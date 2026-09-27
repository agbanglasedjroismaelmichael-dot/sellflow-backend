const express = require('express');
const crypto = require('crypto');

const database = require('../config/database');
const {
  verifyPayment
} = require('../services/moneroo');
const {
  activateSubscription
} = require('../services/subscriptions');

const router = express.Router();

const MONEROO_WEBHOOK_SECRET =
  process.env.MONEROO_WEBHOOK_SECRET;


/**
 * ============================================================
 * OUTIL DATABASE
 * ============================================================
 */

function getDatabaseClient() {
  if (database && typeof database.query === 'function') {
    return database;
  }

  if (
    database &&
    database.pool &&
    typeof database.pool.query === 'function'
  ) {
    return database.pool;
  }

  throw new Error(
    'Connexion PostgreSQL introuvable dans config/database.js.'
  );
}


/**
 * ============================================================
 * VÉRIFICATION SIGNATURE MONEROO
 * ============================================================
 */

function verifyWebhookSignature(rawBody, signature) {
  if (!MONEROO_WEBHOOK_SECRET) {
    throw new Error(
      'MONEROO_WEBHOOK_SECRET n’est pas configuré.'
    );
  }

  if (!signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac(
      'sha256',
      MONEROO_WEBHOOK_SECRET
    )
    .update(rawBody, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'utf8'),
      Buffer.from(String(signature), 'utf8')
    );
  } catch {
    return false;
  }
}


/**
 * ============================================================
 * EXTRACTION DES INFORMATIONS
 * ============================================================
 */

function extractPaymentId(payload) {
  return (
    payload?.data?.id ||
    payload?.data?.payment?.id ||
    payload?.payment?.id ||
    payload?.payment_id ||
    payload?.data?.payment_id ||
    null
  );
}

function extractEventName(payload) {
  return (
    payload?.event ||
    payload?.type ||
    payload?.name ||
    payload?.data?.event ||
    null
  );
}


/**
 * ============================================================
 * DÉTERMINER SI LE PAIEMENT EST RÉUSSI
 * ============================================================
 */

function isSuccessfulEvent(eventName, payload) {
  const event = String(eventName || '').toLowerCase();

  if (
    event === 'payment.success' ||
    event === 'payment_success' ||
    event === 'payment.succeeded' ||
    event === 'payment_succeeded'
  ) {
    return true;
  }

  const status =
    payload?.data?.status ||
    payload?.data?.payment_status ||
    payload?.status ||
    payload?.payment_status ||
    payload?.data?.payment?.status ||
    null;

  if (
    typeof status === 'string' &&
    [
      'success',
      'successful',
      'succeeded',
      'paid',
      'completed'
    ].includes(status.toLowerCase())
  ) {
    return true;
  }

  return false;
}


/**
 * ============================================================
 * DÉTERMINER SI LE PAIEMENT A ÉCHOUÉ
 * ============================================================
 */

function isFailedEvent(eventName, payload) {
  const event = String(eventName || '').toLowerCase();

  if (
    event === 'payment.failed' ||
    event === 'payment_failed' ||
    event === 'payment.cancelled' ||
    event === 'payment_cancelled'
  ) {
    return true;
  }

  const status =
    payload?.data?.status ||
    payload?.data?.payment_status ||
    payload?.status ||
    payload?.payment_status ||
    payload?.data?.payment?.status ||
    null;

  if (
    typeof status === 'string' &&
    [
      'failed',
      'failure',
      'cancelled',
      'canceled',
      'expired'
    ].includes(status.toLowerCase())
  ) {
    return true;
  }

  return false;
}


/**
 * ============================================================
 * WEBHOOK MONEROO
 *
 * IMPORTANT :
 * express.json() ne doit pas être utilisé avant cette route
 * si nous voulons vérifier la signature sur le corps brut.
 * ============================================================
 */

router.post(
  '/moneroo',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : String(req.body || '');

      const signature =
        req.headers['x-moneroo-signature'];

      /**
       * --------------------------------------------------------
       * 1. Vérifier la signature
       * --------------------------------------------------------
       */

      const validSignature =
        verifyWebhookSignature(
          rawBody,
          signature
        );

      if (!validSignature) {
        console.warn(
          '⚠️ Signature webhook Moneroo invalide.'
        );

        return res.status(401).json({
          ok: false,
          error: 'INVALID_WEBHOOK_SIGNATURE'
        });
      }


      /**
       * --------------------------------------------------------
       * 2. Parser le JSON
       * --------------------------------------------------------
       */

      let payload;

      try {
        payload = JSON.parse(rawBody);
      } catch {
        return res.status(400).json({
          ok: false,
          error: 'INVALID_JSON'
        });
      }


      /**
       * --------------------------------------------------------
       * 3. Identifier l'événement
       * --------------------------------------------------------
       */

      const eventName =
        extractEventName(payload);

      const paymentId =
        extractPaymentId(payload);

      console.log(
        '📩 Webhook Moneroo reçu:',
        eventName,
        paymentId
      );

      if (!paymentId) {
        console.warn(
          '⚠️ Webhook Moneroo sans payment ID.'
        );

        return res.status(400).json({
          ok: false,
          error: 'PAYMENT_ID_MISSING'
        });
      }


      /**
       * --------------------------------------------------------
       * 4. Trouver le paiement dans SellFlow
       * --------------------------------------------------------
       */

      const db = getDatabaseClient();

      const paymentResult = await db.query(
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
          metadata
        FROM payments
        WHERE provider = 'moneroo'
          AND provider_reference = $1
        LIMIT 1
        `,
        [paymentId]
      );

      if (paymentResult.rows.length === 0) {
        console.warn(
          '⚠️ Paiement Moneroo inconnu:',
          paymentId
        );

        return res.status(404).json({
          ok: false,
          error: 'PAYMENT_NOT_FOUND'
        });
      }

      const payment =
        paymentResult.rows[0];


      /**
       * --------------------------------------------------------
       * 5. Paiement réussi
       * --------------------------------------------------------
       */

      if (
        isSuccessfulEvent(
          eventName,
          payload
        )
      ) {

        /**
         * Vérification supplémentaire directement
         * auprès de Moneroo.
         */
        let verifiedPayment;

        try {
          verifiedPayment =
            await verifyPayment(paymentId);
        } catch (verificationError) {
          console.error(
            '❌ Vérification Moneroo impossible:',
            verificationError.message
          );

          return res.status(500).json({
            ok: false,
            error: 'MONEROO_VERIFICATION_FAILED'
          });
        }


        /**
         * ------------------------------------------------------
         * Idempotence
         *
         * Si le webhook est reçu plusieurs fois, on ne doit
         * jamais prolonger l'abonnement plusieurs fois.
         * ------------------------------------------------------
         */

        if (payment.status === 'paid') {
          console.log(
            'ℹ️ Paiement déjà traité:',
            paymentId
          );

          return res.json({
            ok: true,
            already_processed: true
          });
        }


        /**
         * ------------------------------------------------------
         * Vérification du statut final.
         * ------------------------------------------------------
         */

        const verifiedStatus =
          verifiedPayment?.data?.status ||
          verifiedPayment?.data?.payment_status ||
          verifiedPayment?.status ||
          verifiedPayment?.payment_status ||
          null;

        if (
          typeof verifiedStatus === 'string' &&
          ![
            'success',
            'successful',
            'succeeded',
            'paid',
            'completed'
          ].includes(
            verifiedStatus.toLowerCase()
          )
        ) {
          console.warn(
            '⚠️ Le webhook indique un succès mais la vérification Moneroo ne confirme pas le paiement:',
            verifiedStatus
          );

          return res.status(409).json({
            ok: false,
            error: 'PAYMENT_NOT_CONFIRMED'
          });
        }


        /**
         * ------------------------------------------------------
         * Marquer le paiement comme payé.
         * ------------------------------------------------------
         */

        await db.query(
          `
          UPDATE payments
          SET
            status = 'paid',
            paid_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
          `,
          [payment.id]
        );


        /**
         * ------------------------------------------------------
         * Activer l'abonnement.
         *
         * IMPORTANT :
         * Cette fonction utilise plan + billing_cycle
         * provenant de la base de données.
         * ------------------------------------------------------
         */

        await activateSubscription(
          payment.user_id,
          payment.plan,
          payment.provider_reference,
          payment.billing_cycle
        );


        console.log(
          '✅ Paiement confirmé + abonnement activé:',
          paymentId
        );

        return res.json({
          ok: true,
          processed: true
        });
      }


      /**
       * --------------------------------------------------------
       * 6. Paiement échoué / annulé
       * --------------------------------------------------------
       */

      if (
        isFailedEvent(
          eventName,
          payload
        )
      ) {

        /**
         * Ne pas écraser un paiement déjà payé.
         */
        if (payment.status === 'paid') {
          return res.json({
            ok: true,
            already_paid: true
          });
        }

        await db.query(
          `
          UPDATE payments
          SET
            status = 'failed',
            failure_reason = $2,
            updated_at = NOW()
          WHERE id = $1
          `,
          [
            payment.id,
            eventName || 'Payment failed'
          ]
        );

        console.log(
          '❌ Paiement échoué:',
          paymentId
        );

        return res.json({
          ok: true,
          processed: true
        });
      }


      /**
       * --------------------------------------------------------
       * 7. Événement non traité
       * --------------------------------------------------------
       */

      console.log(
        'ℹ️ Événement Moneroo reçu mais non traité:',
        eventName
      );

      return res.json({
        ok: true,
        ignored: true,
        event: eventName
      });

    } catch (error) {
      console.error(
        '❌ Erreur webhook Moneroo:',
        error
      );

      return res.status(500).json({
        ok: false,
        error: 'WEBHOOK_PROCESSING_FAILED'
      });
    }
  }
);


module.exports = router;
