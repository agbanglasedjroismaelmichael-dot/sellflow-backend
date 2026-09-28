const { getPool } = require('../config/database');

/*
 * SellFlow AI — initialisation PostgreSQL
 *
 * IMPORTANT :
 * - Aucun SQL ne doit être écrit directement dans le JavaScript sans
 *   être entre quotes ou backticks.
 * - Ce fichier ne supprime aucune donnée existante.
 * - Il ajoute les tables/colonnes manquantes.
 * - La vérification e-mail est volontairement désactivée.
 * - Resend / envoi d'e-mails ne fait pas partie de ce fichier.
 */

async function initDatabase() {
  const pool = getPool();

  console.log('🗄️ Initialisation PostgreSQL SellFlow...');

  /*
   * pgcrypto n'est pas obligatoire pour l'inscription actuelle,
   * mais il reste utile pour les bases historiques de SellFlow.
   */
  try {
    await pool.query(
      'CREATE EXTENSION IF NOT EXISTS pgcrypto'
    );

    console.log('✅ Extension pgcrypto disponible.');
  } catch (error) {
    console.warn(
      '⚠️ pgcrypto non disponible, poursuite sans cette extension:',
      error.message
    );
  }

  /*
   * USERS
   *
   * Le champ id est TEXT pour rester compatible avec les installations
   * historiques qui utilisent UUID ou identifiants texte.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name VARCHAR(150),
      email VARCHAR(320),
      phone VARCHAR(50),
      country VARCHAR(100),
      dial_code VARCHAR(10),
      phone_international VARCHAR(50),

      password_hash TEXT,
      google_id VARCHAR(255),
      auth_provider VARCHAR(30) DEFAULT 'password',

      email_verified BOOLEAN NOT NULL DEFAULT TRUE,

      plan VARCHAR(50) NOT NULL DEFAULT 'free',
      billing VARCHAR(30) NOT NULL DEFAULT 'monthly',
      subscription_status VARCHAR(30) NOT NULL DEFAULT 'active',
      subscription_started_at TIMESTAMPTZ,
      subscription_expires_at TIMESTAMPTZ,

      /*
       * Connexion Chariow persistante.
       * Ces colonnes permettent de conserver la connexion entre
       * plusieurs sessions sans redemander la clé API à chaque connexion.
       */
      chariow_api_key TEXT,
      chariow_store_id TEXT,
      chariow_store_name VARCHAR(255),
      chariow_store_url TEXT,
      chariow_connected BOOLEAN NOT NULL DEFAULT FALSE,
      chariow_connected_at TIMESTAMPTZ,
      chariow_last_sync_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /*
   * Ajout des colonnes manquantes pour les bases déjà existantes.
   */
  const userColumnQueries = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(150)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(320)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS country VARCHAR(100)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS dial_code VARCHAR(10)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_international VARCHAR(50)`,

    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(30) DEFAULT 'password'`,

    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT TRUE`,

    `ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'free'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing VARCHAR(30) DEFAULT 'monthly'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(30) DEFAULT 'active'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ`,

    `ALTER TABLE users ADD COLUMN IF NOT EXISTS chariow_api_key TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS chariow_store_id TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS chariow_store_name VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS chariow_store_url TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS chariow_connected BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS chariow_connected_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS chariow_last_sync_at TIMESTAMPTZ`,

    `ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`
  ];

  for (const query of userColumnQueries) {
    await pool.query(query);
  }

  /*
   * Valeurs de sécurité pour les anciennes lignes.
   */
  await pool.query(`
    UPDATE users
    SET
      email_verified = COALESCE(email_verified, TRUE),
      plan = COALESCE(plan, 'free'),
      billing = COALESCE(billing, 'monthly'),
      subscription_status = COALESCE(subscription_status, 'active'),
      chariow_connected = COALESCE(chariow_connected, FALSE),
      created_at = COALESCE(created_at, NOW()),
      updated_at = COALESCE(updated_at, NOW())
    WHERE
      email_verified IS NULL
      OR plan IS NULL
      OR billing IS NULL
      OR subscription_status IS NULL
      OR chariow_connected IS NULL
      OR created_at IS NULL
      OR updated_at IS NULL
  `);

  /*
   * UN SEUL COMPTE PAR E-MAIL
   *
   * On ne bloque pas le démarrage si une ancienne base contient déjà
   * des doublons : on les signale et l'API /auth/register les refuse.
   */
  const duplicateEmails = await pool.query(`
    SELECT LOWER(TRIM(email)) AS normalized_email, COUNT(*) AS count
    FROM users
    WHERE email IS NOT NULL
      AND TRIM(email) <> ''
    GROUP BY LOWER(TRIM(email))
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `);

  if (duplicateEmails.rows.length === 0) {
    try {
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_normalized
        ON users (LOWER(TRIM(email)))
        WHERE email IS NOT NULL
          AND TRIM(email) <> ''
      `);

      console.log('✅ Unicité e-mail PostgreSQL activée.');
    } catch (error) {
      console.warn(
        '⚠️ Impossible de créer l’index unique des e-mails:',
        error.message
      );
    }
  } else {
    console.warn(
      `⚠️ ${duplicateEmails.rows.length} e-mail(s) dupliqué(s) existent déjà dans users.`
    );

    console.warn(
      'ℹ️ Aucun compte existant n’est supprimé automatiquement.'
    );
  }

  /*
   * CONNEXIONS CHARIOW
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chariow_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      api_key TEXT,
      store_id TEXT,
      store_name VARCHAR(255),
      store_url TEXT,
      connected BOOLEAN NOT NULL DEFAULT TRUE,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sync_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS chariow_connections_user_unique
    ON chariow_connections (user_id)
  `);

  /*
   * SUBSCRIPTIONS
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan VARCHAR(50) NOT NULL,
      billing VARCHAR(30) NOT NULL DEFAULT 'monthly',
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      provider VARCHAR(50),
      external_subscription_id TEXT,
      amount NUMERIC(14,2),
      currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
      started_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx
    ON subscriptions (user_id)
  `);

  /*
   * PAYMENTS
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      plan VARCHAR(50),
      billing VARCHAR(30),
      amount NUMERIC(14,2),
      currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      payment_method VARCHAR(50),
      provider VARCHAR(50),
      transaction_id TEXT,
      external_payment_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS payments_user_id_idx
    ON payments (user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS payments_transaction_id_idx
    ON payments (transaction_id)
  `);

  /*
   * WEBHOOKS
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider VARCHAR(50),
      event_type VARCHAR(150),
      external_event_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      processed BOOLEAN NOT NULL DEFAULT FALSE,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /*
   * Demande d'inscription / compatibilité avec l'ancien système.
   *
   * Cette table existe uniquement pour compatibilité technique.
   * Aucun code e-mail n'est envoyé.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registration_requests (
      id TEXT PRIMARY KEY,
      name VARCHAR(150),
      email VARCHAR(320),
      phone VARCHAR(50),
      country VARCHAR(100),
      dial_code VARCHAR(10),
      phone_international VARCHAR(50),
      password_hash TEXT,

      verified BOOLEAN NOT NULL DEFAULT TRUE,
      verification_token TEXT,

      plan VARCHAR(50) DEFAULT 'free',
      billing VARCHAR(30) DEFAULT 'monthly',

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /*
   * Index utiles.
   */
  await pool.query(`
    CREATE INDEX IF NOT EXISTS users_google_id_idx
    ON users (google_id)
    WHERE google_id IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS users_chariow_store_id_idx
    ON users (chariow_store_id)
    WHERE chariow_store_id IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS registration_requests_email_idx
    ON registration_requests (LOWER(TRIM(email)))
    WHERE email IS NOT NULL
  `);

  console.log('✅ Base PostgreSQL SellFlow initialisée.');
  return true;
}

module.exports = {
  initDatabase
};
