require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { Resend } = require('resend');

const { testDatabaseConnection, getPool } = require('./config/database');
const { initDatabase } = require('./database/init');

/* =========================
AUTH ROUTES
========================= */

const authModule = require('./routes/auth');
const authRoutes = authModule.router || authModule;

const app = express();
const PORT = process.env.PORT || 4000;

/* =========================
RESEND
========================= */

function createEmailClient() {
if (!process.env.RESEND_API_KEY) {
throw new Error(
'La variable RESEND_API_KEY n’est pas configurée.'
);
}

return new Resend(process.env.RESEND_API_KEY);
}

/* =========================
CORS
========================= */

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

```
await db.query('SELECT 1');

const tableCheck = await db.query(`
  SELECT to_regclass('public.registration_requests') AS table_name
`);

const emailConfigured = Boolean(
  process.env.RESEND_API_KEY &&
  process.env.EMAIL_FROM
);

res.json({
  ok: true,
  authRoutes: 'loaded',
  database: 'connected',
  registrationRequestsTable:
    tableCheck.rows[0].table_name
      ? 'exists'
      : 'missing',
  email: emailConfigured
    ? 'configured'
    : 'missing'
});
```

} catch (error) {
console.error('Erreur test-auth:', error);

```
res.status(500).json({
  ok: false,
  error: error.message
});
```

}
});

/* =========================
DATABASE
========================= */

app.get('/health', async (_req, res) => {
try {
const database = await testDatabaseConnection();

```
res.json({
  ok: true,
  service: 'sellflow-backend',
  version: '2.1.0',
  database: database.connected
    ? 'connected'
    : 'disconnected',
  time: new Date().toISOString()
});
```

} catch (error) {
console.error('Erreur PostgreSQL:', error);

```
res.status(500).json({
  ok: false,
  service: 'sellflow-backend',
  version: '2.1.0',
  database: 'disconnected',
  error: 'Connexion à la base de données impossible'
});
```

}
});

/* =========================
ENVOI EMAIL AVEC RESEND
========================= */

async function sendTestEmail() {
const resend = createEmailClient();

if (!process.env.EMAIL_FROM) {
throw new Error(
'La variable EMAIL_FROM n’est pas configurée.'
);
}

if (!process.env.EMAIL_USER) {
throw new Error(
'La variable EMAIL_USER n’est pas configurée.'
);
}

const { data, error } = await resend.emails.send({
from: process.env.EMAIL_FROM,
to: [process.env.EMAIL_USER],
subject: 'Test SellFlow AI',

```
text:
  'Félicitations ! SellFlow AI peut maintenant envoyer des emails.',

html: `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8">
    <title>Test SellFlow AI</title>
  </head>

  <body style="
    margin: 0;
    padding: 0;
    background: #f3f4f6;
    font-family: Arial, sans-serif;
  ">

    <div style="
      max-width: 600px;
      margin: 40px auto;
      padding: 30px;
      background: #ffffff;
      color: #111827;
      border-radius: 12px;
    ">

      <h2>SellFlow AI</h2>

      <p style="font-size: 18px;">
        Félicitations 🎉
      </p>

      <p>
        L'envoi d'emails depuis le backend
        fonctionne correctement.
      </p>

      <p>
        Votre serveur SellFlow AI peut maintenant
        communiquer avec le service d'envoi d'emails.
      </p>

    </div>

  </body>
  </html>
`
```

});

if (error) {
throw new Error(
error.message || JSON.stringify(error)
);
}

return data.id;
}

/* =========================
TEST EMAIL
========================= */

app.get('/test-email', async (_req, res) => {
try {
const messageId = await sendTestEmail();

```
res.json({
  ok: true,
  message: 'Email de test envoyé.',
  messageId
});
```

} catch (error) {
console.error('Erreur email:', error);

```
res.status(500).json({
  ok: false,
  error: 'Impossible d’envoyer l’email.',
  details: error.message || null
});
```

}
});

/* =========================
ROOT
========================= */

app.get('/', (_req, res) => {
res.json({
name: 'SellFlow AI API',
status: 'online',
version: '2.1.0',

```
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
```

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

```
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
```

} catch (error) {
console.error(
'Impossible de démarrer SellFlow:',
error
);

```
process.exit(1);
```

}
}

startServer();
