```javascript
const { getPool } = require('../config/database');

async function initDatabase() {
  const db = getPool();

  // =====================================================
  // EXTENSION UUID / CRYPTO
  // =====================================================

  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  `);

  // =====================================================
  // TABLE USERS
  // =====================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,

      name VARCHAR(120) NOT NULL,

      email VARCHAR(255) NOT NULL,

      phone VARCHAR(30),

      country VARCHAR(100),

      password_hash TEXT,

      email_verified BOOLEAN NOT NULL DEFAULT FALSE,

      plan VARCHAR(50) NOT NULL DEFAULT 'free',

      subscription_status VARCHAR(30)
        NOT NULL DEFAULT 'inactive',

      subscription_started_at TIMESTAMPTZ,

      subscription_expires_at TIMESTAMPTZ,

      reminder_7_sent_at TIMESTAMPTZ,

      reminder_3_sent_at TIMESTAMPTZ,

      reminder_1_sent_at TIMESTAMPTZ,

      expired_notice_sent_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  // =====================================================
  // COMPATIBILITÉ USERS
  // =====================================================

  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS name
        VARCHAR(120);

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS phone
        VARCHAR(30);

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS country
        VARCHAR(100);

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hash
        TEXT;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verified
        BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS plan
        VARCHAR(50) NOT NULL DEFAULT 'free';

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS subscription_status
        VARCHAR(30) NOT NULL DEFAULT 'inactive';

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS subscription_started_at
        TIMESTAMPTZ;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS subscription_expires_at
        TIMESTAMPTZ;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS reminder_7_sent_at
        TIMESTAMPTZ;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS reminder_3_sent_at
        TIMESTAMPTZ;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS reminder_1_sent_at
        TIMESTAMPTZ;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS expired_notice_sent_at
        TIMESTAMPTZ;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS created_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW();

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS updated_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  // =====================================================
  // NORMALISATION DES EMAILS EXISTANTS
  // =====================================================
  //
  // Tous les anciens emails sont normalisés :
  //
  // " Test@Gmail.com "
  //
  // devient :
  //
  // "test@gmail.com"
  //
  // ATTENTION :
  // si deux comptes existants possèdent le même email
  // après normalisation, l'index unique ci-dessous
  // sera volontairement bloqué afin de ne supprimer
  // aucun compte automatiquement.
  // =====================================================

  await db.query(`
    UPDATE users
    SET email = LOWER(TRIM(email))
    WHERE email <> LOWER(TRIM(email));
  `);

  // =====================================================
  // EMAIL VERIFICATION
  // =====================================================
  //
  // Cette table est conservée pour compatibilité avec
  // l'ancienne version de SellFlow.
  //
  // L'inscription actuelle NE l'utilise plus.
  // Resend n'est plus utilisé.
  // =====================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id UUID PRIMARY KEY,

      user_id UUID
        REFERENCES users(id)
        ON DELETE CASCADE,

      email VARCHAR(255) NOT NULL,

      code VARCHAR(10) NOT NULL,

      expires_at TIMESTAMPTZ NOT NULL,

      attempts INTEGER NOT NULL DEFAULT 0,

      used BOOLEAN NOT NULL DEFAULT FALSE,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  // =====================================================
  // REGISTRATION REQUESTS
  // =====================================================
  //
  // Conservée pour compatibilité avec l'ancienne
  // architecture.
  //
  // La nouvelle inscription directe n'utilise plus
  // cette table.
  // =====================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS registration_requests (
      id UUID PRIMARY KEY,

      name VARCHAR(120) NOT NULL,

      email VARCHAR(255) NOT NULL,

      phone VARCHAR(30) NOT NULL,

      country VARCHAR(100) NOT NULL,

      code_hash TEXT NOT NULL,

      expires_at TIMESTAMPTZ NOT NULL,

      attempts INTEGER NOT NULL DEFAULT 0,

      verified BOOLEAN NOT NULL DEFAULT FALSE,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  // =====================================================
  // SESSIONS
  // =====================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY,

      user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      token_hash TEXT NOT NULL,

      expires_at TIMESTAMPTZ NOT NULL,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  // =====================================================
  // PAYMENTS
  // =====================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

      user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      provider VARCHAR(50) NOT NULL
        DEFAULT 'moneroo',

      provider_reference VARCHAR(255),

      plan VARCHAR(50) NOT NULL,

      billing_cycle VARCHAR(20) NOT NULL
        DEFAULT 'monthly',

      amount NUMERIC(12,2) NOT NULL,

      currency VARCHAR(10) NOT NULL
        DEFAULT 'XOF',

      status VARCHAR(50) NOT NULL
        DEFAULT 'pending',

      checkout_url TEXT,

      paid_at TIMESTAMPTZ,

      failure_reason TEXT,

      metadata JSONB NOT NULL
        DEFAULT '{}'::jsonb,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  // =====================================================
  // COMPATIBILITÉ PAYMENTS
  // =====================================================

  await db.query(`
    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS provider
        VARCHAR(50) NOT NULL DEFAULT 'moneroo';

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS provider_reference
        VARCHAR(255);

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS billing_cycle
        VARCHAR(20) NOT NULL DEFAULT 'monthly';

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS checkout_url
        TEXT;

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS paid_at
        TIMESTAMPTZ;

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS failure_reason
        TEXT;

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS metadata
        JSONB DEFAULT '{}'::jsonb;

    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS updated_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW();

    ALTER TABLE payments
      ALTER COLUMN id
        SET DEFAULT gen_random_uuid();

    UPDATE payments
    SET metadata = '{}'::jsonb
    WHERE metadata IS NULL;

    ALTER TABLE payments
      ALTER COLUMN metadata
        SET DEFAULT '{}'::jsonb;

    ALTER TABLE payments
      ALTER COLUMN metadata
        SET NOT NULL;
  `);

  // =====================================================
  // CHARIOW MULTI-BOUTIQUES
  // =====================================================

  await db.query(`
    CREATE TABLE IF NOT EXISTS chariow_connections (
      id UUID PRIMARY KEY,

      user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

      api_key TEXT NOT NULL,

      store_id VARCHAR(255),

      store_name VARCHAR(255),

      store_url TEXT,

      connected BOOLEAN NOT NULL DEFAULT FALSE,

      active BOOLEAN NOT NULL DEFAULT FALSE,

      last_sync_at TIMESTAMPTZ,

      last_sync_status VARCHAR(50),

      last_sync_error TEXT,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);

  // =====================================================
  // COMPATIBILITÉ CHARIOW
  // =====================================================

  await db.query(`
    ALTER TABLE chariow_connections
      ADD COLUMN IF NOT EXISTS active
        BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE chariow_connections
      ADD COLUMN IF NOT EXISTS last_sync_at
        TIMESTAMPTZ;

    ALTER TABLE chariow_connections
      ADD COLUMN IF NOT EXISTS last_sync_status
        VARCHAR(50);

    ALTER TABLE chariow_connections
      ADD COLUMN IF NOT EXISTS last_sync_error
        TEXT;

    ALTER TABLE chariow_connections
      ADD COLUMN IF NOT EXISTS updated_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  // =====================================================
  // INDEX
  // =====================================================

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_users_email
      ON users(email);

    CREATE INDEX IF NOT EXISTS idx_verification_email
      ON email_verification_codes(email);

    CREATE INDEX IF NOT EXISTS idx_registration_requests_email
      ON registration_requests(email);

    CREATE INDEX IF NOT EXISTS idx_sessions_user
      ON sessions(user_id);

    CREATE INDEX IF NOT EXISTS idx_payments_user
      ON payments(user_id);

    CREATE INDEX IF NOT EXISTS idx_payments_status
      ON payments(status);

    CREATE INDEX IF NOT EXISTS idx_payments_provider_reference
      ON payments(provider_reference);

    CREATE INDEX IF NOT EXISTS idx_payments_created_at
      ON payments(created_at);

    CREATE INDEX IF NOT EXISTS idx_payments_user_status
      ON payments(user_id, status);

    CREATE INDEX IF NOT EXISTS idx_chariow_user
      ON chariow_connections(user_id);

    CREATE INDEX IF NOT EXISTS idx_chariow_active
      ON chariow_connections(user_id, active);

    CREATE INDEX IF NOT EXISTS idx_users_subscription_expiry
      ON users(subscription_expires_at);
  `);

  // =====================================================
  // UNICITÉ RÉELLE DES EMAILS
  // =====================================================
  //
  // Un seul compte par adresse e-mail.
  //
  // Les variantes suivantes sont considérées comme
  // identiques :
  //
  // Test@Email.com
  // test@email.com
  //  TEST@EMAIL.COM
  // test@email.com
  //
  // PostgreSQL bloquera donc le deuxième compte.
  // =====================================================

  try {

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
        ON users (LOWER(TRIM(email)));
    `);

  } catch (error) {

    if (error && error.code === '23505') {

      console.error('');
      console.error(
        '===================================================='
      );
      console.error(
        '❌ DOUBLON D''EMAIL DÉTECTÉ DANS LA BASE'
      );
      console.error(
        '===================================================='
      );
      console.error(
        'Deux comptes existants utilisent la même adresse'
      );
      console.error(
        'après normalisation majuscules/espaces.'
      );
      console.error('');
      console.error(
        'Aucun compte n''a été supprimé automatiquement.'
      );
      console.error(
        'Il faut identifier les doublons avant de créer'
      );
      console.error(
        'l''index unique.'
      );
      console.error(
        '===================================================='
      );
      console.error('');

    }

    throw error;
  }

  // =====================================================
  // INDEX UNIQUE NORMAL SUR EMAIL
  // =====================================================
  //
  // La colonne email était déjà UNIQUE dans les anciennes
  // versions de la base.
  //
  // L'index fonctionnel ci-dessus ajoute la protection
  // contre les différences de casse et d'espaces.
  // =====================================================

  console.log(
    '=============================================='
  );

  console.log(
    '✅ Base de données SellFlow initialisée.'
  );

  console.log(
    '✅ Unicité des emails activée.'
  );

  console.log(
    '✅ Emails normalisés automatiquement.'
  );

  console.log(
    '✅ Vérification email désactivée.'
  );

  console.log(
    '✅ Resend non utilisé.'
  );

  console.log(
    '=============================================='
  );
}

module.exports = {
  initDatabase
};
```
