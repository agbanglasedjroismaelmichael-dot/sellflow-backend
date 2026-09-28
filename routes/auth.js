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

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || '';

const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || '';

const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  BACKEND_URL + '/auth/gmail/callback';

/* =========================================================
   HELPERS
========================================================= */

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
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
    phone: user.phone || null,
    country: user.country || null,
    plan: user.plan || 'free',
    email_verified:
      user.email_verified !== false,
    subscription_status:
      user.subscription_status || null,
    subscription_started_at:
      user.subscription_started_at || null,
    subscription_expires_at:
      user.subscription_expires_at || null,
    created_at:
      user.created_at || null,
    updated_at:
      user.updated_at || null
  };
}

async function findUserByEmail(email) {
  const normalizedEmail =
    normalizeEmail(email);

  if (!normalizedEmail) {
    return null;
  }

  const result = await pool.query(
    'SELECT * FROM users ' +
      'WHERE LOWER(TRIM(email)) = $1 ' +
      'LIMIT 1',
    [normalizedEmail]
  );

  return result.rows[0] || null;
}

function emailAlreadyExistsResponse(res) {
  return res.status(409).json({
    ok: false,
    code: 'EMAIL_ALREADY_EXISTS',
    message:
      'Cette adresse e-mail est déjà utilisée. Connectez-vous à votre compte ou utilisez une autre adresse.'
  });
}

function getRegistrationData(body) {
  body = body || {};

  const password =
    String(body.password || '');

  return {
    name:
      String(body.name || '').trim(),

    email:
      normalizeEmail(body.email),

    phone:
      String(body.phone || '').trim(),

    country:
      String(body.country || '').trim(),

    password,

    password2:
      body.password2 === undefined ||
      body.password2 === null
        ? password
        : String(body.password2)
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
    return (
      'Veuillez fournir une adresse e-mail valide.'
    );
  }

  if (
    data.password.length < 6
  ) {
    return (
      'Le mot de passe doit contenir au moins 6 caractères.'
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

  return null;
}

async function createUser({
  name,
  email,
  phone,
  country,
  passwordHash,
  plan = 'free'
}) {
  const result = await pool.query(
    'INSERT INTO users ' +
      '(id, name, email, phone, country, password_hash, email_verified, plan) ' +
      'VALUES ' +
      '(gen_random_uuid(), $1, $2, $3, $4, $5, TRUE, $6) ' +
      'RETURNING *',
    [
      String(name || '').trim(),
      normalizeEmail(email),
      phone
        ? String(phone).trim()
        : null,
      country
        ? String(country).trim()
        : null,
      passwordHash,
      plan
    ]
  );

  return result.rows[0];
}

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

/* =========================================================
   INSCRIPTION
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

    const validationError =
      validateRegistrationData(
        data
      );

    if (validationError) {
      return res.status(400).json({
        ok: false,
        message: validationError
      });
    }

    /*
     * Une adresse e-mail ne peut
     * appartenir qu'à un seul compte.
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
      user = await createUser({
        name: data.name,
        email: data.email,
        phone: data.phone,
        country: data.country,
        passwordHash,
        plan: 'free'
      });
    } catch (error) {
      /*
       * PostgreSQL 23505 = doublon.
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
      user:
        publicUser(user)
    });
  } catch (error) {
    console.error(
      '❌ Erreur inscription:',
      error
    );

    return res.status(500).json({
      ok: false,
      error: 'REGISTER_ERROR',
      message:
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
   CONNEXION
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
          (
            req.body &&
            req.body.password
          ) || ''
        );

      if (
        !email ||
        !isValidEmail(email)
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Veuillez fournir une adresse e-mail valide.'
        });
      }

      if (!password) {
        return res.status(400).json({
          ok: false,
          message:
            'Le mot de passe est obligatoire.'
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

      if (!user.password_hash) {
        return res.status(401).json({
          ok: false,
          code:
            'GOOGLE_ACCOUNT',
          message:
            'Ce compte utilise Google. Connectez-vous avec Google.'
        });
      }

      const validPassword =
        await comparePassword(
          password,
          user.password_hash
        );

      if (!validPassword) {
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
        error:
          'LOGIN_ERROR',
        message:
          'Impossible de se connecter.'
      });
    }
  }
);

/* =========================================================
   UTILISATEUR CONNECTÉ
========================================================= */

router.get(
  '/me',
  authMiddleware,
  async function (req, res) {
    try {
      const userId =
        req.user &&
        (
          req.user.id ||
          req.user.userId ||
          req.user.sub
        );

      if (!userId) {
        return res.status(401).json({
          ok: false,
          message:
            'Utilisateur non authentifié.'
        });
      }

      const result =
        await pool.query(
          'SELECT * FROM users ' +
            'WHERE id = $1 ' +
            'LIMIT 1',
          [userId]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          ok: false,
          message:
            'Compte introuvable.'
        });
      }

      return res.json({
        ok: true,
        user:
          publicUser(
            result.rows[0]
          )
      });
    } catch (error) {
      console.error(
        '❌ Erreur /me:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          'ME_ERROR',
        message:
          'Impossible de récupérer le compte.'
      });
    }
  }
);

/* =========================================================
   CHANGEMENT DE MOT DE PASSE
========================================================= */

router.post(
  '/change-password',
  authMiddleware,
  async function (req, res) {
    try {
      const userId =
        req.user &&
        (
          req.user.id ||
          req.user.userId ||
          req.user.sub
        );

      const currentPassword =
        String(
          (
            req.body &&
            req.body.currentPassword
          ) || ''
        );

      const newPassword =
        String(
          (
            req.body &&
            req.body.newPassword
          ) || ''
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
        newPassword.length < 6
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Le nouveau mot de passe doit contenir au moins 6 caractères.'
        });
      }

      const result =
        await pool.query(
          'SELECT * FROM users ' +
            'WHERE id = $1 ' +
            'LIMIT 1',
          [userId]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          ok: false,
          message:
            'Compte introuvable.'
        });
      }

      const user =
        result.rows[0];

      if (
        !user.password_hash
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Ce compte Google ne possède pas de mot de passe local.'
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

      const newPasswordHash =
        await hashPassword(
          newPassword
        );

      await pool.query(
        'UPDATE users ' +
          'SET password_hash = $1, updated_at = NOW() ' +
          'WHERE id = $2',
        [
          newPasswordHash,
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
        error:
          'CHANGE_PASSWORD_ERROR',
        message:
          'Impossible de modifier le mot de passe.'
      });
    }
  }
);

/* =========================================================
   GOOGLE / GMAIL
========================================================= */

router.get(
  '/gmail/connect',
  function (req, res) {
    try {
      const client =
        createGoogleClient();

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
          prompt: 'select_account',
          scope: [
            'openid',
            'profile',
            'email'
          ]
        });

      return res.redirect(url);
    } catch (error) {
      console.error(
        '❌ Erreur Google connect:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          'GOOGLE_CONNECT_ERROR',
        message:
          'Impossible de démarrer la connexion Google.'
      });
    }
  }
);

/* =========================================================
   GOOGLE CALLBACK
========================================================= */

router.get(
  '/gmail/callback',
  async function (req, res) {
    try {
      const code =
        String(
          (
            req.query &&
            req.query.code
          ) || ''
        ).trim();

      if (!code) {
        return res.redirect(
          FRONTEND_URL +
            '/#google-auth-error'
        );
      }

      const client =
        createGoogleClient();

      if (!client) {
        return res.redirect(
          FRONTEND_URL +
            '/#google-auth-error'
        );
      }

      const tokenResponse =
        await client.getToken(
          code
        );

      client.setCredentials(
        tokenResponse.tokens
      );

      const oauth2 =
        google.oauth2({
          auth: client,
          version: 'v2'
        });

      const userInfoResponse =
        await oauth2.userinfo.get();

      const googleUser =
        userInfoResponse.data ||
        {};

      const googleEmail =
        normalizeEmail(
          googleUser.email
        );

      if (
        !googleEmail ||
        !isValidEmail(
          googleEmail
        )
      ) {
        return res.redirect(
          FRONTEND_URL +
            '/#google-auth-error'
        );
      }

      /*
       * IMPORTANT :
       * On recherche d'abord
       * l'e-mail existant.
       *
       * Un e-mail = un compte.
       */
      let user =
        await findUserByEmail(
          googleEmail
        );

      if (user) {
        console.log(
          '✅ Google : compte existant réutilisé.'
        );
      } else {
        /*
         * Nouveau compte Google.
         */
        const randomPassword =
          crypto.randomBytes(
            32
          ).toString('hex');

        const passwordHash =
          await hashPassword(
            randomPassword
          );

        try {
          user =
            await createUser({
              name:
                String(
                  googleUser.name ||
                  googleUser.given_name ||
                  'Utilisateur SellFlow'
                ).trim(),

              email:
                googleEmail,

              phone:
                null,

              country:
                null,

              passwordHash:
                passwordHash,

              plan:
                'free'
            });

          console.log(
            '✅ Google : nouveau compte créé.'
          );
        } catch (error) {
          /*
           * Un autre processus a pu
           * créer le même e-mail.
           */
          if (
            error &&
            error.code === '23505'
          ) {
            user =
              await findUserByEmail(
                googleEmail
              );
          } else {
            throw error;
          }
        }
      }

      if (!user) {
        return res.redirect(
          FRONTEND_URL +
            '/#google-auth-error'
        );
      }

      const token =
        signToken(user);

      return res.redirect(
        FRONTEND_URL +
          '/#google-auth-success?token=' +
          encodeURIComponent(token)
      );
    } catch (error) {
      console.error(
        '❌ Erreur Google callback:',
        error
      );

      return res.redirect(
        FRONTEND_URL +
          '/#google-auth-error'
      );
    }
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
