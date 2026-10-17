require('dotenv').config();

const express = require('express');
const cors = require('cors');

const database = require('./config/database');
const databaseInit = require('./database/init');

const authRoutes = require('./routes/auth');
const chariowRoutes = require('./routes/chariow');
const paymentsRoutes = require('./routes/payments');
const webhooksRoutes = require('./routes/webhooks');

const app = express();

const PORT = Number(process.env.PORT) || 4000;
const API_VERSION = '2.3.8';

/* =========================================================
   SUBSCRIPTIONS
========================================================= */

let subscriptionRoutes = null;
let startSubscriptionReminderWorker = null;

try {
  subscriptionRoutes = require('./routes/subscriptions');

  console.log(
    '✅ routes/subscriptions.js chargé.'
  );
} catch (error) {
  console.log(
    'ℹ️ routes/subscriptions.js non installé.'
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

    console.log(
      '✅ Worker abonnements disponible.'
    );
  }
} catch (error) {
  console.log(
    'ℹ️ services/subscriptions.js non installé.'
  );
}

/* =========================================================
   WHATSAPP
========================================================= */

let whatsappRoutes = null;

try {
  whatsappRoutes = require('./routes/whatsapp');

  console.log(
    '✅ routes/whatsapp.js chargé.'
  );
} catch (error) {
  console.log(
    'ℹ️ routes/whatsapp.js non installé : ' +
    error.message
  );
}

let startWhatsappQueueWorker = null;

try {
  startWhatsappQueueWorker =
    require('./services/whatsapp-queue').startWorker;
} catch (error) {
  console.log(
    'ℹ️ services/whatsapp-queue.js non installé : ' +
    error.message
  );
}

/* =========================================================
   CORS
========================================================= */

const allowedOrigins = [
  /* FRONTEND ACTUEL */
  'https://sellflowix.netlify.app',
  'https://www.sellflowix.netlify.app',

  /* ANCIENS FRONTENDS CONSERVÉS */
  'https://sellflowic.netlify.app',
  'https://www.sellflowic.netlify.app',
  'https://sellflowme.netlify.app',
  'https://www.sellflowme.netlify.app',

  /* LOCALHOST */
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173'
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(
    process.env.FRONTEND_URL
  );
}

const normalizedAllowedOrigins = [
  ...new Set(
    allowedOrigins
      .filter(Boolean)
      .map(function (origin) {
        return String(origin)
          .trim()
          .replace(/\/+$/, '')
          .toLowerCase();
      })
  )
];

console.log(
  '🌐 Origines CORS autorisées:',
  normalizedAllowedOrigins
);

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  const normalizedOrigin =
    String(origin)
      .trim()
      .replace(/\/+$/, '')
      .toLowerCase();

  /* ORIGINES EXPLICITEMENT AUTORISÉES */
  if (
    normalizedAllowedOrigins.includes(
      normalizedOrigin
    )
  ) {
    return true;
  }

  /* AUTRES FRONTENDS NETLIFY SELLFLOW */
  try {
    const url =
      new URL(normalizedOrigin);

    if (
      url.protocol === 'https:' &&
      url.hostname.endsWith(
        '.netlify.app'
      )
    ) {
      const hostname =
        url.hostname.toLowerCase();

      if (
        hostname.includes('sellflowix') ||
        hostname.includes('sellflowic') ||
        hostname.includes('sellflowme')
      ) {
        return true;
      }
    }
  } catch (error) {
    return false;
  }

  /* LOCALHOST */
  if (
    normalizedOrigin.startsWith(
      'http://localhost:'
    ) ||
    normalizedOrigin.startsWith(
      'http://127.0.0.1:'
    )
  ) {
    return true;
  }

  return false;
}

const corsOptions = {
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(
        null,
        true
      );
    }

    console.warn(
      '⚠️ Origine CORS non reconnue:',
      origin || 'Aucune origine'
    );

    return callback(
      null,
      false
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

app.use(
  cors(corsOptions)
);

/* =========================================================
   WEBHOOKS MONEROO
========================================================= */

app.use(
  '/webhooks',
  webhooksRoutes
);

/* =========================================================
   BODY PARSERS
========================================================= */

app.use(
  express.json({
    limit: '10mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '10mb'
  })
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  '/',
  function (req, res) {
    return res.json({
      name: 'SellFlow AI API',

      status: 'online',

      version: API_VERSION,

      emailService: 'disabled',

      resend: 'disabled',

      frontend: {
        current:
          'https://sellflowix.netlify.app',

        legacy:
          'https://sellflowic.netlify.app',

        previous:
          'https://sellflowme.netlify.app'
      },

      endpoints: {
        health:
          'GET /health',

        auth:
          '/auth',

        chariow:
          '/chariow',

        subscriptions:
          subscriptionRoutes
            ? '/subscriptions'
            : 'non installé',

        whatsapp:
          whatsappRoutes
            ? '/whatsapp'
            : 'non installé',

        payments:
          '/payments',

        webhooks:
          '/webhooks'
      }
    });
  }
);

/* =========================================================
   HEALTH
========================================================= */

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
          result &&
          result.connected
            ? 'connected'
            : 'disconnected',

        frontend:
          'https://sellflowix.netlify.app',

        time:
          new Date().toISOString()
      });
    } catch (error) {
      console.error(
        '❌ Erreur PostgreSQL:',
        error
      );

      return res.status(
        500
      ).json({
        ok: false,

        service:
          'sellflow-backend',

        version:
          API_VERSION,

        database:
          'disconnected',

        frontend:
          'https://sellflowix.netlify.app',

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   AUTH
========================================================= */

app.use(
  '/auth',
  authRoutes
);

/* =========================================================
   CHARIOW
========================================================= */

app.use(
  '/chariow',
  chariowRoutes
);

/* =========================================================
   WHATSAPP
========================================================= */

if (
  whatsappRoutes
) {
  app.use(
    '/whatsapp',
    whatsappRoutes
  );
}

/* =========================================================
   SUBSCRIPTIONS
========================================================= */

if (
  subscriptionRoutes
) {
  app.use(
    '/subscriptions',
    subscriptionRoutes
  );
}

/* =========================================================
   PAYMENTS
========================================================= */

app.use(
  '/payments',
  paymentsRoutes
);

/* =========================================================
   TEST AUTH
========================================================= */

app.get(
  '/test-auth',
  async function (req, res) {
    try {
      const db =
        database.getPool();

      await db.query(
        'SELECT 1'
      );

      return res.json({
        ok: true,

        authRoutes:
          'enabled',

        database:
          'connected',

        chariowRoutes:
          'enabled',

        paymentRoutes:
          'enabled',

        monerooWebhook:
          'enabled',

        subscriptionRoutes:
          subscriptionRoutes
            ? 'enabled'
            : 'not-installed',

        emailService:
          'disabled',

        resend:
          'disabled',

        frontend:
          'https://sellflowix.netlify.app',

        cors:
          normalizedAllowedOrigins
      });
    } catch (error) {
      console.error(
        '❌ Erreur test-auth:',
        error
      );

      return res.status(
        500
      ).json({
        ok: false,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  function (req, res) {
    return res.status(
      404
    ).json({
      ok: false,

      error:
        'ROUTE_NOT_FOUND',

      message:
        'Route introuvable.'
    });
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

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

    if (
      res.headersSent
    ) {
      return next(err);
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

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  try {
    console.log(
      '======================================'
    );

    console.log(
      '🚀 Démarrage de SellFlow AI'
    );

    console.log(
      '📦 Version API:',
      API_VERSION
    );

    console.log(
      '======================================'
    );

    /* -----------------------------------
       POSTGRESQL
    ----------------------------------- */

    console.log(
      '🔌 Connexion à PostgreSQL...'
    );

    const databaseStatus =
      await database.testDatabaseConnection();

    if (
      !databaseStatus ||
      !databaseStatus.connected
    ) {
      throw new Error(
        'Connexion PostgreSQL impossible.'
      );
    }

    console.log(
      '✅ PostgreSQL connecté.'
    );

    /* -----------------------------------
       DATABASE INIT
    ----------------------------------- */

    console.log(
      '🗄️ Initialisation de la base de données...'
    );

    await databaseInit.initDatabase();

    console.log(
      '✅ Base de données prête.'
    );

    /* -----------------------------------
       HTTP SERVER
    ----------------------------------- */

    const server =
      app.listen(
        PORT,
        '0.0.0.0',
        function () {
          console.log(
            '======================================'
          );

          console.log(
            '✅ SELLFLOW API DÉMARRÉE'
          );

          console.log(
            '🌐 Port:',
            PORT
          );

          console.log(
            '📦 Version API:',
            API_VERSION
          );

          console.log(
            '🔐 Authentification: ACTIVÉE'
          );

          console.log(
            '🛍️ Chariow: ACTIVÉ'
          );

          console.log(
            '💳 Moneroo: ACTIVÉ'
          );

          console.log(
            '🔔 Webhook Moneroo: ACTIVÉ'
          );

          console.log(
            '📧 Service email: DÉSACTIVÉ'
          );

          console.log(
            '🚫 Resend: DÉSACTIVÉ'
          );

          console.log(
            '🌐 Frontend:',
            'https://sellflowix.netlify.app'
          );

          if (
            subscriptionRoutes
          ) {
            console.log(
              '📅 Abonnements: ACTIVÉS'
            );
          } else {
            console.log(
              '📅 Abonnements: NON INSTALLÉS'
            );
          }

          console.log(
            '======================================'
          );

          /* -----------------------------
             WORKER ABONNEMENTS
          ----------------------------- */

          if (
            typeof startWhatsappQueueWorker ===
            'function'
          ) {
            startWhatsappQueueWorker().catch(
              function (queueError) {
                console.error(
                  '❌ Erreur file WhatsApp:',
                  queueError
                );
              }
            );
          }

          if (
            typeof startSubscriptionReminderWorker ===
            'function'
          ) {
            try {
              startSubscriptionReminderWorker();

              console.log(
                '⏰ Worker abonnements démarré.'
              );
            } catch (workerError) {
              console.error(
                '❌ Erreur worker abonnements:',
                workerError
              );
            }
          }
        }
      );

    server.on(
      'error',
      function (error) {
        console.error(
          '❌ Erreur serveur HTTP:',
          error
        );

        if (
          error.code ===
          'EADDRINUSE'
        ) {
          console.error(
            '❌ Le port ' +
            PORT +
            ' est déjà utilisé.'
          );
        }

        process.exit(1);
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
      '======================================'
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

/* =========================================================
   PROCESS ERRORS
========================================================= */

process.on(
  'unhandledRejection',
  function (reason) {
    console.error(
      '❌ Unhandled Promise Rejection:',
      reason
    );
  }
);

process.on(
  'uncaughtException',
  function (error) {
    console.error(
      '❌ Uncaught Exception:',
      error
    );

    process.exit(1);
  }
);

/* =========================================================
   START
========================================================= */

startServer();
