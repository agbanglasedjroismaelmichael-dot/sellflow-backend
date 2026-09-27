const express = require('express');
const crypto = require('crypto');

const database = require('../config/database');
const { verifyToken } = require('../utils/auth');

const router = express.Router();


// =====================================================
// AUTHENTIFICATION
// =====================================================

function requireAuth(req, res, next) {
  try {
    const authorization = req.headers.authorization || '';

    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        message: 'Token manquant.'
      });
    }

    const token = authorization.substring(7);
    const decoded = verifyToken(token);

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: 'Session invalide ou expirée.'
    });
  }
}


// =====================================================
// LIMITES MULTIBOUTIQUES
// =====================================================

function getStoreLimit(plan) {
  const normalizedPlan = String(plan || 'free').toLowerCase();

  switch (normalizedPlan) {
    case 'starter':
      return 1;

    case 'pro':
      return 3;

    case 'business':
      return 10;

    default:
      return 1;
  }
}


// =====================================================
// UTILITAIRES
// =====================================================

function cleanString(value, maxLength = 500) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim().substring(0, maxLength);
}


function maskApiKey(apiKey) {
  if (!apiKey) {
    return null;
  }

  if (apiKey.length <= 8) {
    return '********';
  }

  return (
    apiKey.substring(0, 4) +
    '********' +
    apiKey.substring(apiKey.length - 4)
  );
}


function formatStore(row) {
  return {
    id: row.id,
    store_id: row.store_id,
    store_name: row.store_name,
    store_url: row.store_url,
    connected: row.connected,
    active: row.active,
    api_key: maskApiKey(row.api_key),
    last_sync_at: row.last_sync_at,
    last_sync_status: row.last_sync_status,
    last_sync_error: row.last_sync_error,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}


// =====================================================
// GET /chariow/stores
// Récupérer toutes les boutiques de l'utilisateur
// =====================================================

router.get('/stores', requireAuth, async (req, res) => {
  try {
    const db = database.getPool();

    const userResult = await db.query(
      `
      SELECT id, plan, subscription_status, subscription_expires_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [req.user.sub]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({
        ok: false,
        message: 'Utilisateur introuvable.'
      });
    }

    const user = userResult.rows[0];

    const storesResult = await db.query(
      `
      SELECT
        id,
        store_id,
        store_name,
        store_url,
        api_key,
        connected,
        active,
        last_sync_at,
        last_sync_status,
        last_sync_error,
        created_at,
        updated_at
      FROM chariow_connections
      WHERE user_id = $1
      ORDER BY active DESC, created_at ASC
      `,
      [req.user.sub]
    );

    const limit = getStoreLimit(user.plan);

    return res.json({
      ok: true,
      plan: user.plan || 'free',
      subscription_status: user.subscription_status || 'inactive',
      subscription_expires_at: user.subscription_expires_at,
      limit,
      count: storesResult.rows.length,
      available_slots: Math.max(0, limit - storesResult.rows.length),
      stores: storesResult.rows.map(formatStore)
    });

  } catch (error) {
    console.error('Erreur GET /chariow/stores:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible de récupérer les boutiques Chariow.',
      error: error.message
    });
  }
});


// =====================================================
// GET /chariow/stores/:id
// Récupérer une boutique précise
// =====================================================

router.get('/stores/:id', requireAuth, async (req, res) => {
  try {
    const db = database.getPool();

    const result = await db.query(
      `
      SELECT
        id,
        store_id,
        store_name,
        store_url,
        api_key,
        connected,
        active,
        last_sync_at,
        last_sync_status,
        last_sync_error,
        created_at,
        updated_at
      FROM chariow_connections
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [req.params.id, req.user.sub]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        message: 'Boutique introuvable.'
      });
    }

    return res.json({
      ok: true,
      store: formatStore(result.rows[0])
    });

  } catch (error) {
    console.error('Erreur GET /chariow/stores/:id:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible de récupérer la boutique.',
      error: error.message
    });
  }
});


// =====================================================
// POST /chariow/stores
// Ajouter une nouvelle boutique
// =====================================================

router.post('/stores', requireAuth, async (req, res) => {
  try {
    const db = database.getPool();

    const userResult = await db.query(
      `
      SELECT
        id,
        plan,
        subscription_status,
        subscription_expires_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [req.user.sub]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({
        ok: false,
        message: 'Utilisateur introuvable.'
      });
    }

    const user = userResult.rows[0];

    const limit = getStoreLimit(user.plan);

    const countResult = await db.query(
      `
      SELECT COUNT(*)::integer AS count
      FROM chariow_connections
      WHERE user_id = $1
      `,
      [req.user.sub]
    );

    const currentCount = countResult.rows[0].count;

    if (currentCount >= limit) {
      return res.status(403).json({
        ok: false,
        code: 'STORE_LIMIT_REACHED',
        message:
          `Votre plan ${user.plan || 'free'} autorise au maximum ${limit} boutique(s).`,
        plan: user.plan || 'free',
        limit,
        count: currentCount
      });
    }

    const apiKey = cleanString(req.body.api_key, 1000);
    const storeId = cleanString(req.body.store_id, 255);
    const storeName = cleanString(req.body.store_name, 255);
    const storeUrl = cleanString(req.body.store_url, 1000);

    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        message: 'La clé API Chariow est obligatoire.'
      });
    }

    if (!storeName) {
      return res.status(400).json({
        ok: false,
        message: 'Le nom de la boutique est obligatoire.'
      });
    }

    // Empêcher deux fois exactement la même boutique
    if (storeId) {
      const existing = await db.query(
        `
        SELECT id
        FROM chariow_connections
        WHERE user_id = $1
          AND store_id = $2
        LIMIT 1
        `,
        [req.user.sub, storeId]
      );

      if (existing.rows.length) {
        return res.status(409).json({
          ok: false,
          code: 'STORE_ALREADY_EXISTS',
          message: 'Cette boutique Chariow est déjà connectée à votre compte.'
        });
      }
    }

    const id = crypto.randomUUID();

    // Première boutique = automatiquement active
    const shouldBeActive = currentCount === 0;

    const result = await db.query(
      `
      INSERT INTO chariow_connections (
        id,
        user_id,
        api_key,
        store_id,
        store_name,
        store_url,
        connected,
        active,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        TRUE,
        $7,
        NOW(),
        NOW()
      )
      RETURNING
        id,
        store_id,
        store_name,
        store_url,
        api_key,
        connected,
        active,
        last_sync_at,
        last_sync_status,
        last_sync_error,
        created_at,
        updated_at
      `,
      [
        id,
        req.user.sub,
        apiKey,
        storeId || null,
        storeName,
        storeUrl || null,
        shouldBeActive
      ]
    );

    return res.status(201).json({
      ok: true,
      message: 'Boutique Chariow ajoutée avec succès.',
      store: formatStore(result.rows[0])
    });

  } catch (error) {
    console.error('Erreur POST /chariow/stores:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible d’ajouter la boutique Chariow.',
      error: error.message
    });
  }
});


// =====================================================
// PUT /chariow/stores/:id
// Modifier une boutique
// =====================================================

router.put('/stores/:id', requireAuth, async (req, res) => {
  try {
    const db = database.getPool();

    const existing = await db.query(
      `
      SELECT *
      FROM chariow_connections
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [req.params.id, req.user.sub]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        ok: false,
        message: 'Boutique introuvable.'
      });
    }

    const store = existing.rows[0];

    const apiKey =
      req.body.api_key !== undefined
        ? cleanString(req.body.api_key, 1000)
        : store.api_key;

    const storeId =
      req.body.store_id !== undefined
        ? cleanString(req.body.store_id, 255)
        : store.store_id;

    const storeName =
      req.body.store_name !== undefined
        ? cleanString(req.body.store_name, 255)
        : store.store_name;

    const storeUrl =
      req.body.store_url !== undefined
        ? cleanString(req.body.store_url, 1000)
        : store.store_url;

    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        message: 'La clé API Chariow est obligatoire.'
      });
    }

    if (!storeName) {
      return res.status(400).json({
        ok: false,
        message: 'Le nom de la boutique est obligatoire.'
      });
    }

    if (storeId) {
      const duplicate = await db.query(
        `
        SELECT id
        FROM chariow_connections
        WHERE user_id = $1
          AND store_id = $2
          AND id <> $3
        LIMIT 1
        `,
        [req.user.sub, storeId, req.params.id]
      );

      if (duplicate.rows.length) {
        return res.status(409).json({
          ok: false,
          message: 'Cette boutique existe déjà sur votre compte.'
        });
      }
    }

    const result = await db.query(
      `
      UPDATE chariow_connections
      SET
        api_key = $1,
        store_id = $2,
        store_name = $3,
        store_url = $4,
        connected = TRUE,
        updated_at = NOW()
      WHERE id = $5
        AND user_id = $6
      RETURNING
        id,
        store_id,
        store_name,
        store_url,
        api_key,
        connected,
        active,
        last_sync_at,
        last_sync_status,
        last_sync_error,
        created_at,
        updated_at
      `,
      [
        apiKey,
        storeId || null,
        storeName,
        storeUrl || null,
        req.params.id,
        req.user.sub
      ]
    );

    return res.json({
      ok: true,
      message: 'Boutique mise à jour.',
      store: formatStore(result.rows[0])
    });

  } catch (error) {
    console.error('Erreur PUT /chariow/stores/:id:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible de modifier la boutique.',
      error: error.message
    });
  }
});


// =====================================================
// POST /chariow/stores/:id/activate
// Choisir la boutique active
// =====================================================

router.post('/stores/:id/activate', requireAuth, async (req, res) => {
  const db = database.getPool();

  try {
    await db.query('BEGIN');

    const storeResult = await db.query(
      `
      SELECT *
      FROM chariow_connections
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [req.params.id, req.user.sub]
    );

    if (!storeResult.rows.length) {
      await db.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        message: 'Boutique introuvable.'
      });
    }

    // Une seule boutique active par utilisateur
    await db.query(
      `
      UPDATE chariow_connections
      SET active = FALSE,
          updated_at = NOW()
      WHERE user_id = $1
      `,
      [req.user.sub]
    );

    const result = await db.query(
      `
      UPDATE chariow_connections
      SET active = TRUE,
          updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
      RETURNING
        id,
        store_id,
        store_name,
        store_url,
        api_key,
        connected,
        active,
        last_sync_at,
        last_sync_status,
        last_sync_error,
        created_at,
        updated_at
      `,
      [req.params.id, req.user.sub]
    );

    await db.query('COMMIT');

    return res.json({
      ok: true,
      message: 'Boutique active sélectionnée.',
      store: formatStore(result.rows[0])
    });

  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch (_) {}

    console.error('Erreur activation boutique:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible de sélectionner cette boutique.',
      error: error.message
    });
  }
});


// =====================================================
// GET /chariow/stores/active/current
// Boutique actuellement active
// =====================================================

router.get('/stores/active/current', requireAuth, async (req, res) => {
  try {
    const db = database.getPool();

    const result = await db.query(
      `
      SELECT
        id,
        store_id,
        store_name,
        store_url,
        api_key,
        connected,
        active,
        last_sync_at,
        last_sync_status,
        last_sync_error,
        created_at,
        updated_at
      FROM chariow_connections
      WHERE user_id = $1
        AND active = TRUE
      LIMIT 1
      `,
      [req.user.sub]
    );

    if (!result.rows.length) {
      return res.json({
        ok: true,
        store: null,
        message: 'Aucune boutique active.'
      });
    }

    return res.json({
      ok: true,
      store: formatStore(result.rows[0])
    });

  } catch (error) {
    console.error('Erreur boutique active:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible de récupérer la boutique active.',
      error: error.message
    });
  }
});


// =====================================================
// DELETE /chariow/stores/:id
// Supprimer une boutique
// =====================================================

router.delete('/stores/:id', requireAuth, async (req, res) => {
  const db = database.getPool();

  try {
    await db.query('BEGIN');

    const storeResult = await db.query(
      `
      SELECT *
      FROM chariow_connections
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [req.params.id, req.user.sub]
    );

    if (!storeResult.rows.length) {
      await db.query('ROLLBACK');

      return res.status(404).json({
        ok: false,
        message: 'Boutique introuvable.'
      });
    }

    const deletedStore = storeResult.rows[0];

    await db.query(
      `
      DELETE FROM chariow_connections
      WHERE id = $1
        AND user_id = $2
      `,
      [req.params.id, req.user.sub]
    );

    // Si la boutique supprimée était active,
    // on active automatiquement la première restante.
    if (deletedStore.active) {
      await db.query(
        `
        UPDATE chariow_connections
        SET active = TRUE,
            updated_at = NOW()
        WHERE id = (
          SELECT id
          FROM chariow_connections
          WHERE user_id = $1
          ORDER BY created_at ASC
          LIMIT 1
        )
        `,
        [req.user.sub]
      );
    }

    await db.query('COMMIT');

    return res.json({
      ok: true,
      message: 'Boutique supprimée avec succès.'
    });

  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch (_) {}

    console.error('Erreur suppression boutique:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible de supprimer la boutique.',
      error: error.message
    });
  }
});


// =====================================================
// POST /chariow/stores/:id/sync-status
// Mettre à jour l'état de synchronisation
// =====================================================

router.post('/stores/:id/sync-status', requireAuth, async (req, res) => {
  try {
    const db = database.getPool();

    const status = cleanString(req.body.status, 50) || 'success';
    const errorMessage = cleanString(req.body.error, 2000);

    const result = await db.query(
      `
      UPDATE chariow_connections
      SET
        last_sync_at = NOW(),
        last_sync_status = $1,
        last_sync_error = $2,
        updated_at = NOW()
      WHERE id = $3
        AND user_id = $4
      RETURNING
        id,
        store_id,
        store_name,
        connected,
        active,
        last_sync_at,
        last_sync_status,
        last_sync_error
      `,
      [
        status,
        errorMessage || null,
        req.params.id,
        req.user.sub
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        message: 'Boutique introuvable.'
      });
    }

    return res.json({
      ok: true,
      store: result.rows[0]
    });

  } catch (error) {
    console.error('Erreur sync-status:', error);

    return res.status(500).json({
      ok: false,
      message: 'Impossible de mettre à jour la synchronisation.',
      error: error.message
    });
  }
});


module.exports = router;
