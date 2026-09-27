const express = require('express');

const database = require('../config/database');
const { verifyToken } = require('../utils/auth');

const {
  getSubscription,
  activateSubscription,
  runSubscriptionReminders
} = require('../services/subscriptions');

const router = express.Router();


// =====================================================
// AUTH
// =====================================================

function requireAuth(req, res, next) {
  try {
    const authorization =
      req.headers.authorization || '';

    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        message: 'Token manquant.'
      });
    }

    const token =
      authorization.substring(7);

    req.user = verifyToken(token);

    next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message:
        'Session invalide ou expirée.'
    });
  }
}


// =====================================================
// GET /subscriptions/me
// =====================================================

router.get(
  '/me',
  requireAuth,
  async (req, res) => {
    try {
      const subscription =
        await getSubscription(
          req.user.sub
        );

      if (!subscription) {
        return res.status(404).json({
          ok: false,
          message:
            'Utilisateur introuvable.'
        });
      }

      return res.json({
        ok: true,
        subscription
      });
    } catch (error) {
      console.error(
        'Erreur GET /subscriptions/me:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de récupérer l’abonnement.',
        error: error.message
      });
    }
  }
);


// =====================================================
// POST /subscriptions/activate
// =====================================================

router.post(
  '/activate',
  requireAuth,
  async (req, res) => {
    try {
      const plan =
        String(
          req.body.plan || ''
        ).toLowerCase();

      const paymentReference =
        req.body.payment_reference
          ? String(
              req.body.payment_reference
            ).trim()
          : null;

      if (
        ![
          'starter',
          'pro',
          'business'
        ].includes(plan)
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Plan invalide.'
        });
      }

      /*
       * IMPORTANT :
       * Cette route est actuellement réservée
       * au développement.
       *
       * Elle ne doit PAS servir de preuve de paiement
       * en production.
       */

      if (
        process.env.NODE_ENV ===
        'production' &&
        process.env.ALLOW_DEV_SUBSCRIPTION !==
          'true'
      ) {
        return res.status(403).json({
          ok: false,
          code:
            'PAYMENT_REQUIRED',
          message:
            'Activation directe désactivée. Un paiement vérifié est requis.'
        });
      }

      const subscription =
        await activateSubscription(
          req.user.sub,
          plan,
          paymentReference
        );

      return res.json({
        ok: true,
        message:
          'Abonnement activé.',
        subscription
      });
    } catch (error) {
      console.error(
        'Erreur POST /subscriptions/activate:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible d’activer l’abonnement.',
        error: error.message
      });
    }
  }
);


// =====================================================
// POST /subscriptions/run-reminders
// =====================================================

router.post(
  '/run-reminders',
  async (req, res) => {
    try {
      const secret =
        process.env.CRON_SECRET;

      if (!secret) {
        return res.status(503).json({
          ok: false,
          message:
            'CRON_SECRET non configuré.'
        });
      }

      const provided =
        req.headers['x-cron-secret'];

      if (
        !provided ||
        provided !== secret
      ) {
        return res.status(401).json({
          ok: false,
          message:
            'Accès non autorisé.'
        });
      }

      const result =
        await runSubscriptionReminders();

      return res.json({
        ok: true,
        result
      });
    } catch (error) {
      console.error(
        'Erreur POST /subscriptions/run-reminders:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible d’exécuter les rappels.',
        error: error.message
      });
    }
  }
);


module.exports = router;
