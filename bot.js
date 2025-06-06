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
        if (!state.ready || !msg.body || !msg.body.startsWith('/')) return;
        
        try {
            const contact = await msg.getContact();
            if (!contact || contact.isMe) return;

            const phone = contact.id._serialized;
            const text = msg.body.trim();
            const args = text.split(' ').slice(1);
            const cmd = text.split(' ')[0].toLowerCase();

            // Commandes Admin
            if (phone === CONFIG.ADMIN_NUMBER) {
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

            // Activation (pour tous les utilisateurs)
            if (cmd === '/activate') {
                if (!args.length) return msg.reply('❌ Usage: /activate XXXX-XXXX');
                const code = args[0];
                if (await db.validateCode(phone, code)) {
                    await msg.reply(`🎉 *COMPTE ACTIVÉ!*\n\n📋 Vos commandes:\n• /broadcast [message] - Diffuser\n• /addgroup - Ajouter un groupe\n• /status - Voir votre statut\n• /help - Aide complète\n\n✨ Bienvenue!`);
                } else {
                    await msg.reply('❌ Code d\'activation invalide ou expiré');
                }
                return;
            }

            // Vérifier l'autorisation pour les autres commandes
            if (!(await db.isAuthorized(phone))) {
                return msg.reply(`🔒 *ACCÈS REQUIS*\n\nVous devez activer votre compte avec un code.\n\n📞 Contactez l'admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\n💡 Commande: /activate XXXX-XXXX`);
            }

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
