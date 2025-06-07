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
    REWARD_PERIOD_DAYS: 30,
    REWARDS: { first: 1500, second: 1000, third: 500 },
    FILES: { USERS: 'users.json', CODES: 'codes.json', GROUPS: 'groups.json', SESSION: 'session.json', RANKINGS: 'rankings.json' }
};

const state = {
    ready: false, qr: null, client: null, server: null, drive: null,
    fileIds: {}, cache: { users: new Map(), codes: new Map(), groups: new Map(), rankings: new Map() },
    reconnects: 0, maxReconnects: 3, games: new Map()
};

class DriveStore {
    constructor() { this.sessionData = null; }
    async sessionExists(sessionId) {
        try {
            if (!state.fileIds.SESSION) return false;
            const data = await loadFromDrive('SESSION');
            return !!(data && data.sessionData);
        } catch (error) { return false; }
    }
    async save(sessionId, sessionData) {
        try {
            if (!state.fileIds.SESSION) return;
            await saveToDrive('SESSION', { sessionId, sessionData, timestamp: new Date().toISOString() });
        } catch (error) { console.error('❌ Erreur sauvegarde session:', error.message); }
    }
    async extract(sessionId) {
        try {
            if (!state.fileIds.SESSION) return null;
            const data = await loadFromDrive('SESSION');
            return data?.sessionData || null;
        } catch (error) { return null; }
    }
    async delete(sessionId) {
        try {
            if (!state.fileIds.SESSION) return;
            await saveToDrive('SESSION', {});
        } catch (error) { console.error('❌ Erreur suppression session:', error.message); }
    }
}

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
        const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.file'] });
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
            }
        } catch (error) { console.error(`❌ Erreur fichier ${fileName}:`, error.message); }
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
    } catch (error) { return {}; }
}

async function saveToDrive(fileKey, data) {
    try {
        const fileId = state.fileIds[fileKey];
        if (!fileId) throw new Error(`Fichier ${fileKey} non trouvé`);
        await state.drive.files.update({
            fileId: fileId,
            media: { mimeType: 'application/json', body: JSON.stringify(data, null, 2) }
        });
        return true;
    } catch (error) { return false; }
}

async function loadCache() {
    try {
        const [users, codes, groups, rankings] = await Promise.all([
            loadFromDrive('USERS'), loadFromDrive('CODES'), loadFromDrive('GROUPS'), loadFromDrive('RANKINGS')
        ]);
        state.cache.users = new Map(Object.entries(users));
        state.cache.codes = new Map(Object.entries(codes));
        state.cache.groups = new Map(Object.entries(groups));
        state.cache.rankings = new Map(Object.entries(rankings));
    } catch (error) { console.error('❌ Erreur chargement cache:', error.message); }
}

async function saveCache(type = 'all') {
    try {
        const saves = [];
        if (type === 'all' || type === 'users') saves.push(saveToDrive('USERS', Object.fromEntries(state.cache.users)));
        if (type === 'all' || type === 'codes') saves.push(saveToDrive('CODES', Object.fromEntries(state.cache.codes)));
        if (type === 'all' || type === 'groups') saves.push(saveToDrive('GROUPS', Object.fromEntries(state.cache.groups)));
        if (type === 'all' || type === 'rankings') saves.push(saveToDrive('RANKINGS', Object.fromEntries(state.cache.rankings)));
        await Promise.all(saves);
        return true;
    } catch (error) { return false; }
}

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        if (i === 4) code += '-';
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function addPoints(phone, points) {
    const userData = state.cache.rankings.get(phone) || { points: 0, games: 0, lastActive: new Date().toISOString() };
    userData.points += points;
    userData.games += 1;
    userData.lastActive = new Date().toISOString();
    state.cache.rankings.set(phone, userData);
    saveCache('rankings');
}

function getRandomQuiz() {
    const quizzes = [
        { q: "Quelle est la capitale du Cameroun?", r: "yaoundé", p: 10 },
        { q: "Combien font 15 + 27?", r: "42", p: 5 },
        { q: "Quel est le plus grand océan?", r: "pacifique", p: 15 },
        { q: "En quelle année le Cameroun a-t-il obtenu son indépendance?", r: "1960", p: 20 },
        { q: "Combien font 8 x 7?", r: "56", p: 5 },
        { q: "Quelle est la monnaie du Cameroun?", r: "franc cfa", p: 10 }
    ];
    return quizzes[Math.floor(Math.random() * quizzes.length)];
}

async function isGroupAdmin(groupId, userId) {
    try {
        const chat = await state.client.getChatById(groupId);
        const participant = chat.participants.find(p => p.id._serialized === userId);
        return participant && participant.isAdmin;
    } catch (error) { return false; }
}

async function isBotAdmin(groupId) {
    try {
        const chat = await state.client.getChatById(groupId);
        const botParticipant = chat.participants.find(p => p.id._serialized === state.client.info.wid._serialized);
        return botParticipant && botParticipant.isAdmin;
    } catch (error) { return false; }
}

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
        const userData = { phone, active: true, activatedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
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
    async addGroup(groupId, name, addedBy, settings = {}) {
        const defaultSettings = { linksBlocked: false, autoDelete: false, welcomeMessage: true };
        const groupData = {
            groupId, name, addedBy, addedAt: new Date().toISOString(),
            settings: { ...defaultSettings, ...settings }
        };
        state.cache.groups.set(groupId, groupData);
        await saveCache('groups');
        return true;
    },
    async updateGroupSettings(groupId, settings) {
        const groupData = state.cache.groups.get(groupId);
        if (!groupData) return false;
        groupData.settings = { ...groupData.settings, ...settings };
        state.cache.groups.set(groupId, groupData);
        await saveCache('groups');
        return true;
    },
    getTopRankings(limit = 20) {
        const rankings = Array.from(state.cache.rankings.entries())
            .map(([phone, data]) => ({ phone: phone.replace('@c.us', ''), ...data }))
            .sort((a, b) => b.points - a.points)
            .slice(0, limit);
        return rankings;
    }
};

const gameCommands = {
    async quiz(msg, phone) {
        const quiz = getRandomQuiz();
        const gameId = `quiz_${Date.now()}`;
        state.games.set(gameId, {
            type: 'quiz', question: quiz, participants: new Set([phone]),
            startTime: Date.now(), timeout: 30000
        });
        
        await msg.reply(`🧠 *QUIZ* (${quiz.p} points)\n\n❓ ${quiz.q}\n\n⏱️ 30 secondes pour répondre!`);
        
        setTimeout(async () => {
            const game = state.games.get(gameId);
            if (game && !game.answered) {
                state.games.delete(gameId);
                await msg.reply(`⏰ *TEMPS ÉCOULÉ!*\n\n✅ Réponse: ${quiz.r}`);
            }
        }, 30000);
    },

    async pierre(msg, phone, args) {
        if (!args.length) return msg.reply('❌ Usage: /pierre [pierre/papier/ciseaux]');
        const userChoice = args[0].toLowerCase();
        const validChoices = ['pierre', 'papier', 'ciseaux'];
        if (!validChoices.includes(userChoice)) return msg.reply('❌ Choix invalide! Utilisez: pierre, papier ou ciseaux');
        
        const botChoice = validChoices[Math.floor(Math.random() * 3)];
        let result = '', points = 0;
        
        if (userChoice === botChoice) {
            result = '🤝 Égalité!';
            points = 2;
        } else if (
            (userChoice === 'pierre' && botChoice === 'ciseaux') ||
            (userChoice === 'papier' && botChoice === 'pierre') ||
            (userChoice === 'ciseaux' && botChoice === 'papier')
        ) {
            result = '🎉 Vous gagnez!';
            points = 10;
        } else {
            result = '😔 Vous perdez!';
            points = 1;
        }
        
        addPoints(phone, points);
        await msg.reply(`🎲 *PIERRE-PAPIER-CISEAUX*\n\n👤 Vous: ${userChoice}\n🤖 Bot: ${botChoice}\n\n${result}\n💰 +${points} points`);
    },

    async loto(msg, phone, args) {
        if (!args.length) return msg.reply('❌ Usage: /loto [votre numéro 1-50]');
        const userNumber = parseInt(args[0]);
        if (isNaN(userNumber) || userNumber < 1 || userNumber > 50) return msg.reply('❌ Numéro invalide! Choisissez entre 1 et 50');
        
        const winningNumber = Math.floor(Math.random() * 50) + 1;
        let points = 0;
        
        if (userNumber === winningNumber) {
            points = 100;
            await msg.reply(`🎰 *LOTO - JACKPOT!*\n\n🎯 Votre numéro: ${userNumber}\n🎊 Numéro gagnant: ${winningNumber}\n\n🎉 BRAVO! +${points} points`);
        } else {
            points = Math.abs(userNumber - winningNumber) <= 5 ? 20 : 5;
            await msg.reply(`🎰 *LOTO*\n\n🎯 Votre numéro: ${userNumber}\n🎊 Numéro gagnant: ${winningNumber}\n\n${points === 20 ? '🔥 Proche!' : '💪 Continuez!'} +${points} points`);
        }
        
        addPoints(phone, points);
    },

    async calcul(msg, phone) {
        const operations = ['+', '-', '*'];
        const op = operations[Math.floor(Math.random() * operations.length)];
        let a, b, answer;
        
        if (op === '*') {
            a = Math.floor(Math.random() * 12) + 1;
            b = Math.floor(Math.random() * 12) + 1;
        } else {
            a = Math.floor(Math.random() * 50) + 1;
            b = Math.floor(Math.random() * 50) + 1;
        }
        
        switch (op) {
            case '+': answer = a + b; break;
            case '-': answer = a - b; break;
            case '*': answer = a * b; break;
        }
        
        const gameId = `calc_${Date.now()}`;
        state.games.set(gameId, {
            type: 'calcul', answer, participants: new Set([phone]),
            startTime: Date.now(), timeout: 20000
        });
        
        await msg.reply(`🔢 *CALCUL RAPIDE* (15 points)\n\n❓ ${a} ${op} ${b} = ?\n\n⏱️ 20 secondes!`);
        
        setTimeout(async () => {
            const game = state.games.get(gameId);
            if (game && !game.answered) {
                state.games.delete(gameId);
                await msg.reply(`⏰ *TEMPS ÉCOULÉ!*\n\n✅ Réponse: ${answer}`);
            }
        }, 20000);
    },

    async classement(msg) {
        const rankings = db.getTopRankings(10);
        if (!rankings.length) return msg.reply('📊 Aucun classement disponible');
        
        let response = '🏆 *TOP 10 CLASSEMENT*\n\n';
        rankings.forEach((user, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            response += `${medal} ${user.phone}\n💰 ${user.points} points • 🎮 ${user.games} jeux\n\n`;
        });
        
        response += `💎 *RÉCOMPENSES MENSUELLES*\n🥇 ${CONFIG.REWARDS.first}F • 🥈 ${CONFIG.REWARDS.second}F • 🥉 ${CONFIG.REWARDS.third}F`;
        await msg.reply(response);
    }
};

const adminCommands = {
    async help(msg) {
        const helpText = `🔐 *COMMANDES ADMIN*\n\n*📝 GÉNÉRATION*\n• /gencode [numéro]\n\n*📊 STATISTIQUES*\n• /stats - Stats générales\n• /users - Utilisateurs actifs\n• /groups - Groupes\n• /rankings - Top classement\n\n*🤖 GESTION GROUPES*\n• /makeadmin [groupe] - Devenir admin\n• /promote [numéro] [groupe] - Promouvoir membre\n\n*📢 NOTIFICATIONS*\n• /notify users [message]\n• /notify groups [message]\n\n*🔧 MAINTENANCE*\n• /backup - Sauvegarder\n• /cleanup - Nettoyer\n• /rewardcheck - Vérifier récompenses`;
        await msg.reply(helpText);
    },

    async makeadmin(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /makeadmin [nom du groupe]');
        const groupName = args.join(' ').toLowerCase();
        const groups = await db.getAllGroups();
        const targetGroup = groups.find(g => g.name.toLowerCase().includes(groupName));
        
        if (!targetGroup) return msg.reply(`❌ Groupe "${args.join(' ')}" non trouvé`);
        
        try {
            const chat = await state.client.getChatById(targetGroup.group_id);
            const adminParticipant = chat.participants.find(p => p.id._serialized === CONFIG.ADMIN_NUMBER);
            
            if (adminParticipant && adminParticipant.isAdmin) {
                await msg.reply(`✅ Vous êtes déjà admin du groupe "${targetGroup.name}"`);
            } else {
                await msg.reply(`⚠️ Je ne peux pas vous promouvoir dans "${targetGroup.name}". Demandez à un admin du groupe.`);
            }
        } catch (error) {
            await msg.reply('❌ Erreur lors de la vérification du groupe');
        }
    },

    async rewardcheck(msg) {
        const rankings = db.getTopRankings(3);
        if (rankings.length >= 3) {
            const message = `🏆 *VÉRIFICATION RÉCOMPENSES*\n\n🥇 ${rankings[0].phone} - ${CONFIG.REWARDS.first}F\n🥈 ${rankings[1].phone} - ${CONFIG.REWARDS.second}F\n🥉 ${rankings[2].phone} - ${CONFIG.REWARDS.third}F\n\n💰 Total à payer: ${CONFIG.REWARDS.first + CONFIG.REWARDS.second + CONFIG.REWARDS.third}F`;
            await msg.reply(message);
        } else {
            await msg.reply('📊 Pas assez de participants pour les récompenses');
        }
    }
};

const userCommands = {
    async help(msg) {
        const helpText = `🤖 *COMMANDES BOT*\n\n*🎮 JEUX*\n• /quiz - Quiz culture générale\n• /pierre [pierre/papier/ciseaux]\n• /loto [1-50] - Jeu de loto\n• /calcul - Calcul rapide\n• /classement - Voir le top 10\n\n*📋 INFOS*\n• /status - Votre statut\n• /points - Vos points\n\n*📢 DIFFUSION*\n• /broadcast [message]\n• /addgroup - Ajouter ce groupe\n\n*🛡️ ADMIN GROUPE*\n• /blocklinks - Bloquer les liens\n• /allowlinks - Autoriser les liens\n• /welcome on/off - Message de bienvenue`;
        await msg.reply(helpText);
    },

    async points(msg, phone) {
        const userData = state.cache.rankings.get(phone) || { points: 0, games: 0 };
        const rankings = db.getTopRankings(20);
        const userRank = rankings.findIndex(r => r.phone === phone.replace('@c.us', '')) + 1;
        
        await msg.reply(`💰 *VOS POINTS*\n\n🏆 Points: ${userData.points}\n🎮 Jeux joués: ${userData.games}\n📊 Classement: ${userRank > 0 ? `#${userRank}` : 'Non classé'}\n\n🎯 Jouez pour grimper au classement!`);
    },

    async blocklinks(msg, phone) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply('❌ Commande pour groupes uniquement!');
        
        const isAdmin = await isGroupAdmin(chat.id._serialized, phone);
        if (!isAdmin) return msg.reply('❌ Réservé aux admins du groupe!');
        
        await db.updateGroupSettings(chat.id._serialized, { linksBlocked: true });
        await msg.reply('🔒 *LIENS BLOQUÉS*\n\nLes liens envoyés par les membres seront supprimés.\nLes admins peuvent toujours envoyer des liens.');
    },

    async allowlinks(msg, phone) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply('❌ Commande pour groupes uniquement!');
        
        const isAdmin = await isGroupAdmin(chat.id._serialized, phone);
        if (!isAdmin) return msg.reply('❌ Réservé aux admins du groupe!');
        
        await db.updateGroupSettings(chat.id._serialized, { linksBlocked: false });
        await msg.reply('✅ *LIENS AUTORISÉS*\n\nTous les membres peuvent maintenant envoyer des liens.');
    }
};

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    const stats = db.getStats ? db.getStats() : { active_users: state.cache.users.size, total_groups: state.cache.groups.size };
    const html = state.ready ? 
        `<h1 style="color:green">✅ Bot Divertissement En Ligne</h1><p>👥 ${stats.active_users} utilisateurs actifs</p><p>📢 ${stats.total_groups} groupes</p><p>🎮 ${state.cache.rankings.size} joueurs</p>` :
        state.qr ? 
        `<h1>📱 Scanner le QR Code</h1><img src="data:image/png;base64,${state.qr}">` :
        `<h1>🔄 Chargement...</h1>`;
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp Bot</title><style>body{font-family:Arial;text-align:center;background:#25D366;color:white;padding:50px}</style></head><body>${html}</body></html>`);
});

async function initClient() {
    if (!state.drive || !state.fileIds.SESSION) {
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const driveStore = new DriveStore();
    state.client = new Client({
        authStrategy: new RemoteAuth({
            store: driveStore,
            backupSyncIntervalMs: CONFIG.BACKUP_INTERVAL_MS,
            clientId: 'whatsapp-bot-entertainment'
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });

    state.client.on('qr', async (qr) => {
        state.qr = (await QRCode.toDataURL(qr, { width: 400 })).split(',')[1];
    });

    state.client.on('ready', async () => {
        state.ready = true;
        console.log('🎉 BOT DIVERTISSEMENT OPÉRATIONNEL!');
    });

    state.client.on('group_join', async (notification) => {
        const chat = await notification.getChat();
        const groupData = state.cache.groups.get(chat.id._serialized);
        
        if (groupData && groupData.settings.welcomeMessage) {
            setTimeout(async () => {
                await state.client.sendMessage(chat.id._serialized, 
                    `🎉 *BIENVENUE!*\n\nSalut! Je suis votre bot de divertissement.\n\n🎮 Tapez /help pour voir mes jeux!\n🏆 Gagnez des points et participez au classement!\n\n💰 Récompenses mensuelles pour le top 3!`
                );
            }, 3000);
        }
    });

    state.client.on('message', async (msg) => {
        if (!state.ready || !msg.body || msg.fromMe) return;
        
        try {
            const contact = await msg.getContact();
            if (!contact || contact.isMe) return;
            
            const phone = contact.id._serialized;
            const text = msg.body.trim();
            const args = text.split(' ').slice(1);
            const cmd = text.split(' ')[0].toLowerCase();
            const chat = await msg.getChat();

            // Vérification des liens dans les groupes
            if (chat.isGroup && (text.includes('http') || text.includes('www.'))) {
                const groupData = state.cache.groups.get(chat.id._serialized);
                if (groupData && groupData.settings.linksBlocked) {
                    const isAdmin = await isGroupAdmin(chat.id._serialized, phone);
                    const isBotAdminHere = await isBotAdmin(chat.id._serialized);
                    
                    if (!isAdmin && isBotAdminHere) {
                        try {
                            await msg.delete(true);
                            await msg.reply('🔒 Lien supprimé! Seuls les admins peuvent partager des liens.');
                        } catch (error) {
                            console.error('Erreur suppression message:', error);
                        }
                        return;
                    }
                }
            }

            // Réponses aux jeux
            for (const [gameId, game] of state.games) {
                if (game.participants.has(phone) && !game.answered) {
                    if (game.type === 'quiz' && text.toLowerCase().includes(game.question.r.toLowerCase())) {
                        game.answered = true;
                        addPoints(phone, game.question.p);
                        await msg.reply(`🎉 *BRAVO!* Bonne réponse!\n💰 +${game.question.p} points`);
                        state.games.delete(gameId);
                        return;
                    } else if (game.type === 'calcul' && parseInt(text) === game.answer) {
                        game.answered = true;
                        addPoints(phone, 15);
                        await msg.reply(`🎉 *EXCELLENT!* Bonne réponse!\n💰 +15 points`);
                        state.games.delete(gameId);
                        return;
                    }
                }
            }

            // Commandes Admin
            if (phone === CONFIG.ADMIN_NUMBER) {
                if (!text.startsWith('/')) return;
                switch (cmd) {
                    case '/help': await adminCommands.help(msg); break;
                    case '/makeadmin': await adminCommands.makeadmin(msg, args); break;
                    case '/rewardcheck': await adminCommands.rewardcheck(msg); break;
                    default: await msg.reply('❌ Commande admin inconnue');
                        }
            }

            // Commandes Utilisateur
            if (!(await db.isAuthorized(phone))) {
                if (cmd === '/start') {
                    const code = await db.createCode(phone);
                    await msg.reply(`🎮 *BIENVENUE AU BOT DIVERTISSEMENT!*\n\n📝 Votre code d'activation:\n\`${code}\`\n\n⏰ Valide 24h\n💰 30 jours d'utilisation\n\n📱 Tapez: /activate ${code.replace('-', '')}`);
                } else if (cmd === '/activate' && args.length) {
                    if (await db.validateCode(phone, args[0])) {
                        await msg.reply('✅ *COMPTE ACTIVÉ!* 🎉\n\n🎮 Tapez /help pour voir les commandes\n🏆 Gagnez des points et montez au classement!\n\n💰 Récompenses mensuelles pour le top 3!');
                    } else {
                        await msg.reply('❌ Code invalide ou expiré');
                    }
                }
                return;
            }

            // Anti-spam protection
            if (!antiSpam.check(phone, text)) {
                if (antiSpam.warnings.get(phone) >= 3) {
                    await msg.reply('⚠️ Trop de spam détecté. Pause de 5 minutes.');
                    return;
                }
                await msg.reply('⚠️ Ralentissez vos messages!');
                return;
            }

            if (!text.startsWith('/')) return;

            // Commandes de jeux
            switch (cmd) {
                case '/help': await userCommands.help(msg); break;
                case '/quiz': await gameCommands.quiz(msg, phone); break;
                case '/pierre': await gameCommands.pierre(msg, phone, args); break;
                case '/loto': await gameCommands.loto(msg, phone, args); break;
                case '/calcul': await gameCommands.calcul(msg, phone); break;
                case '/classement': await gameCommands.classement(msg); break;
                case '/points': await userCommands.points(msg, phone); break;
                case '/status': 
                    const userData = state.cache.users.get(phone);
                    const daysLeft = userData ? Math.max(0, CONFIG.USAGE_DAYS - Math.floor((Date.now() - new Date(userData.activatedAt)) / 86400000)) : 0;
                    await msg.reply(`📊 *VOTRE STATUT*\n\n✅ Compte: Actif\n⏳ Jours restants: ${daysLeft}\n💰 Points: ${(state.cache.rankings.get(phone) || {points: 0}).points}`);
                    break;
                case '/broadcast':
                    if (!args.length) return msg.reply('❌ Usage: /broadcast [message]');
                    if (!(await db.isAuthorized(phone))) return msg.reply('❌ Accès refusé');
                    
                    const groups = Array.from(state.cache.groups.keys());
                    let sent = 0;
                    for (const groupId of groups) {
                        try {
                            await state.client.sendMessage(groupId, `📢 *MESSAGE DIFFUSÉ*\n\n${args.join(' ')}\n\n_Par: ${contact.pushname || phone.replace('@c.us', '')}_`);
                            sent++;
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        } catch (error) {}
                    }
                    await msg.reply(`✅ Message diffusé dans ${sent} groupes`);
                    break;
                case '/addgroup':
                    if (!chat.isGroup) return msg.reply('❌ Commande pour groupes uniquement!');
                    const isGroupAdmin = await isGroupAdmin(chat.id._serialized, phone);
                    if (!isGroupAdmin) return msg.reply('❌ Seuls les admins peuvent ajouter le groupe!');
                    
                    await db.addGroup(chat.id._serialized, chat.name, phone);
                    await msg.reply('✅ *GROUPE AJOUTÉ!*\n\n🎮 Le bot est maintenant actif ici\n📝 Tapez /help pour voir les commandes\n🛡️ Les admins peuvent gérer les paramètres');
                    break;
                case '/blocklinks': await userCommands.blocklinks(msg, phone); break;
                case '/allowlinks': await userCommands.allowlinks(msg, phone); break;
                case '/welcome':
                    if (!chat.isGroup) return msg.reply('❌ Commande pour groupes uniquement!');
                    const isAdmin = await isGroupAdmin(chat.id._serialized, phone);
                    if (!isAdmin) return msg.reply('❌ Réservé aux admins du groupe!');
                    
                    const setting = args[0]?.toLowerCase() === 'off' ? false : true;
                    await db.updateGroupSettings(chat.id._serialized, { welcomeMessage: setting });
                    await msg.reply(`${setting ? '✅ Messages de bienvenue activés' : '❌ Messages de bienvenue désactivés'}`);
                    break;
                default:
                    await msg.reply('❌ Commande inconnue. Tapez /help');
            }
        } catch (error) {
            console.error('Erreur message:', error);
            await msg.reply('⚠️ Erreur temporaire, réessayez');
        }
    });

    state.client.on('auth_failure', () => {
        console.log('❌ Échec authentification');
        if (state.reconnects < state.maxReconnects) {
            state.reconnects++;
            setTimeout(() => initClient(), 5000);
        }
    });

    state.client.on('disconnected', (reason) => {
        console.log('🔌 Déconnecté:', reason);
        state.ready = false;
        if (state.reconnects < state.maxReconnects) {
            state.reconnects++;
            setTimeout(() => initClient(), 10000);
        }
    });

    await state.client.initialize();
}

// Système anti-spam
const antiSpam = {
    users: new Map(),
    warnings: new Map(),
    
    check(phone, message) {
        const now = Date.now();
        const userData = this.users.get(phone) || { messages: [], lastWarning: 0 };
        
        // Nettoyer les anciens messages (1 minute)
        userData.messages = userData.messages.filter(time => now - time < 60000);
        
        // Vérifier spam de messages identiques
        const recentSimilar = userData.messages.filter(msg => 
            typeof msg === 'object' && msg.text === message && now - msg.time < 30000
        ).length;
        
        if (recentSimilar >= 3) {
            this.warnings.set(phone, (this.warnings.get(phone) || 0) + 1);
            return false;
        }
        
        // Vérifier fréquence (max 10 messages/minute)
        if (userData.messages.length >= 10) {
            this.warnings.set(phone, (this.warnings.get(phone) || 0) + 1);
            return false;
        }
        
        // Vérifier longueur excessive
        if (message.length > 1000) {
            this.warnings.set(phone, (this.warnings.get(phone) || 0) + 1);
            return false;
        }
        
        userData.messages.push({ text: message, time: now });
        this.users.set(phone, userData);
        
        // Reset warnings après 5 minutes
        if (now - userData.lastWarning > 300000) {
            this.warnings.delete(phone);
        }
        
        return true;
    }
};

// Système de récompenses automatique
setInterval(async () => {
    try {
        const rankings = db.getTopRankings(3);
        const now = new Date();
        
        for (let i = 0; i < rankings.length && i < 3; i++) {
            const user = rankings[i];
            const userData = state.cache.rankings.get(user.phone + '@c.us');
            
            if (userData && userData.lastActive) {
                const daysSinceActive = (now - new Date(userData.lastActive)) / 86400000;
                const daysSinceLastReward = userData.lastReward ? 
                    (now - new Date(userData.lastReward)) / 86400000 : CONFIG.REWARD_PERIOD_DAYS + 1;
                
                if (daysSinceActive <= 7 && daysSinceLastReward >= CONFIG.REWARD_PERIOD_DAYS) {
                    const rewards = [CONFIG.REWARDS.first, CONFIG.REWARDS.second, CONFIG.REWARDS.third];
                    const positions = ['🥇 PREMIER', '🥈 DEUXIÈME', '🥉 TROISIÈME'];
                    
                    await state.client.sendMessage(user.phone + '@c.us', 
                        `🎉 *FÉLICITATIONS!*\n\n${positions[i]} au classement!\n💰 Vous avez gagné ${rewards[i]}F!\n\n📞 L'administrateur va vous contacter pour le paiement.`
                    );
                    
                    await state.client.sendMessage(CONFIG.ADMIN_NUMBER, 
                        `💰 *RÉCOMPENSE À PAYER*\n\n${positions[i]}: ${user.phone}\n💵 Montant: ${rewards[i]}F\n📊 Points: ${user.points}`
                    );
                    
                    userData.lastReward = now.toISOString();
                    state.cache.rankings.set(user.phone + '@c.us', userData);
                    await saveCache('rankings');
                }
            }
        }
    } catch (error) {
        console.error('Erreur récompenses:', error);
    }
}, 24 * 60 * 60 * 1000); // Vérification quotidienne

// Sauvegarde automatique
setInterval(async () => {
    try {
        await saveCache();
        console.log('💾 Sauvegarde automatique effectuée');
    } catch (error) {
        console.error('❌ Erreur sauvegarde:', error);
    }
}, 10 * 60 * 1000); // Toutes les 10 minutes

// Initialisation
async function init() {
    console.log('🚀 Initialisation du bot...');
    
    if (await initGoogleDrive()) {
        console.log('💾 Drive initialisé');
        await initClient();
        
        state.server = app.listen(CONFIG.PORT, () => {
            console.log(`🌐 Serveur démarré sur le port ${CONFIG.PORT}`);
        });
    } else {
        console.error('❌ Échec initialisation Drive');
        process.exit(1);
    }
}

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
    console.error('❌ Erreur non gérée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesse rejetée:', reason);
});

// Nettoyage à l'arrêt
process.on('SIGTERM', async () => {
    console.log('🔴 Arrêt du bot...');
    if (state.client) await state.client.destroy();
    if (state.server) state.server.close();
    await saveCache();
    process.exit(0);
});

init();
