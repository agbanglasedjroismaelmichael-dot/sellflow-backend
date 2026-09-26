const express = require('express');
const crypto = require('crypto');

const { getPool } = require('../config/database');
const {
  newId,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  generateVerificationCode
} = require('../utils/auth');

const nodemailer = require('nodemailer');

const router = express.Router();

function createMailer() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

async function sendVerificationEmail(email, code) {
  const transporter = createMailer();

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: email,
    subject: 'Votre code de vérification — SellFlow AI',
    text: `Votre code de vérification SellFlow AI est : ${code}. Il expire dans 10 minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:30px">
        <h2>SellFlow AI</h2>
        <p>Voici votre code de vérification :</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px">
          ${code}
        </div>
        <p>Ce code expire dans <strong>10 minutes</strong>.</p>
        <p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
      </div>
    `
  });
}

/* =========================
   DEMANDE D'INSCRIPTION
========================= */

router.post('/register/request-code', async (req, res) => {
  try {
    const { name, email, country, phone } = req.body;

    if (!name || !email || !country || !phone) {
      return res.status(400).json({
        error: 'Tous les champs sont obligatoires.'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const db = getPool();

    const existingUser = await db.query(
      'SELECT id, email_verified FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (
      existingUser.rows.length &&
      existingUser.rows[0].email_verified
    ) {
      return res.status(409).json({
        error: 'Un compte existe déjà avec cette adresse email.'
      });
    }

    const code = generateVerificationCode();

    const codeHash = crypto
      .createHash('sha256')
      .update(code)
      .digest('hex');

    await db.query(
      'DELETE FROM registration_requests WHERE email = $1',
      [normalizedEmail]
    );

    const requestId = newId();

    await db.query(
      `
      INSERT INTO registration_requests
      (id, name, email, phone, country, code_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '10 minutes')
      `,
      [
        requestId,
        name.trim(),
        normalizedEmail,
        phone.trim(),
        country.trim(),
        codeHash
      ]
    );

    await sendVerificationEmail(normalizedEmail, code);

    res.json({
      ok: true,
      message: 'Code de vérification envoyé.',
      requestId
    });

  } catch (error) {
    console.error('Erreur request-code:', error);

    res.status(500).json({
      error: 'Impossible d’envoyer le code de vérification.'
    });
  }
});

/* =========================
   VÉRIFICATION DU CODE
========================= */

router.post('/register/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        error: 'Email et code obligatoires.'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const db = getPool();

    const result = await db.query(
      `
      SELECT *
      FROM registration_requests
      WHERE email = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [normalizedEmail]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: 'Aucune demande de vérification trouvée.'
      });
    }

    const request = result.rows[0];

    if (request.verified) {
      return res.status(400).json({
        error: 'Ce code a déjà été utilisé.'
      });
    }

    if (new Date(request.expires_at) < new Date()) {
      return res.status(400).json({
        error: 'Le code a expiré. Demandez un nouveau code.'
      });
    }

    if (request.attempts >= 5) {
      return res.status(429).json({
        error: 'Trop de tentatives. Demandez un nouveau code.'
      });
    }

    const codeHash = crypto
      .createHash('sha256')
      .update(String(code).trim())
      .digest('hex');

    if (codeHash !== request.code_hash) {
      await db.query(
        `
        UPDATE registration_requests
        SET attempts = attempts + 1
        WHERE id = $1
        `,
        [request.id]
      );

      return res.status(400).json({
        error: 'Code de vérification incorrect.'
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

    const registrationToken = signToken(
      {
        purpose: 'registration',
        requestId: request.id,
        email: request.email
      },
      '15m'
    );

    res.json({
      ok: true,
      message: 'Email vérifié.',
      registrationToken
    });

  } catch (error) {
    console.error('Erreur verify-code:', error);

    res.status(500).json({
      error: 'Erreur lors de la vérification.'
    });
  }
});

/* =========================
   CRÉATION DU COMPTE
========================= */

router.post('/register/complete', async (req, res) => {
  try {
    const {
      registrationToken,
      password,
      passwordConfirmation
    } = req.body;

    if (
      !registrationToken ||
      !password ||
      !passwordConfirmation
    ) {
      return res.status(400).json({
        error: 'Tous les champs sont obligatoires.'
      });
    }

    if (password !== passwordConfirmation) {
      return res.status(400).json({
        error: 'Les mots de passe ne correspondent pas.'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'Le mot de passe doit contenir au moins 8 caractères.'
      });
    }

    const payload = verifyToken(registrationToken);

    if (payload.purpose !== 'registration') {
      return res.status(401).json({
        error: 'Token d’inscription invalide.'
      });
    }

    const db = getPool();

    const requestResult = await db.query(
      `
      SELECT *
      FROM registration_requests
      WHERE id = $1
      LIMIT 1
      `,
      [payload.requestId]
    );

    if (!requestResult.rows.length) {
      return res.status(404).json({
        error: 'Demande d’inscription introuvable.'
      });
    }

    const request = requestResult.rows[0];

    if (!request.verified) {
      return res.status(403).json({
        error: 'Votre email doit être vérifié avant de créer le compte.'
      });
    }

    const existing = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [request.email]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error: 'Un compte existe déjà avec cette adresse email.'
      });
    }

    const passwordHash = await hashPassword(password);
    const userId = newId();

    await db.query(
      `
      INSERT INTO users
      (id, name, email, phone, country, password_hash, email_verified)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      `,
      [
        userId,
        request.name,
        request.email,
        request.phone,
        request.country,
        passwordHash
      ]
    );

    await db.query(
      'DELETE FROM registration_requests WHERE id = $1',
      [request.id]
    );

    res.status(201).json({
      ok: true,
      message: 'Compte créé avec succès !',
      user: {
        id: userId,
        name: request.name,
        email: request.email,
        phone: request.phone,
        country: request.country
      }
    });

  } catch (error) {
    console.error('Erreur register/complete:', error);

    if (
      error.name === 'TokenExpiredError' ||
      error.name === 'JsonWebTokenError'
    ) {
      return res.status(401).json({
        error: 'La session d’inscription a expiré. Recommencez la vérification.'
      });
    }

    res.status(500).json({
      error: 'Impossible de créer le compte.'
    });
  }
});

/* =========================
   CONNEXION
========================= */

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email et mot de passe obligatoires.'
      });
    }

    const db = getPool();

    const result = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: 'Email ou mot de passe incorrect.'
      });
    }

    const user = result.rows[0];

    const validPassword = await verifyPassword(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        error: 'Email ou mot de passe incorrect.'
      });
    }

    const token = signToken({
      sub: user.id,
      email: user.email
    });

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        country: user.country,
        emailVerified: user.email_verified,
        plan: user.plan
      }
    });

  } catch (error) {
    console.error('Erreur login:', error);

    res.status(500).json({
      error: 'Impossible de se connecter.'
    });
  }
});

/* =========================
   UTILISATEUR CONNECTÉ
========================= */

router.get('/me', async (req, res) => {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentification requise.'
      });
    }

    const token = header.substring(7);
    const payload = verifyToken(token);

    const db = getPool();

    const result = await db.query(
      `
      SELECT id, name, email, phone, country,
             email_verified, plan, created_at
      FROM users
      WHERE id = $1
      `,
      [payload.sub]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: 'Utilisateur introuvable.'
      });
    }

    res.json({
      ok: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Erreur /me:', error);

    res.status(401).json({
      error: 'Session invalide ou expirée.'
    });
  }
});

module.exports = router;
