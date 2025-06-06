const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const express = require('express');

// Configuration avec MongoDB Atlas gratuit
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://username:password@cluster.mongodb.net/whatsappbot?retryWrites=true&w=majority',
    USAGE_DURATION: 30 * 24 * 60 * 60 * 1000, // 30 jours
    PORT: process.env.PORT || 3000,
    CODE_EXPIRY: 24 * 60 * 60 * 1000, // 24h
    QR_TIMEOUT: 120000, // 2 minutes
    RECONNECT_DELAY: 10000, // 10s
    MAX_RECONNECT_ATTEMPTS: 5
};

// État global
let botState = {
    isReady: false,
    currentQR: null,
    server: null,
    reconnectAttempts: 0,
    lastActivity: Date.now(),
    mongoStore: null
};

// Schémas MongoDB
const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    active: { type: Boolean, default: false },
    activatedAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
});

const codeSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    code: { type: String, required: true },
    created: { type: Date, default: Date.now },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, default: () => new Date(Date.now() + CONFIG.CODE_EXPIRY) }
});

const groupSchema = new mongoose.Schema({
    groupId: { type: String, unique: true, required: true },
    name: String,
    addedBy: String,
    addedAt: { type: Date, default: Date.now }
});

// Index pour expiration automatique
codeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const User = mongoose.model('User', userSchema);
const Code = mongoose.model('Code', codeSchema);
const Group = mongoose.model('Group', groupSchema);

// Connexion MongoDB
async function connectMongo() {
    try {
        await mongoose.connect(CONFIG.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000
        });
        console.log('✅ MongoDB connecté');
        
        // Créer le store pour les sessions
        botState.mongoStore = new MongoStore({ mongoose: mongoose });
        return true;
    } catch (error) {
        console.error('❌ Erreur MongoDB:', error.message);
        return false;
    }
}

// Interface web
const app = express();
app.use(express.static('public'));

app.get('/', (req, res) => {
    const status = botState.isReady ? 
        `<h1 style="color:green">✅ Bot En Ligne</h1>
         <p>🕒 Actif: ${new Date(botState.lastActivity).toLocaleString()}</p>
         <p>📊 Session: Persistante</p>` :
        botState.currentQR ? 
        `<h1>📱 Scanner le QR Code</h1>
         <div style="background:white;padding:20px;border-radius:10px;display:inline-block">
         <img src="data:image/png;base64,${botState.currentQR}" style="max-width:300px">
         </div>
         <p>⏰ QR valide 2 minutes</p>
         <script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1 style="color:orange">🔄 Initialisation...</h1>
         <p>Connexion à la base de données...</p>
         <script>setTimeout(()=>location.reload(),5000)</script>`;
    
    res.send(`<!DOCTYPE html>
    <html><head>
        <title>WhatsApp Bot 24/7</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body{font-family:Arial;text-align:center;margin:0;padding:50px;
                 background:linear-gradient(135deg,#25D366,#128C7E);color:white;min-height:100vh}
            h1{margin:20px 0;text-shadow:2px 2px 4px rgba(0,0,0,0.3)}
            p{font-size:16px;margin:10px 0}
            .status{background:rgba(255,255,255,0.1);padding:20px;border-radius:15px;
                   backdrop-filter:blur(10px);display:inline-block;margin:20px}
        </style>
    </head><body>
        <div class="status">${status}</div>
        <p>🤖 Bot WhatsApp avec session persistante</p>
    </body></html>`);
});

// Utilitaires base de données
async function generateCode(phone) {
    try {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 8; i++) {
            if (i === 4) code += ' ';
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        
        await Code.findOneAndUpdate(
            { phone },
            { code, created: new Date(), used: false },
            { upsert: true, new: true }
        );
        
        return code;
    } catch (error) {
        console.error('❌ Erreur génération code:', error.message);
        throw error;
    }
}

async function validateCode(phone, inputCode) {
    try {
        const codeData = await Code.findOne({ phone, used: false });
        if (!codeData) return false;
        
        const normalizedInput = inputCode.replace(/\s/g, '').toUpperCase();
        const normalizedStored = codeData.code.replace(/\s/g, '').toUpperCase();
        
        if (normalizedInput !== normalizedStored) return false;
        if (Date.now() - codeData.created.getTime() > CONFIG.CODE_EXPIRY) {
            await Code.deleteOne({ phone });
            return false;
        }
        
        // Marquer code comme utilisé et activer utilisateur
        await Code.updateOne({ phone }, { used: true });
        await User.findOneAndUpdate(
            { phone },
            { active: true, activatedAt: new Date() },
            { upsert: true }
        );
        
        return true;
    } catch (error) {
        console.error('❌ Erreur validation:', error.message);
        return false;
    }
}

async function isAuthorized(phone) {
    try {
        const user = await User.findOne({ phone });
        if (!user?.active) return false;
        
        const valid = (Date.now() - user.activatedAt.getTime()) < CONFIG.USAGE_DURATION;
        if (!valid) {
            await User.updateOne({ phone }, { active: false });
            return false;
        }
        return true;
    } catch (error) {
        console.error('❌ Erreur autorisation:', error.message);
        return false;
    }
}

// Configuration client avec session persistante
let client;

async function initializeClient() {
    if (!botState.mongoStore) {
        throw new Error('MongoDB store non initialisé');
    }
    
    client = new Client({
        authStrategy: new RemoteAuth({
            store: botState.mongoStore,
            backupSyncIntervalMs: 300000 // Sync toutes les 5min
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    });
    
    return client;
}

// Événements client
function setupClientEvents() {
    client.on('qr', async (qr) => {
        try {
            console.log('📱 Nouveau QR généré');
            botState.currentQR = (await QRCode.toDataURL(qr, { width: 400, margin: 2 })).split(',')[1];
            
            setTimeout(() => {
                if (!botState.isReady) {
                    botState.currentQR = null;
                    console.log('⏰ QR expiré');
                }
            }, CONFIG.QR_TIMEOUT);
        } catch (error) {
            console.error('❌ Erreur QR:', error.message);
        }
    });

    client.on('authenticated', () => {
        console.log('🔐 Authentification réussie');
    });

    client.on('ready', async () => {
        botState.isReady = true;
        botState.currentQR = null;
        botState.reconnectAttempts = 0;
        botState.lastActivity = Date.now();
        
        console.log('🎉 BOT PRÊT ET CONNECTÉ!');
        console.log(`📱 Admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`);
        
        try {
            await client.sendMessage(CONFIG.ADMIN_NUMBER, 
                `🎉 *BOT EN LIGNE 24/7*\n✅ Session persistante active\n🕒 ${new Date().toLocaleString('fr-FR')}\n💾 Données sauvées en cloud`);
        } catch (error) {
            console.error('❌ Notification admin:', error.message);
        }
    });

    client.on('auth_failure', async (msg) => {
        console.error('❌ Échec authentification:', msg);
        botState.isReady = false;
        await attemptReconnect();
    });

    client.on('disconnected', async (reason) => {
        console.log('🔌 Déconnexion:', reason);
        botState.isReady = false;
        
        if (reason !== 'LOGOUT') {
            await attemptReconnect();
        }
    });

    // Gestion des appels
    client.on('call', async (call) => {
        try {
            console.log(`📞 Appel ${call.isVideo ? 'vidéo' : 'audio'} de ${call.from}`);
            await call.reject();
            
            setTimeout(async () => {
                try {
                    await client.sendMessage(call.from, 
                        '🤖 *Bot automatique*\n\n❌ Les appels ne sont pas supportés\n✅ Utilisez uniquement les messages texte\n\n📋 Tapez `/help` pour les commandes');
                } catch (e) {
                    console.error('❌ Erreur message appel:', e.message);
                }
            }, 2000);
        } catch (error) {
            console.error('❌ Erreur appel:', error.message);
        }
    });

    // Traitement des messages
    client.on('message', async (message) => {
        if (!botState.isReady || !message.body || message.type !== 'chat') return;
        
        try {
            const text = message.body.trim();
            if (!text.startsWith('/')) {
                if (text.length < 30) {
                    setTimeout(async () => {
                        try {
                            await message.reply('🤖 Utilisez `/help` pour les commandes disponibles');
                        } catch (e) {}
                    }, 1500);
                }
                return;
            }
            
            const contact = await message.getContact();
            if (!contact || contact.isMe) return;
            
            const userPhone = contact.id._serialized;
            const cmd = text.toLowerCase();
            
            console.log(`📨 ${userPhone.replace('@c.us', '')}: ${cmd}`);
            botState.lastActivity = Date.now();
            
            // Commandes admin
            if (userPhone === CONFIG.ADMIN_NUMBER) {
                if (cmd.startsWith('/gencode ')) {
                    const number = text.substring(9).trim();
                    if (!number) {
                        await message.reply('❌ Usage: `/gencode [numéro]`');
                        return;
                    }
                    
                    const targetPhone = number.includes('@') ? number : `${number}@c.us`;
                    const code = await generateCode(targetPhone);
                    await message.reply(`✅ *CODE GÉNÉRÉ*\n👤 Pour: ${number}\n🔑 \`${code}\`\n⏰ Valide 24h`);
                    
                } else if (cmd === '/stats') {
                    try {
                        const totalUsers = await User.countDocuments();
                        const activeUsers = await User.countDocuments({ active: true });
                        const totalCodes = await Code.countDocuments();
                        const totalGroups = await Group.countDocuments();
                        
                        await message.reply(`📊 *STATISTIQUES BOT*\n👥 Total: ${totalUsers}\n✅ Actifs: ${activeUsers}\n🔑 Codes: ${totalCodes}\n📢 Groupes: ${totalGroups}\n💾 Session: Persistante`);
                    } catch (error) {
                        await message.reply('❌ Erreur lecture statistiques');
                    }
                    
                } else if (cmd === '/help') {
                    await message.reply('🤖 *COMMANDES ADMIN*\n• `/gencode [num]` - Créer code\n• `/stats` - Statistiques\n• `/help` - Cette aide\n\n💡 Session persistante = pas de QR au redémarrage!');
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
                
                if (await validateCode(userPhone, inputCode)) {
                    const expiry = new Date(Date.now() + CONFIG.USAGE_DURATION).toLocaleDateString('fr-FR');
                    await message.reply(`🎉 *ACCÈS ACTIVÉ!*\n📅 Expire: ${expiry}\n\n📋 *Commandes:*\n• \`/broadcast [msg]\` - Diffuser\n• \`/addgroup\` - Ajouter groupe\n• \`/status\` - Mon statut\n• \`/help\` - Aide`);
                } else {
                    await message.reply('❌ Code invalide, utilisé ou expiré');
                }
                return;
            }
            
            // Vérifier autorisation
            if (!(await isAuthorized(userPhone))) {
                await message.reply(`🔒 *Accès requis*\n\nContactez: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\nPuis: \`/activate VOTRE_CODE\``);
                return;
            }
            
            // Commandes utilisateur autorisé
            if (cmd === '/status') {
                try {
                    const user = await User.findOne({ phone: userPhone });
                    const remaining = Math.ceil((user.activatedAt.getTime() + CONFIG.USAGE_DURATION - Date.now()) / (24 * 60 * 60 * 1000));
                    const groupCount = await Group.countDocuments({ addedBy: userPhone });
                    await message.reply(`📊 *MON STATUT*\n🟢 Actif\n📅 ${remaining} jours restants\n📢 ${groupCount} groupes ajoutés`);
                } catch (error) {
                    await message.reply('❌ Erreur lecture statut');
                }
                
            } else if (cmd === '/addgroup') {
                const chat = await message.getChat();
                if (!chat.isGroup) {
                    await message.reply('❌ Cette commande fonctionne uniquement dans les groupes!');
                    return;
                }
                
                try {
                    const existing = await Group.findOne({ groupId: chat.id._serialized });
                    if (existing) {
                        await message.reply('ℹ️ Ce groupe est déjà enregistré');
                    } else {
                        await Group.create({
                            groupId: chat.id._serialized,
                            name: chat.name,
                            addedBy: userPhone
                        });
                        await message.reply(`✅ Groupe ajouté: *${chat.name}*\n📢 Prêt pour diffusion!`);
                    }
                } catch (error) {
                    await message.reply('❌ Erreur ajout groupe');
                }
                
            } else if (cmd.startsWith('/broadcast ')) {
                const msg = text.substring(11).trim();
                if (!msg) {
                    await message.reply('❌ Usage: `/broadcast [votre message]`');
                    return;
                }
                
                try {
                    const userGroups = await Group.find({ addedBy: userPhone });
                    if (userGroups.length === 0) {
                        await message.reply('❌ Aucun groupe enregistré!\nUtilisez `/addgroup` dans vos groupes d\'abord');
                        return;
                    }
                    
                    await message.reply(`🚀 Diffusion vers ${userGroups.length} groupes...`);
                    
                    let success = 0, failed = 0;
                    const senderName = contact.pushname || 'Utilisateur';
                    
                    for (const group of userGroups) {
                        try {
                            const fullMsg = `📢 *Message diffusé*\n👤 De: ${senderName}\n🕒 ${new Date().toLocaleString('fr-FR')}\n\n${msg}`;
                            await client.sendMessage(group.groupId, fullMsg);
                            success++;
                            await new Promise(resolve => setTimeout(resolve, 1500));
                        } catch (error) {
                            failed++;
                            console.error(`❌ Groupe ${group.name}:`, error.message);
                        }
                    }
                    
                    await message.reply(`📊 *DIFFUSION TERMINÉE*\n✅ Succès: ${success}\n❌ Échecs: ${failed}`);
                } catch (error) {
                    await message.reply('❌ Erreur diffusion');
                }
                
            } else if (cmd === '/help') {
                await message.reply('🤖 *MES COMMANDES*\n• `/broadcast [msg]` - Diffuser message\n• `/addgroup` - Ajouter ce groupe\n• `/status` - Mon statut\n• `/help` - Cette aide\n\n⚠️ *Note:* Messages texte uniquement');
            }
            
        } catch (error) {
            console.error('❌ Erreur traitement:', error.message);
            try {
                await message.reply('❌ Erreur interne du bot');
            } catch (e) {}
        }
    });
}

// Reconnexion automatique
async function attemptReconnect() {
    if (botState.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Trop de tentatives échouées');
        return;
    }
    
    botState.reconnectAttempts++;
    console.log(`🔄 Reconnexion ${botState.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}`);
    
    setTimeout(async () => {
        try {
            if (!botState.isReady && client) {
                await client.initialize();
            }
        } catch (error) {
            console.error('❌ Échec reconnexion:', error.message);
            await attemptReconnect();
        }
    }, CONFIG.RECONNECT_DELAY * botState.reconnectAttempts);
}

// Surveillance connexion
setInterval(async () => {
    if (botState.isReady && client) {
        try {
            const state = await client.getState();
            if (state !== 'CONNECTED') {
                console.log('⚠️ État:', state);
                botState.isReady = false;
                await attemptReconnect();
            }
        } catch (error) {
            console.error('❌ Vérification état:', error.message);
            botState.isReady = false;
            await attemptReconnect();
        }
    }
}, 60000); // Vérifier chaque minute

// Démarrage serveur
function startServer() {
    if (!botState.server) {
        botState.server = app.listen(CONFIG.PORT, () => {
            console.log(`🌐 Interface: http://localhost:${CONFIG.PORT}`);
        });
    }
}

// Gestion arrêt propre
process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt du bot...');
    try {
        if (botState.isReady && client) {
            await client.sendMessage(CONFIG.ADMIN_NUMBER, '🛑 Bot arrêté - Session sauvée');
            await client.destroy();
        }
        if (botState.server) botState.server.close();
        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ Erreur arrêt:', error.message);
        process.exit(1);
    }
});

// Gestion erreurs
process.on('uncaughtException', (error) => {
    console.error('❌ Erreur critique:', error.message);
    if (error.message.includes('Session') && !botState.isReady) {
        attemptReconnect();
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Promise rejetée:', reason);
});

// Fonction principale
async function startBot() {
    console.log('🚀 DÉMARRAGE BOT WHATSAPP PERSISTANT');
    console.log('💾 Avec sauvegarde MongoDB Atlas');
    
    // Connexion base de données
    if (!(await connectMongo())) {
        console.error('❌ Impossible de se connecter à MongoDB');
        process.exit(1);
    }
    
    // Démarrer serveur web
    startServer();
    
    try {
        // Initialiser client WhatsApp
        await initializeClient();
        setupClientEvents();
        
        console.log('🔐 Initialisation avec session persistante...');
        await client.initialize();
        
    } catch (error) {
        console.error('❌ Erreur initialisation:', error.message);
        await attemptReconnect();
    }
}

// Lancement
startBot().catch(error => {
    console.error('❌ Erreur fatale:', error.message);
    process.exit(1);
});
