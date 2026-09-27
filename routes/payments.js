const express = require('express');
const database = require('../config/database');

const {
  verifyToken
} = require('../utils/auth');

const {
  initializePayment,
  getPayment,
  extractPaymentInitialization
} = require('../services/moneroo');

const router = express.Router();

/**
 * ============================================================
 * SELLFLOW AI — OFFRES
 * ============================================================
 */

const OFFERS = {
  starter_monthly: {
    plan: 'starter',
    billing_cycle: 'monthly',
    amount: 3500,
    currency: 'XOF',
    name: 'SellFlow Starter — Mensuel'
  },

  pro_monthly: {
    plan: 'pro',
    billing_cycle: 'monthly',
    amount: 9900,
    currency: 'XOF',
    name: 'SellFlow Pro — Mensuel'
  },

  business_monthly: {
    plan: 'business',
    billing_cycle: 'monthly',
    amount: 29900,
    currency: 'XOF',
    name: 'SellFlow Business — Mensuel'
  },

  starter_annual: {
    plan: 'starter',
    billing_cycle: 'annual',
    amount: 35000,
    currency: 'XOF',
    name: 'SellFlow Starter — Annuel'
  },

  pro_annual: {
    plan: 'pro',
    billing_cycle: 'annual',
    amount: 99000,
    currency: 'XOF',
    name: 'SellFlow Pro — Annuel'
  },

  business_annual: {
    plan: 'business',
    billing_cycle: 'annual',
    amount: 299000,
    currency: 'XOF',
    name: 'SellFlow Business — Annuel'
  }
};

/**
 * ============================================================
 * AUTHENTIFICATION
 * ============================================================
 */

function authenticate(req, res, next) {
  try {
    const authorization =
      req.headers.authorization || '';

    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        error: 'AUTH_REQUIRED',
        message: 'Authentification requise.'
      });
    }

    const token =
      authorization.substring(7).trim();

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'TOKEN_MISSING',
        message: 'Token manquant.'
      });
    }

    const decoded =
      verifyToken(token);

    if (!decoded || !decoded.sub) {
      return res.status(401).json({
        ok: false,
        error: 'INVALID_TOKEN',
        message: 'Token invalide.'
      });
    }

    req.user = {
      id: decoded.sub,
      email: decoded.email || null
    };

    next();

  } catch (error) {
    console.error(
      '❌ Erreur authentification paiement:',
      error
    );

    return res.status(401).json({
      ok: false,
      error: 'INVALID_TOKEN',
      message: 'Session invalide ou expirée.'
    });
  }
}

/**
 * ============================================================
 * GET /payments/offers
 * ============================================================
 */

router.get('/offers', (req, res) => {
  return res.json({
    ok: true,
    offers: OFFERS
  });
});

/**
 * ============================================================
 * POST /payments/create
 * ============================================================
 */

router.post(
  '/create',
  authenticate,
  async (req, res) => {
    try {
      const {
        offer_id,
        first_name,
        last_name,
        phone,
        method
      } = req.body || {};

      /**
       * --------------------------------------------------------
       * 1. Vérifier l'offre
       * --------------------------------------------------------
       */

      const offer =
        OFFERS[offer_id];

      if (!offer) {
        return res.status(400).json({
          ok: false,
          error: 'INVALID_OFFER',
          message: 'Offre SellFlow invalide.'
        });
      }

      /**
       * --------------------------------------------------------
       * 2. Récupérer l'utilisateur
       * --------------------------------------------------------
       */

      const db =
        database.getPool();

      const userResult =
        await db.query(
          `
          SELECT
            id,
            name,
            email,
            phone
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [req.user.id]
        );

      if (!userResult.rows.length) {
        return res.status(404).json({
          ok: false,
          error: 'USER_NOT_FOUND',
          message: 'Compte SellFlow introuvable.'
        });
      }

      const user =
        userResult.rows[0];

      /**
       * --------------------------------------------------------
       * 3. Informations client
       * --------------------------------------------------------
       */

      const providedName =
        `${first_name || ''} ${last_name || ''}`.trim();

      const customerName =
        providedName ||
        String(user.name || 'Client SellFlow').trim();

      /**
       * Moneroo exige un first_name ET un last_name.
       *
       * Si le client n'a pas fourni de nom séparé,
       * on utilise SellFlow comme valeur de secours.
       */

      const customerFirstName =
        customerName || 'Client';

      const customerLastName =
        String(last_name || 'SellFlow').trim() ||
        'SellFlow';

      /**
       * --------------------------------------------------------
       * 4. URL de retour
       * --------------------------------------------------------
       */

      const frontendUrl =
        (
          process.env.FRONTEND_URL ||
          'https://sellflowme.netlify.app'
        ).replace(/\/+$/, '');

      const returnUrl =
        `${frontendUrl}/?payment_return=moneroo`;

      /**
       * --------------------------------------------------------
       * 5. Metadata
       * --------------------------------------------------------
       */

      const metadata = {
        user_id: String(user.id),
        offer_id: String(offer_id),
        plan: String(offer.plan),
        billing_cycle: String(offer.billing_cycle),
        product: 'SellFlow AI'
      };

      /**
       * --------------------------------------------------------
       * 6. Préparer le paiement Moneroo
       * --------------------------------------------------------
       */

      const paymentPayload = {
        amount: offer.amount,
        currency: offer.currency,
        description: offer.name,

        customer: {
          email: String(user.email),
          first_name: customerFirstName,
          last_name: customerLastName
        },

        return_url: returnUrl,

        metadata
      };

      /**
       * --------------------------------------------------------
       * 7. Ajouter téléphone si disponible
       * --------------------------------------------------------
       */

      const customerPhone =
        phone ||
        user.phone ||
        null;

      if (
        customerPhone !== null &&
        String(customerPhone).trim() !== ''
      ) {
        paymentPayload.customer.phone =
          String(customerPhone).trim();
      }

      /**
       * --------------------------------------------------------
       * 8. Ajouter méthode de paiement si fournie
       * --------------------------------------------------------
       */

      if (
        method !== undefined &&
        method !== null &&
        String(method).trim() !== ''
      ) {
        paymentPayload.methods = [
          String(method).trim()
        ];
      }

      /**
       * --------------------------------------------------------
       * 9. Initialiser chez Moneroo
       * --------------------------------------------------------
       */

      const monerooResponse =
        await initializePayment(
          paymentPayload
        );

      const {
        paymentId,
        checkoutUrl
      } =
        extractPaymentInitialization(
          monerooResponse
        );

      if (!paymentId) {
        throw new Error(
          'Moneroo n’a pas retourné d’identifiant de paiement.'
        );
      }

      if (!checkoutUrl) {
        throw new Error(
          'Moneroo n’a pas retourné d’URL de paiement.'
        );
      }

      /**
       * --------------------------------------------------------
       * 10. Enregistrer le paiement en base
       * --------------------------------------------------------
       */

      await db.query(
        `
        INSERT INTO payments (
          user_id,
          provider,
          provider_reference,
          plan,
          billing_cycle,
          amount,
          currency,
          status,
          checkout_url,
          metadata
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb
        )
        `,
        [
          user.id,
          'moneroo',
          paymentId,
          offer.plan,
          offer.billing_cycle,
          offer.amount,
          offer.currency,
          'pending',
          checkoutUrl,
          JSON.stringify({
            ...metadata,
            customer_email: user.email
          })
        ]
      );

      /**
       * --------------------------------------------------------
       * 11. Réponse frontend
       * --------------------------------------------------------
       */

      return res.status(201).json({
        ok: true,

        payment: {
          id: paymentId,

          provider: 'moneroo',

          status: 'pending',

          offer_id,

          plan: offer.plan,

          billing_cycle:
            offer.billing_cycle,

          amount:
            offer.amount,

          currency:
            offer.currency,

          checkout_url:
            checkoutUrl
        }
      });

    } catch (error) {
      console.error(
        '❌ Erreur création paiement Moneroo:',
        error
      );

      const status =
        error.status &&
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : 500;

      return res.status(status).json({
        ok: false,

        error:
          'PAYMENT_INITIALIZATION_FAILED',

        message:
          error.message ||
          'Impossible d’initialiser le paiement.',

        details:
          process.env.NODE_ENV === 'production'
            ? undefined
            : error.response || null
      });
    }
  }
);

/**
 * ============================================================
 * GET /payments/:paymentId
 * ============================================================
 */

router.get(
  '/:paymentId',
  authenticate,
  async (req, res) => {
    try {
      const {
        paymentId
      } = req.params;

      if (!paymentId) {
        return res.status(400).json({
          ok: false,
          error: 'PAYMENT_ID_REQUIRED',
          message:
            'Identifiant de paiement obligatoire.'
        });
      }

      const db =
        database.getPool();

      /**
       * --------------------------------------------------------
       * Vérifier que le paiement appartient à l'utilisateur
       * --------------------------------------------------------
       */

      const paymentResult =
        await db.query(
          `
          SELECT
            id,
            user_id,
            provider,
            provider_reference,
            plan,
            billing_cycle,
            amount,
            currency,
            status,
            checkout_url,
            paid_at,
            failure_reason,
            metadata,
            created_at,
            updated_at
          FROM payments
          WHERE provider = 'moneroo'
            AND provider_reference = $1
            AND user_id = $2
          LIMIT 1
          `,
          [
            paymentId,
            req.user.id
          ]
        );

      if (!paymentResult.rows.length) {
        return res.status(404).json({
          ok: false,
          error: 'PAYMENT_NOT_FOUND',
          message:
            'Paiement introuvable.'
        });
      }

      const payment =
        paymentResult.rows[0];

      /**
       * --------------------------------------------------------
       * Vérification auprès de Moneroo
       * --------------------------------------------------------
       */

      const monerooPayment =
        await getPayment(
          paymentId
        );

      return res.json({
        ok: true,

        payment,

        moneroo:
          monerooPayment
      });

    } catch (error) {
      console.error(
        '❌ Erreur vérification paiement:',
        error
      );

      const status =
        error.status &&
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : 500;

      return res.status(status).json({
        ok: false,
        error:
          'PAYMENT_VERIFICATION_FAILED',
        message:
          error.message ||
          'Impossible de vérifier le paiement.'
      });
    }
  }
);

module.exports = router;
