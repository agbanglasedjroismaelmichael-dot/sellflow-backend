require('dotenv').config();

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const { testDatabaseConnection, getPool } = require('./config/database');
const { initDatabase } = require('./database/init');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
  })
);

app.use(express.json({ limit: '1mb' }));

/* =========================
   AUTHENTIFICATION
========================= */

app.use('/auth', authRoutes);

/* =========================
   TEST AUTHENTIFICATION
========================= */

app.get('/test-auth', async (_req, res) => {
  try {
    const db = getPool();

    await db.query('SELECT 1');

    const tableCheck = await db.query(`
      SELECT to_regclass('public.registration_requests') AS table_name
    `);

    const gmailConfigured = Boolean(
      process.env.EMAIL_USER &&
      process.env.EMAIL_APP_PASSWORD
    );

    res.json({
      ok: true,
      authRoutes: 'loaded',
      database: 'connected',
      registrationRequestsTable:
        tableCheck.rows[0].table_name
          ? 'exists'
          : 'missing',
      gmail: gmailConfigured
        ? 'configured'
        : 'missing'
    });

  } catch (error) {
    console.error('Erreur test-auth:', error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================
   DATABASE
========================= */

app.get('/health', async (_req, res) => {
  try {
    const database = await testDatabaseConnection();

    res.json({
      ok: true,
      service: 'sellflow-backend',
      version: '2.0.0',
      database: database.connected
        ? 'connected'
        : 'disconnected',
      time: new Date().toISOString()
    });

  } catch (error) {
    console.error('Erreur PostgreSQL:', error);

    res.status(500).json({
      ok: false,
      service: 'sellflow-backend',
      version: '2.0.0',
      database: 'disconnected',
      error: 'Connexion à la base de données impossible'
    });
  }
});

/* =========================
   EMAIL GMAIL
========================= */

function createEmailTransporter() {
  if (
    !process.env.EMAIL_USER ||
    !process.env.EMAIL_APP_PASSWORD
  ) {
    throw new Error(
      'Les variables EMAIL_USER et EMAIL_APP_PASSWORD ne sont pas configurées.'
    );
  }

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

async function sendTestEmail() {
  const transporter = createEmailTransporter();

  const info = await transporter.sendMail({
    from:
      process.env.EMAIL_FROM ||
      process.env.EMAIL_USER,

    to: process.env.EMAIL_USER,

    subject: 'Test SellFlow AI',

    text:
      'Félicitations ! SellFlow AI peut maintenant envoyer des emails.',

    html: `
      <div style="
        font-family:Arial,sans-serif;
        max-width:600px;
        margin:auto;
        padding:30px
      ">
        <h2>SellFlow AI</h2>

        <p>Félicitations 🎉</p>

        <p>
          L'envoi d'emails depuis le backend
          fonctionne correctement.
        </p>
      </div>
    `
  });

  return info.messageId;
}

/* =========================
   TEST GMAIL
========================= */

app.get('/test-email', async (_req, res) => {
  try {
    const messageId = await sendTestEmail();

    res.json({
      ok: true,
      message: 'Email de test envoyé.',
      messageId
    });

  } catch (error) {
    console.error('Erreur email:', error);

    res.status(500).json({
      ok: false,
      error: 'Impossible d’envoyer l’email.',
      details:
        process.env.NODE_ENV === 'production'
          ? undefined
          : error.message
    });
  }
});

/* =========================
   ROOT
========================= */

app.get('/', (_req, res) => {
  res.json({
    name: 'SellFlow AI API',
    status: 'online',
    version: '2.0.0',

    endpoints: {
      health: 'GET /health',

      testAuth: 'GET /test-auth',

      testEmail: 'GET /test-email',

      registerRequestCode:
        'POST /auth/register/request-code',

      registerVerifyCode:
        'POST /auth/register/verify-code',

      registerComplete:
        'POST /auth/register/complete',

      login:
        'POST /auth/login',

      me:
        'GET /auth/me'
    }
  });
});

/* =========================
   404
========================= */

app.use((_req, res) => {
  res.status(404).json({
    error: 'Route introuvable'
  });
});

/* =========================
   ERROR HANDLER
========================= */

app.use((err, _req, res, _next) => {
  console.error('Erreur serveur:', err);

  res.status(500).json({
    error: 'Erreur serveur'
  });
});

/* =========================
   START SERVER
========================= */

async function startServer() {
  try {
    console.log('Connexion à PostgreSQL...');

    await testDatabaseConnection();

    console.log('PostgreSQL connecté.');

    console.log('Initialisation de la base de données...');

    await initDatabase();

    console.log('Base de données prête.');

    app.listen(PORT, () => {
      console.log(
        `SellFlow API démarrée sur le port ${PORT}`
      );

      console.log(`Port: ${PORT}`);
    });

  } catch (error) {
    console.error(
      'Impossible de démarrer SellFlow:',
      error
    );

    process.exit(1);
  }
}

startServer();
