const { Pool } = require('pg');

let pool = null;

/**
 * ============================================================
 * SELLFLOW AI — DATABASE
 * ============================================================
 */

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL n’est pas configurée.'
      );
    }

    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL,

      ssl:
        process.env.NODE_ENV === 'production'
          ? {
              rejectUnauthorized: false
            }
          : false,

      max:
        Number(
          process.env.DB_POOL_MAX
        ) || 10,

      idleTimeoutMillis:
        Number(
          process.env.DB_IDLE_TIMEOUT_MS
        ) || 30000,

      connectionTimeoutMillis:
        Number(
          process.env.DB_CONNECTION_TIMEOUT_MS
        ) || 10000
    });

    /**
     * Éviter qu'une erreur PostgreSQL sur une
     * connexion inactive fasse planter silencieusement
     * le processus.
     */
    pool.on('error', (error) => {
      console.error(
        '❌ Erreur PostgreSQL sur le pool:',
        error
      );
    });
  }

  return pool;
}


/**
 * ============================================================
 * TEST DE CONNEXION
 * ============================================================
 */

async function testDatabaseConnection() {
  const db = getPool();

  const result = await db.query(
    'SELECT NOW() AS now'
  );

  return {
    connected: true,
    time: result.rows[0].now
  };
}


/**
 * ============================================================
 * FERMER LA CONNEXION
 * ============================================================
 *
 * Utile pour les tests ou lors de l'arrêt propre
 * du serveur.
 */

async function closeDatabaseConnection() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}


/**
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
  getPool,
  testDatabaseConnection,
  closeDatabaseConnection
};
