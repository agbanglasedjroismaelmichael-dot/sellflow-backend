const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL n’est pas configurée.');
    }

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false
    });
  }

  return pool;
}

async function testDatabaseConnection() {
  const db = getPool();

  const result = await db.query('SELECT NOW() AS now');

  return {
    connected: true,
    time: result.rows[0].now
  };
}

module.exports = {
  getPool,
  testDatabaseConnection
};
