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

// Jeux et Quiz
const games = {
    quizzes: [
        { q: "Capitale du Cameroun?", a: ["yaoundé", "yaounde"], points: 10 },
        { q: "2+2×3=?", a: ["8"], points: 8 },
        { q: "Plus grand océan?", a: ["pacifique"], points: 12 },
        { q: "Planète rouge?", a: ["mars"], points: 8 },
        { q: "Inventeur de l'ampoule?", a: ["edison"], points: 15 }
    ],
    
    loto: () => Array.from({length: 6}, () => Math.floor(Math.random() * 45) + 1).sort((a,b) => a-b),
    
    pocket: {
        cards: ['A♠','K♠','Q♠','J♠','10♠','9♠','8♠','7♠'],
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
    }
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
            points: 0, wins: 0, lastActive: Date.now(), name: 'Utilisateur'
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
        await msg.reply(`📊 *STATS BOT*\n👥 Users: ${users}\n📢 Groupes: ${groups}\n🚫 Bannis: ${banned}\n⏰ Uptime: ${Math.floor(process.uptime())}s`);
    },
    
    async leaderboard(msg) {
        const top = getLeaderboard().slice(0, 10);
        if (!top.length) return msg.reply('📋 Classement vide');
        
        let text = '🏆 *TOP 10 JOUEURS*\n\n';
        top.forEach((user, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
            text += `${medal} ${user.name}\n💰 ${user.points} pts\n\n`;
        });
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
                await state.client.sendMessage(group.id._serialized, `📢 *ANNONCE*\n\n${message}`);
                sent++;
                await new Promise(r => setTimeout(r, 2000));
            } catch {}
        }
        await msg.reply(`📊 Diffusé dans ${sent}/${groups.length} groupes`);
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
        
        await msg.reply(`🔗 Liens ${settings.noLinks ? 'INTERDITS' : 'AUTORISÉS'}`);
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
        
        await msg.reply(`👑 Mode admin ${settings.adminOnly ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
    },
    
    async kick(msg) {
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez quelqu\'un');
        
        const chat = await msg.getChat();
        try {
            await chat.removeParticipants([mentions[0].id._serialized]);
            await msg.reply(`✅ ${mentions[0].pushname} exclu`);
        } catch {
            await msg.reply('❌ Impossible d\'exclure');
        }
    }
};

// Commandes Jeux
const gameCommands = {
    async quiz(msg, phone) {
        const quiz = games.quizzes[Math.floor(Math.random() * games.quizzes.length)];
        await msg.reply(`🧠 *QUIZ* (+${quiz.points}pts)\n\n❓ ${quiz.q}\n\n⏰ 30 secondes pour répondre`);
        
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
        await msg.reply(`🎲 *LOTO*\n🎯 Vos numéros: ${numbers.join('-')}\n🎰 Tirage: ${userGuess}\n${win ? '🎉 GAGNÉ!' : '😅 Perdu'}\n💰 +${points} points`);
    },
    
    async pocket(msg, phone) {
        const cards = games.pocket.deal();
        const points = cards[0] === cards[1] ? 30 : 10;
        
        addPoints(phone, points);
        await msg.reply(`🃏 *POCKET*\n🎴 Vos cartes: ${cards.join(' ')}\n${cards[0] === cards[1] ? '🎉 PAIRE!' : '🎯 Pas mal'}\n💰 +${points} points`);
    },
    
    async calc(msg, phone) {
        const problem = games.calc();
        await msg.reply(`🔢 *CALCUL* (+15pts)\n\n❓ ${problem.question}\n\n⏰ 20 secondes`);
        
        const timeout = setTimeout(() => {
            state.cache[`calc_${phone}`] = null;
        }, 20000);
        
        state.cache[`calc_${phone}`] = { ...problem, timeout };
        addPoints(phone, CONFIG.POINTS.DAILY_USE);
    },
    
    async points(msg, phone) {
        const user = state.cache.leaderboard.get(phone);
        const rank = getLeaderboard().findIndex(u => u.phone === phone.replace('@c.us', '')) + 1;
        
        if (!user) return msg.reply('🎮 Jouez d\'abord pour avoir des points!');
        
        await msg.reply(`💰 *VOS POINTS*\n🎯 Points: ${user.points}\n🏆 Rang: ${rank || 'Non classé'}\n🎮 Victoires: ${user.wins}`);
    },
    
    async top(msg) {
        const top = getLeaderboard().slice(0, 5);
        if (!top.length) return msg.reply('📋 Classement vide');
        
        let text = '🏆 *TOP 5*\n\n';
        top.forEach((user, i) => {
            const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i];
            text += `${medal} ${user.name}\n💰 ${user.points} pts\n\n`;
        });
        await msg.reply(text);
    }
};

// Interface web
const app = express();
app.get('/', (req, res) => {
    const html = state.ready ? 
        `<h1>✅ Bot Gaming Online</h1><p>👥 ${state.cache.leaderboard.size} joueurs</p><p>📢 ${state.cache.groups.size} groupes</p>` :
        state.qr ? 
        `<h1>📱 Scanner QR</h1><img src="data:image/png;base64,${state.qr}">` :
        `<h1>🔄 Chargement...</h1>`;
    
    res.send(`<html><head><title>Gaming Bot</title><style>body{text-align:center;font-family:Arial;background:#25D366;color:white;padding:50px}</style></head><body>${html}</body></html>`);
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
});

client.on('ready', () => {
    state.ready = true;
    state.client = client;
    console.log('🎮 Gaming Bot Ready!');
});

client.on('group_join', async (notification) => {
    const chat = await notification.getChat();
    setTimeout(async () => {
        await client.sendMessage(chat.id._serialized, 
            `🎮 *SALUT ${chat.name.toUpperCase()}!*\n\n🎯 Bot de jeux et gestion\n\n🎲 Commandes:\n• /quiz - Quiz\n• /loto - Loto\n• /calc - Calcul\n• /pocket - Cartes\n• /points - Vos points\n• /top - Classement\n\n👑 Admins:\n• /nolinks - Bloquer liens\n• /adminonly - Mode admin\n\nAmusez-vous bien! 🎉`
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
            return msg.reply('🚫 Anti-spam activé. Attendez 5 minutes.');
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
                    return msg.reply('🔗 Liens interdits dans ce groupe!');
                }
            }
            
            // Mode admin only
            if (groupSettings?.adminOnly && text.startsWith('/')) {
                const isAdmin = await isGroupAdmin(chat.id._serialized, phone);
                if (!isAdmin && phone !== CONFIG.ADMIN_NUMBER) {
                    return msg.reply('👑 Commandes réservées aux admins');
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
                return msg.reply(`🎉 *CORRECT!*\n💰 +${quiz.points} points\n🎯 Total: ${points} points`);
            } else {
                return msg.reply(`❌ *FAUX!*\n✅ Réponse: ${quiz.a[0]}`);
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
                return msg.reply(`🎉 *EXACT!*\n💰 +15 points\n🎯 Total: ${points} points`);
            } else {
                return msg.reply(`❌ *FAUX!*\n✅ Réponse: ${calc.answer}`);
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
            case '/points': return gameCommands.points(msg, phone);
            case '/top': return gameCommands.top(msg);
            case '/help':
                return msg.reply(`🎮 *COMMANDES BOT*\n\n🎯 *JEUX:*\n• /quiz - Questions\n• /loto - Loterie\n• /calc - Calculs\n• /pocket - Cartes\n• /points - Vos points\n• /top - Top 5\n\n👑 *ADMIN:*\n• /nolinks - Bloquer liens\n• /adminonly - Mode admin\n• /kick @user - Exclure\n\n🏆 Gagnez des points et montez dans le classement!`);
        }
        
    } catch (error) {
        console.error('Erreur:', error);
        await msg.reply('❌ Erreur. Réessayez.');
    }
});

// Vérification mensuelle des prix
setInterval(async () => {
    const top3 = getLeaderboard().slice(0, 3);
    const now = new Date();
    
    for (let i = 0; i < top3.length; i++) {
        const user = top3[i];
        const userData = state.cache.leaderboard.get(`${user.phone}@c.us`);
        
        if (userData && userData.lastActive) {
            const daysSinceActive = (now - new Date(userData.lastActive)) / (1000 * 60 * 60 * 24);
            
            if (daysSinceActive >= 30) {
                const prize = CONFIG.POINTS.PRIZES[i];
                try {
                    await client.sendMessage(`${user.phone}@c.us`, 
                        `🎉 *FÉLICITATIONS!*\n\n🏆 Vous êtes ${i+1}${i === 0 ? 'er' : 'ème'} du classement!\n💰 Vous avez gagné ${prize} FCFA\n\n📞 Contactez l'admin pour récupérer votre prix: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`
                    );
                    
                    await client.sendMessage(CONFIG.ADMIN_NUMBER, 
                        `💰 *PRIX À PAYER*\n👤 ${user.name} (${user.phone})\n🏆 Position: ${i+1}\n💰 Montant: ${prize} FCFA`
                    );
                } catch (e) {
                    console.error('Erreur envoi prix:', e);
                }
            }
        }
    }
}, 24 * 60 * 60 * 1000); // Vérification quotidienne

// Sauvegarde périodique (pour Render)
setInterval(() => {
    // Pas de sauvegarde fichier sur Render gratuit
    console.log(`💗 ${state.cache.leaderboard.size} joueurs - ${state.cache.groups.size} groupes`);
}, 300000);

client.initialize();
app.listen(CONFIG.PORT, () => console.log(`🌐 Port ${CONFIG.PORT}`));

process.on('SIGTERM', () => {
    console.log('🛑 Arrêt...');
    process.exit(0);
});
