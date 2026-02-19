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
const { encryptJSON, decryptJSON } = require('../services/encryption');

// GET /api/customer/apps — list connected apps (names only, no credentials)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT app_name, connected_at FROM connected_apps WHERE customer_id=$1 ORDER BY app_name',
      [req.customerId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List connected apps error:', err);
    res.status(500).json({ error: 'Failed to list apps' });
  }
});

// POST /api/customer/apps — connect an app (store encrypted credentials)
router.post('/', async (req, res) => {
  const { app_name, username, password } = req.body;
  if (!app_name || !username || !password) {
    return res.status(400).json({ error: 'app_name, username, and password are required' });
  }

  try {
    const encrypted = encryptJSON({ username, password }, req.customerId);

    await pool.query(
      `INSERT INTO connected_apps (customer_id, app_name, credentials)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, app_name) DO UPDATE SET credentials=$3, connected_at=NOW()`,
      [req.customerId, app_name, encrypted]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Connect app error:', err);
    res.status(500).json({ error: 'Failed to connect app' });
  }
});

// DELETE /api/customer/apps/:app_name — disconnect an app
router.delete('/:app_name', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM connected_apps WHERE customer_id=$1 AND app_name=$2',
      [req.customerId, req.params.app_name]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Disconnect app error:', err);
    res.status(500).json({ error: 'Failed to disconnect app' });
  }
});

module.exports = router;
