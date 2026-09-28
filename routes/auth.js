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

/* =========================================================
   BASE DE DONNÉES
========================================================= */

const pool = getPool();

/* =========================================================
   OUTILS
========================================================= */

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: normalizeEmail(user.email),
    phone: user.phone || '',
    country: user.country || '',
    email_verified: user.email_verified === true,
    plan: user.plan || 'free',
    created_at: user.created_at
  };
}

function isValidEmail(email) {
  return /^\S+@\S+\.\S+$/.test(email);
}

/* =========================================================
   INSCRIPTION
   SANS VÉRIFICATION EMAIL
========================================================= */

router.post('/register/complete', async (req, res) => {
  try {
    let {
      name,
      email,
      phone,
      country,
      password,
      password2
    } = req.body || {};

    name = String(name || '').trim();
    email = normalizeEmail(email);
    phone = String(phone || '').trim();
    country = String(country || '').trim();
    password = String(password || '');
    password2 =
      password2 == null
        ? password
        : String(password2);

    /* -----------------------------------------
       VALIDATION
    ----------------------------------------- */

    if (!name) {
      return res.status(400).json({
        message: 'Le nom est obligatoire.'
      });
    }

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        message: 'Adresse e-mail invalide.'
      });
    }

    if (!phone || phone.length < 5) {
      return res.status(400).json({
        message: 'Numéro de téléphone invalide.'
      });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({
        message:
          'Le mot de passe doit contenir au moins 8 caractères.'
      });
    }

    if (password !== password2) {
      return res.status(400).json({
        message:
          'Les mots de passe ne correspondent pas.'
      });
    }

    /* -----------------------------------------
       EMAIL DÉJÀ UTILISÉ ?
    ----------------------------------------- */

    const existingUser = await pool.query(
      `
      SELECT id, email
      FROM users
      WHERE LOWER(TRIM(email)) = $1
      LIMIT 1
      `,
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        code: 'EMAIL_ALREADY_EXISTS',
        message:
          'Cette adresse e-mail est déjà utilisée par un compte SellFlow. Utilise une autre adresse ou connecte-toi à ton compte.'
      });
    }

    /* -----------------------------------------
       HASH MOT DE PASSE
    ----------------------------------------- */

    const passwordHash =
      await hashPassword(password);

    /* -----------------------------------------
       CRÉATION DU COMPTE
    ----------------------------------------- */

    let result;

    try {
      result = await pool.query(
        `
        INSERT INTO users (
          id,
          name,
          email,
          phone,
          country,
          password_hash,
          email_verified,
          plan
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4,
          $5,
          TRUE,
          'free'
        )
        RETURNING
          id,
          name,
          email,
          phone,
          country,
          email_verified,
          plan,
          created_at
        `,
        [
          name,
          email,
          phone,
          country,
          passwordHash
        ]
      );
    } catch (dbError) {
      /*
        Protection contre deux inscriptions
        simultanées avec le même e-mail.
      */

      if (
        dbError &&
        dbError.code === '23505'
      ) {
        return res.status(409).json({
          code: 'EMAIL_ALREADY_EXISTS',
          message:
            'Cette adresse e-mail est déjà utilisée par un compte SellFlow. Utilise une autre adresse ou connecte-toi à ton compte.'
        });
      }

      throw dbError;
    }

    const user = result.rows[0];

    /* -----------------------------------------
       JWT
    ----------------------------------------- */

    const token = signToken(user);

    /* -----------------------------------------
       RÉPONSE
    ----------------------------------------- */

    return res.status(201).json({
      created: true,
      verified: true,
      message:
        'Compte SellFlow créé avec succès.',
      token,
      user: publicUser(user)
    });

  } catch (error) {
    console.error(
      '[AUTH REGISTER COMPLETE]',
      error
    );

    return res.status(500).json({
      message:
        'Impossible de créer le compte pour le moment.'
    });
  }
});

/* =========================================================
   REGISTER CLASSIQUE
   COMPATIBILITÉ ANCIEN FRONTEND
========================================================= */

router.post('/register', async (req, res) => {
  try {
    let {
      name,
      email,
      phone,
      country,
      password,
      password2
    } = req.body || {};

    name = String(name || '').trim();
    email = normalizeEmail(email);
    phone = String(phone || '').trim();
    country = String(country || '').trim();
    password = String(password || '');
    password2 =
      password2 == null
        ? password
        : String(password2);

    /* -----------------------------------------
       VALIDATION
    ----------------------------------------- */

    if (!name) {
      return res.status(400).json({
        message: 'Le nom est obligatoire.'
      });
    }

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        message: 'Adresse e-mail invalide.'
      });
    }

    if (!phone || phone.length < 5) {
      return res.status(400).json({
        message: 'Numéro de téléphone invalide.'
      });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({
        message:
          'Le mot de passe doit contenir au moins 8 caractères.'
      });
    }

    if (password !== password2) {
      return res.status(400).json({
        message:
          'Les mots de passe ne correspondent pas.'
      });
    }

    /* -----------------------------------------
       EMAIL UNIQUE
    ----------------------------------------- */

    const existingUser = await pool.query(
      `
      SELECT id
      FROM users
      WHERE LOWER(TRIM(email)) = $1
      LIMIT 1
      `,
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        code: 'EMAIL_ALREADY_EXISTS',
        message:
          'Cette adresse e-mail est déjà utilisée par un compte SellFlow. Utilise une autre adresse ou connecte-toi.'
      });
    }

    /* -----------------------------------------
       HASH
    ----------------------------------------- */

    const passwordHash =
      await hashPassword(password);

    /* -----------------------------------------
       INSERTION
    ----------------------------------------- */

    let result;

    try {
      result = await pool.query(
        `
        INSERT INTO users (
          id,
          name,
          email,
          phone,
          country,
          password_hash,
          email_verified,
          plan
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4,
          $5,
          TRUE,
          'free'
        )
        RETURNING
          id,
          name,
          email,
          phone,
          country,
          email_verified,
          plan,
          created_at
        `,
        [
          name,
          email,
          phone,
          country,
          passwordHash
        ]
      );
    } catch (dbError) {
      if (
        dbError &&
        dbError.code === '23505'
      ) {
        return res.status(409).json({
          code: 'EMAIL_ALREADY_EXISTS',
          message:
            'Cette adresse e-mail est déjà utilisée par un compte SellFlow. Utilise une autre adresse ou connecte-toi.'
        });
      }

      throw dbError;
    }

    const user = result.rows[0];

    const token = signToken(user);

    return res.status(201).json({
      created: true,
      verified: true,
      message:
        'Compte créé avec succès.',
      token,
      user: publicUser(user)
    });

  } catch (error) {
    console.error(
      '[AUTH REGISTER]',
      error
    );

    return res.status(500).json({
      message:
        'Impossible de créer le compte pour le moment.'
    });
  }
});

/* =========================================================
   CONNEXION
========================================================= */

router.post('/login', async (req, res) => {
  try {
    let {
      email,
      password
    } = req.body || {};

    email = normalizeEmail(email);
    password = String(password || '');

    if (!email || !password) {
      return res.status(400).json({
        message:
          'E-mail et mot de passe obligatoires.'
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        name,
        email,
        phone,
        country,
        password_hash,
        email_verified,
        plan,
        created_at
      FROM users
      WHERE LOWER(TRIM(email)) = $1
      LIMIT 1
      `,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message:
          'E-mail ou mot de passe incorrect.'
      });
    }

    const user = result.rows[0];

    const validPassword =
      await comparePassword(
        password,
        user.password_hash
      );

    if (!validPassword) {
      return res.status(401).json({
        message:
          'E-mail ou mot de passe incorrect.'
      });
    }

    const token = signToken(user);

    return res.json({
      token,
      user: publicUser(user)
    });

  } catch (error) {
    console.error(
      '[AUTH LOGIN]',
      error
    );

    return res.status(500).json({
      message:
        'Impossible de se connecter pour le moment.'
    });
  }
});

/* =========================================================
   PROFIL UTILISATEUR
========================================================= */

router.get(
  '/me',
  authMiddleware,
  async (req, res) => {
    try {
      const userId =
        req.user?.id ||
        req.user?.userId ||
        req.user?.sub;

      if (!userId) {
        return res.status(401).json({
          message:
            'Session invalide.'
        });
      }

      const result = await pool.query(
        `
        SELECT
          id,
          name,
          email,
          phone,
          country,
          email_verified,
          plan,
          created_at
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          message:
            'Utilisateur introuvable.'
        });
      }

      return res.json({
        user: publicUser(
          result.rows[0]
        )
      });

    } catch (error) {
      console.error(
        '[AUTH ME]',
        error
      );

      return res.status(500).json({
        message:
          'Impossible de récupérer le compte.'
      });
    }
  }
);

/* =========================================================
   GOOGLE / GMAIL
========================================================= */

router.get(
  '/gmail/connect',
  (req, res) => {
    try {
      const clientId =
        process.env.GOOGLE_CLIENT_ID;

      const clientSecret =
        process.env.GOOGLE_CLIENT_SECRET;

      const redirectUri =
        process.env.GOOGLE_REDIRECT_URI ||
        `${
          process.env.BACKEND_URL ||
          'https://sellflow-backend.onrender.com'
        }/auth/gmail/callback`;

      if (!clientId || !clientSecret) {
        return res.status(500).json({
          message:
            'Configuration Google OAuth manquante.'
        });
      }

      const oauth2Client =
        new google.auth.OAuth2(
          clientId,
          clientSecret,
          redirectUri
        );

      const scopes = [
        'openid',
        'email',
        'profile'
      ];

      const url =
        oauth2Client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: scopes
        });

      return res.redirect(url);

    } catch (error) {
      console.error(
        '[GMAIL CONNECT]',
        error
      );

      return res.status(500).json({
        message:
          'Impossible de connecter Google.'
      });
    }
  }
);

/* =========================================================
   GOOGLE / GMAIL CALLBACK
========================================================= */

router.get(
  '/gmail/callback',
  async (req, res) => {
    try {
      const {
        code
      } = req.query;

      if (!code) {
        return res.status(400).send(
          'Code Google manquant.'
        );
      }

      const clientId =
        process.env.GOOGLE_CLIENT_ID;

      const clientSecret =
        process.env.GOOGLE_CLIENT_SECRET;

      const redirectUri =
        process.env.GOOGLE_REDIRECT_URI ||
        `${
          process.env.BACKEND_URL ||
          'https://sellflow-backend.onrender.com'
        }/auth/gmail/callback`;

      if (!clientId || !clientSecret) {
        return res.status(500).send(
          'Configuration Google OAuth manquante.'
        );
      }

      const oauth2Client =
        new google.auth.OAuth2(
          clientId,
          clientSecret,
          redirectUri
        );

      const {
        tokens
      } =
        await oauth2Client.getToken(code);

      oauth2Client.setCredentials(tokens);

      const oauth2 =
        google.oauth2({
          auth: oauth2Client,
          version: 'v2'
        });

      const {
        data: profile
      } =
        await oauth2.userinfo.get();

      const email =
        normalizeEmail(
          profile.email
        );

      if (!email) {
        return res.status(400).send(
          'Google n’a pas retourné d’adresse e-mail.'
        );
      }

      /* -----------------------------------------
         RECHERCHE DU COMPTE EXISTANT
      ----------------------------------------- */

      const existingUser =
        await pool.query(
          `
          SELECT
            id,
            name,
            email,
            phone,
            country,
            email_verified,
            plan,
            created_at
          FROM users
          WHERE LOWER(TRIM(email)) = $1
          LIMIT 1
          `,
          [email]
        );

      let user;

      if (existingUser.rows.length > 0) {
        /*
          L'adresse existe déjà :
          on utilise le compte existant.
        */

        user = existingUser.rows[0];

      } else {
        /*
          Création d'un nouveau compte Google
          uniquement si l'adresse n'existe pas.
        */

        const randomPassword =
          crypto.randomBytes(32).toString('hex');

        const passwordHash =
          await hashPassword(
            randomPassword
          );

        try {
          const inserted =
            await pool.query(
              `
              INSERT INTO users (
                id,
                name,
                email,
                phone,
                country,
                password_hash,
                email_verified,
                plan
              )
              VALUES (
                gen_random_uuid(),
                $1,
                $2,
                $3,
                $4,
                $5,
                TRUE,
                'free'
              )
              RETURNING
                id,
                name,
                email,
                phone,
                country,
                email_verified,
                plan,
                created_at
              `,
              [
                profile.name ||
                  profile.given_name ||
                  'Utilisateur Google',

                email,

                '',

                '',

                passwordHash
              ]
            );

          user = inserted.rows[0];

        } catch (dbError) {
          /*
            Si une autre requête a créé le compte
            entre-temps, on récupère ce compte.
          */

          if (
            dbError &&
            dbError.code === '23505'
          ) {
            const retry =
              await pool.query(
                `
                SELECT
                  id,
                  name,
                  email,
                  phone,
                  country,
                  email_verified,
                  plan,
                  created_at
                FROM users
                WHERE LOWER(TRIM(email)) = $1
                LIMIT 1
                `,
                [email]
              );

            if (retry.rows.length > 0) {
              user = retry.rows[0];
            } else {
              throw dbError;
            }

          } else {
            throw dbError;
          }
        }
      }

      /* -----------------------------------------
         JWT
      ----------------------------------------- */

      const token =
        signToken(user);

      /* -----------------------------------------
         REDIRECTION FRONTEND
      ----------------------------------------- */

      const frontend =
        process.env.FRONTEND_URL ||
        'https://sellflowic.netlify.app';

      return res.redirect(
        `${frontend}/#google-auth-success?token=${encodeURIComponent(token)}`
      );

    } catch (error) {
      console.error(
        '[GMAIL CALLBACK]',
        error
      );

      return res.status(500).send(
        'Connexion Google impossible.'
      );
    }
  }
);

/* =========================================================
   EXPORT
========================================================= */

module.exports = router;
