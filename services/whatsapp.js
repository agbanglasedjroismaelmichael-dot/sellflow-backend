/**
 * SellFlow AI — Service WhatsApp Cloud API (Meta)
 *
 * Envoi de messages sans ouvrir WhatsApp sur le téléphone.
 *
 * Identifiants attendus (saisis dans Intégrations) :
 * - access_token  = Clé API / Token d’accès Meta
 * - phone_number_id = ID du numéro WhatsApp Business (champ Secret)
 * - api_version   = optionnel (défaut v21.0)
 */

const META_GRAPH_BASE =
  process.env.WHATSAPP_GRAPH_BASE ||
  'https://graph.facebook.com';

const DEFAULT_API_VERSION =
  process.env.WHATSAPP_API_VERSION || 'v21.0';

function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits;
}

/** Un numéro valide pour WhatsApp commence par l'indicatif pays (jamais par 0). */
function isInternationalPhone(phone) {
  const d = normalizePhone(phone);
  return !!d && !d.startsWith('0') && d.length >= 9 && d.length <= 15;
}

function buildMessagesUrl(phoneNumberId, apiVersion) {
  const version = String(apiVersion || DEFAULT_API_VERSION).replace(/^\/+|\/+$/g, '');
  const id = String(phoneNumberId).trim();
  return `${META_GRAPH_BASE}/${version}/${id}/messages`;
}


/**
 * Traduit une erreur Meta en code applicatif + message français.
 * 131047 / 131051 : hors fenêtre de 24 h -> modèle obligatoire.
 */
function mapMetaError(data, status) {
  const e = (data && data.error) || {};
  const code = Number(e.code || 0);
  const sub = Number(e.error_subcode || 0);
  const details = (e.error_data && e.error_data.details) || '';
  const raw = String(e.message || data?.message || `WhatsApp API error (${status})`);
  let appCode = 'WHATSAPP_SEND_FAILED';
  let message = raw;

  if (code === 190 || sub === 463 || sub === 467) {
    appCode = 'TOKEN_EXPIRED';
    message = 'Le token WhatsApp a expiré ou est invalide. Génère un token permanent (utilisateur système) dans Meta et reconnecte WhatsApp.';
  } else if (code === 131047 || code === 131051 || code === 131026 && /re-?engage/i.test(raw)) {
    appCode = 'TEMPLATE_REQUIRED';
    message = 'Meta n’autorise le texte libre que dans les 24 h après un message du client. Utilise un modèle de message approuvé.';
  } else if (code === 132001) {
    appCode = 'TEMPLATE_NOT_FOUND';
    message = 'Le modèle WhatsApp est introuvable ou pas encore approuvé (vérifie son nom et sa langue).';
  } else if (code === 132000 || code === 132012 || code === 132005 || code === 132007 || code === 132015 || code === 132016) {
    appCode = 'TEMPLATE_PARAMS_INVALID';
    message = 'Le modèle WhatsApp n’accepte pas ces paramètres : ' + (details || raw);
  } else if (code === 131030) {
    appCode = 'RECIPIENT_NOT_ALLOWED';
    message = 'Ce numéro n’est pas autorisé : ton numéro WhatsApp est encore en mode test chez Meta. Ajoute le destinataire ou passe en production.';
  } else if (code === 131026) {
    appCode = 'RECIPIENT_UNREACHABLE';
    message = 'Message non livrable : ce numéro n’a pas WhatsApp ou a bloqué les messages.';
  } else if (code === 131048 || code === 130429 || code === 131056 || status === 429) {
    appCode = 'RATE_LIMITED';
    message = 'Limite d’envoi Meta atteinte. Réessaie dans quelques minutes.';
  } else if (code === 131042) {
    appCode = 'PAYMENT_ISSUE';
    message = 'Meta bloque l’envoi : mode de paiement WhatsApp Business à vérifier dans ton compte Meta.';
  }
  return { appCode, message, metaCode: code || null };
}

function buildError(data, status) {
  const m = mapMetaError(data, status);
  const error = new Error(m.message);
  error.status = status;
  error.code = m.appCode;
  error.metaCode = m.metaCode;
  error.response = data;
  return error;
}

async function postMessage(config, payload) {
  const response = await fetch(buildMessagesUrl(config.phoneNumberId, config.apiVersion), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const rawText = await response.text();
  let data = null;
  try { data = rawText ? JSON.parse(rawText) : null; } catch { data = { raw: rawText }; }
  if (!response.ok) throw buildError(data, response.status);
  return {
    ok: true,
    message_id: data?.messages?.[0]?.id || data?.message_id || null,
    to: payload.to,
    provider: 'meta_whatsapp_cloud',
    raw: data
  };
}

function assertConfig(config) {
  if (!config || !config.accessToken) {
    const e = new Error('Token WhatsApp manquant. Configure WhatsApp Business dans Intégrations.');
    e.code = 'WHATSAPP_NOT_CONNECTED';
    throw e;
  }
  if (!config.phoneNumberId) {
    const e = new Error('Phone Number ID manquant. Dans Intégrations → WhatsApp, mets l’ID du numéro dans le champ « Secret API ».');
    e.code = 'WHATSAPP_NOT_CONNECTED';
    throw e;
  }
}

function assertRecipient(to) {
  const recipient = normalizePhone(to);
  if (!recipient || !isInternationalPhone(recipient)) {
    const e = new Error('Numéro invalide : il doit commencer par l’indicatif pays (ex. 225…), sans 0 devant.');
    e.code = 'PHONE_INVALID';
    throw e;
  }
  return recipient;
}

/**
 * Envoie un message à partir d'un MODÈLE approuvé par Meta
 * (seule façon d'écrire à un client qui n'a pas écrit depuis 24 h).
 * params = valeurs de {{1}}, {{2}}… dans l'ordre.
 */
async function sendTemplateMessage(config, to, template) {
  assertConfig(config);
  const recipient = assertRecipient(to);
  if (!template || !template.name) {
    const e = new Error('Nom du modèle WhatsApp manquant.');
    e.code = 'TEMPLATE_REQUIRED';
    throw e;
  }
  const params = (template.params || []).map((v) => ({
    type: 'text',
    text: String(v == null || v === '' ? '-' : v).replace(/[\r\n\t]+/g, ' ').slice(0, 500)
  }));
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'template',
    template: {
      name: String(template.name).trim(),
      language: { code: template.language || 'fr' }
    }
  };
  if (params.length) payload.template.components = [{ type: 'body', parameters: params }];
  const out = await postMessage(config, payload);
  out.mode = 'template';
  return out;
}

/**
 * Envoie un message texte via WhatsApp Cloud API.
 *
 * @param {object} config
 * @param {string} config.accessToken
 * @param {string} config.phoneNumberId
 * @param {string} [config.apiVersion]
 * @param {string} to - numéro destinataire (avec indicatif pays, sans +)
 * @param {string} body - texte du message
 */
async function sendTextMessage(config, to, body) {
  assertConfig(config);
  const recipient = assertRecipient(to);
  const text = String(body || '').trim();
  if (!text) {
    const e = new Error('Le message de relance est vide.');
    e.code = 'MESSAGE_EMPTY';
    throw e;
  }
  const out = await postMessage(config, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: { preview_url: true, body: text.substring(0, 4096) }
  });
  out.mode = 'text';
  return out;
}

/**
 * Vérifie sommairement le token + phone_number_id
 * en interrogeant le nœud phone_number.
 */
async function verifyCredentials(config) {
  if (!config?.accessToken || !config?.phoneNumberId) {
    throw new Error(
      'Token et Phone Number ID sont obligatoires.'
    );
  }

  const version = String(
    config.apiVersion || DEFAULT_API_VERSION
  ).replace(/^\/+|\/+$/g, '');

  const url =
    `${META_GRAPH_BASE}/${version}/${String(config.phoneNumberId).trim()}` +
    `?fields=display_phone_number,verified_name,quality_rating`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      Accept: 'application/json'
    }
  });

  const rawText = await response.text();
  let data = null;

  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = { raw: rawText };
  }

  if (!response.ok) {
    const apiMessage =
      data?.error?.message ||
      data?.message ||
      `Vérification WhatsApp impossible (${response.status})`;

    const error = new Error(String(apiMessage));
    error.status = response.status;
    error.response = data;
    throw error;
  }

  return {
    ok: true,
    display_phone_number: data?.display_phone_number || null,
    verified_name: data?.verified_name || null,
    quality_rating: data?.quality_rating || null,
    phone_number_id: config.phoneNumberId
  };
}

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  isInternationalPhone,
  verifyCredentials,
  normalizePhone,
  buildMessagesUrl
};
