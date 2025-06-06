const { Client, LocalAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// Configuration optimisée pour Render
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://username:password@cluster.mongodb.net/whatsappbot?retryWrites=true&w=majority',
    USAGE_DURATION: 30 * 24 * 60 * 60 * 1000, // 30 jours
    PORT: process.env.PORT || 3000,
    CODE_EXPIRY: 24 * 60 * 60 * 1000, // 24h
    QR_TIMEOUT: 90000, // 1.5 minutes
    RECONNECT_DELAY: 15000, // 15s
    MAX_RECONNECT_ATTEMPTS: 3
};

// État global simplifié
let botState = {
    isReady: false,
    currentQR: null,
    server: null,
    reconnectAttempts: 0,
    lastActivity: Date.now(),
    client: null
};

// Schémas MongoDB optimisés
const userSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true, index: true },
    active: { type: Boolean, default: false, index: true },
    activatedAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
}, { collection: 'users' });

const codeSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true },
    code: { type: String, required: true },
    created: { type: Date, default: Date.now },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, default: () => new Date(Date.now() + CONFIG.CODE_EXPIRY) }
}, { collection: 'codes' });

const groupSchema = new mongoose.Schema({
    groupId: { type: String, unique: true, required: true },
    name: String,
    addedBy: String,
    addedAt: { type: Date, default: Date.now }
}, { collection: 'groups' });

// Index TTL pour expiration automatique
codeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const User = mongoose.model('User', userSchema);
const Code = mongoose.model('Code', codeSchema);
const Group = mongoose.model('Group', groupSchema);

// Connexion MongoDB avec gestion d'erreur
async function connectMongo() {
    try {
        await mongoose.connect(CONFIG.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 8000,
            socketTimeoutMS: 45000,
            maxPoolSize: 10,
            bufferCommands: false
        });
        console.log('✅ MongoDB connecté');
        return true;
    } catch (error) {
        console.error('❌ Erreur MongoDB:', error.message);
        return false;
    }
}

// Interface web simplifiée
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

app.get('/', (req, res) => {
    const status = botState.isReady ? 
        `<h1 class="online">✅ Bot En Ligne</h1>
         <p>🕒 Actif: ${new Date(botState.lastActivity).toLocaleString('fr-FR')}</p>
         <p>📊 Statut: Connecté</p>` :
        botState.currentQR ? 
        `<h1>📱 Scanner le QR Code</h1>
         <div class="qr-container">
         <img src="data:image/png;base64,${botState.currentQR}" alt="QR Code">
         </div>
         <p>⏰ QR valide 90 secondes</p>
         <script>setTimeout(()=>location.reload(),25000)</script>` :
        `<h1 class="loading">🔄 Initialisation...</h1>
         <p>Connexion en cours...</p>
         <script>setTimeout(()=>location.reload(),8000)</script>`;
    
    res.send(`<!DOCTYPE html>
    <html><head>
        <title>WhatsApp Bot</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            *{margin:0;padding:0;box-sizing:border-box}
            body{font-family:Arial,sans-serif;text-align:center;
                 background:linear-gradient(135deg,#25D366,#128C7E);
                 color:white;min-height:100vh;display:flex;
                 flex-direction:column;justify-content:center;align-items:center}
            .container{background:rgba(255,255,255,0.1);padding:30px;
                      border-radius:20px;backdrop-filter:blur(10px);
                      box-shadow:0 8px 32px rgba(0,0,0,0.2);max-width:500px;margin:20px}
            h1{margin:20px 0;font-size:1.8em;text-shadow:2px 2px 4px rgba(0,0,0,0.3)}
            .online{color:#4CAF50} .loading{color:#FF9800}
            p{font-size:16px;margin:10px 0;opacity:0.9}
            .qr-container{background:white;padding:15px;border-radius:15px;
                         display:inline-block;margin:20px 0}
            img{max-width:280px;height:auto}
            @media(max-width:600px){
                .container{margin:10px;padding:20px}
                h1{font-size:1.4em} img{max-width:250px}
            }
        </style>
    </head><body>
        <div class="container">${status}</div>
        <p style="opacity:0.7;font-size:14px">🤖 WhatsApp Bot Automatique</p>
    </body></html>`);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: botState.isReady ? 'online' : 'offline',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Utilitaires base de données optimisés
async function generateCode(phone) {
    try {
        const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789'; // Sans O et 0
        let code = '';
        for (let i = 0; i < 8; i++) {
            if (i === 4) code += '-';
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        
        await Code.findOneAndUpdate(
            { phone },
            { $set: { code, created: new Date(), used: false, expiresAt: new Date(Date.now() + CONFIG.CODE_EXPIRY) }},
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
        const codeData = await Code.findOne({ phone, used: false }).lean();
        if (!codeData) return false;
        
        const normalizedInput = inputCode.replace(/[-\s]/g, '').toUpperCase();
        const normalizedStored = codeData.code.replace(/[-\s]/g, '').toUpperCase();
        
        if (normalizedInput !== normalizedStored) return false;
        if (Date.now() > codeData.expiresAt.getTime()) {
            await Code.deleteOne({ phone });
            return false;
        }
        
        // Transaction atomique
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                await Code.updateOne({ phone }, { $set: { used: true }}, { session });
                await User.findOneAndUpdate(
                    { phone },
                    { $set: { active: true, activatedAt: new Date() }},
                    { upsert: true, session }
                );
            });
            return true;
        } finally {
            await session.endSession();
        }
    } catch (error) {
        console.error('❌ Erreur validation:', error.message);
        return false;
    }
}

async function isAuthorized(phone) {
    try {
        const user = await User.findOne({ phone, active: true }).lean();
        if (!user?.activatedAt) return false;
        
        const isValid = (Date.now() - user.activatedAt.getTime()) < CONFIG.USAGE_DURATION;
        if (!isValid) {
            await User.updateOne({ phone }, { $set: { active: false }});
            return false;
        }
        return true;
    } catch (error) {
        console.error('❌ Erreur autorisation:', error.message);
        return false;
    }
}

// Configuration client optimisée pour Render
async function initializeClient() {
    try {
        // Créer dossier session si nécessaire
        const sessionPath = path.join(process.cwd(), '.wwebjs_auth');
        try {
            await fs.access(sessionPath);
        } catch {
            await fs.mkdir(sessionPath, { recursive: true });
        }
        
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: 'bot-session',
                dataPath: sessionPath
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
                    '--disable-features=VizDisplayCompositor',
                    '--single-process',
                    '--no-zygote'
                ]
            },
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
            }
        });
        
        botState.client = client;
        return client;
    } catch (error) {
        console.error('❌ Erreur initialisation client:', error.message);
        throw error;
    }
}

// Événements client optimisés
function setupClientEvents(client) {
    client.on('qr', async (qr) => {
        try {
            console.log('📱 QR généré');
            const qrData = await QRCode.toDataURL(qr, { 
                width: 400, 
                margin: 2,
                color: { dark: '#000000', light: '#FFFFFF' }
            });
            botState.currentQR = qrData.split(',')[1];
            
            // Auto-expiration QR
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
        console.log('🔐 Authentifié');
        botState.currentQR = null;
    });

    client.on('ready', async () => {
        botState.isReady = true;
        botState.currentQR = null;
        botState.reconnectAttempts = 0;
        botState.lastActivity = Date.now();
        
        console.log('🎉 BOT PRÊT!');
        console.log(`📱 Admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`);
        
        // Notification admin avec retry
        setTimeout(async () => {
            try {
                await client.sendMessage(CONFIG.ADMIN_NUMBER, 
                    `🎉 *BOT EN LIGNE*\n✅ Connecté avec succès\n🕒 ${new Date().toLocaleString('fr-FR')}\n🌐 Hébergé sur Render`);
            } catch (error) {
                console.log('⚠️ Notification admin échouée:', error.message);
            }
        }, 3000);
    });

    client.on('auth_failure', async (msg) => {
        console.error('❌ Échec auth:', msg);
        botState.isReady = false;
        await attemptReconnect();
    });

    client.on('disconnected', async (reason) => {
        console.log('🔌 Déconnecté:', reason);
        botState.isReady = false;
        
        if (reason !== 'LOGOUT' && reason !== 'NAVIGATION') {
            await attemptReconnect();
        }
    });

    // Rejet automatique des appels
    client.on('call', async (call) => {
        try {
            await call.reject();
            console.log(`📞 Appel rejeté: ${call.from}`);
            
            setTimeout(async () => {
                try {
                    await client.sendMessage(call.from, 
                        '🤖 *Bot automatique*\n❌ Appels non supportés\n✅ Messages texte uniquement\n\n📋 `/help` pour aide');
                } catch (e) {}
            }, 2000);
        } catch (error) {
            console.error('❌ Erreur appel:', error.message);
        }
    });

    // Traitement messages optimisé
    client.on('message', async (message) => {
        if (!botState.isReady || !message.body || message.type !== 'chat') return;
        
        try {
            const text = message.body.trim();
            
            // Réponse automatique pour messages non-commandes
            if (!text.startsWith('/')) {
                if (text.length < 50 && !text.includes('🤖')) {
                    setTimeout(async () => {
                        try {
                            await message.reply('🤖 Tapez `/help` pour les commandes');
                        } catch (e) {}
                    }, 2000);
                }
                return;
            }
            
            const contact = await message.getContact();
            if (!contact || contact.isMe) return;
            
            const userPhone = contact.id._serialized;
            const cmd = text.toLowerCase();
            
            console.log(`📨 ${userPhone.replace('@c.us', '')}: ${cmd.substring(0, 50)}`);
            botState.lastActivity = Date.now();
            
            // Commandes admin
            if (userPhone === CONFIG.ADMIN_NUMBER) {
                await handleAdminCommands(message, cmd, text);
                return;
            }
            
            // Activation utilisateur
            if (cmd.startsWith('/activate ')) {
                await handleActivation(message, text, userPhone);
                return;
            }
            
            // Vérifier autorisation
            if (!(await isAuthorized(userPhone))) {
                await message.reply(`🔒 *Accès requis*\n\n📞 Contact: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\n🔑 Puis: \`/activate VOTRE-CODE\``);
                return;
            }
            
            // Commandes utilisateur autorisé
            await handleUserCommands(message, cmd, text, userPhone, contact);
            
        } catch (error) {
            console.error('❌ Erreur message:', error.message);
            try {
                await message.reply('❌ Erreur temporaire');
            } catch (e) {}
        }
    });
}

// Gestionnaires de commandes
async function handleAdminCommands(message, cmd, text) {
    try {
        if (cmd.startsWith('/gencode ')) {
            const number = text.substring(9).trim();
            if (!number) {
                await message.reply('❌ Usage: `/gencode [numéro]`');
                return;
            }
            
            const targetPhone = number.includes('@') ? number : `${number}@c.us`;
            const code = await generateCode(targetPhone);
            await message.reply(`✅ *CODE GÉNÉRÉ*\n👤 ${number}\n🔑 \`${code}\`\n⏰ Valide 24h`);
            
        } else if (cmd === '/stats') {
            const [totalUsers, activeUsers, totalCodes, totalGroups] = await Promise.all([
                User.countDocuments(),
                User.countDocuments({ active: true }),
                Code.countDocuments(),
                Group.countDocuments()
            ]);
            
            await message.reply(`📊 *STATS*\n👥 Total: ${totalUsers}\n✅ Actifs: ${activeUsers}\n🔑 Codes: ${totalCodes}\n📢 Groupes: ${totalGroups}`);
            
        } else if (cmd === '/help') {
            await message.reply('🤖 *ADMIN*\n• `/gencode [num]` - Créer code\n• `/stats` - Statistiques\n• `/help` - Aide');
        }
    } catch (error) {
        await message.reply('❌ Erreur admin');
    }
}

async function handleActivation(message, text, userPhone) {
    try {
        const inputCode = text.substring(10).trim();
        if (!inputCode) {
            await message.reply('❌ Usage: `/activate XXXX-XXXX`');
            return;
        }
        
        if (await validateCode(userPhone, inputCode)) {
            const expiry = new Date(Date.now() + CONFIG.USAGE_DURATION).toLocaleDateString('fr-FR');
            await message.reply(`🎉 *ACTIVÉ!*\n📅 Expire: ${expiry}\n\n*Commandes:*\n• \`/broadcast [msg]\`\n• \`/addgroup\`\n• \`/status\`\n• \`/help\``);
        } else {
            await message.reply('❌ Code invalide ou expiré');
        }
    } catch (error) {
        await message.reply('❌ Erreur activation');
    }
}

async function handleUserCommands(message, cmd, text, userPhone, contact) {
    try {
        if (cmd === '/status') {
            const user = await User.findOne({ phone: userPhone }).lean();
            const remaining = Math.ceil((user.activatedAt.getTime() + CONFIG.USAGE_DURATION - Date.now()) / (24 * 60 * 60 * 1000));
            const groupCount = await Group.countDocuments({ addedBy: userPhone });
            await message.reply(`📊 *STATUT*\n🟢 Actif\n📅 ${remaining} jours\n📢 ${groupCount} groupes`);
            
        } else if (cmd === '/addgroup') {
            const chat = await message.getChat();
            if (!chat.isGroup) {
                await message.reply('❌ Uniquement dans les groupes!');
                return;
            }
            
            const existing = await Group.findOne({ groupId: chat.id._serialized });
            if (existing) {
                await message.reply('ℹ️ Groupe déjà enregistré');
            } else {
                await Group.create({
                    groupId: chat.id._serialized,
                    name: chat.name || 'Groupe sans nom',
                    addedBy: userPhone
                });
                await message.reply(`✅ Groupe ajouté: *${chat.name}*`);
            }
            
        } else if (cmd.startsWith('/broadcast ')) {
            await handleBroadcast(message, text, userPhone, contact);
            
        } else if (cmd === '/help') {
            await message.reply('🤖 *COMMANDES*\n• `/broadcast [msg]` - Diffuser\n• `/addgroup` - Ajouter groupe\n• `/status` - Mon statut\n• `/help` - Aide');
        }
    } catch (error) {
        await message.reply('❌ Erreur commande');
    }
}

async function handleBroadcast(message, text, userPhone, contact) {
    try {
        const msg = text.substring(11).trim();
        if (!msg) {
            await message.reply('❌ Usage: `/broadcast [message]`');
            return;
        }
        
        const userGroups = await Group.find({ addedBy: userPhone }).lean();
        if (userGroups.length === 0) {
            await message.reply('❌ Aucun groupe!\nUtilisez `/addgroup` d\'abord');
            return;
        }
        
        await message.reply(`🚀 Diffusion vers ${userGroups.length} groupes...`);
        
        let success = 0, failed = 0;
        const senderName = contact.pushname || 'Utilisateur';
        
        for (const group of userGroups) {
            try {
                const fullMsg = `📢 *Diffusion*\n👤 ${senderName}\n🕒 ${new Date().toLocaleString('fr-FR')}\n\n${msg}`;
                await botState.client.sendMessage(group.groupId, fullMsg);
                success++;
                await new Promise(resolve => setTimeout(resolve, 2000)); // Délai anti-spam
            } catch (error) {
                failed++;
                console.error(`❌ Groupe ${group.name}:`, error.message);
            }
        }
        
        await message.reply(`📊 *RÉSULTAT*\n✅ Succès: ${success}\n❌ Échecs: ${failed}`);
    } catch (error) {
        await message.reply('❌ Erreur diffusion');
    }
}

// Reconnexion avec backoff exponentiel
async function attemptReconnect() {
    if (botState.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Trop de tentatives - arrêt reconnexion');
        return;
    }
    
    botState.reconnectAttempts++;
    const delay = CONFIG.RECONNECT_DELAY * Math.pow(2, botState.reconnectAttempts - 1);
    
    console.log(`🔄 Reconnexion ${botState.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS} dans ${delay/1000}s`);
    
    setTimeout(async () => {
        try {
            if (!botState.isReady && botState.client) {
                console.log('🔄 Tentative reconnexion...');
                await botState.client.initialize();
            }
        } catch (error) {
            console.error('❌ Échec reconnexion:', error.message);
            await attemptReconnect();
        }
    }, delay);
}

// Surveillance santé
setInterval(async () => {
    if (botState.isReady && botState.client) {
        try {
            const state = await botState.client.getState();
            if (state !== 'CONNECTED') {
                console.log('⚠️ État client:', state);
                botState.isReady = false;
                await attemptReconnect();
            }
        } catch (error) {
            console.error('❌ Vérification santé:', error.message);
            botState.isReady = false;
            await attemptReconnect();
        }
    }
}, 90000); // Vérifier toutes les 90s

// Nettoyage périodique
setInterval(async () => {
    try {
        const expired = await Code.deleteMany({ 
            expiresAt: { $lt: new Date() }
        });
        if (expired.deletedCount > 0) {
            console.log(`🧹 ${expired.deletedCount} codes expirés supprimés`);
        }
    } catch (error) {
        console.error('❌ Erreur nettoyage:', error.message);
    }
}, 3600000); // Nettoyer toutes les heures

// Démarrage serveur
function startServer() {
    if (!botState.server) {
        botState.server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
            console.log(`🌐 Server: http://0.0.0.0:${CONFIG.PORT}`);
        });
        
        // Gestion timeout serveur
        botState.server.timeout = 30000;
        botState.server.keepAliveTimeout = 5000;
    }
}

// Gestion arrêt propre
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM reçu - arrêt propre...');
    await gracefulShutdown();
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT reçu - arrêt propre...');
    await gracefulShutdown();
});

async function gracefulShutdown() {
    try {
        if (botState.isReady && botState.client) {
            await botState.client.sendMessage(CONFIG.ADMIN_NUMBER, '🛑 Bot arrêté - redémarrage...');
            await botState.client.destroy();
        }
        if (botState.server) {
            botState.server.close();
        }
        await mongoose.disconnect();
        console.log('✅ Arrêt propre terminé');
        process.exit(0);
    } catch (error) {
        console.error('❌ Erreur arrêt:', error.message);
        process.exit(1);
    }
}

// Gestion erreurs globales
process.on('uncaughtException', (error) => {
    console.error('❌ Exception non gérée:', error.message);
    if (!botState.isReady) {
        setTimeout(() => attemptReconnect(), 5000);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rejetée:', reason);
});

// Fonction principale
async function startBot() {
    console.log('🚀 DÉMARRAGE BOT WHATSAPP');
    console.log('🌐 Hébergement: Render gratuit');
    console.log('💾 Base: MongoDB Atlas');
    
    // Connexion MongoDB avec retry
    let mongoConnected = false;
    for (let i = 0; i < 3; i++) {
        mongoConnected = await connectMongo();
        if (mongoConnected) break;
        console.log(`🔄 Retry MongoDB ${i + 1}/3...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    if (!mongoConnected) {
        console.error('❌ MongoDB inaccessible - arrêt');
        process.exit(1);
    }
    
    // Démarrer serveur
    startServer();
    
    try {
        // Initialiser WhatsApp client
        const client = await initializeClient();
        setupClientEvents(client);
        
        console.log('🔐 Initialisation WhatsApp...');
        await client.initialize();
        
    } catch (error) {
        console.error('❌ Erreur initialisation:', error.message);
        setTimeout(() => attemptReconnect(), 10000);
    }
}

// Lancement avec gestion d'erreur
startBot().catch(error => {
    console.error('❌ Erreur fatale:', error.message);
    setTimeout(() => process.exit(1), 2000);
});
