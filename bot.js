const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// Configuration centralisée
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    DB_HOST: process.env.DB_HOST || 'localhost',
    DB_USER: process.env.DB_USER || 'root',
    DB_PASS: process.env.DB_PASS || '',
    DB_NAME: process.env.DB_NAME || 'whatsapp_bot',
    PORT: process.env.PORT || 3000,
    USAGE_DAYS: 30,
    CODE_EXPIRY_HOURS: 24,
    QR_TIMEOUT: 120000
};

// État global simplifié
const state = {
    ready: false,
    qr: null,
    client: null,
    db: null,
    server: null
};

// Pool de connexions MySQL
async function initDB() {
    try {
        state.db = mysql.createPool({
            host: CONFIG.DB_HOST,
            user: CONFIG.DB_USER,
            password: CONFIG.DB_PASS,
            database: CONFIG.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectTimeout: 40000,
            timeout: 60000
        });

        // Créer les tables
        await state.db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                phone VARCHAR(50) UNIQUE NOT NULL,
                active BOOLEAN DEFAULT FALSE,
                activated_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_phone_active (phone, active)
            )
        `);

        await state.db.execute(`
            CREATE TABLE IF NOT EXISTS codes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                phone VARCHAR(50) UNIQUE NOT NULL,
                code VARCHAR(10) NOT NULL,
                used BOOLEAN DEFAULT FALSE,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_phone_expires (phone, expires_at)
            )
        `);

        await state.db.execute(`
            CREATE TABLE IF NOT EXISTS groups_list (
                id INT AUTO_INCREMENT PRIMARY KEY,
                group_id VARCHAR(100) UNIQUE NOT NULL,
                name VARCHAR(255),
                added_by VARCHAR(50) NOT NULL,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_added_by (added_by)
            )
        `);

        // Nettoyage automatique des codes expirés
        await state.db.execute('DELETE FROM codes WHERE expires_at < NOW()');
        
        console.log('✅ MySQL connecté et tables créées');
        return true;
    } catch (error) {
        console.error('❌ Erreur MySQL:', error.message);
        return false;
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

// Fonctions base de données rapides
const db = {
    async createCode(phone) {
        const code = generateCode();
        const expiresAt = new Date(Date.now() + CONFIG.CODE_EXPIRY_HOURS * 3600000);
        
        await state.db.execute(
            'INSERT INTO codes (phone, code, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE code=?, expires_at=?, used=FALSE',
            [phone, code, expiresAt, code, expiresAt]
        );
        return code;
    },

    async validateCode(phone, inputCode) {
        const [rows] = await state.db.execute(
            'SELECT * FROM codes WHERE phone=? AND used=FALSE AND expires_at > NOW()',
            [phone]
        );
        
        if (!rows[0] || rows[0].code.replace('-', '') !== inputCode.replace(/[-\s]/g, '').toUpperCase()) {
            return false;
        }

        // Transaction atomique
        const connection = await state.db.getConnection();
        try {
            await connection.beginTransaction();
            
            await connection.execute('UPDATE codes SET used=TRUE WHERE phone=?', [phone]);
            await connection.execute(
                'INSERT INTO users (phone, active, activated_at) VALUES (?, TRUE, NOW()) ON DUPLICATE KEY UPDATE active=TRUE, activated_at=NOW()',
                [phone]
            );
            
            await connection.commit();
            return true;
        } catch (error) {
            await connection.rollback();
            return false;
        } finally {
            connection.release();
        }
    },

    async isAuthorized(phone) {
        const [rows] = await state.db.execute(
            'SELECT activated_at FROM users WHERE phone=? AND active=TRUE',
            [phone]
        );
        
        if (!rows[0]) return false;
        
        const daysSince = (Date.now() - new Date(rows[0].activated_at).getTime()) / (24 * 3600000);
        if (daysSince > CONFIG.USAGE_DAYS) {
            await state.db.execute('UPDATE users SET active=FALSE WHERE phone=?', [phone]);
            return false;
        }
        return true;
    },

    async addGroup(groupId, name, addedBy) {
        try {
            await state.db.execute(
                'INSERT INTO groups_list (group_id, name, added_by) VALUES (?, ?, ?)',
                [groupId, name, addedBy]
            );
            return true;
        } catch (error) {
            return false; // Déjà existe
        }
    },

    async getUserGroups(phone) {
        const [rows] = await state.db.execute(
            'SELECT group_id, name FROM groups_list WHERE added_by=?',
            [phone]
        );
        return rows;
    },

    async getStats() {
        const [results] = await state.db.execute(`
            SELECT 
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM users WHERE active=TRUE) as active_users,
                (SELECT COUNT(*) FROM codes) as total_codes,
                (SELECT COUNT(*) FROM codes WHERE used=TRUE) as used_codes,
                (SELECT COUNT(*) FROM groups_list) as total_groups
        `);
        return results[0];
    }
};

// Interface web minimaliste
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
    const html = state.ready ? 
        `<h1 style="color:green">✅ Bot En Ligne</h1><p>🕒 ${new Date().toLocaleString()}</p>` :
        state.qr ? 
        `<h1>📱 Scanner QR Code</h1><img src="data:image/png;base64,${state.qr}"><script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1>🔄 Initialisation...</h1><script>setTimeout(()=>location.reload(),10000)</script>`;
    
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp Bot</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial;text-align:center;background:#25D366;color:white;padding:50px}img{background:white;padding:20px;border-radius:10px}</style></head><body>${html}</body></html>`);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: state.ready ? 'online' : 'offline',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// Initialisation client WhatsApp
async function initClient() {
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    
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
                    `🎉 *BOT EN LIGNE*\n✅ MySQL connecté\n🕒 ${new Date().toLocaleString()}`);
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
                    await msg.reply(`📊 *STATS*\n👥 Total: ${stats.total_users}\n✅ Actifs: ${stats.active_users}\n🔑 Codes: ${stats.total_codes}/${stats.used_codes}\n📢 Groupes: ${stats.total_groups}`);
                    
                } else if (cmd === '/help') {
                    await msg.reply('🤖 *ADMIN*\n• /gencode [num] - Créer code\n• /stats - Statistiques\n• /help - Aide');
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
                const [user] = await state.db.execute('SELECT activated_at FROM users WHERE phone=?', [phone]);
                const remaining = Math.ceil(CONFIG.USAGE_DAYS - (Date.now() - new Date(user[0].activated_at).getTime()) / 86400000);
                const groups = await db.getUserGroups(phone);
                await msg.reply(`📊 *STATUT*\n🟢 Actif\n📅 ${remaining} jours restants\n📢 ${groups.length} groupes`);
                
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
                await msg.reply(`🤖 *COMMANDES*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Mon statut\n• /help - Aide\n\n📊 ${groups.length} groupe(s)`);
            }
            
        } catch (error) {
            console.error('❌ Erreur message:', error.message);
            try { await msg.reply('❌ Erreur temporaire'); } catch (e) {}
        }
    });

    await state.client.initialize();
}

// Nettoyage périodique
setInterval(async () => {
    try {
        await state.db.execute('DELETE FROM codes WHERE expires_at < NOW()');
        await state.db.execute('UPDATE users SET active=FALSE WHERE active=TRUE AND activated_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [CONFIG.USAGE_DAYS]);
    } catch (e) {}
}, 3600000); // 1h

// Keep-alive pour Render
setInterval(() => {
    console.log(`💗 Uptime: ${Math.floor(process.uptime())}s - ${state.ready ? 'ONLINE' : 'OFFLINE'}`);
}, 300000);

// Démarrage
async function start() {
    console.log('🚀 DÉMARRAGE BOT WHATSAPP');
    console.log('💾 Base: MySQL');
    console.log('🌐 Hébergeur: Render');
    
    if (!(await initDB())) {
        console.error('❌ Échec connexion MySQL');
        process.exit(1);
    }
    
    state.server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
        console.log(`🌐 Serveur port ${CONFIG.PORT}`);
    });
    
    await initClient();
}

// Arrêt propre
async function shutdown() {
    console.log('🛑 Arrêt en cours...');
    
    if (state.client) {
        try {
            await state.client.sendMessage(CONFIG.ADMIN_NUMBER, '🛑 Bot arrêté - redémarrage auto');
        } catch (e) {}
        await state.client.destroy();
    }
    
    if (state.server) state.server.close();
    if (state.db) await state.db.end();
    
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
