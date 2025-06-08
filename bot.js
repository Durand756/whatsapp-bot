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
        PRIZES: [1500, 1000, 500] // FCFA pour top 3 isgroup
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
    return await safeExecute(async () => {
        const chat = await state.client.getChatById(groupId);
        if (!chat || !chat.isGroup || !chat.participants) return false;
        
        const participant = chat.participants.find(p => p.id._serialized === phone);
        return participant && (participant.isAdmin || participant.isSuperAdmin);
    }, false, 'Check group admin');
}

async function isBotAdmin(groupId) {
    return await safeExecute(async () => {
        const chat = await state.client.getChatById(groupId);
        if (!chat || !chat.isGroup || !chat.participants) return false;
        
        const me = state.client.info.wid._serialized;
        const participant = chat.participants.find(p => p.id._serialized === me);
        return participant && (participant.isAdmin || participant.isSuperAdmin);
    }, false, 'Check bot admin');
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
        
        await msg.reply(`╔═══════════════════╗
║      📊 STATISTIQUES BOT      ║
╠══════════════════╣
║ 👥 Joueurs actifs: ${users.toString().padStart(8)} ║
║ 📢 Groupes: ${groups.toString().padStart(13)} ║
║ 🚫 Utilisateurs bannis: ${banned.toString().padStart(4)} ║
║ ⏰ Temps de fonctionnement: ${uptime}min ║
║ 💾 Mémoire utilisée: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB ║
╚═══════════════════╝`);
    },
    
    async leaderboard(msg) {
        const top = getLeaderboard();
        if (!top.length) return msg.reply('📋 Classement vide');
        
        let text = `🏆 ════ CLASSEMENT GÉNÉRAL ════ 🏆\n\n`;
        top.forEach((user, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            const medal = i < 3 ? medals[i] : `${i + 1}️⃣`;
            const crown = i === 0 ? '👑' : '';
            text += `${medal} ${crown} *${user.name}*\n`;
            text += `   💰 ${user.points.toLocaleString()} points\n`;
            text += `   🎮 ${user.wins} victoires\n\n`;
        });
        
        text += `\n🎁 ════ RÉCOMPENSES MENSUELLES ════\n`;
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
                    `🔊 ════ ANNONCE OFFICIELLE ════ 🔊\n\n${message}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎮 Gaming Bot Admin`);
                sent++;
                await new Promise(r => setTimeout(r, 2000));
            } catch {}
        }
        await msg.reply(`📊 Message diffusé dans ${sent}/${groups.length} groupes`);
    },

     async ban(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /ban @user [raison]');
        
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez un utilisateur à bannir');
        
        const userPhone = mentions[0].id._serialized;
        const reason = args.slice(1).join(' ') || 'Aucune raison spécifiée';
        
        // Bannir pour 24h par défaut
        const banTime = Date.now() + (24 * 60 * 60 * 1000);
        state.cache.banned.set(userPhone, banTime);
        
        await msg.reply(`🚫 ════ UTILISATEUR BANNI ════\n\n👤 *Utilisateur:* ${mentions[0].pushname}\n📱 *Numéro:* ${userPhone.replace('@c.us', '')}\n⏰ *Durée:* 24 heures\n📝 *Raison:* ${reason}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },

    async unban(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /unban @user');
        
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez un utilisateur à débannir');
        
        const userPhone = mentions[0].id._serialized;
        
        if (state.cache.banned.has(userPhone)) {
            state.cache.banned.delete(userPhone);
            await msg.reply(`✅ ════ UTILISATEUR DÉBANNI ════\n\n👤 *Utilisateur:* ${mentions[0].pushname}\n📱 *Numéro:* ${userPhone.replace('@c.us', '')}\n🎯 *Statut:* Peut maintenant utiliser le bot\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        } else {
            await msg.reply('❌ Cet utilisateur n\'est pas banni');
        }
    },

    async userinfo(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /userinfo @user');
        
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez un utilisateur');
        
        const userPhone = mentions[0].id._serialized;
        const user = state.cache.leaderboard.get(userPhone);
        const isBanned = state.cache.banned.has(userPhone);
        
        if (!user) {
            return msg.reply(`📋 ════ INFO UTILISATEUR ════\n\n👤 *Nom:* ${mentions[0].pushname}\n📱 *Numéro:* ${userPhone.replace('@c.us', '')}\n🎮 *Statut:* Nouveau joueur\n🚫 *Banni:* ${isBanned ? 'Oui' : 'Non'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        }
        
        const daysActive = Math.floor((Date.now() - user.joinDate) / (1000 * 60 * 60 * 24));
        const leaderboard = getLeaderboard();
        const rank = leaderboard.findIndex(u => u.phone === userPhone.replace('@c.us', '')) + 1;
        
        await msg.reply(`📋 ════ INFO UTILISATEUR ════\n\n👤 *Nom:* ${user.name}\n📱 *Numéro:* ${userPhone.replace('@c.us', '')}\n💰 *Points:* ${user.points.toLocaleString()}\n🏆 *Rang:* ${rank || 'Non classé'}/20\n🎮 *Victoires:* ${user.wins}\n📅 *Jours actifs:* ${daysActive}\n📊 *Inscription:* ${new Date(user.joinDate).toLocaleDateString('fr-FR')}\n🚫 *Banni:* ${isBanned ? 'Oui' : 'Non'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },

    async announce(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /announce message');
        
        const message = args.join(' ');
        const chats = await state.client.getChats();
        const groups = chats.filter(chat => chat.isGroup);
        
        let sent = 0;
        for (const group of groups) {
            try {
                await state.client.sendMessage(group.id._serialized, 
                    `📢 ════ ANNONCE IMPORTANTE ════ 📢\n\n${message}\n\n⚠️ *Message officiel du Gaming Bot*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                sent++;
                await new Promise(r => setTimeout(r, 1500));
            } catch {}
        }
        await msg.reply(`📊 Annonce envoyée dans ${sent}/${groups.length} groupes`);
    },

    async addpoints(msg, args) {
        if (args.length < 2) return msg.reply('❌ Usage: /addpoints @user [points]');
        
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez un utilisateur');
        
        const points = parseInt(args[1]);
        if (isNaN(points) || points <= 0) return msg.reply('❌ Nombre de points invalide');
        
        const userPhone = mentions[0].id._serialized;
        const newTotal = addPoints(userPhone, points, 'admin_bonus');
        
        await msg.reply(`✅ ════ POINTS AJOUTÉS ════\n\n👤 *Utilisateur:* ${mentions[0].pushname}\n💰 *Points ajoutés:* +${points.toLocaleString()}\n🎯 *Total:* ${newTotal.toLocaleString()} points\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },

    async removepoints(msg, args) {
        if (args.length < 2) return msg.reply('❌ Usage: /removepoints @user [points]');
        
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez un utilisateur');
        
        const points = parseInt(args[1]);
        if (isNaN(points) || points <= 0) return msg.reply('❌ Nombre de points invalide');
        
        const userPhone = mentions[0].id._serialized;
        const user = state.cache.leaderboard.get(userPhone);
        
        if (!user) return msg.reply('❌ Utilisateur non trouvé dans le classement');
        
        user.points = Math.max(0, user.points - points);
        state.cache.leaderboard.set(userPhone, user);
        
        await msg.reply(`✅ ════ POINTS RETIRÉS ════\n\n👤 *Utilisateur:* ${mentions[0].pushname}\n💰 *Points retirés:* -${points.toLocaleString()}\n🎯 *Total:* ${user.points.toLocaleString()} points\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },

    async resetuser(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /resetuser @user');
        
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez un utilisateur');
        
        const userPhone = mentions[0].id._serialized;
        
        if (state.cache.leaderboard.has(userPhone)) {
            state.cache.leaderboard.delete(userPhone);
            await msg.reply(`✅ ════ UTILISATEUR RÉINITIALISÉ ════\n\n👤 *Utilisateur:* ${mentions[0].pushname}\n🔄 *Action:* Toutes les données supprimées\n🎯 *Statut:* Nouveau joueur\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        } else {
            await msg.reply('❌ Utilisateur non trouvé dans le système');
        }
    },

    async prize(msg) {
        const top3 = getLeaderboard().slice(0, 3);
        if (!top3.length) return msg.reply('📋 Aucun joueur dans le classement');
        
        let text = `🎁 ════ GESTION DES PRIX ════ 🎁\n\n`;
        text += `💰 *PRIX ACTUELS:*\n`;
        text += `🥇 1er place: ${CONFIG.POINTS.PRIZES[0].toLocaleString()} FCFA\n`;
        text += `🥈 2e place: ${CONFIG.POINTS.PRIZES[1].toLocaleString()} FCFA\n`;
        text += `🥉 3e place: ${CONFIG.POINTS.PRIZES[2].toLocaleString()} FCFA\n\n`;
        
        text += `🏆 *TOP 3 ACTUEL:*\n`;
        top3.forEach((user, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            text += `${medals[i]} ${user.name} - ${user.points.toLocaleString()} pts\n`;
        });
        
        text += `\n⏰ *Prochaine distribution:* Automatique tous les 30 jours\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        await msg.reply(text);
    },

    async restart(msg) {
        await msg.reply(`🔄 ════ REDÉMARRAGE BOT ════\n\n⚠️ *Attention:* Le bot va redémarrer\n⏰ *Temps d'arrêt:* ~30 secondes\n🔄 *Statut:* En cours...\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        
        setTimeout(() => {
            process.exit(0);
        }, 3000);
    },

    async backup(msg) {
        const backupData = {
            timestamp: Date.now(),
            users: Object.fromEntries(state.cache.leaderboard),
            groups: Object.fromEntries(state.cache.groups),
            banned: Object.fromEntries(state.cache.banned),
            stats: {
                totalUsers: state.cache.leaderboard.size,
                totalGroups: state.cache.groups.size,
                totalBanned: state.cache.banned.size
            }
        };
        
        // Ici vous pourriez sauvegarder dans un fichier ou base de données
        console.log('💾 Sauvegarde effectuée:', JSON.stringify(backupData, null, 2));
        
        await msg.reply(`💾 ════ SAUVEGARDE EFFECTUÉE ════\n\n✅ *Statut:* Sauvegarde réussie\n📊 *Données:* ${backupData.stats.totalUsers} utilisateurs, ${backupData.stats.totalGroups} groupes\n⏰ *Heure:* ${new Date().toLocaleString('fr-FR')}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },

    async logs(msg) {
        const memUsage = process.memoryUsage();
        const uptime = Math.floor(process.uptime());
        
        const logInfo = `📊 ════ LOGS SYSTÈME ════ 📊\n\n⏰ *Temps de fonctionnement:* ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}min\n💾 *Mémoire utilisée:* ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB\n💾 *Mémoire totale:* ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB\n🔄 *Version Node:* ${process.version}\n🎮 *Joueurs actifs:* ${state.cache.leaderboard.size}\n📢 *Groupes connectés:* ${state.cache.groups.size}\n🚫 *Utilisateurs bannis:* ${state.cache.banned.size}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        await msg.reply(logInfo);
    },

    async maintenance(msg, args) {
        if (!args.length) return msg.reply('❌ Usage: /maintenance on/off');
        
        const mode = args[0].toLowerCase();
        if (mode !== 'on' && mode !== 'off') {
            return msg.reply('❌ Utilisez: /maintenance on ou /maintenance off');
        }
        
        // Vous pouvez créer une variable globale pour gérer le mode maintenance
        global.maintenanceMode = (mode === 'on');
        
        await msg.reply(`🔧 ════ MODE MAINTENANCE ════\n\n🔄 *Statut:* ${mode === 'on' ? 'ACTIVÉ 🔴' : 'DÉSACTIVÉ 🟢'}\n⚠️ *Info:* ${mode === 'on' ? 'Bot en maintenance - Commandes limitées' : 'Bot fonctionnel - Toutes commandes disponibles'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },

    async update(msg) {
        await msg.reply(`🔄 ════ MISE À JOUR BOT ════\n\n⚠️ *Attention:* Fonctionnalité en développement\n📋 *Actions:* Vérification des mises à jour\n🔧 *Statut:* Manuel requis pour l'instant\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },

    async help(msg) {
        const helpText = `🎮 ════ COMMANDES ADMIN MASTER ════ 🎮

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
        
        await msg.reply(`🔗 ════ PARAMÈTRE MODIFIÉ ════\n\n${settings.noLinks ? '🚫 Les liens sont maintenant INTERDITS' : '✅ Les liens sont maintenant AUTORISÉS'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
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
        
        await msg.reply(`👑 ════ MODE ADMIN ════\n\n${settings.adminOnly ? '🔒 Seuls les ADMINS peuvent utiliser les commandes' : '🔓 TOUS peuvent utiliser les commandes'}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    },
    
    async kick(msg) {
        const mentions = await msg.getMentions();
        if (!mentions.length) return msg.reply('❌ Mentionnez quelqu\'un à exclure');
        
        const chat = await msg.getChat();
        try {
            await chat.removeParticipants([mentions[0].id._serialized]);
            await msg.reply(`✅ ════ EXCLUSION RÉUSSIE ════\n\n👋 ${mentions[0].pushname} a été exclu du groupe\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        } catch {
            await msg.reply('❌ Impossible d\'exclure cet utilisateur');
        }
    }
};

// Commandes Jeux améliorées
const gameCommands = {
    async quiz(msg, phone) {
        const quiz = games.quizzes[Math.floor(Math.random() * games.quizzes.length)];
        await msg.reply(`🧠 ════ QUIZ CHALLENGE ════ 🧠

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
        
        const resultText = `🎲 ════ SUPER LOTO ════ 🎲

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
        
        const resultText = `🃏 ════ POCKET CARDS ════ 🃏

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
        await msg.reply(`🔢 ════ CALCUL RAPIDE ════ 🔢

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
        await msg.reply(`🤔 ════ ÉNIGME MYSTÈRE ════ 🤔

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
        
        await msg.reply(`💰 ════ VOS STATISTIQUES ════ 💰

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
        
        let text = `🏆 ════ TOP 20 JOUEURS ════ 🏆\n\n`;
        
        top.forEach((user, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            const medal = i < 3 ? medals[i] : `${(i + 1).toString().padStart(2, '0')}`;
            const crown = i === 0 ? '👑' : '';
            
            text += `${medal} ${crown} *${user.name}* - ${user.points.toLocaleString()} pts\n`;
        });
        
        text += `\n🎁 ════ RÉCOMPENSES MENSUELLES ════\n`;
        text += `🥇 1er place: 1,500 FCFA\n`;
        text += `🥈 2e place: 1,000 FCFA\n`;
        text += `🥉 3e place: 500 FCFA\n\n`;
        text += `⏰ *Les prix sont distribués tous les 30 jours!*\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        await msg.reply(text);
    }
};

async function handleGameResponses(msg, phone, text) {
    // Quiz responses
    if (state.cache[`quiz_${phone}`]) {
        const quiz = state.cache[`quiz_${phone}`];
        clearTimeout(quiz.timeout);
        state.cache[`quiz_${phone}`] = null;
        
        const isCorrect = quiz.a.some(ans => text.toLowerCase().includes(ans));
        if (isCorrect) {
            const points = addPoints(phone, quiz.points, 'quiz');
            const user = state.cache.leaderboard.get(phone);
            if (user) user.wins++;
            
            return safeExecute(async () => {
                await msg.reply(`🎉 ═══════ BRAVO! ═══════ 🎉

${quiz.emoji} *BONNE RÉPONSE!*
💰 +${quiz.points} points
🎯 Total: ${points.toLocaleString()} pts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            }, null, 'Quiz success reply');
        } else {
            return safeExecute(async () => {
                await msg.reply(`❌ Mauvaise réponse! Solution: ${quiz.a[0]}`);
            }, null, 'Quiz fail reply');
        }
    }
    
    // Calc responses
    if (state.cache[`calc_${phone}`]) {
        const calc = state.cache[`calc_${phone}`];
        clearTimeout(calc.timeout);
        state.cache[`calc_${phone}`] = null;
        
        if (parseInt(text) === calc.answer) {
            const points = addPoints(phone, 15, 'calc');
            const user = state.cache.leaderboard.get(phone);
            if (user) user.wins++;
            
            return safeExecute(async () => {
                await msg.reply(`🎉 ═══════ CALCUL PARFAIT! ═══════ 🎉

🔢 *BRAVO!*
💰 +15 points
🎯 Total: ${points.toLocaleString()} pts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            }, null, 'Calc success reply');
        } else {
            return safeExecute(async () => {
                await msg.reply(`❌ Incorrect! Réponse: ${calc.answer}`);
            }, null, 'Calc fail reply');
        }
    }
    
    // Riddle responses
    if (state.cache[`riddle_${phone}`]) {
        const riddle = state.cache[`riddle_${phone}`];
        clearTimeout(riddle.timeout);
        state.cache[`riddle_${phone}`] = null;
        
        const isCorrect = riddle.a.some(ans => text.toLowerCase().includes(ans));
        if (isCorrect) {
            const points = addPoints(phone, riddle.points, 'riddle');
            const user = state.cache.leaderboard.get(phone);
            if (user) user.wins++;
            
            return safeExecute(async () => {
                await msg.reply(`🎉 ═══════ ÉNIGME RÉSOLUE! ═══════ 🎉

${riddle.emoji} *EXCELLENT!*
💰 +${riddle.points} points
🎯 Total: ${points.toLocaleString()} pts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            }, null, 'Riddle success reply');
        } else {
            return safeExecute(async () => {
                await msg.reply(`❌ Pas tout à fait! Solution: ${riddle.a[0]}`);
            }, null, 'Riddle fail reply');
        }
    }
};
    
}

async function executeCommands(msg, phone, cmd, args, chat) {
    // Vérifier le mode maintenance (sauf pour l'admin principal)
    if (global.maintenanceMode && phone !== CONFIG.ADMIN_NUMBER) {
        return safeExecute(async () => {
            await msg.reply('🔧 Bot en maintenance. Réessayez plus tard.');
        }, null, 'Maintenance mode reply');
    }
    
    // Commandes Admin Principal (protégées)
    if (phone === CONFIG.ADMIN_NUMBER) {
        switch (cmd) {
            case '/stats':
                return safeExecute(async () => {
                    await masterCommands.stats(msg);
                }, null, 'Stats command');
                
            case '/broadcast':
                return safeExecute(async () => {
                    await masterCommands.broadcast(msg, args);
                }, null, 'Broadcast command');

            case '/announce':
                return safeExecute(async () => {
                    await masterCommands.announce(msg, args);
                }, null, 'Announce command');
                
            case '/ban':
                return safeExecute(async () => {
                    await masterCommands.ban(msg, args);
                }, null, 'Ban command');
                
            case '/unban':
                return safeExecute(async () => {
                    await masterCommands.unban(msg, args);
                }, null, 'Unban command');
                
            case '/userinfo':
                return safeExecute(async () => {
                    await masterCommands.userinfo(msg, args);
                }, null, 'Userinfo command');
                
            case '/addpoints':
                return safeExecute(async () => {
                    await masterCommands.addpoints(msg, args);
                }, null, 'Addpoints command');
                
            case '/removepoints':
                return safeExecute(async () => {
                    await masterCommands.removepoints(msg, args);
                }, null, 'Removepoints command');
                
            case '/resetuser':
                return safeExecute(async () => {
                    await masterCommands.resetuser(msg, args);
                }, null, 'Resetuser command');
                
            case '/prize':
                return safeExecute(async () => {
                    await masterCommands.prize(msg);
                }, null, 'Prize command');
                
            case '/restart':
                return safeExecute(async () => {
                    await masterCommands.restart(msg);
                }, null, 'Restart command');
                
            case '/backup':
                return safeExecute(async () => {
                    await masterCommands.backup(msg);
                }, null, 'Backup command');
                
            case '/logs':
                return safeExecute(async () => {
                    await masterCommands.logs(msg);
                }, null, 'Logs command');
                
            case '/maintenance':
                return safeExecute(async () => {
                    await masterCommands.maintenance(msg, args);
                }, null, 'Maintenance command');
                
            case '/update':
                return safeExecute(async () => {
                    await masterCommands.update(msg);
                }, null, 'Update command');
                
            case '/help':
                return safeExecute(async () => {
                    await masterCommands.help(msg);
                }, null, 'Help command');
                
            case '/leaderboard':
                return safeExecute(async () => {
                    await masterCommands.leaderboard(msg);
                }, null, 'Leaderboard command');
        }
    }
    
    // Commandes Admin Groupe (protégées)
    if (chat && chat.isGroup) {
        const isAdmin = await safeExecute(async () => 
            await isGroupAdmin(chat.id._serialized, phone), false, 'Check group admin');
            
        if (isAdmin || phone === CONFIG.ADMIN_NUMBER) {
            switch (cmd) {
                case '/nolinks':
                    return safeExecute(async () => {
                        await adminCommands.nolinks(msg);
                    }, null, 'Nolinks command');
                    
                case '/adminonly':
                    return safeExecute(async () => {
                        await adminCommands.adminonly(msg);
                    }, null, 'Adminonly command');
                    
                case '/kick':
                    return safeExecute(async () => {
                        await adminCommands.kick(msg);
                    }, null, 'Kick command');
            }
        }
    }
    
    // Commandes Jeux (pour tous les utilisateurs non bannis)
    if (!state.cache.banned.has(phone)) {
        switch (cmd) {
            case '/quiz':
                return safeExecute(async () => {
                    await gameCommands.quiz(msg, phone);
                }, null, 'Quiz command');
                
            case '/loto':
                return safeExecute(async () => {
                    await gameCommands.loto(msg, phone);
                }, null, 'Loto command');
                
            case '/calc':
                return safeExecute(async () => {
                    await gameCommands.calc(msg, phone);
                }, null, 'Calc command');
                
            case '/pocket':
                return safeExecute(async () => {
                    await gameCommands.pocket(msg, phone);
                }, null, 'Pocket command');
                
            case '/riddle':
                return safeExecute(async () => {
                    await gameCommands.riddle(msg, phone);
                }, null, 'Riddle command');
                
            case '/points':
                return safeExecute(async () => {
                    await gameCommands.points(msg, phone);
                }, null, 'Points command');
                
            case '/top':
                return safeExecute(async () => {
                    await gameCommands.top(msg);
                }, null, 'Top command');
                
            case '/help':
                return safeExecute(async () => {
                    await msg.reply(`🎮 ═══════ GUIDE DES COMMANDES ═══════ 🎮

🎯 *JEUX:*
• /quiz - Questions culture (+10-15 pts)
• /loto - Loterie (+5-50 pts)
• /calc - Calculs (+15 pts)
• /pocket - Cartes (+10-30 pts)
• /riddle - Énigmes (+10-15 pts)

🏆 *STATS:*
• /points - Vos statistiques
• /top - Classement

👑 *ADMIN (Groupes):*
• /nolinks - Gérer les liens
• /adminonly - Mode admin
• /kick @user - Exclure

🎁 *PRIX MENSUELS:*
🥇 1,500 FCFA | 🥈 1,000 FCFA | 🥉 500 FCFA

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                }, null, 'Help reply');
        }
    }
}
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
            `🚀 ════ BOT GAMING ONLINE ════ 🚀

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
    await safeExecute(async () => {
        // Vérifier si on peut traiter cet événement
        const groupId = notification.chatId;
        if (!canExecute(`group_join_${groupId}`, CONFIG.RATE_LIMITS.GROUP_JOIN_DELAY)) {
            console.log('⏰ Group join ignoré (rate limit)');
            return;
        }

        const chat = await notification.getChat();
        if (!chat || !chat.isGroup) return;

        console.log(`✅ Bot ajouté au groupe: ${chat.name}`);
        
        // Attendre un peu avant d'envoyer le message
        setTimeout(async () => {
            await safeExecute(async () => {
                await client.sendMessage(chat.id._serialized, 
                    `🎮 ═══════ BIENVENUE! ═══════ 🎮

🚀 *Gaming Bot activé!*

🎯 *JEUX:* /quiz /loto /calc /pocket /riddle
🏆 *STATS:* /points /top
👑 *ADMIN:* /help

🎁 *PRIX MENSUELS:*
🥇 1,500 FCFA | 🥈 1,000 FCFA | 🥉 500 FCFA

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 Tapez /help pour commencer!`
                );
            }, null, 'Envoi message bienvenue');
        }, 3000);
        
    }, null, 'Group join handler');
});

client.on('message', async (msg) => {
    // Protection de base
    if (!state.ready || !msg.body || msg.fromMe) return;
    
    await safeExecute(async () => {
        const contact = await msg.getContact();
        const phone = contact.id._serialized;
        const text = msg.body.trim();
        
        // Rate limiting par utilisateur
        if (!canExecute(`user_${phone}`, 1000)) return;
        
        const args = text.split(' ').slice(1);
        const cmd = text.split(' ')[0].toLowerCase();
        
        // Anti-spam avec protection
        if (checkSpam(phone)) {
            return safeExecute(async () => {
                await msg.reply('🚫 Trop de messages! Attendez 5 minutes.');
            }, null, 'Anti-spam reply');
        }
        
        // Mise à jour nom utilisateur sécurisée
        if (contact.pushname && state.cache.leaderboard.has(phone)) {
            const user = state.cache.leaderboard.get(phone);
            user.name = contact.pushname.substring(0, 50); // Limiter longueur
            state.cache.leaderboard.set(phone, user);
        }
        
        // Vérification liens dans groupes
        const chat = await safeExecute(async () => await msg.getChat(), null, 'Get chat');
        if (chat && chat.isGroup) {
            const groupSettings = state.cache.groups.get(chat.id._serialized);
            if (groupSettings?.noLinks && hasLinks(text)) {
                const isAdmin = await safeExecute(async () => 
                    await isGroupAdmin(chat.id._serialized, phone), false, 'Check admin');
                    
                if (!isAdmin && await safeExecute(async () => 
                    await isBotAdmin(chat.id._serialized), false, 'Check bot admin')) {
                    
                    await safeExecute(async () => {
                        await msg.delete(true);
                        await msg.reply('🔗 Liens interdits dans ce groupe!');
                    }, null, 'Delete link message');
                    return;
                }
            }
            
            // Mode admin only avec protection
            if (groupSettings?.adminOnly && text.startsWith('/')) {
                const isAdmin = await safeExecute(async () => 
                    await isGroupAdmin(chat.id._serialized, phone), false, 'Check admin mode');
                    
                if (!isAdmin && phone !== CONFIG.ADMIN_NUMBER) {
                    return safeExecute(async () => {
                        await msg.reply('👑 Commandes réservées aux admins!');
                    }, null, 'Admin only reply');
                }
            }
        }
        
        // Traitement des réponses aux jeux (sécurisé)
        await handleGameResponses(msg, phone, text);
        
        if (!text.startsWith('/')) return;
        
        // Exécution des commandes avec protection
        await executeCommands(msg, phone, cmd, args, chat);
        
    }, null, 'Message handler principal');
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
                        `🎉 ════ FÉLICITATIONS! ════ 🎉

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
                        `💰 ════ PRIX À DISTRIBUER ════ 💰

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
    
    console.log(`🎮 ════ STATISTIQUES BOT ═══════
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
    console.log(`🌐 ════ SERVEUR DÉMARRÉ ═══════
🔗 Port: ${CONFIG.PORT}
🎮 Dashboard: http://localhost:${CONFIG.PORT}
⚡ Status: En ligne
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});

// Gestion propre de l'arrêt
// ════════ PARTIE 1: AJOUTEZ APRÈS LA CONFIGURATION ════════
// Protection globale contre les erreurs
process.on('uncaughtException', (error) => {
    console.error('🚨 ERREUR CRITIQUE:', error);
    // Ne pas fermer le processus, juste logger
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 PROMESSE REJETÉE:', reason);
    // Ne pas fermer le processus
});

// Gestionnaire d'erreurs sécurisé
const safeExecute = async (fn, fallback = null, context = 'Opération') => {
    try {
        return await fn();
    } catch (error) {
        console.error(`❌ Erreur ${context}:`, error.message);
        return fallback;
    }
};

// Rate limiter pour éviter le spam d'opérations
const rateLimiter = new Map();
const canExecute = (key, delay = 1000) => {
    const now = Date.now();
    const last = rateLimiter.get(key) || 0;
    if (now - last < delay) return false;
    rateLimiter.set(key, now);
    return true;
};
