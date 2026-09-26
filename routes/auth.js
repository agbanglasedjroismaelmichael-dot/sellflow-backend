const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');

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

/* =========================
   GOOGLE OAUTH GMAIL
========================= */

function createGoogleOAuthClient() {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET ||
    !process.env.GOOGLE_REDIRECT_URI
  ) {
    throw new Error(
      'Les variables GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET et GOOGLE_REDIRECT_URI doivent être configurées.'
    );
  }

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/* =========================
   CONNEXION GMAIL
========================= */

router.get('/gmail/connect', (req, res) => {
  try {
    const oauth2Client = createGoogleOAuthClient();

    const state = crypto
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

    /*
      Pour cette première configuration,
      le state est conservé temporairement dans
      une variable serveur.
    */
    global.gmailOAuthState = state;

    res.redirect(authorizationUrl);

  } catch (error) {
    console.error('Erreur Gmail connect:', error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================
   CALLBACK GMAIL
========================= */

router.get('/gmail/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(`
        <h2>Connexion Gmail annulée</h2>
        <p>${String(error)}</p>
      `);
    }

    if (!code) {
      return res.status(400).send(`
        <h2>Erreur Gmail</h2>
        <p>Le code d'autorisation est manquant.</p>
      `);
    }

    if (
      !state ||
      state !== global.gmailOAuthState
    ) {
      return res.status(400).send(`
        <h2>Erreur de sécurité</h2>
        <p>Le paramètre state est invalide.</p>
      `);
    }

    const oauth2Client = createGoogleOAuthClient();

    const { tokens } =
      await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      return res.status(400).send(`
        <h2>Refresh token non reçu</h2>

        <p>
          Google n'a pas retourné de refresh token.
        </p>

        <p>
          Recommence la connexion avec
          l'autorisation Gmail.
        </p>
      `);
    }

    /*
      Le refresh token est affiché une seule fois
      afin de pouvoir l'ajouter dans Render.
    */

    res.send(`
      <!DOCTYPE html>

      <html lang="fr">

      <head>
        <meta charset="UTF-8">

        <title>SellFlow AI - Gmail connecté</title>

        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 50px auto;
            padding: 20px;
          }

          .success {
            padding: 20px;
            background: #e8f5e9;
            border-radius: 10px;
          }

          code {
            display: block;
            padding: 15px;
            margin-top: 15px;
            background: #f4f4f4;
            border-radius: 8px;
            word-break: break-all;
          }

          .warning {
            margin-top: 20px;
            padding: 15px;
            background: #fff3cd;
            border-radius: 8px;
          }
        </style>
      </head>

      <body>

        <div class="success">
          <h1>✅ Gmail connecté</h1>

          <p>
            L'autorisation Google a été effectuée
            avec succès.
          </p>
        </div>

        <h2>Refresh Token</h2>

        <p>
          Ajoute cette valeur dans Render comme
          variable d'environnement :
        </p>

        <strong>
          GOOGLE_REFRESH_TOKEN
        </strong>

        <code>${refreshToken}</code>

        <div class="warning">
          ⚠️ Ne partage jamais ce refresh token.
          Il donne au serveur l'autorisation
          accordée à SellFlow.
        </div>

      </body>

      </html>
    `);

    /*
      On invalide le state après utilisation.
    */
    global.gmailOAuthState = null;

  } catch (error) {
    console.error('Erreur Gmail callback:', error);

    res.status(500).json({
      ok: false,
      error: 'Impossible de finaliser la connexion Gmail.',
      details: error.message
    });
  }
});
