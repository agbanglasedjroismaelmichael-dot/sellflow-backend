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
    status:
      user.subscription_status || 'inactive',
    started_at:
      user.subscription_started_at,
    expires_at:
      user.subscription_expires_at
  };
}

/**
 * Active un abonnement uniquement après
 * confirmation d'un paiement valide.
 *
 * billingCycle :
 * - monthly
 * - annual
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

  const duration = getPlanDuration(
    normalizedPlan,
    normalizedBillingCycle
  );

  const now = new Date();

  const expiresAt = addDays(
    now,
    duration
  );

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

    billing_cycle:
      normalizedBillingCycle,

    duration_days:
      duration,

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
      plan
