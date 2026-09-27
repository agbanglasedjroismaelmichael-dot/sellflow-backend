const database = require('../config/database');

const PLAN_DURATIONS = {
  starter: 30,
  pro: 30,
  business: 30
};

function getPlanDuration(plan) {
  return PLAN_DURATIONS[String(plan || '').toLowerCase()] || 30;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

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
    status: user.subscription_status || 'inactive',
    started_at: user.subscription_started_at,
    expires_at: user.subscription_expires_at
  };
}

async function activateSubscription(
  userId,
  plan,
  paymentReference = null
) {
  const db = database.getPool();

  const normalizedPlan =
    String(plan || '').toLowerCase();

  if (!PLAN_DURATIONS[normalizedPlan]) {
    throw new Error(
      'Plan invalide. Plans disponibles : starter, pro, business.'
    );
  }

  const duration =
    getPlanDuration(normalizedPlan);

  const now = new Date();
  const expiresAt =
    addDays(now, duration);

  const result = await db.query(
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

  return {
    ...result.rows[0],
    payment_reference:
      paymentReference || null
  };
}

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
      new Date(user.subscription_expires_at);

    if (expiresAt <= now) {
      await db.query(
        `
        UPDATE users
        SET
          subscription_status = 'expired',
          expired_notice_sent_at =
            COALESCE(expired_notice_sent_at, NOW()),
          updated_at = NOW()
        WHERE id = $1
        `,
        [user.id]
      );

      expired++;
      continue;
    }

    const difference =
      expiresAt.getTime() - now.getTime();

    const daysRemaining =
      Math.ceil(
        difference /
        (1000 * 60 * 60 * 24)
      );

    /*
     * Pour le moment, nous enregistrons uniquement
     * l'état du rappel.
     *
     * L'envoi email sera branché ensuite avec Resend
     * ou SMTP.
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
            COALESCE(reminder_7_sent_at, NOW()),
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

    if (
      daysRemaining <= 3 &&
      daysRemaining > 1
    ) {
      const result = await db.query(
        `
        UPDATE users
        SET
          reminder_3_sent_at =
            COALESCE(reminder_3_sent_at, NOW()),
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

    if (daysRemaining <= 1) {
      const result = await db.query(
        `
        UPDATE users
        SET
          reminder_1_sent_at =
            COALESCE(reminder_1_sent_at, NOW()),
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

function startSubscriptionReminderWorker() {
  const interval =
    Number(
      process.env.SUBSCRIPTION_CHECK_INTERVAL_MS
    ) || 21600000;

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

  setInterval(async () => {
    try {
      const result =
        await runSubscriptionReminders();

      console.log(
        'Vérification abonnements:',
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

module.exports = {
  PLAN_DURATIONS,
  getPlanDuration,
  getSubscription,
  activateSubscription,
  runSubscriptionReminders,
  startSubscriptionReminderWorker
};
