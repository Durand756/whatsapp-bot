const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');

// Configuration centralisée 
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    PORT: process.env.PORT || 3000,
    USAGE_DAYS: 30,
    CODE_EXPIRY_HOURS: 24,
    QR_TIMEOUT: 120000,
    SESSION_CHECK_INTERVAL: 300000, // 5 minutes
    // Configuration Google Drive
    GDRIVE: {
        PARENT_FOLDER_ID: process.env.GDRIVE_FOLDER_ID || null,
        FILES: {
            USERS: 'users.json',
            CODES: 'codes.json',
            GROUPS: 'groups.json',
            SESSION: 'whatsapp_session.json' // Nouveau fichier pour la session
        }
    }
};

// État global simplifié
const state = {
    ready: false,
    qr: null,
    client: null,
    server: null,
    lastActivity: Date.now(),
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    // Cache en mémoire pour performance
    cache: {
        users: new Map(),
        codes: new Map(),
        groups: new Map()
    },
    // Google Drive
    drive: null,
    driveFiles: {
        users: null,
        codes: null,
        groups: null,
        session: null
    },
    // Session management
    sessionData: null,
    isRestoring: false
};

// Classe pour gérer la session sur Google Drive
class DriveSessionStore {
    constructor(drive, fileId) {
        this.drive = drive;
        this.fileId = fileId;
    }

    async save(sessionData) {
        try {
            const data = JSON.stringify(sessionData, null, 2);
            
            await this.drive.files.update({
                fileId: this.fileId,
                media: {
                    mimeType: 'application/json',
                    body: data
                }
            });
            
            console.log('💾 Session sauvegardée sur Drive');
            return true;
        } catch (error) {
            console.error('❌ Erreur sauvegarde session:', error.message);
            return false;
        }
    }

    async extract() {
        try {
            const response = await this.drive.files.get({
                fileId: this.fileId,
                alt: 'media'
            });

            const data = typeof response.data === 'string' ? 
                JSON.parse(response.data || '{}') : 
                (response.data || {});

            console.log('📥 Session récupérée depuis Drive');
            return data;
        } catch (error) {
            console.error('❌ Erreur récupération session:', error.message);
            return {};
        }
    }

    async delete() {
        try {
            await this.save({});
            console.log('🗑️ Session supprimée du Drive');
            return true;
        } catch (error) {
            console.error('❌ Erreur suppression session:', error.message);
            return false;
        }
    }
}

// Initialisation Google Drive
async function initGoogleDrive() {
    try {
        // Créer les credentials depuis les variables d'environnement
        const credentials = {
            type: process.env.GOOGLE_TYPE,
            project_id: process.env.GOOGLE_PROJECT_ID,
            private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            client_id: process.env.GOOGLE_CLIENT_ID,
            auth_uri: process.env.GOOGLE_AUTH_URI,
            token_uri: process.env.GOOGLE_TOKEN_URI,
            auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
            client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL
        };

        // Authentification avec Google
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });

        state.drive = google.drive({ version: 'v3', auth });

        // Vérifier les fichiers existants ou les créer
        await initDriveFiles();

        console.log('✅ Google Drive initialisé');
        return true;
    } catch (error) {
        console.error('❌ Erreur Google Drive:', error.message);
        return false;
    }
}

// Initialiser les fichiers sur Google Drive
async function initDriveFiles() {
    try {
        for (const [key, fileName] of Object.entries(CONFIG.GDRIVE.FILES)) {
            // Chercher le fichier existant
            const response = await state.drive.files.list({
                q: `name='${fileName}'${CONFIG.GDRIVE.PARENT_FOLDER_ID ? ` and parents in '${CONFIG.GDRIVE.PARENT_FOLDER_ID}'` : ''}`,
                fields: 'files(id, name)'
            });

            if (response.data.files.length > 0) {
                // Fichier trouvé
                state.driveFiles[key] = response.data.files[0].id;
                console.log(`📄 Trouvé: ${fileName} (${state.driveFiles[key]})`);
            } else {
                // Créer le fichier
                const fileMetadata = {
                    name: fileName,
                    parents: CONFIG.GDRIVE.PARENT_FOLDER_ID ? [CONFIG.GDRIVE.PARENT_FOLDER_ID] : undefined
                };

                const media = {
                    mimeType: 'application/json',
                    body: key === 'session' ? '{}' : '{}'
                };

                const file = await state.drive.files.create({
                    resource: fileMetadata,
                    media: media,
                    fields: 'id'
                });

                state.driveFiles[key] = file.data.id;
                console.log(`📄 Créé: ${fileName} (${state.driveFiles[key]})`);
            }
        }

        // Charger les données en cache
        await loadCache();

        // Nettoyage automatique au démarrage
        await cleanupExpiredData();

        return true;
    } catch (error) {
        console.error('❌ Erreur init fichiers Drive:', error.message);
        return false;
    }
}

// Custom LocalAuth qui utilise Google Drive
class DriveAuth {
    constructor(options = {}) {
        this.clientId = options.clientId || 'default';
        this.sessionStore = null;
    }

    async logout() {
        if (this.sessionStore) {
            await this.sessionStore.delete();
        }
        state.sessionData = null;
        console.log('🔌 Session déconnectée');
    }

    async getAuthEventPayload() {
        return state.sessionData;
    }

    async setAuthEventPayload(sessionData) {
        state.sessionData = sessionData;
        
        if (this.sessionStore && sessionData) {
            await this.sessionStore.save({
                sessionData,
                timestamp: new Date().toISOString(),
                clientId: this.clientId
            });
        }
    }

    async beforeConnect() {
        // Initialiser le store de session
        if (!this.sessionStore && state.driveFiles.session) {
            this.sessionStore = new DriveSessionStore(state.drive, state.driveFiles.session);
        }

        // Tenter de récupérer une session existante
        if (this.sessionStore && !state.sessionData) {
            try {
                const savedSession = await this.sessionStore.extract();
                
                if (savedSession.sessionData && savedSession.clientId === this.clientId) {
                    state.sessionData = savedSession.sessionData;
                    state.isRestoring = true;
                    console.log('🔄 Restauration session depuis Drive...');
                    return;
                }
            } catch (error) {
                console.error('❌ Erreur récupération session:', error.message);
            }
        }

        console.log('🆕 Nouvelle session requise');
    }
}

// Charger toutes les données depuis Google Drive
async function loadCache() {
    try {
        const promises = [];
        
        // Charger seulement les fichiers de données (pas la session)
        for (const [key, fileId] of Object.entries(state.driveFiles)) {
            if (key !== 'session') {
                promises.push(
                    state.drive.files.get({
                        fileId: fileId,
                        alt: 'media'
                    }).then(response => ({ key, data: response.data }))
                );
            }
        }

        const results = await Promise.all(promises);
        
        for (const { key, data } of results) {
            const parsedData = typeof data === 'string' ? JSON.parse(data || '{}') : (data || {});
            state.cache[key] = new Map(Object.entries(parsedData));
        }

        console.log(`📊 Cache chargé depuis Drive: ${state.cache.users.size} users, ${state.cache.codes.size} codes, ${state.cache.groups.size} groups`);
    } catch (error) {
        console.error('❌ Erreur chargement cache Drive:', error.message);
    }
}

// Sauvegarder les données sur Google Drive
async function saveData(type) {
    try {
        if (!state.driveFiles[type] || type === 'session') {
            console.error(`❌ ID fichier ${type} manquant ou non autorisé`);
            return false;
        }

        const data = Object.fromEntries(state.cache[type]);
        const jsonData = JSON.stringify(data, null, 2);

        await state.drive.files.update({
            fileId: state.driveFiles[type],
            media: {
                mimeType: 'application/json',
                body: jsonData
            }
        });

        console.log(`💾 ${type} sauvegardé sur Drive`);
        return true;
    } catch (error) {
        console.error(`❌ Erreur sauvegarde ${type} sur Drive:`, error.message);
        return false;
    }
}

// Nettoyage des données expirées
async function cleanupExpiredData() {
    try {
        const now = new Date();
        let cleaned = 0;
        
        // Nettoyer les codes expirés
        for (const [phone, codeData] of state.cache.codes) {
            if (new Date(codeData.expiresAt) < now) {
                state.cache.codes.delete(phone);
                cleaned++;
            }
        }
        
        // Désactiver les utilisateurs expirés
        for (const [phone, userData] of state.cache.users) {
            if (userData.active && userData.activatedAt) {
                const daysSince = (now.getTime() - new Date(userData.activatedAt).getTime()) / 86400000;
                if (daysSince > CONFIG.USAGE_DAYS) {
                    userData.active = false;
                    state.cache.users.set(phone, userData);
                    cleaned++;
                }
            }
        }
        
        if (cleaned > 0) {
            await Promise.all([
                saveData('codes'),
                saveData('users')
            ]);
            console.log(`🧹 ${cleaned} éléments nettoyés`);
        }
    } catch (error) {
        console.error('❌ Erreur nettoyage:', error.message);
    }
}

// Générateur de code optimisé
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        if (i === 4) code += '-';
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// Fonctions base de données Google Drive
const db = {
    async createCode(phone) {
        const code = generateCode();
        const expiresAt = new Date(Date.now() + CONFIG.CODE_EXPIRY_HOURS * 3600000);
        
        const codeData = {
            phone,
            code,
            used: false,
            expiresAt: expiresAt.toISOString(),
            createdAt: new Date().toISOString()
        };
        
        state.cache.codes.set(phone, codeData);
        await saveData('codes');
        
        return code;
    },

    async validateCode(phone, inputCode) {
        try {
            const codeData = state.cache.codes.get(phone);
            
            if (!codeData || codeData.used || new Date(codeData.expiresAt) < new Date()) {
                return false;
            }
            
            if (codeData.code.replace('-', '') !== inputCode.replace(/[-\s]/g, '').toUpperCase()) {
                return false;
            }
            
            // Marquer le code comme utilisé
            codeData.used = true;
            state.cache.codes.set(phone, codeData);
            
            // Activer l'utilisateur
            const userData = state.cache.users.get(phone) || {};
            userData.phone = phone;
            userData.active = true;
            userData.activatedAt = new Date().toISOString();
            userData.createdAt = userData.createdAt || new Date().toISOString();
            
            state.cache.users.set(phone, userData);
            
            // Sauvegarder les deux fichiers
            await Promise.all([
                saveData('codes'),
                saveData('users')
            ]);
            
            return true;
        } catch (error) {
            console.error('❌ Erreur validation:', error.message);
            return false;
        }
    },

    async isAuthorized(phone) {
        try {
            const userData = state.cache.users.get(phone);
            
            if (!userData || !userData.active) return false;
            
            const daysSince = (Date.now() - new Date(userData.activatedAt).getTime()) / 86400000;
            
            if (daysSince > CONFIG.USAGE_DAYS) {
                userData.active = false;
                state.cache.users.set(phone, userData);
                await saveData('users');
                return false;
            }
            
            return true;
        } catch (error) {
            console.error('❌ Erreur autorisation:', error.message);
            return false;
        }
    },

    async addGroup(groupId, name, addedBy) {
        try {
            if (state.cache.groups.has(groupId)) {
                return false; // Déjà existe
            }
            
            const groupData = {
                groupId,
                name,
                addedBy,
                addedAt: new Date().toISOString()
            };
            
            state.cache.groups.set(groupId, groupData);
            await saveData('groups');
            
            return true;
        } catch (error) {
            console.error('❌ Erreur ajout groupe:', error.message);
            return false;
        }
    },

    async getUserGroups(phone) {
        try {
            const userGroups = [];
            
            for (const [groupId, groupData] of state.cache.groups) {
                if (groupData.addedBy === phone) {
                    userGroups.push({
                        group_id: groupData.groupId,
                        name: groupData.name
                    });
                }
            }
            
            return userGroups;
        } catch (error) {
            console.error('❌ Erreur groupes utilisateur:', error.message);
            return [];
        }
    },

    async getStats() {
        try {
            let activeUsers = 0;
            let usedCodes = 0;
            
            // Compter les utilisateurs actifs
            for (const [phone, userData] of state.cache.users) {
                if (userData.active) activeUsers++;
            }
            
            // Compter les codes utilisés
            for (const [phone, codeData] of state.cache.codes) {
                if (codeData.used) usedCodes++;
            }
            
            return {
                total_users: state.cache.users.size,
                active_users: activeUsers,
                total_codes: state.cache.codes.size,
                used_codes: usedCodes,
                total_groups: state.cache.groups.size
            };
        } catch (error) {
            console.error('❌ Erreur stats:', error.message);
            return {
                total_users: 0,
                active_users: 0,
                total_codes: 0,
                used_codes: 0,
                total_groups: 0
            };
        }
    }
};

// Interface web minimaliste
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
    const sessionStatus = state.sessionData ? '🔑 Session Active' : '❌ Pas de Session';
    const reconnectInfo = state.reconnectAttempts > 0 ? `🔄 Tentatives: ${state.reconnectAttempts}/${state.maxReconnectAttempts}` : '';
    
    const html = state.ready ? 
        `<h1 style="color:green">✅ Bot En Ligne</h1><p>🕒 ${new Date().toLocaleString()}</p><p>☁️ Google Drive + Session Persistante</p><p>${sessionStatus}</p>` :
        state.qr ? 
        `<h1>📱 Scanner QR Code</h1><p>${sessionStatus}</p><img src="data:image/png;base64,${state.qr}"><script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1>🔄 Initialisation...</h1><p>${sessionStatus}</p><p>${reconnectInfo}</p><script>setTimeout(()=>location.reload(),10000)</script>`;
    
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp Bot</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial;text-align:center;background:#25D366;color:white;padding:50px}img{background:white;padding:20px;border-radius:10px}</style></head><body>${html}</body></html>`);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: state.ready ? 'online' : 'offline',
        database: 'google-drive',
        session: state.sessionData ? 'active' : 'inactive',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        reconnect_attempts: state.reconnectAttempts,
        cache_size: {
            users: state.cache.users.size,
            codes: state.cache.codes.size,
            groups: state.cache.groups.size
        },
        drive_files: state.driveFiles
    });
});

// Fonction de reconnexion intelligente
async function attemptReconnect() {
    if (state.reconnectAttempts >= state.maxReconnectAttempts) {
        console.log('❌ Limite de reconnexion atteinte');
        return false;
    }

    state.reconnectAttempts++;
    console.log(`🔄 Tentative de reconnexion ${state.reconnectAttempts}/${state.maxReconnectAttempts}`);

    try {
        if (state.client) {
            await state.client.destroy();
        }
        
        // Attendre avant de recréer le client
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        await initClient();
        return true;
    } catch (error) {
        console.error('❌ Erreur reconnexion:', error.message);
        return false;
    }
}

// Initialisation client WhatsApp avec session persistante
async function initClient() {
    state.client = new Client({
        authStrategy: new DriveAuth({ clientId: 'whatsapp-bot-drive' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ]
        }
    });

    // Événements
    state.client.on('qr', async (qr) => {
        console.log('📱 QR Code généré');
        state.qr = (await QRCode.toDataURL(qr, { width: 400 })).split(',')[1];
        setTimeout(() => { if (!state.ready) state.qr = null; }, CONFIG.QR_TIMEOUT);
    });

    state.client.on('authenticated', () => {
        console.log('🔐 Authentifié' + (state.isRestoring ? ' (session restaurée)' : ''));
        state.qr = null;
        state.reconnectAttempts = 0; // Reset compteur
        state.isRestoring = false;
    });

    state.client.on('auth_failure', async (msg) => {
        console.log('❌ Échec authentification:', msg);
        
        // Supprimer la session corrompue
        if (state.client.authStrategy && state.client.authStrategy.sessionStore) {
            await state.client.authStrategy.sessionStore.delete();
        }
        
        state.sessionData = null;
        state.ready = false;
        
        // Tenter une reconnexion
        setTimeout(() => attemptReconnect(), 10000);
    });

    state.client.on('ready', async () => {
        state.ready = true;
        state.qr = null;
        state.lastActivity = Date.now();
        console.log('🎉 BOT PRÊT! Session persistante active');
        
        setTimeout(async () => {
            try {
                await state.client.sendMessage(CONFIG.ADMIN_NUMBER, 
                    `🎉 *BOT EN LIGNE*\n☁️ Google Drive + Session Persistante\n🕒 ${new Date().toLocaleString()}\n🔄 Reconnexions: ${state.reconnectAttempts}`);
            } catch (e) {}
        }, 3000);
    });

    state.client.on('disconnected', async (reason) => {
        console.log('🔌 Déconnecté:', reason);
        state.ready = false;
        
        // Tenter une reconnexion automatique
        if (reason !== 'LOGOUT') {
            setTimeout(() => attemptReconnect(), 15000);
        }
    });

    // Traitement des messages
    state.client.on('message', async (msg) => {
        if (!state.ready || !msg.body || msg.type !== 'chat' || !msg.body.startsWith('/')) return;
        
        state.lastActivity = Date.now(); // Marquer l'activité
        
        try {
            const contact = await msg.getContact();
            if (!contact || contact.isMe) return;

            const phone = contact.id._serialized;
            const text = msg.body.trim();
            const cmd = text.toLowerCase();

            console.log(`📨 ${phone.replace('@c.us', '')}: ${cmd.substring(0, 30)}...`);

            // Commandes admin
            if (phone === CONFIG.ADMIN_NUMBER) {
                if (cmd.startsWith('/gencode ')) {
                    const number = text.substring(9).trim();
                    if (!number) return msg.reply('❌ Usage: /gencode [numéro]');
                    
                    const targetPhone = number.includes('@') ? number : `${number}@c.us`;
                    const code = await db.createCode(targetPhone);
                    await msg.reply(`✅ *CODE GÉNÉRÉ*\n👤 ${number}\n🔑 ${code}\n⏰ 24h\n📝 /activate ${code}`);
                    
                } else if (cmd === '/stats') {
                    const stats = await db.getStats();
                    const uptime = Math.floor(process.uptime() / 60);
                    await msg.reply(`📊 *STATS DRIVE*\n👥 Total: ${stats.total_users}\n✅ Actifs: ${stats.active_users}\n🔑 Codes: ${stats.total_codes}/${stats.used_codes}\n📢 Groupes: ${stats.total_groups}\n⏱️ Uptime: ${uptime}min\n🔄 Reconnexions: ${state.reconnectAttempts}`);
                    
                } else if (cmd === '/backup') {
                    // Sauvegarder tout
                    await Promise.all([
                        saveData('users'),
                        saveData('codes'),
                        saveData('groups')
                    ]);
                    await msg.reply('✅ Backup Drive effectué!');
                    
                } else if (cmd === '/reset-session') {
                    // Réinitialiser la session
                    if (state.client.authStrategy && state.client.authStrategy.sessionStore) {
                        await state.client.authStrategy.sessionStore.delete();
                    }
                    await msg.reply('🔄 Session réinitialisée. Redémarrage requis.');
                    
                } else if (cmd === '/help') {
                    await msg.reply('🤖 *ADMIN*\n• /gencode [num] - Créer code\n• /stats - Statistiques\n• /backup - Sauvegarder\n• /reset-session - Reset session\n• /help - Aide\n\n☁️ Google Drive + Session Persistante');
                }
                return;
            }

            // Activation
            if (cmd.startsWith('/activate ')) {
                const code = text.substring(10).trim();
                if (!code) return msg.reply('❌ Usage: /activate XXXX-XXXX');
                
                if (await db.validateCode(phone, code)) {
                    await msg.reply(`🎉 *ACTIVÉ!* Expire dans ${CONFIG.USAGE_DAYS} jours\n\n📋 *Commandes:*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Mon statut\n• /help - Aide`);
                } else {
                    await msg.reply('❌ Code invalide ou expiré');
                }
                return;
            }

            // Vérifier autorisation
            if (!(await db.isAuthorized(phone))) {
                return msg.reply(`🔒 *Accès requis*\n📞 Contact: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\n🔑 /activate VOTRE-CODE`);
            }

            // Commandes utilisateur
            if (cmd === '/status') {
                const userData = state.cache.users.get(phone);
                const remaining = Math.ceil(CONFIG.USAGE_DAYS - (Date.now() - new Date(userData.activatedAt).getTime()) / 86400000);
                const groups = await db.getUserGroups(phone);
                await msg.reply(`📊 *STATUT*\n🟢 Actif\n📅 ${remaining} jours restants\n📢 ${groups.length} groupes\n☁️ Google Drive + Session Persistante`);
                
            } else if (cmd === '/addgroup') {
                const chat = await msg.getChat();
                if (!chat.isGroup) return msg.reply('❌ Uniquement dans les groupes!');
                
                const added = await db.addGroup(chat.id._serialized, chat.name, phone);
                await msg.reply(added ? 
                    `✅ *Groupe ajouté!*\n📢 ${chat.name}\n💡 /broadcast [message] pour diffuser` :
                    `ℹ️ Groupe déjà enregistré: ${chat.name}`);
                    
            } else if (cmd.startsWith('/broadcast ')) {
                const message = text.substring(11).trim();
                if (!message) return msg.reply('❌ Usage: /broadcast [message]');
                
                const groups = await db.getUserGroups(phone);
                if (!groups.length) return msg.reply('❌ Aucun groupe! Utilisez /addgroup d\'abord');
                
                await msg.reply(`🚀 Diffusion vers ${groups.length} groupe(s)...`);
                
                let success = 0;
                const senderName = contact.pushname || 'Utilisateur';
                
                for (const group of groups) {
                    try {
                        const fullMsg = `📢 *DIFFUSION*\n👤 ${senderName}\n🕒 ${new Date().toLocaleString()}\n\n${message}`;
                        await state.client.sendMessage(group.group_id, fullMsg);
                        success++;
                        await new Promise(r => setTimeout(r, 2000));
                    } catch (e) {}
                }
                
                await msg.reply(`📊 *RÉSULTAT*\n✅ ${success}/${groups.length} groupes\n${success > 0 ? '🎉 Diffusé!' : '❌ Échec'}`);
                
            } else if (cmd === '/help') {
                const groups = await db.getUserGroups(phone);
                await msg.reply(`🤖 *COMMANDES*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Mon statut\n• /help - Aide\n\n📊 ${groups.length} groupe(s)\n☁️ Google Drive + Session Persistante`);
            }
            
        } catch (error) {
            console.error('❌ Erreur message:', error.message);
            try { await msg.reply('❌ Erreur temporaire'); } catch (e) {}
        }
    });

    await state.client.initialize();
}

// Surveillance de la connexion
setInterval(() => {
    if (state.ready) {
        const inactiveTime = Date.now() - state.lastActivity;
        
        // Si inactif depuis plus de 30 minutes, envoyer un ping
        if (inactiveTime > 1800000) {
            console.log('🔔 Ping de maintien de connexion');
            state.lastActivity = Date.now();
            
            // Envoyer un message silencieux à l'admin pour maintenir la connexion
            try {
                state.client.sendMessage(CONFIG.ADMIN_NUMBER, '🔔 Ping automatique - Bot actif')
                    .catch(() => {}); // Ignorer les erreurs de ping
            } catch (e) {}
        }
    }
}, CONFIG.SESSION_CHECK_INTERVAL);

// Nettoyage et sauvegarde périodiques
setInterval(async () => {
    try {
        await cleanupExpiredData();
        
        // Sauvegarde préventive toutes les heures
        await Promise.all([
            saveData('users'),
            saveData('codes'),
            saveData('groups')
        ]);
        
        console.log('💾 Sauvegarde périodique Google Drive effectuée');
    } catch (e) {
        console.error('❌ Erreur sauvegarde périodique:', e.message);
    }
}, 3600000); // 1h

// Keep-alive pour Render avec informations de session
setInterval(() => {
    const sessionStatus = state.sessionData ? 'SESSION-OK' : 'NO-SESSION';
    console.log(`💗 Uptime: ${Math.floor(process.uptime())}s - ${state.ready ? 'ONLINE' : 'OFFLINE'} - ${sessionStatus} - ☁️ Drive (${state.cache.users.size}/${state.cache.codes.size}/${state.cache.groups.size}) - Reconnect: ${state.reconnectAttempts}`);
}, 300000);

// Démarrage
async function start() {
    console.log('🚀 DÉMARRAGE BOT WHATSAPP');
    console.log('☁️ Base: Google Drive (100% GRATUIT)');
    console.log('🔑 Session: Persistante sur Drive');
    console.log('🌐 Hébergeur: Render');
    
    if (!(await initGoogleDrive())) {
        console.error('❌ Échec initialisation Google Drive');
        process.exit(1);
    }
    
    state.server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
        console.log(`🌐 Serveur port ${CONFIG.PORT}`);
    });
    
    await initClient();
}

// Arrêt propre avec sauvegarde de session
async function shutdown() {
    console.log('🛑 Arrêt en cours...');
    
    // Sauvegarder toutes les données avant l'arrêt
    try {
        await Promise.all([
            saveData('users'),
            saveData('codes'),
            saveData('groups')
        ]);
        console.log('💾 Données sauvegardées sur Google Drive');
    } catch (e) {
        console.error('❌ Erreur sauvegarde finale:', e.message);
    }
    
    // Notification d'arrêt avec préservation de session
    if (state.client && state.ready) {
        try {
            await state.client.sendMessage(CONFIG.ADMIN_NUMBER, 
                `🛑 Bot arrêté - Session préservée sur Drive\n🔑 Reconnexion automatique au redémarrage\n💾 Données sauvegardées`);
        } catch (e) {}
        
        // Attendre que le message soit envoyé
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        await state.client.destroy();
    }
    
    if (state.server) state.server.close();
    
    console.log('✅ Arrêt terminé - Session préservée');
    process.exit(0);
}

// Gestion des signaux avec sauvegarde de session
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Gestion erreurs améliorée
process.on('uncaughtException', async (error) => {
    console.error('❌ Exception critique:', error.message);
    
    // Tenter une sauvegarde d'urgence
    try {
        if (state.drive && state.driveFiles.users) {
            await Promise.all([
                saveData('users'),
                saveData('codes'),
                saveData('groups')
            ]);
            console.log('💾 Sauvegarde d\'urgence effectuée');
        }
    } catch (e) {
        console.error('❌ Échec sauvegarde d\'urgence:', e.message);
    }
    
    // Redémarrer après sauvegarde
    process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
    console.error('❌ Promise rejetée:', reason);
    
    // Si c'est une erreur de connexion, tenter une reconnexion
    if (reason && reason.message && reason.message.includes('connection')) {
        console.log('🔄 Erreur de connexion détectée, reconnexion...');
        setTimeout(() => attemptReconnect(), 5000);
    }
});

// Fonction utilitaire pour vérifier l'état de la session
async function checkSessionHealth() {
    try {
        if (!state.client || !state.ready) {
            return false;
        }
        
        // Tester la connexion en récupérant les infos du client
        const info = await state.client.info;
        return !!info;
    } catch (error) {
        console.error('❌ Session malsaine:', error.message);
        return false;
    }
}

// Vérification périodique de la santé de la session
setInterval(async () => {
    if (state.ready && !(await checkSessionHealth())) {
        console.log('⚠️ Session détectée comme malsaine, reconnexion...');
        await attemptReconnect();
    }
}, 600000); // Vérifier toutes les 10 minutes

// Point d'entrée
if (require.main === module) {
    start().catch(async error => {
        console.error('❌ ERREUR DÉMARRAGE:', error.message);
        
        // Tenter une sauvegarde même en cas d'erreur de démarrage
        try {
            if (state.drive) {
                await Promise.all([
                    saveData('users'),
                    saveData('codes'), 
                    saveData('groups')
                ]);
                console.log('💾 Sauvegarde de récupération effectuée');
            }
        } catch (e) {}
        
        process.exit(1);
    });
}

module.exports = { start, CONFIG, state };
