const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// Configuration centralisée
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    PORT: process.env.PORT || 3000,
    USAGE_DAYS: 30,
    CODE_EXPIRY_HOURS: 24,
    QR_TIMEOUT: 120000,
    // Fichiers de données
    DATA_DIR: './data',
    FILES: {
        USERS: './data/users.json',
        CODES: './data/codes.json',
        GROUPS: './data/groups.json'
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
    }
};

// Initialisation du système de fichiers
async function initDB() {
    try {
        // Créer le dossier data
        await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
        
        // Initialiser les fichiers JSON s'ils n'existent pas
        for (const [key, file] of Object.entries(CONFIG.FILES)) {
            try {
                await fs.access(file);
            } catch {
                await fs.writeFile(file, '{}');
                console.log(`📄 Créé: ${file}`);
            }
        }
        
        // Charger les données en cache
        await loadCache();
        
        // Nettoyage automatique au démarrage
        await cleanupExpiredData();
        
        console.log('✅ Système de fichiers JSON initialisé');
        return true;
    } catch (error) {
        console.error('❌ Erreur fichiers:', error.message);
        return false;
    }
}

// Charger toutes les données en cache
async function loadCache() {
    try {
        const [usersData, codesData, groupsData] = await Promise.all([
            fs.readFile(CONFIG.FILES.USERS, 'utf8'),
            fs.readFile(CONFIG.FILES.CODES, 'utf8'),
            fs.readFile(CONFIG.FILES.GROUPS, 'utf8')
        ]);
        
        const users = JSON.parse(usersData || '{}');
        const codes = JSON.parse(codesData || '{}');
        const groups = JSON.parse(groupsData || '{}');
        
        // Convertir en Map pour performance
        state.cache.users = new Map(Object.entries(users));
        state.cache.codes = new Map(Object.entries(codes));
        state.cache.groups = new Map(Object.entries(groups));
        
        console.log(`📊 Cache chargé: ${state.cache.users.size} users, ${state.cache.codes.size} codes, ${state.cache.groups.size} groups`);
    } catch (error) {
        console.error('❌ Erreur chargement cache:', error.message);
    }
}

// Sauvegarder les données sur disque
async function saveData(type) {
    try {
        let data, file;
        
        switch (type) {
            case 'users':
                data = Object.fromEntries(state.cache.users);
                file = CONFIG.FILES.USERS;
                break;
            case 'codes':
                data = Object.fromEntries(state.cache.codes);
                file = CONFIG.FILES.CODES;
                break;
            case 'groups':
                data = Object.fromEntries(state.cache.groups);
                file = CONFIG.FILES.GROUPS;
                break;
            default:
                return false;
        }
        
        await fs.writeFile(file, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`❌ Erreur sauvegarde ${type}:`, error.message);
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

// Fonctions base de données JSON
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
        `<h1 style="color:green">✅ Bot En Ligne</h1><p>🕒 ${new Date().toLocaleString()}</p><p>📄 JSON Files</p>` :
        state.qr ? 
        `<h1>📱 Scanner QR Code</h1><img src="data:image/png;base64,${state.qr}"><script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1>🔄 Initialisation...</h1><script>setTimeout(()=>location.reload(),10000)</script>`;
    
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp Bot</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial;text-align:center;background:#25D366;color:white;padding:50px}img{background:white;padding:20px;border-radius:10px}</style></head><body>${html}</body></html>`);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: state.ready ? 'online' : 'offline',
        database: 'json-files',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        cache_size: {
            users: state.cache.users.size,
            codes: state.cache.codes.size,
            groups: state.cache.groups.size
        }
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
                    `🎉 *BOT EN LIGNE*\n✅ JSON Files connecté\n🕒 ${new Date().toLocaleString()}`);
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
                    await msg.reply(`📊 *STATS JSON*\n👥 Total: ${stats.total_users}\n✅ Actifs: ${stats.active_users}\n🔑 Codes: ${stats.total_codes}/${stats.used_codes}\n📢 Groupes: ${stats.total_groups}`);
                    
                } else if (cmd === '/backup') {
                    // Sauvegarder tout
                    await Promise.all([
                        saveData('users'),
                        saveData('codes'),
                        saveData('groups')
                    ]);
                    await msg.reply('✅ Backup effectué!');
                    
                } else if (cmd === '/help') {
                    await msg.reply('🤖 *ADMIN*\n• /gencode [num] - Créer code\n• /stats - Statistiques\n• /backup - Sauvegarder\n• /help - Aide');
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
                await msg.reply(`📊 *STATUT*\n🟢 Actif\n📅 ${remaining} jours restants\n📢 ${groups.length} groupes\n📄 JSON Files`);
                
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
                await msg.reply(`🤖 *COMMANDES*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Mon statut\n• /help - Aide\n\n📊 ${groups.length} groupe(s)\n📄 JSON Files`);
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
        
        console.log('💾 Sauvegarde périodique effectuée');
    } catch (e) {
        console.error('❌ Erreur sauvegarde périodique:', e.message);
    }
}, 3600000); // 1h

// Keep-alive pour Render
setInterval(() => {
    console.log(`💗 Uptime: ${Math.floor(process.uptime())}s - ${state.ready ? 'ONLINE' : 'OFFLINE'} - 📄 JSON (${state.cache.users.size}/${state.cache.codes.size}/${state.cache.groups.size})`);
}, 300000);

// Démarrage
async function start() {
    console.log('🚀 DÉMARRAGE BOT WHATSAPP');
    console.log('💾 Base: Fichiers JSON (100% GRATUIT)');
    console.log('🌐 Hébergeur: Render');
    
    if (!(await initDB())) {
        console.error('❌ Échec initialisation fichiers');
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
        console.log('💾 Données sauvegardées');
    } catch (e) {
        console.error('❌ Erreur sauvegarde finale:', e.message);
    }
    
    if (state.client) {
        try {
            await state.client.sendMessage(CONFIG.ADMIN_NUMBER, '🛑 Bot arrêté - données sauvegardées');
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
