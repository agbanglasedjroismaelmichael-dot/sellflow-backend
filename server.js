require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { testDatabaseConnection } = require('./config/database');
const { initDatabase } = require('./database/init');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
  })
);

app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  try {
    const database = await testDatabaseConnection();

    res.json({
      ok: true,
      service: 'sellflow-backend',
      version: '2.0.0',
      database: database.connected ? 'connected' : 'disconnected',
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

app.get('/', (_req, res) => {
  res.json({
    name: 'SellFlow AI API',
    status: 'online',
    version: '2.0.0'
  });
});

app.use((_req, res) => {
  res.status(404).json({
    error: 'Route introuvable'
  });
});

app.use((err, _req, res, _next) => {
  console.error('Erreur serveur:', err);

  res.status(500).json({
    error: 'Erreur serveur'
  });
});

async function startServer() {
  try {
    console.log('Connexion à PostgreSQL...');

    await testDatabaseConnection();

    console.log('PostgreSQL connecté.');

    console.log('Initialisation de la base de données...');

    await initDatabase();

    console.log('Base de données prête.');

    app.listen(PORT, () => {
      console.log(`SellFlow API démarrée sur le port ${PORT}`);
    });
  } catch (error) {
    console.error('Impossible de démarrer SellFlow:', error);
    process.exit(1);
  }
}

startServer();
