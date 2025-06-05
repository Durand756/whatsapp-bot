const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Configuration optimisée pour Render
const ADMIN_NUMBER = '237679199601@c.us';
const DATA_FILE = path.join(__dirname, 'users_data.json');
const USAGE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 jours
const SESSION_PATH = path.join(__dirname, '.wwebjs_auth');
const QR_IMAGE_PATH = path.join(__dirname, 'qr-code.png');
const PORT = process.env.PORT || 3000;

// Variables globales
let userData = { users: {}, accessCodes: {}, groups: {} };
let isReady = false;
let currentQR = null;
let client = null;

// Serveur Express pour l'hébergement Render
const app = express();

app.get('/', (req, res) => {
    if (currentQR && !isReady) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot - QR Code</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 20px; 
                           background: linear-gradient(135deg, #25D366, #128C7E); color: white; }
                    .container { max-width: 600px; margin: 0 auto; background: rgba(255,255,255,0.1); 
                                padding: 30px; border-radius: 15px; }
                    .qr-container { background: white; padding: 20px; border-radius: 10px; 
                                   margin: 20px 0; display: inline-block; }
                    img { max-width: 300px; height: auto; }
                    .btn { background: #25D366; color: white; border: none; padding: 12px 24px; 
                          border-radius: 20px; cursor: pointer; margin: 10px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🚀 WhatsApp Bot - Connexion</h1>
                    <div class="qr-container">
                        <img src="data:image/png;base64,${currentQR}" alt="QR Code WhatsApp" />
                    </div>
                    <p><strong>Scannez avec WhatsApp:</strong><br>
                    Menu (⋮) → Appareils liés → Lier un appareil</p>
                    <button class="btn" onclick="location.reload()">🔄 Actualiser</button>
                </div>
                <script>setTimeout(() => location.reload(), 30000);</script>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <div style="text-align:center; padding:50px; font-family:Arial;">
                <h1>🎉 WhatsApp Bot ${isReady ? 'Connecté' : 'En cours de connexion'}</h1>
                <p>Bot opérationnel sur render.com</p>
            </div>
        `);
    }
});

// Endpoint de santé pour Render
app.get('/health', (req, res) => {
    res.json({ 
        status: isReady ? 'connected' : 'connecting',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Démarrer le serveur (obligatoire pour Render)
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Serveur démarré sur port ${PORT}`);
});

// Fonctions utilitaires
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            if (data.trim()) {
                userData = { users: {}, accessCodes: {}, groups: {}, ...JSON.parse(data) };
                console.log('✅ Données chargées');
                return true;
            }
        }
        saveData();
        return true;
    } catch (error) {
        console.error('❌ Erreur chargement:', error.message);
        return false;
    }
}

function saveData() {
    try {
        cleanupExpiredData();
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            ...userData,
            lastSave: Date.now()
        }, null, 2));
        console.log('💾 Données sauvegardées');
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde:', error.message);
        return false;
    }
}

function cleanupExpiredData() {
    const now = Date.now();
    Object.keys(userData.accessCodes).forEach(phone => {
        const codeData = userData.accessCodes[phone];
        if (now - codeData.generated > 24 * 60 * 60 * 1000) {
            delete userData.accessCodes[phone];
        }
    });
}

function generateAccessCode(phoneNumber) {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    userData.accessCodes[phoneNumber] = {
        code: code,
        generated: Date.now(),
        used: false
    };
    saveData();
    return code;
}

function isUserAuthorized(phoneNumber) {
    const user = userData.users[phoneNumber];
    if (!user || !user.authorized) return false;
    
    const now = Date.now();
    const isValid = (now - user.authorizedAt) < USAGE_DURATION;
    
    if (!isValid && user.authorized) {
        user.authorized = false;
        saveData();
    }
    
    return isValid;
}

function validateAccessCode(phoneNumber, code) {
    const accessData = userData.accessCodes[phoneNumber];
    if (!accessData || accessData.used || accessData.code !== code.toUpperCase()) {
        return false;
    }
    
    accessData.used = true;
    userData.users[phoneNumber] = {
        authorized: true,
        authorizedAt: Date.now(),
        phoneNumber: phoneNumber
    };
    
    saveData();
    return true;
}

// Configuration client optimisée pour Render
function initializeClient() {
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "whatsapp-render-bot",
            dataPath: SESSION_PATH
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--no-first-run',
                '--disable-gpu',
                '--single-process' // Important pour Render
            ],
            timeout: 60000
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    });

    // Gestion des événements
    client.on('qr', async (qr) => {
        console.log('📱 QR Code généré');
        try {
            const qrBase64 = await QRCode.toDataURL(qr, {
                errorCorrectionLevel: 'M',
                width: 300,
                margin: 2
            });
            currentQR = qrBase64.split(',')[1];
            
            console.log(`🌐 QR Code disponible: http://localhost:${PORT}`);
            qrcode.generate(qr, { small: true });
        } catch (error) {
            console.error('❌ Erreur QR:', error.message);
            qrcode.generate(qr, { small: true });
        }
    });

    client.on('ready', async () => {
        isReady = true;
        currentQR = null;
        console.log('🎉 Bot connecté avec succès!');
        
        try {
            const info = client.info;
            console.log(`🤖 Bot: ${info.pushname || 'WhatsApp Bot'}`);
            console.log(`📱 Numéro: ${info.wid._serialized.replace('@c.us', '')}`);
            
            // Message de bienvenue à l'admin
            await client.sendMessage(ADMIN_NUMBER, 
                `🎉 *BOT RENDER CONNECTÉ!*\n\n` +
                `✅ Hébergé sur Render\n` +
                `🕒 ${new Date().toLocaleString('fr-FR')}\n\n` +
                `📋 Commandes admin:\n` +
                `• /gencode [numéro]\n` +
                `• /stats\n` +
                `• /help`
            );
        } catch (error) {
            console.log('⚠️ Impossible d\'envoyer message de bienvenue');
        }
    });

    client.on('authenticated', () => {
        console.log('🔐 Session authentifiée');
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Échec authentification:', msg);
        if (fs.existsSync(SESSION_PATH)) {
            fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        }
        setTimeout(() => {
            console.log('🔄 Redémarrage du client...');
            initializeClient();
        }, 5000);
    });

    client.on('disconnected', (reason) => {
        console.log('🔌 Déconnecté:', reason);
        isReady = false;
        currentQR = null;
        
        if (reason === 'LOGOUT') {
            if (fs.existsSync(SESSION_PATH)) {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            }
        }
        
        // Reconnexion automatique
        setTimeout(() => {
            console.log('🔄 Reconnexion...');
            initializeClient();
        }, 10000);
    });

    // CORRECTION MAJEURE: Gestion des messages
    client.on('message', async (message) => {
        if (!isReady) return;
        
        try {
            // Ignorer les messages système et du bot
            if (message.from === 'status@broadcast' || 
                message.type === 'e2e_notification' || 
                message.type === 'notification_template') {
                return;
            }

            const contact = await message.getContact();
            const userNumber = contact.id._serialized;
            const messageText = message.body?.toLowerCase()?.trim() || '';
            
            // Ignorer les messages du bot lui-même
            if (contact.isMe) return;
            
            console.log(`📨 Message de ${contact.pushname || userNumber}: ${message.body}`);
            
            // Commandes administrateur
            if (userNumber === ADMIN_NUMBER) {
                await handleAdminCommands(message, messageText, contact);
                return;
            }
            
            // Activation utilisateur
            if (messageText.startsWith('/activate ')) {
                const code = messageText.split(' ')[1]?.toUpperCase();
                if (!code) {
                    await message.reply('❌ Usage: /activate [CODE]');
                    return;
                }
                
                if (validateAccessCode(userNumber, code)) {
                    const expiryDate = new Date(Date.now() + USAGE_DURATION).toLocaleDateString('fr-FR');
                    await message.reply(
                        `🎉 *ACCÈS ACTIVÉ!*\n\n` +
                        `✅ Durée: 30 jours\n` +
                        `📅 Expire: ${expiryDate}\n\n` +
                        `📋 Commandes:\n` +
                        `• /broadcast [msg]\n` +
                        `• /addgroup\n` +
                        `• /mygroups\n` +
                        `• /status\n` +
                        `• /help`
                    );
                } else {
                    await message.reply('❌ Code invalide ou expiré');
                }
                return;
            }
            
            // Vérifier autorisation pour autres commandes
            if (!isUserAuthorized(userNumber)) {
                if (messageText.startsWith('/')) {
                    await message.reply('🔒 Accès requis. Contactez l\'admin.\nUsage: /activate [CODE]');
                }
                return;
            }
            
            // Commandes utilisateur autorisé
            await handleUserCommands(message, messageText, userNumber, contact);
            
        } catch (error) {
            console.error('❌ Erreur traitement message:', error.message);
            try {
                await message.reply('❌ Erreur interne. Réessayez.');
            } catch (replyError) {
                console.error('❌ Erreur réponse:', replyError.message);
            }
        }
    });

    // Initialisation
    client.initialize().catch(error => {
        console.error('❌ Erreur initialisation:', error.message);
        setTimeout(() => initializeClient(), 5000);
    });
}

// Gestion des commandes admin
async function handleAdminCommands(message, messageText, contact) {
    try {
        if (messageText.startsWith('/gencode ')) {
            const targetNumber = messageText.split(' ')[1];
            if (!targetNumber) {
                await message.reply('❌ Usage: /gencode [numéro]');
                return;
            }
            const formattedNumber = targetNumber.includes('@') ? targetNumber : `${targetNumber}@c.us`;
            const code = generateAccessCode(formattedNumber);
            await message.reply(`✅ *CODE GÉNÉRÉ*\n\n👤 Pour: ${targetNumber}\n🔑 Code: *${code}*\n⏰ Valide 24h`);
        
        } else if (messageText === '/stats') {
            const activeUsers = Object.values(userData.users).filter(user => 
                user.authorized && (Date.now() - user.authorizedAt) < USAGE_DURATION
            ).length;
            
            const totalUsers = Object.keys(userData.users).length;
            const totalGroups = Object.keys(userData.groups).length;
            const pendingCodes = Object.keys(userData.accessCodes).filter(phone => 
                !userData.accessCodes[phone].used
            ).length;
            
            await message.reply(
                `📊 *STATISTIQUES*\n\n` +
                `👥 Utilisateurs actifs: ${activeUsers}\n` +
                `👤 Total utilisateurs: ${totalUsers}\n` +
                `💬 Groupes: ${totalGroups}\n` +
                `🔑 Codes en attente: ${pendingCodes}\n` +
                `🚀 Hébergé sur: Render\n` +
                `⏰ Uptime: ${Math.floor(process.uptime() / 60)}min`
            );
        
        } else if (messageText === '/help') {
            await message.reply(
                `🤖 *COMMANDES ADMIN*\n\n` +
                `🔑 /gencode [numéro] - Générer code d'accès\n` +
                `📊 /stats - Statistiques\n` +
                `❓ /help - Cette aide`
            );
        }
    } catch (error) {
        console.error('❌ Erreur commande admin:', error.message);
        await message.reply('❌ Erreur lors de l\'exécution de la commande');
    }
}

// Gestion des commandes utilisateur
async function handleUserCommands(message, messageText, userNumber, contact) {
    try {
        const chat = await message.getChat();
        
        if (messageText === '/status') {
            const user = userData.users[userNumber];
            const timeLeft = USAGE_DURATION - (Date.now() - user.authorizedAt);
            const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
            const userGroups = Object.keys(userData.groups).filter(g => 
                userData.groups[g].addedBy === userNumber
            ).length;
            
            await message.reply(
                `📊 *VOTRE STATUT*\n\n` +
                `✅ Statut: Autorisé\n` +
                `⏰ Temps restant: ${daysLeft} jours\n` +
                `💬 Vos groupes: ${userGroups}\n` +
                `📅 Expire le: ${new Date(user.authorizedAt + USAGE_DURATION).toLocaleDateString('fr-FR')}`
            );
        
        } else if (messageText === '/addgroup') {
            if (!chat.isGroup) {
                await message.reply('❌ Cette commande fonctionne uniquement dans les groupes');
                return;
            }
            
            const groupId = chat.id._serialized;
            userData.groups[groupId] = {
                name: chat.name,
                addedBy: userNumber,
                addedAt: Date.now()
            };
            saveData();
            await message.reply(`✅ Groupe "${chat.name}" ajouté à votre liste!`);
        
        } else if (messageText === '/mygroups') {
            const myGroups = Object.entries(userData.groups)
                .filter(([_, groupData]) => groupData.addedBy === userNumber)
                .map(([_, groupData]) => `• ${groupData.name}`)
                .join('\n');
            
            if (myGroups) {
                const groupCount = myGroups.split('\n').length;
                await message.reply(`📋 *VOS GROUPES (${groupCount})*\n\n${myGroups}`);
            } else {
                await message.reply('📭 Aucun groupe enregistré\n\n💡 Utilisez /addgroup dans un groupe');
            }
        
        } else if (messageText === '/help') {
            await message.reply(
                `🤖 *COMMANDES DISPONIBLES*\n\n` +
                `📢 /broadcast [message] - Diffuser un message\n` +
                `➕ /addgroup - Ajouter ce groupe\n` +
                `📋 /mygroups - Voir vos groupes\n` +
                `📊 /status - Votre statut\n` +
                `❓ /help - Cette aide`
            );
        
        } else if (messageText.startsWith('/broadcast ')) {
            const broadcastMessage = message.body.substring(11);
            if (!broadcastMessage.trim()) {
                await message.reply('❌ Message vide\n\nUsage: /broadcast [votre message]');
                return;
            }
            
            const userGroups = Object.entries(userData.groups)
                .filter(([_, groupData]) => groupData.addedBy === userNumber);
            
            if (userGroups.length === 0) {
                await message.reply('📭 Aucun groupe configuré\n\n💡 Utilisez /addgroup dans vos groupes');
                return;
            }
            
            await message.reply(`🚀 Diffusion en cours vers ${userGroups.length} groupe(s)...`);
            
            let successCount = 0;
            
            for (const [groupId, groupData] of userGroups) {
                try {
                    const formattedMessage = 
                        `📢 *MESSAGE DIFFUSÉ*\n\n` +
                        `${broadcastMessage}\n\n` +
                        `_👤 ${contact.pushname || 'Utilisateur'}_\n` +
                        `_🕒 ${new Date().toLocaleString('fr-FR')}_`;
                    
                    await client.sendMessage(groupId, formattedMessage);
                    successCount++;
                    
                    // Délai entre envois pour éviter le spam
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                } catch (error) {
                    console.error(`❌ Erreur envoi groupe ${groupData.name}:`, error.message);
                }
            }
            
            await message.reply(
                `📊 *RÉSULTAT DE LA DIFFUSION*\n\n` +
                `✅ Envoyé avec succès: ${successCount}\n` +
                `❌ Échecs: ${userGroups.length - successCount}\n` +
                `🕒 ${new Date().toLocaleTimeString('fr-FR')}`
            );
        }
    } catch (error) {
        console.error('❌ Erreur commande utilisateur:', error.message);
        await message.reply('❌ Erreur lors de l\'exécution de la commande');
    }
}

// Démarrage du bot
console.log('🚀 WHATSAPP BOT - VERSION RENDER');
console.log('================================');

if (!loadData()) {
    console.error('❌ Erreur critique chargement données');
    process.exit(1);
}

// Nettoyage périodique des données expirées
setInterval(cleanupExpiredData, 60 * 60 * 1000); // Chaque heure

// Initialisation du client
initializeClient();

// Arrêt propre
process.on('SIGINT', () => {
    console.log('🛑 Arrêt du bot...');
    saveData();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Arrêt par Render...');
    saveData();
    process.exit(0);
});

// Keep-alive pour Render (éviter l'endormissement)
setInterval(() => {
    console.log(`💓 Bot actif - ${new Date().toLocaleTimeString()}`);
}, 5 * 60 * 1000); // Toutes les 5 minutes
