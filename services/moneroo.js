/**

* SellFlow AI
* Service Moneroo
* 
* Moneroo Standard Integration
  */

const MONEROO_API_BASE =
process.env.MONEROO_API_BASE ||
'https://api.moneroo.io/v1';

const MONEROO_API_KEY =
process.env.MONEROO_API_KEY;

/**

* ============================================================
* CONFIGURATION
* ============================================================
  */

function ensureMonerooConfigured() {
if (!MONEROO_API_KEY) {
throw new Error(
'MONEROO_API_KEY n’est pas configurée dans les variables d’environnement.'
);
}
}

/**

* ============================================================
* REQUÊTE MONEROO
* ============================================================
  */

async function monerooRequest(
path,
options = {}
) {
ensureMonerooConfigured();

const url =
"${MONEROO_API_BASE}${path}";

const response =
await fetch(url, {
...options,

  headers: {
    Authorization:
      `Bearer ${MONEROO_API_KEY}`,

    'Content-Type':
      'application/json',

    Accept:
      'application/json',

    ...(options.headers || {})
  }
});

const rawText =
await response.text();

let data = null;

try {
data =
rawText
? JSON.parse(rawText)
: null;

} catch {
data = {
raw: rawText
};
}

if (!response.ok) {

const error =
  new Error(
    data?.message ||
    data?.error ||
    `Moneroo API error (${response.status})`
  );

error.status =
  response.status;

error.response =
  data;

throw error;

}

return data;
}

/**

* ============================================================
* INITIALISER UN PAIEMENT
* ============================================================
  */

async function initializePayment(
paymentData
) {

if (
!paymentData ||
typeof paymentData !== 'object'
) {
throw new Error(
'Les données du paiement sont obligatoires.'
);
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

// ----------------------------------------------------------
// Validation montant
// ----------------------------------------------------------

if (
!Number.isInteger(amount) ||
amount <= 0
) {
throw new Error(
'Le montant du paiement doit être un entier positif.'
);
}

// ----------------------------------------------------------
// Validation devise
// ----------------------------------------------------------

if (
!currency ||
typeof currency !== 'string'
) {
throw new Error(
'La devise du paiement est obligatoire.'
);
}

// ----------------------------------------------------------
// Validation description
// ----------------------------------------------------------

if (
!description ||
typeof description !== 'string'
) {
throw new Error(
'La description du paiement est obligatoire.'
);
}

// ----------------------------------------------------------
// Validation URL retour
// ----------------------------------------------------------

if (
!return_url ||
typeof return_url !== 'string'
) {
throw new Error(
'Le return_url du paiement est obligatoire.'
);
}

// ----------------------------------------------------------
// Validation client
// ----------------------------------------------------------

if (
!customer ||
typeof customer !== 'object'
) {
throw new Error(
'Les informations client sont obligatoires.'
);
}

if (!customer.email) {
throw new Error(
'L’adresse email du client est obligatoire.'
);
}

if (!customer.first_name) {
throw new Error(
'Le prénom du client est obligatoire.'
);
}

if (!customer.last_name) {
throw new Error(
'Le nom du client est obligatoire.'
);
}

// ----------------------------------------------------------
// Payload principal
// ----------------------------------------------------------

const payload = {

amount,

currency,

description,

customer: {

  email:
    String(customer.email),

  first_name:
    String(customer.first_name),

  last_name:
    String(customer.last_name)
},

return_url

};

// ----------------------------------------------------------
// Champs client facultatifs
// ----------------------------------------------------------

const optionalCustomerFields = [
'phone',
'address',
'city',
'state',
'country',
'zip'
];

for (
const field
of optionalCustomerFields
) {

if (
  customer[field] !== undefined &&
  customer[field] !== null &&
  String(customer[field]).trim() !== ''
) {

  payload.customer[field] =
    String(customer[field]).trim();
}

}

// ----------------------------------------------------------
// Metadata
// ----------------------------------------------------------

if (
metadata &&
typeof metadata === 'object'
) {

payload.metadata = {};

for (
  const [key, value]
  of Object.entries(metadata)
) {

  payload.metadata[
    String(key)
  ] = String(value);
}

}

// ----------------------------------------------------------
// Méthodes de paiement
// ----------------------------------------------------------

if (
Array.isArray(methods) &&
methods.length > 0
) {

payload.methods =
  methods.map(
    (method) =>
      String(method)
  );

}

// ----------------------------------------------------------
// Restriction pays
// ----------------------------------------------------------

if (restrict_country_code) {

payload.restrict_country_code =
  String(
    restrict_country_code
  );

}

// ----------------------------------------------------------
// Restriction téléphone
// ----------------------------------------------------------

if (
restricted_phone &&
typeof restricted_phone === 'object'
) {

if (
  !restricted_phone.number ||
  !restricted_phone.country_code
) {

  throw new Error(
    'restricted_phone nécessite number et country_code.'
  );
}


payload.restricted_phone = {

  number:
    String(
      restricted_phone.number
    ),

  country_code:
    String(
      restricted_phone.country_code
    )
};

}

// ----------------------------------------------------------
// Restrictions incompatibles
// ----------------------------------------------------------

if (
payload.restrict_country_code &&
payload.restricted_phone
) {

throw new Error(
  'Utilisez soit restrict_country_code, soit restricted_phone, mais pas les deux.'
);

}

return monerooRequest(
'/payments/initialize',
{
method: 'POST',

  body:
    JSON.stringify(payload)
}

);
}

/**

* ============================================================
* RÉCUPÉRER UN PAIEMENT
* ============================================================
  */

async function getPayment(
paymentId
) {

if (!paymentId) {
throw new Error(
'paymentId est obligatoire.'
);
}

return monerooRequest(
"/payments/${encodeURIComponent(paymentId)}",
{
method: 'GET'
}
);
}

/**

* ============================================================
* VÉRIFIER UN PAIEMENT
* ============================================================
  */

async function verifyPayment(
paymentId
) {
return getPayment(
paymentId
);
}

/**

* ============================================================
* EXTRAIRE PAYMENT ID
* ============================================================
  */

function extractPaymentId(
response
) {

return (
response?.data?.id ||
null
);
}

/**

* ============================================================
* EXTRAIRE CHECKOUT URL
* ============================================================
  */

function extractCheckoutUrl(
response
) {

return (
response?.data?.checkout_url ||
null
);
}

/**

* ============================================================
* EXTRAIRE LES INFORMATIONS DE PAIEMENT
* ============================================================
  */

function extractPaymentInitialization(
response
) {

const paymentId =
extractPaymentId(
response
);

const checkoutUrl =
extractCheckoutUrl(
response
);

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

/**

* ============================================================
* EXPORTS
* ============================================================
  */

module.exports = {

initializePayment,

getPayment,

verifyPayment,

extractPaymentId,

extractCheckoutUrl,

extractPaymentInitialization
};
