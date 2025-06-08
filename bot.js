const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');

// Configuration sécurisée
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    PORT: process.env.PORT || 3000,
    SPAM_LIMIT: 4,
    SPAM_BAN_TIME: 180000, // 3min
    MAX_RETRIES: 3,
    POINTS: {
        QUIZ: 12, GAME: 18, DAILY: 3,
        PRIZES: [1500, 1000, 500]
    }
};

// État global sécurisé
const state = {
    ready: false,
    qr: null,
    client: null,
    reconnecting: false,
    cache: {
        users: new Map(),
        groups: new Map(),
        spam: new Map(),
        banned: new Map(),
        leaderboard: new Map(),
        activeGames: new Map()
    }
};

// Jeux optimisés
const games = {
    quizzes: [
        { q: "Capitale du Cameroun?", a: ["yaoundé", "yaounde"], pts: 12, emoji: "🇨🇲" },
        { q: "2+2×3 = ?", a: ["8"], pts: 10, emoji: "🔢" },
        { q: "Plus grand océan?", a: ["pacifique"], pts: 15, emoji: "🌊" },
        { q: "Planète rouge?", a: ["mars"], pts: 10, emoji: "🔴" },
        { q: "Inventeur ampoule?", a: ["edison"], pts: 18, emoji: "💡" },
        { q: "Plus haut sommet?", a: ["everest"], pts: 15, emoji: "🏔️" },
        { q: "Roi des animaux?", a: ["lion"], pts: 10, emoji: "🦁" },
        { q: "Continent du Cameroun?", a: ["afrique"], pts: 12, emoji: "🌍" },
        { q: "Joueurs équipe foot?", a: ["11", "onze"], pts: 10, emoji: "⚽" },
        { q: "Rouge + Bleu = ?", a: ["violet"], pts: 12, emoji: "🎨" }
    ],
    
    riddles: [
        { q: "Blanc quand sale?", a: ["tableau", "ardoise"], pts: 18, emoji: "🖍️" },
        { q: "Plus on enlève, plus grand?", a: ["trou"], pts: 15, emoji: "🕳️" },
        { q: "Brille sans être étoile?", a: ["lune"], pts: 12, emoji: "🌙" }
    ],
    
    loto: () => Array.from({length: 5}, () => Math.floor(Math.random() * 30) + 1).sort((a,b) => a-b),
    
    calc: () => {
        const ops = ['+', '-', '×'];
        const a = Math.floor(Math.random() * 25) + 1;
        const b = Math.floor(Math.random() * 15) + 1;
        const op = ops[Math.floor(Math.random() * ops.length)];
        let result;
        switch(op) {
            case '+': result = a + b; break;
            case '-': result = a - b; break;
            case '×': result = a * b; break;
        }
        return { question: `${a} ${op} ${b}`, answer: result };
    }
};

// Fonction de design responsive
function createBox(title, content, width = 35) {
    const topBorder = '╔' + '═'.repeat(width) + '╗';
    const bottomBorder = '╚' + '═'.repeat(width) + '╝';
    const separator = '╠' + '═'.repeat(width) + '╣';
    
    const lines = [topBorder];
    
    // Titre centré
    if (title) {
        const titlePadding = Math.floor((width - title.length) / 2);
        const titleLine = '║' + ' '.repeat(titlePadding) + title + ' '.repeat(width - titlePadding - title.length) + '║';
        lines.push(titleLine, separator);
    }
    
    // Contenu avec retour à la ligne automatique
    content.split('\n').forEach(line => {
        if (line.length <= width - 2) {
            const padding = width - 2 - line.length;
            lines.push('║ ' + line + ' '.repeat(padding) + ' ║');
        } else {
            // Découper les lignes trop longues
            for (let i = 0; i < line.length; i += width - 2) {
                const chunk = line.substr(i, width - 2);
                const padding = width - 2 - chunk.length;
                lines.push('║ ' + chunk + ' '.repeat(padding) + ' ║');
            }
        }
    });
    
    lines.push(bottomBorder);
    return lines.join('\n');
}

// Anti-spam optimisé
function checkSpam(phone) {
    const now = Date.now();
    
    // Vérifier ban
    if (state.cache.banned.has(phone)) {
        const banTime = state.cache.banned.get(phone);
        if (now < banTime) return true;
        state.cache.banned.delete(phone);
    }
    
    // Initialiser historique
    if (!state.cache.spam.has(phone)) {
        state.cache.spam.set(phone, []);
    }
    
    const messages = state.cache.spam.get(phone);
    messages.push(now);
    
    // Nettoyer ancien historique
    const filtered = messages.filter(time => now - time < 60000);
    state.cache.spam.set(phone, filtered);
    
    // Vérifier limite
    if (filtered.length > CONFIG.SPAM_LIMIT) {
        state.cache.banned.set(phone, now + CONFIG.SPAM_BAN_TIME);
        return true;
    }
    return false;
}

// Gestion des points sécurisée
function addPoints(phone, points, reason = '') {
    if (!state.cache.leaderboard.has(phone)) {
        state.cache.leaderboard.set(phone, {
            points: 0, wins: 0, lastActive: Date.now(), 
            name: 'Joueur', joinDate: Date.now()
        });
    }
    const user = state.cache.leaderboard.get(phone);
    user.points += Math.max(0, points); // Empêcher points négatifs
    user.lastActive = Date.now();
    state.cache.leaderboard.set(phone, user);
    return user.points;
}

function getLeaderboard() {
    return Array.from(state.cache.leaderboard.entries())
        .map(([phone, data]) => ({ phone: phone.replace('@c.us', ''), ...data }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 15);
}

// Vérifications admin sécurisées
async function isGroupAdmin(groupId, phone) {
    try {
        const chat = await state.client.getChatById(groupId);
        if (!chat.isGroup) return false;
        const participant = chat.participants.find(p => p.id._serialized === phone);
        return participant && (participant.isAdmin || participant.isSuperAdmin);
    } catch (error) {
        console.error('Erreur vérification admin:', error);
        return false;
    }
}

async function isBotAdmin(groupId) {
    try {
        const chat = await state.client.getChatById(groupId);
        const me = state.client.info.wid._serialized;
        const participant = chat.participants.find(p => p.id._serialized === me);
        return participant && (participant.isAdmin || participant.isSuperAdmin);
    } catch (error) {
        return false;
    }
}

// Détection de liens
function hasLinks(text) {
    const linkRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[^\s]+\.[a-z]{2,})/i;
    return linkRegex.test(text);
}

// Commandes jeux optimisées
const gameCommands = {
    async quiz(msg, phone) {
        const quiz = games.quizzes[Math.floor(Math.random() * games.quizzes.length)];
        const content = `${quiz.emoji} QUESTION:\n${quiz.q}\n\n🎯 Récompense: +${quiz.pts} points\n⏰ Temps: 25 secondes`;
        
        await msg.reply(createBox('🧠 QUIZ CHALLENGE', content));
        
        const timeout = setTimeout(() => {
            state.cache.activeGames.delete(`quiz_${phone}`);
        }, 25000);
        
        state.cache.activeGames.set(`quiz_${phone}`, { ...quiz, timeout });
        addPoints(phone, CONFIG.POINTS.DAILY);
    },
    
    async loto(msg, phone) {
        const numbers = games.loto();
        const userGuess = Math.floor(Math.random() * 30) + 1;
        const win = numbers.includes(userGuess);
        const points = win ? 40 : 8;
        
        addPoints(phone, points);
        
        const content = `🎯 Vos numéros: ${numbers.join(' - ')}\n🎰 Numéro gagnant: ${userGuess}\n\n${win ? '🎉 GAGNÉ! BRAVO!' : '😅 Pas de chance...'}\n\n💰 Points: +${points}`;
        
        await msg.reply(createBox('🎲 SUPER LOTO', content));
    },
    
    async calc(msg, phone) {
        const problem = games.calc();
        const content = `🧮 CALCUL:\n${problem.question} = ?\n\n🎯 Récompense: +15 points\n⏰ Temps: 20 secondes`;
        
        await msg.reply(createBox('🔢 CALCUL RAPIDE', content));
        
        const timeout = setTimeout(() => {
            state.cache.activeGames.delete(`calc_${phone}`);
        }, 20000);
        
        state.cache.activeGames.set(`calc_${phone}`, { ...problem, timeout });
        addPoints(phone, CONFIG.POINTS.DAILY);
    },
    
    async riddle(msg, phone) {
        const riddle = games.riddles[Math.floor(Math.random() * games.riddles.length)];
        const content = `${riddle.emoji} ÉNIGME:\n${riddle.q}\n\n🎯 Récompense: +${riddle.pts} points\n⏰ Temps: 30 secondes`;
        
        await msg.reply(createBox('🤔 ÉNIGME MYSTÈRE', content));
        
        const timeout = setTimeout(() => {
            state.cache.activeGames.delete(`riddle_${phone}`);
        }, 30000);
        
        state.cache.activeGames.set(`riddle_${phone}`, { ...riddle, timeout });
        addPoints(phone, CONFIG.POINTS.DAILY);
    },
    
    async points(msg, phone) {
        const user = state.cache.leaderboard.get(phone);
        if (!user) return msg.reply('🎮 Jouez d\'abord pour avoir des points!');
        
        const leaderboard = getLeaderboard();
        const rank = leaderboard.findIndex(u => u.phone === phone.replace('@c.us', '')) + 1;
        const daysActive = Math.floor((Date.now() - user.joinDate) / (1000 * 60 * 60 * 24));
        
        const content = `👤 Joueur: ${user.name}\n🎯 Points: ${user.points.toLocaleString()}\n🏆 Rang: ${rank || 'Non classé'}/15\n🎮 Victoires: ${user.wins}\n📅 Jours actifs: ${daysActive}`;
        
        await msg.reply(createBox('💰 VOS STATISTIQUES', content));
    },
    
    async top(msg) {
        const top = getLeaderboard();
        if (!top.length) return msg.reply('📋 Classement vide');
        
        let content = '';
        top.slice(0, 10).forEach((user, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            const medal = i < 3 ? medals[i] : `${i + 1}`;
            content += `${medal} ${user.name} - ${user.points.toLocaleString()}\n`;
        });
        
        content += '\n🎁 PRIX MENSUELS:\n🥇 1,500 FCFA | 🥈 1,000 | 🥉 500';
        
        await msg.reply(createBox('🏆 TOP JOUEURS', content));
    }
};

// Commandes admin
const adminCommands = {
    async nolinks(msg) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply('❌ Commande groupe uniquement');
        
        const groupId = chat.id._serialized;
        if (!state.cache.groups.has(groupId)) {
            state.cache.groups.set(groupId, { noLinks: false, adminOnly: false });
        }
        
        const settings = state.cache.groups.get(groupId);
        settings.noLinks = !settings.noLinks;
        state.cache.groups.set(groupId, settings);
        
        const content = `${settings.noLinks ? '🚫 Liens INTERDITS' : '✅ Liens AUTORISÉS'}`;
        await msg.reply(createBox('🔗 PARAMÈTRE MODIFIÉ', content));
    },
    
    async adminonly(msg) {
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply('❌ Commande groupe uniquement');
        
        const groupId = chat.id._serialized;
        if (!state.cache.groups.has(groupId)) {
            state.cache.groups.set(groupId, { noLinks: false, adminOnly: false });
        }
        
        const settings = state.cache.groups.get(groupId);
        settings.adminOnly = !settings.adminOnly;
        state.cache.groups.set(groupId, settings);
        
        const content = `${settings.adminOnly ? '🔒 Mode ADMIN activé' : '🔓 Mode TOUS activé'}`;
        await msg.reply(createBox('👑 PARAMÈTRE ADMIN', content));
    },
    
    async stats(msg) {
        if (msg.from !== CONFIG.ADMIN_NUMBER) return;
        
        const users = state.cache.leaderboard.size;
        const groups = state.cache.groups.size;
        const banned = state.cache.banned.size;
        const uptime = Math.floor(process.uptime() / 60);
        const memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        
        const content = `👥 Joueurs: ${users}\n📢 Groupes: ${groups}\n🚫 Bannis: ${banned}\n⏰ Uptime: ${uptime}min\n💾 Mémoire: ${memory}MB`;
        
        await msg.reply(createBox('📊 STATISTIQUES BOT', content));
    }
};

// Interface web sécurisée
const app = express();
app.get('/', (req, res) => {
    const html = state.ready ? 
        `<div class="container">
            <h1>🎮 Gaming Bot - ONLINE ✅</h1>
            <div class="stats">
                <div class="card">
                    <h3>👥</h3>
                    <p>${state.cache.leaderboard.size}</p>
                    <span>Joueurs</span>
                </div>
                <div class="card">
                    <h3>📢</h3>
                    <p>${state.cache.groups.size}</p>
                    <span>Groupes</span>
                </div>
                <div class="card">
                    <h3>⏰</h3>
                    <p>${Math.floor(process.uptime() / 60)}</p>
                    <span>Minutes</span>
                </div>
            </div>
        </div>` :
        state.qr ? 
        `<div class="container">
            <h1>📱 Scanner QR Code</h1>
            <img src="data:image/png;base64,${state.qr}" class="qr">
            <p>Scannez avec WhatsApp</p>
        </div>` :
        `<div class="container">
            <h1>🔄 Démarrage...</h1>
            <div class="loader"></div>
        </div>`;
    
    const css = `<style>
        body { font-family: Arial; background: linear-gradient(135deg, #25D366, #075E54); color: white; margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .container { text-align: center; background: rgba(255,255,255,0.1); padding: 30px; border-radius: 15px; backdrop-filter: blur(10px); box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
        .stats { display: flex; gap: 15px; margin-top: 20px; flex-wrap: wrap; justify-content: center; }
        .card { background: rgba(255,255,255,0.2); padding: 15px; border-radius: 10px; min-width: 80px; }
        .card h3 { margin: 0; font-size: 1.5em; }
        .card p { margin: 5px 0; font-size: 1.2em; font-weight: bold; }
        .card span { font-size: 0.8em; opacity: 0.8; }
        .qr { max-width: 250px; border-radius: 10px; margin: 15px 0; }
        .loader { border: 3px solid rgba(255,255,255,0.3); border-radius: 50%; border-top: 3px solid white; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 15px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        @media (max-width: 480px) { .stats { flex-direction: column; } .card { margin: 5px 0; } }
    </style>`;
    
    res.send(`<html><head><title>Gaming Bot</title>${css}</head><body>${html}</body></html>`);
});

// Client WhatsApp avec gestion d'erreurs
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    }
});

client.on('qr', async (qr) => {
    try {
        state.qr = (await QRCode.toDataURL(qr, { width: 256 })).split(',')[1];
        console.log('📱 QR Code généré');
    } catch (error) {
        console.error('Erreur QR:', error);
    }
});

client.on('ready', async () => {
    state.ready = true;
    state.client = client;
    state.reconnecting = false;
    console.log('🎮 Gaming Bot Ready!');
    
    // Notification admin sécurisée
    try {
        await client.sendMessage(CONFIG.ADMIN_NUMBER, 
            createBox('🚀 BOT ONLINE', `✅ Démarré avec succès\n⏰ ${new Date().toLocaleString('fr-FR')}\n🔧 Version 2.1 Stable`)
        );
    } catch (error) {
        console.error('Erreur notification:', error);
    }
});

client.on('disconnected', async (reason) => {
    console.log('🔌 Déconnecté:', reason);
    state.ready = false;
    
    if (!state.reconnecting) {
        state.reconnecting = true;
        setTimeout(() => {
            console.log('🔄 Tentative de reconnexion...');
            client.initialize();
        }, 5000);
    }
});

client.on('group_join', async (notification) => {
    try {
        const chat = await notification.getChat();
        
        // Sécurité: vérifier si c'est un vrai groupe
        if (!chat || !chat.isGroup) return;
        
        // Délai de sécurité avant d'envoyer le message
        setTimeout(async () => {
            try {
                const welcomeContent = `🚀 Gaming Bot activé!\n\n🎯 JEUX:\n/quiz /loto /calc /riddle\n\n🏆 CLASSEMENT:\n/points /top\n\n👑 ADMIN:\n/nolinks /adminonly\n\n🎁 Prix mensuels pour le top 3!`;
                
                await client.sendMessage(chat.id._serialized, 
                    createBox(`🎮 BIENVENUE`, welcomeContent)
                );
            } catch (error) {
                console.error('Erreur message bienvenue:', error);
            }
        }, 3000);
        
    } catch (error) {
        console.error('Erreur group_join:', error);
    }
});

client.on('message', async (msg) => {
    if (!state.ready || !msg.body || msg.fromMe) return;
    
    try {
        const contact = await msg.getContact();
        const phone = contact.id._serialized;
        const text = msg.body.trim();
        const args = text.split(' ').slice(1);
        const cmd = text.split(' ')[0].toLowerCase();
        
        // Anti-spam
        if (checkSpam(phone)) {
            return msg.reply(createBox('🚫 ANTI-SPAM', 'Trop de messages!\nAttendez 3 minutes.'));
        }
        
        // Mettre à jour nom utilisateur
        if (contact.pushname && state.cache.leaderboard.has(phone)) {
            const user = state.cache.leaderboard.get(phone);
            user.name = contact.pushname;
            state.cache.leaderboard.set(phone, user);
        }
        
        // Vérifier liens dans groupes
        const chat = await msg.getChat();
        if (chat.isGroup) {
            const groupSettings = state.cache.groups.get(chat.id._serialized);
            if (groupSettings?.noLinks && hasLinks(text)) {
                const isAdmin = await isGroupAdmin(chat.id._serialized, phone);
                if (!isAdmin && await isBotAdmin(chat.id._serialized)) {
                    await msg.delete(true);
                    return msg.reply(createBox('🔗 LIEN DÉTECTÉ', 'Liens interdits!\nSeuls admins autorisés.'));
                }
            }
            
            // Mode admin only
            if (groupSettings?.adminOnly && text.startsWith('/')) {
                const isAdmin = await isGroupAdmin(chat.id._serialized, phone);
                if (!isAdmin && phone !== CONFIG.ADMIN_NUMBER) {
                    return msg.reply(createBox('👑 ACCÈS RESTREINT', 'Commandes réservées\naux admins!'));
                }
            }
        }
        
        // Gérer réponses aux jeux
        const activeGame = state.cache.activeGames.get(`quiz_${phone}`) || 
                          state.cache.activeGames.get(`calc_${phone}`) || 
                          state.cache.activeGames.get(`riddle_${phone}`);
                          
        if (activeGame) {
            const gameType = state.cache.activeGames.has(`quiz_${phone}`) ? 'quiz' :
                           state.cache.activeGames.has(`calc_${phone}`) ? 'calc' : 'riddle';
            
            clearTimeout(activeGame.timeout);
            state.cache.activeGames.delete(`${gameType}_${phone}`);
            
            let isCorrect = false;
            if (gameType === 'calc') {
                isCorrect = parseInt(text) === activeGame.answer;
            } else {
                isCorrect = activeGame.a.some(ans => text.toLowerCase().includes(ans));
            }
            
            if (isCorrect) {
                const points = addPoints(phone, activeGame.pts || 15);
                const user = state.cache.leaderboard.get(phone);
                user.wins++;
                return msg.reply(createBox('🎉 BRAVO!', `✅ Bonne réponse!\n💰 +${activeGame.pts || 15} points\n🎯 Total: ${points.toLocaleString()}`));
            } else {
                const answer = activeGame.answer || activeGame.a[0];
                return msg.reply(createBox('❌ INCORRECT', `✅ Réponse: ${answer}\n💡 Réessayez!`));
            }
        }
        
        if (!text.startsWith('/')) return;
        
        // Commandes jeux
        switch (cmd) {
            case '/quiz': return gameCommands.quiz(msg, phone);
            case '/loto': return gameCommands.loto(msg, phone);
            case '/calc': return gameCommands.calc(msg, phone);
            case '/riddle': return gameCommands.riddle(msg, phone);
            case '/points': return gameCommands.points(msg, phone);
            case '/top': return gameCommands.top(msg);
            case '/help':
                const helpContent = `🎯 JEUX:\n/quiz /loto /calc /riddle\n\n🏆 STATS:\n/points /top\n\n👑 ADMIN:\n/nolinks /adminonly\n\n🎁 Prix mensuels: 1500-500 FCFA`;
                return msg.reply(createBox('🎮 COMMANDES', helpContent));
        }
        
        // Commandes admin
        if (chat.isGroup) {
            const isAdmin = await isGroupAdmin(chat.id._serialized, phone) || phone === CONFIG.ADMIN_NUMBER;
            if (isAdmin) {
                switch (cmd) {
                    case '/nolinks': return adminCommands.nolinks(msg);
                    case '/adminonly': return adminCommands.adminonly(msg);
                    case '/stats': return adminCommands.stats(msg);
                }
            }
        } else if (phone === CONFIG.ADMIN_NUMBER) {
            if (cmd === '/stats') return adminCommands.stats(msg);
        }
        
    } catch (error) {
        console.error('Erreur message:', error);
        await msg.reply(createBox('❌ ERREUR', 'Erreur technique.\nRéessayez plus tard.'));
    }
});

// Nettoyage périodique
setInterval(() => {
    // Nettoyer spam cache
    const now = Date.now();
    for (const [phone, times] of state.cache.spam.entries()) {
        const filtered = times.filter(time => now - time < 60000);
        if (filtered.length === 0) {
            state.cache.spam.delete(phone);
        } else {
            state.cache.spam.set(phone, filtered);
        }
    }
    
    // Nettoyer bans expirés
    for (const [phone, banTime] of state.cache.banned.entries()) {
        if (now >= banTime) {
            state.cache.banned.delete(phone);
        }
    }
    
    // Nettoyer jeux expirés
    for (const [key, game] of state.cache.activeGames.entries()) {
        if (game.timeout && game.timeout._destroyed) {
            state.cache.activeGames.delete(key);
        }
    }
    
    console.log(`🧹 Nettoyage: ${state.cache.leaderboard.size} joueurs, ${state.cache.groups.size} groupes`);
}, 300000); // 5 minutes

// Gestion arrêt propre
process.on('SIGTERM', () => {
    console.log('🛑 Arrêt du bot...');
    if (state.client && state.ready) {
        state.client.sendMessage(CONFIG.ADMIN_NUMBER, 
            createBox('🛑 BOT OFFLINE', `Arrêté à ${new Date().toLocaleString('fr-FR')}`)
        ).finally(() => process.exit(0));
    } else {
        process.exit(0);
    }
});

// Démarrage
client.initialize();
app.listen(CONFIG.PORT, () => {
    console.log(`🌐 Serveur démarré sur port ${CONFIG.PORT}`);
});
