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
    BACKUP_INTERVAL_MS: 60000,
    RANKING_RESET_DAYS: 30,
    PRIZES: { 1: 1500, 2: 1000, 3: 500 },
    FILES: { 
        USERS: 'users.json', 
        CODES: 'codes.json', 
        GROUPS: 'groups.json', 
        SESSION: 'session.json',
        RANKINGS: 'rankings.json',
        GROUP_SETTINGS: 'group_settings.json'
    }
};

// État global
const state = {
    ready: false, qr: null, client: null, server: null, drive: null,
    fileIds: {}, cache: { 
        users: new Map(), codes: new Map(), groups: new Map(),
        rankings: new Map(), groupSettings: new Map()
    },
    reconnects: 0, maxReconnects: 3,
    activeGames: new Map(),
    lastRankingReset: null
};

// Games data
const gameData = {
    quiz: [
        {q: "Capitale du Cameroun ?", a: ["yaoundé", "yaounde"], p: 10},
        {q: "2 + 2 = ?", a: ["4", "quatre"], p: 5},
        {q: "Combien de continents ?", a: ["7", "sept"], p: 8},
        {q: "Président du Cameroun ?", a: ["paul biya", "biya"], p: 10},
        {q: "Langue officielle du Cameroun ?", a: ["français", "francais", "anglais"], p: 8}
    ],
    math: [
        {q: "15 × 3 = ?", a: "45", p: 10},
        {q: "√64 = ?", a: "8", p: 15},
        {q: "25% de 200 = ?", a: "50", p: 12},
        {q: "2³ = ?", a: "8", p: 10}
    ]
};

// Store Google Drive pour RemoteAuth
class DriveStore {
    constructor() { this.sessionData = null; }
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
            await saveToDrive('SESSION', { sessionId, sessionData, timestamp: new Date().toISOString() });
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

// Google Drive Functions
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
        const [users, codes, groups, rankings, groupSettings] = await Promise.all([
            loadFromDrive('USERS'), loadFromDrive('CODES'), loadFromDrive('GROUPS'),
            loadFromDrive('RANKINGS'), loadFromDrive('GROUP_SETTINGS')
        ]);
        state.cache.users = new Map(Object.entries(users));
        state.cache.codes = new Map(Object.entries(codes));
        state.cache.groups = new Map(Object.entries(groups));
        state.cache.rankings = new Map(Object.entries(rankings));
        state.cache.groupSettings = new Map(Object.entries(groupSettings));
        state.lastRankingReset = rankings.lastReset || new Date().toISOString();
        console.log(`📊 Cache chargé: ${state.cache.users.size} users, ${state.cache.rankings.size} rankings`);
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
        if (type === 'all' || type === 'rankings') saves.push(saveToDrive('RANKINGS', { ...Object.fromEntries(state.cache.rankings), lastReset: state.lastRankingReset }));
        if (type === 'all' || type === 'groupSettings') saves.push(saveToDrive('GROUP_SETTINGS', Object.fromEntries(state.cache.groupSettings)));
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

function addPoints(phone, points, reason) {
    let userData = state.cache.rankings.get(phone) || { 
        phone, points: 0, games: 0, wins: 0, lastActivity: new Date().toISOString()
    };
    userData.points += points;
    userData.games++;
    userData.lastActivity = new Date().toISOString();
    if (reason === 'win') userData.wins++;
    state.cache.rankings.set(phone, userData);
    saveCache('rankings');
    return userData.points;
}

function getTopRankings(limit = 20) {
    const rankings = Array.from(state.cache.rankings.values())
        .sort((a, b) => b.points - a.points)
        .slice(0, limit);
    return rankings;
}

async function isGroupAdmin(groupId, userId) {
    try {
        const chat = await state.client.getChatById(groupId);
        if (chat.isGroup) {
            const participant = chat.participants.find(p => p.id._serialized === userId);
            return participant && participant.isAdmin;
        }
        return false;
    } catch (error) {
        console.error('Erreur vérification admin:', error.message);
        return false;
    }
}

async function isBotAdmin(groupId) {
    try {
        const chat = await state.client.getChatById(groupId);
        if (chat.isGroup) {
            const botParticipant = chat.participants.find(p => p.id._serialized === state.client.info.wid._serialized);
            return botParticipant && botParticipant.isAdmin;
        }
        return false;
    } catch (error) {
        return false;
    }
}

async function promoteToAdmin(groupId, userId) {
    try {
        const chat = await state.client.getChatById(groupId);
        await chat.promoteParticipants([userId]);
        return true;
    } catch (error) {
        console.error('Erreur promotion admin:', error.message);
        return false;
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

    async getGroupSettings(groupId) {
        return state.cache.groupSettings.get(groupId) || {
            groupId, 
            antiLink: false,
            welcomeMsg: true,
            autoDelete: false,
            gameMode: true
        };
    },

    async updateGroupSettings(groupId, settings) {
        const current = await this.getGroupSettings(groupId);
        const updated = { ...current, ...settings };
        state.cache.groupSettings.set(groupId, updated);
        await saveCache('groupSettings');
        return updated;
    }
};

// Commandes de jeu
const gameCommands = {
    async quiz(msg, phone, args) {
        const gameId = `${msg.from}_quiz`;
        if (state.activeGames.has(gameId)) {
            return msg.reply('🎯 Un quiz est déjà en cours dans ce chat!');
        }

        const question = gameData.quiz[Math.floor(Math.random() * gameData.quiz.length)];
        state.activeGames.set(gameId, {
            type: 'quiz', question, startTime: Date.now(), participants: new Set()
        });

        await msg.reply(`🧠 *QUIZ TIME!*\n\n❓ ${question.q}\n\n💰 ${question.p} points\n⏰ 30 secondes pour répondre!`);

        setTimeout(async () => {
            const game = state.activeGames.get(gameId);
            if (game && !game.winner) {
                state.activeGames.delete(gameId);
                await msg.reply(`⏰ *TEMPS ÉCOULÉ!*\n💡 Réponse: ${question.a[0]}`);
            }
        }, 30000);
    },

    async math(msg, phone, args) {
        const gameId = `${msg.from}_math`;
        if (state.activeGames.has(gameId)) {
            return msg.reply('🔢 Un calcul est déjà en cours!');
        }

        const question = gameData.math[Math.floor(Math.random() * gameData.math.length)];
        state.activeGames.set(gameId, {
            type: 'math', question, startTime: Date.now(), participants: new Set()
        });

        await msg.reply(`🔢 *CALCUL RAPIDE!*\n\n➕ ${question.q}\n\n💰 ${question.p} points\n⏰ 20 secondes!`);

        setTimeout(async () => {
            const game = state.activeGames.get(gameId);
            if (game && !game.winner) {
                state.activeGames.delete(gameId);
                await msg.reply(`⏰ *TEMPS ÉCOULÉ!*\n💡 Réponse: ${question.a}`);
            }
        }, 20000);
    },

    async loto(msg, phone, args) {
        if (!args.length) return msg.reply('🎰 Usage: /loto [nombre entre 1-50]');
        
        const userNumber = parseInt(args[0]);
        if (isNaN(userNumber) || userNumber < 1 || userNumber > 50) {
            return msg.reply('❌ Nombre invalide! Choisissez entre 1 et 50');
        }

        const winningNumber = Math.floor(Math.random() * 50) + 1;
        const contact = await msg.getContact();
        
        if (userNumber === winningNumber) {
            const points = addPoints(phone, 50, 'win');
            await msg.reply(`🎉 *JACKPOT!* 🎰\n\n👤 ${contact.pushname}\n🎯 Votre nombre: ${userNumber}\n🏆 Nombre gagnant: ${winningNumber}\n\n💰 +50 points!\n📊 Total: ${points} points`);
        } else {
            const points = addPoints(phone, 2, 'play');
            await msg.reply(`🎰 *LOTO*\n\n👤 ${contact.pushname}\n🎯 Votre nombre: ${userNumber}\n🏆 Nombre gagnant: ${winningNumber}\n\n💰 +2 points de participation\n📊 Total: ${points} points`);
        }
    },

    async pocket(msg, phone, args) {
        const prizes = [5, 10, 15, 20, 25, 30, 0, 0, 0, 0]; // 60% chance de gagner
        const prize = prizes[Math.floor(Math.random() * prizes.length)];
        const contact = await msg.getContact();
        
        if (prize > 0) {
            const points = addPoints(phone, prize, 'win');
            await msg.reply(`🎊 *POCKET WIN!*\n\n👤 ${contact.pushname}\n🎁 Vous gagnez: ${prize} points!\n📊 Total: ${points} points`);
        } else {
            const points = addPoints(phone, 1, 'play');
            await msg.reply(`🎪 *POCKET*\n\n👤 ${contact.pushname}\n😅 Pas de chance cette fois!\n💰 +1 point de participation\n📊 Total: ${points} points`);
        }
    },

    async ranking(msg) {
        const top = getTopRankings(10);
        if (!top.length) return msg.reply('📊 Aucun classement disponible');
        
        let response = '🏆 *TOP 10 JOUEURS*\n\n';
        top.forEach((user, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            const phone = user.phone.replace('@c.us', '');
            response += `${medal} +${phone.slice(-4)} - ${user.points}pts\n`;
        });
        
        response += `\n💰 Prix mensuel:\n🥇 1500F • 🥈 1000F • 🥉 500F`;
        await msg.reply(response);
    },

    async mystats(msg, phone) {
        const userData = state.cache.rankings.get(phone) || { points: 0, games: 0, wins: 0 };
        const rankings = getTopRankings();
        const position = rankings.findIndex(u => u.phone === phone) + 1;
        const contact = await msg.getContact();
        
        await msg.reply(`📊 *VOS STATISTIQUES*\n\n👤 ${contact.pushname}\n💰 Points: ${userData.points}\n🎮 Jeux joués: ${userData.games}\n🏆 Victoires: ${userData.wins}\n📈 Classement: ${position || 'Non classé'}/∞\n\n${position <= 3 ? '🎉 Vous êtes dans le top 3!' : ''}`);
    }
};

// Commandes Admin de groupe
const groupAdminCommands = {
    async antilink(msg, phone, args) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply('❌ Commande réservée aux groupes');
        
        const isAdmin = await isGroupAdmin(chat.id._serialized, phone) || phone === CONFIG.ADMIN_NUMBER;
        if (!isAdmin) return msg.reply('👮‍♂️ Réservé aux admins du groupe');
        
        const action = args[0]?.toLowerCase();
        if (!['on', 'off'].includes(action)) {
            return msg.reply('⚙️ Usage: /antilink [on/off]');
        }
        
        const settings = await db.updateGroupSettings(chat.id._serialized, { antiLink: action === 'on' });
        await msg.reply(`🔗 Anti-lien ${action === 'on' ? 'activé' : 'désactivé'} ✅`);
    },

    async welcome(msg, phone, args) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply('❌ Commande réservée aux groupes');
        
        const isAdmin = await isGroupAdmin(chat.id._serialized, phone) || phone === CONFIG.ADMIN_NUMBER;
        if (!isAdmin) return msg.reply('👮‍♂️ Réservé aux admins du groupe');
        
        const action = args[0]?.toLowerCase();
        if (!['on', 'off'].includes(action)) {
            return msg.reply('⚙️ Usage: /welcome [on/off]');
        }
        
        await db.updateGroupSettings(chat.id._serialized, { welcomeMsg: action === 'on' });
        await msg.reply(`👋 Message de bienvenue ${action === 'on' ? 'activé' : 'désactivé'} ✅`);
    },

    async gamemode(msg, phone, args) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply('❌ Commande réservée aux groupes');
        
        const isAdmin = await isGroupAdmin(chat.id._serialized, phone) || phone === CONFIG.ADMIN_NUMBER;
        if (!isAdmin) return msg.reply('👮‍♂️ Réservé aux admins du groupe');
        
        const action = args[0]?.toLowerCase();
        if (!['on', 'off'].includes(action)) {
            return msg.reply('⚙️ Usage: /gamemode [on/off]');
        }
        
        await db.updateGroupSettings(chat.id._serialized, { gameMode: action === 'on' });
        await msg.reply(`🎮 Mode jeu ${action === 'on' ? 'activé' : 'désactivé'} ✅`);
    }
};

// Commandes Admin principales
const adminCommands = {
    async help(msg) {
        const helpText = `🔐 *COMMANDES ADMIN PRINCIPAL*

*📝 CODES*
• /gencode [numéro] - Générer code
• /stats - Statistiques

*🎮 JEUX*
• /resetranking [confirm] - Reset classement
• /winners - Top 3 actuel

*👑 GROUPES*
• /makeadmin [groupe] - Devenir admin
• /groupsettings [groupe] - Voir paramètres

*📢 NOTIFICATIONS*
• /notify users [msg] - Tous users
• /notify groups [msg] - Tous groupes`;

        await msg.reply(helpText);
    },

    async makeadmin(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /makeadmin [nom du groupe]');
        
        const groupName = args.join(' ').toLowerCase();
        let targetGroup = null;
        
        for (const [id, data] of state.cache.groups) {
            if (data.name.toLowerCase().includes(groupName)) {
                targetGroup = { id, ...data };
                break;
            }
        }
        
        if (!targetGroup) return msg.reply('❌ Groupe non trouvé');
        
        try {
            const botIsAdmin = await isBotAdmin(targetGroup.id);
            if (!botIsAdmin) {
                return msg.reply('❌ Le bot n\'est pas admin dans ce groupe');
            }
            
            const promoted = await promoteToAdmin(targetGroup.id, CONFIG.ADMIN_NUMBER);
            if (promoted) {
                await msg.reply(`✅ Vous êtes maintenant admin du groupe "${targetGroup.name}"`);
            } else {
                await msg.reply('❌ Échec de la promotion');
            }
        } catch (error) {
            await msg.reply('❌ Erreur lors de la promotion');
        }
    },

    async resetranking(msg, args) {
        if (args[0] !== 'confirm') {
            return msg.reply('⚠️ Voulez-vous vraiment reset le classement?\n\nTapez: /resetranking confirm');
        }
        
        // Sauvegarder les gagnants actuels
        const winners = getTopRankings(3);
        if (winners.length >= 3) {
            for (let i = 0; i < 3; i++) {
                const prize = CONFIG.PRIZES[i + 1];
                const winner = winners[i];
                try {
                    await state.client.sendMessage(winner.phone, 
                        `🎉 *FÉLICITATIONS!*\n\nVous terminez ${i + 1}${i === 0 ? 'er' : 'ème'} du classement mensuel!\n💰 Prix: ${prize}F CFA\n\nContactez l'admin pour récupérer votre prix: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`
                    );
                } catch (e) {
                    console.error(`Erreur envoi prix à ${winner.phone}:`, e.message);
                }
            }
        }
        
        // Reset du classement
        state.cache.rankings.clear();
        state.lastRankingReset = new Date().toISOString();
        await saveCache('rankings');
        
        await msg.reply('✅ Classement remis à zéro! Les gagnants ont été notifiés.');
    },

    async winners(msg) {
        const top3 = getTopRankings(3);
        if (!top3.length) return msg.reply('📊 Aucun classement disponible');
        
        let response = '🏆 *TOP 3 ACTUEL*\n\n';
        top3.forEach((user, index) => {
            const medal = ['🥇', '🥈', '🥉'][index];
            const prize = CONFIG.PRIZES[index + 1];
            const phone = user.phone.replace('@c.us', '');
            response += `${medal} +${phone.slice(-4)} - ${user.points}pts (${prize}F)\n`;
        });
        
        const daysLeft = 30 - Math.floor((Date.now() - new Date(state.lastRankingReset)) / 86400000);
        response += `\n⏰ ${daysLeft} jours restants`;
        
        await msg.reply(response);
    }
};

// Interface web
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    const stats = state.cache ? {
        users: state.cache.users?.size || 0,
        groups: state.cache.groups?.size || 0,
        rankings: state.cache.rankings?.size || 0
    } : { users: 0, groups: 0, rankings: 0 };
    
    const html = state.ready ? 
        `<h1 style="color:green">✅ Bot En Ligne</h1><p>👥 ${stats.users} utilisateurs</p><p>📢 ${stats.groups} groupes</p><p>🏆 ${stats.rankings} joueurs</p>` :
        state.qr ? 
        `<h1>📱 Scanner le QR Code</h1><img src="data:image/png;base64,${state.qr}">` :
        `<h1>🔄 Chargement...</h1>`;
    
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp Gaming Bot</title><style>body{font-family:Arial;text-align:center;background:#25D366;color:white;padding:50px}img{background:white;padding:20px;border-radius:10px;max-width:400px}</style></head><body>${html}</body></html>`);
});

// Client WhatsApp
// Suite du code à partir de initClient()
async function initClient() {
    if (!state.drive || !state.fileIds.SESSION) {
        console.log('⏳ Attente Google Drive...');
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const driveStore = new DriveStore();
    
    state.client = new Client({
        authStrategy: new RemoteAuth({
            store: driveStore,
            backupSyncIntervalMs: CONFIG.BACKUP_INTERVAL_MS
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    // QR Code
    state.client.on('qr', async (qr) => {
        try {
            state.qr = await QRCode.toDataURL(qr);
            console.log('📱 QR Code généré - Visitez http://localhost:' + CONFIG.PORT);
        } catch (error) {
            console.error('❌ Erreur QR:', error.message);
        }
    });

    // Client prêt
    state.client.on('ready', async () => {
        console.log('✅ Client WhatsApp prêt!');
        state.ready = true;
        state.qr = null;
        state.reconnects = 0;
    });

    // Déconnexion
    state.client.on('disconnected', async (reason) => {
        console.log('⚠️ Déconnecté:', reason);
        state.ready = false;
        
        if (state.reconnects < state.maxReconnects) {
            state.reconnects++;
            console.log(`🔄 Tentative de reconnexion ${state.reconnects}/${state.maxReconnects}...`);
            setTimeout(() => initClient(), 5000);
        } else {
            console.log('❌ Nombre max de reconnexions atteint');
        }
    });

    // Nouveau membre dans un groupe
    state.client.on('group_join', async (notification) => {
        const settings = await db.getGroupSettings(notification.chatId);
        if (!settings.welcomeMsg) return;

        const chat = await notification.getChat();
        const contact = await state.client.getContactById(notification.id.participant);
        
        await chat.sendMessage(`🎉 Bienvenue @${contact.number} dans ${chat.name}!\n\n🎮 Tapez /help pour voir les jeux disponibles`);
    });

    // Messages
    state.client.on('message', async (msg) => {
        try {
            await handleMessage(msg);
        } catch (error) {
            console.error('❌ Erreur message:', error.message);
        }
    });

    // Authentification
    state.client.on('authenticated', () => {
        console.log('🔐 Authentifié avec succès');
    });

    state.client.on('auth_failure', (msg) => {
        console.error('❌ Échec authentification:', msg);
    });

    await state.client.initialize();
}

// Gestionnaire de messages principal
async function handleMessage(msg) {
    if (msg.fromMe) return;
    
    const phone = msg.from;
    const text = msg.body.trim();
    const isPrivate = !msg.from.includes('@g.us');
    const isAdmin = phone === CONFIG.ADMIN_NUMBER;
    
    // Anti-lien pour les groupes
    if (!isPrivate && !isAdmin) {
        const settings = await db.getGroupSettings(phone);
        if (settings.antiLink && (text.includes('http') || text.includes('www.'))) {
            const isGroupAdmin = await isGroupAdmin(phone, msg.author || phone);
            if (!isGroupAdmin) {
                await msg.delete(true);
                return msg.reply('🚫 Les liens sont interdits dans ce groupe!');
            }
        }
    }

    // Réponses aux jeux actifs
    await handleGameResponses(msg, phone, text);

    // Commandes avec préfixe /
    if (!text.startsWith('/')) return;
    
    const [command, ...args] = text.slice(1).toLowerCase().split(' ');
    
    // Commandes admin principal
    if (isAdmin) {
        const adminCmd = adminCommands[command];
        if (adminCmd) return await adminCmd(msg, args);
        
        // Commandes spéciales admin
        if (command === 'gencode') return await handleGenCode(msg, args);
        if (command === 'stats') return await handleStats(msg);
        if (command === 'notify') return await handleNotify(msg, args);
        if (command === 'groupsettings') return await handleGroupSettings(msg, args);
    }
    
    // Vérification autorisation pour utilisateurs normaux
    if (!isAdmin && !await db.isAuthorized(phone)) {
        if (command === 'activate') return await handleActivate(msg, args);
        return msg.reply('🔐 Accès non autorisé. Contactez l\'admin pour obtenir un code d\'activation.');
    }
    
    // Commandes de jeu
    if (!isPrivate) {
        const settings = await db.getGroupSettings(msg.from);
        if (!settings.gameMode && !isAdmin) {
            return msg.reply('🎮 Les jeux sont désactivés dans ce groupe');
        }
    }
    
    const gameCmd = gameCommands[command];
    if (gameCmd) return await gameCmd(msg, phone, args);
    
    // Commandes admin de groupe
    const groupAdminCmd = groupAdminCommands[command];
    if (groupAdminCmd) return await groupAdminCmd(msg, phone, args);
    
    // Commandes générales
    if (command === 'help') return await handleHelp(msg, isAdmin);
    if (command === 'menu') return await handleMenu(msg);
}

// Gestionnaire réponses jeux
async function handleGameResponses(msg, phone, text) {
    for (const [gameId, game] of state.activeGames) {
        if (!gameId.startsWith(msg.from)) continue;
        if (game.participants.has(phone)) continue;
        
        let isCorrect = false;
        
        if (game.type === 'quiz') {
            isCorrect = game.question.a.some(answer => 
                text.toLowerCase().includes(answer.toLowerCase())
            );
        } else if (game.type === 'math') {
            isCorrect = text.trim() === game.question.a;
        }
        
        if (isCorrect) {
            game.winner = phone;
            game.participants.add(phone);
            state.activeGames.delete(gameId);
            
            const contact = await msg.getContact();
            const points = addPoints(phone, game.question.p, 'win');
            
            await msg.reply(`🎉 *BRAVO ${contact.pushname}!*\n\n💡 Bonne réponse: ${game.question.a[0] || game.question.a}\n💰 +${game.question.p} points!\n⏱️ Temps: ${Math.round((Date.now() - game.startTime) / 1000)}s\n📊 Total: ${points} points`);
            break;
        }
    }
}

// Commandes admin spéciales
async function handleGenCode(msg, args) {
    if (!args.length) return msg.reply('❌ Usage: /gencode [numéro avec indicatif]');
    
    let targetPhone = args[0].replace(/[^\d]/g, '');
    if (!targetPhone.startsWith('237')) targetPhone = '237' + targetPhone;
    targetPhone += '@c.us';
    
    const code = await db.createCode(targetPhone);
    await msg.reply(`🔐 *CODE GÉNÉRÉ*\n\n📱 Numéro: ${targetPhone.replace('@c.us', '')}\n🎫 Code: \`${code}\`\n⏰ Expire dans ${CONFIG.CODE_EXPIRY_HOURS}h`);
}

async function handleStats(msg) {
    const stats = {
        users: state.cache.users.size,
        activeUsers: Array.from(state.cache.users.values()).filter(u => u.active).length,
        groups: state.cache.groups.size,
        codes: state.cache.codes.size,
        usedCodes: Array.from(state.cache.codes.values()).filter(c => c.used).length,
        rankings: state.cache.rankings.size
    };
    
    await msg.reply(`📊 *STATISTIQUES BOT*\n\n👥 Utilisateurs: ${stats.activeUsers}/${stats.users}\n📢 Groupes: ${stats.groups}\n🎫 Codes: ${stats.usedCodes}/${stats.codes}\n🏆 Joueurs actifs: ${stats.rankings}\n\n⚡ Status: ${state.ready ? 'En ligne' : 'Hors ligne'}`);
}

async function handleNotify(msg, args) {
    if (args.length < 2) return msg.reply('❌ Usage: /notify [users/groups] [message]');
    
    const target = args[0];
    const message = args.slice(1).join(' ');
    let sent = 0;
    
    if (target === 'users') {
        for (const [phone, userData] of state.cache.users) {
            if (!userData.active) continue;
            try {
                await state.client.sendMessage(phone, `📢 *NOTIFICATION ADMIN*\n\n${message}`);
                sent++;
                await new Promise(resolve => setTimeout(resolve, 1000)); // Délai anti-spam
            } catch (error) {
                console.error(`Erreur envoi à ${phone}:`, error.message);
            }
        }
    } else if (target === 'groups') {
        for (const [groupId] of state.cache.groups) {
            try {
                await state.client.sendMessage(groupId, `📢 *ANNONCE*\n\n${message}`);
                sent++;
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
                console.error(`Erreur envoi groupe ${groupId}:`, error.message);
            }
        }
    }
    
    await msg.reply(`✅ Message envoyé à ${sent} ${target}`);
}

async function handleGroupSettings(msg, args) {
    if (!args.length) return msg.reply('❌ Usage: /groupsettings [nom du groupe]');
    
    const groupName = args.join(' ').toLowerCase();
    let targetGroup = null;
    
    for (const [id, data] of state.cache.groups) {
        if (data.name.toLowerCase().includes(groupName)) {
            targetGroup = { id, ...data };
            break;
        }
    }
    
    if (!targetGroup) return msg.reply('❌ Groupe non trouvé');
    
    const settings = await db.getGroupSettings(targetGroup.id);
    await msg.reply(`⚙️ *PARAMÈTRES: ${targetGroup.name}*\n\n🔗 Anti-lien: ${settings.antiLink ? '✅' : '❌'}\n👋 Message bienvenue: ${settings.welcomeMsg ? '✅' : '❌'}\n🎮 Mode jeu: ${settings.gameMode ? '✅' : '❌'}\n🗑️ Auto-suppression: ${settings.autoDelete ? '✅' : '❌'}`);
}

// Activation utilisateur
async function handleActivate(msg, args) {
    if (!args.length) return msg.reply('🔐 Usage: /activate [CODE]');
    
    const code = args[0].toUpperCase();
    const phone = msg.from;
    
    const success = await db.validateCode(phone, code);
    if (success) {
        await msg.reply(`✅ *ACTIVATION RÉUSSIE!*\n\n🎉 Bienvenue! Votre accès est valide ${CONFIG.USAGE_DAYS} jours\n🎮 Tapez /help pour voir les commandes disponibles`);
    } else {
        await msg.reply('❌ Code invalide, expiré ou déjà utilisé');
    }
}

// Aide et menu
async function handleHelp(msg, isAdmin) {
    const gameHelp = `🎮 *COMMANDES DE JEU*

*🧠 QUIZ & CALCULS*
• /quiz - Question culture générale
• /math - Calcul rapide
• /loto [1-50] - Loterie (50pts)
• /pocket - Jeu de hasard

*📊 CLASSEMENT*
• /ranking - Top 10 joueurs
• /mystats - Vos statistiques

*⚙️ GROUPES (Admins)*
• /antilink [on/off] - Anti-lien
• /welcome [on/off] - Message bienvenue
• /gamemode [on/off] - Activer/désactiver jeux`;

    if (isAdmin) {
        await msg.reply(gameHelp + '\n\n🔐 Tapez /help admin pour les commandes administrateur');
    } else {
        await msg.reply(gameHelp);
    }
}

async function handleMenu(msg) {
    await msg.reply(`🎯 *MENU PRINCIPAL*\n\n🎮 /help - Liste des commandes\n🏆 /ranking - Classement\n📊 /mystats - Mes stats\n🎲 /quiz - Jouer au quiz\n🔢 /math - Calcul rapide\n🎰 /loto [nombre] - Loterie\n🎪 /pocket - Jeu surprise`);
}

// Démarrage du serveur
async function startServer() {
    return new Promise((resolve) => {
        state.server = app.listen(CONFIG.PORT, () => {
            console.log(`🌐 Serveur démarré sur le port ${CONFIG.PORT}`);
            resolve();
        });
    });
}

// Sauvegarde automatique
function startAutoSave() {
    setInterval(async () => {
        if (state.ready) {
            await saveCache();
            console.log('💾 Sauvegarde automatique effectuée');
        }
    }, CONFIG.BACKUP_INTERVAL_MS);
}

// Reset automatique du classement
function checkRankingReset() {
    setInterval(() => {
        if (!state.lastRankingReset) return;
        
        const daysSinceReset = Math.floor((Date.now() - new Date(state.lastRankingReset)) / 86400000);
        
        if (daysSinceReset >= CONFIG.RANKING_RESET_DAYS) {
            console.log('🔄 Reset automatique du classement mensuel');
            // Le reset sera fait manuellement par l'admin pour notifier les gagnants
        }
    }, 24 * 60 * 60 * 1000); // Vérification quotidienne
}

// Nettoyage des codes expirés
function cleanupExpiredCodes() {
    setInterval(async () => {
        let cleaned = 0;
        const now = new Date();
        
        for (const [phone, codeData] of state.cache.codes) {
            if (new Date(codeData.expiresAt) < now) {
                state.cache.codes.delete(phone);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            await saveCache('codes');
            console.log(`🧹 ${cleaned} codes expirés supprimés`);
        }
    }, 60 * 60 * 1000); // Toutes les heures
}

// Gestionnaire d'arrêt propre
process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt du bot...');
    
    if (state.client) {
        await state.client.destroy();
    }
    
    if (state.server) {
        state.server.close();
    }
    
    await saveCache();
    console.log('💾 Sauvegarde finale effectuée');
    process.exit(0);
});

// Gestion des erreurs non capturées
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Erreur non gérée:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Exception non capturée:', error);
});

// Fonction principale
async function main() {
    console.log('🚀 Démarrage du WhatsApp Gaming Bot...');
    
    // Initialisation Google Drive
    const driveReady = await initGoogleDrive();
    if (!driveReady) {
        console.error('❌ Impossible d\'initialiser Google Drive');
        process.exit(1);
    }
    
    // Démarrage du serveur web
    await startServer();
    
    // Initialisation du client WhatsApp
    await initClient();
    
    // Démarrage des tâches automatiques
    startAutoSave();
    checkRankingReset();
    cleanupExpiredCodes();
    
    console.log('✅ Bot entièrement initialisé!');
}

// Point d'entrée
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Erreur fatale:', error);
        process.exit(1);
    });
}

module.exports = {
    CONFIG,
    state,
    db,
    gameCommands,
    adminCommands,
    main
};
