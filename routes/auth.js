const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');

const { getPool } = require('../config/database');

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
  .replace(/\/+$/, '');

const BACKEND_URL = (
  process.env.BACKEND_URL ||
  'https://sellflow-backend.onrender.com'
)
  .trim()
  .replace(/\/+$/, '');

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SECRET_KEY ||
  'sellflow-change-this-secret-in-render';

const JWT_EXPIRES_IN =
  process.env.JWT_EXPIRES_IN ||
  '30d';

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || '';

const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || '';

const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  `${BACKEND_URL}/auth/google/callback`;

const PROMO_CODE = 'BLACKING';

/* =========================================================
   HELPERS
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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizePhone(value) {
  return String(value || '')
    .trim()
    .replace(/[^\d+]/g, '')
    .slice(0, 30);
}

function getBearerToken(req) {
  const header = String(
    req.headers.authorization || ''
  );

  if (!header.startsWith('Bearer ')) {
    return '';
  }

  return header.slice(7).trim();
}

function signToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      id: String(user.id),
      email: normalizeEmail(user.email),
      name: user.name || ''
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN
    }
  );
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name || '',
    email: normalizeEmail(user.email),
    phone: user.phone || '',
    country: user.country || '',
    plan: user.plan || 'free',
    billing: user.billing || 'monthly',
    subscription_status:
      user.subscription_status || 'inactive',
    subscription_started_at:
      user.subscription_started_at || null,
    subscription_expires_at:
      user.subscription_expires_at || null,
    email_verified:
      user.email_verified !== false,
    auth_provider:
      user.auth_provider || 'password',
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
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
    ORDER BY ordinal_position
  `);

  return new Set(
    result.rows.map((row) => row.column_name)
  );
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function findUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT *
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
    `
      SELECT *
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function createUser({
  name,
  email,
  phone = null,
  country = null,
  passwordHash = null,
  plan = 'free',
  billing = 'monthly',
  subscriptionStatus = 'active',
  googleId = null,
  authProvider = 'password'
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

    columns.push(quoteIdentifier(column));
    values.push(value);
    placeholders.push(
      `$${values.length}`
    );
  }

  if (columnsAvailable.has('id')) {
    columns.push('"id"');
    placeholders.push('gen_random_uuid()');
  }

  add(
    'name',
    cleanString(name, 120)
  );

  add(
    'email',
    normalizeEmail(email)
  );

  add(
    'phone',
    normalizePhone(phone)
  );

  add(
    'country',
    cleanString(country, 100)
  );

  if (passwordHash) {
    add(
      'password_hash',
      passwordHash
    );
  }

  add(
    'email_verified',
    true
  );

  add(
    'plan',
    plan
  );

  add(
    'subscription_status',
    subscriptionStatus
  );

  const subscriptionStartedAt =
    plan !== 'free'
      ? new Date()
      : null;

  const subscriptionExpiresAt =
    plan === 'business' &&
    billing === 'yearly'
      ? new Date(
          Date.now() +
          365 * 24 * 60 * 60 * 1000
        )
      : null;

  add(
    'subscription_started_at',
    subscriptionStartedAt
  );

  add(
    'subscription_expires_at',
    subscriptionExpiresAt
  );

  add(
    'google_id',
    googleId
  );

  add(
    'auth_provider',
    authProvider
  );

  add(
    'billing',
    billing
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

  const query = `
    INSERT INTO users (
      ${columns.join(', ')}
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

async function updateGoogleIdentity(
  userId,
  googleId,
  name
) {
  const columnsAvailable =
    await getUsersColumns();

  const sets = [];
  const values = [];
  let index = 1;

  function setIfExists(
    column,
    value
  ) {
    if (!columnsAvailable.has(column)) {
      return;
    }

    sets.push(
      `${quoteIdentifier(column)} = $${index}`
    );

    values.push(value);
    index += 1;
  }

  setIfExists(
    'google_id',
    googleId
  );

  setIfExists(
    'auth_provider',
    'google'
  );

  if (
    name &&
    columnsAvailable.has('name')
  ) {
    setIfExists(
      'name',
      cleanString(name, 120)
    );
  }

  if (
    columnsAvailable.has('email_verified')
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

  values.push(userId);

  await pool.query(
    `
      UPDATE users
      SET ${sets.join(', ')}
      WHERE id = $${values.length}
    `,
    values
  );
}

/* =========================================================
   REGISTRATION
========================================================= */

function getRegistrationData(body) {
  const input = body || {};

  return {
    name: cleanString(
      input.name,
      120
    ),

    email: normalizeEmail(
      input.email
    ),

    password: String(
      input.password || ''
    ),

    passwordConfirmation:
      input.passwordConfirmation != null
        ? String(
            input.passwordConfirmation
          )
        : input.password_confirmation != null
          ? String(
              input.password_confirmation
            )
          : input.password2 != null
            ? String(input.password2)
            : '',

    phone: normalizePhone(
      input.phone ||
      input.phone_number ||
      ''
    ),

    country: cleanString(
      input.country,
      100
    ),

    promoCode: cleanString(
      input.promoCode ||
      input.promo_code ||
      input.codePromo ||
      input.code_promo ||
      '',
      50
    ).toUpperCase()
  };
}

function validateRegistrationData(data) {
  if (!data.name) {
    return 'Le nom est obligatoire.';
  }

  if (
    !data.email ||
    !isValidEmail(data.email)
  ) {
    return 'Veuillez fournir une adresse e-mail valide.';
  }

  if (data.password.length < 8) {
    return 'Le mot de passe doit contenir au moins 8 caractères.';
  }

  if (
    data.passwordConfirmation &&
    data.password !==
      data.passwordConfirmation
  ) {
    return 'Les mots de passe ne correspondent pas.';
  }

  return null;
}

function emailAlreadyExistsResponse(res) {
  return res.status(409).json({
    ok: false,
    code: 'EMAIL_ALREADY_EXISTS',
    error: 'EMAIL_ALREADY_EXISTS',
    message:
      'Cette adresse e-mail possède déjà un compte. Connecte-toi avec ce compte.'
  });
}

async function registerHandler(req, res) {
  try {
    const data =
      getRegistrationData(
        req.body
      );

    const validationError =
      validateRegistrationData(
        data
      );

    if (validationError) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: 'VALIDATION_ERROR',
        message: validationError
      });
    }

    /* UNE ADRESSE EMAIL = UN COMPTE */
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
      await bcrypt.hash(
        data.password,
        12
      );

    /*
     * BLACKING = Business annuel
     */
    const promoApplied =
      data.promoCode === PROMO_CODE;

    const plan =
      promoApplied
        ? 'business'
        : 'free';

    const billing =
      promoApplied
        ? 'yearly'
        : 'monthly';

    let user;

    try {
      user = await createUser({
        name: data.name,
        email: data.email,
        phone: data.phone || null,
        country: data.country || null,
        passwordHash,
        plan,
        billing,
        subscriptionStatus: 'active',
        googleId: null,
        authProvider: 'password'
      });
    } catch (error) {
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
      promoApplied,
      message:
        promoApplied
          ? 'Compte créé. Le code BLACKING a activé la version Business annuelle.'
          : 'Compte créé avec succès.',
      token,
      accessToken: token,
      user: publicUser(user)
    });
  } catch (error) {
    console.error(
      '❌ Erreur /auth/register:',
      error
    );

    return res.status(500).json({
      ok: false,
      code: 'REGISTER_ERROR',
      error: 'REGISTER_ERROR',
      message:
        error.message ||
        'Impossible de créer le compte.'
    });
  }
}

router.post(
  '/register',
  registerHandler
);

router.post(
  '/register/complete',
  registerHandler
);

/* =========================================================
   LOGIN
========================================================= */

router.post(
  '/login',
  async function (req, res) {
    try {
      const email =
        normalizeEmail(
          req.body &&
          req.body.email
        );

      const password =
        String(
          (req.body &&
            req.body.password) ||
          ''
        );

      if (
        !email ||
        !isValidEmail(email) ||
        !password
      ) {
        return res.status(400).json({
          ok: false,
          code: 'INVALID_INPUT',
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
          code: 'INVALID_CREDENTIALS',
          error: 'INVALID_CREDENTIALS',
          message:
            'E-mail ou mot de passe incorrect.'
        });
      }

      const storedHash =
        user.password_hash ||
        user.passwordHash ||
        '';

      if (!storedHash) {
        return res.status(401).json({
          ok: false,
          code: 'GOOGLE_ACCOUNT',
          error: 'PASSWORD_LOGIN_UNAVAILABLE',
          message:
            'Ce compte utilise Google. Connectez-vous avec Google.'
        });
      }

      const valid =
        await bcrypt.compare(
          password,
          storedHash
        );

      if (!valid) {
        return res.status(401).json({
          ok: false,
          code: 'INVALID_CREDENTIALS',
          error: 'INVALID_CREDENTIALS',
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
        user: publicUser(user)
      });
    } catch (error) {
      console.error(
        '❌ Erreur /auth/login:',
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
  }
);

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

async function authMiddleware(
  req,
  res,
  next
) {
  try {
    const token =
      getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        ok: false,
        code: 'UNAUTHENTICATED',
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

    const userId =
      payload &&
      (
        payload.id ||
        payload.sub
      );

    if (!userId) {
      return res.status(401).json({
        ok: false,
        code: 'INVALID_TOKEN',
        error: 'INVALID_TOKEN',
        message:
          'Token invalide.'
      });
    }

    const user =
      await findUserById(
        userId
      );

    if (!user) {
      return res.status(404).json({
        ok: false,
        code: 'USER_NOT_FOUND',
        error: 'USER_NOT_FOUND',
        message:
          'Compte introuvable.'
      });
    }

    req.user = user;
    req.auth = payload;

    return next();
  } catch (error) {
    console.error(
      '❌ Auth middleware:',
      error.message
    );

    return res.status(401).json({
      ok: false,
      code: 'INVALID_TOKEN',
      error: 'INVALID_TOKEN',
      message:
        'Session invalide ou expirée.'
    });
  }
}

/* =========================================================
   CURRENT USER
========================================================= */

router.get(
  '/me',
  authMiddleware,
  async function (req, res) {
    try {
      const user =
        await findUserById(
          req.user.id
        );

      if (!user) {
        return res.status(404).json({
          ok: false,
          code: 'USER_NOT_FOUND',
          error: 'USER_NOT_FOUND',
          message:
            'Compte introuvable.'
        });
      }

      return res.json({
        ok: true,
        user: publicUser(user)
      });
    } catch (error) {
      console.error(
        '❌ Erreur /auth/me:',
        error
      );

      return res.status(500).json({
        ok: false,
        code: 'ME_ERROR',
        error: 'ME_ERROR',
        message:
          'Impossible de récupérer le compte.'
      });
    }
  }
);

/* =========================================================
   CHANGE PASSWORD
========================================================= */

router.post(
  '/change-password',
  authMiddleware,
  async function (req, res) {
    try {
      const currentPassword =
        String(
          req.body &&
          req.body.currentPassword
            ? req.body.currentPassword
            : ''
        );

      const newPassword =
        String(
          req.body &&
          req.body.newPassword
            ? req.body.newPassword
            : ''
        );

      if (
        !currentPassword ||
        !newPassword
      ) {
        return res.status(400).json({
          ok: false,
          code: 'PASSWORD_REQUIRED',
          message:
            'Ancien et nouveau mot de passe obligatoires.'
        });
      }

      if (
        newPassword.length < 8
      ) {
        return res.status(400).json({
          ok: false,
          code: 'PASSWORD_TOO_SHORT',
          message:
            'Le nouveau mot de passe doit contenir au moins 8 caractères.'
        });
      }

      const user =
        await findUserById(
          req.user.id
        );

      const currentHash =
        user &&
        (
          user.password_hash ||
          user.passwordHash
        );

      if (!currentHash) {
        return res.status(400).json({
          ok: false,
          code: 'NO_LOCAL_PASSWORD',
          message:
            'Ce compte ne possède pas de mot de passe local.'
        });
      }

      const valid =
        await bcrypt.compare(
          currentPassword,
          currentHash
        );

      if (!valid) {
        return res.status(401).json({
          ok: false,
          code: 'INVALID_CURRENT_PASSWORD',
          message:
            'Ancien mot de passe incorrect.'
        });
      }

      const newHash =
        await bcrypt.hash(
          newPassword,
          12
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
          req.user.id
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
        code: 'CHANGE_PASSWORD_ERROR',
        message:
          'Impossible de modifier le mot de passe.'
      });
    }
  }
);

/* =========================================================
   GOOGLE OAUTH
========================================================= */

function getGoogleClient() {
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

router.get(
  '/google',
  function (req, res) {
    try {
      const client =
        getGoogleClient();

      if (!client) {
        return res.status(500).json({
          ok: false,
          code: 'GOOGLE_NOT_CONFIGURED',
          message:
            'La connexion Google n’est pas configurée sur le backend.'
        });
      }

      const url =
        client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'select_account',
          scope: [
            'openid',
            'email',
            'profile'
          ]
        });

      return res.redirect(url);
    } catch (error) {
      console.error(
        '❌ Erreur /auth/google:',
        error
      );

      return res.status(500).json({
        ok: false,
        code: 'GOOGLE_CONNECT_ERROR',
        message:
          'Impossible de démarrer la connexion Google.'
      });
    }
  }
);

router.get(
  '/gmail/connect',
  function (req, res) {
    return res.redirect(
      `${BACKEND_URL}/auth/google`
    );
  }
);

async function googleCallbackHandler(
  req,
  res
) {
  try {
    const code =
      cleanString(
        req.query &&
        req.query.code,
        2000
      );

    if (!code) {
      return res.redirect(
        `${FRONTEND_URL}/?google_error=missing_code`
      );
    }

    const client =
      getGoogleClient();

    if (!client) {
      return res.redirect(
        `${FRONTEND_URL}/?google_error=not_configured`
      );
    }

    const { tokens } =
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

    const { data } =
      await oauth2.userinfo.get();

    const googleId =
      cleanString(
        data && data.id,
        300
      );

    const email =
      normalizeEmail(
        data && data.email
      );

    const name =
      cleanString(
        (data && data.name) ||
        (data && data.given_name) ||
        'Utilisateur SellFlow',
        120
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
     * On cherche d'abord l'e-mail.
     * Donc un compte Google existant n'en crée pas un deuxième.
     */
    let user =
      await findUserByEmail(
        email
      );

    if (user) {
      await updateGoogleIdentity(
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
            passwordHash: null,
            plan: 'free',
            billing: 'monthly',
            subscriptionStatus: 'active',
            googleId,
            authProvider: 'google'
          });
      } catch (error) {
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
      `${FRONTEND_URL}/?google_auth=success&token=${encodeURIComponent(
        token
      )}&user=${userJson}`
    );
  } catch (error) {
    console.error(
      '❌ Erreur callback Google:',
      error
    );

    return res.redirect(
      `${FRONTEND_URL}/?google_error=callback_failed`
    );
  }
}

router.get(
  '/google/callback',
  googleCallbackHandler
);

router.get(
  '/gmail/callback',
  googleCallbackHandler
);

/* =========================================================
   ANCIEN SYSTÈME EMAIL DÉSACTIVÉ
========================================================= */

router.all(
  '/register/request-email-code',
  function (req, res) {
    return res.status(410).json({
      ok: false,
      code: 'EMAIL_VERIFICATION_DISABLED',
      message:
        'La vérification par e-mail est désactivée. Utilise directement /auth/register.'
    });
  }
);

router.all(
  '/register/verify-email-code',
  function (req, res) {
    return res.status(410).json({
      ok: false,
      code: 'EMAIL_VERIFICATION_DISABLED',
      message:
        'La vérification par e-mail est désactivée.'
    });
  }
);

router.all(
  '/register/resend-email-code',
  function (req, res) {
    return res.status(410).json({
      ok: false,
      code: 'EMAIL_VERIFICATION_DISABLED',
      message:
        'La vérification par e-mail est désactivée.'
    });
  }
);

router.all(
  '/test-email',
  function (req, res) {
    return res.status(410).json({
      ok: false,
      code: 'EMAIL_SERVICE_DISABLED',
      message:
        'Le service e-mail est désactivé.'
    });
  }
);

/* =========================================================
   STATUS
========================================================= */

router.get(
  '/status',
  function (req, res) {
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
   EXPORT
========================================================= */

module.exports = router;
