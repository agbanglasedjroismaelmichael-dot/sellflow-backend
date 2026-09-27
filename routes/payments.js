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

    const decoded = verifyToken(token);

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
 *
 * Retourne les 6 offres disponibles.
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
 *
 * Crée un paiement Moneroo.
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

      const offer = OFFERS[offer_id];

      if (!offer) {
        return res.status(400).json({
          ok: false,
          error: 'INVALID_OFFER',
          message: 'Offre SellFlow invalide.'
        });
      }


      /**
       * --------------------------------------------------------
       * 2. Récupérer le compte depuis PostgreSQL
       * --------------------------------------------------------
       */

      const db =
        database.getPool();

      const userResult =
        await db.query(
          `
          SELECT
            id,
            email,
            first_name,
            last_name
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

      const customerFirstName =
        String(
          first_name ||
          user.first_name ||
          'Client'
        ).trim();

      const customerLastName =
        String(
          last_name ||
          user.last_name ||
          'SellFlow'
        ).trim();


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
        billing_cycle:
          String(offer.billing_cycle),
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
       * Ajouter le téléphone uniquement
       * s'il a réellement été fourni.
       */

      if (
        phone !== undefined &&
        phone !== null &&
        String(phone).trim() !== ''
      ) {
        paymentPayload.customer.phone =
          String(phone).trim();
      }


      /**
       * Ajouter la méthode uniquement
       * si elle a été fournie.
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
       * 7. Initialiser chez Moneroo
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


      /**
       * --------------------------------------------------------
       * 8. Enregistrer le paiement
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
            customer_email:
              user.email
          })
        ]
      );


      /**
       * --------------------------------------------------------
       * 9. Réponse frontend
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

          amount: offer.amount,

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
 *
 * Vérifie un paiement appartenant
 * à l'utilisateur connecté.
 *
 * Cette route ne déclenche PAS l'activation
 * de l'abonnement.
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
       * Vérifier que le paiement
       * appartient bien à l'utilisateur.
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
       * Vérification auprès de Moneroo.
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

      return res.status(500).json({
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
