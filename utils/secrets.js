/**
 * SellFlow AI — chiffrement des secrets (tokens WhatsApp, clés Chariow)
 * AES-256-GCM. Clé dans la variable d'environnement SECRETS_KEY
 * (64 caractères hexadécimaux, ou 32 octets en base64).
 * Générer une clé :  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
let warned = false;

function getKey() {
  const raw = String(process.env.SECRETS_KEY || '').trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(raw, 'base64');
  return b.length === 32 ? b : null;
}

function encryptSecret(plain) {
  if (plain == null || plain === '') return plain;
  const text = String(plain);
  if (text.startsWith(PREFIX)) return text;
  const key = getKey();
  if (!key) {
    if (!warned) {
      warned = true;
      console.warn('[secrets] SECRETS_KEY absente ou invalide : les secrets sont stockés en clair. Définis SECRETS_KEY sur Render.');
    }
    return text;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, enc].map((b) => b.toString('base64')).join(':');
}

function decryptSecret(stored) {
  if (stored == null || stored === '') return stored;
  const text = String(stored);
  if (!text.startsWith(PREFIX)) return text; // ancien secret en clair
  const key = getKey();
  if (!key) throw new Error('SECRETS_KEY manquante : impossible de déchiffrer le secret enregistré.');
  const [iv, tag, enc] = text.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
