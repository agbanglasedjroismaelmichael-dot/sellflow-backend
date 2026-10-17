/**
 * SellFlow AI — routes WhatsApp
 * À placer dans : routes/whatsapp.js  (dossier « itinéraires » sur GitHub)
 *
 * POST   /whatsapp/pair        connexion rapide : génère le code à 8 chiffres (appareils connectés)
 * GET    /whatsapp/pair/status état du jumelage (pending / connected)
 * POST   /whatsapp/connect     vérifie chez Meta puis enregistre token + Phone Number ID
 * GET    /whatsapp/status      état de la connexion (sans jamais renvoyer le token)
 * POST   /whatsapp/relance     envoie une relance immédiatement (sans file)
 * POST   /whatsapp/queue       ajoute des relances à la file (espacées, limite par jour)
 * GET    /whatsapp/queue       état de la file
 * POST   /whatsapp/queue/pause | /resume | /cancel
 * DELETE /whatsapp/disconnect  supprime la connexion
 */

const express = require('express');

const database = require('../config/database');
const { verifyToken } = require('../utils/auth');
const whatsapp = require('../services/whatsapp');
const whatsappWeb = require('../services/whatsapp-web');
const whatsappQueue = require('../services/whatsapp-queue');

const router = express.Router();

/* ---------- Authentification (même logique que routes/chariow.js) ---------- */

function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization || '';

    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, message: 'Token manquant.' });
    }

    req.user = verifyToken(authorization.substring(7));
    return next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: 'Session invalide ou expirée.'
    });
  }
}

/* ---------- Table créée automatiquement au premier usage ---------- */

let tableReady = null;

function ensureTable() {
  if (!tableReady) {
    tableReady = database
      .getPool()
      .query(
        `
        CREATE TABLE IF NOT EXISTS whatsapp_connections (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL UNIQUE
            REFERENCES users(id) ON DELETE CASCADE,
          access_token TEXT NOT NULL,
          phone_number_id VARCHAR(100) NOT NULL,
          api_version VARCHAR(20) NOT NULL DEFAULT 'v21.0',
          display_phone_number VARCHAR(50),
          verified_name VARCHAR(255),
          quality_rating VARCHAR(50),
          connected BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        `
      )
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }

  return tableReady;
}

function clean(value, max = 500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().substring(0, max);
}

function publicConnection(row) {
  return {
    connected: !!row.connected,
    phone_number_id: row.phone_number_id,
    display_phone_number: row.display_phone_number,
    verified_name: row.verified_name,
    quality_rating: row.quality_rating,
    updated_at: row.updated_at
  };
}

/* ---------- POST /whatsapp/connect ---------- */

router.post('/connect', requireAuth, async (req, res) => {
  try {
    await ensureTable();

    const accessToken = clean(req.body.access_token, 1000);
    const phoneNumberId = clean(req.body.phone_number_id, 100);
    const apiVersion = clean(req.body.api_version, 20) || 'v21.0';

    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({
        ok: false,
        code: 'MISSING_FIELDS',
        message: 'Le token d’accès et le Phone Number ID sont obligatoires.'
      });
    }

    let info;

    try {
      info = await whatsapp.verifyCredentials({
        accessToken,
        phoneNumberId,
        apiVersion
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        code: 'WHATSAPP_VERIFY_FAILED',
        message:
          error.message ||
          'Meta a refusé ces identifiants. Vérifie le token et le Phone Number ID.'
      });
    }

    const saved = await database.getPool().query(
      `
      INSERT INTO whatsapp_connections
        (user_id, access_token, phone_number_id, api_version,
         display_phone_number, verified_name, quality_rating,
         connected, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        phone_number_id = EXCLUDED.phone_number_id,
        api_version = EXCLUDED.api_version,
        display_phone_number = EXCLUDED.display_phone_number,
        verified_name = EXCLUDED.verified_name,
        quality_rating = EXCLUDED.quality_rating,
        connected = TRUE,
        updated_at = NOW()
      RETURNING *
      `,
      [
        req.user.sub,
        accessToken,
        phoneNumberId,
        apiVersion,
        info.display_phone_number,
        info.verified_name,
        info.quality_rating
      ]
    );

    return res.json({
      ok: true,
      message: 'WhatsApp connecté.',
      connection: publicConnection(saved.rows[0])
    });
  } catch (error) {
    console.error('Erreur POST /whatsapp/connect:', error);

    return res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'Impossible d’enregistrer la connexion WhatsApp.'
    });
  }
});

/* ---------- Connexion rapide : code à 8 chiffres ---------- */

router.post('/pair', requireAuth, async (req, res) => {
  try {
    const result = await whatsappWeb.startPairing(req.user.sub, req.body.phone);

    return res.json({
      ok: true,
      code: result.code,
      message: 'Saisis ce code dans WhatsApp > Appareils connectés > Connecter un appareil > Associer avec le numéro de téléphone.'
    });
  } catch (error) {
    console.error('Erreur POST /whatsapp/pair:', error.code || '', error.message);

    return res.status(error.code ? 400 : 500).json({
      ok: false,
      code: error.code || 'PAIRING_FAILED',
      message: error.message || 'Impossible de générer le code.'
    });
  }
});

router.get('/pair/status', requireAuth, async (req, res) => {
  try {
    const st = await whatsappWeb.getStatus(req.user.sub);

    return res.json({
      ok: true,
      status: st.status,
      connected: st.status === 'connected' || st.status === 'saved',
      phone: st.phone,
      error: st.error
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: 'Impossible de lire l’état du jumelage.'
    });
  }
});

/* ---------- GET /whatsapp/status ---------- */

router.get('/status', requireAuth, async (req, res) => {
  try {
    await ensureTable();

    const result = await database
      .getPool()
      .query('SELECT * FROM whatsapp_connections WHERE user_id = $1 LIMIT 1', [
        req.user.sub
      ]);

    const web = await whatsappWeb.getStatus(req.user.sub);
    const webConnected = web.status === 'connected' || web.status === 'saved';

    if (!result.rows.length) {
      return res.json({
        ok: true,
        connected: webConnected,
        mode: webConnected ? 'pairing' : null,
        connection: webConnected ? { connected: true, display_phone_number: web.phone } : null
      });
    }

    return res.json({
      ok: true,
      connected: !!result.rows[0].connected || webConnected,
      mode: webConnected ? 'pairing' : 'meta',
      connection: publicConnection(result.rows[0])
    });
  } catch (error) {
    console.error('Erreur GET /whatsapp/status:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible de lire le statut WhatsApp.'
    });
  }
});

/* ---------- POST /whatsapp/relance ---------- */

router.post('/relance', requireAuth, async (req, res) => {
  try {
    await ensureTable();

    if (await whatsappWeb.hasSession(req.user.sub)) {
      const name = clean(req.body.name, 120) || 'client';
      const text =
        clean(req.body.message, 4000) ||
        `Bonjour ${name}, votre paiement n’a pas abouti. Répondez à ce message pour finaliser votre commande.`;

      const sentWeb = await whatsappWeb.sendText(req.user.sub, req.body.phone, text);

      return res.json({
        ok: true,
        message: 'Relance envoyée.',
        message_id: sentWeb.message_id,
        mode: sentWeb.mode
      });
    }

    const result = await database
      .getPool()
      .query('SELECT * FROM whatsapp_connections WHERE user_id = $1 LIMIT 1', [
        req.user.sub
      ]);

    const row = result.rows[0];

    if (!row || !row.connected) {
      return res.status(400).json({
        ok: false,
        code: 'WHATSAPP_NOT_CONNECTED',
        message: 'WhatsApp n’est pas connecté. Ouvre Intégrations pour le connecter.'
      });
    }

    const config = {
      accessToken: row.access_token,
      phoneNumberId: row.phone_number_id,
      apiVersion: row.api_version
    };

    const phone = clean(req.body.phone, 40);
    const template = req.body.template;

    let sent;

    if (template && template.name) {
      sent = await whatsapp.sendTemplateMessage(config, phone, template);
    } else {
      const name = clean(req.body.name, 120) || 'client';
      const message =
        clean(req.body.message, 4000) ||
        `Bonjour ${name}, votre paiement n’a pas abouti. Répondez à ce message pour finaliser votre commande.`;

      sent = await whatsapp.sendTextMessage(config, phone, message);
    }

    return res.json({
      ok: true,
      message: 'Relance envoyée.',
      message_id: sent.message_id,
      mode: sent.mode
    });
  } catch (error) {
    console.error('Erreur POST /whatsapp/relance:', error.code || '', error.message);

    const known = !!error.code;

    return res.status(known ? 400 : 500).json({
      ok: false,
      code: error.code || 'WHATSAPP_SEND_FAILED',
      message: error.message || 'Envoi WhatsApp impossible.'
    });
  }
});

/* ---------- File d'attente des relances ---------- */

router.post('/queue', requireAuth, async (req, res) => {
  try {
    await ensureTable();

    const web = await whatsappWeb.hasSession(req.user.sub);
    const meta = await database
      .getPool()
      .query('SELECT 1 FROM whatsapp_connections WHERE user_id = $1 AND connected = TRUE LIMIT 1', [
        req.user.sub
      ]);

    if (!web && !meta.rows.length) {
      return res.status(400).json({
        ok: false,
        code: 'WHATSAPP_NOT_CONNECTED',
        message: 'WhatsApp n’est pas connecté. Ouvre Intégrations pour le connecter.'
      });
    }

    const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
    const result = await whatsappQueue.enqueue(req.user.sub, items);

    if (!result.added) {
      return res.status(400).json({
        ok: false,
        code: 'QUEUE_NOTHING_ADDED',
        message:
          'Rien n’a été ajouté : numéro ou message manquant, ou ce client est déjà dans la file.'
      });
    }

    return res.json({ ok: true, ...result, message: 'Ajouté à la file d’envoi.' });
  } catch (error) {
    console.error('Erreur POST /whatsapp/queue:', error);
    return res.status(500).json({ ok: false, message: 'Impossible d’ajouter à la file.' });
  }
});

router.get('/queue', requireAuth, async (req, res) => {
  try {
    return res.json({ ok: true, ...(await whatsappQueue.getQueue(req.user.sub)) });
  } catch (error) {
    console.error('Erreur GET /whatsapp/queue:', error);
    return res.status(500).json({ ok: false, message: 'Impossible de lire la file.' });
  }
});

router.post('/queue/pause', requireAuth, async (req, res) => {
  try {
    await whatsappQueue.setPaused(req.user.sub, true);
    return res.json({ ok: true, paused: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Impossible de mettre en pause.' });
  }
});

router.post('/queue/resume', requireAuth, async (req, res) => {
  try {
    await whatsappQueue.setPaused(req.user.sub, false);
    return res.json({ ok: true, paused: false });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Impossible de reprendre.' });
  }
});

router.post('/queue/cancel', requireAuth, async (req, res) => {
  try {
    const cancelled = await whatsappQueue.cancelPending(req.user.sub);
    return res.json({ ok: true, cancelled });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Impossible d’annuler la file.' });
  }
});

/* ---------- DELETE /whatsapp/disconnect ---------- */

router.delete('/disconnect', requireAuth, async (req, res) => {
  try {
    await ensureTable();

    await database
      .getPool()
      .query('DELETE FROM whatsapp_connections WHERE user_id = $1', [
        req.user.sub
      ]);

    await whatsappWeb.disconnect(req.user.sub);

    return res.json({ ok: true, message: 'WhatsApp déconnecté.' });
  } catch (error) {
    console.error('Erreur DELETE /whatsapp/disconnect:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible de déconnecter WhatsApp.'
    });
  }
});

module.exports = router;
