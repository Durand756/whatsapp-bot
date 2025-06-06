const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const express = require('express');

// Configuration optimisée
const CONFIG = {
    ADMIN_NUMBER: '237651104356@c.us',
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://username:password@cluster.mongodb.net/whatsappbot?retryWrites=true&w=majority',
    USAGE_DURATION: 30 * 24 * 60 * 60 * 1000, // 30 jours
    PORT: process.env.PORT || 3000,
    CODE_EXPIRY: 24 * 60 * 60 * 1000, // 24h
    QR_TIMEOUT: 120000, // 2 minutes
    RECONNECT_DELAY: 20000, // 20s
    MAX_RECONNECT_ATTEMPTS: 5
};

// État global
let botState = {
    isReady: false,
    currentQR: null,
    server: null,
    reconnectAttempts: 0,
    lastActivity: Date.now(),
    client: null,
    mongoStore: null
};

// Schémas MongoDB
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

// Connexion MongoDB avec retry
async function connectMongo() {
    try {
        await mongoose.connect(CONFIG.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
            maxPoolSize: 15,
            bufferCommands: false,
            retryWrites: true
        });
        console.log('✅ MongoDB connecté');
        
        // Créer le store pour les sessions WhatsApp
        botState.mongoStore = new MongoStore({ mongoose: mongoose });
        console.log('✅ MongoStore initialisé');
        return true;
    } catch (error) {
        console.error('❌ Erreur MongoDB:', error.message);
        return false;
    }
}

// Interface web
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
    const status = botState.isReady ? 
        `<h1 class="online">✅ Bot En Ligne</h1>
         <p>🕒 Dernière activité: ${new Date(botState.lastActivity).toLocaleString('fr-FR')}</p>
         <p>📊 Session sauvegardée dans MongoDB</p>
         <p>🔄 Pas de reconnexion nécessaire</p>` :
        botState.currentQR ? 
        `<h1>📱 Scanner le QR Code</h1>
         <div class="qr-container">
         <img src="data:image/png;base64,${botState.currentQR}" alt="QR Code">
         </div>
         <p>⏰ QR valide 2 minutes</p>
         <p>💾 Session sera sauvegardée</p>
         <script>setTimeout(()=>location.reload(),30000)</script>` :
        `<h1 class="loading">🔄 Initialisation...</h1>
         <p>Tentative ${botState.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS}</p>
         <p>💾 Vérification session MongoDB...</p>
         <script>setTimeout(()=>location.reload(),10000)</script>`;
    
    res.send(`<!DOCTYPE html>
    <html><head>
        <title>WhatsApp Bot - Render</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            *{margin:0;padding:0;box-sizing:border-box}
            body{font-family:'Segoe UI',sans-serif;text-align:center;
                 background:linear-gradient(135deg,#25D366 0%,#128C7E 100%);
                 color:white;min-height:100vh;display:flex;
                 flex-direction:column;justify-content:center;align-items:center;
                 background-attachment:fixed}
            .container{background:rgba(255,255,255,0.15);padding:40px;
                      border-radius:25px;backdrop-filter:blur(15px);
                      box-shadow:0 15px 50px rgba(0,0,0,0.3);max-width:550px;
                      margin:20px;border:1px solid rgba(255,255,255,0.2)}
            h1{margin:25px 0;font-size:2em;text-shadow:3px 3px 6px rgba(0,0,0,0.4);
               font-weight:700}
            .online{color:#4CAF50;animation:pulse 2s infinite}
            .loading{color:#FF9800} .qr-container{background:white;padding:20px;
            border-radius:20px;display:inline-block;margin:25px 0;
            box-shadow:0 10px 30px rgba(0,0,0,0.2)}
            img{max-width:300px;height:auto;border-radius:10px}
            p{font-size:16px;margin:15px 0;opacity:0.95;line-height:1.6}
            @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}
            @media(max-width:600px){
                .container{margin:15px;padding:30px}
                h1{font-size:1.6em} img{max-width:280px}
            }
        </style>
    </head><body>
        <div class="container">${status}</div>
        <p style="opacity:0.8;font-size:14px;margin-top:20px">
        🤖 WhatsApp Bot avec Session Persistante</p>
    </body></html>`);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: botState.isReady ? 'online' : 'offline',
        sessionStored: !!botState.mongoStore,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        reconnectAttempts: botState.reconnectAttempts
    });
});

// Utilitaires base de données
async function generateCode(phone) {
    try {
        const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
        let code = '';
        for (let i = 0; i < 8; i++) {
            if (i === 4) code += '-';
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        
        await Code.findOneAndUpdate(
            { phone },
            { $set: { code, created: new Date(), used: false, 
                     expiresAt: new Date(Date.now() + CONFIG.CODE_EXPIRY) }},
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

// Configuration client avec RemoteAuth + MongoDB
async function initializeClient() {
    try {
        if (!botState.mongoStore) {
            throw new Error('MongoStore non initialisé');
        }
        
        const client = new Client({
            authStrategy: new RemoteAuth({
                store: botState.mongoStore,
                clientId: 'whatsapp-bot-render',
                dataPath: './sessions/',
                backupSyncIntervalMs: 60000 // Sync toutes les minutes
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
                    '--no-zygote',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding'
                ],
                timeout: 60000
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

// Événements client
function setupClientEvents(client) {
    client.on('qr', async (qr) => {
        try {
            console.log('📱 QR Code généré - scan requis');
            const qrData = await QRCode.toDataURL(qr, { 
                width: 450, 
                margin: 3,
                color: { dark: '#000000', light: '#FFFFFF' },
                errorCorrectionLevel: 'M'
            });
            botState.currentQR = qrData.split(',')[1];
            
            // Auto-expiration QR
            setTimeout(() => {
                if (!botState.isReady) {
                    botState.currentQR = null;
                    console.log('⏰ QR Code expiré');
                }
            }, CONFIG.QR_TIMEOUT);
        } catch (error) {
            console.error('❌ Erreur QR:', error.message);
        }
    });

    client.on('authenticated', (session) => {
        console.log('🔐 Authentifié - session sauvegardée dans MongoDB');
        botState.currentQR = null;
    });

    client.on('remote_session_saved', () => {
        console.log('💾 Session sauvegardée dans MongoDB');
    });

    client.on('ready', async () => {
        botState.isReady = true;
        botState.currentQR = null;
        botState.reconnectAttempts = 0;
        botState.lastActivity = Date.now();
        
        console.log('🎉 BOT PRÊT ET CONNECTÉ!');
        console.log(`📱 Admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}`);
        console.log('💾 Session persistante activée');
        
        // Notification admin
        setTimeout(async () => {
            try {
                await client.sendMessage(CONFIG.ADMIN_NUMBER, 
                    `🎉 *BOT EN LIGNE*\n✅ Connecté avec session persistante\n💾 Stockage: MongoDB\n🕒 ${new Date().toLocaleString('fr-FR')}\n🌐 Hébergé sur Render\n\n🔄 Plus de reconnexion nécessaire!`);
            } catch (error) {
                console.log('⚠️ Notification admin échouée:', error.message);
            }
        }, 5000);
    });

    client.on('auth_failure', async (msg) => {
        console.error('❌ Échec authentification:', msg);
        botState.isReady = false;
        // Supprimer session corrompue
        try {
            await botState.mongoStore.delete({ session: 'whatsapp-bot-render' });
            console.log('🗑️ Session corrompue supprimée');
        } catch (e) {}
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
                        '🤖 *Bot automatique*\n❌ Appels non supportés\n✅ Messages texte uniquement\n\n📋 Tapez `/help` pour l\'aide');
                } catch (e) {}
            }, 3000);
        } catch (error) {
            console.error('❌ Erreur gestion appel:', error.message);
        }
    });

    // Traitement messages
    client.on('message', async (message) => {
        if (!botState.isReady || !message.body || message.type !== 'chat') return;
        
        try {
            const text = message.body.trim();
            
            // Auto-réponse pour non-commandes
            if (!text.startsWith('/')) {
                if (text.length < 50 && !text.includes('🤖') && Math.random() < 0.3) {
                    setTimeout(async () => {
                        try {
                            await message.reply('🤖 Tapez `/help` pour voir les commandes disponibles');
                        } catch (e) {}
                    }, 3000);
                }
                return;
            }
            
            const contact = await message.getContact();
            if (!contact || contact.isMe) return;
            
            const userPhone = contact.id._serialized;
            const cmd = text.toLowerCase();
            
            console.log(`📨 Message de ${userPhone.replace('@c.us', '')}: ${cmd.substring(0, 40)}...`);
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
                await message.reply(`🔒 *Accès Requis*\n\n📞 Contactez l'admin: ${CONFIG.ADMIN_NUMBER.replace('@c.us', '')}\n🔑 Puis utilisez: \`/activate VOTRE-CODE\`\n\n💡 Code valide 24h`);
                return;
            }
            
            // Commandes utilisateur autorisé
            await handleUserCommands(message, cmd, text, userPhone, contact);
            
        } catch (error) {
            console.error('❌ Erreur traitement message:', error.message);
            try {
                await message.reply('❌ Erreur temporaire, réessayez');
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
                await message.reply('❌ Usage: `/gencode [numéro]`\nExemple: `/gencode 237651234567`');
                return;
            }
            
            const targetPhone = number.includes('@') ? number : `${number}@c.us`;
            const code = await generateCode(targetPhone);
            await message.reply(`✅ *CODE GÉNÉRÉ*\n👤 Numéro: ${number}\n🔑 Code: \`${code}\`\n⏰ Valide: 24 heures\n📝 Usage: \`/activate ${code}\``);
            
        } else if (cmd === '/stats') {
            const [totalUsers, activeUsers, totalCodes, usedCodes, totalGroups] = await Promise.all([
                User.countDocuments(),
                User.countDocuments({ active: true }),
                Code.countDocuments(),
                Code.countDocuments({ used: true }),
                Group.countDocuments()
            ]);
            
            await message.reply(`📊 *STATISTIQUES*\n👥 Utilisateurs total: ${totalUsers}\n✅ Utilisateurs actifs: ${activeUsers}\n🔑 Codes générés: ${totalCodes}\n✅ Codes utilisés: ${usedCodes}\n📢 Groupes enregistrés: ${totalGroups}\n\n🕒 ${new Date().toLocaleString('fr-FR')}`);
            
        } else if (cmd === '/help') {
            await message.reply('🤖 *COMMANDES ADMIN*\n• `/gencode [numéro]` - Générer un code d\'activation\n• `/stats` - Voir les statistiques\n• `/help` - Afficher cette aide\n\n💾 Session persistante activée');
        }
    } catch (error) {
        await message.reply('❌ Erreur dans la commande admin');
        console.error('❌ Erreur admin:', error.message);
    }
}

async function handleActivation(message, text, userPhone) {
    try {
        const inputCode = text.substring(10).trim();
        if (!inputCode) {
            await message.reply('❌ Usage: `/activate XXXX-XXXX`\nExemple: `/activate AB12-CD34`');
            return;
        }
        
        if (await validateCode(userPhone, inputCode)) {
            const expiry = new Date(Date.now() + CONFIG.USAGE_DURATION).toLocaleDateString('fr-FR');
            await message.reply(`🎉 *ACTIVATION RÉUSSIE!*\n📅 Expire le: ${expiry}\n\n📋 *Commandes disponibles:*\n• \`/broadcast [message]\` - Diffuser un message\n• \`/addgroup\` - Ajouter ce groupe\n• \`/status\` - Voir mon statut\n• \`/help\` - Aide\n\n✅ Vous pouvez maintenant utiliser le bot!`);
        } else {
            await message.reply('❌ *Code invalide ou expiré*\n\n💡 Vérifiez:\n• Le code est correct\n• Il n\'a pas expiré (24h)\n• Il n\'a pas déjà été utilisé');
        }
    } catch (error) {
        await message.reply('❌ Erreur lors de l\'activation');
        console.error('❌ Erreur activation:', error.message);
    }
}

async function handleUserCommands(message, cmd, text, userPhone, contact) {
    try {
        if (cmd === '/status') {
            const user = await User.findOne({ phone: userPhone }).lean();
            const remaining = Math.ceil((user.activatedAt.getTime() + CONFIG.USAGE_DURATION - Date.now()) / (24 * 60 * 60 * 1000));
            const groupCount = await Group.countDocuments({ addedBy: userPhone });
            await message.reply(`📊 *MON STATUT*\n🟢 Statut: Actif\n📅 Jours restants: ${remaining}\n📢 Mes groupes: ${groupCount}\n🕒 Activé le: ${user.activatedAt.toLocaleDateString('fr-FR')}`);
            
        } else if (cmd === '/addgroup') {
            const chat = await message.getChat();
            if (!chat.isGroup) {
                await message.reply('❌ Cette commande fonctionne uniquement dans les groupes!\n💡 Ajoutez le bot à un groupe et réessayez');
                return;
            }
            
            const existing = await Group.findOne({ groupId: chat.id._serialized });
            if (existing) {
                await message.reply(`ℹ️ Ce groupe est déjà enregistré\n📢 Nom: *${chat.name}*\n📅 Ajouté le: ${existing.addedAt.toLocaleDateString('fr-FR')}`);
            } else {
                await Group.create({
                    groupId: chat.id._serialized,
                    name: chat.name || 'Groupe sans nom',
                    addedBy: userPhone
                });
                await message.reply(`✅ *Groupe ajouté avec succès!*\n📢 Nom: *${chat.name}*\n👤 Ajouté par vous\n\n💡 Utilisez \`/broadcast [message]\` pour diffuser`);
            }
            
        } else if (cmd.startsWith('/broadcast ')) {
            await handleBroadcast(message, text, userPhone, contact);
            
        } else if (cmd === '/help') {
            const groupCount = await Group.countDocuments({ addedBy: userPhone });
            await message.reply(`🤖 *COMMANDES DISPONIBLES*\n\n• \`/broadcast [message]\` - Diffuser un message vers vos groupes\n• \`/addgroup\` - Ajouter ce groupe à votre liste\n• \`/status\` - Voir votre statut et groupes\n• \`/help\` - Afficher cette aide\n\n📊 Vous avez ${groupCount} groupe(s) enregistré(s)`);
        }
    } catch (error) {
        await message.reply('❌ Erreur dans la commande');
        console.error('❌ Erreur commande utilisateur:', error.message);
    }
}

async function handleBroadcast(message, text, userPhone, contact) {
    try {
        const msg = text.substring(11).trim();
        if (!msg) {
            await message.reply('❌ Usage: `/broadcast [votre message]`\nExemple: `/broadcast Salut tout le monde!`');
            return;
        }
        
        const userGroups = await Group.find({ addedBy: userPhone }).lean();
        if (userGroups.length === 0) {
            await message.reply('❌ Aucun groupe enregistré!\n💡 Allez dans un groupe et tapez `/addgroup` d\'abord');
            return;
        }
        
        await message.reply(`🚀 Diffusion en cours vers ${userGroups.length} groupe(s)...\n⏳ Veuillez patienter...`);
        
        let success = 0, failed = 0;
        const senderName = contact.pushname || contact.name || 'Utilisateur';
        
        for (const group of userGroups) {
            try {
                const fullMsg = `📢 *MESSAGE DIFFUSÉ*\n👤 Envoyé par: ${senderName}\n🕒 Le: ${new Date().toLocaleString('fr-FR')}\n\n${msg}`;
                await botState.client.sendMessage(group.groupId, fullMsg);
                success++;
                console.log(`✅ Message envoyé au groupe: ${group.name}`);
                
                // Délai anti-spam progressif
                await new Promise(resolve => setTimeout(resolve, 2000 + (success * 500)));
            } catch (error) {
                failed++;
                console.error(`❌ Erreur groupe ${group.name}:`, error.message);
            }
        }
        
        await message.reply(`📊 *RÉSULTAT DE LA DIFFUSION*\n✅ Succès: ${success} groupe(s)\n❌ Échecs: ${failed} groupe(s)\n\n${success > 0 ? '🎉 Message diffusé avec succès!' : '😔 Aucun message envoyé'}`);
    } catch (error) {
        await message.reply('❌ Erreur lors de la diffusion');
        console.error('❌ Erreur broadcast:', error.message);
    }
}

// Reconnexion intelligente
async function attemptReconnect() {
    if (botState.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
        console.error(`❌ Maximum de tentatives atteint (${CONFIG.MAX_RECONNECT_ATTEMPTS}) - arrêt des reconnexions`);
        return;
    }
    
    botState.reconnectAttempts++;
    const delay = CONFIG.RECONNECT_DELAY * Math.pow(1.5, botState.reconnectAttempts - 1);
    
    console.log(`🔄 Tentative de reconnexion ${botState.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS} dans ${Math.round(delay/1000)}s`);
    
    setTimeout(async () => {
        try {
            if (!botState.isReady && botState.client) {
                console.log('🔄 Reconnexion en cours...');
                await botState.client.destroy();
                botState.client = null;
                
                // Réinitialiser le client
                const newClient = await initializeClient();
                setupClientEvents(newClient);
                await newClient.initialize();
            }
        } catch (error) {
            console.error('❌ Échec reconnexion:', error.message);
            await attemptReconnect();
        }
    }, delay);
}

// Surveillance de santé améliorée
setInterval(async () => {
    if (botState.isReady && botState.client) {
        try {
            const state = await botState.client.getState();
            if (state !== 'CONNECTED') {
                console.log(`⚠️ État client anormal: ${state}`);
                botState.isReady = false;
                await attemptReconnect();
            } else {
                // Reset du compteur si tout va bien
                if (botState.reconnectAttempts > 0) {
                    botState.reconnectAttempts = 0;
                    console.log('✅ Connexion stable - compteur reset');
                }
            }
        } catch (error) {
            console.error('❌ Erreur vérification santé:', error.message);
            botState.isReady = false;
            await attemptReconnect();
        }
    }
}, 120000); // Vérification toutes les 2 minutes

// Nettoyage périodique optimisé
setInterval(async () => {
    try {
        const [expiredCodes, inactiveUsers] = await Promise.all([
            Code.deleteMany({ expiresAt: { $lt: new Date() }}),
            User.updateMany(
                { 
                    active: true, 
                    activatedAt: { $lt: new Date(Date.now() - CONFIG.USAGE_DURATION) }
                },
                { $set: { active: false }}
            )
        ]);
        
        if (expiredCodes.deletedCount > 0 || inactiveUsers.modifiedCount > 0) {
            console.log(`🧹 Nettoyage: ${expiredCodes.deletedCount} codes expirés, ${inactiveUsers.modifiedCount} utilisateurs désactivés`);
        }
    } catch (error) {
        console.error('❌ Erreur nettoyage:', error.message);
    }
}, 7200000); // Nettoyer toutes les 2 heures

// Démarrage serveur
function startServer() {
    if (!botState.server) {
        botState.server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
            console.log(`🌐 Serveur démarré sur le port ${CONFIG.PORT}`);
            console.log('🔗 Interface web accessible');
        });
        
        // Configuration serveur optimisée pour Render
        botState.server.timeout = 60000; // 1 minute
        botState.server.keepAliveTimeout = 10000; // 10 secondes
        botState.server.headersTimeout = 65000; // Légèrement plus que timeout
    }
}

// Gestion arrêt propre
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM reçu - arrêt propre en cours...');
    await gracefulShutdown();
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT reçu - arrêt propre en cours...');
    await gracefulShutdown();
});

async function gracefulShutdown() {
    try {
        console.log('🔄 Démarrage de l\'arrêt propre...');
        
        // Notifier l'admin si possible
        if (botState.isReady && botState.client) {
            try {
                await botState.client.sendMessage(CONFIG.ADMIN_NUMBER, 
                    '🛑 *Bot en cours d\'arrêt*\n🔄 Redémarrage automatique prévu\n💾 Session sauvegardée dans MongoDB');
                console.log('📱 Admin notifié de l\'arrêt');
            } catch (e) {
                console.log('⚠️ Impossible de notifier l\'admin');
            }
        }
        
        // Fermer le client WhatsApp proprement
        if (botState.client) {
            console.log('📱 Fermeture du client WhatsApp...');
            await botState.client.destroy();
            botState.client = null;
        }
        
        // Fermer le serveur web
        if (botState.server) {
            console.log('🌐 Fermeture du serveur web...');
            botState.server.close();
            botState.server = null;
        }
        
        // Fermer la connexion MongoDB
        if (mongoose.connection.readyState === 1) {
            console.log('💾 Fermeture de la connexion MongoDB...');
            await mongoose.disconnect();
        }
        
        console.log('✅ Arrêt propre terminé avec succès');
        process.exit(0);
    } catch (error) {
        console.error('❌ Erreur pendant l\'arrêt:', error.message);
        process.exit(1);
    }
}

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
    console.error('❌ Exception non gérée:', error.message);
    console.error('Stack:', error.stack);
    
    // Tentative de redémarrage si le bot n'est pas prêt
    if (!botState.isReady) {
        console.log('🔄 Tentative de récupération...');
        setTimeout(() => {
            attemptReconnect();
        }, 10000);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rejetée non gérée:', reason);
    console.error('Promise:', promise);
});

// Keep-alive pour Render (évite la mise en veille)
setInterval(async () => {
    try {
        // Ping santé interne
        const healthCheck = {
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            botReady: botState.isReady,
            mongoConnected: mongoose.connection.readyState === 1
        };
        
        console.log(`💗 Keep-alive: ${healthCheck.uptime}s uptime, ${healthCheck.memory}MB RAM, Bot: ${healthCheck.botReady ? 'ON' : 'OFF'}`);
        
        // Auto-restart si problème détecté
        if (!healthCheck.botReady && !healthCheck.mongoConnected) {
            console.log('⚠️ Problème détecté - tentative de redémarrage');
            await attemptReconnect();
        }
    } catch (error) {
        console.error('❌ Erreur keep-alive:', error.message);
    }
}, 300000); // Toutes les 5 minutes

// Fonction principale optimisée
async function startBot() {
    console.log('🚀 =================================');
    console.log('🚀 DÉMARRAGE BOT WHATSAPP AVANCÉ');
    console.log('🚀 =================================');
    console.log('🌐 Plateforme: Render (gratuit)');
    console.log('💾 Base de données: MongoDB Atlas');
    console.log('📱 Session: Persistante dans MongoDB');
    console.log('🔄 Auto-reconnexion: Activée');
    
    // Connexion MongoDB avec plusieurs tentatives
    let mongoConnected = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
        console.log(`📡 Tentative connexion MongoDB ${attempt}/5...`);
        mongoConnected = await connectMongo();
        if (mongoConnected) break;
        
        if (attempt < 5) {
            const delay = Math.min(5000 * attempt, 20000);
            console.log(`⏳ Retry dans ${delay/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    if (!mongoConnected) {
        console.error('❌ ERREUR FATALE: MongoDB inaccessible après 5 tentatives');
        console.error('🔧 Vérifiez votre MONGODB_URI dans les variables d\'environnement');
        process.exit(1);
    }
    
    // Démarrer le serveur web
    console.log('🌐 Démarrage du serveur web...');
    startServer();
    
    try {
        // Initialiser le client WhatsApp avec session persistante
        console.log('📱 Initialisation du client WhatsApp...');
        console.log('💾 Vérification de session existante dans MongoDB...');
        
        const client = await initializeClient();
        setupClientEvents(client);
        
        console.log('🔐 Démarrage de l\'authentification...');
        console.log('📡 Connexion à WhatsApp Web...');
        
        await client.initialize();
        
    } catch (error) {
        console.error('❌ Erreur critique lors de l\'initialisation:', error.message);
        console.error('Stack:', error.stack);
        
        // Tentative de récupération
        console.log('🔄 Tentative de récupération dans 15 secondes...');
        setTimeout(() => {
            attemptReconnect();
        }, 15000);
    }
}

// Point d'entrée avec gestion d'erreur robuste
if (require.main === module) {
    startBot().catch(error => {
        console.error('❌ ERREUR FATALE AU DÉMARRAGE:', error.message);
        console.error('Stack complète:', error.stack);
        
        // Dernier recours: redémarrage après délai
        console.log('💀 Redémarrage d\'urgence dans 30 secondes...');
        setTimeout(() => {
            process.exit(1);
        }, 30000);
    });
}

// Export pour tests (optionnel)
module.exports = {
    startBot,
    CONFIG,
    botState
};
