const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Configuration
const ADMIN_NUMBER = '237679199601@c.us';
const DATA_FILE = path.join(__dirname, 'users_data.json');
const USAGE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 jours
const SESSION_PATH = path.join(__dirname, '.wwebjs_auth');

// Variables globales
let userData = {
    users: {},
    accessCodes: {},
    groups: {}
};

let isReady = false;
let hasValidSession = false;
let currentQR = null;
let qrExpireTimeout = null;

// Serveur Express pour afficher le QR code
const app = express();
const PORT = 3000;
let server = null;

// Page HTML pour le QR code
app.get('/', (req, res) => {
    if (currentQR) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot - Connexion</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        background: linear-gradient(135deg, #25D366, #128C7E);
                        color: white;
                        margin: 0;
                        padding: 20px;
                        box-sizing: border-box;
                    }
                    .container {
                        text-align: center;
                        background: rgba(255,255,255,0.1);
                        padding: 30px;
                        border-radius: 20px;
                        backdrop-filter: blur(15px);
                        box-shadow: 0 10px 40px rgba(0,0,0,0.3);
                        max-width: 500px;
                        width: 100%;
                    }
                    .qr-container {
                        background: white;
                        padding: 20px;
                        border-radius: 15px;
                        margin: 20px auto;
                        display: inline-block;
                        box-shadow: 0 5px 20px rgba(0,0,0,0.2);
                    }
                    .qr-container img {
                        max-width: 280px;
                        width: 100%;
                        height: auto;
                        display: block;
                    }
                    .instructions {
                        line-height: 1.6;
                        margin: 20px 0;
                    }
                    .step {
                        background: rgba(255,255,255,0.1);
                        padding: 12px;
                        border-radius: 10px;
                        margin: 8px 0;
                        border-left: 3px solid #25D366;
                    }
                    .warning {
                        background: rgba(255,193,7,0.2);
                        padding: 15px;
                        border-radius: 10px;
                        margin: 20px 0;
                        border-left: 4px solid #ffc107;
                        font-size: 14px;
                    }
                    .countdown {
                        font-size: 18px;
                        font-weight: bold;
                        color: #ffc107;
                        margin: 15px 0;
                    }
                    .refresh-btn {
                        background: #25D366;
                        color: white;
                        border: none;
                        padding: 12px 25px;
                        border-radius: 25px;
                        font-size: 14px;
                        cursor: pointer;
                        margin: 10px;
                        transition: all 0.3s;
                        font-weight: bold;
                    }
                    .refresh-btn:hover {
                        background: #128C7E;
                        transform: translateY(-2px);
                        box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                    }
                    .status {
                        background: rgba(37, 211, 102, 0.2);
                        padding: 10px;
                        border-radius: 10px;
                        margin: 15px 0;
                        font-size: 14px;
                    }
                    @media (max-width: 600px) {
                        .container { padding: 20px; margin: 10px; }
                        .qr-container img { max-width: 240px; }
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>📱 Connexion WhatsApp</h1>
                    
                    <div class="warning">
                        ⚠️ <strong>IMPORTANT:</strong> Cette connexion est nécessaire uniquement lors de la première utilisation ou après déconnexion.
                    </div>
                    
                    <div class="qr-container">
                        <img src="data:image/png;base64,${currentQR}" alt="QR Code WhatsApp" />
                    </div>
                    
                    <div class="countdown" id="countdown">QR Code expire dans 45 secondes</div>
                    
                    <div class="instructions">
                        <h3>📋 Instructions:</h3>
                        
                        <div class="step">
                            <strong>1.</strong> Ouvrez WhatsApp sur votre téléphone
                        </div>
                        
                        <div class="step">
                            <strong>2.</strong> Appuyez sur ⋮ (menu) → "Appareils liés"
                        </div>
                        
                        <div class="step">
                            <strong>3.</strong> Sélectionnez "Lier un appareil"
                        </div>
                        
                        <div class="step">
                            <strong>4.</strong> Scannez le QR code ci-dessus
                        </div>
                    </div>
                    
                    <div class="status">
                        🔄 Actualisation automatique toutes les 45 secondes
                    </div>
                    
                    <button class="refresh-btn" onclick="location.reload()">
                        🔄 Actualiser maintenant
                    </button>
                </div>
                
                <script>
                    let timeLeft = 45;
                    const countdownEl = document.getElementById('countdown');
                    
                    const timer = setInterval(() => {
                        timeLeft--;
                        countdownEl.textContent = \`QR Code expire dans \${timeLeft} secondes\`;
                        
                        if (timeLeft <= 0) {
                            clearInterval(timer);
                            location.reload();
                        }
                    }, 1000);
                </script>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot - État</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        background: linear-gradient(135deg, #25D366, #128C7E);
                        color: white;
                        margin: 0;
                        padding: 20px;
                    }
                    .container {
                        text-align: center;
                        background: rgba(255,255,255,0.1);
                        padding: 40px;
                        border-radius: 20px;
                        backdrop-filter: blur(15px);
                        box-shadow: 0 10px 40px rgba(0,0,0,0.3);
                    }
                    .status-icon { font-size: 64px; margin: 20px 0; }
                    .close-btn {
                        background: rgba(255,255,255,0.2);
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 15px;
                        cursor: pointer;
                        margin-top: 20px;
                        font-size: 14px;
                    }
                    .close-btn:hover {
                        background: rgba(255,255,255,0.3);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="status-icon">✅</div>
                    <h1>Bot WhatsApp Connecté!</h1>
                    <p>Le bot est maintenant opérationnel et connecté.</p>
                    <p style="font-size: 14px; opacity: 0.8;">
                        Plus besoin de QR code.<br>
                        Les prochaines connexions seront automatiques.
                    </p>
                    <button class="close-btn" onclick="window.close()">
                        Fermer cette page
                    </button>
                </div>
                
                <script>
                    // Fermer automatiquement après 10 secondes
                    setTimeout(() => {
                        window.close();
                    }, 10000);
                </script>
            </body>
            </html>
        `);
    }
});

// Démarrer le serveur web seulement quand nécessaire
function startWebServer() {
    if (!server) {
        server = app.listen(PORT, () => {
            console.log(`🌐 Interface QR Code: http://localhost:${PORT}`);
            console.log(`📱 Ouvrez cette URL pour scanner le QR code`);
        });
    }
}

// Arrêter le serveur web
function stopWebServer() {
    if (server) {
        server.close();
        server = null;
        console.log('🌐 Serveur web fermé');
    }
}

// Vérifier si une session existe
function checkExistingSession() {
    try {
        hasValidSession = fs.existsSync(SESSION_PATH) && fs.readdirSync(SESSION_PATH).length > 0;
        return hasValidSession;
    } catch (error) {
        console.error('❌ Erreur vérification session:', error.message);
        return false;
    }
}

// Fonctions utilitaires
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            if (data.trim()) {
                const parsed = JSON.parse(data);
                userData = { 
                    users: {},
                    accessCodes: {},
                    groups: {},
                    ...parsed 
                };
                console.log('✅ Données utilisateur chargées');
                return true;
            }
        }
        console.log('📝 Nouveau fichier de données créé');
        saveData();
        return true;
    } catch (error) {
        console.error('❌ Erreur chargement données:', error.message);
        return false;
    }
}

function saveData() {
    try {
        cleanupExpiredData();
        const dataToSave = {
            ...userData,
            lastSave: Date.now()
        };
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde:', error.message);
        return false;
    }
}

function cleanupExpiredData() {
    const now = Date.now();
    let cleaned = false;
    
    // Nettoyer codes d'accès expirés (24h)
    Object.keys(userData.accessCodes).forEach(phone => {
        const codeData = userData.accessCodes[phone];
        if (now - codeData.generated > 24 * 60 * 60 * 1000) {
            delete userData.accessCodes[phone];
            cleaned = true;
        }
    });
    
    // Nettoyer utilisateurs expirés
    Object.keys(userData.users).forEach(phone => {
        const user = userData.users[phone];
        if (user.authorized && (now - user.authorizedAt) >= USAGE_DURATION) {
            user.authorized = false;
            cleaned = true;
        }
    });
    
    if (cleaned) {
        console.log('🧹 Données expirées nettoyées');
    }
}

function generateAccessCode(phoneNumber) {
    // Format: XXXX XXXX (8 caractères au total)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        if (i === 4) code += ' '; // Espace au milieu
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
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
        return false;
    }
    
    return isValid;
}

function validateAccessCode(phoneNumber, inputCode) {
    const accessData = userData.accessCodes[phoneNumber];
    if (!accessData || accessData.used) {
        return false;
    }
    
    // Normaliser les codes (supprimer espaces et mettre en majuscules)
    const normalizedInput = inputCode.replace(/\s/g, '').toUpperCase();
    const normalizedStored = accessData.code.replace(/\s/g, '').toUpperCase();
    
    if (normalizedInput !== normalizedStored) {
        return false;
    }
    
    // Vérifier expiration (24h)
    const now = Date.now();
    if (now - accessData.generated > 24 * 60 * 60 * 1000) {
        delete userData.accessCodes[phoneNumber];
        saveData();
        return false;
    }
    
    // Marquer comme utilisé et autoriser l'utilisateur
    accessData.used = true;
    userData.users[phoneNumber] = {
        authorized: true,
        authorizedAt: Date.now(),
        phoneNumber: phoneNumber
    };
    
    saveData();
    return true;
}

function formatPhoneNumber(number) {
    // Supprimer tous les caractères non numériques sauf le +
    let cleaned = number.replace(/[^\d+]/g, '');
    
    // Si commence par +, garder le +
    if (number.startsWith('+')) {
        cleaned = '+' + cleaned.substring(1);
    }
    
    // Ajouter @c.us si pas déjà présent
    if (!cleaned.includes('@')) {
        cleaned += '@c.us';
    }
    
    return cleaned;
}

// Configuration client WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-bot-v2",
        dataPath: SESSION_PATH
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--no-first-run',
            '--disable-gpu',
            '--disable-features=VizDisplayCompositor',
            '--disable-extensions'
        ],
        timeout: 60000
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

// Gestion des événements WhatsApp
client.on('qr', async (qr) => {
    console.log('\n🔄 Génération du QR Code...');
    
    try {
        // Générer le QR code en base64
        const qrBase64 = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            quality: 0.92,
            margin: 2,
            width: 300,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });
        
        currentQR = qrBase64.split(',')[1]; // Enlever le préfixe
        
        // Démarrer le serveur web pour afficher le QR
        startWebServer();
        
        console.log('\n📱 QR CODE GÉNÉRÉ');
        console.log('═══════════════════════════════');
        console.log(`🌐 Interface: http://localhost:${PORT}`);
        console.log('⏰ QR Code expire dans 45 secondes');
        console.log('🔄 Actualisation automatique');
        
        // Expirer le QR code après 45 secondes
        if (qrExpireTimeout) {
            clearTimeout(qrExpireTimeout);
        }
        
        qrExpireTimeout = setTimeout(() => {
            currentQR = null;
            console.log('⏰ QR Code expiré - Nouveau QR en cours...');
        }, 45000);
        
    } catch (error) {
        console.error('❌ Erreur génération QR:', error.message);
    }
});

client.on('ready', async () => {
    isReady = true;
    currentQR = null;
    
    // Arrêter le serveur web
    setTimeout(stopWebServer, 2000);
    
    console.log('\n🎉 BOT WHATSAPP CONNECTÉ AVEC SUCCÈS!');
    console.log('═══════════════════════════════════════');
    
    if (!hasValidSession) {
        console.log('✅ PREMIÈRE CONNEXION RÉUSSIE');
        console.log('🔒 Session sauvegardée pour les prochaines fois');
    } else {
        console.log('🚀 RECONNEXION AUTOMATIQUE');
    }
    
    console.log(`📞 Admin: ${ADMIN_NUMBER.replace('@c.us', '')}`);
    console.log(`🕒 Connecté: ${new Date().toLocaleString('fr-FR')}`);
    console.log('✅ Bot opérationnel');
    
    hasValidSession = true;
    
    // Envoyer un message de confirmation à soi-même
    try {
        const selfMessage = `🎉 *BOT CONNECTÉ*\n\n✅ Status: Opérationnel\n🕒 Heure: ${new Date().toLocaleString('fr-FR')}\n🔒 Session: ${hasValidSession ? 'Permanente' : 'Temporaire'}\n\n🤖 Le bot est prêt à recevoir des commandes!`;
        
        await client.sendMessage(ADMIN_NUMBER, selfMessage);
        console.log('📩 Message de confirmation envoyé');
    } catch (error) {
        console.error('❌ Erreur envoi message confirmation:', error.message);
    }
});

client.on('authenticated', () => {
    console.log('🔐 Session authentifiée avec succès');
});

client.on('auth_failure', (msg) => {
    console.error('\n❌ ÉCHEC AUTHENTIFICATION:', msg);
    
    // Nettoyer session corrompue
    if (fs.existsSync(SESSION_PATH)) {
        try {
            fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            console.log('🗑️ Session corrompue supprimée');
        } catch (error) {
            console.error('❌ Erreur suppression session:', error.message);
        }
    }
    
    console.log('🔄 REDÉMARREZ LE BOT pour reconnecter');
    stopWebServer();
    process.exit(1);
});

client.on('disconnected', (reason) => {
    console.log('\n🔌 Déconnecté:', reason);
    isReady = false;
    currentQR = null;
    
    if (reason === 'LOGOUT') {
        console.log('📱 Déconnexion manuelle depuis WhatsApp');
        if (fs.existsSync(SESSION_PATH)) {
            try {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
                console.log('🗑️ Session supprimée');
            } catch (error) {
                console.error('❌ Erreur suppression session:', error.message);
            }
        }
        stopWebServer();
        process.exit(0);
    }
    
    // Reconnexion automatique
    console.log('🔄 Reconnexion dans 15 secondes...');
    setTimeout(() => {
        console.log('🔄 Tentative de reconnexion...');
        client.initialize().catch(error => {
            console.error('❌ Erreur reconnexion:', error.message);
        });
    }, 15000);
});

// Traitement des messages
client.on('message', async (message) => {
    if (!isReady) return;
    
    try {
        const contact = await message.getContact();
        const userNumber = contact.id._serialized;
        const messageText = message.body.trim();
        const chat = await message.getChat();
        
        // Ignorer ses propres messages
        if (contact.isMe) return;
        
        // Traiter seulement les commandes (messages commençant par /)
        if (!messageText.startsWith('/')) return;
        
        const command = messageText.toLowerCase();
        
        // Commandes administrateur
        if (userNumber === ADMIN_NUMBER) {
            await handleAdminCommands(message, command, contact);
            return;
        }
        
        // Commande d'activation
        if (command.startsWith('/activate ')) {
            const codeInput = messageText.substring(10).trim();
            if (!codeInput) {
                await message.reply('❌ *Usage incorrect*\n\n📝 Format: `/activate XXXX XXXX`\n💡 Utilisez le code reçu de l\'admin');
                return;
            }
            
            if (validateAccessCode(userNumber, codeInput)) {
                const expiryDate = new Date(Date.now() + USAGE_DURATION).toLocaleDateString('fr-FR');
                await message.reply(`🎉 *ACCÈS ACTIVÉ AVEC SUCCÈS!*\n\n✅ *Statut:* Autorisé\n📅 *Expire le:* ${expiryDate}\n⏰ *Durée:* 30 jours\n\n📋 *Commandes disponibles:*\n• \`/broadcast [message]\` - Diffuser\n• \`/addgroup\` - Ajouter groupe\n• \`/mygroups\` - Mes groupes\n• \`/status\` - Mon statut\n• \`/help\` - Aide\n\n🚀 *Vous pouvez maintenant utiliser le bot!*`);
            } else {
                await message.reply('❌ *Code invalide*\n\n🔍 *Raisons possibles:*\n• Code incorrect\n• Code déjà utilisé\n• Code expiré (24h)\n\n💬 Contactez l\'admin pour un nouveau code');
            }
            return;
        }
        
        // Vérifier autorisation pour les autres commandes
        if (!isUserAuthorized(userNumber)) {
            await message.reply('🔒 *Accès requis*\n\n❌ Vous n\'êtes pas autorisé à utiliser ce bot\n\n🔑 *Pour activer:*\n1. Contactez l\'administrateur\n2. Utilisez: `/activate XXXX XXXX`\n\n📞 *Admin:* ' + ADMIN_NUMBER.replace('@c.us', ''));
            return;
        }
        
        // Commandes utilisateur autorisé
        await handleUserCommands(message, command, userNumber, contact, chat);
        
    } catch (error) {
        console.error('❌ Erreur traitement message:', error.message);
        await message.reply('❌ *Erreur interne*\n\nUne erreur s\'est produite. Réessayez plus tard.');
    }
});

// Gestion des commandes administrateur
async function handleAdminCommands(message, command, contact) {
    try {
        if (command.startsWith('/gencode ')) {
            const targetNumber = message.body.substring(9).trim();
            if (!targetNumber) {
                await message.reply('❌ *Usage incorrect*\n\n📝 Format: `/gencode [numéro]`\n💡 Exemple: `/gencode 237679199601`');
                return;
            }
            
            const formattedNumber = formatPhoneNumber(targetNumber);
            const code = generateAccessCode(formattedNumber);
            
            await message.reply(`✅ *CODE GÉNÉRÉ AVEC SUCCÈS*\n\n👤 *Pour:* ${targetNumber}\n🔑 *Code:* \`${code}\`\n⏰ *Valide:* 24 heures\n📅 *Généré:* ${new Date().toLocaleString('fr-FR')}\n\n📝 *Instructions pour l'utilisateur:*\nUtiliser: \`/activate ${code}\``);
            
        } else if (command === '/stats') {
            await sendAdminStats(message);
            
        } else if (command === '/listusers') {
            await sendUsersList(message);
            
        } else if (command.startsWith('/revoke ')) {
            const targetNumber = message.body.substring(8).trim();
            const formattedNumber = formatPhoneNumber(targetNumber);
            
            if (userData.users[formattedNumber]) {
                userData.users[formattedNumber].authorized = false;
                saveData();
                await message.reply(`✅ *ACCÈS RÉVOQUÉ*\n\n👤 Utilisateur: ${targetNumber}\n🚫 Accès supprimé`);
            } else {
                await message.reply(`❌ Utilisateur non trouvé: ${targetNumber}`);
            }
            
        } else if (command === '/cleanup') {
            cleanupExpiredData();
            await message.reply('🧹 *NETTOYAGE EFFECTUÉ*\n\n✅ Données expirées supprimées');
            
        } else if (command === '/reset') {
            if (fs.existsSync(SESSION_PATH)) {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
                await message.reply('🔄 *SESSION RÉINITIALISÉE*\n\n⚠️ Redémarrage requis pour reconnecter');
                setTimeout(() => process.exit(0), 2000);
            } else {
                await message.reply('❌ Aucune session à réinitialiser');
            }
            
        } else if (command === '/help') {
            await message.reply(`🤖 *COMMANDES ADMINISTRATEUR*\n\n🔑 \`/gencode [numéro]\` - Générer code\n📊 \`/stats\` - Statistiques\n👥 \`/listusers\` - Liste utilisateurs\n🚫 \`/revoke [numéro]\` - Révoquer accès\n🧹 \`/cleanup\` - Nettoyer données\n🔄 \`/reset\` - Reset session\n❓ \`/help\` - Cette aide`);
        }
        
    } catch (error) {
        console.error('❌ Erreur commande admin:', error.message);
        await message.reply('❌ Erreur lors de l\'exécution de la commande');
    }
}

// Gestion des commandes utilisateur
async function handleUserCommands(message, command, userNumber, contact, chat) {
    try {
        switch (command) {
            case '/status':
                await sendUserStatus(message, userNumber);
                break;
                
            case '/addgroup':
                if (!chat.isGroup) {
                    await message.reply('❌ *Commande pour groupes uniquement*\n\n💡 Utilisez cette commande dans un groupe WhatsApp');
                    return;
                }
                
                const groupId = chat.id._serialized;
                if (userData.groups[groupId]) {
                    await message.reply(`ℹ️ *Groupe déjà enregistré*\n\n📝 Nom: ${chat.name}\n👤 Ajouté par: ${userData.groups[groupId].addedBy === userNumber ? 'Vous' : 'Autre utilisateur'}`);
                } else {
                    userData.groups[groupId] = {
                        name: chat.name,
                        addedBy: userNumber,
                        addedAt: Date.now()
                    };
                    saveData();
                    await message.reply(`✅ *Groupe ajouté avec succès!*\n\n📝 *Nom:* ${chat.name}\n📅 *Ajouté le:* ${new Date().toLocaleDateString('fr-FR')}\n\n🚀 Vous pouvez maintenant diffuser des messages dans ce groupe!`);
                }
                break;
                
            case '/mygroups':
                await sendUserGroups(message, userNumber);
                break;
                
            case '/help':
                await message.reply(`🤖 *COMMANDES UTILISATEUR*\n\n📢 \`/broadcast [message]\` - Diffuser message\n➕ \` - Ajouter groupe\n📋 \`/mygroups\` - Mes groupes\n📊 \`/status\` - Mon statut\n❓ \`/help\` - Cette aide\n\n💡 *Exemple broadcast:*\n\`/broadcast Bonjour tout le monde!\``);
                break;
                
            default:
                if (command.startsWith('/broadcast ')) {
                    const broadcastMessage = message.body.substring(11).trim();
                    if (!broadcastMessage) {
                        await message.reply('❌ *Message vide*\n\n📝 Format: `/broadcast [votre message]`\n💡 Exemple: `/broadcast Bonjour à tous!`');
                        return;
                    }
                    
                    await handleBroadcast(message, broadcastMessage, userNumber, contact);
                } else {
                    await message.reply('❌ *Commande inconnue*\n\n📋 Utilisez `/help` pour voir les commandes disponibles');
                }
                break;
        }
        
    } catch (error) {
        console.error('❌ Erreur commande utilisateur:', error.message);
        await message.reply('❌ Erreur lors de l\'exécution de la commande');
    }
}

// Fonction de diffusion
async function handleBroadcast(message, broadcastMessage, userNumber, contact) {
    try {
        const userGroups = Object.keys(userData.groups).filter(groupId => 
            userData.groups[groupId].addedBy === userNumber
        );
        
        if (userGroups.length === 0) {
            await message.reply('❌ *Aucun groupe enregistré*\n\n➕ Utilisez `/addgroup` dans vos groupes d\'abord\n📋 Puis `/mygroups` pour voir la liste');
            return;
        }
        
        let successCount = 0;
        let failCount = 0;
        const results = [];
        
        // Message de début de diffusion
        await message.reply(`🚀 *DIFFUSION EN COURS...*\n\n📊 Groupes cibles: ${userGroups.length}\n⏳ Veuillez patienter...`);
        
        // Diffuser dans chaque groupe
        for (const groupId of userGroups) {
            try {
                const groupInfo = userData.groups[groupId];
                const fullMessage = `📢 *Message diffusé*\n👤 *De:* ${contact.pushname || contact.number}\n📅 *Le:* ${new Date().toLocaleString('fr-FR')}\n\n${broadcastMessage}`;
                
                await client.sendMessage(groupId, fullMessage);
                successCount++;
                results.push(`✅ ${groupInfo.name}`);
                
                // Délai entre envois pour éviter spam
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`❌ Erreur diffusion groupe ${groupId}:`, error.message);
                failCount++;
                results.push(`❌ ${userData.groups[groupId]?.name || 'Groupe inconnu'}`);
            }
        }
        
        // Rapport final
        const reportMessage = `📊 *RAPPORT DE DIFFUSION*\n\n✅ *Succès:* ${successCount}\n❌ *Échecs:* ${failCount}\n📈 *Total:* ${userGroups.length}\n\n📋 *Détails:*\n${results.join('\n')}\n\n📅 *Terminé le:* ${new Date().toLocaleString('fr-FR')}`;
        
        await message.reply(reportMessage);
        
    } catch (error) {
        console.error('❌ Erreur broadcast:', error.message);
        await message.reply('❌ *Erreur de diffusion*\n\nUne erreur s\'est produite pendant la diffusion');
    }
}

// Envoyer les statistiques admin
async function sendAdminStats(message) {
    try {
        const totalUsers = Object.keys(userData.users).length;
        const activeUsers = Object.values(userData.users).filter(user => user.authorized).length;
        const pendingCodes = Object.keys(userData.accessCodes).length;
        const totalGroups = Object.keys(userData.groups).length;
        
        const statsMessage = `📊 *STATISTIQUES DU BOT*\n\n👥 *Utilisateurs:*\n• Total: ${totalUsers}\n• Actifs: ${activeUsers}\n• Inactifs: ${totalUsers - activeUsers}\n\n🔑 *Codes d'accès:*\n• En attente: ${pendingCodes}\n\n📢 *Groupes:*\n• Enregistrés: ${totalGroups}\n\n📅 *Mis à jour:* ${new Date().toLocaleString('fr-FR')}\n🟢 *Statut:* Opérationnel`;
        
        await message.reply(statsMessage);
        
    } catch (error) {
        console.error('❌ Erreur stats:', error.message);
        await message.reply('❌ Erreur lors de la récupération des statistiques');
    }
}

// Envoyer la liste des utilisateurs
async function sendUsersList(message) {
    try {
        const users = Object.values(userData.users);
        if (users.length === 0) {
            await message.reply('📋 *LISTE UTILISATEURS*\n\n❌ Aucun utilisateur enregistré');
            return;
        }
        
        let usersList = '📋 *LISTE DES UTILISATEURS*\n\n';
        users.forEach((user, index) => {
            const phone = user.phoneNumber.replace('@c.us', '');
            const status = user.authorized ? '🟢 Actif' : '🔴 Inactif';
            const expiry = user.authorized ? 
                new Date(user.authorizedAt + USAGE_DURATION).toLocaleDateString('fr-FR') : 
                'N/A';
            
            usersList += `*${index + 1}.* ${phone}\n${status} | Expire: ${expiry}\n\n`;
        });
        
        await message.reply(usersList);
        
    } catch (error) {
        console.error('❌ Erreur liste utilisateurs:', error.message);
        await message.reply('❌ Erreur lors de la récupération de la liste');
    }
}

// Envoyer le statut utilisateur
async function sendUserStatus(message, userNumber) {
    try {
        const user = userData.users[userNumber];
        if (!user) {
            await message.reply('❌ *Aucune données utilisateur*\n\nVous n\'êtes pas encore enregistré dans le système');
            return;
        }
        
        const phone = userNumber.replace('@c.us', '');
        const isActive = user.authorized;
        const authorizedDate = user.authorizedAt ? 
            new Date(user.authorizedAt).toLocaleString('fr-FR') : 'N/A';
        const expiryDate = user.authorized ? 
            new Date(user.authorizedAt + USAGE_DURATION).toLocaleString('fr-FR') : 'N/A';
        
        const remainingTime = user.authorized ? 
            Math.max(0, Math.ceil((user.authorizedAt + USAGE_DURATION - Date.now()) / (24 * 60 * 60 * 1000))) : 0;
        
        const userGroups = Object.keys(userData.groups).filter(groupId => 
            userData.groups[groupId].addedBy === userNumber
        ).length;
        
        const statusMessage = `📊 *VOTRE STATUT*\n\n👤 *Téléphone:* ${phone}\n🔐 *Statut:* ${isActive ? '🟢 Actif' : '🔴 Inactif'}\n📅 *Autorisé le:* ${authorizedDate}\n⏰ *Expire le:* ${expiryDate}\n📆 *Jours restants:* ${remainingTime}\n📢 *Groupes:* ${userGroups}\n\n📅 *Vérifié le:* ${new Date().toLocaleString('fr-FR')}`;
        
        await message.reply(statusMessage);
        
    } catch (error) {
        console.error('❌ Erreur statut utilisateur:', error.message);
        await message.reply('❌ Erreur lors de la récupération du statut');
    }
}

// Envoyer les groupes de l'utilisateur
async function sendUserGroups(message, userNumber) {
    try {
        const userGroups = Object.entries(userData.groups).filter(([groupId, groupData]) => 
            groupData.addedBy === userNumber
        );
        
        if (userGroups.length === 0) {
            await message.reply('📋 *MES GROUPES*\n\n❌ Aucun groupe enregistré\n\n💡 Utilisez `/addgroup` dans un groupe pour l\'ajouter');
            return;
        }
        
        let groupsList = `📋 *MES GROUPES* (${userGroups.length})\n\n`;
        userGroups.forEach(([groupId, groupData], index) => {
            const addedDate = new Date(groupData.addedAt).toLocaleDateString('fr-FR');
            groupsList += `*${index + 1}.* ${groupData.name}\n📅 Ajouté: ${addedDate}\n\n`;
        });
        
        groupsList += `💡 *Total:* ${userGroups.length} groupe(s)\n🚀 Utilisez \`/broadcast [message]\` pour diffuser`;
        
        await message.reply(groupsList);
        
    } catch (error) {
        console.error('❌ Erreur groupes utilisateur:', error.message);
        await message.reply('❌ Erreur lors de la récupération des groupes');
    }
}

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
    console.error('❌ Erreur non gérée:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesse rejetée:', reason);
});

// Gestion de l'arrêt propre
process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt du bot...');
    
    try {
        if (isReady) {
            await client.sendMessage(ADMIN_NUMBER, '🛑 *BOT ARRÊTÉ*\n\n📅 Arrêt: ' + new Date().toLocaleString('fr-FR'));
        }
        
        if (client) {
            await client.logout();
        }
        
        stopWebServer();
        saveData();
        
        console.log('✅ Arrêt propre effectué');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Erreur lors de l\'arrêt:', error.message);
        process.exit(1);
    }
});

// Sauvegarde périodique des données
setInterval(() => {
    if (isReady) {
        saveData();
        console.log('💾 Sauvegarde automatique effectuée');
    }
}, 5 * 60 * 1000); // Toutes les 5 minutes

// Démarrage du bot
async function startBot() {
    console.log('🚀 DÉMARRAGE DU BOT WHATSAPP');
    console.log('═══════════════════════════════════');
    
    try {
        // Charger les données
        if (!loadData()) {
            console.error('❌ Impossible de charger les données');
            process.exit(1);
        }
        
        // Vérifier session existante
        const hasSession = checkExistingSession();
        console.log(`🔐 Session existante: ${hasSession ? 'OUI' : 'NON'}`);
        
        if (hasSession) {
            console.log('🔄 Tentative de connexion automatique...');
        } else {
            console.log('📱 Première connexion - QR Code requis');
        }
        
        // Initialiser le client
        await client.initialize();
        
    } catch (error) {
        console.error('❌ Erreur démarrage:', error.message);
        stopWebServer();
        process.exit(1);
    }
}

// Lancer le bot
console.log('🤖 WhatsApp Bot v2.0');
console.log('Made with ❤️ for broadcasting');
console.log('');

startBot().catch(error => {
    console.error('❌ Erreur fatale:', error.message);
    process.exit(1);
});
