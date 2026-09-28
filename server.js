require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const database = require('./config/database');
const databaseInit = require('./database/init');

const authRoutes = require('./routes/auth');
const chariowRoutes = require('./routes/chariow');
const paymentsRoutes = require('./routes/payments');
const webhooksRoutes = require('./routes/webhooks');

/* =========================
   SUBSCRIPTIONS
========================= */

let subscriptionRoutes = null;
let startSubscriptionReminderWorker = null;

try {
  subscriptionRoutes = require('./routes/subscriptions');
} catch (error) {
  console.log(
    'ℹ️ routes/subscriptions.js non installé pour le moment.'
  );
}

try {
  const subscriptionService =
    require('./services/subscriptions');

  if (
    subscriptionService &&
    typeof subscriptionService.startSubscriptionReminderWorker ===
      'function'
  ) {
    startSubscriptionReminderWorker =
      subscriptionService.startSubscriptionReminderWorker;
  }
} catch (error) {
  console.log(
    'ℹ️ services/subscriptions.js non installé pour le moment.'
  );
}

/* =========================
   APP
========================= */

const app = express();

const PORT =
  process.env.PORT || 4000;

const API_VERSION = '2.3.1';

/* =========================
   CORS
========================= */

/*
 * Domaines autorisés pour le frontend SellFlow.
 *
 * IMPORTANT :
 * Le nouveau frontend Netlify est :
 * https://sellflowic.netlify.app
 *
 * L'ancien frontend reste autorisé :
 * https://sellflowme.netlify.app
 */

const allowedOrigins = [
  'https://sellflowic.netlify.app',
  'https://sellflowme.netlify.app',

  // Développement local
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173'
];

/*
 * Permet éventuellement d'ajouter une origine
 * depuis les variables d'environnement Render.
 *
 * Exemple Render :
 * FRONTEND_URL=https://sellflowic.netlify.app
 */

if (process.env.FRONTEND_URL) {
  const frontendUrl =
    process.env.FRONTEND_URL.trim().replace(/\/$/, '');

  if (
    frontendUrl &&
    !allowedOrigins.includes(frontendUrl)
  ) {
    allowedOrigins.push(frontendUrl);
  }
}

/*
 * Supprime les doublons.
 */
const uniqueAllowedOrigins = [
  ...new Set(allowedOrigins)
];

console.log(
  '🌐 Origines CORS autorisées:',
  uniqueAllowedOrigins
);

/*
 * Configuration CORS.
 *
 * Le middleware cors gère également les requêtes
 * OPTIONS / preflight utilisées par fetch().
 */

const corsOptions = {
  origin: function (origin, callback) {

    /*
     * Requêtes sans Origin :
     * Postman, curl, certains health checks,
     * services internes, etc.
     */
    if (!origin) {
      return callback(null, true);
    }

    /*
     * En développement, on autorise les origines
     * afin de faciliter les tests locaux.
     */
    if (
      process.env.NODE_ENV !== 'production'
    ) {
      return callback(null, true);
    }

    /*
     * Vérification de l'origine autorisée.
     */
    if (
      uniqueAllowedOrigins.includes(origin)
    ) {
      return callback(null, true);
    }

    console.warn(
      '⚠️ Origine CORS refusée:',
      origin
    );

    return callback(
      new Error(
        'Origine CORS non autorisée: ' +
        origin
      )
    );
  },

  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin'
  ],

  exposedHeaders: [
    'Content-Length',
    'Content-Type'
  ],

  credentials: true,

  optionsSuccessStatus: 204,

  maxAge: 86400
};

/*
 * CORS global.
 *
 * IMPORTANT :
 * Cette ligne doit être placée AVANT les routes.
 * Elle permet notamment de traiter :
 *
 * OPTIONS /auth/login
 * OPTIONS /auth/register/...
 * OPTIONS /subscriptions/me
 * OPTIONS /chariow/...
 * etc.
 */

app.use(
  cors(corsOptions)
);

/*
 * Réponse supplémentaire pour les requêtes OPTIONS.
 *
 * Le middleware cors principal gère déjà le preflight.
 * Cette route permet de s'assurer qu'une requête OPTIONS
 * reçue par l'application est correctement terminée.
 */

app.use(
  function (req, res, next) {

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  }
);

/*
 * IMPORTANT :
 *
 * Le webhook Moneroo est monté AVANT express.json()
 * afin que la route puisse récupérer le corps brut
 * si la vérification de signature en a besoin.
 */

/* =========================
   WEBHOOKS MONEROO
========================= */

app.use(
  '/webhooks',
  webhooksRoutes
);

/* =========================
   JSON
========================= */

app.use(
  express.json({
    limit: '1mb'
  })
);

/* =========================
   URLENCODED
========================= */

app.use(
  express.urlencoded({
    extended: true,
    limit: '1mb'
  })
);

/* =========================
   ROOT
========================= */

app.get(
  '/',
  function (req, res) {
    res.json({
      name: 'SellFlow AI API',

      status: 'online',

      version: API_VERSION,

      frontend: {
        current:
          'https://sellflowic.netlify.app',

        legacy:
          'https://sellflowme.netlify.app'
      },

      endpoints: {
        health:
          'GET /health',

        auth:
          '/auth',

        testAuth:
          'GET /test-auth',

        testEmail:
          'GET /test-email',

        chariow: {
          stores:
            'GET /chariow/stores',

          addStore:
            'POST /chariow/stores',

          getStore:
            'GET /chariow/stores/:id',

          updateStore:
            'PUT /chariow/stores/:id',

          activateStore:
            'POST /chariow/stores/:id/activate',

          activeStore:
            'GET /chariow/stores/active/current',

          deleteStore:
            'DELETE /chariow/stores/:id',

          syncStatus:
            'POST /chariow/stores/:id/sync-status'
        },

        subscriptions:
          subscriptionRoutes
            ? '/subscriptions'
            : 'non installé',

        payments: {
          offers:
            'GET /payments/offers',

          create:
            'POST /payments/create',

          get:
            'GET /payments/:paymentId'
        },

        webhooks: {
          moneroo:
            'POST /webhooks/moneroo'
        }
      }
    });
  }
);

/* =========================
   HEALTH
========================= */

app.get(
  '/health',
  async function (req, res) {
    try {

      const result =
        await database.testDatabaseConnection();

      return res.json({
        ok: true,

        service:
          'sellflow-backend',

        version:
          API_VERSION,

        database:
          result.connected
            ? 'connected'
            : 'disconnected',

        time:
          new Date().toISOString()
      });

    } catch (error) {

      console.error(
        '❌ Erreur PostgreSQL:',
        error
      );

      return res.status(500).json({
        ok: false,

        service:
          'sellflow-backend',

        version:
          API_VERSION,

        database:
          'disconnected',

        error:
          error.message
      });
    }
  }
);

/* =========================
   AUTH ROUTES
========================= */

app.use(
  '/auth',
  authRoutes
);

/* =========================
   CHARIOW MULTI-BOUTIQUES
========================= */

app.use(
  '/chariow',
  chariowRoutes
);

/* =========================
   SUBSCRIPTIONS
========================= */

if (subscriptionRoutes) {

  app.use(
    '/subscriptions',
    subscriptionRoutes
  );

}

/* =========================
   PAYMENTS
========================= */

app.use(
  '/payments',
  paymentsRoutes
);

/* =========================
   TEST AUTH / DATABASE
========================= */

app.get(
  '/test-auth',
  async function (req, res) {

    try {

      const db =
        database.getPool();

      await db.query(
        'SELECT 1'
      );

      const tableCheck =
        await db.query(`
          SELECT to_regclass(
            'public.registration_requests'
          ) AS table_name
        `);

      return res.json({
        ok: true,

        authRoutes:
          'enabled',

        database:
          'connected',

        registrationRequestsTable:
          tableCheck.rows[0].table_name
            ? 'exists'
            : 'missing',

        chariowRoutes:
          'enabled',

        subscriptionRoutes:
          subscriptionRoutes
            ? 'enabled'
            : 'not-installed',

        paymentRoutes:
          'enabled',

        monerooWebhook:
          'enabled',

        email:
          process.env.RESEND_API_KEY &&
          process.env.EMAIL_FROM &&
          process.env.EMAIL_USER
            ? 'configured'
            : 'missing',

        cors: {
          enabled: true,
          currentFrontend:
            'https://sellflowic.netlify.app',
          legacyFrontend:
            'https://sellflowme.netlify.app'
        }
      });

    } catch (error) {

      console.error(
        '❌ Erreur test-auth:',
        error
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message
      });

    }

  }
);

/* =========================
   TEST RESEND
========================= */

app.get(
  '/test-email',
  async function (req, res) {

    try {

      if (!process.env.RESEND_API_KEY) {

        return res.status(500).json({
          ok: false,

          error:
            'RESEND_API_KEY manquante dans Render.'
        });

      }

      if (!process.env.EMAIL_FROM) {

        return res.status(500).json({
          ok: false,

          error:
            'EMAIL_FROM manquante dans Render.'
        });

      }

      if (!process.env.EMAIL_USER) {

        return res.status(500).json({
          ok: false,

          error:
            'EMAIL_USER manquante dans Render.'
        });

      }

      const resend =
        new Resend(
          process.env.RESEND_API_KEY
        );

      const result =
        await resend.emails.send({

          from:
            process.env.EMAIL_FROM,

          to: [
            process.env.EMAIL_USER
          ],

          subject:
            'Test SellFlow AI',

          text:
            'Félicitations ! SellFlow AI peut maintenant envoyer des emails.'

        });

      if (result.error) {

        return res.status(500).json({

          ok: false,

          error:
            result.error.message ||
            'Erreur Resend',

          details:
            result.error

        });

      }

      return res.json({

        ok: true,

        message:
          'Email envoyé avec succès.',

        messageId:
          result.data &&
          result.data.id
            ? result.data.id
            : null

      });

    } catch (error) {

      console.error(
        '❌ Erreur Resend:',
        error
      );

      return res.status(500).json({

        ok: false,

        error:
          'Impossible d’envoyer l’email.',

        details:
          error.message || null

      });

    }

  }
);

/* =========================
   404
========================= */

app.use(
  function (req, res) {

    return res.status(404).json({

      ok: false,

      error:
        'ROUTE_NOT_FOUND',

      message:
        'Route introuvable.'

    });

  }
);

/* =========================
   ERROR HANDLER
========================= */

app.use(
  function (
    err,
    req,
    res,
    next
  ) {

    console.error(
      '❌ Erreur serveur:',
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    /*
     * Si une erreur CORS survient,
     * on renvoie une réponse JSON claire.
     */
    if (
      err &&
      typeof err.message === 'string' &&
      err.message.includes('CORS')
    ) {

      return res.status(403).json({

        ok: false,

        error:
          'CORS_ERROR',

        message:
          err.message

      });

    }

    return res.status(
      err.status || 500
    ).json({

      ok: false,

      error:
        'SERVER_ERROR',

      message:
        err.message ||
        'Erreur serveur.'

    });

  }
);

/* =========================
   START SERVER
========================= */

async function startServer() {

  try {

    console.log(
      '======================================'
    );

    console.log(
      '🚀 Démarrage de SellFlow AI...'
    );

    console.log(
      '======================================'
    );

    console.log(
      '🔌 Connexion à PostgreSQL...'
    );

    await database.testDatabaseConnection();

    console.log(
      '✅ PostgreSQL connecté.'
    );

    console.log(
      '🗄️ Initialisation de la base de données...'
    );

    await databaseInit.initDatabase();

    console.log(
      '✅ Base de données prête.'
    );

    console.log(
      '🌐 Frontend principal:',
      'https://sellflowic.netlify.app'
    );

    console.log(
      '🌐 Ancien frontend:',
      'https://sellflowme.netlify.app'
    );

    console.log(
      '🔐 CORS activé.'
    );

    app.listen(
      PORT,
      '0.0.0.0',
      function () {

        console.log(
          '======================================'
        );

        console.log(
          '✅ SellFlow API démarrée'
        );

        console.log(
          '🌐 Port: ' + PORT
        );

        console.log(
          '📦 Version API: ' +
          API_VERSION
        );

        console.log(
          '💳 Paiements Moneroo: ACTIVÉS'
        );

        console.log(
          '🔔 Webhook Moneroo: ACTIVÉ'
        );

        console.log(
          '🛍️ Chariow multi-boutiques: ACTIVÉ'
        );

        if (subscriptionRoutes) {

          console.log(
            '📅 Abonnements: ACTIVÉS'
          );

        } else {

          console.log(
            '📅 Abonnements: en attente'
          );

        }

        console.log(
          '🔐 CORS: sellflowic.netlify.app AUTORISÉ'
        );

        console.log(
          '======================================'
        );

        /*
         * Worker des rappels d'abonnement.
         */

        if (
          typeof startSubscriptionReminderWorker ===
          'function'
        ) {

          try {

            startSubscriptionReminderWorker();

            console.log(
              '⏰ Worker des abonnements démarré.'
            );

          } catch (workerError) {

            console.error(
              '❌ Erreur démarrage worker abonnement:',
              workerError
            );

          }

        }

      }
    );

  } catch (error) {

    console.error(
      '======================================'
    );

    console.error(
      '❌ IMPOSSIBLE DE DÉMARRER SELLFLOW'
    );

    console.error(
      error
    );

    console.error(
      '======================================'
    );

    process.exit(1);

  }

}

startServer();
