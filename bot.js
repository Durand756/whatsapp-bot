const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const { google } = require('googleapis');

// Configuration centralisée
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    PORT: process.env.PORT || 3000,
    USAGE_DAYS: 30,
    CODE_EXPIRY_HOURS: 24,
    QR_TIMEOUT: 120000,
    // Configuration Google Drive
    GDRIVE: {
        PARENT_FOLDER_ID: process.env.GDRIVE_FOLDER_ID || null, // ID du dossier parent sur Google Drive
        FILES: {
            USERS: 'users.json',
            CODES: 'codes.json',
            GROUPS: 'groups.json'
        }
    }
};

// État global simplifié
const state = {
    ready: false,
    qr: null,
    client: null,
    server: null,
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
        groups: null
    }
};

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
                    body: '{}'
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

// Charger toutes les données depuis Google Drive
async function loadCache() {
    try {
        const promises = [];
        
        for (const [key, fileId] of Object.entries(state.driveFiles)) {
            promises.push(
                state.drive.files.get({
                    fileId: fileId,
                    alt: 'media'
                }).then(response => ({ key, data: response.data }))
            );
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
        if (!state.driveFiles[type]) {
            console.error(`❌ ID fichier ${type} manquant`);
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
    const html = state.ready ? 
        `<h1 style="color:green">✅ Bot En Ligne</h1><p>🕒 ${new Date().toLocaleString()}</p><p>☁️ Google Drive</p>` :
        state.qr ? 
        `<h1>📱 Scanner QR Code</h1><img src="data:image/png;base64,${state.qr}"><script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1>🔄 Initialisation...</h1><script>setTimeout(()=>location.reload(),10000)</script>`;
    
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp Bot</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial;text-align:center;background:#25D366;color:white;padding:50px}img{background:white;padding:20px;border-radius:10px}</style></head><body>${html}</body></html>`);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: state.ready ? 'online' : 'offline',
        database: 'google-drive',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        cache_size: {
            users: state.cache.users.size,
            codes: state.cache.codes.size,
            groups: state.cache.groups.size
        },
        drive_files: state.driveFiles
    });
});

// Initialisation client WhatsApp
async function initClient() {
    state.client = new Client({
        authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }),
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
        console.log('🔐 Authentifié');
        state.qr = null;
    });

    state.client.on('ready', async () => {
        state.ready = true;
        state.qr = null;
        console.log('🎉 BOT PRÊT!');
        
        setTimeout(async () => {
            try {
                await state.client.sendMessage(CONFIG.ADMIN_NUMBER, 
                    `🎉 *BOT EN LIGNE*\n☁️ Google Drive connecté\n🕒 ${new Date().toLocaleString()}`);
            } catch (e) {}
        }, 3000);
    });

    state.client.on('disconnected', () => {
        console.log('🔌 Déconnecté');
        state.ready = false;
    });

    // Traitement des messages
    state.client.on('message', async (msg) => {
        if (!state.ready || !msg.body || msg.type !== 'chat' || !msg.body.startsWith('/')) return;
        
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
                    await msg.reply(`📊 *STATS DRIVE*\n👥 Total: ${stats.total_users}\n✅ Actifs: ${stats.active_users}\n🔑 Codes: ${stats.total_codes}/${stats.used_codes}\n📢 Groupes: ${stats.total_groups}`);
                    
                } else if (cmd === '/backup') {
                    // Sauvegarder tout
                    await Promise.all([
                        saveData('users'),
                        saveData('codes'),
                        saveData('groups')
                    ]);
                    await msg.reply('✅ Backup Drive effectué!');
                    
                } else if (cmd === '/help') {
                    await msg.reply('🤖 *ADMIN*\n• /gencode [num] - Créer code\n• /stats - Statistiques\n• /backup - Sauvegarder\n• /help - Aide\n\n☁️ Google Drive');
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
                await msg.reply(`📊 *STATUT*\n🟢 Actif\n📅 ${remaining} jours restants\n📢 ${groups.length} groupes\n☁️ Google Drive`);
                
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
                await msg.reply(`🤖 *COMMANDES*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Mon statut\n• /help - Aide\n\n📊 ${groups.length} groupe(s)\n☁️ Google Drive`);
            }
            
        } catch (error) {
            console.error('❌ Erreur message:', error.message);
            try { await msg.reply('❌ Erreur temporaire'); } catch (e) {}
        }
    });

    await state.client.initialize();
}

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

// Keep-alive pour Render
setInterval(() => {
    console.log(`💗 Uptime: ${Math.floor(process.uptime())}s - ${state.ready ? 'ONLINE' : 'OFFLINE'} - ☁️ Drive (${state.cache.users.size}/${state.cache.codes.size}/${state.cache.groups.size})`);
}, 300000);

// Démarrage
async function start() {
    console.log('🚀 DÉMARRAGE BOT WHATSAPP');
    console.log('☁️ Base: Google Drive (100% GRATUIT)');
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

// Arrêt propre avec sauvegarde
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
    
    if (state.client) {
        try {
            await state.client.sendMessage(CONFIG.ADMIN_NUMBER, '🛑 Bot arrêté - données sauvegardées sur Drive');
        } catch (e) {}
        await state.client.destroy();
    }
    
    if (state.server) state.server.close();
    
    console.log('✅ Arrêt terminé');
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Gestion erreurs
process.on('uncaughtException', (error) => {
    console.error('❌ Exception:', error.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Promise rejetée:', reason);
});

// Point d'entrée
if (require.main === module) {
    start().catch(error => {
        console.error('❌ ERREUR DÉMARRAGE:', error.message);
        process.exit(1);
    });
}

module.exports = { start, CONFIG, state };
