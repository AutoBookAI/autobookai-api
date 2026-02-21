/**
 * Connected Apps — customers store credentials for apps their AI assistant can use.
 *
 * Credentials are AES-256 encrypted at rest using the per-customer key.
 * When the AI needs to use an app (via browser automation), it decrypts
 * the credentials at runtime.
 *
 * Mounted at /api/customer/apps (behind customerAuth middleware in server.js)
 */

const router = require('express').Router();
const { pool } = require('../db');
const { encryptJSON } = require('../services/encryption');

// GET /api/customer/apps — list connected apps (names only, no credentials)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT app_name, app_category, status, connected_at, last_used_at
       FROM connected_apps WHERE customer_id=$1 ORDER BY app_name`,
      [req.customerId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List connected apps error:', err);
    res.status(500).json({ error: 'Failed to list apps' });
  }
});

// GET /api/customer/apps/:appName/status — check if a specific app is connected
router.get('/:appName/status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT app_name, status FROM connected_apps
       WHERE customer_id=$1 AND app_name=$2`,
      [req.customerId, req.params.appName]
    );
    if (result.rows.length === 0) {
      return res.json({ app_name: req.params.appName, connected: false });
    }
    res.json({
      app_name: req.params.appName,
      connected: result.rows[0].status === 'connected',
      status: result.rows[0].status,
    });
  } catch (err) {
    console.error('App status error:', err);
    res.status(500).json({ error: 'Failed to check app status' });
  }
});

// Helper: extract credentials from request body (supports flat and nested formats)
function extractCredentials(body) {
  // Flat: { app_name, username, password }
  if (body.username && body.password) {
    return { username: body.username, password: body.password };
  }
  // Nested: { app_name, credentials: { username, password } }
  if (body.credentials && body.credentials.username && body.credentials.password) {
    return { username: body.credentials.username, password: body.credentials.password };
  }
  return null;
}

// POST /api/customer/apps/connect — connect an app (store encrypted credentials)
router.post('/connect', async (req, res) => {
  const { app_name, category } = req.body;
  const creds = extractCredentials(req.body);

  if (!app_name || !creds) {
    return res.status(400).json({ error: 'app_name, username, and password are required' });
  }

  try {
    const encrypted = encryptJSON(creds, req.customerId);

    const result = await pool.query(
      `INSERT INTO connected_apps (customer_id, app_name, app_category, credentials, status)
       VALUES ($1, $2, $3, $4, 'connected')
       ON CONFLICT (customer_id, app_name) DO UPDATE
         SET credentials=$4, app_category=COALESCE($3, connected_apps.app_category),
             status='connected', connected_at=NOW()
       RETURNING id`,
      [req.customerId, app_name, category || null, encrypted]
    );

    res.json({ success: true, app_name, status: 'connected', id: result.rows[0]?.id });
  } catch (err) {
    console.error('Connect app error:', err);
    res.status(500).json({ error: 'Failed to connect app' });
  }
});

// POST /api/customer/apps — backward-compatible connect endpoint
router.post('/', async (req, res) => {
  const { app_name, category } = req.body;
  const creds = extractCredentials(req.body);

  if (!app_name || !creds) {
    return res.status(400).json({ error: 'app_name, username, and password are required' });
  }

  try {
    const encrypted = encryptJSON(creds, req.customerId);

    const result = await pool.query(
      `INSERT INTO connected_apps (customer_id, app_name, app_category, credentials, status)
       VALUES ($1, $2, $3, $4, 'connected')
       ON CONFLICT (customer_id, app_name) DO UPDATE
         SET credentials=$4, app_category=COALESCE($3, connected_apps.app_category),
             status='connected', connected_at=NOW()
       RETURNING id`,
      [req.customerId, app_name, category || null, encrypted]
    );

    res.json({ success: true, app_name, status: 'connected', id: result.rows[0]?.id });
  } catch (err) {
    console.error('Connect app error:', err);
    res.status(500).json({ error: 'Failed to connect app' });
  }
});

// DELETE /api/customer/apps/:appName/disconnect — disconnect an app by name
router.delete('/:appName/disconnect', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM connected_apps WHERE customer_id=$1 AND app_name=$2',
      [req.customerId, req.params.appName]
    );
    res.json({ success: true, app_name: req.params.appName, status: 'disconnected' });
  } catch (err) {
    console.error('Disconnect app error:', err);
    res.status(500).json({ error: 'Failed to disconnect app' });
  }
});

// DELETE /api/customer/apps/:appName — backward-compatible disconnect (by name or id)
router.delete('/:appName', async (req, res) => {
  try {
    const param = req.params.appName;
    // If numeric, treat as record ID; otherwise as app_name
    if (/^\d+$/.test(param)) {
      await pool.query(
        'DELETE FROM connected_apps WHERE customer_id=$1 AND id=$2',
        [req.customerId, parseInt(param)]
      );
    } else {
      await pool.query(
        'DELETE FROM connected_apps WHERE customer_id=$1 AND app_name=$2',
        [req.customerId, param]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect app error:', err);
    res.status(500).json({ error: 'Failed to disconnect app' });
  }
});

module.exports = router;
