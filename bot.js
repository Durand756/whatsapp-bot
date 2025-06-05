const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Configuration
const ADMIN_NUMBER = '237651104356@c.us'; // Remplacer par le numéro admin
const DATA_FILE = path.join(__dirname, 'users_data.json');
const USAGE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 jours
const CONNECTION_CODE_DURATION = 10 * 60 * 1000; // 10 minutes pour le code de connexion

// Variables globales pour la performance
let userData = {
    users: {},
    accessCodes: {},
    groups: {},
    connectionCode: null,
    connectionCodeExpiry: 0
};

let isReady = false;
let lastActivity = Date.now();

// Charger les données avec gestion d'erreur améliorée
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            const parsed = JSON.parse(data);
            userData = { ...userData, ...parsed };
            console.log('✅ Données chargées avec succès');
        }
    } catch (error) {
        console.error('❌ Erreur chargement données:', error.message);
        // Créer une sauvegarde d'urgence
        saveDataBackup();
    }
}

// Sauvegarder avec backup
function saveData() {
    try {
        // Nettoyer les données avant sauvegarde
        cleanupBeforeSave();
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(userData, null, 2));
        console.log('💾 Données sauvegardées');
    } catch (error) {
        console.error('❌ Erreur sauvegarde:', error.message);
    }
}

// Sauvegarde d'urgence
function saveDataBackup() {
    try {
        const backupFile = path.join(__dirname, `backup_${Date.now()}.json`);
        fs.writeFileSync(backupFile, JSON.stringify(userData, null, 2));
        console.log(`🔄 Backup créé: ${backupFile}`);
    } catch (error) {
        console.error('❌ Erreur backup:', error.message);
    }
}

// Nettoyer avant sauvegarde pour optimiser
function cleanupBeforeSave() {
    const now = Date.now();
    
    // Supprimer les codes de connexion expirés
    if (userData.connectionCodeExpiry && now > userData.connectionCodeExpiry) {
        userData.connectionCode = null;
        userData.connectionCodeExpiry = 0;
    }
}

// Générer un code de connexion à 8 chiffres
function generateConnectionCode() {
    const code = Math.floor(10000000 + Math.random() * 90000000).toString();
    userData.connectionCode = code;
    userData.connectionCodeExpiry = Date.now() + CONNECTION_CODE_DURATION;
    saveData();
    
    console.log(`🔑 Code de connexion généré: ${code.substring(0,3)} ${code.substring(3)}`);
    return code;
}

// Vérifier le code de connexion
function verifyConnectionCode(inputCode) {
    const now = Date.now();
    
    if (!userData.connectionCode || now > userData.connectionCodeExpiry) {
        return false;
    }
    
    return userData.connectionCode === inputCode.replace(/\s/g, '');
}

// Générer un code d'accès utilisateur
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

// Vérifier autorisation utilisateur
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

// Valider code d'accès
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

// Nettoyage optimisé des données expirées
function cleanupExpiredData() {
    const now = Date.now();
    const codeExpiry = 24 * 60 * 60 * 1000;
    let cleaned = false;
    
    // Nettoyer codes d'accès expirés
    for (const phone in userData.accessCodes) {
        if (now - userData.accessCodes[phone].generated > codeExpiry) {
            delete userData.accessCodes[phone];
            cleaned = true;
        }
    }
    
    // Nettoyer utilisateurs expirés
    for (const phone in userData.users) {
        const user = userData.users[phone];
        if (user.authorized && (now - user.authorizedAt) > USAGE_DURATION) {
            user.authorized = false;
            cleaned = true;
        }
    }
    
    if (cleaned) {
        saveData();
        console.log('🧹 Nettoyage des données expirées effectué');
    }
}

// Configuration client optimisée pour Render
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-bot-render",
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
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ],
        timeout: 60000
    }
});

// Gestion QR Code avec code de connexion
client.on('qr', (qr) => {
    console.log('\n🔗 === CONNEXION WHATSAPP ===');
    console.log('Vous avez 2 options pour vous connecter:');
    console.log('\n📱 OPTION 1 - Scanner le QR Code:');
    qrcode.generate(qr, { small: true });
    
    console.log('\n🔢 OPTION 2 - Code de connexion:');
    const connectionCode = generateConnectionCode();
    console.log(`┌─────────────────────────────────────────┐`);
    console.log(`│  Saisissez ce code dans votre mobile:  │`);
    console.log(`│                                         │`);
    console.log(`│           ${connectionCode.substring(0,3)} ${connectionCode.substring(3)}              │`);
    console.log(`│                                         │`);
    console.log(`│  (Code valide pendant 10 minutes)      │`);
    console.log(`└─────────────────────────────────────────┘`);
    console.log('\nÉtapes pour le code:');
    console.log('1. Ouvrez WhatsApp sur votre téléphone');
    console.log('2. Allez dans Paramètres > Appareils liés');
    console.log('3. Cliquez "Lier un appareil"');
    console.log('4. Choisissez "Lier avec le numéro de téléphone"');
    console.log(`5. Saisissez: ${connectionCode.substring(0,3)} ${connectionCode.substring(3)}`);
    console.log('\n⏱️  En attente de connexion...\n');
});

// Connexion réussie
client.on('ready', () => {
    isReady = true;
    console.log('\n🎉 === BOT CONNECTÉ AVEC SUCCÈS ===');
    console.log(`📞 Admin: ${ADMIN_NUMBER}`);
    console.log(`🕒 Heure: ${new Date().toLocaleString('fr-FR')}`);
    console.log('✅ Le bot est maintenant opérationnel!\n');
    
    // Nettoyage initial
    cleanupExpiredData();
    
    // Nettoyage périodique optimisé
    setInterval(() => {
        if (Date.now() - lastActivity > 30 * 60 * 1000) { // 30 min d'inactivité
            cleanupExpiredData();
        }
    }, 60 * 60 * 1000); // Toutes les heures
});

// Traitement des messages optimisé
client.on('message', async (message) => {
    if (!isReady) return;
    
    lastActivity = Date.now();
    
    try {
        const contact = await message.getContact();
        const userNumber = contact.id._serialized;
        const messageText = message.body.toLowerCase().trim();
        const chat = await message.getChat();
        
        // Vérifier code de connexion d'abord
        if (messageText.startsWith('/connect ')) {
            const inputCode = messageText.split(' ')[1];
            if (verifyConnectionCode(inputCode)) {
                await message.reply('✅ Code de connexion valide! Vous pouvez maintenant utiliser WhatsApp Web.');
                userData.connectionCode = null; // Invalider après usage
                saveData();
            } else {
                await message.reply('❌ Code de connexion invalide ou expiré.');
            }
            return;
        }
        
        // Commandes admin optimisées
        if (userNumber === ADMIN_NUMBER) {
            switch (true) {
                case messageText.startsWith('/gencode '):
                    const targetNumber = messageText.split(' ')[1];
                    if (!targetNumber) {
                        await message.reply('❌ Usage: /gencode [numéro]');
                        return;
                    }
                    const formattedNumber = targetNumber.includes('@') ? targetNumber : `${targetNumber}@c.us`;
                    const code = generateAccessCode(formattedNumber);
                    await message.reply(`✅ *Code généré pour ${targetNumber}*\n\n🔑 Code: *${code}*\n⏰ Valide: 24h\n🎯 Usage: Unique\n\n_L'utilisateur doit envoyer: /activate ${code}_`);
                    break;
                    
                case messageText === '/stats':
                    const activeUsers = Object.values(userData.users).filter(user => 
                        user.authorized && (Date.now() - user.authorizedAt) < USAGE_DURATION
                    ).length;
                    const totalGroups = Object.keys(userData.groups).length;
                    const pendingCodes = Object.keys(userData.accessCodes).filter(phone => 
                        !userData.accessCodes[phone].used
                    ).length;
                    
                    await message.reply(`📊 *Statistiques Bot*\n\n👥 Actifs: ${activeUsers}\n💬 Groupes: ${totalGroups}\n🔑 Codes: ${pendingCodes}\n🕒 Uptime: ${Math.floor((Date.now() - lastActivity) / 60000)}min`);
                    break;
                    
                case messageText === '/newcode':
                    const newConnCode = generateConnectionCode();
                    await message.reply(`🔢 *Nouveau Code de Connexion*\n\n*${newConnCode.substring(0,3)} ${newConnCode.substring(3)}*\n\n⏰ Valide 10 minutes\n📱 À saisir dans WhatsApp mobile`);
                    break;
                    
                case messageText === '/cleanup':
                    cleanupExpiredData();
                    await message.reply('🧹 Nettoyage des données expirées terminé.');
                    break;
                    
                case messageText === '/help':
                    await message.reply(`🤖 *Commandes Admin*\n\n/gencode [num] - Générer code accès\n/newcode - Nouveau code connexion\n/stats - Statistiques\n/cleanup - Nettoyer données\n/help - Cette aide`);
                    break;
            }
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
                await message.reply(`🎉 *Accès Activé!*\n\n✅ Durée: 30 jours\n📅 Expire: ${new Date(Date.now() + USAGE_DURATION).toLocaleDateString('fr-FR')}\n\n📖 *Commandes:*\n/broadcast [msg] - Diffuser\n/addgroup - Ajouter groupe\n/mygroups - Mes groupes\n/status - Mon statut\n/help - Aide`);
            } else {
                await message.reply('❌ Code invalide, expiré ou déjà utilisé.');
            }
            return;
        }
        
        // Vérifier autorisation pour autres commandes
        if (!isUserAuthorized(userNumber)) {
            if (messageText.startsWith('/')) {
                await message.reply('🔒 *Accès Requis*\n\nContactez l\'admin pour un code d\'accès.\nUsage: /activate [CODE]');
            }
            return;
        }
        
        // Commandes utilisateur autorisé
        switch (messageText) {
            case '/status':
                const user = userData.users[userNumber];
                const timeLeft = USAGE_DURATION - (Date.now() - user.authorizedAt);
                const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
                const userGroups = Object.keys(userData.groups).filter(g => 
                    userData.groups[g].addedBy === userNumber
                ).length;
                
                await message.reply(`📊 *Votre Statut*\n\n✅ Autorisé\n⏰ ${daysLeft} jours restants\n💬 ${userGroups} groupes\n📱 Actif depuis: ${new Date(user.authorizedAt).toLocaleDateString('fr-FR')}`);
                break;
                
            case '/addgroup':
                if (!chat.isGroup) {
                    await message.reply('❌ Commande réservée aux groupes.');
                    return;
                }
                
                const groupId = chat.id._serialized;
                userData.groups[groupId] = {
                    name: chat.name,
                    addedBy: userNumber,
                    addedAt: Date.now()
                };
                saveData();
                await message.reply(`✅ Groupe *"${chat.name}"* ajouté à votre liste de diffusion.`);
                break;
                
            case '/mygroups':
                const myGroups = Object.entries(userData.groups)
                    .filter(([_, groupData]) => groupData.addedBy === userNumber)
                    .map(([_, groupData]) => `• ${groupData.name}`)
                    .join('\n');
                
                if (myGroups) {
                    await message.reply(`📋 *Vos Groupes (${myGroups.split('\n').length})*\n\n${myGroups}`);
                } else {
                    await message.reply('📭 Aucun groupe.\nUtilisez /addgroup dans un groupe pour l\'ajouter.');
                }
                break;
                
            case '/help':
                await message.reply(`🤖 *Commandes Disponibles*\n\n📢 /broadcast [message] - Diffuser\n➕ /addgroup - Ajouter ce groupe\n📋 /mygroups - Voir mes groupes\n📊 /status - Mon statut\n❓ /help - Cette aide`);
                break;
        }
        
        // Commande broadcast
        if (messageText.startsWith('/broadcast ')) {
            const broadcastMessage = message.body.substring(11);
            if (!broadcastMessage.trim()) {
                await message.reply('❌ Message vide. Usage: /broadcast [votre message]');
                return;
            }
            
            const userGroups = Object.entries(userData.groups)
                .filter(([_, groupData]) => groupData.addedBy === userNumber);
            
            if (userGroups.length === 0) {
                await message.reply('📭 Aucun groupe disponible.\nAjoutez des groupes avec /addgroup');
                return;
            }
            
            await message.reply('🚀 Diffusion en cours...');
            
            let successCount = 0;
            let failCount = 0;
            
            for (const [groupId, groupData] of userGroups) {
                try {
                    await client.sendMessage(groupId, `📢 *Message Diffusé*\n\n${broadcastMessage}\n\n_👤 Par: ${contact.pushname || contact.number}_\n_🕒 ${new Date().toLocaleTimeString('fr-FR')}_`);
                    successCount++;
                    
                    // Pause optimisée entre envois
                    await new Promise(resolve => setTimeout(resolve, 1500));
                } catch (error) {
                    console.error(`❌ Erreur groupe ${groupData.name}:`, error.message);
                    failCount++;
                }
            }
            
            await message.reply(`📊 *Diffusion Terminée*\n\n✅ Envoyés: ${successCount}/${userGroups.length}\n${failCount > 0 ? `❌ Échecs: ${failCount}` : '🎉 Tous envoyés!'}`);
        }
        
    } catch (error) {
        console.error('❌ Erreur traitement:', error.message);
        if (error.message.includes('Rate limit')) {
            await message.reply('⏳ Trop de messages. Attendez quelques secondes.');
        }
    }
});

// Gestion d'erreurs optimisée
client.on('auth_failure', (msg) => {
    console.error('❌ Échec authentification:', msg);
    process.exit(1);
});

client.on('disconnected', (reason) => {
    console.log('🔌 Déconnecté:', reason);
    isReady = false;
});

// Gestion propre de l'arrêt
const gracefulShutdown = () => {
    console.log('\n🛑 Arrêt du bot...');
    saveData();
    client.destroy().then(() => {
        console.log('✅ Bot arrêté proprement');
        process.exit(0);
    });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Keep-alive pour Render
const keepAlive = () => {
    setInterval(() => {
        console.log(`💓 Keep-alive: ${new Date().toISOString()}`);
    }, 25 * 60 * 1000); // 25 minutes
};

// Initialisation
console.log('🚀 Démarrage Bot WhatsApp Avancé...');
console.log('📍 Optimisé pour Render.com');
loadData();
keepAlive();
client.initialize();
