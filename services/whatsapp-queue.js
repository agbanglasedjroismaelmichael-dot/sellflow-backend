/**
 * SellFlow AI — file d'attente des relances WhatsApp
 * À placer dans : services/whatsapp-queue.js
 *
 * - 1 message toutes les 4 à 6 minutes par utilisateur (variation aléatoire)
 * - limite sur 24 h glissantes (WHATSAPP_DAILY_LIMIT, 40 par défaut)
 * - pause / reprise / annulation
 * - le reste continue automatiquement le lendemain
 */

const database = require('../config/database');
const whatsapp = require('./whatsapp');
const whatsappWeb = require('./whatsapp-web');

const DAILY_LIMIT = Number(process.env.WHATSAPP_DAILY_LIMIT) || 40;
const GAP_MIN_MS = (Number(process.env.WHATSAPP_GAP_MIN_MINUTES) || 4) * 60 * 1000;
const GAP_MAX_MS = (Number(process.env.WHATSAPP_GAP_MAX_MINUTES) || 6) * 60 * 1000;
const TICK_MS = 15 * 1000;

let ready = null;
function ensureTables() {
  if (!ready) {
    ready = database.getPool().query(`
      CREATE TABLE IF NOT EXISTS whatsapp_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(120),
        phone VARCHAR(40) NOT NULL,
        amount VARCHAR(60),
        message TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        error TEXT,
        scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wa_queue_user_status
        ON whatsapp_queue(user_id, status);
      CREATE TABLE IF NOT EXISTS whatsapp_queue_settings (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        paused BOOLEAN NOT NULL DEFAULT FALSE,
        next_send_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const db = () => database.getPool();
const randomGap = () => GAP_MIN_MS + Math.floor(Math.random() * (GAP_MAX_MS - GAP_MIN_MS + 1));
const clean = (v, max) => (v === undefined || v === null ? '' : String(v).trim().substring(0, max));

/* ---------- Ajout à la file ---------- */

async function enqueue(userId, items) {
  await ensureTables();
  let added = 0;
  let skipped = 0;

  for (const item of (items || []).slice(0, 200)) {
    const phone = clean(item.phone, 40).replace(/[^\d]/g, '');
    const message = clean(item.message, 4000);
    if (phone.length < 8 || !message) { skipped++; continue; }

    const dup = await db().query(
      "SELECT 1 FROM whatsapp_queue WHERE user_id = $1 AND phone = $2 AND status IN ('pending','sending') LIMIT 1",
      [userId, phone]
    );
    if (dup.rows.length) { skipped++; continue; }

    const delay = Math.max(0, Math.min(Number(item.delay_seconds) || 0, 86400));
    await db().query(
      `INSERT INTO whatsapp_queue (user_id, name, phone, amount, message, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' seconds')::interval)`,
      [userId, clean(item.name, 120), phone, clean(item.amount, 60), message, String(delay)]
    );
    added++;
  }

  await db().query(
    'INSERT INTO whatsapp_queue_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId]
  );

  const pending = await db().query(
    "SELECT COUNT(*)::int AS n FROM whatsapp_queue WHERE user_id = $1 AND status = 'pending'",
    [userId]
  );
  return { added, skipped, pending: pending.rows[0].n };
}

/* ---------- Lecture / contrôle ---------- */

async function getQueue(userId) {
  await ensureTables();
  const counts = await db().query(
    'SELECT status, COUNT(*)::int AS n FROM whatsapp_queue WHERE user_id = $1 GROUP BY status',
    [userId]
  );
  const byStatus = { pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 };
  counts.rows.forEach((r) => { byStatus[r.status] = r.n; });

  const sent24 = await db().query(
    "SELECT COUNT(*)::int AS n FROM whatsapp_queue WHERE user_id = $1 AND status = 'sent' AND sent_at > NOW() - INTERVAL '24 hours'",
    [userId]
  );
  const settings = await db().query(
    'SELECT paused, next_send_at FROM whatsapp_queue_settings WHERE user_id = $1',
    [userId]
  );
  const items = await db().query(
    `SELECT id, name, phone, status, error, sent_at, created_at
     FROM whatsapp_queue WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 30`,
    [userId]
  );

  return {
    paused: settings.rows[0] ? settings.rows[0].paused : false,
    next_send_at: settings.rows[0] ? settings.rows[0].next_send_at : null,
    counts: byStatus,
    sent_24h: sent24.rows[0].n,
    daily_limit: DAILY_LIMIT,
    items: items.rows
  };
}

async function setPaused(userId, paused) {
  await ensureTables();
  await db().query(
    `INSERT INTO whatsapp_queue_settings (user_id, paused) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET paused = EXCLUDED.paused`,
    [userId, paused]
  );
}

async function cancelPending(userId) {
  await ensureTables();
  const r = await db().query(
    "UPDATE whatsapp_queue SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending'",
    [userId]
  );
  return r.rowCount;
}

/* ---------- Envoi d'un message ---------- */

async function sendOne(userId, item) {
  if (await whatsappWeb.hasSession(userId)) {
    return whatsappWeb.sendText(userId, item.phone, item.message);
  }
  const r = await db().query(
    'SELECT * FROM whatsapp_connections WHERE user_id = $1 AND connected = TRUE LIMIT 1',
    [userId]
  );
  if (!r.rows.length) {
    const e = new Error('WhatsApp n’est pas connecté.');
    e.code = 'WHATSAPP_NOT_CONNECTED';
    throw e;
  }
  return whatsapp.sendTextMessage(
    { accessToken: r.rows[0].access_token, phoneNumberId: r.rows[0].phone_number_id, apiVersion: r.rows[0].api_version },
    item.phone,
    item.message
  );
}

async function processUser(userId) {
  const settings = await db().query(
    'SELECT paused, next_send_at FROM whatsapp_queue_settings WHERE user_id = $1',
    [userId]
  );
  const st = settings.rows[0];
  if (st && (st.paused || new Date(st.next_send_at) > new Date())) return;

  const sent24 = await db().query(
    "SELECT COUNT(*)::int AS n FROM whatsapp_queue WHERE user_id = $1 AND status = 'sent' AND sent_at > NOW() - INTERVAL '24 hours'",
    [userId]
  );
  if (sent24.rows[0].n >= DAILY_LIMIT) return;

  // Prend le plus ancien message prêt, de façon atomique
  const picked = await db().query(
    `UPDATE whatsapp_queue SET status = 'sending'
     WHERE id = (
       SELECT id FROM whatsapp_queue
       WHERE user_id = $1 AND status = 'pending' AND scheduled_at <= NOW()
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [userId]
  );
  if (!picked.rows.length) return;
  const item = picked.rows[0];

  const setNext = (ms) => db().query(
    `INSERT INTO whatsapp_queue_settings (user_id, next_send_at)
     VALUES ($1, NOW() + ($2 || ' milliseconds')::interval)
     ON CONFLICT (user_id) DO UPDATE SET next_send_at = EXCLUDED.next_send_at`,
    [userId, String(ms)]
  );

  try {
    await sendOne(userId, item);
    await db().query("UPDATE whatsapp_queue SET status = 'sent', sent_at = NOW(), error = NULL WHERE id = $1", [item.id]);
    await setNext(randomGap());
  } catch (error) {
    const code = error.code || '';

    // Problèmes temporaires : on remet en attente et on réessaie plus tard
    if (code === 'WHATSAPP_NOT_CONNECTED' || code === 'WHATSAPP_CONNECTING' || code === 'TOKEN_EXPIRED') {
      await db().query("UPDATE whatsapp_queue SET status = 'pending', error = $2 WHERE id = $1", [item.id, error.message]);
      await setNext(2 * 60 * 1000);
      return;
    }
    if (code === 'RATE_LIMITED') {
      await db().query("UPDATE whatsapp_queue SET status = 'pending', error = $2 WHERE id = $1", [item.id, error.message]);
      await setNext(30 * 60 * 1000);
      return;
    }

    await db().query("UPDATE whatsapp_queue SET status = 'failed', error = $2 WHERE id = $1", [item.id, error.message || 'Échec']);
    await setNext(20 * 1000); // numéro invalide etc. : rien n'est parti, on enchaîne vite
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const users = await db().query(
      "SELECT DISTINCT user_id FROM whatsapp_queue WHERE status = 'pending' AND scheduled_at <= NOW()"
    );
    for (const row of users.rows) {
      try { await processUser(row.user_id); } catch (e) { console.error('Erreur file WhatsApp:', e.message); }
    }
  } catch (e) {
    console.error('Erreur worker WhatsApp:', e.message);
  } finally {
    running = false;
  }
}

async function startWorker() {
  await ensureTables();
  // Messages restés « en cours » après un redémarrage du serveur
  await db().query("UPDATE whatsapp_queue SET status = 'pending' WHERE status = 'sending'");
  setInterval(tick, TICK_MS);
  console.log('📤 File d’attente WhatsApp démarrée (limite ' + DAILY_LIMIT + '/24 h).');
}

module.exports = { enqueue, getQueue, setPaused, cancelPending, startWorker };
