const express = require('express');
const crypto = require('crypto');

const database = require('../config/database');
const { verifyToken } = require('../utils/auth');

const router = express.Router();

const CHARIOW_API_BASE =
  process.env.CHARIOW_API_BASE || 'https://api.chariow.com/v1';


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
// VÉRIFICATION RÉELLE CHARIOW
// =====================================================

async function verifyChariowApiKey(apiKey) {
  const response = await fetch(`${CHARIOW_API_BASE}/store`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  });

  let body = null;

  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }

  if (!response.ok) {
    const apiMessage =
      body && body.message
        ? body.message
        : 'La clé API Chariow est invalide ou inaccessible.';

    const error = new Error(apiMessage);
    error.status = response.status;
    error.chariow = body;

    throw error;
  }

  if (!body || !body.data) {
    throw new Error(
      'Chariow a répondu, mais les informations de la boutique sont absentes.'
    );
  }

  return {
    store: body.data,
    raw: body
  };
}


// =====================================================
// GET /chariow/stores
// Toutes les boutiques de l'utilisateur
// =====================================================

router.get('/stores', requireAuth, async (req, res) => {
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
      available_slots: Math.max(
        0,
        limit - storesResult.rows.length
      ),
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
// Une boutique précise
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
// AJOUTER UNE BOUTIQUE + VÉRIFIER LA CLÉ CHARIOW
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

    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        message: 'La clé API Chariow est obligatoire.'
      });
    }

    // -------------------------------------------------
    // VÉRIFICATION RÉELLE AUPRÈS DE CHARIOW
    // -------------------------------------------------

    let chariow;

    try {
      chariow = await verifyChariowApiKey(apiKey);
    } catch (error) {
      console.error(
        'Échec vérification clé Chariow:',
        error.message
      );

      return res.status(400).json({
        ok: false,
        code: 'CHARIOW_CONNECTION_FAILED',
        message:
          'Impossible de connecter cette boutique Chariow. Vérifiez que la clé API est correcte et active.'
      });
    }

    const remoteStore = chariow.store;

    const storeId = cleanString(
      remoteStore.id,
      255
    );

    const storeName = cleanString(
      remoteStore.name,
      255
    );

    const storeUrl = cleanString(
      remoteStore.url,
      1000
    );

    if (!storeId) {
      return res.status(400).json({
        ok: false,
        code: 'CHARIOW_STORE_ID_MISSING',
        message:
          'Chariow n’a pas retourné l’identifiant de la boutique.'
      });
    }

    if (!storeName) {
      return res.status(400).json({
        ok: false,
        code: 'CHARIOW_STORE_NAME_MISSING',
        message:
          'Chariow n’a pas retourné le nom de la boutique.'
      });
    }

    // -------------------------------------------------
    // EMPÊCHER LES DOUBLONS
    // -------------------------------------------------

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
        message:
          'Cette boutique Chariow est déjà connectée à votre compte.'
      });
    }

    const id = crypto.randomUUID();

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
        last_sync_at,
        last_sync_status,
        last_sync_error,
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
        'success',
        NULL,
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
        storeId,
        storeName,
        storeUrl || null,
        shouldBeActive
      ]
    );

    return res.status(201).json({
      ok: true,
      message:
        'Boutique Chariow vérifiée et connectée avec succès.',
      store: formatStore(result.rows[0])
    });
  } catch (error) {
    console.error('Erreur POST /chariow/stores:', error);

    return res.status(500).json({
      ok: false,
      message:
        'Impossible d’ajouter la boutique Chariow.',
      error: error.message
    });
  }
});


// =====================================================
// PUT /chariow/stores/:id
// MODIFIER UNE BOUTIQUE
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

    const currentStore = existing.rows[0];

    const apiKey =
      req.body.api_key !== undefined
        ? cleanString(req.body.api_key, 1000)
        : currentStore.api_key;

    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        message: 'La clé API Chariow est obligatoire.'
      });
    }

    // Si une nouvelle clé est fournie,
    // on la vérifie réellement.
    let remoteStore;

    try {
      const verification =
        await verifyChariowApiKey(apiKey);

      remoteStore = verification.store;
    } catch (error) {
      return res.status(400).json({
        ok: false,
        code: 'CHARIOW_CONNECTION_FAILED',
        message:
          'La nouvelle clé API Chariow n’a pas pu être vérifiée.'
      });
    }

    const storeId = cleanString(
      remoteStore.id,
      255
    );

    const storeName =
      req.body.store_name !== undefined
        ? cleanString(req.body.store_name, 255)
        : cleanString(remoteStore.name, 255);

    const storeUrl =
      req.body.store_url !== undefined
        ? cleanString(req.body.store_url, 1000)
        : cleanString(remoteStore.url, 1000);

    if (!storeId || !storeName) {
      return res.status(400).json({
        ok: false,
        message:
          'Les informations de la boutique retournées par Chariow sont incomplètes.'
      });
    }

    const duplicate = await db.query(
      `
      SELECT id
      FROM chariow_connections
      WHERE user_id = $1
        AND store_id = $2
        AND id <> $3
      LIMIT 1
      `,
      [
        req.user.sub,
        storeId,
        req.params.id
      ]
    );

    if (duplicate.rows.length) {
      return res.status(409).json({
        ok: false,
        message:
          'Cette boutique Chariow existe déjà sur votre compte.'
      });
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
        last_sync_at = NOW(),
        last_sync_status = 'success',
        last_sync_error = NULL,
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
        storeId,
        storeName,
        storeUrl || null,
        req.params.id,
        req.user.sub
      ]
    );

    return res.json({
      ok: true,
      message:
        'Boutique Chariow vérifiée et mise à jour.',
      store: formatStore(result.rows[0])
    });
  } catch (error) {
    console.error(
      'Erreur PUT /chariow/stores/:id:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'Impossible de modifier la boutique.',
      error: error.message
    });
  }
});


// =====================================================
// POST /chariow/stores/:id/activate
// CHOISIR LA BOUTIQUE ACTIVE
// =====================================================

router.post(
  '/stores/:id/activate',
  requireAuth,
  async (req, res) => {
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

      await db.query(
        `
        UPDATE chariow_connections
        SET
          active = FALSE,
          updated_at = NOW()
        WHERE user_id = $1
        `,
        [req.user.sub]
      );

      const result = await db.query(
        `
        UPDATE chariow_connections
        SET
          active = TRUE,
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
        [
          req.params.id,
          req.user.sub
        ]
      );

      await db.query('COMMIT');

      return res.json({
        ok: true,
        message:
          'Boutique active sélectionnée.',
        store: formatStore(result.rows[0])
      });
    } catch (error) {
      try {
        await db.query('ROLLBACK');
      } catch (_) {}

      console.error(
        'Erreur activation boutique:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de sélectionner cette boutique.',
        error: error.message
      });
    }
  }
);


// =====================================================
// GET /chariow/stores/active/current
// BOUTIQUE ACTIVE
// =====================================================

router.get(
  '/stores/active/current',
  requireAuth,
  async (req, res) => {
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
          message:
            'Aucune boutique active.'
        });
      }

      return res.json({
        ok: true,
        store: formatStore(result.rows[0])
      });
    } catch (error) {
      console.error(
        'Erreur boutique active:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de récupérer la boutique active.',
        error: error.message
      });
    }
  }
);


// =====================================================
// DELETE /chariow/stores/:id
// SUPPRIMER UNE BOUTIQUE
// =====================================================

router.delete(
  '/stores/:id',
  requireAuth,
  async (req, res) => {
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
        [
          req.params.id,
          req.user.sub
        ]
      );

      if (!storeResult.rows.length) {
        await db.query('ROLLBACK');

        return res.status(404).json({
          ok: false,
          message:
            'Boutique introuvable.'
        });
      }

      const deletedStore =
        storeResult.rows[0];

      await db.query(
        `
        DELETE FROM chariow_connections
        WHERE id = $1
          AND user_id = $2
        `,
        [
          req.params.id,
          req.user.sub
        ]
      );

      if (deletedStore.active) {
        await db.query(
          `
          UPDATE chariow_connections
          SET
            active = TRUE,
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
        message:
          'Boutique supprimée avec succès.'
      });
    } catch (error) {
      try {
        await db.query('ROLLBACK');
      } catch (_) {}

      console.error(
        'Erreur suppression boutique:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de supprimer la boutique.',
        error: error.message
      });
    }
  }
);


// =====================================================
// POST /chariow/stores/:id/sync-status
// SYNCHRONISATION RÉELLE
// =====================================================

router.post(
  '/stores/:id/sync-status',
  requireAuth,
  async (req, res) => {
    try {
      const db = database.getPool();

      const result = await db.query(
        `
        SELECT
          id,
          api_key
        FROM chariow_connections
        WHERE id = $1
          AND user_id = $2
        LIMIT 1
        `,
        [
          req.params.id,
          req.user.sub
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          message:
            'Boutique introuvable.'
        });
      }

      const store =
        result.rows[0];

      // Vérification réelle auprès de Chariow
      let verification;

      try {
        verification =
          await verifyChariowApiKey(
            store.api_key
          );
      } catch (error) {
        await db.query(
          `
          UPDATE chariow_connections
          SET
            connected = FALSE,
            last_sync_at = NOW(),
            last_sync_status = 'error',
            last_sync_error = $1,
            updated_at = NOW()
          WHERE id = $2
            AND user_id = $3
          `,
          [
            error.message,
            req.params.id,
            req.user.sub
          ]
        );

        return res.status(400).json({
          ok: false,
          code:
            'CHARIOW_SYNC_FAILED',
          message:
            'La synchronisation Chariow a échoué. La clé API peut être invalide ou révoquée.'
        });
      }

      const remoteStore =
        verification.store;

      const updated =
        await db.query(
          `
          UPDATE chariow_connections
          SET
            store_id = $1,
            store_name = $2,
            store_url = $3,
            connected = TRUE,
            last_sync_at = NOW(),
            last_sync_status = 'success',
            last_sync_error = NULL,
            updated_at = NOW()
          WHERE id = $4
            AND user_id = $5
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
            cleanString(
              remoteStore.id,
              255
            ),
            cleanString(
              remoteStore.name,
              255
            ),
            cleanString(
              remoteStore.url,
              1000
            ) || null,
            req.params.id,
            req.user.sub
          ]
        );

      return res.json({
        ok: true,
        message:
          'Boutique Chariow synchronisée avec succès.',
        store:
          formatStore(
            updated.rows[0]
          )
      });
    } catch (error) {
      console.error(
        'Erreur sync-status:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'Impossible de synchroniser la boutique.',
        error: error.message
      });
    }
  }
);


module.exports = router;
