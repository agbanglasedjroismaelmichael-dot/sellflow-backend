require('dotenv').config();

const express = require('express');
const cors = require('cors');
const Resend = require('resend').Resend;

const database = require('./config/database');
const databaseInit = require('./database/init');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 4000;

/* =========================
   CORS
========================= */

app.use(
  cors({
    origin: '*'
  })
);

app.use(express.json({ limit: '1mb' }));

/* =========================
   ROOT
========================= */

app.get('/', function (req, res) {
  res.json({
    name: 'SellFlow AI API',
    status: 'online',
    version: '2.1.0',
    endpoints: {
      health: 'GET /health',
      auth: '/auth',
      testAuth: 'GET /test-auth',
      testEmail: 'GET /test-email'
    }
  });
});

/* =========================
   HEALTH
========================= */

app.get('/health', async function (req, res) {
  try {
    const result = await database.testDatabaseConnection();

    res.json({
      ok: true,
      service: 'sellflow-backend',
      version: '2.1.0',
      database: result.connected ? 'connected' : 'disconnected',
      time: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erreur PostgreSQL:', error);

    res.status(500).json({
      ok: false,
      service: 'sellflow-backend',
      version: '2.1.0',
      database: 'disconnected',
      error: error.message
    });
  }
});

/* =========================
   AUTH ROUTES
========================= */

app.use('/auth', authRoutes);

/* =========================
   TEST AUTH / DATABASE
========================= */

app.get('/test-auth', async function (req, res) {
  try {
    const db = database.getPool();

    await db.query('SELECT 1');

    const tableCheck = await db.query(
      "SELECT to_regclass('public.registration_requests') AS table_name"
    );

    res.json({
      ok: true,
      authRoutes: 'enabled',
      database: 'connected',
      registrationRequestsTable:
        tableCheck.rows[0].table_name
          ? 'exists'
          : 'missing',
      email:
        process.env.RESEND_API_KEY &&
        process.env.EMAIL_FROM &&
        process.env.EMAIL_USER
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
   TEST RESEND
========================= */

app.get('/test-email', async function (req, res) {
  try {
    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'RESEND_API_KEY manquante dans Render.'
      });
    }

    if (!process.env.EMAIL_FROM) {
      return res.status(500).json({
        ok: false,
        error: 'EMAIL_FROM manquante dans Render.'
      });
    }

    if (!process.env.EMAIL_USER) {
      return res.status(500).json({
        ok: false,
        error: 'EMAIL_USER manquante dans Render.'
      });
    }

    const resend = new Resend(
      process.env.RESEND_API_KEY
    );

    const result = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: [process.env.EMAIL_USER],
      subject: 'Test SellFlow AI',
      text:
        'Félicitations ! SellFlow AI peut maintenant envoyer des emails.'
    });

    if (result.error) {
      return res.status(500).json({
        ok: false,
        error:
          result.error.message ||
          'Erreur Resend',
        details: result.error
      });
    }

    res.json({
      ok: true,
      message: 'Email envoyé avec succès.',
      messageId:
        result.data && result.data.id
          ? result.data.id
          : null
    });
  } catch (error) {
    console.error('Erreur Resend:', error);

    res.status(500).json({
      ok: false,
      error: 'Impossible d’envoyer l’email.',
      details: error.message || null
    });
  }
});

/* =========================
   404
========================= */

app.use(function (req, res) {
  res.status(404).json({
    error: 'Route introuvable'
  });
});

/* =========================
   ERROR HANDLER
========================= */

app.use(function (err, req, res, next) {
  console.error('Erreur serveur:', err);

  res.status(500).json({
    error: 'Erreur serveur',
    details: err.message || null
  });
});

/* =========================
   START SERVER
========================= */

async function startServer() {
  try {
    console.log('Connexion à PostgreSQL...');

    await database.testDatabaseConnection();

    console.log('PostgreSQL connecté.');

    console.log('Initialisation de la base de données...');

    await databaseInit.initDatabase();

    console.log('Base de données prête.');

    app.listen(PORT, function () {
      console.log(
        'SellFlow API démarrée sur le port ' +
        PORT
      );

      console.log('Port: ' + PORT);
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
