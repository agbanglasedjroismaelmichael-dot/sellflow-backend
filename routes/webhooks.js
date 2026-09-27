const express = require('express');

const database = require('../config/database');

const {
  verifyPayment
} = require('../services/moneroo');

const {
  activateSubscription
} = require('../services/subscriptions');

const router = express.Router();

/**
 * ============================================================
 * SELLFLOW AI — WEBHOOKS MONEROO
 * ============================================================
 *
 * IMPORTANT :
 * Un webhook n'est pas considéré comme une preuve suffisante
 * d'un paiement réussi.
 *
 * Lorsqu'un événement de succès est reçu :
 *
 * 1. SellFlow récupère le paiement concerné.
 * 2. SellFlow vérifie directement le paiement auprès de Moneroo.
 * 3. Le paiement est marqué comme payé.
 * 4. L'abonnement est activé.
 *
 * Le service d'abonnement possède une protection contre
 * les doubles activations.
 *
 * ============================================================
 */

/**
 * ============================================================
 * OUTILS
 * ============================================================
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
 * Extraire l'identifiant du paiement.
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
 * Extraire le statut du paiement.
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
 * Vérifier si un statut représente un succès.
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
 * Vérifier si un statut représente un échec.
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
 * Extraire le statut réel retourné par Moneroo.
 */
function extractVerifiedStatus(payment) {
  return (
    payment?.data?.status ||
    payment?.data?.payment_status ||
    payment?.data?.payment?.status ||
    payment?.status ||
    payment?.payment_status ||
    payment?.payment?.status ||
    null
  );
}


/**
 * ============================================================
 * ROUTE WEBHOOK MONEROO
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
       * 1. PAYLOAD
       * --------------------------------------------------------
       */

      const payload =
        req.body || {};


      /**
       * --------------------------------------------------------
       * 2. IDENTIFICATION
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
       * 3. PAYMENT ID OBLIGATOIRE
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
       * 4. DATABASE
       * --------------------------------------------------------
       */

      const db =
        getDatabasePool();


      /**
       * --------------------------------------------------------
       * 5. RECHERCHE DU PAIEMENT
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
          [String(paymentId)]
        );


      /**
       * --------------------------------------------------------
       * PAIEMENT INCONNU
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
       * ========================================================
       * 6. PAIEMENT RÉUSSI
       * ========================================================
       */

      if (
        isSuccessfulEvent(
          eventName,
          payload
        )
      ) {

        /**
         * ------------------------------------------------------
         * VÉRIFICATION DIRECTE MONEROO
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
         * STATUT RÉEL
         * ------------------------------------------------------
         */

        const verifiedStatus =
          extractVerifiedStatus(
            verifiedPayment
          );

        console.log(
          '🔎 Statut Moneroo vérifié:',
          verifiedStatus
        );


        /**
         * ------------------------------------------------------
         * LE PAIEMENT DOIT ÊTRE CONFIRMÉ
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
         * 7. MARQUER LE PAIEMENT COMME PAYÉ
         * ------------------------------------------------------
         *
         * Si le paiement est déjà paid, on ne considère PAS
         * cela comme une erreur.
         *
         * On continue vers activateSubscription().
         *
         * C'est important :
         *
         * paiement marqué paid
         *        ↓
         * activation échoue
         *        ↓
         * webhook renvoyé
         *        ↓
         * activation peut être retentée
         *
         * Le service subscriptions.js empêche ensuite
         * une double activation.
         */

        let paymentWasJustMarkedPaid = false;

        if (
          payment.status !== 'paid'
        ) {

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

          paymentWasJustMarkedPaid =
            updateResult.rows.length > 0;

        }


        /**
         * ------------------------------------------------------
         * 8. ACTIVER L'ABONNEMENT
         * ------------------------------------------------------
         *
         * Les données viennent de la base de données,
         * pas du webhook.
         */

        try {

          if (
            typeof activateSubscription !==
            'function'
          ) {
            throw new Error(
              'activateSubscription() introuvable.'
            );
          }

          const subscription =
            await activateSubscription(
              payment.user_id,
              payment.plan,
              payment.provider_reference,
              payment.billing_cycle
            );


          /**
           * ----------------------------------------------------
           * SUCCÈS
           * ----------------------------------------------------
           */

          console.log(
            '✅ Paiement confirmé + abonnement activé:',
            {
              paymentId,
              userId: payment.user_id,
              plan: payment.plan,
              billingCycle:
                payment.billing_cycle,
              alreadyActivated:
                subscription?.already_activated ||
                false
            }
          );

          return res.json({
            ok: true,
            processed: true,
            payment_id: paymentId,
            status: 'paid',
            subscription_activated: true,
            already_activated:
              subscription?.already_activated ||
              false
          });

        } catch (subscriptionError) {

          /**
           * ----------------------------------------------------
           * IMPORTANT
           * ----------------------------------------------------
           *
           * Le paiement est déjà confirmé et payé.
           *
           * On retourne une erreur afin que Moneroo puisse
           * éventuellement renvoyer le webhook.
           *
           * Lors du prochain passage,
           * activateSubscription() pourra reprendre le travail.
           */

          console.error(
            '❌ Activation abonnement impossible:',
            subscriptionError
          );

          return res.status(500).json({
            ok: false,
            error:
              'SUBSCRIPTION_ACTIVATION_FAILED',
            payment_id: paymentId,
            payment_marked_paid:
              paymentWasJustMarkedPaid
          });
        }
      }


      /**
       * ========================================================
       * 9. PAIEMENT ÉCHOUÉ / ANNULÉ
       * ========================================================
       */

      if (
        isFailedEvent(
          eventName,
          payload
        )
      ) {

        /**
         * Ne jamais transformer un paiement déjà payé
         * en paiement échoué.
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
            AND status <> 'paid'
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
       * ========================================================
       * 10. ÉVÉNEMENT NON TRAITÉ
       * ========================================================
       */

      console.log(
        'ℹ️ Événement Moneroo ignoré:',
        eventName
      );


      return res.json({
        ok: true,
        ignored: true,
        event:
          eventName || null,
        payment_id:
          paymentId
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
