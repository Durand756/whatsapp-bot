const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Configuration simplifiée et stable
const ADMIN_NUMBER = '237651104356@c.us';
const DATA_FILE = path.join(__dirname, 'users_data.json');
const USAGE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 jours
const MAX_RETRY_ATTEMPTS = 3;

// Variables globales
let userData = {
    users: {},
    accessCodes: {},
    groups: {}
};

let isReady = false;
let retryCount = 0;

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

// Configuration client CORRIGÉE pour la stabilité
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-bot-v2"
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
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ],
        timeout: 60000 // Réduit à 1 minute
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

// Gestion des événements de connexion
client.on('qr', (qr) => {
    console.log('\n' + '='.repeat(50));
    console.log('🔗 SCAN CE QR CODE AVEC WHATSAPP');
    console.log('='.repeat(50));
    
    qrcode.generate(qr, { small: true });
    
    console.log('\n📱 Instructions:');
    console.log('1. Ouvrez WhatsApp sur votre téléphone');
    console.log('2. Allez dans Menu (⋮) → Appareils liés');
    console.log('3. Appuyez sur "Lier un appareil"');
    console.log('4. Scannez le QR code ci-dessus');
    console.log('\n⏱️  En attente de la connexion...\n');
});

client.on('ready', () => {
    isReady = true;
    retryCount = 0;
    
    console.log('\n' + '🎉'.repeat(20));
    console.log('🚀 BOT WHATSAPP CONNECTÉ AVEC SUCCÈS!');
    console.log('🎉'.repeat(20));
    console.log(`📞 Admin: ${ADMIN_NUMBER.replace('@c.us', '')}`);
    console.log(`🕒 Connecté le: ${new Date().toLocaleString('fr-FR')}`);
    console.log('✅ Toutes les fonctionnalités sont opérationnelles');
    console.log('🎉'.repeat(20) + '\n');
});

client.on('authenticated', () => {
    console.log('🔐 Authentification réussie - Session sauvegardée');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Échec authentification:', msg);
    console.log('🗑️ Suppression des données d\'authentification corrompues...');
    
    // Supprimer le dossier d'authentification corrompu
    const authPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log('🗑️ Dossier d\'authentification supprimé');
    }
    
    handleReconnection('auth_failure');
});

client.on('disconnected', (reason) => {
    console.log('🔌 Déconnecté:', reason);
    isReady = false;
    
    // Ne pas redémarrer automatiquement pour certaines raisons
    if (reason === 'NAVIGATION' || reason === 'LOGOUT') {
        console.log('📱 Déconnexion manuelle - Redémarrage nécessaire');
        return;
    }
    
    handleReconnection(reason);
});

// Gestion des erreurs de session
client.on('loading_screen', (percent, message) => {
    console.log('⏳ Chargement:', percent + '%', message);
});

// Système de reconnexion amélioré
function handleReconnection(reason) {
    if (retryCount >= MAX_RETRY_ATTEMPTS) {
        console.error('❌ Trop de tentatives échouées. Redémarrez manuellement le bot.');
        process.exit(1);
    }
    
    retryCount++;
    const waitTime = Math.min(30 * retryCount, 120); // Augmente le délai à chaque tentative
    
    console.log(`🔄 Reconnexion ${retryCount}/${MAX_RETRY_ATTEMPTS} dans ${waitTime}s...`);
    
    setTimeout(() => {
        console.log('🚀 Tentative de reconnexion...');
        client.initialize().catch(error => {
            console.error('❌ Erreur reconnexion:', error.message);
        });
    }, waitTime * 1000);
}

// Traitement des messages
client.on('message', async (message) => {
    if (!isReady) return;
    
    try {
        const contact = await message.getContact();
        const userNumber = contact.id._serialized;
        const messageText = message.body.toLowerCase().trim();
        const chat = await message.getChat();
        
        // Éviter les boucles de messages du bot
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
                await message.reply('❌ Usage: /activate [CODE]\n\nExemple: /activate ABC123');
                return;
            }
            
            if (validateAccessCode(userNumber, code)) {
                const expiryDate = new Date(Date.now() + USAGE_DURATION).toLocaleDateString('fr-FR');
                await message.reply(`🎉 *ACCÈS ACTIVÉ!*\n\n✅ Durée: 30 jours\n📅 Expire le: ${expiryDate}\n\n📋 *Commandes:*\n• /broadcast [msg] - Diffuser\n• /addgroup - Ajouter groupe\n• /mygroups - Mes groupes\n• /status - Mon statut\n• /help - Aide\n\n🚀 Toutes les fonctionnalités sont activées!`);
            } else {
                await message.reply('❌ Code invalide, expiré ou déjà utilisé.\nContactez l\'admin pour un nouveau code.');
            }
            return;
        }
        
        // Vérifier autorisation
        if (!isUserAuthorized(userNumber)) {
            if (messageText.startsWith('/')) {
                await message.reply('🔒 *ACCÈS REQUIS*\n\nContactez l\'admin pour obtenir un code.\nUsage: /activate [CODE]');
            }
            return;
        }
        
        // Commandes utilisateur
        await handleUserCommands(message, messageText, userNumber, contact, chat);
        
    } catch (error) {
        console.error('❌ Erreur message:', error.message);
        
        // Éviter les réponses d'erreur en boucle
        if (!error.message.includes('Rate limit') && !error.message.includes('not found')) {
            try {
                await message.reply('❌ Erreur temporaire. Réessayez.');
            } catch (replyError) {
                console.error('❌ Impossible de répondre:', replyError.message);
            }
        }
    }
});

// Gestion des commandes admin
async function handleAdminCommands(message, messageText, contact) {
    try {
        switch (true) {
            case messageText.startsWith('/gencode '):
                const targetNumber = messageText.split(' ')[1];
                if (!targetNumber) {
                    await message.reply('❌ Usage: /gencode [numéro]\n\nExemple: /gencode 237123456789');
                    return;
                }
                const formattedNumber = targetNumber.includes('@') ? targetNumber : `${targetNumber}@c.us`;
                const code = generateAccessCode(formattedNumber);
                await message.reply(`✅ *CODE GÉNÉRÉ*\n\n👤 Pour: ${targetNumber}\n🔑 Code: *${code}*\n⏰ Valide 24h\n\n📋 *Instructions:*\n/activate ${code}`);
                break;
                
            case messageText === '/stats':
                await sendStats(message);
                break;
                
            case messageText === '/cleanup':
                cleanupExpiredData();
                await message.reply('🧹 Nettoyage effectué');
                break;
                
            case messageText === '/help':
                await message.reply(`🤖 *ADMIN COMMANDS*\n\n🔑 /gencode [numéro]\n📊 /stats\n🧹 /cleanup\n❓ /help`);
                break;
        }
    } catch (error) {
        console.error('❌ Erreur commande admin:', error.message);
    }
}

// Gestion des commandes utilisateur
async function handleUserCommands(message, messageText, userNumber, contact, chat) {
    try {
        switch (messageText) {
            case '/status':
                await sendUserStatus(message, userNumber);
                break;
                
            case '/addgroup':
                if (!chat.isGroup) {
                    await message.reply('❌ Commande pour les groupes uniquement');
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
        
        // Commande broadcast
        if (messageText.startsWith('/broadcast ')) {
            await handleBroadcast(message, messageText, userNumber, contact);
        }
    } catch (error) {
        console.error('❌ Erreur commande utilisateur:', error.message);
    }
}

// Fonctions auxiliaires
async function sendStats(message) {
    try {
        const activeUsers = Object.values(userData.users).filter(user => 
            user.authorized && (Date.now() - user.authorizedAt) < USAGE_DURATION
        ).length;
        
        const totalUsers = Object.keys(userData.users).length;
        const totalGroups = Object.keys(userData.groups).length;
        const pendingCodes = Object.keys(userData.accessCodes).filter(phone => 
            !userData.accessCodes[phone].used
        ).length;
        
        await message.reply(`📊 *STATS*\n\n👥 Actifs: ${activeUsers}\n👤 Total: ${totalUsers}\n💬 Groupes: ${totalGroups}\n🔑 Codes: ${pendingCodes}\n🚀 Statut: ${isReady ? '✅' : '❌'}`);
    } catch (error) {
        console.error('❌ Erreur stats:', error.message);
    }
}

async function sendUserStatus(message, userNumber) {
    try {
        const user = userData.users[userNumber];
        const timeLeft = USAGE_DURATION - (Date.now() - user.authorizedAt);
        const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
        const userGroups = Object.keys(userData.groups).filter(g => 
            userData.groups[g].addedBy === userNumber
        ).length;
        
        await message.reply(`📊 *VOTRE STATUT*\n\n✅ Autorisé\n⏰ ${daysLeft} jours restants\n💬 ${userGroups} groupes\n📅 Expire: ${new Date(user.authorizedAt + USAGE_DURATION).toLocaleDateString('fr-FR')}`);
    } catch (error) {
        console.error('❌ Erreur statut:', error.message);
    }
}

async function sendUserGroups(message, userNumber) {
    try {
        const myGroups = Object.entries(userData.groups)
            .filter(([_, groupData]) => groupData.addedBy === userNumber)
            .map(([_, groupData]) => `• ${groupData.name}`)
            .join('\n');
        
        if (myGroups) {
            const groupCount = myGroups.split('\n').length;
            await message.reply(`📋 *VOS GROUPES (${groupCount})*\n\n${myGroups}\n\n💡 /broadcast [message] pour diffuser`);
        } else {
            await message.reply('📭 Aucun groupe\n\n💡 Dans un groupe: /addgroup');
        }
    } catch (error) {
        console.error('❌ Erreur groupes:', error.message);
    }
}

// Gestion de la diffusion
async function handleBroadcast(message, messageText, userNumber, contact) {
    try {
        const broadcastMessage = message.body.substring(11);
        if (!broadcastMessage.trim()) {
            await message.reply('❌ Message vide\n\nUsage: /broadcast [message]');
            return;
        }
        
        const userGroups = Object.entries(userData.groups)
            .filter(([_, groupData]) => groupData.addedBy === userNumber);
        
        if (userGroups.length === 0) {
            await message.reply('📭 Aucun groupe\n\n💡 /addgroup dans vos groupes');
            return;
        }
        
        await message.reply(`🚀 Diffusion vers ${userGroups.length} groupes...`);
        
        let successCount = 0;
        let failCount = 0;
        
        for (const [groupId, groupData] of userGroups) {
            try {
                const formattedMessage = `📢 *Message Diffusé*\n\n${broadcastMessage}\n\n_👤 ${contact.pushname || 'Utilisateur'}_\n_🕒 ${new Date().toLocaleString('fr-FR')}_`;
                
                await client.sendMessage(groupId, formattedMessage);
                successCount++;
                
                // Pause anti-spam
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.error(`❌ Groupe ${groupData.name}:`, error.message);
                failCount++;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        await message.reply(`📊 *RÉSULTAT*\n\n✅ Succès: ${successCount}\n${failCount > 0 ? `❌ Échecs: ${failCount}` : '🎉 Tout envoyé!'}\n\n🕒 ${new Date().toLocaleTimeString('fr-FR')}`);
        
    } catch (error) {
        console.error('❌ Erreur broadcast:', error.message);
        await message.reply('❌ Erreur lors de la diffusion');
    }
}

// Gestion de l'arrêt
const gracefulShutdown = () => {
    console.log('\n🛑 Arrêt du bot...');
    saveData();
    
    if (client) {
        client.destroy().then(() => {
            console.log('✅ Bot arrêté');
            process.exit(0);
        }).catch(() => {
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Démarrage
console.log('\n🚀 DÉMARRAGE BOT WHATSAPP');
console.log('===============================');

if (!loadData()) {
    console.error('❌ Erreur chargement données');
    process.exit(1);
}

// Nettoyage périodique (toutes les heures)
setInterval(cleanupExpiredData, 60 * 60 * 1000);

console.log('🔄 Initialisation...');
client.initialize().catch(error => {
    console.error('❌ Erreur init:', error.message);
    process.exit(1);
});

console.log('✅ Bot prêt - En attente de connexion\n');
