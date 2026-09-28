const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { google } = require('googleapis');

const { getPool } = require('../config/database');

const router = express.Router();

/* =========================================================
CONFIGURATION
========================================================= */

const FRONTEND_URL =
process.env.FRONTEND_URL ||
'https://sellflowic.netlify.app';

const BACKEND_URL =
process.env.BACKEND_URL ||
'https://sellflow-backend.onrender.com';

const JWT_SECRET =
process.env.JWT_SECRET ||
process.env.SECRET_KEY ||
'sellflow-change-this-secret-in-render';

const JWT_EXPIRES_IN =
process.env.JWT_EXPIRES_IN ||
'30d';

/* =========================================================
UTILITAIRES
========================================================= */

function normalizeEmail(value) {
return String(value || '')
.trim()
.toLowerCase();
}

function cleanString(value, maxLength = 500) {
return String(value || '')
.trim()
.slice(0, maxLength);
}

function normalizePhone(value) {
return String(value || '')
.trim()
.replace(/[^\d+]/g, '')
.slice(0, 30);
}

function publicUser(user) {
if (!user) return null;

return {
id: user.id,
name: user.name || '',
email: user.email || '',
phone: user.phone || '',
country: user.country || '',
dial_code: user.dial_code || '',
phone_international:
user.phone_international ||
user.phone ||
'',
plan:
user.plan ||
user.subscription_plan ||
'starter',
billing:
user.billing ||
user.subscription_billing ||
'monthly',
subscription_status:
user.subscription_status ||
user.status ||
'active',
auth_provider:
user.auth_provider ||
'password',
created_at:
user.created_at ||
null,
updated_at:
user.updated_at ||
null
};
}

function createToken(user) {
return jwt.sign(
{
sub: String(user.id),
id: String(user.id),
email: user.email,
name: user.name || ''
},
JWT_SECRET,
{
expiresIn: JWT_EXPIRES_IN
}
);
}

function getBearerToken(req) {
const header = req.headers.authorization || '';

if (!header.startsWith('Bearer ')) {
return '';
}

return header.slice(7).trim();
}

function generateId() {
if (typeof crypto.randomUUID === 'function') {
return crypto.randomUUID();
}

return crypto.randomBytes(16).toString('hex');
}

/* =========================================================
DATABASE
========================================================= */

async function getUsersColumns() {
const pool = getPool();

const result = await pool.query(
`       SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
      ORDER BY ordinal_position
    `
);

return new Set(
result.rows.map(
(row) => row.column_name
)
);
}

function quoteIdentifier(value) {
return `"${String(value).replace(/"/g, '""')}"`;
}

async function findUserByEmail(email) {
const pool = getPool();

const result = await pool.query(
`       SELECT *
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
[email]
);

return result.rows[0] || null;
}

async function findUserById(id) {
const pool = getPool();

const result = await pool.query(
`       SELECT *
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
[id]
);

return result.rows[0] || null;
}

/* =========================================================
CRÉATION UTILISATEUR
========================================================= */

async function createUser({
name,
email,
passwordHash = null,
phone = '',
country = '',
dialCode = '',
phoneInternational = '',
googleId = null,
authProvider = 'password',
plan = 'starter',
billing = 'monthly',
subscriptionStatus = 'active'
}) {
const pool = getPool();

const columnsAvailable =
await getUsersColumns();

const values = [];
const columns = [];
const placeholders = [];

function addColumn(column, value) {
if (!columnsAvailable.has(column)) {
return;
}

```
columns.push(column);
values.push(value);
placeholders.push(`$${values.length}`);
```

}

addColumn('id', generateId());

addColumn('name', name);

addColumn('email', email);

if (passwordHash) {
if (columnsAvailable.has('password_hash')) {
addColumn(
'password_hash',
passwordHash
);
} else if (
columnsAvailable.has('passwordHash')
) {
addColumn(
'passwordHash',
passwordHash
);
}
}

addColumn('phone', phone);

addColumn('country', country);

addColumn('dial_code', dialCode);

addColumn(
'phone_international',
phoneInternational
);

addColumn('google_id', googleId);

addColumn(
'auth_provider',
authProvider
);

addColumn('plan', plan);

addColumn('billing', billing);

addColumn(
'subscription_status',
subscriptionStatus
);

const now = new Date();

addColumn('created_at', now);

addColumn('updated_at', now);

if (!columns.length) {
throw new Error(
'Aucune colonne exploitable trouvée dans la table users.'
);
}

const query = `     INSERT INTO users (
      ${columns.map(quoteIdentifier).join(', ')}
    )
    VALUES (
      ${placeholders.join(', ')}
    )
    RETURNING *
  `;

const result = await pool.query(
query,
values
);

return result.rows[0];
}

/* =========================================================
MISE À JOUR GOOGLE
========================================================= */

async function updateGoogleIdentity(
userId,
googleId
) {
const pool = getPool();

const columnsAvailable =
await getUsersColumns();

const sets = [];
const values = [
googleId,
userId
];

if (
columnsAvailable.has('google_id')
) {
sets.push('google_id = $1');
}

if (
columnsAvailable.has('auth_provider')
) {
sets.push(
"auth_provider = 'google'"
);
}

if (
columnsAvailable.has('updated_at')
) {
sets.push(
'updated_at = NOW()'
);
}

if (!sets.length) {
return;
}

await pool.query(
`       UPDATE users
      SET ${sets.join(', ')}
      WHERE id = $2
    `,
values
);
}

/* =========================================================
MISE À JOUR PROFIL
========================================================= */

async function updateGoogleProfile(
userId,
googleProfile
) {
const pool = getPool();

const columnsAvailable =
await getUsersColumns();

const sets = [];
const values = [];
let index = 1;

function setIfExists(
column,
value
) {
if (
!columnsAvailable.has(column)
) {
return;
}

```
sets.push(
  `${quoteIdentifier(column)} = $${index}`
);

values.push(value);
index += 1;
```

}

setIfExists(
'name',
googleProfile.name
);

setIfExists(
'google_id',
googleProfile.googleId
);

setIfExists(
'auth_provider',
'google'
);

if (
columnsAvailable.has('updated_at')
) {
sets.push(
'"updated_at" = NOW()'
);
}

if (!sets.length) {
return;
}

values.push(userId);

await pool.query(
`       UPDATE users
      SET ${sets.join(', ')}
      WHERE id = $${values.length}
    `,
values
);
}

/* =========================================================
VALIDATION INSCRIPTION
========================================================= */

function validateRegistration(body) {
const name = cleanString(
body.name,
150
);

const email =
normalizeEmail(body.email);

const password =
String(body.password || '');

const passwordConfirmation =
String(
body.password_confirmation ||
body.passwordConfirmation ||
''
);

const country = cleanString(
body.country,
100
);

const dialCode =
cleanString(
body.dial_code ||
body.dialCode ||
'',
10
);

const rawPhone =
body.phone ||
body.phone_number ||
'';

const phone =
normalizePhone(rawPhone);

const phoneInternational =
normalizePhone(
body.phone_international ||
body.phoneInternational ||
(
dialCode &&
phone &&
!phone.startsWith('+')
? `${dialCode}${phone}`
: phone
)
);

if (!name) {
throw new Error(
'Le nom est obligatoire.'
);
}

if (!email) {
throw new Error(
'L’adresse e-mail est obligatoire.'
);
}

if (
!/^[^\s@]+@[^\s@]+.[^\s@]+$/.test(
email
)
) {
throw new Error(
'Adresse e-mail invalide.'
);
}

if (password.length < 8) {
throw new Error(
'Le mot de passe doit contenir au moins 8 caractères.'
);
}

if (
passwordConfirmation &&
password !== passwordConfirmation
) {
throw new Error(
'Les mots de passe ne correspondent pas.'
);
}

return {
name,
email,
password,
passwordConfirmation,
country,
dialCode,
phone,
phoneInternational
};
}

/* =========================================================
INSCRIPTION DIRECTE
========================================================= */

async function registerAccount(req, res) {
try {
const data =
validateRegistration(req.body);

```
/* -----------------------------------------
   EMAIL UNIQUE
----------------------------------------- */

const existingUser =
  await findUserByEmail(
    data.email
  );

if (existingUser) {
  return res.status(409).json({
    ok: false,
    error: 'EMAIL_ALREADY_EXISTS',
    message:
      'Cette adresse e-mail possède déjà un compte. Connecte-toi avec ce compte.'
  });
}

/* -----------------------------------------
   HASH MOT DE PASSE
----------------------------------------- */

const passwordHash =
  await bcrypt.hash(
    data.password,
    12
  );

/* -----------------------------------------
   CRÉATION
----------------------------------------- */

const user =
  await createUser({
    name: data.name,
    email: data.email,
    passwordHash,
    phone: data.phone,
    country: data.country,
    dialCode: data.dialCode,
    phoneInternational:
      data.phoneInternational,
    authProvider: 'password',
    plan: 'starter',
    billing: 'monthly',
    subscriptionStatus: 'active'
  });

const token =
  createToken(user);

return res.status(201).json({
  ok: true,
  message:
    'Compte créé avec succès.',
  token,
  accessToken: token,
  user: publicUser(user)
});
```

} catch (error) {
console.error(
'❌ Erreur inscription:',
error
);

```
/* -----------------------------------------
   EMAIL UNIQUE POSTGRESQL
----------------------------------------- */

if (
  error &&
  error.code === '23505'
) {
  return res.status(409).json({
    ok: false,
    error: 'EMAIL_ALREADY_EXISTS',
    message:
      'Cette adresse e-mail possède déjà un compte.'
  });
}

return res.status(400).json({
  ok: false,
  error:
    error.message ||
    'Impossible de créer le compte.'
});
```

}
}

/* =========================================================
POST /AUTH/REGISTER
========================================================= */

router.post(
'/register',
registerAccount
);

/* =========================================================
POST /AUTH/REGISTER/COMPLETE
Compatibilité avec anciennes versions
========================================================= */

router.post(
'/register/complete',
registerAccount
);

/* =========================================================
POST /AUTH/LOGIN
========================================================= */

router.post(
'/login',
async (req, res) => {
try {
const email =
normalizeEmail(
req.body.email
);

```
  const password =
    String(
      req.body.password || ''
    );

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_CREDENTIALS',
      message:
        'E-mail et mot de passe obligatoires.'
    });
  }

  const user =
    await findUserByEmail(
      email
    );

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'INVALID_CREDENTIALS',
      message:
        'E-mail ou mot de passe incorrect.'
    });
  }

  const storedHash =
    user.password_hash ||
    user.passwordHash ||
    user.password ||
    '';

  if (!storedHash) {
    return res.status(401).json({
      ok: false,
      error: 'PASSWORD_LOGIN_UNAVAILABLE',
      message:
        'Ce compte utilise une autre méthode de connexion.'
    });
  }

  const validPassword =
    await bcrypt.compare(
      password,
      storedHash
    );

  if (!validPassword) {
    return res.status(401).json({
      ok: false,
      error: 'INVALID_CREDENTIALS',
      message:
        'E-mail ou mot de passe incorrect.'
    });
  }

  const token =
    createToken(user);

  return res.json({
    ok: true,
    message: 'Connexion réussie.',
    token,
    accessToken: token,
    user: publicUser(user)
  });
} catch (error) {
  console.error(
    '❌ Erreur connexion:',
    error
  );

  return res.status(500).json({
    ok: false,
    error: 'LOGIN_ERROR',
    message:
      'Impossible de se connecter.'
  });
}
```

}
);

/* =========================================================
GET /AUTH/ME
========================================================= */

router.get(
'/me',
async (req, res) => {
try {
const token =
getBearerToken(req);

```
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'MISSING_TOKEN',
      message:
        'Token d’authentification manquant.'
    });
  }

  const payload =
    jwt.verify(
      token,
      JWT_SECRET
    );

  const user =
    await findUserById(
      payload.id ||
      payload.sub
    );

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: 'USER_NOT_FOUND',
      message:
        'Utilisateur introuvable.'
    });
  }

  return res.json({
    ok: true,
    user: publicUser(user)
  });
} catch (error) {
  console.error(
    '❌ /auth/me:',
    error
  );

  return res.status(401).json({
    ok: false,
    error: 'INVALID_TOKEN',
    message:
      'Session invalide ou expirée.'
  });
}
```

}
);

/* =========================================================
GOOGLE OAUTH
========================================================= */

function getGoogleClient() {
const clientId =
process.env.GOOGLE_CLIENT_ID;

const clientSecret =
process.env.GOOGLE_CLIENT_SECRET;

const redirectUri =
process.env.GOOGLE_REDIRECT_URI ||
`${BACKEND_URL}/auth/google/callback`;

if (
!clientId ||
!clientSecret
) {
throw new Error(
'GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET manquant.'
);
}

return new google.auth.OAuth2(
clientId,
clientSecret,
redirectUri
);
}

/* =========================================================
GET /AUTH/GOOGLE
========================================================= */

router.get(
'/google',
async (req, res) => {
try {
const oauth2Client =
getGoogleClient();

```
  const url =
    oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account',
      scope: [
        'openid',
        'email',
        'profile'
      ]
    });

  return res.redirect(
    url
  );
} catch (error) {
  console.error(
    '❌ Google OAuth:',
    error
  );

  return res.status(500).json({
    ok: false,
    error: 'GOOGLE_CONFIG_ERROR',
    message:
      error.message
  });
}
```

}
);

/* =========================================================
GET /AUTH/GOOGLE/CALLBACK
========================================================= */

router.get(
'/google/callback',
async (req, res) => {
try {
const code =
cleanString(
req.query.code
);

```
  if (!code) {
    return res.redirect(
      `${FRONTEND_URL}/?google_error=missing_code`
    );
  }

  const oauth2Client =
    getGoogleClient();

  const {
    tokens
  } =
    await oauth2Client.getToken(
      code
    );

  oauth2Client.setCredentials(
    tokens
  );

  const oauth2 =
    google.oauth2({
      auth:
        oauth2Client,
      version: 'v2'
    });

  const {
    data
  } =
    await oauth2.userinfo.get();

  const googleId =
    cleanString(
      data.id,
      300
    );

  const email =
    normalizeEmail(
      data.email
    );

  const name =
    cleanString(
      data.name ||
      data.given_name ||
      'Utilisateur Google',
      150
    );

  if (
    !googleId ||
    !email
  ) {
    return res.redirect(
      `${FRONTEND_URL}/?google_error=incomplete_profile`
    );
  }

  /* -----------------------------------------
     UN SEUL COMPTE PAR EMAIL
  ----------------------------------------- */

  let user =
    await findUserByEmail(
      email
    );

  if (user) {
    await updateGoogleIdentity(
      user.id,
      googleId
    );

    await updateGoogleProfile(
      user.id,
      {
        name:
          user.name || name,
        googleId
      }
    );

    user =
      await findUserById(
        user.id
      );
  } else {
    user =
      await createUser({
        name,
        email,
        passwordHash: null,
        phone: '',
        country: '',
        dialCode: '',
        phoneInternational: '',
        googleId,
        authProvider: 'google',
        plan: 'starter',
        billing: 'monthly',
        subscriptionStatus: 'active'
      });
  }

  const token =
    createToken(user);

  const userJson =
    encodeURIComponent(
      JSON.stringify(
        publicUser(user)
      )
    );

  return res.redirect(
    `${FRONTEND_URL}/?google_auth=success&token=${encodeURIComponent(token)}&user=${userJson}`
  );
} catch (error) {
  console.error(
    '❌ Google callback:',
    error
  );

  return res.redirect(
    `${FRONTEND_URL}/?google_error=callback_failed`
  );
}
```

}
);

/* =========================================================
ROUTES D'ANCIEN SYSTÈME EMAIL
SUPPRIMÉES INTENTIONNELLEMENT
========================================================= */

/*
Aucun :
/register/request-email-code
/register/verify-email-code
/register/resend-email-code
/verify-email
/test-email

Pas de Resend.
Pas de code envoyé par e-mail.
*/

/* =========================================================
EXPORT
========================================================= */

module.exports = router;
