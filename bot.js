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

// ===================== SYSTÈME DE GESTION DE GROUPES =====================
// À ajouter après la ligne 'const state = {...}' dans votre code principal

// Extension de l'état global pour la gestion des groupes
Object.assign(state, {
    groupSettings: new Map(), // Configuration par groupe
    gameStats: new Map(),     // Statistiques de jeu par utilisateur
    activeGames: new Map(),   // Jeux en cours
    monthlyRanking: new Map() // Classement mensuel
});

// Extension des fichiers de configuration
Object.assign(CONFIG.FILES, {
    GROUP_SETTINGS: 'group_settings.json',
    GAME_STATS: 'game_stats.json',
    MONTHLY_RANKING: 'monthly_ranking.json'
});

// Configuration des jeux et récompenses
const GAME_CONFIG = {
    QUIZ_POINTS: 10,
    CALC_POINTS: 15,
    LOTO_POINTS: 5,
    USAGE_POINTS: 2,
    MONTHLY_PRIZES: {
        1: { amount: 1500, phone: '237651104356' }, // Numéro pour récupérer les gains
        2: { amount: 1000, phone: '237651104356' },
        3: { amount: 500, phone: '237651104356' }
    },
    GAME_TIMEOUT: 30000 // 30 secondes pour répondre
};

// ===================== GESTION DES DONNÉES =====================

// Extension du système de cache
async function loadGroupCache() {
    try {
        const [groupSettings, gameStats, monthlyRanking] = await Promise.all([
            loadFromDrive('GROUP_SETTINGS'),
            loadFromDrive('GAME_STATS'),
            loadFromDrive('MONTHLY_RANKING')
        ]);

        state.groupSettings = new Map(Object.entries(groupSettings));
        state.gameStats = new Map(Object.entries(gameStats));
        state.monthlyRanking = new Map(Object.entries(monthlyRanking));

        console.log(`🎮 Cache groupes chargé: ${state.groupSettings.size} groupes, ${state.gameStats.size} joueurs`);
    } catch (error) {
        console.error('❌ Erreur chargement cache groupes:', error.message);
    }
}

async function saveGroupCache(type = 'all') {
    try {
        const saves = [];
        if (type === 'all' || type === 'settings') {
            saves.push(saveToDrive('GROUP_SETTINGS', Object.fromEntries(state.groupSettings)));
        }
        if (type === 'all' || type === 'stats') {
            saves.push(saveToDrive('GAME_STATS', Object.fromEntries(state.gameStats)));
        }
        if (type === 'all' || type === 'ranking') {
            saves.push(saveToDrive('MONTHLY_RANKING', Object.fromEntries(state.monthlyRanking)));
        }
        await Promise.all(saves);
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde cache groupes:', error.message);
        return false;
    }
}

// ===================== UTILITAIRES DE GROUPE =====================

async function isGroupAdmin(msg, userId) {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return false;
        
        const participant = chat.participants.find(p => p.id._serialized === userId);
        return participant && participant.isAdmin;
    } catch (error) {
        console.error('❌ Erreur vérification admin:', error.message);
        return false;
    }
}

function getGroupSettings(groupId) {
    const defaultSettings = {
        linkProtection: true,
        gamesEnabled: true,
        autoDeleteLinks: true,
        allowedAdmins: [],
        customCommands: {}
    };
    return state.groupSettings.get(groupId) || defaultSettings;
}

function getUserStats(userId) {
    const defaultStats = {
        totalPoints: 0,
        gamesPlayed: 0,
        quizCorrect: 0,
        calcCorrect: 0,
        lotoWins: 0,
        monthlyPoints: 0,
        lastActivity: new Date().toISOString()
    };
    return state.gameStats.get(userId) || defaultStats;
}

async function addPoints(userId, points, gameType = 'usage') {
    try {
        const stats = getUserStats(userId);
        stats.totalPoints += points;
        stats.monthlyPoints += points;
        stats.gamesPlayed += gameType !== 'usage' ? 1 : 0;
        stats.lastActivity = new Date().toISOString();
        
        if (gameType === 'quiz') stats.quizCorrect++;
        else if (gameType === 'calc') stats.calcCorrect++;
        else if (gameType === 'loto') stats.lotoWins++;
        
        state.gameStats.set(userId, stats);
        await saveGroupCache('stats');
        return stats.totalPoints;
    } catch (error) {
        console.error('❌ Erreur ajout points:', error.message);
        return 0;
    }
}

// ===================== GÉNÉRATEURS DE JEUX =====================

const gameGenerators = {
    generateQuiz() {
        const topics = [
            { q: "Quelle est la capitale du Cameroun ?", a: ["yaoundé", "yaounde"], points: 10 },
            { q: "Combien font 7 × 8 ?", a: ["56"], points: 10 },
            { q: "En quelle année le Cameroun a-t-il eu son indépendance ?", a: ["1960"], points: 15 },
            { q: "Quel est le plus grand océan du monde ?", a: ["pacifique"], points: 10 },
            { q: "Combien de continents y a-t-il ?", a: ["7", "sept"], points: 10 },
            { q: "Quelle est la monnaie du Cameroun ?", a: ["fcfa", "franc cfa"], points: 10 }
        ];
        return topics[Math.floor(Math.random() * topics.length)];
    },

    generateCalculation() {
        const operations = ['+', '-', '×', '÷'];
        const op = operations[Math.floor(Math.random() * operations.length)];
        let a, b, result, question;
        
        switch (op) {
            case '+':
                a = Math.floor(Math.random() * 100) + 1;
                b = Math.floor(Math.random() * 100) + 1;
                result = a + b;
                question = `${a} + ${b}`;
                break;
            case '-':
                a = Math.floor(Math.random() * 100) + 50;
                b = Math.floor(Math.random() * 50) + 1;
                result = a - b;
                question = `${a} - ${b}`;
                break;
            case '×':
                a = Math.floor(Math.random() * 12) + 1;
                b = Math.floor(Math.random() * 12) + 1;
                result = a * b;
                question = `${a} × ${b}`;
                break;
            case '÷':
                result = Math.floor(Math.random() * 12) + 1;
                b = Math.floor(Math.random() * 10) + 2;
                a = result * b;
                question = `${a} ÷ ${b}`;
                break;
        }
        
        return {
            q: `Combien font ${question} ?`,
            a: [result.toString()],
            points: GAME_CONFIG.CALC_POINTS
        };
    },

    generateLoto() {
        const winningNumber = Math.floor(Math.random() * 100) + 1;
        return {
            q: `🎰 LOTO ÉCLAIR 🎰\nChoisissez un nombre entre 1 et 100!\n\n💰 Nombre gagnant proche = ${GAME_CONFIG.LOTO_POINTS} points\n🎯 Nombre exact = ${GAME_CONFIG.LOTO_POINTS * 3} points`,
            winningNumber,
            type: 'loto'
        };
    }
};

// ===================== SYSTÈME DE JEU =====================

async function startGame(msg, gameType) {
    try {
        const chat = await msg.getChat();
        const groupId = chat.id._serialized;
        
        if (state.activeGames.has(groupId)) {
            return msg.reply('🎮 Un jeu est déjà en cours dans ce groupe!');
        }

        let game;
        switch (gameType) {
            case 'quiz':
                game = gameGenerators.generateQuiz();
                break;
            case 'calc':
                game = gameGenerators.generateCalculation();
                break;
            case 'loto':
                game = gameGenerators.generateLoto();
                break;
            default:
                return msg.reply('❌ Type de jeu invalide!');
        }

        game.type = gameType;
        game.startTime = Date.now();
        game.participants = new Map();
        
        state.activeGames.set(groupId, game);

        await msg.reply(`🎮 **${gameType.toUpperCase()}** 🎮\n\n${game.q}\n\n⏰ Vous avez 30 secondes!\n💰 Récompense: ${game.points || GAME_CONFIG.LOTO_POINTS} points`);

        // Timer pour fermer le jeu
        setTimeout(async () => {
            await endGame(groupId, chat);
        }, GAME_CONFIG.GAME_TIMEOUT);

    } catch (error) {
        console.error('❌ Erreur démarrage jeu:', error.message);
        await msg.reply('❌ Erreur lors du démarrage du jeu');
    }
}

async function endGame(groupId, chat) {
    try {
        const game = state.activeGames.get(groupId);
        if (!game) return;

        state.activeGames.delete(groupId);

        if (game.participants.size === 0) {
            await state.client.sendMessage(groupId, '⏰ Temps écoulé! Aucune participation.');
            return;
        }

        let resultMsg = `🏁 **JEU TERMINÉ** 🏁\n\n`;
        
        if (game.type === 'loto') {
            resultMsg += `🎯 Nombre gagnant: ${game.winningNumber}\n\n`;
            const winners = [];
            
            for (const [userId, guess] of game.participants) {
                const difference = Math.abs(parseInt(guess) - game.winningNumber);
                let points = 0;
                
                if (difference === 0) {
                    points = GAME_CONFIG.LOTO_POINTS * 3;
                    winners.push({ userId, guess, points, exact: true });
                } else if (difference <= 5) {
                    points = GAME_CONFIG.LOTO_POINTS;
                    winners.push({ userId, guess, points, exact: false });
                }
                
                if (points > 0) {
                    await addPoints(userId, points, 'loto');
                }
            }
            
            if (winners.length > 0) {
                resultMsg += '🏆 **GAGNANTS:**\n';
                for (const winner of winners) {
                    const contact = await state.client.getContactById(winner.userId);
                    const name = contact.pushname || contact.number;
                    resultMsg += `${winner.exact ? '🎯' : '🎲'} ${name}: ${winner.guess} (+${winner.points} pts)\n`;
                }
            } else {
                resultMsg += '😢 Aucun gagnant cette fois!';
            }
        } else {
            resultMsg += `✅ Bonne réponse: ${game.a[0]}\n\n`;
            
            if (game.winner) {
                const contact = await state.client.getContactById(game.winner);
                const name = contact.pushname || contact.number;
                resultMsg += `🏆 Gagnant: ${name} (+${game.points} points)`;
            } else {
                resultMsg += '😢 Aucune bonne réponse!';
            }
        }

        await state.client.sendMessage(groupId, resultMsg);
    } catch (error) {
        console.error('❌ Erreur fin de jeu:', error.message);
    }
}

// ===================== CLASSEMENT ET RÉCOMPENSES =====================

async function getMonthlyRanking(limit = 10) {
    try {
        const rankings = [];
        for (const [userId, stats] of state.gameStats) {
            if (stats.monthlyPoints > 0) {
                rankings.push({
                    userId,
                    monthlyPoints: stats.monthlyPoints,
                    totalPoints: stats.totalPoints,
                    gamesPlayed: stats.gamesPlayed
                });
            }
        }
        
        rankings.sort((a, b) => b.monthlyPoints - a.monthlyPoints);
        return rankings.slice(0, limit);
    } catch (error) {
        console.error('❌ Erreur classement:', error.message);
        return [];
    }
}

async function processMonthlyRewards() {
    try {
        const ranking = await getMonthlyRanking(3);
        const rewards = [];
        
        for (let i = 0; i < Math.min(ranking.length, 3); i++) {
            const player = ranking[i];
            const prize = GAME_CONFIG.MONTHLY_PRIZES[i + 1];
            
            if (prize && player.monthlyPoints >= 50) { // Minimum 50 points pour gagner
                const contact = await state.client.getContactById(player.userId);
                const name = contact.pushname || contact.number;
                
                rewards.push({
                    position: i + 1,
                    userId: player.userId,
                    name,
                    points: player.monthlyPoints,
                    prize: prize.amount,
                    contactNumber: prize.phone
                });
                
                // Message privé au gagnant
                const congratsMsg = `🎉 **FÉLICITATIONS!** 🎉\n\nVous êtes ${i === 0 ? '1er' : i === 1 ? '2ème' : '3ème'} du classement mensuel!\n\n💰 Gain: ${prize.amount}F\n📞 Contactez: ${prize.phone}\n🏆 Points ce mois: ${player.monthlyPoints}`;
                
                await state.client.sendMessage(player.userId, congratsMsg);
            }
        }
        
        // Reset des points mensuels
        for (const [userId, stats] of state.gameStats) {
            stats.monthlyPoints = 0;
            state.gameStats.set(userId, stats);
        }
        
        await saveGroupCache('stats');
        return rewards;
    } catch (error) {
        console.error('❌ Erreur traitement récompenses:', error.message);
        return [];
    }
}

// ===================== COMMANDES DE GROUPE =====================

const groupCommands = {
    async gameQuiz(msg) {
        await startGame(msg, 'quiz');
    },

    async gameCalc(msg) {
        await startGame(msg, 'calc');
    },

    async gameLoto(msg) {
        await startGame(msg, 'loto');
    },

    async ranking(msg) {
        try {
            const ranking = await getMonthlyRanking(10);
            if (ranking.length === 0) {
                return msg.reply('📊 Aucun joueur ce mois-ci!');
            }

            let response = `🏆 **CLASSEMENT MENSUEL** 🏆\n\n`;
            
            for (let i = 0; i < ranking.length; i++) {
                const player = ranking[i];
                try {
                    const contact = await state.client.getContactById(player.userId);
                    const name = contact.pushname || contact.number;
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                    response += `${medal} ${name}\n💰 ${player.monthlyPoints} pts | 🎮 ${player.gamesPlayed} jeux\n\n`;
                } catch (e) {
                    console.error('Erreur contact classement:', e.message);
                }
            }
            
            response += `💰 Récompenses fin de mois:\n🥇 1500F | 🥈 1000F | 🥉 500F`;
            await msg.reply(response);
        } catch (error) {
            console.error('❌ Erreur affichage classement:', error.message);
            await msg.reply('❌ Erreur lors de l\'affichage du classement');
        }
    },

    async myStats(msg) {
        try {
            const contact = await msg.getContact();
            const stats = getUserStats(contact.id._serialized);
            
            const response = `📊 **VOS STATISTIQUES** 📊\n\n💰 Points total: ${stats.totalPoints}\n🗓️ Points ce mois: ${stats.monthlyPoints}\n🎮 Jeux joués: ${stats.gamesPlayed}\n\n🧠 Quiz réussis: ${stats.quizCorrect}\n🔢 Calculs réussis: ${stats.calcCorrect}\n🎰 Loto gagnés: ${stats.lotoWins}`;
            
            await msg.reply(response);
        } catch (error) {
            console.error('❌ Erreur stats utilisateur:', error.message);
            await msg.reply('❌ Erreur lors de l\'affichage des statistiques');
        }
    },

    async groupConfig(msg, args, isAdmin) {
        if (!isAdmin) return msg.reply('❌ Seuls les administrateurs peuvent configurer le groupe');
        
        const chat = await msg.getChat();
        const groupId = chat.id._serialized;
        const settings = getGroupSettings(groupId);
        
        if (!args.length) {
            const status = `⚙️ **CONFIGURATION GROUPE** ⚙️\n\n🔗 Protection liens: ${settings.linkProtection ? '✅' : '❌'}\n🎮 Jeux activés: ${settings.gamesEnabled ? '✅' : '❌'}\n🗑️ Suppression auto: ${settings.autoDeleteLinks ? '✅' : '❌'}`;
            return msg.reply(status);
        }
        
        const [setting, value] = args;
        switch (setting.toLowerCase()) {
            case 'liens':
                settings.linkProtection = value === 'on';
                break;
            case 'jeux':
                settings.gamesEnabled = value === 'on';
                break;
            case 'autodel':
                settings.autoDeleteLinks = value === 'on';
                break;
            default:
                return msg.reply('❌ Options: liens, jeux, autodel\nUsage: /config liens on/off');
        }
        
        state.groupSettings.set(groupId, settings);
        await saveGroupCache('settings');
        await msg.reply(`✅ ${setting} ${value === 'on' ? 'activé' : 'désactivé'}`);
    }
};

// ===================== SYSTÈME DE PROTECTION DES LIENS =====================

async function handleLinkProtection(msg) {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return false;
        
        const groupId = chat.id._serialized;
        const settings = getGroupSettings(groupId);
        
        if (!settings.linkProtection) return false;
        
        const hasLink = /https?:\/\/|www\.|\.com|\.net|\.org|t\.me|wa\.me/i.test(msg.body);
        if (!hasLink) return false;
        
        const contact = await msg.getContact();
        const isAdmin = await isGroupAdmin(msg, contact.id._serialized);
        const isBotAdmin = contact.id._serialized === CONFIG.ADMIN_NUMBER;
        
        if (isAdmin || isBotAdmin) return false;
        
        if (settings.autoDeleteLinks) {
            await msg.delete(true);
            const warning = `🚫 @${contact.id.user}, les liens sont interdits dans ce groupe!`;
            const sentMsg = await msg.reply(warning, null, { mentions: [contact] });
            
            setTimeout(async () => {
                try {
                    await sentMsg.delete(true);
                } catch (e) {
                    console.error('Erreur suppression message warning:', e.message);
                }
            }, 10000);
        }
        
        return true;
    } catch (error) {
        console.error('❌ Erreur protection liens:', error.message);
        return false;
    }
}

// ===================== GESTION DES RÉPONSES DE JEU =====================

async function handleGameResponse(msg) {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return false;
        
        const groupId = chat.id._serialized;
        const game = state.activeGames.get(groupId);
        
        if (!game || msg.body.startsWith('/')) return false;
        
        const contact = await msg.getContact();
        const userId = contact.id._serialized;
        const userInput = msg.body.trim().toLowerCase();
        
        if (game.type === 'loto') {
            const guess = parseInt(msg.body.trim());
            if (isNaN(guess) || guess < 1 || guess > 100) return false;
            
            game.participants.set(userId, guess);
            return true;
        } else {
            // Quiz ou Calcul
            const isCorrect = game.a.some(answer => 
                userInput === answer.toLowerCase() || 
                userInput.includes(answer.toLowerCase())
            );
            
            if (isCorrect && !game.winner) {
                game.winner = userId;
                await addPoints(userId, game.points, game.type);
                
                const name = contact.pushname || contact.number;
                await msg.reply(`🎉 Bravo ${name}! Bonne réponse! (+${game.points} points)`);
                
                setTimeout(async () => {
                    await endGame(groupId, chat);
                }, 2000);
                
                return true;
            }
        }
        
        return false;
    } catch (error) {
        console.error('❌ Erreur gestion réponse jeu:', error.message);
        return false;
    }
}

// ===================== TÂCHE MENSUELLE =====================

// Fonction à appeler le 1er de chaque mois
async function monthlyRewardTask() {
    try {
        console.log('🏆 Traitement des récompenses mensuelles...');
        const rewards = await processMonthlyRewards();
        
        if (rewards.length > 0) {
            // Notifier l'admin
            let adminMsg = `🏆 **RÉCOMPENSES MENSUELLES** 🏆\n\n`;
            rewards.forEach(reward => {
                adminMsg += `${reward.position === 1 ? '🥇' : reward.position === 2 ? '🥈' : '🥉'} ${reward.name}\n💰 ${reward.prize}F à distribuer\n📞 ${reward.contactNumber}\n\n`;
            });
            
            await state.client.sendMessage(CONFIG.ADMIN_NUMBER, adminMsg);
        }
        
        console.log(`🎉 ${rewards.length} récompenses distribuées`);
    } catch (error) {
        console.error('❌ Erreur tâche mensuelle:', error.message);
    }
}

// Planifier la tâche mensuelle (1er de chaque mois à minuit)
function scheduleMonthlyTask() {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
    const timeUntilNextMonth = nextMonth.getTime() - now.getTime();
    
    setTimeout(() => {
        monthlyRewardTask();
        setInterval(monthlyRewardTask, 30 * 24 * 60 * 60 * 1000); // Répéter chaque mois
    }, timeUntilNextMonth);
}

// ===================== EXPORTS =====================
module.exports = {
    groupCommands,
    loadGroupCache,
    saveGroupCache,
    handleLinkProtection,
    handleGameResponse,
    addPoints,
    isGroupAdmin,
    scheduleMonthlyTask,
    monthlyRewardTask
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
    await loadGroupCache(); // Ajouter cette ligne
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
- /status - Voir votre statut
- /messtats - Vos statistiques de jeu
- /help - Afficher cette aide

*📢 DIFFUSION*
- /broadcast [message] - Diffuser dans vos groupes
- /addgroup - Ajouter ce groupe à votre liste

*🎮 JEUX (dans les groupes)*
- /quiz - Quiz culture générale
- /calcul - Calcul mathématique
- /loto - Loto éclair (1-100)
- /classement - Top joueurs du mois

*⚙️ GROUPE (admins uniquement)*
- /config - Voir/modifier config groupe
- /config liens on/off - Protection liens
- /config jeux on/off - Activer/désactiver jeux
- /config autodel on/off - Suppression auto liens

*🏆 RÉCOMPENSES MENSUELLES*
🥇 1er: 1500F | 🥈 2ème: 1000F | 🥉 3ème: 500F

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
    // Protection contre les liens (avant tout traitement)
    if (await handleLinkProtection(msg)) return;

    // Gestion des réponses de jeu (avant tout traitement)
    if (await handleGameResponse(msg)) return;
    
    if (!state.ready || !msg.body || msg.fromMe) return;
    
    try {
        const contact = await msg.getContact();
        if (!contact || contact.isMe) return;

        const phone = contact.id._serialized;
        const text = msg.body.trim();
        const args = text.split(' ').slice(1);
        const cmd = text.split(' ')[0].toLowerCase();
        
        // Vérifier si c'est un groupe
        const chat = await msg.getChat();
        const isGroup = chat.isGroup;

        // Commandes Admin (toujours autorisées partout)
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
                // Commandes de jeu pour l'admin
                case '/quiz':
                    if (isGroup) {
                        await groupCommands.gameQuiz(msg);
                        await addPoints(phone, GAME_CONFIG.USAGE_POINTS);
                    } else {
                        await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                    }
                    break;
                case '/calcul':
                    if (isGroup) {
                        await groupCommands.gameCalc(msg);
                        await addPoints(phone, GAME_CONFIG.USAGE_POINTS);
                    } else {
                        await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                    }
                    break;
                case '/loto':
                    if (isGroup) {
                        await groupCommands.gameLoto(msg);
                        await addPoints(phone, GAME_CONFIG.USAGE_POINTS);
                    } else {
                        await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                    }
                    break;
                case '/classement':
                    if (isGroup) {
                        await groupCommands.ranking(msg);
                    } else {
                        await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                    }
                    break;
                case '/messtats':
                    if (isGroup) {
                        await groupCommands.myStats(msg);
                    } else {
                        await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                    }
                    break;
                case '/config':
                    if (isGroup) {
                        const isAdmin = await isGroupAdmin(msg, phone) || phone === CONFIG.ADMIN_NUMBER;
                        await groupCommands.groupConfig(msg, args, isAdmin);
                    } else {
                        await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                    }
                    break;
                default:
                    await msg.reply('❌ Commande inconnue. Tapez /help pour voir les commandes disponibles.');
            }
            return;
        }

        // GESTION DES GROUPES - Pas de vérification d'activation
        if (isGroup) {
            // Dans les groupes, seules les commandes sont traitées, pas de demande d'activation
            if (!text.startsWith('/')) return;
            
            switch (cmd) {
                case '/help':
                    await msg.reply(`🎮 *COMMANDES GROUPE* 🎮\n\n🧠 /quiz - Quiz culture générale\n🔢 /calcul - Calcul mental\n🎰 /loto - Loto éclair\n📊 /classement - Top joueurs\n📈 /messtats - Mes statistiques\n⚙️ /config - Configuration (admins)`);
                    break;
                case '/quiz':
                    await groupCommands.gameQuiz(msg);
                    await addPoints(phone, GAME_CONFIG.USAGE_POINTS);
                    break;
                case '/calcul':
                    await groupCommands.gameCalc(msg);
                    await addPoints(phone, GAME_CONFIG.USAGE_POINTS);
                    break;
                case '/loto':
                    await groupCommands.gameLoto(msg);
                    await addPoints(phone, GAME_CONFIG.USAGE_POINTS);
                    break;
                case '/classement':
                    await groupCommands.ranking(msg);
                    break;
                case '/messtats':
                    await groupCommands.myStats(msg);
                    break;
                case '/config':
                    const isAdmin = await isGroupAdmin(msg, phone) || phone === CONFIG.ADMIN_NUMBER;
                    await groupCommands.groupConfig(msg, args, isAdmin);
                    break;
                default:
                    // Dans les groupes, ne pas répondre aux commandes inconnues pour éviter le spam
                    return;
            }
            return;
        }

        // GESTION DES MESSAGES PRIVÉS - Vérification d'activation requise
        const isAuthorized = await db.isAuthorized(phone);
        
        // Si l'utilisateur n'est pas autorisé en privé
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
            
            // Pour tout autre message en privé, demander l'activation
            await msg.reply(`🔒 *ACCÈS REQUIS*\n\nVous devez activer votre compte avec un code.\n\n📞 Contactez l'admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\n💡 Commande: /activate XXXX-XXXX`);
            return;
        }

        // Utilisateur autorisé en privé - traiter uniquement les commandes
        if (!text.startsWith('/')) return;

        // Commandes utilisateur autorisé en privé
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
            // Commandes de jeu aussi disponibles en privé pour les comptes activés
            case '/quiz':
                if (isGroup) {
                    await groupCommands.gameQuiz(msg);
                    await addPoints(phone, GAME_CONFIG.USAGE_POINTS);
                } else {
                    await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                }
                break;
            case '/calcul':
                if (isGroup) {
                    await groupCommands.gameCalc(msg);
                    await addPoints(phone, GAME_CONFIG.USAGE_POINTS);
                } else {
                    await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                }
                break;
            case '/loto':
                if (isGroup) {
                    await groupCommands.gameLoto(msg);
                    await addPoints(phone, GAME_CONFIG.USAGE_POINTS);
                } else {
                    await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                }
                break;
            case '/classement':
                if (isGroup) {
                    await groupCommands.ranking(msg);
                } else {
                    await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                }
                break;
            case '/messtats':
                if (isGroup) {
                    await groupCommands.myStats(msg);
                } else {
                    await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                }
                break;
            case '/config':
                if (isGroup) {
                    const isAdmin = await isGroupAdmin(msg, phone) || phone === CONFIG.ADMIN_NUMBER;
                    await groupCommands.groupConfig(msg, args, isAdmin);
                } else {
                    await msg.reply('❌ Cette commande fonctionne uniquement dans les groupes.');
                }
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
    // Planifier les récompenses mensuelles
scheduleMonthlyTask();
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
