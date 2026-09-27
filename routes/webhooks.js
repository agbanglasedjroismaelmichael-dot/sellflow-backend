const express = require('express');

const database = require('../config/database');

const {
  verifyPayment
} = require('../services/moneroo');

const router = express.Router();

/**
 * ============================================================
 * SELLFLOW AI — WEBHOOKS MONEROO
 * ============================================================
 *
 * IMPORTANT :
 * Le webhook ne doit jamais être considéré comme une preuve
 * suffisante d'un paiement réussi.
 *
 * Lorsqu'un événement de succès est reçu, SellFlow vérifie
 * directement le paiement auprès de Moneroo avant d'activer
 * l'abonnement.
 *
 * ============================================================
 */

/**
 * ============================================================
 * OUTILS
 * ============================================================
 */

/**
 * Récupérer le pool PostgreSQL.
 */
function getDatabasePool() {
  if (
    database &&
    typeof database.getPool === 'function'
  ) {
    return database.getPool();
  }

  throw new Error(
    'getPool() est introuvable dans config/database.js.'
  );
}


/**
 * Extraire l'identifiant du paiement depuis différents
 * formats possibles du webhook.
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


/**
 * Extraire le nom de l'événement.
 */
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
 * Extraire le statut du paiement du webhook.
 */
function extractWebhookStatus(payload) {
  return (
    payload?.data?.status ||
    payload?.data?.payment_status ||
    payload?.data?.payment?.status ||
    payload?.status ||
    payload?.payment_status ||
    payload?.payment?.status ||
    null
  );
}


/**
 * Normaliser un statut.
 */
function normalizeStatus(status) {
  if (
    typeof status !== 'string'
  ) {
    return null;
  }

  return status
    .trim()
    .toLowerCase();
}


/**
 * Vérifier si un statut représente un paiement réussi.
 */
function isSuccessfulStatus(status) {
  return [
    'success',
    'successful',
    'succeeded',
    'paid',
    'completed'
  ].includes(
    normalizeStatus(status)
  );
}


/**
 * Vérifier si un statut représente un paiement échoué.
 */
function isFailedStatus(status) {
  return [
    'failed',
    'failure',
    'cancelled',
    'canceled',
    'expired'
  ].includes(
    normalizeStatus(status)
  );
}


/**
 * Vérifier si l'événement représente un succès.
 */
function isSuccessfulEvent(
  eventName,
  payload
) {
  const event =
    String(eventName || '')
      .trim()
      .toLowerCase();

  if (
    [
      'payment.success',
      'payment_success',
      'payment.succeeded',
      'payment_succeeded',
      'payment.paid',
      'payment_paid'
    ].includes(event)
  ) {
    return true;
  }

  return isSuccessfulStatus(
    extractWebhookStatus(payload)
  );
}


/**
 * Vérifier si l'événement représente un échec.
 */
function isFailedEvent(
  eventName,
  payload
) {
  const event =
    String(eventName || '')
      .trim()
      .toLowerCase();

  if (
    [
      'payment.failed',
      'payment_failed',
      'payment.cancelled',
      'payment_cancelled',
      'payment.canceled',
      'payment_expired'
    ].includes(event)
  ) {
    return true;
  }

  return isFailedStatus(
    extractWebhookStatus(payload)
  );
}


/**
 * ============================================================
 * ROUTE WEBHOOK
 * ============================================================
 */

router.post(
  '/moneroo',
  express.json({
    limit: '1mb'
  }),
  async (req, res) => {
    try {

      /**
       * --------------------------------------------------------
       * 1. Récupérer le payload
       * --------------------------------------------------------
       */

      const payload =
        req.body || {};

      /**
       * --------------------------------------------------------
       * 2. Identifier l'événement
       * --------------------------------------------------------
       */

      const eventName =
        extractEventName(payload);

      const paymentId =
        extractPaymentId(payload);

      console.log(
        '📩 Webhook Moneroo reçu:',
        {
          event: eventName,
          paymentId
        }
      );

      /**
       * --------------------------------------------------------
       * 3. Vérifier paymentId
       * --------------------------------------------------------
       */

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
       * 4. Connexion PostgreSQL
       * --------------------------------------------------------
       */

      const db =
        getDatabasePool();

      /**
       * --------------------------------------------------------
       * 5. Rechercher le paiement
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
            metadata
          FROM payments
          WHERE provider = 'moneroo'
            AND provider_reference = $1
          LIMIT 1
          `,
          [paymentId]
        );

      /**
       * --------------------------------------------------------
       * Paiement inconnu
       * --------------------------------------------------------
       */

      if (
        paymentResult.rows.length === 0
      ) {
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
       * 6. Événement de succès
       * --------------------------------------------------------
       */

      if (
        isSuccessfulEvent(
          eventName,
          payload
        )
      ) {

        /**
         * ------------------------------------------------------
         * Protection contre les doublons
         * ------------------------------------------------------
         */

        if (
          payment.status === 'paid'
        ) {
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
         * Vérification DIRECTE auprès de Moneroo
         * ------------------------------------------------------
         */

        let verifiedPayment;

        try {

          verifiedPayment =
            await verifyPayment(
              paymentId
            );

        } catch (verificationError) {

          console.error(
            '❌ Vérification Moneroo impossible:',
            verificationError
          );

          return res.status(502).json({
            ok: false,
            error:
              'MONEROO_VERIFICATION_FAILED'
          });
        }

        /**
         * ------------------------------------------------------
         * Récupérer le statut réel
         * ------------------------------------------------------
         */

        const verifiedStatus =
          verifiedPayment?.data?.status ||
          verifiedPayment?.data?.payment_status ||
          verifiedPayment?.data?.payment?.status ||
          verifiedPayment?.status ||
          verifiedPayment?.payment_status ||
          verifiedPayment?.payment?.status ||
          null;

        console.log(
          '🔎 Statut Moneroo vérifié:',
          verifiedStatus
        );

        /**
         * ------------------------------------------------------
         * Le paiement doit être réellement confirmé
         * ------------------------------------------------------
         */

        if (
          !isSuccessfulStatus(
            verifiedStatus
          )
        ) {

          console.warn(
            '⚠️ Paiement non confirmé par Moneroo:',
            {
              paymentId,
              verifiedStatus
            }
          );

          return res.status(409).json({
            ok: false,
            error:
              'PAYMENT_NOT_CONFIRMED'
          });
        }

        /**
         * ------------------------------------------------------
         * 7. Marquer le paiement comme payé
         * ------------------------------------------------------
         */

        const updateResult =
          await db.query(
            `
            UPDATE payments
            SET
              status = 'paid',
              paid_at = COALESCE(
                paid_at,
                NOW()
              ),
              updated_at = NOW()
            WHERE id = $1
              AND status <> 'paid'
            RETURNING id
            `,
            [payment.id]
          );

        /**
         * ------------------------------------------------------
         * Si quelqu'un a déjà traité le paiement entre-temps
         * ------------------------------------------------------
         */

        if (
          updateResult.rows.length === 0
        ) {

          console.log(
            'ℹ️ Paiement déjà traité simultanément:',
            paymentId
          );

          return res.json({
            ok: true,
            already_processed: true
          });
        }

        /**
         * ------------------------------------------------------
         * 8. Activer l'abonnement
         * ------------------------------------------------------
         */

        let activateSubscription;

        try {

          const subscriptionService =
            require('../services/subscriptions');

          activateSubscription =
            subscriptionService
              .activateSubscription;

        } catch (subscriptionError) {

          console.error(
            '❌ Service abonnement introuvable:',
            subscriptionError
          );

          /**
           * Le paiement est déjà marqué payé.
           *
           * On retourne une erreur pour que le problème
           * soit visible dans les logs et puisse être corrigé.
           */

          return res.status(500).json({
            ok: false,
            error:
              'SUBSCRIPTION_SERVICE_UNAVAILABLE'
          });
        }

        if (
          typeof activateSubscription !==
          'function'
        ) {

          console.error(
            '❌ activateSubscription() introuvable.'
          );

          return res.status(500).json({
            ok: false,
            error:
              'SUBSCRIPTION_ACTIVATION_UNAVAILABLE'
          });
        }

        /**
         * ------------------------------------------------------
         * Activation avec les données de la DB
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
          processed: true,
          payment_id: paymentId,
          status: 'paid'
        });
      }

      /**
       * --------------------------------------------------------
       * 9. Paiement échoué / annulé
       * --------------------------------------------------------
       */

      if (
        isFailedEvent(
          eventName,
          payload
        )
      ) {

        /**
         * Ne jamais remplacer "paid" par "failed".
         */

        if (
          payment.status === 'paid'
        ) {

          console.log(
            'ℹ️ Paiement déjà payé, événement d’échec ignoré:',
            paymentId
          );

          return res.json({
            ok: true,
            already_paid: true
          });
        }

        const failureReason =
          eventName ||
          extractWebhookStatus(payload) ||
          'Payment failed';

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
            String(failureReason)
          ]
        );

        console.log(
          '❌ Paiement échoué:',
          paymentId
        );

        return res.json({
          ok: true,
          processed: true,
          payment_id: paymentId,
          status: 'failed'
        });
      }

      /**
       * --------------------------------------------------------
       * 10. Événement non traité
       * --------------------------------------------------------
       */

      console.log(
        'ℹ️ Événement Moneroo ignoré:',
        eventName
      );

      return res.json({
        ok: true,
        ignored: true,
        event: eventName || null,
        payment_id: paymentId
      });

    } catch (error) {

      console.error(
        '❌ Erreur webhook Moneroo:',
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          'WEBHOOK_PROCESSING_FAILED'
      });
    }
  }
);

module.exports = router;
