const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Configuration
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    DATA_FILE: path.join(__dirname, 'users_data.json'),
    USAGE_DURATION: 30 * 24 * 60 * 60 * 1000, // 30 jours
    SESSION_PATH: path.join(__dirname, '.wwebjs_auth'),
    PORT: 3000,
    CODE_EXPIRY: 24 * 60 * 60 * 1000, // 24h
    QR_TIMEOUT: 45000
};

// État global
let state = {
    isReady: false,
    currentQR: null,
    server: null,
    userData: { users: {}, accessCodes: {}, groups: {} },
    botMessages: new Set() // Pour tracker les messages du bot
};

// Serveur Express
const app = express();
app.get('/', (req, res) => {
    const html = state.isReady ? 
        `<!DOCTYPE html><html><head><title>Bot Connecté</title><style>
        body{font-family:Arial;text-align:center;margin-top:50px;background:#25D366;color:white}
        .container{background:rgba(255,255,255,0.1);padding:40px;border-radius:20px;display:inline-block}
        </style></head><body><div class="container"><h1>✅ Bot WhatsApp Connecté!</h1>
        <p>Le bot est opérationnel et prêt à recevoir des commandes.</p></div></body></html>` :
        
        (state.currentQR ? 
        `<!DOCTYPE html><html><head><title>QR Code</title><style>
        body{font-family:Arial;text-align:center;margin-top:50px;background:#25D366;color:white}
        .qr{background:white;padding:20px;border-radius:15px;margin:20px;display:inline-block}
        .btn{background:#128C7E;color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer}
        </style></head><body><h1>📱 Connexion WhatsApp</h1>
        <div class="qr"><img src="data:image/png;base64,${state.currentQR}" alt="QR Code"/></div>
        <p>Scannez avec WhatsApp</p><button class="btn" onclick="location.reload()">🔄 Actualiser</button>
        <script>setTimeout(()=>location.reload(),45000)</script></body></html>` :
        
        `<!DOCTYPE html><html><head><title>En attente</title></head><body style="text-align:center;margin-top:100px">
        <h1>🔄 Initialisation...</h1><p>Le bot se connecte...</p></body></html>`);
    res.send(html);
});

// Utilitaires
function loadData() {
    try {
        if (fs.existsSync(CONFIG.DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
            state.userData = { users: {}, accessCodes: {}, groups: {}, ...data };
        }
        return true;
    } catch (error) {
        console.error('❌ Erreur chargement:', error.message);
        return false;
    }
}

function saveData() {
    try {
        cleanupExpiredData();
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(state.userData, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde:', error.message);
        return false;
    }
}

function cleanupExpiredData() {
    const now = Date.now();
    
    // Nettoyer codes expirés
    Object.keys(state.userData.accessCodes).forEach(phone => {
        if (now - state.userData.accessCodes[phone].generated > CONFIG.CODE_EXPIRY) {
            delete state.userData.accessCodes[phone];
        }
    });
    
    // Nettoyer utilisateurs expirés
    Object.keys(state.userData.users).forEach(phone => {
        const user = state.userData.users[phone];
        if (user.authorized && (now - user.authorizedAt) >= CONFIG.USAGE_DURATION) {
            user.authorized = false;
        }
    });
}

function generateAccessCode(phoneNumber) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        if (i === 4) code += ' ';
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    state.userData.accessCodes[phoneNumber] = {
        code,
        generated: Date.now(),
        used: false
    };
    saveData();
    return code;
}

function isUserAuthorized(phoneNumber) {
    const user = state.userData.users[phoneNumber];
    if (!user?.authorized) return false;
    
    const isValid = (Date.now() - user.authorizedAt) < CONFIG.USAGE_DURATION;
    if (!isValid) {
        user.authorized = false;
        saveData();
    }
    return isValid;
}

function validateAccessCode(phoneNumber, inputCode) {
    const accessData = state.userData.accessCodes[phoneNumber];
    if (!accessData?.code || accessData.used) return false;
    
    const normalizedInput = inputCode.replace(/\s/g, '').toUpperCase();
    const normalizedStored = accessData.code.replace(/\s/g, '').toUpperCase();
    
    if (normalizedInput !== normalizedStored) return false;
    
    if (Date.now() - accessData.generated > CONFIG.CODE_EXPIRY) {
        delete state.userData.accessCodes[phoneNumber];
        saveData();
        return false;
    }
    
    accessData.used = true;
    state.userData.users[phoneNumber] = {
        authorized: true,
        authorizedAt: Date.now(),
        phoneNumber
    };
    saveData();
    return true;
}

function startWebServer() {
    if (!state.server) {
        state.server = app.listen(CONFIG.PORT, () => {
            console.log(`🌐 Interface: http://localhost:${CONFIG.PORT}`);
        });
    }
}

function stopWebServer() {
    if (state.server) {
        state.server.close();
        state.server = null;
    }
}

// Client WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-bot-v4",
        dataPath: CONFIG.SESSION_PATH
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

// Événements
client.on('qr', async (qr) => {
    if (state.isReady) return; // Ne pas générer de QR si déjà connecté
    
    try {
        console.log('🔄 Génération QR Code...');
        const qrBase64 = await QRCode.toDataURL(qr, { width: 300 });
        state.currentQR = qrBase64.split(',')[1];
        startWebServer();
        
        setTimeout(() => {
            if (!state.isReady) state.currentQR = null;
        }, CONFIG.QR_TIMEOUT);
        
    } catch (error) {
        console.error('❌ Erreur QR:', error.message);
    }
});

client.on('ready', async () => {
    state.isReady = true;
    state.currentQR = null;
    
    console.log('🎉 BOT CONNECTÉ!');
    console.log(`📞 Admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`);
    console.log(`🕒 ${new Date().toLocaleString('fr-FR')}`);
    
    // Démarrer le serveur pour l'interface de statut
    startWebServer();
    
    try {
        await client.sendMessage(CONFIG.ADMIN_NUMBER, 
            `🎉 *BOT CONNECTÉ*\n✅ Opérationnel\n🕒 ${new Date().toLocaleString('fr-FR')}`);
    } catch (error) {
        console.error('❌ Erreur message confirmation:', error.message);
    }
});

client.on('auth_failure', () => {
    console.error('❌ Échec authentification');
    if (fs.existsSync(CONFIG.SESSION_PATH)) {
        fs.rmSync(CONFIG.SESSION_PATH, { recursive: true, force: true });
    }
    process.exit(1);
});

client.on('disconnected', (reason) => {
    console.log('🔌 Déconnecté:', reason);
    state.isReady = false;
    
    if (reason === 'LOGOUT') {
        if (fs.existsSync(CONFIG.SESSION_PATH)) {
            fs.rmSync(CONFIG.SESSION_PATH, { recursive: true, force: true });
        }
        process.exit(0);
    }
});

// Traitement des messages
client.on('message', async (message) => {
    if (!state.isReady || !message.body?.trim()) return;
    
    try {
        const contact = await message.getContact();
        if (!contact) return;
        
        const userNumber = contact.id._serialized;
        const messageText = message.body.trim();
        
        // Vérifier si c'est un message du bot (éviter les boucles)
        if (contact.isMe || state.botMessages.has(message.id.id)) return;
        
        // Traiter seulement les commandes
        if (!messageText.startsWith('/')) return;
        
        const command = messageText.toLowerCase();
        console.log(`📨 ${userNumber}: ${command}`);
        
        // Commandes admin
        if (userNumber === CONFIG.ADMIN_NUMBER) {
            await handleAdminCommand(message, command);
            return;
        }
        
        // Commande d'activation
        if (command.startsWith('/activate ')) {
            const code = messageText.substring(10).trim();
            if (!code) {
                await sendReply(message, '❌ Format: `/activate XXXX XXXX`');
                return;
            }
            
            if (validateAccessCode(userNumber, code)) {
                const expiry = new Date(Date.now() + CONFIG.USAGE_DURATION).toLocaleDateString('fr-FR');
                await sendReply(message, `🎉 *ACCÈS ACTIVÉ*\n📅 Expire: ${expiry}\n\n*Commandes:*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Mon statut\n• /help - Aide`);
            } else {
                await sendReply(message, '❌ Code invalide ou expiré');
            }
            return;
        }
        
        // Vérifier autorisation
        if (!isUserAuthorized(userNumber)) {
            await sendReply(message, `🔒 *Accès requis*\n\nContactez l'admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\nPuis: \`/activate CODE\``);
            return;
        }
        
        // Commandes utilisateur
        await handleUserCommand(message, command, userNumber);
        
    } catch (error) {
        console.error('❌ Erreur traitement:', error.message);
        try {
            await sendReply(message, '❌ Erreur interne');
        } catch (e) {
            console.error('❌ Erreur réponse:', e.message);
        }
    }
});

// Fonction pour envoyer une réponse et tracker les messages du bot
async function sendReply(message, text) {
    try {
        const sentMessage = await message.reply(text);
        // Ajouter l'ID du message envoyé par le bot
        if (sentMessage && sentMessage.id) {
            state.botMessages.add(sentMessage.id.id);
        }
        return sentMessage;
    } catch (error) {
        console.error('❌ Erreur envoi réponse:', error.message);
        throw error;
    }
}

// Fonction pour envoyer un message et tracker
async function sendMessage(chatId, text) {
    try {
        const sentMessage = await client.sendMessage(chatId, text);
        if (sentMessage && sentMessage.id) {
            state.botMessages.add(sentMessage.id.id);
        }
        return sentMessage;
    } catch (error) {
        console.error('❌ Erreur envoi message:', error.message);
        throw error;
    }
}

// Gestionnaire admin
async function handleAdminCommand(message, command) {
    try {
        if (command.startsWith('/gencode ')) {
            const number = message.body.substring(9).trim();
            if (!number) {
                await sendReply(message, '❌ Format: `/gencode [numéro]`');
                return;
            }
            
            const formattedNumber = number.includes('@') ? number : `${number}@c.us`;
            const code = generateAccessCode(formattedNumber);
            await sendReply(message, `✅ *CODE GÉNÉRÉ*\n👤 Pour: ${number}\n🔑 Code: \`${code}\`\n⏰ Valide 24h`);
            
        } else if (command === '/stats') {
            const stats = {
                users: Object.keys(state.userData.users).length,
                active: Object.values(state.userData.users).filter(u => u.authorized).length,
                codes: Object.keys(state.userData.accessCodes).length,
                groups: Object.keys(state.userData.groups).length
            };
            await sendReply(message, `📊 *STATISTIQUES*\n👥 Utilisateurs: ${stats.users}\n✅ Actifs: ${stats.active}\n🔑 Codes: ${stats.codes}\n📢 Groupes: ${stats.groups}`);
            
        } else if (command === '/help') {
            await sendReply(message, '🤖 *COMMANDES ADMIN*\n• /gencode [num] - Créer code\n• /stats - Statistiques\n• /help - Cette aide');
        }
    } catch (error) {
        console.error('❌ Erreur admin:', error.message);
        await sendReply(message, '❌ Erreur commande admin');
    }
}

// Gestionnaire utilisateur
async function handleUserCommand(message, command, userNumber) {
    try {
        if (command === '/status') {
            const user = state.userData.users[userNumber];
            const remaining = Math.ceil((user.authorizedAt + CONFIG.USAGE_DURATION - Date.now()) / (24 * 60 * 60 * 1000));
            const groupCount = Object.values(state.userData.groups).filter(g => g.addedBy === userNumber).length;
            
            await sendReply(message, `📊 *MON STATUT*\n🟢 Actif\n📅 ${remaining} jours restants\n📢 ${groupCount} groupes enregistrés`);
            
        } else if (command === '/addgroup') {
            const chat = await message.getChat();
            if (!chat.isGroup) {
                await sendReply(message, '❌ Commande pour groupes uniquement');
                return;
            }
            
            const groupId = chat.id._serialized;
            if (state.userData.groups[groupId]) {
                await sendReply(message, 'ℹ️ Groupe déjà enregistré');
            } else {
                state.userData.groups[groupId] = {
                    name: chat.name,
                    addedBy: userNumber,
                    addedAt: Date.now()
                };
                saveData();
                await sendReply(message, `✅ Groupe ajouté: *${chat.name}*`);
            }
            
        } else if (command.startsWith('/broadcast ')) {
            const msg = message.body.substring(11).trim();
            if (!msg) {
                await sendReply(message, '❌ Format: `/broadcast [votre message]`');
                return;
            }
            
            await handleBroadcast(message, msg, userNumber);
            
        } else if (command === '/help') {
            await sendReply(message, '🤖 *COMMANDES DISPONIBLES*\n• /broadcast [msg] - Diffuser un message\n• /addgroup - Ajouter ce groupe\n• /status - Mon statut\n• /help - Cette aide');
        }
    } catch (error) {
        console.error('❌ Erreur utilisateur:', error.message);
        await sendReply(message, '❌ Erreur commande');
    }
}

// Fonction de diffusion
async function handleBroadcast(message, broadcastMessage, userNumber) {
    try {
        const userGroups = Object.entries(state.userData.groups)
            .filter(([, group]) => group.addedBy === userNumber);
        
        if (userGroups.length === 0) {
            await sendReply(message, '❌ Aucun groupe enregistré. Utilisez `/addgroup` d\'abord');
            return;
        }
        
        await sendReply(message, `🚀 Diffusion vers ${userGroups.length} groupes...`);
        
        let success = 0, failed = 0;
        const contact = await message.getContact();
        
        for (const [groupId, groupInfo] of userGroups) {
            try {
                const fullMessage = `📢 *Message diffusé*\n👤 De: ${contact.pushname || 'Utilisateur'}\n📅 ${new Date().toLocaleString('fr-FR')}\n\n${broadcastMessage}`;
                await sendMessage(groupId, fullMessage);
                success++;
                await new Promise(resolve => setTimeout(resolve, 1000)); // Délai entre envois
            } catch (error) {
                failed++;
                console.error(`❌ Erreur groupe ${groupId}:`, error.message);
            }
        }
        
        await sendReply(message, `📊 *RÉSULTAT DIFFUSION*\n✅ Succès: ${success}\n❌ Échecs: ${failed}`);
        
    } catch (error) {
        console.error('❌ Erreur broadcast:', error.message);
        await sendReply(message, '❌ Erreur de diffusion');
    }
}

// Nettoyage périodique des messages trackés (éviter la surcharge mémoire)
setInterval(() => {
    if (state.botMessages.size > 1000) {
        state.botMessages.clear();
    }
}, 60 * 60 * 1000); // Toutes les heures

// Gestion des erreurs
process.on('uncaughtException', (error) => {
    console.error('❌ Erreur critique:', error.message);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt du bot...');
    try {
        if (state.isReady) {
            await sendMessage(CONFIG.ADMIN_NUMBER, '🛑 Bot arrêté');
        }
        stopWebServer();
        saveData();
        process.exit(0);
    } catch (error) {
        process.exit(1);
    }
});

// Sauvegarde périodique
setInterval(() => {
    if (state.isReady) saveData();
}, 5 * 60 * 1000); // Toutes les 5 minutes

// Démarrage
async function startBot() {
    console.log('🚀 DÉMARRAGE BOT WHATSAPP v4.0');
    
    if (!loadData()) {
        console.error('❌ Impossible de charger les données');
        process.exit(1);
    }
    
    const hasSession = fs.existsSync(CONFIG.SESSION_PATH) && 
                      fs.readdirSync(CONFIG.SESSION_PATH).length > 0;
    
    console.log(`🔐 Session: ${hasSession ? 'Existante' : 'Nouvelle'}`);
    
    await client.initialize();
}

// Lancement
console.log('🤖 WhatsApp Bot Optimisé v4.0 - Version Compacte');
startBot().catch(error => {
    console.error('❌ Erreur fatale:', error.message);
    process.exit(1);
});
