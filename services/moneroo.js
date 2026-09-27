/**
 * SellFlow AI
 * Service Moneroo
 *
 * Moneroo Standard Integration
 * Documentation utilisée :
 * POST /v1/payments/initialize
 */

const MONEROO_API_BASE =
  process.env.MONEROO_API_BASE || 'https://api.moneroo.io/v1';

const MONEROO_API_KEY = process.env.MONEROO_API_KEY;

/**
 * Vérifie que la clé Moneroo existe.
 */
function ensureMonerooConfigured() {
  if (!MONEROO_API_KEY) {
    throw new Error(
      'MONEROO_API_KEY n’est pas configurée dans les variables d’environnement.'
    );
  }
}

/**
 * Envoie une requête à l'API Moneroo.
 */
async function monerooRequest(path, options = {}) {
  ensureMonerooConfigured();

  const url = `${MONEROO_API_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${MONEROO_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });

  const rawText = await response.text();

  let data = null;

  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = {
      raw: rawText
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.message ||
        data?.error ||
        `Moneroo API error (${response.status})`
    );

    error.status = response.status;
    error.response = data;

    throw error;
  }

  return data;
}

/**
 * Initialise un paiement Moneroo.
 *
 * Le payload doit respecter le format officiel Moneroo :
 *
 * {
 *   amount,
 *   currency,
 *   description,
 *   return_url,
 *   customer: {
 *     email,
 *     first_name,
 *     last_name
 *   },
 *   metadata,
 *   methods
 * }
 */
async function initializePayment(paymentData) {
  if (!paymentData || typeof paymentData !== 'object') {
    throw new Error('Les données du paiement sont obligatoires.');
  }

  const {
    amount,
    currency,
    description,
    return_url,
    customer,
    metadata,
    methods,
    restrict_country_code,
    restricted_phone
  } = paymentData;

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Le montant du paiement doit être un entier positif.');
  }

  if (!currency || typeof currency !== 'string') {
    throw new Error('La devise du paiement est obligatoire.');
  }

  if (!description || typeof description !== 'string') {
    throw new Error('La description du paiement est obligatoire.');
  }

  if (!return_url || typeof return_url !== 'string') {
    throw new Error('Le return_url du paiement est obligatoire.');
  }

  if (!customer || typeof customer !== 'object') {
    throw new Error('Les informations client sont obligatoires.');
  }

  if (!customer.email) {
    throw new Error('L’adresse email du client est obligatoire.');
  }

  if (!customer.first_name) {
    throw new Error('Le prénom du client est obligatoire.');
  }

  if (!customer.last_name) {
    throw new Error('Le nom du client est obligatoire.');
  }

  const payload = {
    amount,
    currency,
    description,
    customer: {
      email: String(customer.email),
      first_name: String(customer.first_name),
      last_name: String(customer.last_name)
    },
    return_url
  };

  /**
   * Champs client facultatifs.
   */
  const optionalCustomerFields = [
    'phone',
    'address',
    'city',
    'state',
    'country',
    'zip'
  ];

  for (const field of optionalCustomerFields) {
    if (
      customer[field] !== undefined &&
      customer[field] !== null &&
      customer[field] !== ''
    ) {
      payload.customer[field] = String(customer[field]);
    }
  }

  /**
   * Metadata facultatives.
   */
  if (metadata && typeof metadata === 'object') {
    payload.metadata = {};

    for (const [key, value] of Object.entries(metadata)) {
      /**
       * La documentation Moneroo précise que les valeurs
       * de metadata doivent être des chaînes.
       */
      payload.metadata[String(key)] = String(value);
    }
  }

  /**
   * Méthodes de paiement facultatives.
   *
   * Exemple :
   * ["mtn_bj", "moov_bj"]
   */
  if (Array.isArray(methods) && methods.length > 0) {
    payload.methods = methods.map((method) => String(method));
  }

  /**
   * Restriction par pays.
   */
  if (restrict_country_code) {
    payload.restrict_country_code = String(restrict_country_code);
  }

  /**
   * Restriction par téléphone.
   */
  if (restricted_phone && typeof restricted_phone === 'object') {
    if (
      !restricted_phone.number ||
      !restricted_phone.country_code
    ) {
      throw new Error(
        'restricted_phone nécessite number et country_code.'
      );
    }

    payload.restricted_phone = {
      number: String(restricted_phone.number),
      country_code: String(restricted_phone.country_code)
    };
  }

  /**
   * Moneroo indique que restrict_country_code et
   * restricted_phone sont mutuellement exclusifs.
   */
  if (
    payload.restrict_country_code &&
    payload.restricted_phone
  ) {
    throw new Error(
      'Utilisez soit restrict_country_code, soit restricted_phone, mais pas les deux.'
    );
  }

  return monerooRequest('/payments/initialize', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

/**
 * Vérifie un paiement Moneroo.
 *
 * GET /v1/payments/{paymentId}
 */
async function getPayment(paymentId) {
  if (!paymentId) {
    throw new Error('paymentId est obligatoire.');
  }

  return monerooRequest(
    `/payments/${encodeURIComponent(paymentId)}`,
    {
      method: 'GET'
    }
  );
}

/**
 * Alias explicite pour la vérification d'un paiement.
 */
async function verifyPayment(paymentId) {
  return getPayment(paymentId);
}

/**
 * Récupère l'identifiant Moneroo depuis la réponse
 * d'initialisation.
 */
function extractPaymentId(response) {
  return response?.data?.id || null;
}

/**
 * Récupère le lien de paiement Moneroo.
 */
function extractCheckoutUrl(response) {
  return response?.data?.checkout_url || null;
}

/**
 * Vérifie que la réponse contient bien les éléments
 * nécessaires pour rediriger le client.
 */
function extractPaymentInitialization(response) {
  const paymentId = extractPaymentId(response);
  const checkoutUrl = extractCheckoutUrl(response);

  if (!paymentId) {
    throw new Error(
      'Moneroo n’a pas retourné de payment ID.'
    );
  }

  if (!checkoutUrl) {
    throw new Error(
      'Moneroo n’a pas retourné de checkout_url.'
    );
  }

  return {
    paymentId,
    checkoutUrl
  };
}

module.exports = {
  initializePayment,
  getPayment,
  verifyPayment,
  extractPaymentId,
  extractCheckoutUrl,
  extractPaymentInitialization
};
