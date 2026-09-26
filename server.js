require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const { testDatabaseConnection, getPool } = require('./config/database');
const { initDatabase } = require('./database/init');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
origin: '*'
}));

app.use(express.json({ limit: '1mb' }));

/* =========================
DATABASE
========================= */

app.get('/health', async (req, res) => {
try {
const database = await testDatabaseConnection();

```
res.json({
  ok: true,
  service: 'sellflow-backend',
  version: '2.1.0',
  database: database.connected ? 'connected' : 'disconnected',
  time: new Date().toISOString()
});
```

} catch (error) {
console.error(error);

```
res.status(500).json({
  ok: false,
  service: 'sellflow-backend',
  version: '2.1.0',
  database: 'disconnected',
  error: error.message
});
```

}
});

/* =========================
TEST AUTH
========================= */

app.get('/test-auth', async (req, res) => {
try {
const db = getPool();

```
await db.query('SELECT 1');

const tableCheck = await db.query(
  "SELECT to_regclass('public.registration_requests') AS table_name"
);

res.json({
  ok: true,
  authRoutes: 'not-loaded',
  database: 'connected',
  registrationRequestsTable:
    tableCheck.rows[0].table_name
      ? 'exists'
      : 'missing',
  email:
    process.env.RESEND_API_KEY && process.env.EMAIL_FROM
      ? 'configured'
      : 'missing'
});
```

} catch (error) {
console.error(error);

```
res.status(500).json({
  ok: false,
  error: error.message
});
```

}
});

/* =========================
RESEND
========================= */

app.get('/test-email', async (req, res) => {
try {
if (!process.env.RESEND_API_KEY) {
return res.status(500).json({
ok: false,
error: 'RESEND_API_KEY manquante dans Render.'
});
}

```
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

const resend = new Resend(process.env.RESEND_API_KEY);

const result = await resend.emails.send({
  from: process.env.EMAIL_FROM,
  to: [process.env.EMAIL_USER],
  subject: 'Test SellFlow AI',
  text: 'Félicitations ! SellFlow AI peut envoyer des emails.'
});

if (result.error) {
  return res.status(500).json({
    ok: false,
    error: result.error.message || 'Erreur Resend',
    details: result.error
  });
}

res.json({
  ok: true,
  message: 'Email envoyé avec succès.',
  messageId: result.data ? result.data.id : null
});
```

} catch (error) {
console.error('Erreur Resend:', error);

```
res.status(500).json({
  ok: false,
  error: 'Impossible d’envoyer l’email.',
  details: error.message
});
```

}
});

/* =========================
ROOT
========================= */

app.get('/', (req, res) => {
res.json({
name: 'SellFlow AI API',
status: 'online',
version: '2.1.0',
endpoints: {
health: 'GET /health',
testAuth: 'GET /test-auth',
testEmail: 'GET /test-email'
}
});
});

/* =========================
404
========================= */

app.use((req, res) => {
res.status(404).json({
error: 'Route introuvable'
});
});

/* =========================
START
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
  console.log(`SellFlow API démarrée sur le port ${PORT}`);
});
```

} catch (error) {
console.error('Impossible de démarrer SellFlow:', error);
process.exit(1);
}
}

startServer();
