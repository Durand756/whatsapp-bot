const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Configuration
const ADMIN_NUMBER = '237651104356@c.us'; // Remplacer par le numéro admin (format international)
const DATA_FILE = path.join(__dirname, 'users_data.json');
const USAGE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 jours en millisecondes

// Structure de données
let userData = {
    users: {},
    accessCodes: {},
    groups: {}
};

// Charger les données existantes
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            userData = JSON.parse(data);
        }
    } catch (error) {
        console.error('Erreur lors du chargement des données:', error);
    }
}

// Sauvegarder les données
function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(userData, null, 2));
    } catch (error) {
        console.error('Erreur lors de la sauvegarde:', error);
    }
}

// Générer un code d'accès unique
function generateAccessCode(phoneNumber) {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const timestamp = Date.now();
    
    userData.accessCodes[phoneNumber] = {
        code: code,
        generated: timestamp,
        used: false
    };
    
    saveData();
    return code;
}

// Vérifier si un utilisateur est autorisé
function isUserAuthorized(phoneNumber) {
    const user = userData.users[phoneNumber];
    if (!user) return false;
    
    const now = Date.now();
    return user.authorized && (now - user.authorizedAt) < USAGE_DURATION;
}

// Vérifier si un code d'accès est valide
function validateAccessCode(phoneNumber, code) {
    const accessData = userData.accessCodes[phoneNumber];
    if (!accessData || accessData.used || accessData.code !== code.toUpperCase()) {
        return false;
    }
    
    // Marquer le code comme utilisé
    accessData.used = true;
    
    // Autoriser l'utilisateur
    userData.users[phoneNumber] = {
        authorized: true,
        authorizedAt: Date.now(),
        phoneNumber: phoneNumber
    };
    
    saveData();
    return true;
}

// Nettoyer les codes expirés et utilisateurs non autorisés
function cleanupExpiredData() {
    const now = Date.now();
    const codeExpiry = 24 * 60 * 60 * 1000; // 24h pour les codes
    
    // Nettoyer les codes expirés
    for (const [phone, codeData] of Object.entries(userData.accessCodes)) {
        if (now - codeData.generated > codeExpiry) {
            delete userData.accessCodes[phone];
        }
    }
    
    // Nettoyer les utilisateurs expirés
    for (const [phone, user] of Object.entries(userData.users)) {
        if (now - user.authorizedAt > USAGE_DURATION) {
            userData.users[phone].authorized = false;
        }
    }
    
    saveData();
}

// Initialiser le client WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "whatsapp-bot"
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
            '--disable-gpu'
        ]
    }
});

// Événement QR Code
client.on('qr', (qr) => {
    console.log('Scannez le QR code pour vous connecter:');
    qrcode.generate(qr, { small: true });
});

// Événement de connexion réussie
client.on('ready', () => {
    console.log('Bot WhatsApp connecté avec succès!');
    console.log(`Numéro admin: ${ADMIN_NUMBER}`);
    
    // Nettoyer les données expirées au démarrage
    cleanupExpiredData();
    
    // Nettoyer toutes les heures
    setInterval(cleanupExpiredData, 60 * 60 * 1000);
});

// Événement de réception de message
client.on('message', async (message) => {
    try {
        const contact = await message.getContact();
        const userNumber = contact.id._serialized;
        const messageText = message.body.toLowerCase().trim();
        const chat = await message.getChat();
        
        // Commandes admin
        if (userNumber === ADMIN_NUMBER) {
            if (messageText.startsWith('/gencode ')) {
                const targetNumber = messageText.split(' ')[1];
                if (targetNumber) {
                    const formattedNumber = targetNumber.includes('@') ? targetNumber : `${targetNumber}@c.us`;
                    const code = generateAccessCode(formattedNumber);
                    await message.reply(`Code d'accès généré pour ${targetNumber}: *${code}*\n\nCe code est valide pendant 24h et à usage unique.`);
                } else {
                    await message.reply('Usage: /gencode [numéro]');
                }
                return;
            }
            
            if (messageText === '/stats') {
                const activeUsers = Object.values(userData.users).filter(user => 
                    user.authorized && (Date.now() - user.authorizedAt) < USAGE_DURATION
                ).length;
                const totalGroups = Object.keys(userData.groups).length;
                
                await message.reply(`📊 *Statistiques du Bot*\n\n👥 Utilisateurs actifs: ${activeUsers}\n💬 Groupes enregistrés: ${totalGroups}\n📋 Codes en attente: ${Object.keys(userData.accessCodes).length}`);
                return;
            }
            
            if (messageText === '/help') {
                await message.reply(`🤖 *Commandes Admin*\n\n/gencode [numéro] - Générer un code d'accès\n/stats - Voir les statistiques\n/help - Afficher cette aide`);
                return;
            }
        }
        
        // Activation avec code d'accès
        if (messageText.startsWith('/activate ')) {
            const code = messageText.split(' ')[1];
            if (validateAccessCode(userNumber, code)) {
                await message.reply(`✅ *Accès activé avec succès!*\n\nVotre accès est valide pendant 30 jours.\n\n📖 *Commandes disponibles:*\n/broadcast [message] - Diffuser un message\n/addgroup - Ajouter ce groupe\n/mygroups - Voir vos groupes\n/status - Voir votre statut`);
            } else {
                await message.reply('❌ Code d\'accès invalide ou expiré.');
            }
            return;
        }
        
        // Vérifier l'autorisation pour les autres commandes
        if (!isUserAuthorized(userNumber)) {
            if (messageText.startsWith('/')) {
                await message.reply('❌ Vous n\'êtes pas autorisé à utiliser ce bot. Contactez l\'administrateur pour obtenir un code d\'accès.');
            }
            return;
        }
        
        // Commandes utilisateur autorisé
        if (messageText === '/status') {
            const user = userData.users[userNumber];
            const timeLeft = USAGE_DURATION - (Date.now() - user.authorizedAt);
            const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
            
            await message.reply(`📊 *Votre Statut*\n\n✅ Autorisé\n⏰ Temps restant: ${daysLeft} jours\n💬 Groupes: ${Object.keys(userData.groups).filter(g => userData.groups[g].addedBy === userNumber).length}`);
            return;
        }
        
        if (messageText === '/addgroup') {
            if (chat.isGroup) {
                const groupId = chat.id._serialized;
                userData.groups[groupId] = {
                    name: chat.name,
                    addedBy: userNumber,
                    addedAt: Date.now()
                };
                saveData();
                await message.reply(`✅ Groupe "${chat.name}" ajouté à votre liste de diffusion.`);
            } else {
                await message.reply('❌ Cette commande ne peut être utilisée que dans un groupe.');
            }
            return;
        }
        
        if (messageText === '/mygroups') {
            const userGroups = Object.entries(userData.groups)
                .filter(([_, groupData]) => groupData.addedBy === userNumber)
                .map(([groupId, groupData]) => `• ${groupData.name}`)
                .join('\n');
            
            if (userGroups) {
                await message.reply(`📋 *Vos Groupes:*\n\n${userGroups}`);
            } else {
                await message.reply('❌ Aucun groupe ajouté. Utilisez /addgroup dans un groupe pour l\'ajouter.');
            }
            return;
        }
        
        if (messageText.startsWith('/broadcast ')) {
            const broadcastMessage = message.body.substring(11); // Enlever '/broadcast '
            const userGroups = Object.entries(userData.groups)
                .filter(([_, groupData]) => groupData.addedBy === userNumber);
            
            if (userGroups.length === 0) {
                await message.reply('❌ Aucun groupe disponible pour la diffusion. Ajoutez des groupes avec /addgroup.');
                return;
            }
            
            let successCount = 0;
            let failCount = 0;
            
            for (const [groupId, groupData] of userGroups) {
                try {
                    await client.sendMessage(groupId, `📢 *Message diffusé*\n\n${broadcastMessage}\n\n_Envoyé par: ${contact.pushname || contact.number}_`);
                    successCount++;
                } catch (error) {
                    console.error(`Erreur envoi groupe ${groupData.name}:`, error);
                    failCount++;
                }
                
                // Pause entre les envois
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            await message.reply(`📊 *Diffusion terminée*\n\n✅ Envoyés: ${successCount}\n❌ Échecs: ${failCount}`);
            return;
        }
        
        if (messageText === '/help') {
            await message.reply(`🤖 *Commandes Disponibles:*\n\n/broadcast [message] - Diffuser un message dans vos groupes\n/addgroup - Ajouter ce groupe à votre liste\n/mygroups - Voir vos groupes\n/status - Voir votre statut d'accès\n/help - Afficher cette aide`);
            return;
        }
        
    } catch (error) {
        console.error('Erreur traitement message:', error);
    }
});

// Gestion des erreurs
client.on('auth_failure', (msg) => {
    console.error('Échec de l\'authentification:', msg);
});

client.on('disconnected', (reason) => {
    console.log('Client déconnecté:', reason);
});

// Initialisation
console.log('Démarrage du bot WhatsApp...');
loadData();
client.initialize();

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
    console.log('Arrêt du bot...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Arrêt du bot...');
    client.destroy();
    process.exit(0);
});
