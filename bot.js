const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Configuration globale
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    DATA_FILE: path.join(__dirname, 'bot_data.json'),
    USAGE_DURATION: 30 * 24 * 60 * 60 * 1000, // 30 jours
    SESSION_PATH: path.join(__dirname, '.wwebjs_auth'),
    PORT: 3000,
    CODE_EXPIRY: 24 * 60 * 60 * 1000, // 24h
    QR_TIMEOUT: 60000, // 1 minute
    RECONNECT_DELAY: 5000, // 5 secondes
    MAX_RECONNECT_ATTEMPTS: 10
};

// État global du bot
let botState = {
    isReady: false,
    currentQR: null,
    server: null,
    data: { users: {}, codes: {}, groups: {} },
    reconnectAttempts: 0,
    lastActivity: Date.now()
};

// Serveur web pour interface
const app = express();
app.get('/', (req, res) => {
    const status = botState.isReady ? 
        `<h1 style="color:green">✅ Bot En Ligne</h1><p>Actif depuis: ${new Date(botState.lastActivity).toLocaleString()}</p>` :
        botState.currentQR ? 
        `<h1>📱 Scan QR Code</h1><img src="data:image/png;base64,${botState.currentQR}" style="max-width:300px"><script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1>🔄 Connexion...</h1><script>setTimeout(()=>location.reload(),5000)</script>`;
    
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp Bot</title><style>body{font-family:Arial;text-align:center;margin:50px;background:#25D366;color:white}</style></head><body>${status}</body></html>`);
});

// Gestion des données
function loadData() {
    try {
        if (fs.existsSync(CONFIG.DATA_FILE)) {
            botState.data = { users: {}, codes: {}, groups: {}, ...JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8')) };
        }
        return true;
    } catch (error) {
        console.error('❌ Erreur chargement:', error.message);
        return false;
    }
}

function saveData() {
    try {
        // Nettoyer les données expirées
        const now = Date.now();
        Object.keys(botState.data.codes).forEach(phone => {
            if (now - botState.data.codes[phone].created > CONFIG.CODE_EXPIRY) {
                delete botState.data.codes[phone];
            }
        });
        
        Object.keys(botState.data.users).forEach(phone => {
            const user = botState.data.users[phone];
            if (user.active && (now - user.activatedAt) >= CONFIG.USAGE_DURATION) {
                user.active = false;
            }
        });
        
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(botState.data, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde:', error.message);
        return false;
    }
}

// Utilitaires
function generateCode(phone) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        if (i === 4) code += ' ';
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    
    botState.data.codes[phone] = { code, created: Date.now(), used: false };
    saveData();
    return code;
}

function validateCode(phone, inputCode) {
    const codeData = botState.data.codes[phone];
    if (!codeData?.code || codeData.used) return false;
    
    const normalizedInput = inputCode.replace(/\s/g, '').toUpperCase();
    const normalizedStored = codeData.code.replace(/\s/g, '').toUpperCase();
    
    if (normalizedInput !== normalizedStored) return false;
    if (Date.now() - codeData.created > CONFIG.CODE_EXPIRY) {
        delete botState.data.codes[phone];
        saveData();
        return false;
    }
    
    codeData.used = true;
    botState.data.users[phone] = { active: true, activatedAt: Date.now(), phone };
    saveData();
    return true;
}

function isAuthorized(phone) {
    const user = botState.data.users[phone];
    if (!user?.active) return false;
    
    const valid = (Date.now() - user.activatedAt) < CONFIG.USAGE_DURATION;
    if (!valid) {
        user.active = false;
        saveData();
    }
    return valid;
}

// Configuration client WhatsApp optimisée pour 24/7
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "bot-247-v1",
        dataPath: CONFIG.SESSION_PATH
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ]
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

// Démarrer serveur web
function startServer() {
    if (!botState.server) {
        botState.server = app.listen(CONFIG.PORT, () => {
            console.log(`🌐 Interface: http://localhost:${CONFIG.PORT}`);
        });
    }
}

// Fonction de reconnexion automatique
async function attemptReconnect() {
    if (botState.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Trop de tentatives de reconnexion');
        return;
    }
    
    botState.reconnectAttempts++;
    console.log(`🔄 Tentative de reconnexion ${botState.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}`);
    
    setTimeout(async () => {
        try {
            if (!botState.isReady) {
                await client.initialize();
            }
        } catch (error) {
            console.error('❌ Erreur reconnexion:', error.message);
            await attemptReconnect();
        }
    }, CONFIG.RECONNECT_DELAY * botState.reconnectAttempts);
}

// Événements client
client.on('qr', async (qr) => {
    try {
        console.log('📱 QR Code généré');
        botState.currentQR = (await QRCode.toDataURL(qr, { width: 300 })).split(',')[1];
        startServer();
        
        setTimeout(() => {
            if (!botState.isReady) botState.currentQR = null;
        }, CONFIG.QR_TIMEOUT);
    } catch (error) {
        console.error('❌ Erreur QR:', error.message);
    }
});

client.on('ready', async () => {
    botState.isReady = true;
    botState.currentQR = null;
    botState.reconnectAttempts = 0;
    botState.lastActivity = Date.now();
    
    console.log('🎉 BOT CONNECTÉ ET PRÊT!');
    console.log(`📞 Admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`);
    startServer();
    
    try {
        await client.sendMessage(CONFIG.ADMIN_NUMBER, `🎉 *BOT EN LIGNE 24/7*\n✅ Prêt à fonctionner\n🕒 ${new Date().toLocaleString('fr-FR')}`);
    } catch (error) {
        console.error('❌ Erreur notification admin:', error.message);
    }
});

client.on('auth_failure', async (msg) => {
    console.error('❌ Échec authentification:', msg);
    botState.isReady = false;
    
    // Supprimer session corrompue et reconnecter
    if (fs.existsSync(CONFIG.SESSION_PATH)) {
        fs.rmSync(CONFIG.SESSION_PATH, { recursive: true, force: true });
    }
    
    await attemptReconnect();
});

client.on('disconnected', async (reason) => {
    console.log('🔌 Déconnexion:', reason);
    botState.isReady = false;
    
    // Reconnexion automatique sauf si déconnexion manuelle
    if (reason !== 'LOGOUT' && reason !== 'NAVIGATION') {
        await attemptReconnect();
    }
});

// NOUVEAU: Gestion des appels (FIX PRINCIPAL)
client.on('call', async (call) => {
    try {
        console.log(`📞 Appel reçu de ${call.from}:`, call.isVideo ? 'Vidéo' : 'Audio');
        
        // Rejeter automatiquement l'appel
        await call.reject();
        
        // Optionnel: Envoyer un message d'explication
        setTimeout(async () => {
            try {
                await client.sendMessage(call.from, '🤖 *Bot automatique*\n\nJe ne peux pas répondre aux appels.\nUtilisez les commandes texte uniquement.\n\nTapez `/help` pour voir les commandes disponibles.');
            } catch (error) {
                console.error('❌ Erreur message appel:', error.message);
            }
        }, 2000);
        
    } catch (error) {
        console.error('❌ Erreur gestion appel:', error.message);
    }
});

// Fonction d'envoi sécurisée
async function sendMessage(chatId, text) {
    try {
        if (!botState.isReady) throw new Error('Bot non connecté');
        return await client.sendMessage(chatId, text);
    } catch (error) {
        console.error('❌ Erreur envoi:', error.message);
        throw error;
    }
}

// Traitement des messages (AMÉLIORÉ)
client.on('message', async (message) => {
    if (!botState.isReady) return;
    
    try {
        // Ignorer les messages système et autres types non-texte
        if (!message.body || message.type !== 'chat') {
            // Log pour debug mais ne pas traiter
            if (message.type === 'ptt') {
                console.log('🎤 Message vocal ignoré');
            } else if (message.hasMedia) {
                console.log('📎 Média ignoré');
            }
            return;
        }
        
        const text = message.body.trim();
        if (!text) return;
        
        const contact = await message.getContact();
        if (!contact || contact.isMe) return;
        
        const userPhone = contact.id._serialized;
        botState.lastActivity = Date.now();
        
        // Traiter seulement les commandes
        if (!text.startsWith('/')) {
            // Répondre aux messages non-commandes avec info
            if (text.length < 50) { // Éviter de répondre aux longs messages
                setTimeout(async () => {
                    try {
                        await message.reply('🤖 Utilisez `/help` pour voir les commandes disponibles');
                    } catch (error) {
                        console.error('❌ Erreur réponse auto:', error.message);
                    }
                }, 1000);
            }
            return;
        }
        
        const cmd = text.toLowerCase();
        console.log(`📨 ${userPhone}: ${cmd}`);
        
        // Commandes admin
        if (userPhone === CONFIG.ADMIN_NUMBER) {
            if (cmd.startsWith('/gencode ')) {
                const number = text.substring(9).trim();
                if (!number) {
                    await message.reply('❌ Usage: `/gencode [numéro]`');
                    return;
                }
                
                const targetPhone = number.includes('@') ? number : `${number}@c.us`;
                const code = generateCode(targetPhone);
                await message.reply(`✅ *CODE GÉNÉRÉ*\n👤 Pour: ${number}\n🔑 Code: \`${code}\`\n⏰ Valide 24h`);
                
            } else if (cmd === '/stats') {
                const stats = {
                    users: Object.keys(botState.data.users).length,
                    active: Object.values(botState.data.users).filter(u => u.active).length,
                    codes: Object.keys(botState.data.codes).length,
                    groups: Object.keys(botState.data.groups).length
                };
                await message.reply(`📊 *STATISTIQUES*\n👥 Total: ${stats.users}\n✅ Actifs: ${stats.active}\n🔑 Codes: ${stats.codes}\n📢 Groupes: ${stats.groups}`);
                
            } else if (cmd === '/help') {
                await message.reply('🤖 *ADMIN*\n• /gencode [num] - Créer code\n• /stats - Statistiques\n• /help - Aide');
            }
            return;
        }
        
        // Activation utilisateur
        if (cmd.startsWith('/activate ')) {
            const inputCode = text.substring(10).trim();
            if (!inputCode) {
                await message.reply('❌ Usage: `/activate XXXX XXXX`');
                return;
            }
            
            if (validateCode(userPhone, inputCode)) {
                const expiry = new Date(Date.now() + CONFIG.USAGE_DURATION).toLocaleDateString('fr-FR');
                await message.reply(`🎉 *ACCÈS ACTIVÉ*\n📅 Expire: ${expiry}\n\n*Commandes:*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Statut\n• /help - Aide`);
            } else {
                await message.reply('❌ Code invalide ou expiré');
            }
            return;
        }
        
        // Vérifier autorisation
        if (!isAuthorized(userPhone)) {
            await message.reply(`🔒 *Accès requis*\n\nContactez: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\nPuis: \`/activate CODE\``);
            return;
        }
        
        // Commandes utilisateur autorisé
        if (cmd === '/status') {
            const user = botState.data.users[userPhone];
            const remaining = Math.ceil((user.activatedAt + CONFIG.USAGE_DURATION - Date.now()) / (24 * 60 * 60 * 1000));
            const groupCount = Object.values(botState.data.groups).filter(g => g.addedBy === userPhone).length;
            await message.reply(`📊 *STATUT*\n🟢 Actif\n📅 ${remaining} jours\n📢 ${groupCount} groupes`);
            
        } else if (cmd === '/addgroup') {
            const chat = await message.getChat();
            if (!chat.isGroup) {
                await message.reply('❌ Commande pour groupes uniquement');
                return;
            }
            
            const groupId = chat.id._serialized;
            if (botState.data.groups[groupId]) {
                await message.reply('ℹ️ Groupe déjà enregistré');
            } else {
                botState.data.groups[groupId] = {
                    name: chat.name,
                    addedBy: userPhone,
                    addedAt: Date.now()
                };
                saveData();
                await message.reply(`✅ Groupe ajouté: *${chat.name}*`);
            }
            
        } else if (cmd.startsWith('/broadcast ')) {
            const msg = text.substring(11).trim();
            if (!msg) {
                await message.reply('❌ Usage: `/broadcast [message]`');
                return;
            }
            
            const userGroups = Object.entries(botState.data.groups).filter(([, group]) => group.addedBy === userPhone);
            if (userGroups.length === 0) {
                await message.reply('❌ Aucun groupe. Utilisez `/addgroup` d\'abord');
                return;
            }
            
            await message.reply(`🚀 Diffusion vers ${userGroups.length} groupes...`);
            
            let success = 0, failed = 0;
            const senderName = contact.pushname || 'Utilisateur';
            
            for (const [groupId, groupInfo] of userGroups) {
                try {
                    const fullMsg = `📢 *Message diffusé*\n👤 De: ${senderName}\n📅 ${new Date().toLocaleString('fr-FR')}\n\n${msg}`;
                    await sendMessage(groupId, fullMsg);
                    success++;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    failed++;
                    console.error(`❌ Erreur groupe ${groupId}:`, error.message);
                }
            }
            
            await message.reply(`📊 *RÉSULTAT*\n✅ Succès: ${success}\n❌ Échecs: ${failed}`);
            
        } else if (cmd === '/help') {
            await message.reply('🤖 *COMMANDES*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Mon statut\n• /help - Aide\n\n⚠️ *Note:* Je ne réponds qu\'aux messages texte et commandes.');
        }
        
    } catch (error) {
        console.error('❌ Erreur message:', error.message);
        try {
            await message.reply('❌ Erreur interne');
        } catch (e) {
            console.error('❌ Erreur réponse:', e.message);
        }
    }
});

// NOUVEAU: Gestion des erreurs spécifiques
client.on('message_create', (message) => {
    // Ignorer silencieusement les messages créés par le bot
    if (message.fromMe) return;
});

client.on('message_revoke_everyone', (after, before) => {
    // Ignorer les messages supprimés
    console.log('🗑️ Message supprimé ignoré');
});

client.on('message_revoke_me', (message) => {
    // Ignorer les messages supprimés pour moi
    console.log('🗑️ Message supprimé pour moi ignoré');
});

// Maintien de la connexion (AMÉLIORÉ)
setInterval(() => {
    if (botState.isReady) {
        // Ping pour maintenir la connexion
        client.getState().then(state => {
            if (state !== 'CONNECTED') {
                console.log('⚠️ État connexion:', state);
                if (state === 'TIMEOUT' || state === 'CONFLICT' || state === 'UNLAUNCHED') {
                    botState.isReady = false;
                    attemptReconnect();
                }
            }
        }).catch(error => {
            console.error('❌ Erreur vérification état:', error.message);
            botState.isReady = false;
            attemptReconnect();
        });
    }
}, 30000); // Vérifier toutes les 30 secondes

// Sauvegarde automatique
setInterval(() => {
    if (botState.isReady) saveData();
}, 300000); // Toutes les 5 minutes

// Gestion des signaux système (AMÉLIORÉ)
process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt du bot...');
    try {
        if (botState.isReady) {
            await sendMessage(CONFIG.ADMIN_NUMBER, '🛑 Bot arrêté manuellement');
        }
        if (botState.server) botState.server.close();
        saveData();
        await client.destroy();
        process.exit(0);
    } catch (error) {
        console.error('❌ Erreur arrêt:', error.message);
        process.exit(1);
    }
});

process.on('uncaughtException', (error) => {
    console.error('❌ Erreur critique:', error.message);
    // Ne pas redémarrer automatiquement sur erreur critique
    if (error.message.includes('Session closed') || error.message.includes('Navigation failed')) {
        console.log('🔄 Tentative de récupération...');
        if (!botState.isReady) {
            attemptReconnect();
        }
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rejetée:', reason);
    // Ignorer certaines erreurs courantes
    if (reason && typeof reason === 'object' && reason.message) {
        if (reason.message.includes('Execution context was destroyed') ||
            reason.message.includes('Session closed') ||
            reason.message.includes('Target closed')) {
            console.log('⚠️ Erreur de session ignorée');
            return;
        }
    }
});

// Fonction de démarrage
async function startBot() {
    console.log('🚀 DÉMARRAGE BOT WHATSAPP 24/7');
    console.log('🤖 Version Optimisée - Gestion Appels/Médias');
    
    if (!loadData()) {
        console.error('❌ Erreur chargement données');
        process.exit(1);
    }
    
    const hasSession = fs.existsSync(CONFIG.SESSION_PATH) && fs.readdirSync(CONFIG.SESSION_PATH).length > 0;
    console.log(`🔐 Session: ${hasSession ? 'Trouvée' : 'Nouvelle'}`);
    
    try {
        await client.initialize();
        console.log('✅ Initialisation réussie');
    } catch (error) {
        console.error('❌ Erreur initialisation:', error.message);
        await attemptReconnect();
    }
}

// Lancement du bot
startBot().catch(error => {
    console.error('❌ Erreur fatale:', error.message);
    process.exit(1);
});
