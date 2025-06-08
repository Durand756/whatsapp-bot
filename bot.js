const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');

// Configuration
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    PORT: process.env.PORT || 3000,
    SPAM_LIMIT: 5, // Messages par minute
    SPAM_BAN_TIME: 300000, // 5min
    POINTS: {
        QUIZ_WIN: 10, GAME_WIN: 15, DAILY_USE: 2,
        PRIZES: [1500, 1000, 500] // FCFA pour top 3
    }
};

// État global
const state = {
    ready: false, qr: null, client: null,
    cache: { 
        users: new Map(), groups: new Map(), 
        spam: new Map(), banned: new Map(),
        leaderboard: new Map()
    }
};

// Jeux et Quiz améliorés
const games = {
    quizzes: [
        { q: "🏛️ Quelle est la capitale du Cameroun?", a: ["yaoundé", "yaounde"], points: 10, emoji: "🇨🇲" },
        { q: "🧮 Combien fait 2+2×3?", a: ["8"], points: 8, emoji: "🔢" },
        { q: "🌊 Quel est le plus grand océan du monde?", a: ["pacifique"], points: 12, emoji: "🗺️" },
        { q: "🔴 Quelle planète est surnommée la planète rouge?", a: ["mars"], points: 8, emoji: "🚀" },
        { q: "💡 Qui a inventé l'ampoule électrique?", a: ["edison"], points: 15, emoji: "⚡" },
        { q: "🏔️ Quel est le plus haut sommet du monde?", a: ["everest"], points: 12, emoji: "⛰️" },
        { q: "🦁 Quel est le roi des animaux?", a: ["lion"], points: 8, emoji: "👑" },
        { q: "🌍 Sur quel continent se trouve le Cameroun?", a: ["afrique"], points: 10, emoji: "🌍" },
        { q: "⚽ Combien de joueurs dans une équipe de football?", a: ["11", "onze"], points: 8, emoji: "⚽" },
        { q: "🎨 Quelle couleur obtient-on en mélangeant rouge et bleu?", a: ["violet", "violette"], points: 10, emoji: "🎨" }
    ],
    
    loto: () => Array.from({length: 6}, () => Math.floor(Math.random() * 45) + 1).sort((a,b) => a-b),
    
    pocket: {
        cards: ['🂡','🂮','🂭','🂫','🂪','🂩','🂨','🂧','🂦','🂥'],
        deal: () => {
            const deck = games.pocket.cards;
            return [deck[Math.floor(Math.random() * deck.length)], 
                   deck[Math.floor(Math.random() * deck.length)]];
        }
    },
    
    calc: () => {
        const ops = ['+', '-', '×'];
        const a = Math.floor(Math.random() * 50) + 1;
        const b = Math.floor(Math.random() * 30) + 1;
        const op = ops[Math.floor(Math.random() * ops.length)];
        let result;
        switch(op) {
            case '+': result = a + b; break;
            case '-': result = a - b; break;
            case '×': result = a * b; break;
        }
        return { question: `${a} ${op} ${b} = ?`, answer: result };
    },
    
    // Nouveau jeu de devinettes
    riddles: [
        { q: "🤔 Je suis blanc quand je suis sale, que suis-je?", a: ["tableau", "ardoise"], points: 15, emoji: "🖍️" },
        { q: "🕳️ Plus on m'enlève, plus je deviens grand. Que suis-je?", a: ["trou"], points: 12, emoji: "🕳️" },
        { q: "🌙 Je brille la nuit sans être une étoile, que suis-je?", a: ["lune"], points: 10, emoji: "🌙" }
    ]
};

// Anti-spam
function checkSpam(phone) {
    const now = Date.now();
    if (state.cache.banned.has(phone)) {
        const banTime = state.cache.banned.get(phone);
        if (now < banTime) return true;
        state.cache.banned.delete(phone);
    }
    
    if (!state.cache.spam.has(phone)) {
        state.cache.spam.set(phone, []);
    }
    
    const messages = state.cache.spam.get(phone);
    messages.push(now);
    
    // Garder seulement les messages de la dernière minute
    const filtered = messages.filter(time => now - time < 60000);
    state.cache.spam.set(phone, filtered);
    
    if (filtered.length > CONFIG.SPAM_LIMIT) {
        state.cache.banned.set(phone, now + CONFIG.SPAM_BAN_TIME);
        return true;
    }
    return false;
}

// Gestion des points
function addPoints(phone, points, reason = '') {
    if (!state.cache.leaderboard.has(phone)) {
        state.cache.leaderboard.set(phone, {
            points: 0, wins: 0, lastActive: Date.now(), name: 'Joueur', joinDate: Date.now()
        });
    }
    const user = state.cache.leaderboard.get(phone);
    user.points += points;
    user.lastActive = Date.now();
    state.cache.leaderboard.set(phone, user);
    return user.points;
}

function getLeaderboard() {
    return Array.from(state.cache.leaderboard.entries())
        .map(([phone, data]) => ({ phone: phone.replace('@c.us', ''), ...data }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 20);
}

// Vérifications admin
async function isGroupAdmin(groupId, phone) {
    try {
        const chat = await state.client.getChatById(groupId);
        if (!chat.isGroup) return false;
        const participant = chat.participants.find(p => p.id._serialized === phone);
        return participant && (participant.isAdmin || participant.isSuperAdmin);
    } catch { return false; }
}

async function isBotAdmin(groupId) {
    try {
        const chat = await state.client.getChatById(groupId);
        const me = state.client.info.wid._serialized;
        const participant = chat.participants.find(p => p.id._serialized === me);
        return participant && (participant.isAdmin || participant.isSuperAdmin);
    } catch { return false; }
}

// Détection liens
function hasLinks(text) {
    const linkRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[^\s]+\.[a-z]{2,})/i;
    return linkRegex.test(text);
}

// Commandes Admin Principal
const masterCommands = {
    async makeadmin(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /makeadmin @user');
        const chat = await msg.getChat();
        if (!chat.isGroup) return msg.reply('❌ Commande groupe uniquement');
        
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez un utilisateur');
        
        try {
            await chat.promoteParticipants([mentions[0].id._serialized]);
            await msg.reply(`✅ ${mentions[0].pushname} promu admin`);
        } catch (e) {
            await msg.reply('❌ Impossible de promouvoir (bot pas admin?)');
        }
    },
    
    async stats(msg) {
        const users = state.cache.leaderboard.size;
        const groups = state.cache.groups.size;
        const banned = state.cache.banned.size;
        const uptime = Math.floor(process.uptime() / 60);
        
        await msg.reply(`╔═══════════════════════╗
║      📊 STATISTIQUES BOT      ║
╠═══════════════════════╣
║ 👥 Joueurs actifs: ${users.toString().padStart(8)} ║
║ 📢 Groupes: ${groups.toString().padStart(13)} ║
║ 🚫 Utilisateurs bannis: ${banned.toString().padStart(4)} ║
║ ⏰ Temps de fonctionnement: ${uptime}min ║
║ 💾 Mémoire utilisée: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB ║
╚═══════════════════════╝`);
    },
    
    async leaderboard(msg) {
        const top = getLeaderboard();
        if (!top.length) return msg.reply('📋 Classement vide');
        
        let text = `🏆 ═══════ CLASSEMENT GÉNÉRAL ═══════ 🏆\n\n`;
        top.forEach((user, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            const medal = i < 3 ? medals[i] : `${i + 1}️⃣`;
            const crown = i === 0 ? '👑' : '';
            text += `${medal} ${crown} *${user.name}*\n`;
            text += `   💰 ${user.points.toLocaleString()} points\n`;
            text += `   🎮 ${user.wins} victoires\n\n`;
        });
        
        text += `\n🎁 ═══════ RÉCOMPENSES MENSUELLES ═══════\n`;
        text += `🥇 1er place: 1,500 FCFA\n`;
        text += `🥈 2e place: 1,000 FCFA\n`;
        text += `🥉 3e place: 500 FCFA\n\n`;
        text += `⏰ Les prix sont distribués tous les 30 jours!`;
        
        await msg.reply(text);
    },
    
    async broadcast(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /broadcast message');
        const message = args.join(' ');
        const chats = await state.client.getChats();
        const groups = chats.filter(chat => chat.isGroup);
        
        let sent = 0;
        for (const group of groups) {
            try {
                await state.client.sendMessage(group.id._serialized, 
                    `🔊 ═══════ ANNONCE OFFICIELLE ═══════ 🔊\n\n${message}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎮 Gaming Bot Admin`);
                sent++;
                await new Promise(r => setTimeout(r, 2000));
            } catch {}
        }
        await msg.reply(`📊 Message diffusé dans ${sent}/${groups.length} groupes`);
    },

    async help(msg) {
        const helpText = `🎮 ═══════ COMMANDES ADMIN MASTER ═══════ 🎮

👑 *GESTION UTILISATEURS:*
• /makeadmin @user - Promouvoir admin
• /ban @user - Bannir utilisateur  
• /unban @user - Débannir utilisateur

📊 *STATISTIQUES:*
• /stats - Statistiques détaillées
• /leaderboard - Classement complet
• /userinfo @user - Info utilisateur

📢 *COMMUNICATION:*
• /broadcast [message] - Diffusion globale
• /announce [message] - Annonce importante

🎯 *JEUX & POINTS:*
• /addpoints @user [points] - Ajouter points
• /removepoints @user [points] - Retirer points
• /resetuser @user - Reset utilisateur
• /prize - Gérer les prix mensuels

⚙️ *SYSTÈME:*
• /restart - Redémarrer bot
• /backup - Sauvegarder données
• /logs - Voir les logs

🛠️ *MAINTENANCE:*
• /maintenance on/off - Mode maintenance
• /update - Mettre à jour bot`;

        await msg.reply(helpText);
    }
};

// Commandes Admin Groupe
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
        
        await msg.reply(`🔗 ═══════ PARAMÈTRE MODIFIÉ ═══════\n\n${settings.noLinks ? '🚫 Les liens sont maintenant INTERDITS' : '✅ Les liens sont maintenant AUTORISÉS'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
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
        
        await msg.reply(`👑 ═══════ MODE ADMIN ═══════\n\n${settings.adminOnly ? '🔒 Seuls les ADMINS peuvent utiliser les commandes' : '🔓 TOUS peuvent utiliser les commandes'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },
    
    async kick(msg) {
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez quelqu\'un à exclure');
        
        const chat = await msg.getChat();
        try {
            await chat.removeParticipants([mentions[0].id._serialized]);
            await msg.reply(`✅ ═══════ EXCLUSION RÉUSSIE ═══════\n\n👋 ${mentions[0].pushname} a été exclu du groupe\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        } catch {
            await msg.reply('❌ Impossible d\'exclure cet utilisateur');
        }
    }
};

// Commandes Jeux améliorées
const gameCommands = {
    async quiz(msg, phone) {
        const quiz = games.quizzes[Math.floor(Math.random() * games.quizzes.length)];
        await msg.reply(`🧠 ═══════ QUIZ CHALLENGE ═══════ 🧠

${quiz.emoji} *QUESTION:*
${quiz.q}

🎯 *RÉCOMPENSE:* +${quiz.points} points
⏰ *TEMPS LIMITE:* 30 secondes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 Tapez votre réponse maintenant!`);
        
        const timeout = setTimeout(() => {
            state.cache[`quiz_${phone}`] = null;
        }, 30000);
        
        state.cache[`quiz_${phone}`] = { ...quiz, timeout };
        addPoints(phone, CONFIG.POINTS.DAILY_USE);
    },
    
    async loto(msg, phone) {
        const numbers = games.loto();
        const userGuess = Math.floor(Math.random() * 45) + 1;
        const win = numbers.includes(userGuess);
        const points = win ? 50 : 5;
        
        addPoints(phone, points);
        
        const resultText = `🎲 ═══════ SUPER LOTO ═══════ 🎲

🎯 *VOS NUMÉROS:* ${numbers.join(' - ')}
🎰 *NUMÉRO GAGNANT:* ${userGuess}

${win ? '🎉 ✨ FÉLICITATIONS! VOUS AVEZ GAGNÉ! ✨' : '😅 Pas de chance cette fois...'}

💰 *POINTS GAGNÉS:* +${points}
🏆 *STATUT:* ${win ? 'GAGNANT 🏆' : 'PARTICIPATION 🎯'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        await msg.reply(resultText);
    },
    
    async pocket(msg, phone) {
        const cards = games.pocket.deal();
        const isPair = cards[0] === cards[1];
        const points = isPair ? 30 : 10;
        
        addPoints(phone, points);
        
        const resultText = `🃏 ═══════ POCKET CARDS ═══════ 🃏

🎴 *VOS CARTES:*
   ${cards[0]}    ${cards[1]}

${isPair ? '🎉 ✨ PAIRE PARFAITE! ✨' : '🎯 Belle combinaison!'}

💰 *POINTS GAGNÉS:* +${points}
🏆 *BONUS:* ${isPair ? 'PAIRE x3' : 'NORMAL'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        await msg.reply(resultText);
    },
    
    async calc(msg, phone) {
        const problem = games.calc();
        await msg.reply(`🔢 ═══════ CALCUL RAPIDE ═══════ 🔢

🧮 *CALCUL À RÉSOUDRE:*
   ${problem.question}

🎯 *RÉCOMPENSE:* +15 points
⏰ *TEMPS LIMITE:* 20 secondes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔥 Répondez vite pour gagner!`);
        
        const timeout = setTimeout(() => {
            state.cache[`calc_${phone}`] = null;
        }, 20000);
        
        state.cache[`calc_${phone}`] = { ...problem, timeout };
        addPoints(phone, CONFIG.POINTS.DAILY_USE);
    },

    async riddle(msg, phone) {
        const riddle = games.riddles[Math.floor(Math.random() * games.riddles.length)];
        await msg.reply(`🤔 ═══════ ÉNIGME MYSTÈRE ═══════ 🤔

${riddle.emoji} *ÉNIGME:*
${riddle.q}

🎯 *RÉCOMPENSE:* +${riddle.points} points
⏰ *TEMPS LIMITE:* 45 secondes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 Réfléchissez bien...`);
        
        const timeout = setTimeout(() => {
            state.cache[`riddle_${phone}`] = null;
        }, 45000);
        
        state.cache[`riddle_${phone}`] = { ...riddle, timeout };
        addPoints(phone, CONFIG.POINTS.DAILY_USE);
    },
    
    async points(msg, phone) {
        const user = state.cache.leaderboard.get(phone);
        const leaderboard = getLeaderboard();
        const rank = leaderboard.findIndex(u => u.phone === phone.replace('@c.us', '')) + 1;
        
        if (!user) return msg.reply('🎮 Jouez d\'abord pour avoir des points!');
        
        const daysActive = Math.floor((Date.now() - user.joinDate) / (1000 * 60 * 60 * 24));
        const avgPointsPerDay = daysActive > 0 ? Math.round(user.points / daysActive) : 0;
        
        await msg.reply(`💰 ═══════ VOS STATISTIQUES ═══════ 💰

👤 *JOUEUR:* ${user.name}
🎯 *POINTS TOTAUX:* ${user.points.toLocaleString()}
🏆 *RANG ACTUEL:* ${rank || 'Non classé'}/20
🎮 *VICTOIRES:* ${user.wins}
📅 *JOURS ACTIFS:* ${daysActive}
📊 *MOYENNE/JOUR:* ${avgPointsPerDay} pts

${rank <= 3 ? '🎁 *VOUS ÊTES DANS LE TOP 3!*\n🏆 Continuez pour gagner des prix!' : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },
    
    async top(msg) {
        const top = getLeaderboard();
        if (!top.length) return msg.reply('📋 Classement vide');
        
        let text = `🏆 ═══════ TOP 20 JOUEURS ═══════ 🏆\n\n`;
        
        top.forEach((user, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            const medal = i < 3 ? medals[i] : `${(i + 1).toString().padStart(2, '0')}`;
            const crown = i === 0 ? '👑' : '';
            
            text += `${medal} ${crown} *${user.name}* - ${user.points.toLocaleString()} pts\n`;
        });
        
        text += `\n🎁 ═══════ RÉCOMPENSES MENSUELLES ═══════\n`;
        text += `🥇 1er place: 1,500 FCFA\n`;
        text += `🥈 2e place: 1,000 FCFA\n`;
        text += `🥉 3e place: 500 FCFA\n\n`;
        text += `⏰ *Les prix sont distribués tous les 30 jours!*\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        await msg.reply(text);
    }
};

// Interface web améliorée
const app = express();
app.get('/', (req, res) => {
    const html = state.ready ? 
        `<div class="container">
            <h1>🎮 Gaming Bot - ONLINE ✅</h1>
            <div class="stats">
                <div class="stat-card">
                    <h3>👥 Joueurs</h3>
                    <p>${state.cache.leaderboard.size}</p>
                </div>
                <div class="stat-card">
                    <h3>📢 Groupes</h3>
                    <p>${state.cache.groups.size}</p>
                </div>
                <div class="stat-card">
                    <h3>⏰ Uptime</h3>
                    <p>${Math.floor(process.uptime() / 60)}min</p>
                </div>
            </div>
        </div>` :
        state.qr ? 
        `<div class="container">
            <h1>📱 Scanner le QR Code</h1>
            <img src="data:image/png;base64,${state.qr}" class="qr-code">
            <p>Scannez avec WhatsApp</p>
        </div>` :
        `<div class="container">
            <h1>🔄 Chargement du bot...</h1>
            <div class="loader"></div>
        </div>`;
    
    const css = `
        <style>
            body { 
                font-family: 'Arial', sans-serif; 
                background: linear-gradient(135deg, #25D366, #075E54); 
                color: white; 
                margin: 0; 
                padding: 0; 
                min-height: 100vh; 
                display: flex; 
                justify-content: center; 
                align-items: center; 
            }
            .container { 
                text-align: center; 
                background: rgba(255,255,255,0.1); 
                padding: 40px; 
                border-radius: 20px; 
                backdrop-filter: blur(10px); 
                box-shadow: 0 8px 32px rgba(0,0,0,0.3); 
            }
            .stats { 
                display: flex; 
                gap: 20px; 
                margin-top: 20px; 
                justify-content: center; 
            }
            .stat-card { 
                background: rgba(255,255,255,0.2); 
                padding: 20px; 
                border-radius: 15px; 
                min-width: 100px; 
            }
            .qr-code { 
                max-width: 300px; 
                border-radius: 15px; 
                margin: 20px 0; 
            }
            .loader { 
                border: 4px solid rgba(255,255,255,0.3); 
                border-radius: 50%; 
                border-top: 4px solid white; 
                width: 40px; 
                height: 40px; 
                animation: spin 2s linear infinite; 
                margin: 20px auto; 
            }
            @keyframes spin { 
                0% { transform: rotate(0deg); } 
                100% { transform: rotate(360deg); } 
            }
        </style>
    `;
    
    res.send(`<html><head><title>Gaming Bot Dashboard</title>${css}</head><body>${html}</body></html>`);
});

// Client WhatsApp
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', async (qr) => {
    state.qr = (await QRCode.toDataURL(qr)).split(',')[1];
    console.log('📱 QR Code généré');
});

client.on('ready', async () => {
    state.ready = true;
    state.client = client;
    console.log('🎮 Gaming Bot Ready!');
    
    // Notification à l'admin principal
    try {
        await client.sendMessage(CONFIG.ADMIN_NUMBER, 
            `🚀 ═══════ BOT GAMING ONLINE ═══════ 🚀

✅ *STATUT:* Bot démarré avec succès
⏰ *HEURE:* ${new Date().toLocaleString('fr-FR')}
🔧 *VERSION:* 2.0 Enhanced

📊 *FONCTIONNALITÉS ACTIVES:*
• 🎮 Jeux interactifs
• 🏆 Système de classement
• 💰 Récompenses mensuelles
• 🛡️ Anti-spam avancé
• 👑 Gestion des groupes

🎯 *COMMANDES ADMIN DISPONIBLES:*
Tapez /help pour voir toutes vos commandes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Votre Gaming Bot est prêt!`);
    } catch (error) {
        console.error('Erreur notification admin:', error);
    }
});

client.on('group_join', async (notification) => {
    const chat = await notification.getChat();
    setTimeout(async () => {
        await client.sendMessage(chat.id._serialized, 
            `🎮 ═══════ BIENVENUE DANS ${chat.name.toUpperCase()}! ═══════ 🎮

🚀 *Gaming Bot activé avec succès!*

🎯 *JEUX DISPONIBLES:*
• /quiz - Questions culture générale
• /loto - Loterie avec gros lots
• /calc - Calculs rapides
• /pocket - Jeu de cartes
• /riddle - Énigmes mystères

🏆 *CLASSEMENT & POINTS:*
• /points - Vos statistiques
• /top - Top 20 joueurs

👑 *COMMANDES ADMIN:*
• /nolinks - Bloquer les liens
• /adminonly - Mode admin seul
• /kick @user - Exclure membre

🎁 *RÉCOMPENSES MENSUELLES:*
🥇 1er: 1,500 FCFA | 🥈 2e: 1,000 FCFA | 🥉 3e: 500 FCFA

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Amusez-vous bien et que le meilleur gagne! 🏆`
        );
    }, 3000);
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
            return msg.reply('🚫 ═══════ ANTI-SPAM ACTIVÉ ═══════\n\n⏰ Vous envoyez trop de messages!\n🔒 Attendez 5 minutes avant de réessayer.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }
        
        // Mettre à jour nom utilisateur
        if (contact.pushname && state.cache.leaderboard.has(phone)) {
            const user = state.cache.leaderboard.get(phone);
            user.name = contact.pushname;
            state.cache.leaderboard.set(phone, user);
        }
        
        // Vérifier liens interdits
        const chat = await msg.getChat();
        if (chat.isGroup) {
            const groupSettings = state.cache.groups.get(chat.id._serialized);
            if (groupSettings?.noLinks && hasLinks(text)) {
                const isAdmin = await isGroupAdmin(chat.id._serialized, phone);
                if (!isAdmin && await isBotAdmin(chat.id._serialized)) {
                    await msg.delete(true);
                    return msg.reply('🔗 ═══════ LIEN DÉTECTÉ ═══════\n\n🚫 Les liens sont interdits dans ce groupe!\n👑 Seuls les admins peuvent partager des liens.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                }
            }
            
            // Mode admin only
            if (groupSettings?.adminOnly && text.startsWith('/')) {
                const isAdmin = await isGroupAdmin(chat.id._serialized, phone);
                if (!isAdmin && phone !== CONFIG.ADMIN_NUMBER) {
                    return msg.reply('👑 ═══════ ACCÈS RESTREINT ═══════\n\n🔒 Les commandes sont réservées aux admins!\n💬 Contactez un administrateur pour plus d\'infos.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                }
            }
        }
        
        // Réponses aux jeux en cours
        if (state.cache[`quiz_${phone}`]) {
            const quiz = state.cache[`quiz_${phone}`];
            clearTimeout(quiz.timeout);
            state.cache[`quiz_${phone}`] = null;
            
            if (quiz.a.some(ans => text.toLowerCase().includes(ans))) {
                const points = addPoints(phone, quiz.points, 'quiz');
                const user = state.cache.leaderboard.get(phone);
                user.wins++;
                return msg.reply(`🎉 ═══════ BRAVO! BONNE RÉPONSE! ═══════ 🎉

${quiz.emoji} *QUIZ RÉUSSI!*
✅ *RÉPONSE:* ${quiz.a[0]}
💰 *POINTS GAGNÉS:* +${quiz.points}
🎯 *TOTAL POINTS:* ${points.toLocaleString()}
🏆 *VICTOIRES:* ${user.wins}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Continuez à jouer pour gravir le classement!`);
            } else {
                return msg.reply(`❌ ═══════ RÉPONSE INCORRECTE ═══════ ❌

${quiz.emoji} *QUIZ ÉCHOUÉ*
✅ *BONNE RÉPONSE:* ${quiz.a[0]}
💡 *CONSEIL:* Réfléchissez bien la prochaine fois!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Retentez votre chance avec /quiz`);
            }
        }
        
        if (state.cache[`calc_${phone}`]) {
            const calc = state.cache[`calc_${phone}`];
            clearTimeout(calc.timeout);
            state.cache[`calc_${phone}`] = null;
            
            if (parseInt(text) === calc.answer) {
                const points = addPoints(phone, 15, 'calc');
                const user = state.cache.leaderboard.get(phone);
                user.wins++;
                return msg.reply(`🎉 ═══════ CALCUL PARFAIT! ═══════ 🎉

🔢 *CALCUL RÉUSSI!*
✅ *RÉPONSE:* ${calc.answer}
💰 *POINTS GAGNÉS:* +15
🎯 *TOTAL POINTS:* ${points.toLocaleString()}
🏆 *VICTOIRES:* ${user.wins}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧮 Votre rapidité est impressionnante!`);
            } else {
                return msg.reply(`❌ ═══════ CALCUL INCORRECT ═══════ ❌

🔢 *CALCUL ÉCHOUÉ*
✅ *BONNE RÉPONSE:* ${calc.answer}
💡 *CONSEIL:* Prenez votre temps pour calculer!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Retentez avec /calc`);
            }
        }

        if (state.cache[`riddle_${phone}`]) {
            const riddle = state.cache[`riddle_${phone}`];
            clearTimeout(riddle.timeout);
            state.cache[`riddle_${phone}`] = null;
            
            if (riddle.a.some(ans => text.toLowerCase().includes(ans))) {
                const points = addPoints(phone, riddle.points, 'riddle');
                const user = state.cache.leaderboard.get(phone);
                user.wins++;
                return msg.reply(`🎉 ═══════ ÉNIGME RÉSOLUE! ═══════ 🎉

${riddle.emoji} *GÉNIAL!*
✅ *RÉPONSE:* ${riddle.a[0]}
💰 *POINTS GAGNÉS:* +${riddle.points}
🎯 *TOTAL POINTS:* ${points.toLocaleString()}
🏆 *VICTOIRES:* ${user.wins}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 Votre logique est excellente!`);
            } else {
                return msg.reply(`❌ ═══════ ÉNIGME NON RÉSOLUE ═══════ ❌

${riddle.emoji} *RÉPONSE INCORRECTE*
✅ *SOLUTION:* ${riddle.a[0]}
💡 *CONSEIL:* Réfléchissez différemment!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Nouvelle énigme avec /riddle`);
            }
        }
        
        if (!text.startsWith('/')) return;
        
        // Commandes Admin Principal
        if (phone === CONFIG.ADMIN_NUMBER) {
            switch (cmd) {
                case '/makeadmin': return masterCommands.makeadmin(msg, args);
                case '/stats': return masterCommands.stats(msg);
                case '/leaderboard': return masterCommands.leaderboard(msg);
                case '/broadcast': return masterCommands.broadcast(msg, args);
                case '/help': return masterCommands.help(msg);
            }
        }
        
        // Commandes Admin Groupe
        if (chat.isGroup) {
            const isAdmin = await isGroupAdmin(chat.id._serialized, phone) || phone === CONFIG.ADMIN_NUMBER;
            if (isAdmin) {
                switch (cmd) {
                    case '/nolinks': return adminCommands.nolinks(msg);
                    case '/adminonly': return adminCommands.adminonly(msg);
                    case '/kick': return adminCommands.kick(msg);
                }
            }
        }
        
        // Commandes Jeux (tous)
        switch (cmd) {
            case '/quiz': return gameCommands.quiz(msg, phone);
            case '/loto': return gameCommands.loto(msg, phone);
            case '/pocket': return gameCommands.pocket(msg, phone);
            case '/calc': return gameCommands.calc(msg, phone);
            case '/riddle': return gameCommands.riddle(msg, phone);
            case '/points': return gameCommands.points(msg, phone);
            case '/top': return gameCommands.top(msg);
            case '/help':
                return msg.reply(`🎮 ═══════ GUIDE DES COMMANDES ═══════ 🎮

🎯 *JEUX DISPONIBLES:*
• /quiz - Questions culture générale (+10-15 pts)
• /loto - Loterie avec gros lots (+5-50 pts)
• /calc - Calculs mathématiques (+15 pts)
• /pocket - Jeu de cartes (+10-30 pts)
• /riddle - Énigmes mystères (+10-15 pts)

🏆 *CLASSEMENT & STATS:*
• /points - Vos statistiques personnelles
• /top - Top 20 des meilleurs joueurs

👑 *COMMANDES ADMIN (Groupes):*
• /nolinks - Activer/désactiver les liens
• /adminonly - Mode commandes admin seul
• /kick @user - Exclure un membre

🎁 *SYSTÈME DE RÉCOMPENSES:*
🥇 1er place: 1,500 FCFA (mensuel)
🥈 2e place: 1,000 FCFA (mensuel)  
🥉 3e place: 500 FCFA (mensuel)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Amusez-vous et gagnez des prix! 🏆`);
        }
        
    } catch (error) {
        console.error('Erreur:', error);
        await msg.reply('❌ ═══════ ERREUR SYSTÈME ═══════\n\n🔧 Une erreur technique s\'est produite.\n🔄 Veuillez réessayer dans quelques instants.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }
});

// Vérification mensuelle des prix améliorée
setInterval(async () => {
    const top3 = getLeaderboard().slice(0, 3);
    const now = new Date();
    
    for (let i = 0; i < top3.length; i++) {
        const user = top3[i];
        const userData = state.cache.leaderboard.get(`${user.phone}@c.us`);
        
        if (userData && userData.joinDate) {
            const daysSinceJoin = (now - new Date(userData.joinDate)) / (1000 * 60 * 60 * 24);
            
            if (daysSinceJoin >= 30) {
                const prize = CONFIG.POINTS.PRIZES[i];
                const position = i + 1;
                const medals = ['🥇', '🥈', '🥉'];
                
                try {
                    // Message au gagnant
                    await client.sendMessage(`${user.phone}@c.us`, 
                        `🎉 ═══════ FÉLICITATIONS! ═══════ 🎉

${medals[i]} *VOUS AVEZ GAGNÉ UN PRIX!*

🏆 *POSITION:* ${position}${position === 1 ? 'er' : 'e'} place du classement
👤 *JOUEUR:* ${user.name}
💰 *PRIX:* ${prize.toLocaleString()} FCFA
⭐ *POINTS TOTAUX:* ${user.points.toLocaleString()}

🎯 *POUR RÉCUPÉRER VOTRE PRIX:*
Cliquez sur ce lien pour contacter l'admin:
https://wa.me/+237651104356?text=Bonjour%20Admin%2C%20je%20suis%20${encodeURIComponent(user.name)}%20et%20j'ai%20fini%20${position}${position === 1 ? 'er' : 'e'}%20du%20classement.%20Je%20viens%20récupérer%20mon%20prix%20de%20${prize}%20FCFA.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Bravo pour votre performance! 🏆`
                    );
                    
                    // Notification à l'admin
                    await client.sendMessage(CONFIG.ADMIN_NUMBER, 
                        `💰 ═══════ PRIX À DISTRIBUER ═══════ 💰

${medals[i]} *GAGNANT DU MOIS:*
👤 *NOM:* ${user.name}
📱 *NUMÉRO:* ${user.phone}
🏆 *RANG:* ${position}${position === 1 ? 'er' : 'e'} place
💰 *MONTANT:* ${prize.toLocaleString()} FCFA
⭐ *POINTS:* ${user.points.toLocaleString()}
📅 *DATE:* ${now.toLocaleDateString('fr-FR')}

🎯 *ACTIONS À PRENDRE:*
• Vérifier l'identité du gagnant
• Préparer le paiement de ${prize} FCFA
• Confirmer la transaction

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Nouveau cycle de récompenses démarré!`
                    );
                    
                    // Marquer comme récompensé
                    userData.lastReward = now.getTime();
                    state.cache.leaderboard.set(`${user.phone}@c.us`, userData);
                    
                } catch (e) {
                    console.error('Erreur envoi prix:', e);
                }
            }
        }
    }
}, 24 * 60 * 60 * 1000); // Vérification quotidienne

// Sauvegarde périodique et statistiques
setInterval(() => {
    const stats = {
        players: state.cache.leaderboard.size,
        groups: state.cache.groups.size,
        totalPoints: Array.from(state.cache.leaderboard.values()).reduce((sum, user) => sum + user.points, 0),
        totalGames: Array.from(state.cache.leaderboard.values()).reduce((sum, user) => sum + user.wins, 0)
    };
    
    console.log(`🎮 ═══════ STATISTIQUES BOT ═══════
👥 Joueurs actifs: ${stats.players}
📢 Groupes connectés: ${stats.groups}  
💰 Points distribués: ${stats.totalPoints.toLocaleString()}
🎯 Parties jouées: ${stats.totalGames.toLocaleString()}
💾 Mémoire: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}, 300000); // Toutes les 5 minutes

// Démarrage du client et serveur
client.initialize();
app.listen(CONFIG.PORT, () => {
    console.log(`🌐 ═══════ SERVEUR DÉMARRÉ ═══════
🔗 Port: ${CONFIG.PORT}
🎮 Dashboard: http://localhost:${CONFIG.PORT}
⚡ Status: En ligne
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});

// Gestion propre de l'arrêt
process.on('SIGTERM', () => {
    console.log('🛑 ═══════ ARRÊT DU BOT ═══════');
    
    // Notification d'arrêt à l'admin
    if (state.client && state.ready) {
        state.client.sendMessage(CONFIG.ADMIN_NUMBER, 
            `🛑 ═══════ BOT GAMING OFFLINE ═══════

⚠️ *STATUT:* Bot arrêté
⏰ *HEURE:* ${new Date().toLocaleString('fr-FR')}
📊 *DERNIÈRES STATS:*
• ${state.cache.leaderboard.size} joueurs
• ${state.cache.groups.size} groupes

🔄 *REDÉMARRAGE:* Automatique prévu
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
        ).finally(() => {
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});
