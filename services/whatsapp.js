/**
 * SellFlow AI — WhatsApp par code de jumelage (appareils connectés)
 * À placer dans : services/whatsapp-web.js
 *
 * Dépendance à ajouter dans package.json :  "@whiskeysockets/baileys": "^6.7.9"
 * Connexion NON officielle : respecter des délais d'envoi pour éviter le blocage du numéro.
 */

const database = require('../config/database');

const sessions = new Map(); // userId -> { sock, status, pairingCode, phone, starting }

const silentLogger = {
  level: 'silent',
  child() { return silentLogger; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}
};

let baileysPromise = null;
function loadBaileys() {
  if (!baileysPromise) baileysPromise = import('@whiskeysockets/baileys');
  return baileysPromise;
}

/* ---------- Tables ---------- */

let tablesReady = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = database.getPool().query(`
      CREATE TABLE IF NOT EXISTS whatsapp_auth (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE IF NOT EXISTS whatsapp_web_sessions (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        phone VARCHAR(30),
        connected BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch((e) => { tablesReady = null; throw e; });
  }
  return tablesReady;
}

/* ---------- Session d'authentification stockée dans PostgreSQL ---------- */

async function useDbAuthState(userId, baileys) {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  const db = database.getPool();

  const read = async (key) => {
    const r = await db.query(
      'SELECT value FROM whatsapp_auth WHERE user_id = $1 AND key = $2',
      [userId, key]
    );
    return r.rows.length ? JSON.parse(r.rows[0].value, BufferJSON.reviver) : null;
  };
  const write = (key, value) => db.query(
    `INSERT INTO whatsapp_auth (user_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [userId, key, JSON.stringify(value, BufferJSON.replacer)]
  );
  const remove = (key) => db.query(
    'DELETE FROM whatsapp_auth WHERE user_id = $1 AND key = $2', [userId, key]
  );

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => write('creds', creds)
  };
}

async function clearAuth(userId) {
  const db = database.getPool();
  await db.query('DELETE FROM whatsapp_auth WHERE user_id = $1', [userId]);
  await db.query(
    'UPDATE whatsapp_web_sessions SET connected = FALSE, updated_at = NOW() WHERE user_id = $1',
    [userId]
  );
}

async function setConnected(userId, phone, connected) {
  await database.getPool().query(
    `INSERT INTO whatsapp_web_sessions (user_id, phone, connected, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       phone = COALESCE(EXCLUDED.phone, whatsapp_web_sessions.phone),
       connected = EXCLUDED.connected, updated_at = NOW()`,
    [userId, phone || null, connected]
  );
}

function digits(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d;
}

/* ---------- Démarrage d'une session ---------- */

async function openSocket(userId, phone, wantPairing) {
  await ensureTables();
  const baileys = await loadBaileys();
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { DisconnectReason, fetchLatestBaileysVersion } = baileys;

  const { state, saveCreds } = await useDbAuthState(userId, baileys);

  let version;
  try { version = (await fetchLatestBaileysVersion()).version; } catch (e) { /* version par défaut */ }

  const entry = sessions.get(userId) || {};
  entry.status = state.creds.registered ? 'connecting' : 'pending';
  entry.phone = phone || entry.phone || null;
  sessions.set(userId, entry);

  const sock = makeWASocket({
    auth: state,
    version,
    logger: silentLogger,
    printQRInTerminal: false,
    browser: ['SellFlow', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });
  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  let pairingAsked = false;
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && wantPairing && !state.creds.registered && !pairingAsked) {
      pairingAsked = true;
      try {
        const code = await sock.requestPairingCode(digits(entry.phone));
        entry.pairingCode = code;
        entry.status = 'pending';
      } catch (error) {
        entry.status = 'error';
        entry.error = error.message || 'Impossible de générer le code.';
      }
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.pairingCode = null;
      entry.error = null;
      const me = sock.user && sock.user.id ? digits(String(sock.user.id).split(':')[0]) : null;
      await setConnected(userId, me || entry.phone, true).catch(() => {});
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect && lastDisconnect.error &&
        lastDisconnect.error.output && lastDisconnect.error.output.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        sessions.delete(userId);
        await clearAuth(userId).catch(() => {});
        return;
      }
      // Reconnexion automatique (inclut le redémarrage demandé juste après le jumelage)
      entry.status = 'connecting';
      setTimeout(() => {
        openSocket(userId, entry.phone, false).catch((e) => {
          entry.status = 'error';
          entry.error = e.message;
        });
      }, 2000);
    }
  });

  return entry;
}

/* ---------- API du service ---------- */

async function startPairing(userId, phone) {
  const d = digits(phone);
  if (d.length < 9 || d.length > 15 || d.startsWith('0')) {
    const e = new Error('Numéro invalide : indique l’indicatif pays sans 0 ni + (ex. 22998164790).');
    e.code = 'PHONE_INVALID';
    throw e;
  }

  const old = sessions.get(userId);
  if (old && old.sock) { try { old.sock.end(undefined); } catch (e) { /* ignore */ } }
  sessions.delete(userId);
  await ensureTables();
  await clearAuth(userId); // repartir d'une session propre pour obtenir un nouveau code
  await setConnected(userId, d, false);

  const entry = await openSocket(userId, d, true);

  // Attendre le code (max 20 s)
  for (let i = 0; i < 40; i++) {
    if (entry.pairingCode || entry.status === 'error') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!entry.pairingCode) {
    const e = new Error(entry.error || 'Le code n’a pas pu être généré. Réessaie dans un instant.');
    e.code = 'PAIRING_FAILED';
    throw e;
  }
  return { code: entry.pairingCode.replace(/(.{4})(.{4})/, '$1-$2') };
}

async function getStatus(userId) {
  await ensureTables();
  const live = sessions.get(userId);
  if (live) {
    return { status: live.status, phone: live.phone, error: live.error || null };
  }
  const r = await database.getPool().query(
    'SELECT phone, connected FROM whatsapp_web_sessions WHERE user_id = $1', [userId]
  );
  if (r.rows.length && r.rows[0].connected) {
    return { status: 'saved', phone: r.rows[0].phone, error: null };
  }
  return { status: 'disconnected', phone: null, error: null };
}

async function ensureLive(userId, timeoutMs = 25000) {
  let entry = sessions.get(userId);
  if (!entry || !entry.sock) {
    const st = await getStatus(userId);
    if (st.status !== 'saved') {
      const e = new Error('WhatsApp n’est pas connecté.');
      e.code = 'WHATSAPP_NOT_CONNECTED';
      throw e;
    }
    entry = await openSocket(userId, st.phone, false);
  }
  const start = Date.now();
  while (entry.status !== 'connected' && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (entry.status !== 'connected') {
    const e = new Error('Connexion WhatsApp en cours. Réessaie dans quelques secondes.');
    e.code = 'WHATSAPP_CONNECTING';
    throw e;
  }
  return entry;
}

async function hasSession(userId) {
  const st = await getStatus(userId);
  return st.status === 'connected' || st.status === 'saved' || st.status === 'connecting';
}

async function sendText(userId, to, text) {
  const body = String(text || '').trim();
  if (!body) {
    const e = new Error('Le message de relance est vide.');
    e.code = 'MESSAGE_EMPTY';
    throw e;
  }
  const d = digits(to);
  if (d.length < 9 || d.length > 15 || d.startsWith('0')) {
    const e = new Error('Numéro invalide : il doit commencer par l’indicatif pays, sans 0 devant.');
    e.code = 'PHONE_INVALID';
    throw e;
  }
  const entry = await ensureLive(userId);
  const found = await entry.sock.onWhatsApp(d).catch(() => null);
  if (found && found[0] && found[0].exists === false) {
    const e = new Error('Ce numéro n’a pas WhatsApp.');
    e.code = 'RECIPIENT_UNREACHABLE';
    throw e;
  }
  const jid = found && found[0] && found[0].jid ? found[0].jid : `${d}@s.whatsapp.net`;
  const sent = await entry.sock.sendMessage(jid, { text: body.substring(0, 4096) });
  return {
    ok: true,
    message_id: sent && sent.key ? sent.key.id : null,
    mode: 'web_pairing'
  };
}

async function disconnect(userId) {
  const entry = sessions.get(userId);
  if (entry && entry.sock) {
    try { await entry.sock.logout(); } catch (e) { try { entry.sock.end(undefined); } catch (_) { /* ignore */ } }
  }
  sessions.delete(userId);
  await ensureTables();
  await clearAuth(userId);
}

module.exports = { startPairing, getStatus, hasSession, sendText, disconnect };
