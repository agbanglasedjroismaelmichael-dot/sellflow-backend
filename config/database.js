const DATABASE_URL = process.env.DATABASE_URL || null;

function getDatabaseConfig() {
  if (!DATABASE_URL) {
    return {
      configured: false,
      url: null
    };
  }

  return {
    configured: true,
    url: DATABASE_URL
  };
}

module.exports = {
  getDatabaseConfig
};
