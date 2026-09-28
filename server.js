require('dotenv').config();

const express = require('express');
const cors = require('cors');

const database = require('./config/database');
const databaseInit = require('./database/init');

const authRoutes = require('./routes/auth');
const chariowRoutes = require('./routes/chariow');
const paymentsRoutes = require('./routes/payments');
const webhooksRoutes = require('./routes/webhooks');

/* =========================================================
CONFIGURATION
========================================================= */

const app = express();

const PORT = Number(process.env.PORT) || 4000;
const API_VERSION = '2.3.4';

/* =========================================================
SUBSCRIPTIONS
========================================================= */

let subscriptionRoutes = null;
let startSubscriptionReminderWorker = null;

try {
subscriptionRoutes = require('./routes/subscriptions');

console.log('✅ routes/subscriptions.js chargé.');
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
}
} catch (error) {
console.log(
'ℹ️ services/subscriptions.js non installé.'
);
}

/* =========================================================
CORS
========================================================= */

const allowedOrigins = [
'https://sellflowic.netlify.app',
'https://sellflowme.netlify.app',

'http://localhost:3000',
'http://localhost:5173',

'http://127.0.0.1:3000',
'http://127.0.0.1:5173'
];

if (process.env.FRONTEND_URL) {
const frontendUrl = process.env.FRONTEND_URL
.trim()
.replace(//+$/, '');

if (
frontendUrl &&
!allowedOrigins.includes(frontendUrl)
) {
allowedOrigins.push(frontendUrl);
}
}

const uniqueAllowedOrigins = [
...new Set(
allowedOrigins
.filter(Boolean)
.map((origin) =>
origin
.trim()
.replace(//+$/, '')
)
)
];

console.log(
'🌐 CORS:',
uniqueAllowedOrigins
);

/* =========================================================
CORS OPTIONS
========================================================= */

const corsOptions = {
origin(origin, callback) {

```
/*
 * Requêtes sans Origin :
 * Render, curl, Postman, etc.
 */

if (!origin) {
  return callback(null, true);
}

const normalizedOrigin = origin
  .trim()
  .replace(/\/+$/, '');

/*
 * Développement local
 */

if (
  process.env.NODE_ENV !== 'production' &&
  (
    normalizedOrigin.startsWith(
      'http://localhost:'
    ) ||
    normalizedOrigin.startsWith(
      'http://127.0.0.1:'
    )
  )
) {
  return callback(null, true);
}

/*
 * Production
 */

if (
  uniqueAllowedOrigins.includes(
    normalizedOrigin
  )
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
```

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

credentials: true,

optionsSuccessStatus: 204,

maxAge: 86400
};

app.use(cors(corsOptions));

/* =========================================================
OPTIONS
========================================================= */

app.options(
'*',
cors(corsOptions)
);

/* =========================================================
WEBHOOKS
========================================================= */

/*

* Les webhooks sont montés avant express.json()
* pour préserver le traitement éventuel du body brut.
  */

app.use(
'/webhooks',
webhooksRoutes
);

/* =========================================================
BODY PARSERS
========================================================= */

app.use(
express.json({
limit: '1mb'
})
);

app.use(
express.urlencoded({
extended: true,
limit: '1mb'
})
);

/* =========================================================
ROOT
========================================================= */

app.get(
'/',
function (req, res) {

```
return res.json({

  name: 'SellFlow AI API',

  status: 'online',

  version: API_VERSION,

  emailService: 'disabled',

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

    chariow:
      '/chariow',

    subscriptions:
      subscriptionRoutes
        ? '/subscriptions'
        : 'non installé',

    payments:
      '/payments',

    webhooks:
      '/webhooks'
  }
});
```

}
);

/* =========================================================
HEALTH
========================================================= */

app.get(
'/health',
async function (req, res) {

```
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
    '❌ Health database error:',
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
```

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
SUBSCRIPTIONS
========================================================= */

if (subscriptionRoutes) {

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

```
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
      tableCheck.rows[0] &&
      tableCheck.rows[0].table_name
        ? 'exists'
        : 'missing',

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

    cors:
      uniqueAllowedOrigins
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
```

}
);

/* =========================================================
404
========================================================= */

app.use(
function (req, res) {

```
return res.status(404).json({

  ok: false,

  error:
    'ROUTE_NOT_FOUND',

  message:
    'Route introuvable.'
});
```

}
);

/* =========================================================
ERROR HANDLER
========================================================= */

app.use(
function (err, req, res, next) {

```
console.error(
  '❌ Erreur serveur:',
  err
);

if (res.headersSent) {
  return next(err);
}

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
```

}
);

/* =========================================================
START SERVER
========================================================= */

async function startServer() {

try {

```
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
   DATABASE CONNECTION
----------------------------------- */

console.log(
  '🔌 Connexion PostgreSQL...'
);

await database.testDatabaseConnection();

console.log(
  '✅ PostgreSQL connecté.'
);

/* -----------------------------------
   DATABASE INITIALIZATION
----------------------------------- */

console.log(
  '🗄️ Initialisation de la base...'
);

await databaseInit.initDatabase();

console.log(
  '✅ Base de données prête.'
);

/* -----------------------------------
   SERVER
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
        '📦 API:',
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
        '📧 Resend: DÉSACTIVÉ'
      );

      console.log(
        '📧 Service email externe: DÉSACTIVÉ'
      );

      console.log(
        '🌐 Frontend:',
        'https://sellflowic.netlify.app'
      );

      if (subscriptionRoutes) {

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
         SUBSCRIPTION WORKER
      ----------------------------- */

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

/* -----------------------------------
   SERVER ERROR
----------------------------------- */

server.on(
  'error',
  function (error) {

    console.error(
      '❌ Erreur du serveur HTTP:',
      error
    );

    if (
      error.code === 'EADDRINUSE'
    ) {

      console.error(
        `❌ Le port ${PORT} est déjà utilisé.`
      );
    }

    process.exit(1);
  }
);
```

} catch (error) {

```
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
```

}
}

/* =========================================================
PROCESS ERRORS
========================================================= */

process.on(
'unhandledRejection',
function (reason) {

```
console.error(
  '❌ Unhandled Promise Rejection:',
  reason
);
```

}
);

process.on(
'uncaughtException',
function (error) {

```
console.error(
  '❌ Uncaught Exception:',
  error
);

process.exit(1);
```

}
);

/* =========================================================
START
========================================================= */

startServer();
