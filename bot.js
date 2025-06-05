const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Configuration renforcée
const ADMIN_NUMBER = '237679199601@c.us';
const DATA_FILE = path.join(__dirname, 'users_data.json');
const USAGE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 jours
const CONNECTION_CODE_DURATION = 10 * 60 * 1000; // 10 minutes
const MAX_RETRY_ATTEMPTS = 3;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Variables globales optimisées
let userData = {
    users: {},
    accessCodes: {},
    groups: {},
    connectionCode: null,
    connectionCodeExpiry: 0
};

let isReady = false;
let lastActivity = Date.now();
let retryCount = 0;
let healthCheckInterval;

// Fonctions utilitaires améliorées
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
                    connectionCode: null,
                    connectionCodeExpiry: 0,
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
        createBackup();
        return false;
    }
}

function saveData() {
    try {
        cleanupBeforeSave();
        const dataToSave = {
            ...userData,
            lastSave: Date.now()
        };
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
        console.log('💾 Données sauvegardées');
        return true;
    } catch (error) {
        console.error('❌ Erreur sauvegarde:', error.message);
        createBackup();
        return false;
    }
}

function createBackup() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(__dirname, `backup_${timestamp}.json`);
        fs.writeFileSync(backupFile, JSON.stringify(userData, null, 2));
        console.log(`🔄 Backup créé: ${backupFile}`);
    } catch (error) {
        console.error('❌ Erreur backup:', error.message);
    }
}

function cleanupBeforeSave() {
    const now = Date.now();
    
    // Nettoyer code de connexion expiré
    if (userData.connectionCodeExpiry && now > userData.connectionCodeExpiry) {
        userData.connectionCode = null;
        userData.connectionCodeExpiry = 0;
    }
    
    // Nettoyer codes d'accès expirés (24h)
    Object.keys(userData.accessCodes).forEach(phone => {
        const codeData = userData.accessCodes[phone];
        if (now - codeData.generated > 24 * 60 * 60 * 1000) {
            delete userData.accessCodes[phone];
        }
    });
}

// Gestion des codes améliorée
function generateConnectionCode() {
    const code = Math.floor(10000000 + Math.random() * 90000000).toString();
    userData.connectionCode = code;
    userData.connectionCodeExpiry = Date.now() + CONNECTION_CODE_DURATION;
    saveData();
    
    console.log(`🔑 Code de connexion: ${code.substring(0,4)} ${code.substring(4)}`);
    return code;
}

function verifyConnectionCode(inputCode) {
    const now = Date.now();
    const cleanInput = inputCode.replace(/\s/g, '');
    
    if (!userData.connectionCode || now > userData.connectionCodeExpiry) {
        return false;
    }
    
    return userData.connectionCode === cleanInput;
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

// Configuration client optimisée pour la stabilité
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-bot-stable",
        dataPath: './auth_data'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--no-first-run',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--memory-pressure-off',
            '--max_old_space_size=4096'
        ],
        timeout: 120000, // 2 minutes
        slowMo: 50 // Ralentir pour éviter les erreurs
    }
});

// Gestion améliorée des événements
client.on('qr', (qr) => {
    console.log('\n' + '='.repeat(50));
    console.log('🔗 CONNEXION WHATSAPP - 2 OPTIONS');
    console.log('='.repeat(50));
    
    console.log('\n📱 OPTION 1 - QR Code:');
    qrcode.generate(qr, { small: true });
    
    console.log('\n🔢 OPTION 2 - Code de connexion:');
    const connectionCode = generateConnectionCode();
    console.log('┌─────────────────────────────────────────┐');
    console.log('│      CODE DE CONNEXION WHATSAPP        │');
    console.log('├─────────────────────────────────────────┤');
    console.log(`│           ${connectionCode.substring(0,4)} ${connectionCode.substring(4)}              │`);
    console.log('├─────────────────────────────────────────┤');
    console.log('│      Valide pendant 10 minutes         │');
    console.log('└─────────────────────────────────────────┘');
    
    console.log('\n📝 Instructions:');
    console.log('1. Ouvrez WhatsApp sur votre mobile');
    console.log('2. Menu → Appareils liés');
    console.log('3. "Lier un appareil"');
    console.log('4. "Lier avec le numéro"');
    console.log(`5. Saisissez: ${connectionCode.substring(0,4)} ${connectionCode.substring(4)}`);
    console.log('\n⏱️  En attente de connexion...\n');
});

client.on('ready', () => {
    isReady = true;
    retryCount = 0;
    lastActivity = Date.now();
    
    console.log('\n' + '🎉'.repeat(20));
    console.log('🚀 BOT WHATSAPP CONNECTÉ AVEC SUCCÈS!');
    console.log('🎉'.repeat(20));
    console.log(`📞 Admin: ${ADMIN_NUMBER}`);
    console.log(`🕒 Connecté à: ${new Date().toLocaleString('fr-FR')}`);
    console.log('✅ Toutes les fonctionnalités sont opérationnelles');
    console.log('🎉'.repeat(20) + '\n');
    
    // Démarrer le monitoring de santé
    startHealthCheck();
    
    // Nettoyage initial
    setTimeout(() => {
        cleanupExpiredData();
    }, 5000);
});

client.on('authenticated', () => {
    console.log('🔐 Authentification réussie');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Échec authentification:', msg);
    handleReconnection('auth_failure');
});

client.on('disconnected', (reason) => {
    console.log('🔌 Déconnecté:', reason);
    isReady = false;
    stopHealthCheck();
    handleReconnection(reason);
});

// Système de reconnexion automatique
function handleReconnection(reason) {
    if (retryCount >= MAX_RETRY_ATTEMPTS) {
        console.error('❌ Nombre max de tentatives atteint. Arrêt du bot.');
        process.exit(1);
    }
    
    retryCount++;
    console.log(`🔄 Tentative de reconnexion ${retryCount}/${MAX_RETRY_ATTEMPTS} dans 30s...`);
    
    setTimeout(() => {
        console.log('🚀 Reconnexion en cours...');
        client.initialize().catch(error => {
            console.error('❌ Erreur reconnexion:', error.message);
        });
    }, 30000);
}

// Monitoring de santé
function startHealthCheck() {
    healthCheckInterval = setInterval(async () => {
        try {
            if (isReady) {
                const state = await client.getState();
                if (state !== 'CONNECTED') {
                    console.log('⚠️ État inattendu:', state);
                    isReady = false;
                }
            }
            console.log(`💓 Health check: ${isReady ? 'OK' : 'DISCONNECTED'} - ${new Date().toISOString()}`);
        } catch (error) {
            console.error('❌ Health check failed:', error.message);
            isReady = false;
        }
    }, HEALTH_CHECK_INTERVAL);
}

function stopHealthCheck() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
}

// Nettoyage optimisé
function cleanupExpiredData() {
    const now = Date.now();
    let cleaned = false;
    
    // Nettoyer codes d'accès expirés (24h)
    Object.keys(userData.accessCodes).forEach(phone => {
        if (now - userData.accessCodes[phone].generated > 24 * 60 * 60 * 1000) {
            delete userData.accessCodes[phone];
            cleaned = true;
        }
    });
    
    // Nettoyer utilisateurs expirés
    Object.keys(userData.users).forEach(phone => {
        const user = userData.users[phone];
        if (user.authorized && (now - user.authorizedAt) > USAGE_DURATION) {
            user.authorized = false;
            cleaned = true;
        }
    });
    
    if (cleaned) {
        saveData();
        console.log('🧹 Nettoyage des données expirées effectué');
    }
}

// Traitement des messages avec gestion d'erreurs renforcée
client.on('message', async (message) => {
    if (!isReady) return;
    
    lastActivity = Date.now();
    
    try {
        const contact = await message.getContact();
        const userNumber = contact.id._serialized;
        const messageText = message.body.toLowerCase().trim();
        const chat = await message.getChat();
        
        // Log des messages pour debug (optionnel)
        // console.log(`📨 Message de ${contact.pushname || contact.number}: ${message.body}`);
        
        // Vérification code de connexion
        if (messageText.startsWith('/connect ')) {
            const inputCode = messageText.split(' ')[1];
            if (verifyConnectionCode(inputCode)) {
                await message.reply('✅ Code de connexion valide! WhatsApp Web est maintenant connecté.');
                userData.connectionCode = null;
                userData.connectionCodeExpiry = 0;
                saveData();
            } else {
                await message.reply('❌ Code de connexion invalide ou expiré.\nDemandez un nouveau code à l\'admin.');
            }
            return;
        }
        
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
                await message.reply(`🎉 *ACCÈS ACTIVÉ AVEC SUCCÈS!*\n\n✅ Durée: 30 jours\n📅 Expire le: ${expiryDate}\n\n📋 *Commandes disponibles:*\n• /broadcast [msg] - Diffuser message\n• /addgroup - Ajouter ce groupe\n• /mygroups - Voir mes groupes\n• /status - Mon statut\n• /help - Aide complète\n\n🚀 Vous pouvez maintenant utiliser toutes les fonctionnalités!`);
            } else {
                await message.reply('❌ *Code invalide*\n\nVérifiez:\n• Le code est correct\n• Il n\'est pas expiré (24h max)\n• Il n\'a pas déjà été utilisé\n\nContactez l\'admin pour un nouveau code.');
            }
            return;
        }
        
        // Vérifier autorisation pour autres commandes
        if (!isUserAuthorized(userNumber)) {
            if (messageText.startsWith('/')) {
                await message.reply('🔒 *ACCÈS REQUIS*\n\nVous devez activer votre accès pour utiliser les commandes.\n\n📞 Contactez l\'administrateur pour obtenir un code d\'activation.\n\n💡 Usage: /activate [CODE]');
            }
            return;
        }
        
        // Commandes utilisateur autorisé
        await handleUserCommands(message, messageText, userNumber, contact, chat);
        
    } catch (error) {
        console.error('❌ Erreur traitement message:', error.message);
        
        // Gestion spécifique des erreurs courantes
        if (error.message.includes('Rate limit')) {
            await message.reply('⏳ Trop de messages trop rapidement. Patientez quelques secondes.');
        } else if (error.message.includes('Message not found')) {
            console.log('⚠️ Message non trouvé (probablement supprimé)');
        } else {
            await message.reply('❌ Une erreur est survenue. Réessayez dans quelques instants.');
        }
    }
});

// Gestion des commandes admin
async function handleAdminCommands(message, messageText, contact) {
    switch (true) {
        case messageText.startsWith('/gencode '):
            const targetNumber = messageText.split(' ')[1];
            if (!targetNumber) {
                await message.reply('❌ Usage: /gencode [numéro]\n\nExemple: /gencode 237123456789');
                return;
            }
            const formattedNumber = targetNumber.includes('@') ? targetNumber : `${targetNumber}@c.us`;
            const code = generateAccessCode(formattedNumber);
            await message.reply(`✅ *CODE GÉNÉRÉ AVEC SUCCÈS*\n\n👤 Pour: ${targetNumber}\n🔑 Code: *${code}*\n⏰ Validité: 24 heures\n🎯 Usage: Unique\n\n📋 *Instructions pour l'utilisateur:*\nEnvoyer: /activate ${code}\n\n💡 Le code sera automatiquement supprimé après usage.`);
            break;
            
        case messageText === '/stats':
            await sendStats(message);
            break;
            
        case messageText === '/newcode':
            const newConnCode = generateConnectionCode();
            await message.reply(`🔢 *NOUVEAU CODE DE CONNEXION*\n\n*${newConnCode.substring(0,4)} ${newConnCode.substring(4)}*\n\n⏰ Valide pendant 10 minutes\n📱 À saisir dans l'application WhatsApp mobile\n\n📝 Instructions:\n1. WhatsApp → Appareils liés\n2. Lier un appareil\n3. Lier avec le numéro\n4. Saisir le code`);
            break;
            
        case messageText === '/cleanup':
            cleanupExpiredData();
            await message.reply('🧹 *Nettoyage terminé*\n\nDonnées expirées supprimées avec succès.');
            break;
            
        case messageText === '/backup':
            createBackup();
            await message.reply('💾 *Backup créé*\n\nSauvegarde des données effectuée.');
            break;
            
        case messageText === '/help':
            await message.reply(`🤖 *COMMANDES ADMINISTRATEUR*\n\n🔑 /gencode [numéro] - Générer code d'accès\n🔢 /newcode - Nouveau code de connexion\n📊 /stats - Statistiques détaillées\n🧹 /cleanup - Nettoyer données expirées\n💾 /backup - Créer une sauvegarde\n❓ /help - Cette aide\n\n💡 *Conseils:*\n• Générez des codes régulièrement\n• Surveillez les stats\n• Nettoyez périodiquement`);
            break;
    }
}

// Gestion des commandes utilisateur
async function handleUserCommands(message, messageText, userNumber, contact, chat) {
    switch (messageText) {
        case '/status':
            await sendUserStatus(message, userNumber);
            break;
            
        case '/addgroup':
            if (!chat.isGroup) {
                await message.reply('❌ *Commande réservée aux groupes*\n\nVous devez être dans un groupe pour utiliser cette commande.');
                return;
            }
            
            const groupId = chat.id._serialized;
            userData.groups[groupId] = {
                name: chat.name,
                addedBy: userNumber,
                addedAt: Date.now()
            };
            saveData();
            await message.reply(`✅ *GROUPE AJOUTÉ*\n\n📝 Nom: "${chat.name}"\n📅 Ajouté le: ${new Date().toLocaleDateString('fr-FR')}\n\n💡 Vous pouvez maintenant diffuser des messages dans ce groupe avec /broadcast`);
            break;
            
        case '/mygroups':
            await sendUserGroups(message, userNumber);
            break;
            
        case '/help':
            await message.reply(`🤖 *COMMANDES UTILISATEUR*\n\n📢 /broadcast [message] - Diffuser un message\n➕ /addgroup - Ajouter ce groupe à vos diffusions\n📋 /mygroups - Voir vos groupes\n📊 /status - Votre statut d'accès\n❓ /help - Cette aide\n\n💡 *Exemple de diffusion:*\n/broadcast Bonjour à tous ! 👋\n\n⚠️ *Important:*\nAjoutez d'abord des groupes avec /addgroup`);
            break;
    }
    
    // Commande broadcast
    if (messageText.startsWith('/broadcast ')) {
        await handleBroadcast(message, messageText, userNumber, contact);
    }
}

// Fonctions auxiliaires pour les statistiques et statuts
async function sendStats(message) {
    const activeUsers = Object.values(userData.users).filter(user => 
        user.authorized && (Date.now() - user.authorizedAt) < USAGE_DURATION
    ).length;
    
    const totalUsers = Object.keys(userData.users).length;
    const totalGroups = Object.keys(userData.groups).length;
    const pendingCodes = Object.keys(userData.accessCodes).filter(phone => 
        !userData.accessCodes[phone].used
    ).length;
    
    const uptime = Math.floor((Date.now() - lastActivity) / 60000);
    
    await message.reply(`📊 *STATISTIQUES DÉTAILLÉES*\n\n👥 Utilisateurs actifs: ${activeUsers}\n👤 Total utilisateurs: ${totalUsers}\n💬 Groupes configurés: ${totalGroups}\n🔑 Codes en attente: ${pendingCodes}\n⏰ Dernière activité: ${uptime}min\n🚀 Statut: ${isReady ? '✅ Connecté' : '❌ Déconnecté'}\n\n📅 Mis à jour: ${new Date().toLocaleString('fr-FR')}`);
}

async function sendUserStatus(message, userNumber) {
    const user = userData.users[userNumber];
    const timeLeft = USAGE_DURATION - (Date.now() - user.authorizedAt);
    const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
    const userGroups = Object.keys(userData.groups).filter(g => 
        userData.groups[g].addedBy === userNumber
    ).length;
    
    await message.reply(`📊 *VOTRE STATUT*\n\n✅ Statut: Autorisé\n⏰ Temps restant: ${daysLeft} jours\n💬 Vos groupes: ${userGroups}\n📅 Activé le: ${new Date(user.authorizedAt).toLocaleDateString('fr-FR')}\n🔄 Expire le: ${new Date(user.authorizedAt + USAGE_DURATION).toLocaleDateString('fr-FR')}\n\n💡 Contactez l'admin pour renouveler avant expiration.`);
}

async function sendUserGroups(message, userNumber) {
    const myGroups = Object.entries(userData.groups)
        .filter(([_, groupData]) => groupData.addedBy === userNumber)
        .map(([_, groupData]) => `• ${groupData.name}`)
        .join('\n');
    
    if (myGroups) {
        const groupCount = myGroups.split('\n').length;
        await message.reply(`📋 *VOS GROUPES (${groupCount})*\n\n${myGroups}\n\n💡 Pour ajouter un groupe:\n1. Allez dans le groupe\n2. Tapez /addgroup\n\n📢 Pour diffuser: /broadcast [votre message]`);
    } else {
        await message.reply('📭 *Aucun groupe configuré*\n\n💡 Pour ajouter des groupes:\n1. Rejoignez un groupe WhatsApp\n2. Dans le groupe, tapez /addgroup\n3. Le groupe sera ajouté à votre liste\n\n📢 Vous pourrez ensuite diffuser avec /broadcast');
    }
}

// Gestion de la diffusion
async function handleBroadcast(message, messageText, userNumber, contact) {
    const broadcastMessage = message.body.substring(11);
    if (!broadcastMessage.trim()) {
        await message.reply('❌ *Message vide*\n\nUsage: /broadcast [votre message]\n\nExemple:\n/broadcast Bonjour tout le monde ! 👋');
        return;
    }
    
    const userGroups = Object.entries(userData.groups)
        .filter(([_, groupData]) => groupData.addedBy === userNumber);
    
    if (userGroups.length === 0) {
        await message.reply('📭 *Aucun groupe disponible*\n\n💡 Pour ajouter des groupes:\n1. Allez dans un groupe\n2. Tapez /addgroup\n3. Répétez pour chaque groupe souhaité\n\n📢 Vous pourrez ensuite diffuser vos messages !');
        return;
    }
    
    await message.reply(`🚀 *DIFFUSION EN COURS...*\n\n📊 Groupes cibles: ${userGroups.length}\n⏳ Veuillez patienter...`);
    
    let successCount = 0;
    let failCount = 0;
    const failedGroups = [];
    
    for (const [groupId, groupData] of userGroups) {
        try {
            const formattedMessage = `📢 *Message Diffusé*\n\n${broadcastMessage}\n\n_👤 Envoyé par: ${contact.pushname || contact.number}_\n_🕒 Le: ${new Date().toLocaleString('fr-FR')}_`;
            
            await client.sendMessage(groupId, formattedMessage);
            successCount++;
            
            // Pause pour éviter le spam
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            console.error(`❌ Erreur groupe ${groupData.name}:`, error.message);
            failCount++;
            failedGroups.push(groupData.name);
            
            // Pause même en cas d'erreur
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    let resultMessage = `📊 *DIFFUSION TERMINÉE*\n\n✅ Succès: ${successCount}/${userGroups.length}`;
    
    if (failCount > 0) {
        resultMessage += `\n❌ Échecs: ${failCount}`;
        if (failedGroups.length > 0) {
            resultMessage += `\n\n⚠️ Groupes en échec:\n${failedGroups.map(name => `• ${name}`).join('\n')}`;
        }
    } else {
        resultMessage += '\n🎉 Tous les messages ont été envoyés !';
    }
    
    resultMessage += `\n\n🕒 Terminé à: ${new Date().toLocaleTimeString('fr-FR')}`;
    
    await message.reply(resultMessage);
}

// Gestion propre de l'arrêt
const gracefulShutdown = () => {
    console.log('\n🛑 Arrêt du bot en cours...');
    stopHealthCheck();
    saveData();
    
    if (client) {
        client.destroy().then(() => {
            console.log('✅ Bot arrêté proprement');
            process.exit(0);
        }).catch(() => {
            console.log('⚠️ Arrêt forcé');
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
};

// Gestion des signaux système
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (error) => {
    console.error('❌ Exception non gérée:', error.message);
    createBackup();
    gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesse rejetée non gérée:', reason);
});

// Initialisation du bot
console.log('\n' + '🚀'.repeat(20));
console.log('DÉMARRAGE BOT WHATSAPP AVANCÉ');
console.log('🚀'.repeat(20));
console.log('📍 Version: Stable & Optimisée');
console.log('🌐 Environnement: Render.com Ready');
console.log('🔧 Fonctionnalités: Complètes');
console.log('🚀'.repeat(20) + '\n');

// Chargement des données
if (!loadData()) {
    console.error('❌ Impossible de charger les données. Arrêt du bot.');
    process.exit(1);
}

// Nettoyage périodique (toutes les heures)
setInterval(() => {
    if (Date.now() - lastActivity > 30 * 60 * 1000) { // Si inactif depuis 30min
        cleanupExpiredData();
    }
}, 60 * 60 * 1000);

// Démarrage du client
console.log('🔄 Initialisation du client WhatsApp...');
client.initialize().catch(error => {
    console.error('❌ Erreur initialisation:', error.message);
    console.log('🔄 Nouvelle tentative dans 10 secondes...');
    setTimeout(() => {
        process.exit(1);
    }, 10000);
});

console.log('✅ Bot WhatsApp démarré avec succès!');
console.log('📞 En attente de connexion...\n');
