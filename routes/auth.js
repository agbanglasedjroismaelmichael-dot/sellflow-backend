const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const { Resend } = require('resend');

const { getPool } = require('../config/database');

const {
  newId,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  generateVerificationCode
} = require('../utils/auth');

const router = express.Router();

/* =========================================================
   OUTILS
========================================================= */

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    country: user.country,
    email_verified: user.email_verified,
    plan: user.plan,
    created_at: user.created_at
  };
}

function isDevAuthBypassEnabled() {
  return process.env.DEV_AUTH_BYPASS === 'true';
}

function getResend() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY n’est pas configuré.');
  }

  return new Resend(process.env.RESEND_API_KEY);
}

function getEmailFrom() {
  if (!process.env.EMAIL_FROM) {
    throw new Error('EMAIL_FROM n’est pas configuré.');
  }

  return process.env.EMAIL_FROM;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendVerificationEmail({
  email,
  name,
  code
}) {
  const resend = getResend();
  const from = getEmailFrom();

  const safeName = escapeHtml(name);

  const result = await resend.emails.send({
    from,
    to: [email],
    subject: 'Votre code de vérification SellFlow AI',
    html: `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <title>Code SellFlow AI</title>
      </head>

      <body style="
        margin:0;
        padding:30px;
        background:#f5f7fb;
        font-family:Arial,sans-serif;
        color:#111827;
      ">

        <div style="
          max-width:600px;
          margin:auto;
          background:white;
          border-radius:18px;
          padding:35px;
          box-shadow:0 10px 35px rgba(0,0,0,.08);
        ">

          <h1 style="margin-top:0;">
            SellFlow AI
          </h1>

          <p>
            Bonjour ${safeName},
          </p>

          <p>
            Voici votre code de vérification :
          </p>

          <div style="
            margin:25px 0;
            padding:20px;
            background:#f3f4f6;
            border-radius:14px;
            text-align:center;
            font-size:34px;
            font-weight:bold;
            letter-spacing:8px;
          ">
            ${escapeHtml(code)}
          </div>

          <p>
            Ce code est valable pendant
            <strong>10 minutes</strong>.
          </p>

          <p style="color:#6b7280;font-size:13px;">
            Si vous n'êtes pas à l'origine de cette demande,
            vous pouvez simplement ignorer cet e-mail.
          </p>

        </div>

      </body>
      </html>
    `
  });

  if (result?.error) {
    throw new Error(
      result.error.message ||
      'Impossible d’envoyer l’e-mail.'
    );
  }

  return result;
              }
/* =========================================================
   INSCRIPTION — DEMANDE DE CODE
========================================================= */

router.post(
  '/register/request-email-code',
  async (req, res) => {
    try {
      const db = getPool();

      const {
        name,
        email,
        phone,
        phone_international,
        country,
        dial_code
      } = req.body || {};

      const normalizedEmail =
        normalizeEmail(email);

      const finalPhone =
        String(
          phone_international ||
          `${dial_code || ''}${phone || ''}`
        ).trim();

      const cleanName =
        String(name || '').trim();

      if (
        !cleanName ||
        !normalizedEmail ||
        !finalPhone
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Nom, e-mail et téléphone sont obligatoires.'
        });
      }

      if (
        !/^\S+@\S+\.\S+$/.test(normalizedEmail)
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Adresse e-mail invalide.'
        });
      }

      const existingUser =
        await db.query(
          `
          SELECT id
          FROM users
          WHERE email = $1
          LIMIT 1
          `,
          [normalizedEmail]
        );

      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          ok: false,
          message:
            'Un compte existe déjà avec cette adresse e-mail.'
        });
      }

      const recent =
        await db.query(
          `
          SELECT id
          FROM registration_requests
          WHERE email = $1
            AND created_at >
              NOW() - INTERVAL '60 seconds'
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [normalizedEmail]
        );

      if (recent.rows.length > 0) {
        return res.status(429).json({
          ok: false,
          message:
            'Attends environ 1 minute avant de demander un nouveau code.'
        });
      }

      const code =
        isDevAuthBypassEnabled()
          ? '000000'
          : generateVerificationCode();

      const codeHash =
        await hashPassword(code);

      const verificationId =
        newId();

      await db.query(
        `
        INSERT INTO registration_requests
        (
          id,
          name,
          email,
          phone,
          country,
          code_hash,
          expires_at,
          attempts,
          verified
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          NOW() + INTERVAL '10 minutes',
          0,
          FALSE
        )
        `,
        [
          verificationId,
          cleanName,
          normalizedEmail,
          finalPhone,
          country || '',
          codeHash
        ]
      );

      if (isDevAuthBypassEnabled()) {
        console.log(
          `⚠️ DEV_AUTH_BYPASS actif — code de test pour ${normalizedEmail}: 000000`
        );

        return res.json({
          ok: true,
          message:
            'Mode test : utilise le code 000000.',
          verification_token:
            verificationId,
          dev_mode: true,
          test_code: '000000'
        });
      }

      await sendVerificationEmail({
        email: normalizedEmail,
        name: cleanName,
        code
      });

      return res.json({
        ok: true,
        message:
          'Code de vérification envoyé.',
        verification_token:
          verificationId
      });

    } catch (error) {
      console.error(
        'Erreur request-email-code:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          error.message ||
          'Impossible d’envoyer le code de vérification.'
      });
    }
  }
);

/* =========================================================
   INSCRIPTION — VÉRIFICATION DU CODE
========================================================= */

router.post(
  '/register/verify-email-code',
  async (req, res) => {
    try {
      const db = getPool();

      const {
        email,
        code,
        verification_token
      } = req.body || {};

      const normalizedEmail =
        normalizeEmail(email);

      const cleanCode =
        String(code || '').trim();

      if (
        !normalizedEmail ||
        !cleanCode
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'E-mail et code sont obligatoires.'
        });
      }

      let requestResult;

      if (verification_token) {
        requestResult =
          await db.query(
            `
            SELECT *
            FROM registration_requests
            WHERE id = $1
              AND email = $2
            LIMIT 1
            `,
            [
              verification_token,
              normalizedEmail
            ]
          );
      } else {
        requestResult =
          await db.query(
            `
            SELECT *
            FROM registration_requests
            WHERE email = $1
              AND verified = FALSE
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [normalizedEmail]
          );
      }

      if (requestResult.rows.length === 0) {
        return res.status(400).json({
          ok: false,
          message:
            'Demande de vérification introuvable ou expirée.'
        });
      }

      const request =
        requestResult.rows[0];

      if (request.verified) {
        return res.json({
          ok: true,
          verified: true,
          verification_token:
            request.id,
          verificationId:
            request.id
        });
      }

      if (
        new Date(request.expires_at) <
        new Date()
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Le code de vérification a expiré. Demande un nouveau code.'
        });
      }

      if (
        Number(request.attempts || 0) >= 5
      ) {
        return res.status(429).json({
          ok: false,
          message:
            'Trop de tentatives. Demande un nouveau code.'
        });
      }

      let validCode = false;

      if (
        isDevAuthBypassEnabled() &&
        cleanCode === '000000'
      ) {
        validCode = true;
      } else {
        validCode =
          await verifyPassword(
            cleanCode,
            request.code_hash
          );
      }

      if (!validCode) {
        await db.query(
          `
          UPDATE registration_requests
          SET attempts = attempts + 1
          WHERE id = $1
          `,
          [request.id]
        );

        return res.status(400).json({
          ok: false,
          verified: false,
          message:
            'Code incorrect.'
        });
      }

      await db.query(
        `
        UPDATE registration_requests
        SET verified = TRUE
        WHERE id = $1
        `,
        [request.id]
      );

      return res.json({
        ok: true,
        verified: true,
        verification_token:
          request.id,
        verificationId:
          request.id,
        message:
          isDevAuthBypassEnabled()
            ? 'Adresse e-mail vérifiée en mode test.'
            : 'Adresse e-mail vérifiée.'
      });

    } catch (error) {
      console.error(
        'Erreur verify-email-code:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de vérifier le code.'
      });
    }
  }
);
/* =========================================================
   INSCRIPTION — CRÉATION DU COMPTE
========================================================= */

router.post(
  '/register/complete',
  async (req, res) => {
    try {
      const db = getPool();

      const {
        name,
        email,
        password,
        password_confirmation,
        country,
        phone,
        phone_international,
        verification_token
      } = req.body || {};

      const normalizedEmail =
        normalizeEmail(email);

      const cleanName =
        String(name || '').trim();

      const finalPhone =
        String(
          phone_international ||
          phone ||
          ''
        ).trim();

      if (
        !cleanName ||
        !normalizedEmail ||
        !password
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Nom, e-mail et mot de passe sont obligatoires.'
        });
      }

      if (
        !/^\S+@\S+\.\S+$/.test(normalizedEmail)
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Adresse e-mail invalide.'
        });
      }

      if (
        String(password).length < 8
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Le mot de passe doit contenir au moins 8 caractères.'
        });
      }

      if (
        password_confirmation &&
        password !== password_confirmation
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Les mots de passe ne correspondent pas.'
        });
      }

      if (!verification_token) {
        return res.status(400).json({
          ok: false,
          message:
            'Vérifie d’abord ton adresse e-mail.'
        });
      }

      const verification =
        await db.query(
          `
          SELECT *
          FROM registration_requests
          WHERE id = $1
            AND email = $2
            AND verified = TRUE
          LIMIT 1
          `,
          [
            verification_token,
            normalizedEmail
          ]
        );

      if (verification.rows.length === 0) {
        return res.status(400).json({
          ok: false,
          message:
            'Adresse e-mail non vérifiée ou vérification invalide.'
        });
      }

      const request =
        verification.rows[0];

      if (
        new Date(request.expires_at) <
        new Date()
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'La vérification a expiré. Recommence la vérification de ton e-mail.'
        });
      }

      const existingUser =
        await db.query(
          `
          SELECT id
          FROM users
          WHERE email = $1
          LIMIT 1
          `,
          [normalizedEmail]
        );

      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          ok: false,
          message:
            'Un compte existe déjà avec cette adresse e-mail.'
        });
      }

      const passwordHash =
        await hashPassword(password);

      const userId =
        newId();

      const userResult =
        await db.query(
          `
          INSERT INTO users
          (
            id,
            name,
            email,
            phone,
            country,
            password_hash,
            email_verified,
            plan
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
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
            userId,
            cleanName,
            normalizedEmail,
            finalPhone,
            country ||
              request.country ||
              '',
            passwordHash
          ]
        );

      await db.query(
        `
        UPDATE registration_requests
        SET verified = TRUE
        WHERE id = $1
        `,
        [request.id]
      );

      const user =
        userResult.rows[0];

      const token =
        signToken(user);

      return res.status(201).json({
        ok: true,
        created: true,
        verified: true,
        token,
        user: publicUser(user)
      });

    } catch (error) {
      console.error(
        'Erreur register/complete:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de créer le compte.',
        details:
          process.env.NODE_ENV === 'development'
            ? error.message
            : undefined
      });
    }
  }
);

/* =========================================================
   INSCRIPTION SIMPLE — COMPATIBILITÉ ANCIEN FRONTEND
========================================================= */

router.post(
  '/register',
  async (req, res) => {
    try {
      const db = getPool();

      const {
        name,
        email,
        password
      } = req.body || {};

      const normalizedEmail =
        normalizeEmail(email);

      const cleanName =
        String(name || '').trim();

      if (
        !cleanName ||
        !normalizedEmail ||
        !password
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Nom, e-mail et mot de passe sont obligatoires.'
        });
      }

      if (
        !/^\S+@\S+\.\S+$/.test(normalizedEmail)
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Adresse e-mail invalide.'
        });
      }

      if (
        String(password).length < 8
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Le mot de passe doit contenir au moins 8 caractères.'
        });
      }

      const existing =
        await db.query(
          `
          SELECT id
          FROM users
          WHERE email = $1
          LIMIT 1
          `,
          [normalizedEmail]
        );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          ok: false,
          message:
            'Un compte existe déjà avec cette adresse e-mail.'
        });
      }

      const passwordHash =
        await hashPassword(password);

      const userId =
        newId();

      const result =
        await db.query(
          `
          INSERT INTO users
          (
            id,
            name,
            email,
            password_hash,
            email_verified,
            plan
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
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
            userId,
            cleanName,
            normalizedEmail,
            passwordHash
          ]
        );

      const user =
        result.rows[0];

      const token =
        signToken(user);

      return res.status(201).json({
        ok: true,
        created: true,
        token,
        user: publicUser(user)
      });

    } catch (error) {
      console.error(
        'Erreur register:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de créer le compte.'
      });
    }
  }
);

/* =========================================================
   CONNEXION
========================================================= */

router.post(
  '/login',
  async (req, res) => {
    try {
      const db = getPool();

      const {
        email,
        password
      } = req.body || {};

      const normalizedEmail =
        normalizeEmail(email);

      if (
        !normalizedEmail ||
        !password
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'E-mail et mot de passe obligatoires.'
        });
      }

      const result =
        await db.query(
          `
          SELECT *
          FROM users
          WHERE email = $1
          LIMIT 1
          `,
          [normalizedEmail]
        );

      if (result.rows.length === 0) {
        return res.status(401).json({
          ok: false,
          message:
            'E-mail ou mot de passe incorrect.'
        });
      }

      const user =
        result.rows[0];

      if (!user.password_hash) {
        return res.status(401).json({
          ok: false,
          message:
            'Ce compte ne possède pas encore de mot de passe.'
        });
      }

      const valid =
        await verifyPassword(
          password,
          user.password_hash
        );

      if (!valid) {
        return res.status(401).json({
          ok: false,
          message:
            'E-mail ou mot de passe incorrect.'
        });
      }

      const token =
        signToken(user);

      return res.json({
        ok: true,
        token,
        user: publicUser(user)
      });

    } catch (error) {
      console.error(
        'Erreur login:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de se connecter.'
      });
    }
  }
);

/* =========================================================
   PROFIL CONNECTÉ
========================================================= */

router.get(
  '/me',
  async (req, res) => {
    try {
      const db = getPool();

      const auth =
        req.headers.authorization || '';

      if (
        !auth.startsWith('Bearer ')
      ) {
        return res.status(401).json({
          ok: false,
          message:
            'Token manquant.'
        });
      }

      const token =
        auth.substring(7).trim();

      if (!token) {
        return res.status(401).json({
          ok: false,
          message:
            'Token manquant.'
        });
      }

      const decoded =
        verifyToken(token);

      if (
        !decoded ||
        !decoded.sub
      ) {
        return res.status(401).json({
          ok: false,
          message:
            'Session invalide ou expirée.'
        });
      }

      const userId =
        decoded.sub;

      const result =
        await db.query(
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
          ok: false,
          message:
            'Utilisateur introuvable.'
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
        'Erreur auth/me:',
        error
      );

      return res.status(401).json({
        ok: false,
        message:
          'Session invalide ou expirée.'
      });
    }
  }
);
/* =========================================================
   GOOGLE OAUTH GMAIL
   Conservé pour plus tard
========================================================= */

function createGoogleOAuthClient() {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET ||
    !process.env.GOOGLE_REDIRECT_URI
  ) {
    throw new Error(
      'Les variables Google OAuth ne sont pas configurées.'
    );
  }

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

router.get(
  '/gmail/connect',
  (req, res) => {
    try {
      const oauth2Client =
        createGoogleOAuthClient();

      const state =
        crypto
          .randomBytes(32)
          .toString('hex');

      const authorizationUrl =
        oauth2Client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: [
            'https://www.googleapis.com/auth/gmail.send'
          ],
          state
        });

      global.gmailOAuthState =
        state;

      return res.redirect(
        authorizationUrl
      );

    } catch (error) {
      console.error(
        'Erreur Gmail connect:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          process.env.NODE_ENV === 'development'
            ? error.message
            : 'Configuration Google OAuth indisponible.'
      });
    }
  }
);

router.get(
  '/gmail/callback',
  async (req, res) => {
    try {
      const {
        code,
        state,
        error
      } = req.query;

      if (error) {
        return res.status(400).send(
          '<h2>Connexion Gmail annulée</h2>'
        );
      }

      if (!code) {
        return res.status(400).send(
          '<h2>Code Gmail manquant.</h2>'
        );
      }

      if (
        !state ||
        state !== global.gmailOAuthState
      ) {
        return res.status(400).send(
          '<h2>État Gmail invalide.</h2>'
        );
      }

      const oauth2Client =
        createGoogleOAuthClient();

      const { tokens } =
        await oauth2Client.getToken(code);

      oauth2Client.setCredentials(
        tokens
      );

      global.gmailOAuthState = null;

      return res.send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport"
                content="width=device-width,initial-scale=1">
          <title>SellFlow AI</title>
        </head>

        <body style="
          font-family:Arial,sans-serif;
          background:#f5f7fb;
          max-width:700px;
          margin:60px auto;
          padding:20px;
        ">

          <div style="
            background:#fff;
            border-radius:18px;
            padding:35px;
            box-shadow:0 10px 35px rgba(0,0,0,.08);
          ">

            <h1>✅ Gmail connecté</h1>

            <p>
              L'autorisation Gmail a été effectuée
              avec succès.
            </p>

            <p style="color:#6b7280;">
              La connexion a été traitée côté serveur.
              Les informations d'autorisation ne sont
              pas affichées dans le navigateur.
            </p>

          </div>

        </body>
        </html>
      `);

    } catch (error) {
      console.error(
        'Erreur Gmail callback:',
        error
      );

      global.gmailOAuthState = null;

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de finaliser la connexion Gmail.'
      });
    }
  }
);

module.exports = router;
