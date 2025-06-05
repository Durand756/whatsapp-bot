const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // Ajouter cette dépendance
const fs = require('fs');
const path = require('path');
const express = require('express'); // Ajouter cette dépendance

// Configuration
const ADMIN_NUMBER = '237679199601@c.us';
const DATA_FILE = path.join(__dirname, 'users_data.json');
const USAGE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 jours
const SESSION_PATH = path.join(__dirname, '.wwebjs_auth');
const QR_IMAGE_PATH = path.join(__dirname, 'qr-code.png');

// Variables globales
let userData = {
    users: {},
    accessCodes: {},
    groups: {}
};

let isReady = false;
let hasValidSession = false;
let currentQR = null;

// Serveur Express pour afficher le QR code
const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
    if (currentQR) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot - QR Code</title>
                <meta charset="utf-8">
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        background: linear-gradient(135deg, #25D366, #128C7E);
                        color: white;
                        margin: 0;
                    }
                    .container {
                        text-align: center;
                        background: rgba(255,255,255,0.1);
                        padding: 40px;
                        border-radius: 20px;
                        backdrop-filter: blur(10px);
                        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                    }
                    .qr-container {
                        background: white;
                        padding: 20px;
                        border-radius: 15px;
                        margin: 20px 0;
                        display: inline-block;
                    }
                    img {
                        max-width: 300px;
                        height: auto;
                    }
                    .instructions {
                        max-width: 500px;
                        line-height: 1.6;
                        margin-top: 20px;
                    }
                    .step {
                        background: rgba(255,255,255,0.1);
                        padding: 10px;
                        border-radius: 10px;
                        margin: 10px 0;
                    }
                    .warning {
                        background: rgba(255,193,7,0.3);
                        padding: 15px;
                        border-radius: 10px;
                        margin: 20px 0;
                        border-left: 4px solid #ffc107;
                    }
                    .refresh-btn {
                        background: #25D366;
                        color: white;
                        border: none;
                        padding: 15px 30px;
                        border-radius: 25px;
                        font-size: 16px;
                        cursor: pointer;
                        margin-top: 20px;
                        transition: all 0.3s;
                    }
                    .refresh-btn:hover {
                        background: #128C7E;
                        transform: scale(1.05);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🚀 WhatsApp Bot - Première Connexion</h1>
                    
                    <div class="warning">
                        ⚠️ <strong>IMPORTANT:</strong> Cette étape n'est nécessaire qu'UNE SEULE FOIS!<br>
                        Après ça, le bot se connectera automatiquement.
                    </div>
                    
                    <div class="qr-container">
                        <img src="data:image/png;base64,${currentQR}" alt="QR Code WhatsApp" />
                    </div>
                    
                    <div class="instructions">
                        <h3>📱 Instructions:</h3>
                        
                        <div class="step">
                            <strong>1.</strong> Ouvrez WhatsApp sur votre téléphone
                        </div>
                        
                        <div class="step">
                            <strong>2.</strong> Appuyez sur les 3 points (menu) en haut à droite
                        </div>
                        
                        <div class="step">
                            <strong>3.</strong> Sélectionnez "Appareils liés"
                        </div>
                        
                        <div class="step">
                            <strong>4.</strong> Appuyez sur "Lier un appareil"
                        </div>
                        
                        <div class="step">
                            <strong>5.</strong> Scannez le QR code ci-dessus avec votre téléphone
                        </div>
                    </div>
                    
                    <button class="refresh-btn" onclick="location.reload()">
                        🔄 Actualiser le QR Code
                    </button>
                    
                    <p style="margin-top: 30px; font-size: 14px; opacity: 0.8;">
                        Une fois connecté, cette page ne sera plus nécessaire.<br>
                        Le bot se connectera automatiquement à chaque démarrage.
                    </p>
                </div>
                
                <script>
                    // Auto-refresh toutes les 30 secondes
                    setTimeout(() => {
                        location.reload();
                    }, 30000);
                </script>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot</title>
                <meta charset="utf-8">
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        background: linear-gradient(135deg, #25D366, #128C7E);
                        color: white;
                        margin: 0;
                    }
                    .container {
                        text-align: center;
                        background: rgba(255,255,255,0.1);
                        padding: 40px;
                        border-radius: 20px;
                        backdrop-filter: blur(10px);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎉 WhatsApp Bot Connecté!</h1>
                    <p>Le bot est maintenant opérationnel.<br>Plus besoin de QR code.</p>
                    <p style="font-size: 14px; opacity: 0.8;">Vous pouvez fermer cette page.</p>
                </div>
            </body>
            </html>
        `);
    }
});

// Démarrer le serveur web
function startWebServer() {
    app.listen(PORT, () => {
        console.log(`🌐 Serveur web démarré: http://localhost:${PORT}`);
        console.log(`📱 Ouvrez cette URL dans votre navigateur pour scanner le QR code`);
    });
}

// Vérifier si une session existe
function checkExistingSession() {
    hasValidSession = fs.existsSync(SESSION_PATH) && fs.readdirSync(SESSION_PATH).length > 0;
    return hasValidSession;
}

// Fonctions utilitaires (identiques)
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
                console.log('✅ Données chargées avec succès');
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
        console.log('💾 Données sauvegardées');
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde:', error.message);
        return false;
    }
}

function cleanupExpiredData() {
    const now = Date.now();
    
    // Nettoyer codes d'accès expirés (24h)
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

// Configuration client
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-persistent-bot",
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
            '--disable-features=VizDisplayCompositor'
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
    console.log('\n' + '⚠️'.repeat(50));
    console.log('PREMIÈRE CONNEXION REQUISE - QR CODE GÉNÉRÉ');
    console.log('⚠️'.repeat(50));
    
    try {
        // Générer le QR code en base64 pour le web
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
        
        // Stocker le QR code
        currentQR = qrBase64.split(',')[1]; // Enlever le préfixe data:image/png;base64,
        
        // Sauvegarder aussi en fichier
        await QRCode.toFile(QR_IMAGE_PATH, qr, {
            errorCorrectionLevel: 'M',
            width: 400,
            margin: 2
        });
        
        console.log('\n🌐 MÉTHODES POUR SCANNER LE QR CODE:');
        console.log('════════════════════════════════════');
        console.log(`1. 🖥️  Navigateur: http://localhost:${PORT}`);
        console.log(`2. 📁 Fichier: ${QR_IMAGE_PATH}`);
        console.log('3. 📱 Console (ci-dessous):\n');
        
        // Afficher dans la console avec de meilleures options
        qrcode.generate(qr, { 
            small: false,  // QR code plus grand
            errorCorrectionLevel: 'M'
        });
        
        console.log('\n════════════════════════════════════');
        console.log('📱 INSTRUCTIONS DÉTAILLÉES:');
        console.log('1. Ouvrez WhatsApp sur votre téléphone');
        console.log('2. Menu (⋮) → Appareils liés');
        console.log('3. "Lier un appareil"');
        console.log('4. Scannez avec une des méthodes ci-dessus');
        console.log('\n🎯 APRÈS ÇA: Plus jamais de QR code!');
        console.log('🚀 Connexions futures: 100% automatiques\n');
        
    } catch (error) {
        console.error('❌ Erreur génération QR:', error.message);
        
        // Fallback: affichage console seulement
        console.log('\n📱 QR CODE (Console seulement):');
        qrcode.generate(qr, { small: false });
    }
});

client.on('ready', () => {
    isReady = true;
    currentQR = null; // Effacer le QR code
    
    console.log('\n' + '🎉'.repeat(50));
    console.log('BOT WHATSAPP CONNECTÉ AVEC SUCCÈS!');
    console.log('🎉'.repeat(50));
    
    if (!hasValidSession) {
        console.log('✅ SESSION SAUVEGARDÉE - PREMIÈRE CONNEXION RÉUSSIE!');
        console.log('🚀 PROCHAINS DÉMARRAGES: CONNEXION AUTOMATIQUE!');
        
        // Supprimer le fichier QR code
        if (fs.existsSync(QR_IMAGE_PATH)) {
            fs.unlinkSync(QR_IMAGE_PATH);
        }
    } else {
        console.log('🚀 CONNEXION AUTOMATIQUE RÉUSSIE!');
        console.log('📱 Aucun QR code nécessaire!');
    }
    
    console.log(`📞 Admin: ${ADMIN_NUMBER.replace('@c.us', '')}`);
    console.log(`🕒 Connecté: ${new Date().toLocaleString('fr-FR')}`);
    console.log('✅ Bot opérationnel et prêt à recevoir des messages');
    console.log('🎉'.repeat(50) + '\n');
    
    hasValidSession = true;
});

client.on('authenticated', (session) => {
    console.log('🔐 Session authentifiée et sauvegardée avec succès');
    console.log('🎯 Connexions futures: Automatiques garanties!');
});

client.on('auth_failure', (msg) => {
    console.error('\n❌ ÉCHEC D\'AUTHENTIFICATION:', msg);
    console.log('🔧 SOLUTION: Nettoyage de la session corrompue...');
    
    // Supprimer session corrompue
    if (fs.existsSync(SESSION_PATH)) {
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        console.log('🗑️ Session corrompue supprimée');
    }
    if (fs.existsSync(QR_IMAGE_PATH)) {
        fs.unlinkSync(QR_IMAGE_PATH);
    }
    
    console.log('🔄 REDÉMARREZ LE BOT pour générer un nouveau QR code');
    process.exit(1);
});

client.on('disconnected', (reason) => {
    console.log('\n🔌 Déconnecté:', reason);
    isReady = false;
    currentQR = null;
    
    if (reason === 'LOGOUT') {
        console.log('📱 Déconnexion manuelle depuis WhatsApp');
        console.log('🔄 Nettoyage de la session...');
        if (fs.existsSync(SESSION_PATH)) {
            fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        }
        if (fs.existsSync(QR_IMAGE_PATH)) {
            fs.unlinkSync(QR_IMAGE_PATH);
        }
        console.log('🔄 REDÉMARREZ LE BOT pour reconnecter');
        process.exit(0);
    }
    
    // Reconnexion automatique pour autres raisons
    console.log('🔄 Tentative de reconnexion automatique dans 15s...');
    setTimeout(() => {
        client.initialize();
    }, 15000);
});

// Traitement des messages (identique au code original)
client.on('message', async (message) => {
    if (!isReady) return;
    
    try {
        const contact = await message.getContact();
        const userNumber = contact.id._serialized;
        const messageText = message.body.toLowerCase().trim();
        const chat = await message.getChat();
        
        if (contact.isMe) return;
        
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
                await message.reply(`🎉 *ACCÈS ACTIVÉ!*\n\n✅ Durée: 30 jours\n📅 Expire: ${expiryDate}\n\n📋 Commandes:\n• /broadcast [msg]\n• /addgroup\n• /mygroups\n• /status\n• /help`);
            } else {
                await message.reply('❌ Code invalide ou expiré');
            }
            return;
        }
        
        // Vérifier autorisation
        if (!isUserAuthorized(userNumber)) {
            if (messageText.startsWith('/')) {
                await message.reply('🔒 Accès requis. Contactez l\'admin.\nUsage: /activate [CODE]');
            }
            return;
        }
        
        // Commandes utilisateur
        await handleUserCommands(message, messageText, userNumber, contact, chat);
        
    } catch (error) {
        console.error('❌ Erreur traitement message:', error.message);
    }
});

// Toutes les autres fonctions restent identiques...
async function handleAdminCommands(message, messageText, contact) {
    switch (true) {
        case messageText.startsWith('/gencode '):
            const targetNumber = messageText.split(' ')[1];
            if (!targetNumber) {
                await message.reply('❌ Usage: /gencode [numéro]');
                return;
            }
            const formattedNumber = targetNumber.includes('@') ? targetNumber : `${targetNumber}@c.us`;
            const code = generateAccessCode(formattedNumber);
            await message.reply(`✅ *CODE GÉNÉRÉ*\n\n👤 Pour: ${targetNumber}\n🔑 Code: *${code}*\n⏰ Valide 24h`);
            break;
            
        case messageText === '/stats':
            await sendStats(message);
            break;
            
        case messageText === '/reset':
            if (fs.existsSync(SESSION_PATH)) {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
                await message.reply('🔄 Session réinitialisée. Redémarrage requis.');
                process.exit(0);
            }
            break;
            
        case messageText === '/help':
            await message.reply(`🤖 *ADMIN*\n\n🔑 /gencode [numéro]\n📊 /stats\n🔄 /reset\n❓ /help`);
            break;
    }
}

async function handleUserCommands(message, messageText, userNumber, contact, chat) {
    switch (messageText) {
        case '/status':
            await sendUserStatus(message, userNumber);
            break;
            
        case '/addgroup':
            if (!chat.isGroup) {
                await message.reply('❌ Commande pour groupes uniquement');
                return;
            }
            
            const groupId = chat.id._serialized;
            userData.groups[groupId] = {
                name: chat.name,
                addedBy: userNumber,
                addedAt: Date.now()
            };
            saveData();
            await message.reply(`✅ Groupe "${chat.name}" ajouté!`);
            break;
            
        case '/mygroups':
            await sendUserGroups(message, userNumber);
            break;
            
        case '/help':
            await message.reply(`🤖 *COMMANDES*\n\n📢 /broadcast [msg]\n➕ /addgroup\n📋 /mygroups\n📊 /status\n❓ /help`);
            break;
    }
    
    if (messageText.startsWith('/broadcast ')) {
        await handleBroadcast(message, messageText, userNumber, contact);
    }
}

async function sendStats(message) {
    const activeUsers = Object.values(userData.users).filter(user => 
        user.authorized && (Date.now() - user.authorizedAt) < USAGE_DURATION
    ).length;
    
    const totalUsers = Object.keys(userData.users).length;
    const totalGroups = Object.keys(userData.groups).length;
    const pendingCodes = Object.keys(userData.accessCodes).filter(phone => 
        !userData.accessCodes[phone].used
    ).length;
    
    await message.reply(`📊 *STATS*\n\n👥 Actifs: ${activeUsers}\n👤 Total: ${totalUsers}\n💬 Groupes: ${totalGroups}\n🔑 Codes: ${pendingCodes}\n🚀 Session: ${hasValidSession ? '✅ Permanente' : '❌ Temporaire'}`);
}

async function sendUserStatus(message, userNumber) {
    const user = userData.users[userNumber];
    const timeLeft = USAGE_DURATION - (Date.now() - user.authorizedAt);
    const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
    const userGroups = Object.keys(userData.groups).filter(g => 
        userData.groups[g].addedBy === userNumber
    ).length;
    
    await message.reply(`📊 *STATUT*\n\n✅ Autorisé\n⏰ ${daysLeft} jours\n💬 ${userGroups} groupes\n📅 Expire: ${new Date(user.authorizedAt + USAGE_DURATION).toLocaleDateString('fr-FR')}`);
}

async function sendUserGroups(message, userNumber) {
    const myGroups = Object.entries(userData.groups)
        .filter(([_, groupData]) => groupData.addedBy === userNumber)
        .map(([_, groupData]) => `• ${groupData.name}`)
        .join('\n');
    
    if (myGroups) {
        const groupCount = myGroups.split('\n').length;
        await message.reply(`📋 *GROUPES (${groupCount})*\n\n${myGroups}`);
    } else {
        await message.reply('📭 Aucun groupe\n\n💡 /addgroup dans un groupe');
    }
}

async function handleBroadcast(message, messageText, userNumber, contact) {
    const broadcastMessage = message.body.substring(11);
    if (!broadcastMessage.trim()) {
        await message.reply('❌ Message vide');
        return;
    }
    
    const userGroups = Object.entries(userData.groups)
        .filter(([_, groupData]) => groupData.addedBy === userNumber);
    
    if (userGroups.length === 0) {
        await message.reply('📭 Aucun groupe configuré');
        return;
    }
    
    await message.reply(`🚀 Diffusion vers ${userGroups.length} groupes...`);
    
    let successCount = 0;
    
    for (const [groupId, groupData] of userGroups) {
        try {
            const formattedMessage = `📢 *Message Diffusé*\n\n${broadcastMessage}\n\n_👤 ${contact.pushname || 'Utilisateur'}_\n_🕒 ${new Date().toLocaleString('fr-FR')}_`;
            
            await client.sendMessage(groupId, formattedMessage);
            successCount++;
            await new Promise(resolve => setTimeout(resolve, 3000));
            
        } catch (error) {
            console.error(`❌ Erreur groupe ${groupData.name}:`, error.message);
        }
    }
    
    await message.reply(`📊 *RÉSULTAT*\n\n✅ Envoyé à ${successCount}/${userGroups.length} groupes\n🕒 ${new Date().toLocaleTimeString('fr-FR')}`);
}

// Démarrage
console.log('\n🚀 BOT WHATSAPP - QR CODE AMÉLIORÉ');
console.log('=======================================');

// Vérifier session existante
if (checkExistingSession()) {
    console.log('✅ SESSION TROUVÉE - Connexion automatique!');
    console.log('📱 Aucun QR code requis');
} else {
    console.log('⚠️  PREMIÈRE CONNEXION - QR code requis');
    console.log('🌐 Serveur web pour QR code démarré');
    startWebServer();
}

if (!loadData()) {
    console.error('❌ Erreur chargement données');
    process.exit(1);
}

setInterval(cleanupExpiredData, 60 * 60 * 1000);

console.log('🔄 Initialisation du client WhatsApp...');
client.initialize().catch(error => {
    console.error('❌ Erreur initialisation:', error.message);
    process.exit(1);
});

// Arrêt propre
process.on('SIGINT', () => {
    console.log('\n🛑 Arrêt du bot...');
    saveData();
    if (fs.existsSync(QR_IMAGE_PATH)) {
        fs.unlinkSync(QR_IMAGE_PATH);
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    saveData();
    if (fs.existsSync(QR_IMAGE_PATH)) {
        fs.unlinkSync(QR_IMAGE_PATH);
    }
    process.exit(0);
});
