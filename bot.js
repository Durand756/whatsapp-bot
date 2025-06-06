const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Configuration centralisée
const CONFIG = {
    ADMIN_NUMBER: '237679199601@c.us',
    DATA_FILE: path.join(__dirname, 'users_data.json'),
    USAGE_DURATION: 30 * 24 * 60 * 60 * 1000, // 30 jours
    SESSION_PATH: path.join(__dirname, '.wwebjs_auth'),
    PORT: 3000,
    CODE_EXPIRY: 24 * 60 * 60 * 1000, // 24h
    QR_TIMEOUT: 45000 // 45s
};

// État global simplifié
let state = {
    isReady: false,
    currentQR: null,
    server: null,
    userData: { users: {}, accessCodes: {}, groups: {} }
};

// Serveur Express minimal
const app = express();
app.get('/', (req, res) => {
    const html = state.currentQR ? generateQRPage() : generateSuccessPage();
    res.send(html);
});

function generateQRPage() {
    return `<!DOCTYPE html>
<html><head><title>WhatsApp Bot - QR Code</title><meta charset="utf-8">
<style>
body{font-family:Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;
background:linear-gradient(135deg,#25D366,#128C7E);color:white;margin:0;padding:20px}
.container{text-align:center;background:rgba(255,255,255,0.1);padding:30px;border-radius:20px;
backdrop-filter:blur(15px);box-shadow:0 10px 40px rgba(0,0,0,0.3)}
.qr{background:white;padding:20px;border-radius:15px;margin:20px auto;display:inline-block}
.qr img{max-width:280px;width:100%;height:auto}
.btn{background:#25D366;color:white;border:none;padding:12px 25px;border-radius:25px;
cursor:pointer;margin:10px;font-weight:bold}
.btn:hover{background:#128C7E}
</style></head><body>
<div class="container">
<h1>📱 Connexion WhatsApp</h1>
<div class="qr"><img src="data:image/png;base64,${state.currentQR}" alt="QR Code"/></div>
<p>Scannez le QR code avec WhatsApp</p>
<button class="btn" onclick="location.reload()">🔄 Actualiser</button>
</div>
<script>setTimeout(()=>location.reload(),45000)</script>
</body></html>`;
}

function generateSuccessPage() {
    return `<!DOCTYPE html>
<html><head><title>WhatsApp Bot - Connecté</title><meta charset="utf-8">
<style>body{font-family:Arial;display:flex;align-items:center;justify-content:center;
min-height:100vh;background:linear-gradient(135deg,#25D366,#128C7E);color:white;text-align:center}
.container{background:rgba(255,255,255,0.1);padding:40px;border-radius:20px;backdrop-filter:blur(15px)}
</style></head><body>
<div class="container"><h1>✅ Bot Connecté!</h1><p>Le bot est opérationnel</p></div>
<script>setTimeout(()=>window.close(),10000)</script>
</body></html>`;
}

// Utilitaires de données
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
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify({
            ...state.userData,
            lastSave: Date.now()
        }, null, 2));
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
    
    // Vérifier expiration
    if (Date.now() - accessData.generated > CONFIG.CODE_EXPIRY) {
        delete state.userData.accessCodes[phoneNumber];
        saveData();
        return false;
    }
    
    // Autoriser utilisateur
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
            console.log(`🌐 QR Code: http://localhost:${CONFIG.PORT}`);
        });
    }
}

function stopWebServer() {
    if (state.server) {
        state.server.close();
        state.server = null;
    }
}

// Client WhatsApp avec configuration optimisée
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-bot-optimized",
        dataPath: CONFIG.SESSION_PATH
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor'
        ]
    }
});

// Événements WhatsApp
client.on('qr', async (qr) => {
    try {
        console.log('🔄 Génération QR Code...');
        const qrBase64 = await QRCode.toDataURL(qr, { width: 300 });
        state.currentQR = qrBase64.split(',')[1];
        startWebServer();
        
        setTimeout(() => {
            state.currentQR = null;
        }, CONFIG.QR_TIMEOUT);
        
    } catch (error) {
        console.error('❌ Erreur QR:', error.message);
    }
});

client.on('ready', async () => {
    state.isReady = true;
    state.currentQR = null;
    setTimeout(stopWebServer, 2000);
    
    console.log('🎉 BOT CONNECTÉ AVEC SUCCÈS!');
    console.log(`📞 Admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`);
    console.log(`🕒 ${new Date().toLocaleString('fr-FR')}`);
    
    // Message de confirmation
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

// Traitement des messages - VERSION CORRIGÉE
client.on('message', async (message) => {
    // Vérifications de base
    if (!state.isReady || !message.body?.trim()) return;
    
    try {
        // Obtenir les informations du contact
        const contact = await message.getContact();
        if (!contact || contact.isMe) return;
        
        const userNumber = contact.id._serialized;
        const messageText = message.body.trim();
        
        // Traiter seulement les commandes
        if (!messageText.startsWith('/')) return;
        
        const command = messageText.toLowerCase();
        
        console.log(`📨 Message reçu de ${userNumber}: ${command}`);
        
        // Commandes administrateur
        if (userNumber === CONFIG.ADMIN_NUMBER) {
            await handleAdminCommand(message, command);
            return;
        }
        
        // Commande d'activation
        if (command.startsWith('/activate ')) {
            const code = messageText.substring(10).trim();
            if (!code) {
                await message.reply('❌ Format: `/activate XXXX XXXX`');
                return;
            }
            
            if (validateAccessCode(userNumber, code)) {
                const expiry = new Date(Date.now() + CONFIG.USAGE_DURATION).toLocaleDateString('fr-FR');
                await message.reply(`🎉 *ACCÈS ACTIVÉ*\n📅 Expire: ${expiry}\n\nCommandes:\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Mon statut`);
            } else {
                await message.reply('❌ Code invalide ou expiré');
            }
            return;
        }
        
        // Vérifier autorisation
        if (!isUserAuthorized(userNumber)) {
            await message.reply(`🔒 *Accès requis*\n\nContactez l'admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\nPuis: \`/activate CODE\``);
            return;
        }
        
        // Commandes utilisateur autorisé
        await handleUserCommand(message, command, userNumber);
        
    } catch (error) {
        console.error('❌ Erreur traitement message:', error.message);
        try {
            await message.reply('❌ Erreur interne');
        } catch (replyError) {
            console.error('❌ Erreur réponse:', replyError.message);
        }
    }
});

// Gestionnaire commandes admin
async function handleAdminCommand(message, command) {
    try {
        if (command.startsWith('/gencode ')) {
            const number = message.body.substring(9).trim();
            if (!number) {
                await message.reply('❌ Format: `/gencode [numéro]`');
                return;
            }
            
            const formattedNumber = number.includes('@') ? number : `${number}@c.us`;
            const code = generateAccessCode(formattedNumber);
            await message.reply(`✅ *CODE GÉNÉRÉ*\n👤 Pour: ${number}\n🔑 Code: \`${code}\`\n⏰ Valide 24h`);
            
        } else if (command === '/stats') {
            const stats = {
                users: Object.keys(state.userData.users).length,
                active: Object.values(state.userData.users).filter(u => u.authorized).length,
                codes: Object.keys(state.userData.accessCodes).length,
                groups: Object.keys(state.userData.groups).length
            };
            await message.reply(`📊 *STATS*\n👥 Utilisateurs: ${stats.users}\n✅ Actifs: ${stats.active}\n🔑 Codes: ${stats.codes}\n📢 Groupes: ${stats.groups}`);
            
        } else if (command === '/help') {
            await message.reply('🤖 *ADMIN*\n• /gencode [num] - Créer code\n• /stats - Statistiques\n• /help - Aide');
        }
    } catch (error) {
        console.error('❌ Erreur commande admin:', error.message);
        await message.reply('❌ Erreur commande admin');
    }
}

// Gestionnaire commandes utilisateur
async function handleUserCommand(message, command, userNumber) {
    try {
        if (command === '/status') {
            const user = state.userData.users[userNumber];
            const remaining = Math.ceil((user.authorizedAt + CONFIG.USAGE_DURATION - Date.now()) / (24 * 60 * 60 * 1000));
            const groupCount = Object.values(state.userData.groups).filter(g => g.addedBy === userNumber).length;
            
            await message.reply(`📊 *STATUT*\n🟢 Actif\n📅 ${remaining} jours restants\n📢 ${groupCount} groupes`);
            
        } else if (command === '/addgroup') {
            const chat = await message.getChat();
            if (!chat.isGroup) {
                await message.reply('❌ Commande pour groupes uniquement');
                return;
            }
            
            const groupId = chat.id._serialized;
            if (state.userData.groups[groupId]) {
                await message.reply('ℹ️ Groupe déjà enregistré');
            } else {
                state.userData.groups[groupId] = {
                    name: chat.name,
                    addedBy: userNumber,
                    addedAt: Date.now()
                };
                saveData();
                await message.reply(`✅ Groupe ajouté: ${chat.name}`);
            }
            
        } else if (command.startsWith('/broadcast ')) {
            const msg = message.body.substring(11).trim();
            if (!msg) {
                await message.reply('❌ Format: `/broadcast [message]`');
                return;
            }
            
            await handleBroadcast(message, msg, userNumber);
            
        } else if (command === '/help') {
            await message.reply('🤖 *COMMANDES*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /status - Mon statut\n• /help - Aide');
        }
    } catch (error) {
        console.error('❌ Erreur commande user:', error.message);
        await message.reply('❌ Erreur commande');
    }
}

// Fonction de diffusion optimisée
async function handleBroadcast(message, broadcastMessage, userNumber) {
    try {
        const userGroups = Object.entries(state.userData.groups)
            .filter(([, group]) => group.addedBy === userNumber);
        
        if (userGroups.length === 0) {
            await message.reply('❌ Aucun groupe. Utilisez `/addgroup` d\'abord');
            return;
        }
        
        await message.reply(`🚀 Diffusion vers ${userGroups.length} groupes...`);
        
        let success = 0, failed = 0;
        const contact = await message.getContact();
        
        for (const [groupId, groupInfo] of userGroups) {
            try {
                const fullMessage = `📢 *Message diffusé*\n👤 ${contact.pushname || 'Utilisateur'}\n📅 ${new Date().toLocaleString('fr-FR')}\n\n${broadcastMessage}`;
                await client.sendMessage(groupId, fullMessage);
                success++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                failed++;
                console.error(`❌ Erreur groupe ${groupId}:`, error.message);
            }
        }
        
        await message.reply(`📊 *RÉSULTAT*\n✅ Succès: ${success}\n❌ Échecs: ${failed}`);
        
    } catch (error) {
        console.error('❌ Erreur broadcast:', error.message);
        await message.reply('❌ Erreur de diffusion');
    }
}

// Gestion des erreurs
process.on('uncaughtException', (error) => {
    console.error('❌ Erreur non gérée:', error.message);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt du bot...');
    try {
        if (state.isReady) {
            await client.sendMessage(CONFIG.ADMIN_NUMBER, '🛑 Bot arrêté');
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
}, 5 * 60 * 1000);

// Démarrage
async function startBot() {
    console.log('🚀 DÉMARRAGE BOT WHATSAPP');
    
    if (!loadData()) {
        console.error('❌ Impossible de charger les données');
        process.exit(1);
    }
    
    const hasSession = fs.existsSync(CONFIG.SESSION_PATH) && 
                      fs.readdirSync(CONFIG.SESSION_PATH).length > 0;
    
    console.log(`🔐 Session: ${hasSession ? 'Existante' : 'Nouvelle'}`);
    
    await client.initialize();
}

console.log('🤖 WhatsApp Bot Optimisé v3.0');
startBot().catch(error => {
    console.error('❌ Erreur fatale:', error.message);
    process.exit(1);
});
