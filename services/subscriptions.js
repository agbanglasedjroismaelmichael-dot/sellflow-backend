const database = require('../config/database');

const PLAN_DURATIONS = {
  starter: {
    monthly: 30,
    annual: 365
  },
  pro: {
    monthly: 30,
    annual: 365
  },
  business: {
    monthly: 30,
    annual: 365
  }
};

function normalizePlan(plan) {
  return String(plan || '').trim().toLowerCase();
}

function normalizeBillingCycle(billingCycle) {
  const value = String(billingCycle || '').trim().toLowerCase();

  if (value === 'annual' || value === 'yearly') {
    return 'annual';
  }

  return 'monthly';
}

function getPlanDuration(plan, billingCycle = 'monthly') {
  const normalizedPlan = normalizePlan(plan);
  const normalizedBillingCycle =
    normalizeBillingCycle(billingCycle);

  return (
    PLAN_DURATIONS[normalizedPlan]?.[normalizedBillingCycle] ||
    30
  );
}

function addDays(date, days) {
  const result = new Date(date);

  result.setUTCDate(
    result.getUTCDate() + days
  );

  return result;
}

/**
 * ============================================================
 * RÉCUPÉRER L'ABONNEMENT D'UN UTILISATEUR
 * ============================================================
 */
async function getSubscription(userId) {
  const db = database.getPool();

  const result = await db.query(
    `
    SELECT
      id,
      email,
      name,
      plan,
      subscription_status,
      subscription_started_at,
      subscription_expires_at
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );

  if (!result.rows.length) {
    return null;
  }

  const user = result.rows[0];

  /*
   * Si l'abonnement est arrivé à expiration,
   * on met automatiquement son statut à expired.
   */
  if (
    user.subscription_expires_at &&
    new Date(user.subscription_expires_at) <= new Date() &&
    user.subscription_status === 'active'
  ) {
    await db.query(
      `
      UPDATE users
      SET
        subscription_status = 'expired',
        updated_at = NOW()
      WHERE id = $1
      `,
      [userId]
    );

    user.subscription_status = 'expired';
  }

  return {
    user_id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan || 'free',
    status:
      user.subscription_status || 'inactive',
    started_at:
      user.subscription_started_at,
    expires_at:
      user.subscription_expires_at
  };
}

/**
 * ============================================================
 * ACTIVER UN ABONNEMENT
 * ============================================================
 *
 * Cette fonction est appelée après confirmation
 * d'un paiement valide.
 *
 * billingCycle :
 * - monthly
 * - annual
 *
 * paymentReference :
 * référence du paiement Moneroo
 *
 * IMPORTANT :
 * La fonction est idempotente.
 * Si le même paiement est traité plusieurs fois,
 * l'abonnement ne sera pas activé une deuxième fois.
 */
async function activateSubscription(
  userId,
  plan,
  paymentReference = null,
  billingCycle = 'monthly'
) {
  const db = database.getPool();

  const normalizedPlan =
    normalizePlan(plan);

  const normalizedBillingCycle =
    normalizeBillingCycle(billingCycle);

  if (!PLAN_DURATIONS[normalizedPlan]) {
    throw new Error(
      'Plan invalide. Plans disponibles : starter, pro, business.'
    );
  }

  /*
   * On utilise une transaction afin que :
   *
   * 1. Le paiement soit vérifié
   * 2. L'abonnement soit activé
   * 3. Le paiement soit marqué comme déjà traité
   *
   * tout cela de manière cohérente.
   */
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    /*
     * --------------------------------------------------------
     * PROTECTION CONTRE LES DOUBLES ACTIVATIONS
     * --------------------------------------------------------
     */
    if (paymentReference) {
      const paymentResult = await client.query(
        `
        SELECT
          id,
          user_id,
          provider,
          provider_reference,
          plan,
          billing_cycle,
          status,
          metadata
        FROM payments
        WHERE provider_reference = $1
          AND user_id = $2
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        `,
        [
          String(paymentReference),
          userId
        ]
      );

      if (paymentResult.rows.length) {
        const payment = paymentResult.rows[0];

        const metadata =
          payment.metadata || {};

        /*
         * Le même paiement a déjà activé
         * l'abonnement.
         */
        if (
          metadata.subscription_activated === true
        ) {
          const existingUser =
            await client.query(
              `
              SELECT
                id,
                email,
                name,
                plan,
                subscription_status,
                subscription_started_at,
                subscription_expires_at
              FROM users
              WHERE id = $1
              LIMIT 1
              `,
              [userId]
            );

          if (!existingUser.rows.length) {
            throw new Error(
              'Utilisateur introuvable.'
            );
          }

          await client.query('COMMIT');

          return {
            ...existingUser.rows[0],
            billing_cycle:
              metadata.billing_cycle ||
              normalizedBillingCycle,
            duration_days:
              metadata.duration_days ||
              getPlanDuration(
                normalizedPlan,
                normalizedBillingCycle
              ),
            payment_reference:
              paymentReference,
            already_activated: true
          };
        }
      }
    }

    /*
     * --------------------------------------------------------
     * CALCUL DE LA DATE D'EXPIRATION
     * --------------------------------------------------------
     */
    const duration =
      getPlanDuration(
        normalizedPlan,
        normalizedBillingCycle
      );

    const now = new Date();

    const expiresAt =
      addDays(now, duration);

    /*
     * --------------------------------------------------------
     * ACTIVATION DE L'ABONNEMENT
     * --------------------------------------------------------
     */
    const result = await client.query(
      `
      UPDATE users
      SET
        plan = $1,
        subscription_status = 'active',
        subscription_started_at = $2,
        subscription_expires_at = $3,

        reminder_7_sent_at = NULL,
        reminder_3_sent_at = NULL,
        reminder_1_sent_at = NULL,
        expired_notice_sent_at = NULL,

        updated_at = NOW()

      WHERE id = $4

      RETURNING
        id,
        email,
        name,
        plan,
        subscription_status,
        subscription_started_at,
        subscription_expires_at
      `,
      [
        normalizedPlan,
        now,
        expiresAt,
        userId
      ]
    );

    if (!result.rows.length) {
      throw new Error(
        'Utilisateur introuvable.'
      );
    }

    /*
     * --------------------------------------------------------
     * MARQUER LE PAIEMENT COMME AYANT ACTIVÉ
     * L'ABONNEMENT
     * --------------------------------------------------------
     */
    if (paymentReference) {
      await client.query(
        `
        UPDATE payments
        SET
          metadata =
            COALESCE(metadata, '{}'::jsonb)
            ||
            jsonb_build_object(
              'subscription_activated',
              true,
              'subscription_activated_at',
              NOW(),
              'billing_cycle',
              $1,
              'duration_days',
              $2
            ),
          updated_at = NOW()
        WHERE provider_reference = $3
          AND user_id = $4
        `,
        [
          normalizedBillingCycle,
          duration,
          String(paymentReference),
          userId
        ]
      );
    }

    await client.query('COMMIT');

    return {
      ...result.rows[0],

      billing_cycle:
        normalizedBillingCycle,

      duration_days:
        duration,

      payment_reference:
        paymentReference || null,

      already_activated: false
    };

  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(
        'Erreur rollback abonnement:',
        rollbackError
      );
    }

    throw error;

  } finally {
    client.release();
  }
}

/**
 * ============================================================
 * VÉRIFICATION DES ABONNEMENTS
 * ============================================================
 */
async function runSubscriptionReminders() {
  const db = database.getPool();

  const users = await db.query(
    `
    SELECT
      id,
      email,
      name,
      plan,
      subscription_status,
      subscription_expires_at
    FROM users
    WHERE
      subscription_status = 'active'
      AND subscription_expires_at IS NOT NULL
    ORDER BY subscription_expires_at ASC
    `
  );

  const now = new Date();

  let checked = 0;
  let expired = 0;
  let reminders = 0;

  for (const user of users.rows) {
    checked++;

    const expiresAt =
      new Date(
        user.subscription_expires_at
      );

    /*
     * --------------------------------------------------------
     * ABONNEMENT EXPIRÉ
     * --------------------------------------------------------
     */
    if (expiresAt <= now) {
      await db.query(
        `
        UPDATE users
        SET
          subscription_status = 'expired',

          expired_notice_sent_at =
            COALESCE(
              expired_notice_sent_at,
              NOW()
            ),

          updated_at = NOW()

        WHERE id = $1
        `,
        [user.id]
      );

      expired++;

      continue;
    }

    /*
     * --------------------------------------------------------
     * JOURS RESTANTS
     * --------------------------------------------------------
     */
    const difference =
      expiresAt.getTime() -
      now.getTime();

    const daysRemaining =
      Math.ceil(
        difference /
        (1000 * 60 * 60 * 24)
      );

    /*
     * --------------------------------------------------------
     * RAPPEL J-7
     * --------------------------------------------------------
     */
    if (
      daysRemaining <= 7 &&
      daysRemaining > 3
    ) {
      const result = await db.query(
        `
        UPDATE users
        SET
          reminder_7_sent_at =
            COALESCE(
              reminder_7_sent_at,
              NOW()
            ),

          updated_at = NOW()

        WHERE id = $1
          AND reminder_7_sent_at IS NULL

        RETURNING id
        `,
        [user.id]
      );

      if (result.rows.length) {
        reminders++;
      }
    }

    /*
     * --------------------------------------------------------
     * RAPPEL J-3
     * --------------------------------------------------------
     */
    if (
      daysRemaining <= 3 &&
      daysRemaining > 1
    ) {
      const result = await db.query(
        `
        UPDATE users
        SET
          reminder_3_sent_at =
            COALESCE(
              reminder_3_sent_at,
              NOW()
            ),

          updated_at = NOW()

        WHERE id = $1
          AND reminder_3_sent_at IS NULL

        RETURNING id
        `,
        [user.id]
      );

      if (result.rows.length) {
        reminders++;
      }
    }

    /*
     * --------------------------------------------------------
     * RAPPEL J-1
     * --------------------------------------------------------
     */
    if (daysRemaining <= 1) {
      const result = await db.query(
        `
        UPDATE users
        SET
          reminder_1_sent_at =
            COALESCE(
              reminder_1_sent_at,
              NOW()
            ),

          updated_at = NOW()

        WHERE id = $1
          AND reminder_1_sent_at IS NULL

        RETURNING id
        `,
        [user.id]
      );

      if (result.rows.length) {
        reminders++;
      }
    }
  }

  return {
    checked,
    expired,
    reminders
  };
}

/**
 * ============================================================
 * WORKER AUTOMATIQUE
 * ============================================================
 */
function startSubscriptionReminderWorker() {
  const interval =
    Number(
      process.env.SUBSCRIPTION_CHECK_INTERVAL_MS
    ) || 21600000;

  /*
   * Première vérification 5 secondes
   * après le démarrage du serveur.
   */
  setTimeout(async () => {
    try {
      const result =
        await runSubscriptionReminders();

      console.log(
        'Vérification abonnements:',
        result
      );
    } catch (error) {
      console.error(
        'Erreur vérification abonnements:',
        error
      );
    }
  }, 5000);

  /*
   * Puis vérification périodique.
   *
   * 21600000 ms = 6 heures
   */
  setInterval(async () => {
    try {
      const result =
        await runSubscriptionReminders();

      console.log(
        'Worker abonnements:',
        result
      );
    } catch (error) {
      console.error(
        'Erreur worker abonnements:',
        error
      );
    }
  }, interval);
}

/**
 * ============================================================
 * EXPORTS
 * ============================================================
 */
module.exports = {
  PLAN_DURATIONS,
  normalizePlan,
  normalizeBillingCycle,
  getPlanDuration,
  getSubscription,
  activateSubscription,
  runSubscriptionReminders,
  startSubscriptionReminderWorker
};
