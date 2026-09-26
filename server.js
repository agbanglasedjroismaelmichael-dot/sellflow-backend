require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

// ===============================
// CORS
// ===============================

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  })
);

// ===============================
// JSON
// ===============================

app.use(express.json({ limit: '1mb' }));

// ===============================
// HEALTH CHECK
// ===============================

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'sellflow-backend',
    version: '2.0.0',
    time: new Date().toISOString()
  });
});

// ===============================
// API
// ===============================

app.get('/', (_req, res) => {
  res.json({
    name: 'SellFlow AI API',
    status: 'online',
    version: '2.0.0',
    message: 'SellFlow backend is running.'
  });
});

// ===============================
// 404
// ===============================

app.use((_req, res) => {
  res.status(404).json({
    error: 'Route introuvable'
  });
});

// ===============================
// ERREURS
// ===============================

app.use((err, _req, res, _next) => {
  console.error('Erreur serveur:', err);

  res.status(500).json({
    error: 'Erreur serveur'
  });
});

// ===============================
// START
// ===============================

app.listen(PORT, () => {
  console.log(`SellFlow API démarrée sur le port ${PORT}`);
  console.log(`Port: ${PORT}`);
});
