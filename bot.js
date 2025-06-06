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

// Interface web
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    const html = state.ready ? 
        `<h1 style="color:green">✅ Bot En Ligne</h1><p>☁️ Google Drive</p><p>🕒 ${new Date().toLocaleString()}</p>` :
        state.qr ? 
        `<h1>📱 Scanner QR</h1><img src="data:image/png;base64,${state.qr}"><script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1>🔄 Chargement...</h1><script>setTimeout(()=>location.reload(),10000)</script>`;
    
    res.send(`<!DOCTYPE html><html><head><title>Bot</title><style>body{font-family:Arial;text-align:center;background:#25D366;color:white;padding:50px}img{background:white;padding:20px;border-radius:10px}</style></head><body>${html}</body></html>`);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: state.ready ? 'online' : 'offline',
        uptime: Math.floor(process.uptime()),
        cache: { users: state.cache.users.size, codes: state.cache.codes.size, groups: state.cache.groups.size }
    });
});

// Client WhatsApp
async function reconnect() {
    if (state.reconnects >= state.maxReconnects) {
        console.log('❌ Limite reconnexion atteinte');
        return;
    }
    state.reconnects++;
    console.log(`🔄 Reconnexion ${state.reconnects}/${state.maxReconnects}`);
    try {
        if (state.client) await state.client.destroy();
        await new Promise(r => setTimeout(r, 5000));
        await initClient();
    } catch (error) {
        console.error('❌ Erreur reconnexion:', error.message);
    }
}

async function initClient() {
    // Attendre que Google Drive soit prêt
    if (!state.drive || !state.fileIds.SESSION) {
        console.log('⏳ Attente initialisation Google Drive...');
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
        console.log('📱 QR généré');
        state.qr = (await QRCode.toDataURL(qr, { width: 400 })).split(',')[1];
        setTimeout(() => { if (!state.ready) state.qr = null; }, 120000);
    });

    state.client.on('authenticated', () => {
        console.log('🔐 Authentifié');
        state.qr = null;
        state.reconnects = 0;
    });

    state.client.on('auth_failure', () => {
        console.log('❌ Échec auth');
        setTimeout(reconnect, 10000);
    });

    state.client.on('ready', async () => {
        state.ready = true;
        state.qr = null;
        console.log('🎉 BOT PRÊT!');
        setTimeout(async () => {
            try {
                await state.client.sendMessage(CONFIG.ADMIN_NUMBER, `🎉 *BOT EN LIGNE*\n☁️ Google Drive\n🕒 ${new Date().toLocaleString()}`);
            } catch (e) {}
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
            const cmd = text.toLowerCase();

            // Admin
            if (phone === CONFIG.ADMIN_NUMBER) {
                if (cmd.startsWith('/gencode ')) {
                    const number = text.substring(9).trim();
                    if (!number) return msg.reply('❌ Usage: /gencode [numéro]');
                    const targetPhone = number.includes('@') ? number : `${number}@c.us`;
                    const code = await db.createCode(targetPhone);
                    await msg.reply(`✅ *CODE*\n👤 ${number}\n🔑 ${code}\n⏰ 24h`);
                } else if (cmd === '/stats') {
                    const stats = db.getStats();
                    await msg.reply(`📊 *STATS*\n👥 ${stats.total_users}\n✅ ${stats.active_users}\n🔑 ${stats.total_codes}/${stats.used_codes}\n📢 ${stats.total_groups}`);
                } else if (cmd === '/backup') {
                    await saveCache();
                    await msg.reply('✅ Backup effectué!');
                }
                return;
            }

            // Activation
            if (cmd.startsWith('/activate ')) {
                const code = text.substring(10).trim();
                if (!code) return msg.reply('❌ Usage: /activate XXXX-XXXX');
                if (await db.validateCode(phone, code)) {
                    await msg.reply(`🎉 *ACTIVÉ!*\n📋 Commandes:\n• /broadcast [msg]\n• /addgroup\n• /status`);
                } else {
                    await msg.reply('❌ Code invalide');
                }
                return;
            }

            // Vérifier autorisation
            if (!(await db.isAuthorized(phone))) {
                return msg.reply(`🔒 Accès requis\n📞 ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`);
            }

            // Commandes utilisateur
            if (cmd === '/status') {
                const userData = state.cache.users.get(phone);
                const remaining = Math.ceil(CONFIG.USAGE_DAYS - (Date.now() - new Date(userData.activatedAt)) / 86400000);
                const groups = await db.getUserGroups(phone);
                await msg.reply(`📊 *STATUT*\n🟢 Actif\n📅 ${remaining} jours\n📢 ${groups.length} groupes`);
            } else if (cmd === '/addgroup') {
                const chat = await msg.getChat();
                if (!chat.isGroup) return msg.reply('❌ Uniquement dans les groupes!');
                const added = await db.addGroup(chat.id._serialized, chat.name, phone);
                await msg.reply(added ? `✅ Groupe ajouté: ${chat.name}` : `ℹ️ Déjà enregistré`);
            } else if (cmd.startsWith('/broadcast ')) {
                const message = text.substring(11).trim();
                if (!message) return msg.reply('❌ Usage: /broadcast [message]');
                const groups = await db.getUserGroups(phone);
                if (!groups.length) return msg.reply('❌ Aucun groupe!');
                await msg.reply(`🚀 Diffusion vers ${groups.length} groupe(s)...`);
                
                let success = 0;
                const senderName = contact.pushname || 'Utilisateur';
                for (const group of groups) {
                    try {
                        const fullMsg = `📢 *DIFFUSION*\n👤 ${senderName}\n\n${message}`;
                        await state.client.sendMessage(group.group_id, fullMsg);
                        success++;
                        await new Promise(r => setTimeout(r, 2000));
                    } catch (e) {}
                }
                await msg.reply(`📊 *RÉSULTAT*\n✅ ${success}/${groups.length}`);
            } else if (cmd === '/help') {
                const groups = await db.getUserGroups(phone);
                await msg.reply(`🤖 *COMMANDES*\n• /broadcast [msg]\n• /addgroup\n• /status\n• /help\n\n📊 ${groups.length} groupe(s)`);
            }
        } catch (error) {
            console.error('❌ Erreur message:', error.message);
        }
    });

    await state.client.initialize();
}

// Tâches périodiques
setInterval(cleanup, 3600000); // 1h
setInterval(() => saveCache(), CONFIG.BACKUP_INTERVAL_MS * 30); // 30min
setInterval(() => console.log(`💗 ${Math.floor(process.uptime())}s - ${state.ready ? 'ONLINE' : 'OFFLINE'} - ☁️ Drive`), 300000); // 5min

// Arrêt propre
async function shutdown() {
    console.log('🛑 Arrêt...');
    await saveCache();
    if (state.client && state.ready) {
        try {
            await state.client.sendMessage(CONFIG.ADMIN_NUMBER, '🛑 Bot arrêté');
            await new Promise(r => setTimeout(r, 2000));
            await state.client.destroy();
        } catch (e) {}
    }
    if (state.server) state.server.close();
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Démarrage
async function start() {
    console.log('🚀 DÉMARRAGE BOT');
    if (!(await initGoogleDrive())) {
        console.error('❌ Échec Google Drive');
        process.exit(1);
    }
    state.server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
        console.log(`🌐 Port ${CONFIG.PORT}`);
    });
    await initClient();
}

if (require.main === module) {
    start().catch(error => {
        console.error('❌ ERREUR:', error.message);
        process.exit(1);
    });
}

module.exports = { start, CONFIG, state };
