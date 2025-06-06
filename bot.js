const { Client, RemoteAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const { google } = require('googleapis');

// Configuration
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    PORT: process.env.PORT || 3000,
    USAGE_DAYS: 30,
    CODE_EXPIRY_HOURS: 24,
    GDRIVE_FOLDER_ID: process.env.GDRIVE_FOLDER_ID || null,
    BACKUP_INTERVAL_MS: 60000, // 1 minute minimum requis
    FILES: { USERS: 'users.json', CODES: 'codes.json', GROUPS: 'groups.json', SESSION: 'session.json' }
};

// État global
const state = {
    ready: false, qr: null, client: null, server: null, drive: null,
    fileIds: {}, cache: { users: new Map(), codes: new Map(), groups: new Map() },
    reconnects: 0, maxReconnects: 3
};

// Store Google Drive pour RemoteAuth
class DriveStore {
    constructor() {
        this.sessionData = null;
    }

    async sessionExists(sessionId) {
        try {
            if (!state.fileIds.SESSION) return false;
            const data = await loadFromDrive('SESSION');
            return !!(data && data.sessionData);
        } catch (error) {
            console.error('❌ Erreur vérification session:', error.message);
            return false;
        }
    }

    async save(sessionId, sessionData) {
        try {
            if (!state.fileIds.SESSION) return;
            await saveToDrive('SESSION', {
                sessionId,
                sessionData,
                timestamp: new Date().toISOString()
            });
            console.log('💾 Session sauvegardée sur Drive');
        } catch (error) {
            console.error('❌ Erreur sauvegarde session:', error.message);
        }
    }

    async extract(sessionId) {
        try {
            if (!state.fileIds.SESSION) return null;
            const data = await loadFromDrive('SESSION');
            return data?.sessionData || null;
        } catch (error) {
            console.error('❌ Erreur extraction session:', error.message);
            return null;
        }
    }

    async delete(sessionId) {
        try {
            if (!state.fileIds.SESSION) return;
            await saveToDrive('SESSION', {});
            console.log('🗑️ Session supprimée');
        } catch (error) {
            console.error('❌ Erreur suppression session:', error.message);
        }
    }
}

// Google Drive
async function initGoogleDrive() {
    try {
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

        const auth = new google.auth.GoogleAuth({
            credentials, scopes: ['https://www.googleapis.com/auth/drive.file']
        });

        state.drive = google.drive({ version: 'v3', auth });
        await initDriveFiles();
        console.log('✅ Google Drive initialisé');
        return true;
    } catch (error) {
        console.error('❌ Erreur Google Drive:', error.message);
        return false;
    }
}

async function initDriveFiles() {
    for (const [key, fileName] of Object.entries(CONFIG.FILES)) {
        try {
            const response = await state.drive.files.list({
                q: `name='${fileName}'${CONFIG.GDRIVE_FOLDER_ID ? ` and parents in '${CONFIG.GDRIVE_FOLDER_ID}'` : ''}`,
                fields: 'files(id, name)'
            });

            if (response.data.files.length > 0) {
                state.fileIds[key] = response.data.files[0].id;
                console.log(`📄 Trouvé: ${fileName}`);
            } else {
                const fileMetadata = {
                    name: fileName,
                    parents: CONFIG.GDRIVE_FOLDER_ID ? [CONFIG.GDRIVE_FOLDER_ID] : undefined
                };

                const file = await state.drive.files.create({
                    resource: fileMetadata,
                    media: { mimeType: 'application/json', body: '{}' },
                    fields: 'id'
                });

                state.fileIds[key] = file.data.id;
                console.log(`📄 Créé: ${fileName}`);
            }
        } catch (error) {
            console.error(`❌ Erreur fichier ${fileName}:`, error.message);
        }
    }
    await loadCache();
}

async function loadFromDrive(fileKey) {
    try {
        const fileId = state.fileIds[fileKey];
        if (!fileId) throw new Error(`Fichier ${fileKey} non trouvé`);

        const response = await state.drive.files.get({ fileId: fileId, alt: 'media' });
        let data = response.data;
        if (typeof data === 'string') data = JSON.parse(data || '{}');
        return data || {};
    } catch (error) {
        console.error(`❌ Erreur chargement ${fileKey}:`, error.message);
        return {};
    }
}

async function saveToDrive(fileKey, data) {
    try {
        const fileId = state.fileIds[fileKey];
        if (!fileId) throw new Error(`Fichier ${fileKey} non trouvé`);

        await state.drive.files.update({
            fileId: fileId,
            media: { mimeType: 'application/json', body: JSON.stringify(data, null, 2) }
        });

        console.log(`💾 ${fileKey} sauvegardé`);
        return true;
    } catch (error) {
        console.error(`❌ Erreur sauvegarde ${fileKey}:`, error.message);
        return false;
    }
}

async function loadCache() {
    try {
        const [users, codes, groups] = await Promise.all([
            loadFromDrive('USERS'), loadFromDrive('CODES'), loadFromDrive('GROUPS')
        ]);

        state.cache.users = new Map(Object.entries(users));
        state.cache.codes = new Map(Object.entries(codes));
        state.cache.groups = new Map(Object.entries(groups));

        console.log(`📊 Cache chargé: ${state.cache.users.size} users, ${state.cache.codes.size} codes, ${state.cache.groups.size} groups`);
    } catch (error) {
        console.error('❌ Erreur chargement cache:', error.message);
    }
}

async function saveCache(type = 'all') {
    try {
        const saves = [];
        if (type === 'all' || type === 'users') saves.push(saveToDrive('USERS', Object.fromEntries(state.cache.users)));
        if (type === 'all' || type === 'codes') saves.push(saveToDrive('CODES', Object.fromEntries(state.cache.codes)));
        if (type === 'all' || type === 'groups') saves.push(saveToDrive('GROUPS', Object.fromEntries(state.cache.groups)));
        await Promise.all(saves);
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde cache:', error.message);
        return false;
    }
}

// Utilitaires
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        if (i === 4) code += '-';
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

async function cleanup() {
    try {
        let cleaned = 0;
        const now = new Date();
        
        for (const [phone, data] of state.cache.codes) {
            if (new Date(data.expiresAt) < now) {
                state.cache.codes.delete(phone);
                cleaned++;
            }
        }
        
        for (const [phone, data] of state.cache.users) {
            if (data.active && data.activatedAt) {
                const days = (now - new Date(data.activatedAt)) / 86400000;
                if (days > CONFIG.USAGE_DAYS) {
                    data.active = false;
                    cleaned++;
                }
            }
        }
        
        if (cleaned > 0) {
            await saveCache();
            console.log(`🧹 ${cleaned} éléments nettoyés`);
        }
    } catch (error) {
        console.error('❌ Erreur nettoyage:', error.message);
    }
}

// Base de données
const db = {
    async createCode(phone) {
        const code = generateCode();
        const data = {
            phone, code, used: false,
            expiresAt: new Date(Date.now() + CONFIG.CODE_EXPIRY_HOURS * 3600000).toISOString(),
            createdAt: new Date().toISOString()
        };
        state.cache.codes.set(phone, data);
        await saveCache('codes');
        return code;
    },

    async validateCode(phone, inputCode) {
        const data = state.cache.codes.get(phone);
        if (!data || data.used || new Date(data.expiresAt) < new Date()) return false;
        if (data.code.replace('-', '') !== inputCode.replace(/[-\s]/g, '').toUpperCase()) return false;
        
        data.used = true;
        state.cache.codes.set(phone, data);
        
        const userData = {
            phone, active: true,
            activatedAt: new Date().toISOString(),
            createdAt: new Date().toISOString()
        };
        
        state.cache.users.set(phone, userData);
        await saveCache();
        return true;
    },

    async isAuthorized(phone) {
        const data = state.cache.users.get(phone);
        if (!data || !data.active) return false;
        
        const days = (Date.now() - new Date(data.activatedAt)) / 86400000;
        if (days > CONFIG.USAGE_DAYS) {
            data.active = false;
            state.cache.users.set(phone, data);
            await saveCache('users');
            return false;
        }
        return true;
    },

    async addGroup(groupId, name, addedBy) {
        if (state.cache.groups.has(groupId)) return false;
        state.cache.groups.set(groupId, {
            groupId, name, addedBy, addedAt: new Date().toISOString()
        });
        await saveCache('groups');
        return true;
    },

    async getUserGroups(phone) {
        const groups = [];
        for (const [id, data] of state.cache.groups) {
            if (data.addedBy === phone) groups.push({ group_id: id, name: data.name });
        }
        return groups;
    },

    async getAllUsers() {
        const users = [];
        for (const [phone, data] of state.cache.users) {
            if (data.active) {
                const remaining = Math.ceil(CONFIG.USAGE_DAYS - (Date.now() - new Date(data.activatedAt)) / 86400000);
                users.push({
                    phone: phone.replace('@c.us', ''),
                    activatedAt: data.activatedAt,
                    remaining: remaining > 0 ? remaining : 0
                });
            }
        }
        return users;
    },

    async getAllGroups() {
        const groups = [];
        for (const [id, data] of state.cache.groups) {
            groups.push({
                group_id: id,
                name: data.name,
                addedBy: data.addedBy.replace('@c.us', ''),
                addedAt: data.addedAt
            });
        }
        return groups;
    },

    getStats() {
        let activeUsers = 0, usedCodes = 0;
        for (const [, data] of state.cache.users) if (data.active) activeUsers++;
        for (const [, data] of state.cache.codes) if (data.used) usedCodes++;
        return {
            total_users: state.cache.users.size, active_users: activeUsers,
            total_codes: state.cache.codes.size, used_codes: usedCodes,
            total_groups: state.cache.groups.size
        };
    }
};

// Commandes Admin
const adminCommands = {
    async help(msg) {
        const helpText = `🔐 *COMMANDES ADMIN*

*📝 GÉNÉRATION*
• /gencode [numéro] - Générer un code
• /gencode +237651104356

*📊 STATISTIQUES*
• /stats - Statistiques générales
• /users - Liste des utilisateurs actifs
• /groups - Liste des groupes

*📢 NOTIFICATIONS*
• /notify users [message] - Notifier tous les utilisateurs
• /notify groups [message] - Notifier tous les groupes
• /notify user [numéro] [message] - Notifier un utilisateur
• /notify group [nom/id] [message] - Notifier un groupe

*🔧 MAINTENANCE*
• /backup - Forcer la sauvegarde
• /cleanup - Nettoyer les données expirées
• /help - Afficher cette aide`;

        await msg.reply(helpText);
    },

    async gencode(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /gencode [numéro]');
        const number = args.join(' ').trim();
        const targetPhone = number.includes('@') ? number : `${number}@c.us`;
        const code = await db.createCode(targetPhone);
        await msg.reply(`✅ *CODE GÉNÉRÉ*\n👤 ${number}\n🔑 ${code}\n⏰ 24h`);
    },

    async stats(msg) {
        const stats = db.getStats();
        await msg.reply(`📊 *STATISTIQUES*\n👥 Total: ${stats.total_users}\n✅ Actifs: ${stats.active_users}\n🔑 Codes: ${stats.total_codes}/${stats.used_codes}\n📢 Groupes: ${stats.total_groups}`);
    },

    async users(msg) {
        const users = await db.getAllUsers();
        if (!users.length) return msg.reply('📋 Aucun utilisateur actif');
        
        let response = `👥 *UTILISATEURS ACTIFS (${users.length})*\n\n`;
        users.slice(0, 10).forEach((user, i) => {
            response += `${i + 1}. ${user.phone}\n📅 ${user.remaining} jours restants\n\n`;
        });
        
        if (users.length > 10) response += `... et ${users.length - 10} autres`;
        await msg.reply(response);
    },

    async groups(msg) {
        const groups = await db.getAllGroups();
        if (!groups.length) return msg.reply('📋 Aucun groupe enregistré');
        
        let response = `📢 *GROUPES ENREGISTRÉS (${groups.length})*\n\n`;
        groups.slice(0, 10).forEach((group, i) => {
            response += `${i + 1}. ${group.name}\n👤 Par: ${group.addedBy}\n\n`;
        });
        
        if (groups.length > 10) response += `... et ${groups.length - 10} autres`;
        await msg.reply(response);
    },

    async notify(msg, args) {
        if (args.length < 2) {
            return msg.reply(`❌ Usage:
• /notify users [message]
• /notify groups [message] 
• /notify user [numéro] [message]
• /notify group [nom] [message]`);
        }

        const type = args[0].toLowerCase();
        const message = args.slice(type === 'user' || type === 'group' ? 2 : 1).join(' ');
        
        if (!message) return msg.reply('❌ Message requis');

        let success = 0;
        let total = 0;

        try {
            if (type === 'users') {
                const users = await db.getAllUsers();
                total = users.length;
                await msg.reply(`📢 Notification vers ${total} utilisateur(s)...`);
                
                for (const user of users) {
                    try {
                        await state.client.sendMessage(`${user.phone}@c.us`, `🔔 *NOTIFICATION ADMIN*\n\n${message}`);
                        success++;
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (e) {
                        console.error(`Erreur envoi à ${user.phone}:`, e.message);
                    }
                }
            } else if (type === 'groups') {
                const groups = await db.getAllGroups();
                total = groups.length;
                await msg.reply(`📢 Notification vers ${total} groupe(s)...`);
                
                for (const group of groups) {
                    try {
                        await state.client.sendMessage(group.group_id, `🔔 *NOTIFICATION ADMIN*\n\n${message}`);
                        success++;
                        await new Promise(r => setTimeout(r, 2000));
                    } catch (e) {
                        console.error(`Erreur envoi au groupe ${group.name}:`, e.message);
                    }
                }
            } else if (type === 'user') {
                const targetNumber = args[1];
                const targetPhone = targetNumber.includes('@') ? targetNumber : `${targetNumber}@c.us`;
                total = 1;
                
                try {
                    await state.client.sendMessage(targetPhone, `🔔 *NOTIFICATION ADMIN*\n\n${message}`);
                    success = 1;
                } catch (e) {
                    console.error(`Erreur envoi à ${targetNumber}:`, e.message);
                }
            } else if (type === 'group') {
                const groupName = args[1].toLowerCase();
                const groups = await db.getAllGroups();
                const targetGroup = groups.find(g => 
                    g.name.toLowerCase().includes(groupName) || g.group_id === groupName
                );
                
                if (!targetGroup) {
                    return msg.reply(`❌ Groupe "${args[1]}" non trouvé`);
                }
                
                total = 1;
                try {
                    await state.client.sendMessage(targetGroup.group_id, `🔔 *NOTIFICATION ADMIN*\n\n${message}`);
                    success = 1;
                } catch (e) {
                    console.error(`Erreur envoi au groupe ${targetGroup.name}:`, e.message);
                }
            }

            await msg.reply(`📊 *RÉSULTAT NOTIFICATION*\n✅ Envoyé: ${success}/${total}\n${success < total ? '⚠️ Certains envois ont échoué' : '🎉 Tous envoyés avec succès'}`);
            
        } catch (error) {
            console.error('Erreur notification:', error.message);
            await msg.reply('❌ Erreur lors de l\'envoi des notifications');
        }
    },

    async backup(msg) {
        await saveCache();
        await msg.reply('✅ Sauvegarde effectuée!');
    },

    async cleanup(msg) {
        await cleanup();
        await msg.reply('✅ Nettoyage effectué!');
    }
};

// Commandes Utilisateur
const userCommands = {
    async help(msg) {
        const helpText = `🤖 *COMMANDES UTILISATEUR*

*📋 INFORMATIONS*
• /status - Voir votre statut
• /help - Afficher cette aide

*📢 DIFFUSION*
• /broadcast [message] - Diffuser dans vos groupes
• /addgroup - Ajouter ce groupe à votre liste

*ℹ️ EXEMPLE*
/broadcast Bonjour tout le monde!

*📞 SUPPORT*
Contact admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`;

        await msg.reply(helpText);
    },

    async status(msg, phone) {
        const userData = state.cache.users.get(phone);
        const remaining = Math.ceil(CONFIG.USAGE_DAYS - (Date.now() - new Date(userData.activatedAt)) / 86400000);
        const groups = await db.getUserGroups(phone);
        await msg.reply(`📊 *VOTRE STATUT*\n🟢 Actif\n📅 ${remaining} jours restants\n📢 ${groups.length} groupe(s) enregistré(s)`);
    },

    async addgroup(msg, phone) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply('❌ Cette commande fonctionne uniquement dans les groupes!');
        const added = await db.addGroup(chat.id._serialized, chat.name, phone);
        await msg.reply(added ? `✅ Groupe "${chat.name}" ajouté à votre liste` : `ℹ️ Ce groupe est déjà enregistré`);
    },

    async broadcast(msg, phone, args) {
        if (!args.length) return msg.reply('❌ Usage: /broadcast [votre message]');
        
        const message = args.join(' ');
        const groups = await db.getUserGroups(phone);
        
        if (!groups.length) return msg.reply('❌ Aucun groupe enregistré! Utilisez /addgroup dans vos groupes d\'abord.');
        
        const contact = await msg.getContact();
        const senderName = contact.pushname || 'Utilisateur';
        
        await msg.reply(`🚀 Diffusion en cours vers ${groups.length} groupe(s)...`);
        
        let success = 0;
        for (const group of groups) {
            try {
                const fullMsg = `📢 *DIFFUSION*\n👤 ${senderName}\n\n${message}`;
                await state.client.sendMessage(group.group_id, fullMsg);
                success++;
                await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                console.error(`Erreur diffusion groupe ${group.name}:`, e.message);
            }
        }
        
        await msg.reply(`📊 *RÉSULTAT DIFFUSION*\n✅ Envoyé: ${success}/${groups.length}\n${success < groups.length ? '⚠️ Certains groupes n\'ont pas reçu le message' : '🎉 Diffusion réussie dans tous les groupes'}`);
    }
};

// Interface web
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    const html = state.ready ? 
        `<h1 style="color:green">✅ Bot En Ligne</h1><p>☁️ Google Drive Connecté</p><p>👥 ${state.cache.users.size} utilisateurs</p><p>📢 ${state.cache.groups.size} groupes</p><p>🕒 ${new Date().toLocaleString()}</p>` :
        state.qr ? 
        `<h1>📱 Scanner le QR Code</h1><img src="data:image/png;base64,${state.qr}"><p>⏰ Le QR expire dans 2 minutes</p><script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1>🔄 Chargement en cours...</h1><p>Veuillez patienter...</p><script>setTimeout(()=>location.reload(),10000)</script>`;
    
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp Bot</title><style>body{font-family:Arial;text-align:center;background:#25D366;color:white;padding:50px}img{background:white;padding:20px;border-radius:10px;max-width:400px}</style></head><body>${html}</body></html>`);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: state.ready ? 'online' : 'offline',
        uptime: Math.floor(process.uptime()),
        cache: { 
            users: state.cache.users.size, 
            codes: state.cache.codes.size, 
            groups: state.cache.groups.size 
        },
        reconnects: state.reconnects
    });
});

// Client WhatsApp
async function reconnect() {
    if (state.reconnects >= state.maxReconnects) {
        console.log('❌ Limite de reconnexion atteinte');
        return;
    }
    state.reconnects++;
    console.log(`🔄 Tentative de reconnexion ${state.reconnects}/${state.maxReconnects}`);
    try {
        if (state.client) await state.client.destroy();
        await new Promise(r => setTimeout(r, 5000));
        await initClient();
    } catch (error) {
        console.error('❌ Erreur lors de la reconnexion:', error.message);
    }
}

async function initClient() {
    // Attendre que Google Drive soit prêt
    if (!state.drive || !state.fileIds.SESSION) {
        console.log('⏳ Attente de l\'initialisation de Google Drive...');
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const driveStore = new DriveStore();
    
    state.client = new Client({
        authStrategy: new RemoteAuth({
            store: driveStore,
            backupSyncIntervalMs: CONFIG.BACKUP_INTERVAL_MS,
            clientId: 'whatsapp-bot-drive'
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });

    state.client.on('qr', async (qr) => {
        console.log('📱 QR Code généré');
        state.qr = (await QRCode.toDataURL(qr, { width: 400 })).split(',')[1];
        setTimeout(() => { if (!state.ready) state.qr = null; }, 120000);
    });

    state.client.on('authenticated', () => {
        console.log('🔐 Authentification réussie');
        state.qr = null;
        state.reconnects = 0;
    });

    state.client.on('auth_failure', () => {
        console.log('❌ Échec de l\'authentification');
        setTimeout(reconnect, 10000);
    });

    state.client.on('ready', async () => {
        state.ready = true;
        state.qr = null;
        console.log('🎉 BOT OPÉRATIONNEL!');
        setTimeout(async () => {
            try {
                const stats = db.getStats();
                await state.client.sendMessage(CONFIG.ADMIN_NUMBER, 
                    `🎉 *BOT EN LIGNE*\n☁️ Google Drive connecté\n👥 ${stats.active_users} utilisateurs actifs\n📢 ${stats.total_groups} groupes\n🕒 ${new Date().toLocaleString()}`
                );
            } catch (e) {
                console.error('Erreur envoi message admin:', e.message);
            }
        }, 3000);
    });

    state.client.on('disconnected', (reason) => {
        console.log('🔌 Déconnecté:', reason);
        state.ready = false;
        if (reason !== 'LOGOUT') setTimeout(reconnect, 15000);
    });

    state.client.on('message', async (msg) => {
    // Ignorer les messages qui ne sont pas des commandes ou les messages système
    if (!state.ready || !msg.body || msg.fromMe) return;
    
    try {
        const contact = await msg.getContact();
        if (!contact || contact.isMe) return;

        const phone = contact.id._serialized;
        const text = msg.body.trim();
        const args = text.split(' ').slice(1);
        const cmd = text.split(' ')[0].toLowerCase();

        // Commandes Admin (toujours autorisées)
        if (phone === CONFIG.ADMIN_NUMBER) {
            // Ne traiter que les commandes qui commencent par /
            if (!text.startsWith('/')) return;
            
            switch (cmd) {
                case '/help':
                    await adminCommands.help(msg);
                    break;
                case '/gencode':
                    await adminCommands.gencode(msg, args);
                    break;
                case '/stats':
                    await adminCommands.stats(msg);
                    break;
                case '/users':
                    await adminCommands.users(msg);
                    break;
                case '/groups':
                    await adminCommands.groups(msg);
                    break;
                case '/notify':
                    await adminCommands.notify(msg, args);
                    break;
                case '/backup':
                    await adminCommands.backup(msg);
                    break;
                case '/cleanup':
                    await adminCommands.cleanup(msg);
                    break;
                default:
                    await msg.reply('❌ Commande inconnue. Tapez /help pour voir les commandes disponibles.');
            }
            return;
        }

        // Pour tous les autres utilisateurs, vérifier s'ils sont autorisés
        const isAuthorized = await db.isAuthorized(phone);
        
        // Si l'utilisateur n'est pas autorisé et écrit quelque chose (commande ou message normal)
        if (!isAuthorized) {
            // Permettre uniquement la commande /activate
            if (text.startsWith('/activate')) {
                if (!args.length) return msg.reply('❌ Usage: /activate XXXX-XXXX');
                const code = args[0];
                if (await db.validateCode(phone, code)) {
                    await msg.reply(`🎉 *COMPTE ACTIVÉ!*\n\n📋 Vos commandes:\n• /broadcast [message] - Diffuser\n• /addgroup - Ajouter un groupe\n• /status - Voir votre statut\n• /help - Aide complète\n\n✨ Bienvenue!`);
                } else {
                    await msg.reply('❌ Code d\'activation invalide ou expiré');
                }
                return;
            }
            
            // Pour tout autre message (commande ou texte normal), demander l'activation
            await msg.reply(`🔒 *ACCÈS REQUIS*\n\nVous devez activer votre compte avec un code.\n\n📞 Contactez l'admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\n💡 Commande: /activate XXXX-XXXX`);
            return;
        }

        // Utilisateur autorisé - traiter uniquement les commandes
        if (!text.startsWith('/')) return;

        // Commandes utilisateur autorisé
        switch (cmd) {
            case '/help':
                await userCommands.help(msg);
                break;
            case '/status':
                await userCommands.status(msg, phone);
                break;
            case '/addgroup':
                await userCommands.addgroup(msg, phone);
                break;
            case '/broadcast':
                await userCommands.broadcast(msg, phone, args);
                break;
            case '/activate':
                await msg.reply('✅ Votre compte est déjà activé! Tapez /help pour voir les commandes disponibles.');
                break;
            default:
                await msg.reply('❌ Commande inconnue. Tapez /help pour voir les commandes disponibles.');
        }

    } catch (error) {
        console.error('❌ Erreur traitement message:', error.message);
        await msg.reply('❌ Une erreur s\'est produite. Veuillez réessayer.');
    }
});
    await state.client.initialize();
}

// Tâches périodiques
setInterval(cleanup, 3600000); // Nettoyage toutes les heures
setInterval(() => saveCache(), CONFIG.BACKUP_INTERVAL_MS * 30); // Sauvegarde toutes les 30 minutes
setInterval(() => {
    const stats = db.getStats();
    console.log(`💗 Uptime: ${Math.floor(process.uptime())}s - Status: ${state.ready ? 'ONLINE' : 'OFFLINE'} - Users: ${stats.active_users} - Groups: ${stats.total_groups} - ☁️ Drive`);
}, 300000); // Log toutes les 5 minutes

// Arrêt propre du système
async function shutdown() {
    console.log('🛑 Arrêt du système en cours...');
    
    try {
        // Sauvegarder les données
        await saveCache();
        console.log('💾 Données sauvegardées');
        
        // Notifier l'admin de l'arrêt
        if (state.client && state.ready) {
            try {
                await state.client.sendMessage(CONFIG.ADMIN_NUMBER, 
                    `🛑 *BOT ARRÊTÉ*\n🕒 ${new Date().toLocaleString()}\n💾 Données sauvegardées`
                );
                console.log('📱 Admin notifié');
                await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                console.error('Erreur notification admin:', e.message);
            }
            
            // Fermer le client WhatsApp
            await state.client.destroy();
            console.log('📱 Client WhatsApp fermé');
        }
        
        // Fermer le serveur web
        if (state.server) {
            state.server.close();
            console.log('🌐 Serveur web fermé');
        }
        
    } catch (error) {
        console.error('❌ Erreur lors de l\'arrêt:', error.message);
    }
    
    console.log('✅ Arrêt terminé');
    process.exit(0);
}

// Gestionnaires de signaux système
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => {
    console.error('❌ Exception non gérée:', error);
    shutdown();
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesse rejetée non gérée:', reason);
});

// Fonction de démarrage principal
async function start() {
    console.log('🚀 DÉMARRAGE DU BOT WHATSAPP');
    console.log('📋 Configuration:');
    console.log(`   • Admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`);
    console.log(`   • Port: ${CONFIG.PORT}`);
    console.log(`   • Durée d'utilisation: ${CONFIG.USAGE_DAYS} jours`);
    console.log(`   • Expiration codes: ${CONFIG.CODE_EXPIRY_HOURS}h`);
    
    // Initialiser Google Drive
    if (!(await initGoogleDrive())) {
        console.error('❌ Échec de l\'initialisation de Google Drive');
        process.exit(1);
    }
    
    // Démarrer le serveur web
    state.server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
        console.log(`🌐 Serveur web démarré sur le port ${CONFIG.PORT}`);
    });
    
    // Initialiser le client WhatsApp
    console.log('📱 Initialisation du client WhatsApp...');
    await initClient();
}

// Point d'entrée si le fichier est exécuté directement
if (require.main === module) {
    start().catch(error => {
        console.error('❌ ERREUR FATALE:', error.message);
        console.error(error.stack);
        process.exit(1);
    });
}

// Export pour utilisation en tant que module
module.exports = { 
    start, 
    CONFIG, 
    state, 
    db, 
    adminCommands, 
    userCommands 
};

// === SYSTÈME DE GESTION DE GROUPES AVANCÉ ===
// À ajouter dans votre bot WhatsApp existant

// Configuration pour les nouveaux modules
const GROUP_CONFIG = {
    LINK_PATTERNS: [/https?:\/\/[^\s]+/, /www\.[^\s]+/, /t\.me\/[^\s]+/, /chat\.whatsapp\.com\/[^\s]+/],
    GAMES: {
        QUIZ: { POINTS: 10, TIME_LIMIT: 30000 },
        MATH: { POINTS: 5, TIME_LIMIT: 20000 },
        LOTO: { POINTS: 15, COST: 2, MAX_NUMBER: 50 }
    },
    MONTHLY_PRIZES: [
        { position: 1, amount: 1500, emoji: "🥇" },
        { position: 2, amount: 1000, emoji: "🥈" },
        { position: 3, amount: 500, emoji: "🥉" }
    ],
    PRIZE_CONTACT: "237651104356",
    POINT_REWARDS: { MESSAGE_USE: 1, GAME_PARTICIPATION: 2, DAILY_BONUS: 5 }
};

// État étendu pour les groupes
const groupState = {
    activeGames: new Map(),
    gameQuestions: new Map(),
    leaderboards: new Map(),
    monthlyWinners: new Map()
};

// Base de données étendue pour les groupes
const groupDB = {
    async getGroupSettings(groupId) {
        if (!state.cache.groups.has(groupId)) {
            const defaultSettings = {
                groupId, name: "Groupe", settings: {
                    antiLink: false, welcomeMsg: true, gameMode: true,
                    autoDelete: false, adminOnly: false
                },
                moderators: [], createdAt: new Date().toISOString()
            };
            state.cache.groups.set(groupId, defaultSettings);
            await saveCache('groups');
        }
        return state.cache.groups.get(groupId);
    },

    async updateGroupSettings(groupId, newSettings) {
        const group = await this.getGroupSettings(groupId);
        group.settings = { ...group.settings, ...newSettings };
        group.updatedAt = new Date().toISOString();
        state.cache.groups.set(groupId, group);
        await saveCache('groups');
        return group;
    },

    async getUserStats(phone, groupId = null) {
        const key = `${phone}${groupId ? `_${groupId}` : ''}`;
        if (!state.cache.users.has(key)) {
            const stats = {
                phone, groupId, points: 0, gamesPlayed: 0, gamesWon: 0,
                level: 1, lastActive: new Date().toISOString(),
                dailyStreak: 0, lastDaily: null, achievements: []
            };
            state.cache.users.set(key, stats);
        }
        return state.cache.users.get(key);
    },

    async updateUserStats(phone, groupId, updates) {
        const key = `${phone}${groupId ? `_${groupId}` : ''}`;
        const stats = await this.getUserStats(phone, groupId);
        Object.assign(stats, updates, { lastActive: new Date().toISOString() });
        
        // Calcul automatique du niveau
        const newLevel = Math.floor(stats.points / 100) + 1;
        if (newLevel > stats.level) {
            stats.level = newLevel;
            stats.achievements.push(`Niveau ${newLevel} atteint!`);
        }
        
        state.cache.users.set(key, stats);
        await saveCache('users');
        return stats;
    },

    async getTopPlayers(groupId = null, limit = 10) {
        const players = [];
        const suffix = groupId ? `_${groupId}` : '';
        
        for (const [key, user] of state.cache.users) {
            if (key.endsWith(suffix) && user.points > 0) {
                players.push({
                    phone: user.phone.replace('@c.us', ''),
                    points: user.points,
                    level: user.level,
                    gamesWon: user.gamesWon || 0,
                    winRate: user.gamesPlayed ? ((user.gamesWon || 0) / user.gamesPlayed * 100).toFixed(1) : 0
                });
            }
        }
        
        return players.sort((a, b) => b.points - a.points).slice(0, limit);
    }
};

// Modérateur de liens
const linkModerator = {
    async checkMessage(msg, groupSettings) {
        if (!groupSettings.settings.antiLink) return false;
        
        const hasLink = GROUP_CONFIG.LINK_PATTERNS.some(pattern => pattern.test(msg.body));
        if (!hasLink) return false;
        
        const chat = await msg.getChat();
        const contact = await msg.getContact();
        const isAdmin = await this.isGroupAdmin(chat, contact.id._serialized);
        const isBotAdmin = contact.id._serialized === CONFIG.ADMIN_NUMBER;
        const isModerator = groupSettings.moderators.includes(contact.id._serialized);
        
        if (isAdmin || isBotAdmin || isModerator) return false;
        
        try {
            await msg.delete(true);
            const warning = await msg.reply(`⚠️ @${contact.number} Les liens ne sont pas autorisés dans ce groupe!`);
            setTimeout(() => warning.delete().catch(() => {}), 10000);
            return true;
        } catch (error) {
            console.error('Erreur suppression lien:', error.message);
            return false;
        }
    },

    async isGroupAdmin(chat, userId) {
        try {
            const participant = chat.participants.find(p => p.id._serialized === userId);
            return participant && participant.isAdmin;
        } catch {
            return false;
        }
    }
};

// Générateur de jeux IA
const gameEngine = {
    generateQuiz() {
        const topics = [
            { q: "Quelle est la capitale du Cameroun?", a: ["Yaoundé", "douala", "yaounde"], cat: "Géographie" },
            { q: "Combien font 15 × 8?", a: ["120"], cat: "Mathématiques" },
            { q: "En quelle année le Cameroun a-t-il obtenu son indépendance?", a: ["1960"], cat: "Histoire" },
            { q: "Quel est le plus grand océan du monde?", a: ["Pacifique", "océan pacifique"], cat: "Géographie" },
            { q: "Qui a écrit 'Le Vieux Nègre et la Médaille'?", a: ["Ferdinand Oyono", "oyono"], cat: "Littérature" },
            { q: "Combien de régions compte le Cameroun?", a: ["10", "dix"], cat: "Géographie" },
            { q: "Quelle est la monnaie du Cameroun?", a: ["CFA", "FCFA", "Franc CFA"], cat: "Économie" },
            { q: "Quel fleuve traverse Douala?", a: ["Wouri"], cat: "Géographie" }
        ];
        return topics[Math.floor(Math.random() * topics.length)];
    },

    generateMath() {
        const operations = ['+', '-', '×', '÷'];
        const op = operations[Math.floor(Math.random() * operations.length)];
        let a, b, answer, question;
        
        switch(op) {
            case '+':
                a = Math.floor(Math.random() * 100) + 1;
                b = Math.floor(Math.random() * 100) + 1;
                answer = a + b;
                question = `${a} + ${b}`;
                break;
            case '-':
                a = Math.floor(Math.random() * 100) + 50;
                b = Math.floor(Math.random() * 50) + 1;
                answer = a - b;
                question = `${a} - ${b}`;
                break;
            case '×':
                a = Math.floor(Math.random() * 15) + 1;
                b = Math.floor(Math.random() * 15) + 1;
                answer = a * b;
                question = `${a} × ${b}`;
                break;
            case '÷':
                answer = Math.floor(Math.random() * 20) + 1;
                b = Math.floor(Math.random() * 10) + 2;
                a = answer * b;
                question = `${a} ÷ ${b}`;
                break;
        }
        
        return { question, answer: answer.toString(), category: "Calcul" };
    },

    generateLoto() {
        const winningNumbers = [];
        while (winningNumbers.length < 5) {
            const num = Math.floor(Math.random() * GROUP_CONFIG.GAMES.LOTO.MAX_NUMBER) + 1;
            if (!winningNumbers.includes(num)) winningNumbers.push(num);
        }
        return winningNumbers.sort((a, b) => a - b);
    },

    async startGame(groupId, type, msg) {
        if (groupState.activeGames.has(groupId)) {
            return msg.reply("🎮 Un jeu est déjà en cours dans ce groupe!");
        }

        let gameData;
        switch(type) {
            case 'quiz':
                gameData = this.generateQuiz();
                gameData.type = 'quiz';
                gameData.timeLimit = GROUP_CONFIG.GAMES.QUIZ.TIME_LIMIT;
                gameData.points = GROUP_CONFIG.GAMES.QUIZ.POINTS;
                break;
            case 'math':
                gameData = this.generateMath();
                gameData.type = 'math';
                gameData.timeLimit = GROUP_CONFIG.GAMES.MATH.TIME_LIMIT;
                gameData.points = GROUP_CONFIG.GAMES.MATH.POINTS;
                break;
            case 'loto':
                gameData = {
                    type: 'loto',
                    winningNumbers: this.generateLoto(),
                    participants: new Map(),
                    timeLimit: 60000,
                    points: GROUP_CONFIG.GAMES.LOTO.POINTS
                };
                break;
        }

        gameData.startTime = Date.now();
        gameData.groupId = groupId;
        gameData.participants = gameData.participants || new Set();
        
        groupState.activeGames.set(groupId, gameData);
        
        // Message de lancement
        let gameMsg;
        if (type === 'loto') {
            gameMsg = `🎰 *JEU DE LOTO* 🎰\n\nChoisissez 5 numéros entre 1 et ${GROUP_CONFIG.GAMES.LOTO.MAX_NUMBER}\nFormat: /loto 5 12 23 31 45\nCoût: ${GROUP_CONFIG.GAMES.LOTO.COST} points\nGain: ${gameData.points} points\n⏰ 60 secondes!`;
        } else {
            gameMsg = `🧠 *${type.toUpperCase()}* - ${gameData.category}\n\n❓ ${gameData.question}\n\n💎 Points: ${gameData.points}\n⏰ ${gameData.timeLimit/1000}s pour répondre!\n\nTapez votre réponse!`;
        }
        
        await msg.reply(gameMsg);
        
        // Timer automatique
        setTimeout(() => this.endGame(groupId, msg), gameData.timeLimit);
    },

    async handleAnswer(msg, groupId) {
        const game = groupState.activeGames.get(groupId);
        if (!game) return;

        const contact = await msg.getContact();
        const phone = contact.id._serialized;
        const answer = msg.body.trim().toLowerCase();

        if (game.type === 'loto') {
            if (!msg.body.startsWith('/loto')) return;
            
            const numbers = msg.body.split(' ').slice(1).map(n => parseInt(n)).filter(n => n >= 1 && n <= GROUP_CONFIG.GAMES.LOTO.MAX_NUMBER);
            if (numbers.length !== 5) {
                return msg.reply("❌ Veuillez choisir exactement 5 numéros valides!");
            }

            const userStats = await groupDB.getUserStats(phone, groupId);
            if (userStats.points < GROUP_CONFIG.GAMES.LOTO.COST) {
                return msg.reply(`❌ Points insuffisants! (${GROUP_CONFIG.GAMES.LOTO.COST} requis)`);
            }

            game.participants.set(phone, { numbers, name: contact.pushname || contact.number });
            await groupDB.updateUserStats(phone, groupId, { 
                points: userStats.points - GROUP_CONFIG.GAMES.LOTO.COST,
                gamesPlayed: (userStats.gamesPlayed || 0) + 1
            });

            await msg.reply(`✅ Participation enregistrée: ${numbers.join(', ')}`);
            return;
        }

        // Quiz et Math
        const correctAnswers = Array.isArray(game.answer) ? game.answer : [game.answer];
        const isCorrect = correctAnswers.some(correct => correct.toLowerCase() === answer);

        if (isCorrect && !game.participants.has(phone)) {
            game.participants.add(phone);
            game.winner = { phone, name: contact.pushname || contact.number };
            
            await groupDB.updateUserStats(phone, groupId, { 
                points: (await groupDB.getUserStats(phone, groupId)).points + game.points,
                gamesPlayed: ((await groupDB.getUserStats(phone, groupId)).gamesPlayed || 0) + 1,
                gamesWon: ((await groupDB.getUserStats(phone, groupId)).gamesWon || 0) + 1
            });

            await msg.reply(`🎉 *BRAVO ${game.winner.name}!*\n✅ Réponse correcte!\n💎 +${game.points} points`);
            this.endGame(groupId, msg);
        }
    },

    async endGame(groupId, msg) {
        const game = groupState.activeGames.get(groupId);
        if (!game) return;

        groupState.activeGames.delete(groupId);

        if (game.type === 'loto') {
            const winners = [];
            for (const [phone, data] of game.participants) {
                const matches = data.numbers.filter(n => game.winningNumbers.includes(n)).length;
                if (matches >= 3) {
                    const prize = matches === 5 ? game.points * 2 : matches === 4 ? game.points : Math.floor(game.points / 2);
                    winners.push({ ...data, phone, matches, prize });
                    
                    await groupDB.updateUserStats(phone, groupId, { 
                        points: (await groupDB.getUserStats(phone, groupId)).points + prize,
                        gamesWon: ((await groupDB.getUserStats(phone, groupId)).gamesWon || 0) + 1
                    });
                }
            }

            let resultMsg = `🎰 *RÉSULTATS LOTO* 🎰\n\n🎯 Numéros gagnants: ${game.winningNumbers.join(', ')}\n👥 ${game.participants.size} participant(s)\n\n`;
            
            if (winners.length > 0) {
                resultMsg += "🏆 *GAGNANTS:*\n";
                winners.forEach(w => {
                    resultMsg += `• ${w.name}: ${w.matches}/5 = ${w.prize} pts\n`;
                });
            } else {
                resultMsg += "😢 Aucun gagnant cette fois!";
            }

            await msg.reply(resultMsg);
        } else if (!game.winner) {
            const correctAnswer = Array.isArray(game.answer) ? game.answer[0] : game.answer;
            await msg.reply(`⏰ *TEMPS ÉCOULÉ!*\n\nLa réponse était: **${correctAnswer}**\nTentez votre chance au prochain jeu! 🎮`);
        }
    }
};

// Système de classement mensuel
const leaderboardSystem = {
    async checkMonthlyReset() {
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
        
        if (!groupState.monthlyWinners.has(currentMonth)) {
            await this.processMonthlyWinners();
            groupState.monthlyWinners.set(currentMonth, true);
        }
    },

    async processMonthlyWinners() {
        try {
            const topPlayers = await groupDB.getTopPlayers(null, 3);
            if (topPlayers.length === 0) return;

            let winnerMsg = "🏆 *GAGNANTS DU MOIS* 🏆\n\n";
            
            for (let i = 0; i < topPlayers.length && i < 3; i++) {
                const player = topPlayers[i];
                const prize = GROUP_CONFIG.MONTHLY_PRIZES[i];
                
                winnerMsg += `${prize.emoji} **${i + 1}er**: ${player.phone}\n`;
                winnerMsg += `   💎 ${player.points} points\n`;
                winnerMsg += `   🏆 ${player.gamesWon} victoires\n`;
                winnerMsg += `   💰 Gain: ${prize.amount} FCFA\n\n`;

                // Notification privée au gagnant
                try {
                    await state.client.sendMessage(`${player.phone}@c.us`, 
                        `🎉 *FÉLICITATIONS!* 🎉\n\nVous êtes ${prize.emoji} **${prize.position}${prize.position === 1 ? 'er' : 'ème'}** du classement mensuel!\n\n💰 Votre gain: **${prize.amount} FCFA**\n\n📞 Contactez ${GROUP_CONFIG.PRIZE_CONTACT} pour récupérer votre prix!\n\n🏆 Continuez à jouer pour le mois prochain!`
                    );
                } catch (e) {
                    console.error(`Erreur notification gagnant ${player.phone}:`, e.message);
                }
            }

            winnerMsg += `📞 Contact pour les gains: ${GROUP_CONFIG.PRIZE_CONTACT}`;

            // Notifier l'admin
            await state.client.sendMessage(CONFIG.ADMIN_NUMBER, winnerMsg);

            // Reset des points pour le nouveau mois
            await this.resetMonthlyPoints();
            
        } catch (error) {
            console.error('Erreur traitement gagnants mensuels:', error.message);
        }
    },

    async resetMonthlyPoints() {
        for (const [key, user] of state.cache.users) {
            if (user.points > 0) {
                user.points = Math.floor(user.points * 0.1); // Garde 10% des points
                user.gamesWon = 0;
                user.gamesPlayed = 0;
            }
        }
        await saveCache('users');
        console.log('🔄 Points mensuels réinitialisés');
    }
};

// Commandes de groupe étendues
const groupCommands = {
    async settings(msg, args) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply("❌ Commande réservée aux groupes!");

        const contact = await msg.getContact();
        const isAdmin = await linkModerator.isGroupAdmin(chat, contact.id._serialized);
        const isBotAdmin = contact.id._serialized === CONFIG.ADMIN_NUMBER;

        if (!isAdmin && !isBotAdmin) {
            return msg.reply("❌ Seuls les administrateurs peuvent modifier les paramètres!");
        }

        const groupSettings = await groupDB.getGroupSettings(chat.id._serialized);

        if (!args.length) {
            const settings = groupSettings.settings;
            return msg.reply(`🔧 *PARAMÈTRES DU GROUPE*\n\n🔗 Anti-liens: ${settings.antiLink ? '✅' : '❌'}\n👋 Message bienvenue: ${settings.welcomeMsg ? '✅' : '❌'}\n🎮 Mode jeu: ${settings.gameMode ? '✅' : '❌'}\n🗑️ Auto-suppression: ${settings.autoDelete ? '✅' : '❌'}\n👑 Admin uniquement: ${settings.adminOnly ? '✅' : '❌'}\n\n💡 Usage: /settings antilink on/off`);
        }

        const [setting, value] = args;
        const newValue = ['on', 'true', '1', 'oui'].includes(value?.toLowerCase());

        const validSettings = ['antilink', 'welcome', 'game', 'autodelete', 'adminonly'];
        const settingKey = {
            'antilink': 'antiLink', 'welcome': 'welcomeMsg', 'game': 'gameMode',
            'autodelete': 'autoDelete', 'adminonly': 'adminOnly'
        }[setting?.toLowerCase()];

        if (!settingKey) {
            return msg.reply(`❌ Paramètre invalide!\nDisponibles: ${validSettings.join(', ')}`);
        }

        await groupDB.updateGroupSettings(chat.id._serialized, { [settingKey]: newValue });
        await msg.reply(`✅ ${setting}: ${newValue ? 'Activé' : 'Désactivé'}`);
    },

    async game(msg, args) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply("❌ Commande réservée aux groupes!");

        const groupSettings = await groupDB.getGroupSettings(chat.id._serialized);
        if (!groupSettings.settings.gameMode) {
            return msg.reply("❌ Les jeux sont désactivés dans ce groupe!");
        }

        const gameType = args[0]?.toLowerCase();
        const validGames = ['quiz', 'math', 'loto'];

        if (!gameType || !validGames.includes(gameType)) {
            return msg.reply(`🎮 *JEUX DISPONIBLES*\n\n🧠 /game quiz - Questions culture générale\n🔢 /game math - Calcul mental\n🎰 /game loto - Jeu de numéros\n\n📊 /rank - Voir le classement\n💎 /points - Voir vos points`);
        }

        await gameEngine.startGame(chat.id._serialized, gameType, msg);
    },

    async rank(msg, args) {
        const chat = await msg.getChat();
        const groupId = chat.isGroup ? chat.id._serialized : null;
        const isGlobal = args[0]?.toLowerCase() === 'global';

        const topPlayers = await groupDB.getTopPlayers(isGlobal ? null : groupId, 10);
        
        if (!topPlayers.length) {
            return msg.reply("📊 Aucun joueur dans le classement pour le moment!");
        }

        let rankMsg = `🏆 *CLASSEMENT ${isGlobal ? 'GLOBAL' : 'DU GROUPE'}*\n\n`;
        
        topPlayers.forEach((player, i) => {
            const medal = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`;
            rankMsg += `${medal} ${player.phone}\n`;
            rankMsg += `   💎 ${player.points} pts | 🏆 ${player.gamesWon} | 📊 ${player.winRate}%\n\n`;
        });

        rankMsg += `💰 Prix mensuels: ${GROUP_CONFIG.MONTHLY_PRIZES.map(p => `${p.emoji} ${p.amount}F`).join(' | ')}`;

        await msg.reply(rankMsg);
    },

    async points(msg) {
        const contact = await msg.getContact();
        const chat = await msg.getChat();
        const groupId = chat.isGroup ? chat.id._serialized : null;
        
        const stats = await groupDB.getUserStats(contact.id._serialized, groupId);
        const dailyBonus = await this.checkDailyBonus(contact.id._serialized);

        let pointsMsg = `💎 *VOS STATISTIQUES*\n\n📊 Points: ${stats.points}\n🏆 Niveau: ${stats.level}\n🎮 Jeux joués: ${stats.gamesPlayed || 0}\n✅ Victoires: ${stats.gamesWon || 0}\n📈 Ratio: ${stats.gamesPlayed ? ((stats.gamesWon || 0) / stats.gamesPlayed * 100).toFixed(1) : 0}%`;

        if (dailyBonus > 0) {
            pointsMsg += `\n\n🎁 Bonus quotidien: +${dailyBonus} pts`;
        }

        if (stats.achievements?.length > 0) {
            pointsMsg += `\n\n🏅 Derniers succès:\n${stats.achievements.slice(-3).map(a => `• ${a}`).join('\n')}`;
        }

        await msg.reply(pointsMsg);
    },

    async checkDailyBonus(phone) {
        const today = new Date().toDateString();
        const stats = await groupDB.getUserStats(phone);
        
        if (stats.lastDaily !== today) {
            const bonus = GROUP_CONFIG.POINT_REWARDS.DAILY_BONUS;
            const newStreak = stats.lastDaily === new Date(Date.now() - 86400000).toDateString() ? 
                (stats.dailyStreak || 0) + 1 : 1;
            
            await groupDB.updateUserStats(phone, null, {
                points: stats.points + bonus,
                dailyStreak: newStreak,
                lastDaily: today
            });
            
            return bonus;
        }
        return 0;
    }
};

// Intégration dans le gestionnaire de messages principal
const originalMessageHandler = state.client.on;

// Hook pour intercepter les messages de groupe
async function handleGroupMessage(msg) {
    if (!msg.from.includes('@g.us')) return false; // Pas un groupe

    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const groupId = chat.id._serialized;
    const phone = contact.id._serialized;

    try {
        // Charger les paramètres du groupe
        const groupSettings = await groupDB.getGroupSettings(groupId);
        
        // Modération des liens
        const linkDeleted = await linkModerator.checkMessage(msg, groupSettings);
        if (linkDeleted) return true;

        // Gestion des jeux actifs
        if (groupState.activeGames.has(groupId)) {
            await gameEngine.handleAnswer(msg, groupId);
        }

        // Commandes de groupe
        if (msg.body.startsWith('/')) {
            const [cmd, ...args] = msg.body.slice(1).split(' ');
            
            switch(cmd.toLowerCase()) {
                case 'settings':
                case 'config':
                    await groupCommands.settings(msg, args);
                    return true;
                case 'game':
                case 'jeu':
                    await groupCommands.game(msg, args);
                    return true;
                case 'rank':
                case 'classement':
                    await groupCommands.rank(msg, args);
                    return true;
                case 'points':
                case 'stats':
                    await groupCommands.points(msg);
                    return true;
                case 'loto':
                    if (groupState.activeGames.has(groupId)) {
                        await gameEngine.handleAnswer(msg, groupId);
                    }
                    return true;
            }
        }

        // Attribution de points pour activité
        if (await db.isAuthorized(phone)) {
            const currentStats = await groupDB.getUserStats(phone, groupId);
            await groupDB.updateUserStats(phone, groupId, {
                points: currentStats.points + GROUP_CONFIG.POINT_REWARDS.MESSAGE_USE
            });
        }

        return false; // Laisser passer pour traitement normal
        
    } catch (error) {
        console.error('Erreur gestion message groupe:', error.message);
        return false;
    }
}

// Tâches automatiques étendues
setInterval(() => leaderboardSystem.checkMonthlyReset(), 3600000); // Check mensuel chaque heure
setInterval(() => {
    // Nettoyage des jeux abandonnés
    const now = Date.now();
    for (const [groupId, game] of groupState.activeGames) {
        if (now - game.startTime > game.timeLimit + 30000) {
            groupState.activeGames.delete(groupId);
            console.log(`🧹 Jeu abandonné nettoyé: ${groupId}`);
        }
    }
}, 300000); // Toutes les 5 minutes

// Export des nouveaux modules
module.exports = {
    ...module.exports,
    groupDB,
    groupCommands,
    gameEngine,
    linkModerator,
    leaderboardSystem,
    handleGroupMessage,
    GROUP_CONFIG
};

console.log('🎮 Système de gestion de groupes avancé chargé!');
