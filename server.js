require('dotenv').config();

const express = require('express');
const cors = require('cors');
const Resend = require('resend').Resend;

const database = require('./config/database');
const databaseInit = require('./database/init');

const authRoutes = require('./routes/auth');
const chariowRoutes = require('./routes/chariow');

/* =========================
   ROUTES PAIEMENTS
========================= */

const paymentsRoutes = require('./routes/payments');

/* =========================
   ROUTES WEBHOOKS
========================= */

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

const API_VERSION = '2.3.0';


/* =========================
   CORS
========================= */

app.use(
  cors({
    origin: '*'
  })
);


/*
 * IMPORTANT
 *
 * Le webhook Moneroo doit recevoir le corps
 * brut de la requête pour vérifier sa signature.
 *
 * Donc la route /webhooks/moneroo est montée
 * AVANT express.json().
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
   ROOT
========================= */

app.get(
  '/',
  function (req, res) {
    res.json({
      name: 'SellFlow AI API',

      status: 'online',

      version: API_VERSION,

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

      res.json({

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
        'Erreur PostgreSQL:',
        error
      );

      res.status(500).json({

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
=========================
