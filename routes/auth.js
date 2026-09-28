const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');

const { getPool } = require('../config/database');

const {
hashPassword,
comparePassword,
signToken,
authMiddleware
} = require('../utils/auth');

const router = express.Router();
const pool = getPool();

/* =========================================================
CONFIGURATION
========================================================= */

const FRONTEND_URL = (
process.env.FRONTEND_URL ||
'https://sellflowic.netlify.app'
)
.trim()
.replace(//+$/, '');

const BACKEND_URL = (
process.env.BACKEND_URL ||
'https://sellflow-backend.onrender.com'
)
.trim()
.replace(//+$/, '');

const GOOGLE_CLIENT_ID =
process.env.GOOGLE_CLIENT_ID || '';

const GOOGLE_CLIENT_SECRET =
process.env.GOOGLE_CLIENT_SECRET || '';

const GOOGLE_REDIRECT_URI =
process.env.GOOGLE_REDIRECT_URI ||
`${BACKEND_URL}/auth/google/callback`;

/* =========================================================
HELPERS
========================================================= */

function normalizeEmail(value) {
return String(value || '')
.trim()
.toLowerCase();
}

function isValidEmail(email) {
return /^[^\s@]+@[^\s@]+.[^\s@]+$/.test(email);
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
if (!user) {
return null;
}

return {
id: user.id,
name: user.name || '',
email: normalizeEmail(user.email),
phone: user.phone || null,
country: user.country || null,
dial_code: user.dial_code || null,
phone_international:
user.phone_international ||
user.phone ||
null,
plan:
user.plan ||
user.subscription_plan ||
'free',
billing:
user.billing ||
user.subscription_billing ||
'monthly',
email_verified:
user.email_verified !== false,
subscription_status:
user.subscription_status || null,
subscription_started_at:
user.subscription_started_at || null,
subscription_expires_at:
user.subscription_expires_at || null,
auth_provider:
user.auth_provider ||
'password',
created_at:
user.created_at || null,
updated_at:
user.updated_at || null
};
}

/* =========================================================
DATABASE HELPERS
========================================================= */

async function getUsersColumns() {
const result = await pool.query(`     SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
    ORDER BY ordinal_position
  `);

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
const normalizedEmail =
normalizeEmail(email);

if (!normalizedEmail) {
return null;
}

const result = await pool.query(
`       SELECT *
      FROM users
      WHERE LOWER(TRIM(email)) = $1
      LIMIT 1
    `,
[normalizedEmail]
);

return result.rows[0] || null;
}

async function findUserById(id) {
if (!id) {
return null;
}

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
CREATE USER
========================================================= */

async function createUser({
name,
email,
phone = null,
country = null,
dialCode = null,
phoneInternational = null,
passwordHash = null,
googleId = null,
authProvider = 'password',
plan = 'free',
billing = 'monthly'
}) {
const columnsAvailable =
await getUsersColumns();

const columns = [];
const values = [];
const placeholders = [];

function add(column, value) {
if (!columnsAvailable.has(column)) {
return;
}

```
columns.push(column);
values.push(value);
placeholders.push(
  `$${values.length}`
);
```

}

/*
PostgreSQL UUID.
Compatible avec le schéma historique
de SellFlow qui utilise gen_random_uuid().
*/
if (columnsAvailable.has('id')) {
columns.push('id');
placeholders.push(
'gen_random_uuid()'
);
}

add(
'name',
cleanString(name, 150)
);

add(
'email',
normalizeEmail(email)
);

add(
'phone',
phone || null
);

add(
'country',
country || null
);

add(
'dial_code',
dialCode || null
);

add(
'phone_international',
phoneInternational || null
);

add(
'password_hash',
passwordHash
);

add(
'google_id',
googleId
);

add(
'auth_provider',
authProvider
);

/*
L'inscription directe est considérée
comme valide. Aucun code e-mail.
*/
add(
'email_verified',
true
);

add(
'plan',
plan
);

add(
'billing',
billing
);

add(
'subscription_status',
'active'
);

add(
'created_at',
new Date()
);

add(
'updated_at',
new Date()
);

if (!columns.length) {
throw new Error(
'La table users ne contient aucune colonne exploitable.'
);
}

const result = await pool.query(
`       INSERT INTO users (
        ${columns
          .map(quoteIdentifier)
          .join(', ')}
      )
      VALUES (
        ${placeholders.join(', ')}
      )
      RETURNING *
    `,
values
);

return result.rows[0];
}

/* =========================================================
GOOGLE ACCOUNT UPDATE
========================================================= */

async function setGoogleIdentity(
userId,
googleId,
name
) {
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
sets.push(
'google_id = $1'
);
}

if (
columnsAvailable.has('auth_provider')
) {
sets.push(
"auth_provider = 'google'"
);
}

if (
name &&
columnsAvailable.has('name')
) {
sets.push(
'name = $3'
);

```
values.push(name);
```

}

if (
columnsAvailable.has(
'email_verified'
)
) {
sets.push(
'email_verified = TRUE'
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
REGISTRATION DATA
========================================================= */

function getRegistrationData(
body = {}
) {
const name =
cleanString(
body.name,
150
);

const email =
normalizeEmail(
body.email
);

const password =
String(
body.password || ''
);

const password2 =
body.password2 == null
? password
: String(body.password2);

const passwordConfirmation =
body.password_confirmation == null
? password2
: String(
body.password_confirmation
);

const country =
cleanString(
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

const phone =
normalizePhone(
body.phone ||
body.phone_number ||
''
);

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

return {
name,
email,
password,
password2,
passwordConfirmation,
country,
dialCode,
phone,
phoneInternational
};
}

function validateRegistrationData(
data
) {
if (!data.name) {
return (
'Le nom est obligatoire.'
);
}

if (
!data.email ||
!isValidEmail(data.email)
) {
return (
'Veuillez fournir une adresse e-mail valide.'
);
}

if (
data.password.length < 8
) {
return (
'Le mot de passe doit contenir au moins 8 caractères.'
);
}

if (
data.password !==
data.password2
) {
return (
'Les mots de passe ne correspondent pas.'
);
}

if (
data.password !==
data.passwordConfirmation
) {
return (
'Les mots de passe ne correspondent pas.'
);
}

return null;
}

function emailAlreadyExistsResponse(
res
) {
return res.status(409).json({
ok: false,
code: 'EMAIL_ALREADY_EXISTS',
error: 'EMAIL_ALREADY_EXISTS',
message:
'Cette adresse e-mail est déjà utilisée. Connectez-vous à votre compte ou utilisez une autre adresse.'
});
}

/* =========================================================
REGISTER
AUCUNE VÉRIFICATION E-MAIL
========================================================= */

async function registerHandler(
req,
res
) {
try {
const data =
getRegistrationData(
req.body
);

```
const validationError =
  validateRegistrationData(
    data
  );

if (validationError) {
  return res.status(400).json({
    ok: false,
    code: 'VALIDATION_ERROR',
    message:
      validationError
  });
}

/*
  PROTECTION 1 :
  une adresse e-mail normalisée
  ne peut créer qu'un compte.
*/
const existingUser =
  await findUserByEmail(
    data.email
  );

if (existingUser) {
  return emailAlreadyExistsResponse(
    res
  );
}

const passwordHash =
  await hashPassword(
    data.password
  );

let user;

try {
  user =
    await createUser({
      name: data.name,
      email: data.email,
      phone:
        data.phone || null,
      country:
        data.country || null,
      dialCode:
        data.dialCode || null,
      phoneInternational:
        data.phoneInternational ||
        null,
      passwordHash,
      googleId: null,
      authProvider:
        'password',
      plan: 'free',
      billing: 'monthly'
    });
} catch (error) {
  /*
    PROTECTION 2 :
    contrainte UNIQUE PostgreSQL.
    23505 = duplicate key.
  */
  if (
    error &&
    error.code === '23505'
  ) {
    return emailAlreadyExistsResponse(
      res
    );
  }

  throw error;
}

const token =
  signToken(user);

return res.status(201).json({
  ok: true,
  created: true,
  verified: true,
  message:
    'Compte créé avec succès.',
  token,
  accessToken: token,
  user:
    publicUser(user)
});
```

} catch (error) {
console.error(
'❌ Erreur inscription:',
error
);

```
return res.status(500).json({
  ok: false,
  code: 'REGISTER_ERROR',
  error: 'REGISTER_ERROR',
  message:
    error.message ||
    'Impossible de créer le compte.'
});
```

}
}

router.post(
'/register',
registerHandler
);

/*
Compatibilité avec l'ancien frontend.
Cette route ne demande également aucun
code de vérification.
*/
router.post(
'/register/complete',
registerHandler
);

/* =========================================================
LOGIN
========================================================= */

router.post(
'/login',
async (req, res) => {
try {
const email =
normalizeEmail(
req.body &&
req.body.email
);

```
  const password =
    String(
      (
        req.body &&
        req.body.password
      ) || ''
    );

  if (
    !email ||
    !isValidEmail(email) ||
    !password
  ) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_INPUT',
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
      code:
        'INVALID_CREDENTIALS',
      message:
        'E-mail ou mot de passe incorrect.'
    });
  }

  const passwordHash =
    user.password_hash;

  /*
    Un compte Google pur n'a pas
    forcément de mot de passe local.
  */
  if (!passwordHash) {
    return res.status(401).json({
      ok: false,
      code: 'GOOGLE_ACCOUNT',
      message:
        'Ce compte utilise Google. Connectez-vous avec Google.'
    });
  }

  const valid =
    await comparePassword(
      password,
      passwordHash
    );

  if (!valid) {
    return res.status(401).json({
      ok: false,
      code:
        'INVALID_CREDENTIALS',
      message:
        'E-mail ou mot de passe incorrect.'
    });
  }

  const token =
    signToken(user);

  return res.json({
    ok: true,
    message:
      'Connexion réussie.',
    token,
    accessToken: token,
    user:
      publicUser(user)
  });
} catch (error) {
  console.error(
    '❌ Erreur connexion:',
    error
  );

  return res.status(500).json({
    ok: false,
    code: 'LOGIN_ERROR',
    error: 'LOGIN_ERROR',
    message:
      'Impossible de se connecter.'
  });
}
```

}
);

/* =========================================================
CURRENT USER
========================================================= */

router.get(
'/me',
authMiddleware,
async (req, res) => {
try {
const userId =
req.user &&
(
req.user.id ||
req.user.userId ||
req.user.sub
);

```
  if (!userId) {
    return res.status(401).json({
      ok: false,
      code:
        'UNAUTHENTICATED',
      message:
        'Utilisateur non authentifié.'
    });
  }

  const user =
    await findUserById(
      userId
    );

  if (!user) {
    return res.status(404).json({
      ok: false,
      code:
        'USER_NOT_FOUND',
      message:
        'Compte introuvable.'
    });
  }

  return res.json({
    ok: true,
    user:
      publicUser(user)
  });
} catch (error) {
  console.error(
    '❌ Erreur /auth/me:',
    error
  );

  return res.status(500).json({
    ok: false,
    code: 'ME_ERROR',
    message:
      'Impossible de récupérer le compte.'
  });
}
```

}
);

/* =========================================================
CHANGE PASSWORD
========================================================= */

router.post(
'/change-password',
authMiddleware,
async (req, res) => {
try {
const userId =
req.user &&
(
req.user.id ||
req.user.userId ||
req.user.sub
);

```
  const currentPassword =
    String(
      req.body.currentPassword ||
      ''
    );

  const newPassword =
    String(
      req.body.newPassword ||
      ''
    );

  if (!userId) {
    return res.status(401).json({
      ok: false,
      message:
        'Utilisateur non authentifié.'
    });
  }

  if (
    !currentPassword ||
    !newPassword
  ) {
    return res.status(400).json({
      ok: false,
      message:
        'Ancien et nouveau mot de passe obligatoires.'
    });
  }

  if (
    newPassword.length < 8
  ) {
    return res.status(400).json({
      ok: false,
      message:
        'Le nouveau mot de passe doit contenir au moins 8 caractères.'
    });
  }

  const user =
    await findUserById(
      userId
    );

  if (
    !user ||
    !user.password_hash
  ) {
    return res.status(400).json({
      ok: false,
      message:
        'Ce compte ne possède pas de mot de passe local.'
    });
  }

  const valid =
    await comparePassword(
      currentPassword,
      user.password_hash
    );

  if (!valid) {
    return res.status(401).json({
      ok: false,
      message:
        'Ancien mot de passe incorrect.'
    });
  }

  const newHash =
    await hashPassword(
      newPassword
    );

  await pool.query(
    `
      UPDATE users
      SET
        password_hash = $1,
        updated_at = NOW()
      WHERE id = $2
    `,
    [
      newHash,
      userId
    ]
  );

  return res.json({
    ok: true,
    message:
      'Mot de passe modifié avec succès.'
  });
} catch (error) {
  console.error(
    '❌ Erreur changement mot de passe:',
    error
  );

  return res.status(500).json({
    ok: false,
    code:
      'CHANGE_PASSWORD_ERROR',
    message:
      'Impossible de modifier le mot de passe.'
  });
}
```

}
);

/* =========================================================
GOOGLE / GMAIL
========================================================= */

function createGoogleClient() {
if (
!GOOGLE_CLIENT_ID ||
!GOOGLE_CLIENT_SECRET
) {
return null;
}

return new google.auth.OAuth2(
GOOGLE_CLIENT_ID,
GOOGLE_CLIENT_SECRET,
GOOGLE_REDIRECT_URI
);
}

/* ---------------------------------------------------------
/auth/google
--------------------------------------------------------- */

router.get(
'/google',
(req, res) => {
try {
const client =
createGoogleClient();

```
  if (!client) {
    return res.status(500).json({
      ok: false,
      code:
        'GOOGLE_NOT_CONFIGURED',
      message:
        'La connexion Google n’est pas configurée sur le backend.'
    });
  }

  const url =
    client.generateAuthUrl({
      access_type: 'offline',
      prompt:
        'select_account',
      scope: [
        'openid',
        'profile',
        'email'
      ]
    });

  return res.redirect(
    url
  );
} catch (error) {
  console.error(
    '❌ Erreur Google connect:',
    error
  );

  return res.status(500).json({
    ok: false,
    code:
      'GOOGLE_CONNECT_ERROR',
    message:
      'Impossible de démarrer la connexion Google.'
  });
}
```

}
);

/* ---------------------------------------------------------
Ancienne URL /auth/gmail/connect
--------------------------------------------------------- */

router.get(
'/gmail/connect',
(req, res) => {
return res.redirect(
`${BACKEND_URL}/auth/google`
);
}
);

/* =========================================================
GOOGLE CALLBACK
========================================================= */

async function googleCallbackHandler(
req,
res
) {
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

const client =
  createGoogleClient();

if (!client) {
  return res.redirect(
    `${FRONTEND_URL}/?google_error=not_configured`
  );
}

const {
  tokens
} =
  await client.getToken(
    code
  );

client.setCredentials(
  tokens
);

const oauth2 =
  google.oauth2({
    auth: client,
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
    'Utilisateur SellFlow',
    150
  );

if (
  !googleId ||
  !email ||
  !isValidEmail(email)
) {
  return res.redirect(
    `${FRONTEND_URL}/?google_error=incomplete_profile`
  );
}

/*
  IMPORTANT :
  on recherche d'abord l'e-mail.
  Donc un e-mail Google existant
  ne crée PAS un deuxième compte.
*/
let user =
  await findUserByEmail(
    email
  );

if (user) {
  console.log(
    '✅ Google : compte existant réutilisé pour',
    email
  );

  await setGoogleIdentity(
    user.id,
    googleId,
    user.name || name
  );

  user =
    await findUserById(
      user.id
    );
} else {
  try {
    user =
      await createUser({
        name,
        email,
        phone: null,
        country: null,
        dialCode: null,
        phoneInternational:
          null,
        passwordHash: null,
        googleId,
        authProvider:
          'google',
        plan: 'free',
        billing: 'monthly'
      });
  } catch (error) {
    /*
      Si deux requêtes Google
      tentent le même e-mail,
      PostgreSQL bloque le doublon.
    */
    if (
      error &&
      error.code === '23505'
    ) {
      user =
        await findUserByEmail(
          email
        );
    } else {
      throw error;
    }
  }
}

if (!user) {
  return res.redirect(
    `${FRONTEND_URL}/?google_error=user_creation_failed`
  );
}

const token =
  signToken(user);

const userJson =
  encodeURIComponent(
    JSON.stringify(
      publicUser(user)
    )
  );

return res.redirect(
  `${FRONTEND_URL}/?google_auth=success&token=${encodeURIComponent(token)}&user=${userJson}`
);
```

} catch (error) {
console.error(
'❌ Erreur Google callback:',
error
);

```
return res.redirect(
  `${FRONTEND_URL}/?google_error=callback_failed`
);
```

}
}

/*
Nouvelle URL.
*/
router.get(
'/google/callback',
googleCallbackHandler
);

/*
Ancienne URL conservée pour
compatibilité avec Gmail/Google
déjà configuré.
*/
router.get(
'/gmail/callback',
googleCallbackHandler
);

/* =========================================================
STATUS
========================================================= */

router.get(
'/status',
(req, res) => {
return res.json({
ok: true,
service:
'SellFlow authentication',
emailVerification:
'disabled',
uniqueEmail:
'enabled',
googleAuth:
GOOGLE_CLIENT_ID &&
GOOGLE_CLIENT_SECRET
? 'configured'
: 'not-configured',
resend:
'disabled'
});
}
);

/* =========================================================
ANCIEN SYSTÈME EMAIL DÉSACTIVÉ
========================================================= */

router.all(
'/register/request-email-code',
(req, res) => {
return res.status(410).json({
ok: false,
code:
'EMAIL_VERIFICATION_DISABLED',
message:
'La vérification par e-mail est désactivée. Utilise directement /auth/register.'
});
}
);

router.all(
'/register/verify-email-code',
(req, res) => {
return res.status(410).json({
ok: false,
code:
'EMAIL_VERIFICATION_DISABLED',
message:
'La vérification par e-mail est désactivée.'
});
}
);

router.all(
'/register/resend-email-code',
(req, res) => {
return res.status(410).json({
ok: false,
code:
'EMAIL_VERIFICATION_DISABLED',
message:
'La vérification par e-mail est désactivée.'
});
}
);

router.all(
'/test-email',
(req, res) => {
return res.status(410).json({
ok: false,
code:
'EMAIL_SERVICE_DISABLED',
message:
'Le service d’e-mail est désactivé.'
});
}
);

/* =========================================================
EXPORT
========================================================= */

module.exports = router;
