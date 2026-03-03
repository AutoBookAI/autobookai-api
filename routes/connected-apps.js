/**
 * Connected Apps — customers store credentials for apps their AI assistant can use.
 *
 * Credentials are AES-256 encrypted at rest using the per-customer key.
 * When the AI needs to use an app (via browser automation), it decrypts
 * the credentials at runtime.
 *
 * On connect, credentials are verified via OpenClaw (headless browser login).
 * If OpenClaw is unavailable, credentials are stored with status 'unverified'.
 *
 * Mounted at /api/customer/apps (behind customerAuth middleware in server.js)
 */

const router = require('express').Router();
const { pool } = require('../db');
const { encryptJSON } = require('../services/encryption');

const OPENCLAW_URL = process.env.OPENCLAW_URL;

// Login page URLs for credential verification
const LOGIN_URLS = {
  'ubereats':   'https://auth.uber.com/v2/',
  'uber':       'https://auth.uber.com/v2/',
  'doordash':   'https://identity.doordash.com/auth/user/login',
  'instacart':  'https://www.instacart.com/login',
  'amazon':     'https://www.amazon.com/ap/signin',
  'opentable':  'https://www.opentable.com/sign-in',
  'resy':       'https://resy.com/login',
};

/**
 * Verify credentials via OpenClaw headless browser.
 * Returns { verified: true/false, error?: string }
 */
async function verifyCredentials(appName, creds, loginUrl) {
  if (!OPENCLAW_URL) return { verified: null, error: 'unavailable' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    const response = await fetch(`${OPENCLAW_URL}/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Go to ${loginUrl} and try to log in with username/email "${creds.username}" and password "${creds.password}". After attempting login, report ONLY whether the login was successful or failed. If you see a dashboard, home page, account page, or any post-login content, respond with exactly "LOGIN_SUCCESS". If you see an error message like "invalid credentials", "incorrect password", "account not found", or the login form reappears with an error, respond with exactly "LOGIN_FAILED" followed by the error message. Do not navigate anywhere else after the login attempt.`,
        timeout: 40,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[VERIFY-CREDS] OpenClaw HTTP ${response.status}`);
      return { verified: null, error: 'unavailable' };
    }

    const data = await response.json();
    const result = (data.response || '').trim();

    if (result.includes('LOGIN_SUCCESS')) {
      return { verified: true };
    } else if (result.includes('LOGIN_FAILED')) {
      const errorMsg = result.replace('LOGIN_FAILED', '').trim();
      return { verified: false, error: errorMsg || 'Invalid credentials' };
    } else {
      // Ambiguous result — check for common success/failure indicators
      const lower = result.toLowerCase();
      if (lower.includes('successfully logged in') || lower.includes('login successful') || lower.includes('welcome') || lower.includes('dashboard')) {
        return { verified: true };
      }
      if (lower.includes('invalid') || lower.includes('incorrect') || lower.includes('wrong password') || lower.includes('not found') || lower.includes('failed to log in') || lower.includes('authentication failed')) {
        return { verified: false, error: 'Invalid credentials — login failed' };
      }
      // Truly ambiguous — treat as unverifiable
      console.log(`[VERIFY-CREDS] Ambiguous result for ${appName}: ${result.slice(0, 200)}`);
      return { verified: null, error: 'Could not determine login result' };
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[VERIFY-CREDS] Timeout verifying ${appName}`);
      return { verified: null, error: 'Verification timed out' };
    }
    console.error(`[VERIFY-CREDS] Error verifying ${appName}:`, err.message);
    return { verified: null, error: 'unavailable' };
  }
}

// GET /api/customer/apps — list connected apps (names only, no credentials)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT app_name, app_category, auth_type, status, connected_at, last_used_at
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
      connected: result.rows[0].status === 'connected' || result.rows[0].status === 'unverified',
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

/**
 * Core connect logic shared by both endpoints.
 * Verifies credentials via OpenClaw if a login URL is known,
 * then stores encrypted credentials.
 */
async function handleConnect(req, res) {
  const { app_name, category } = req.body;
  const creds = extractCredentials(req.body);

  if (!app_name || !creds) {
    return res.status(400).json({ error: 'app_name, username, and password are required' });
  }

  try {
    // Check if we have a login URL for this app
    const appKey = app_name.toLowerCase().replace(/[\s_-]+/g, '');
    const loginUrl = LOGIN_URLS[appKey];

    let status = 'connected';

    if (loginUrl) {
      // Verify credentials via OpenClaw
      console.log(`[CONNECT-APP] Verifying credentials for ${app_name} at ${loginUrl}`);
      const verification = await verifyCredentials(app_name, creds, loginUrl);

      if (verification.verified === false) {
        // Login failed — do NOT store credentials
        console.log(`[CONNECT-APP] Verification FAILED for ${app_name}: ${verification.error}`);
        return res.status(401).json({
          error: `Login failed for ${app_name}: ${verification.error}`,
          verified: false,
        });
      } else if (verification.verified === true) {
        console.log(`[CONNECT-APP] Verification SUCCESS for ${app_name}`);
        status = 'connected';
      } else {
        // OpenClaw unavailable or ambiguous — store as unverified
        console.log(`[CONNECT-APP] Could not verify ${app_name}: ${verification.error}`);
        status = 'unverified';
      }
    } else if (OPENCLAW_URL) {
      // No login URL mapped — store as unverified (can't verify)
      status = 'unverified';
    }

    const encrypted = encryptJSON(creds, req.customerId);

    const result = await pool.query(
      `INSERT INTO connected_apps (customer_id, app_name, app_category, credentials, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (customer_id, app_name) DO UPDATE
         SET credentials=$4, app_category=COALESCE($3, connected_apps.app_category),
             status=$5, connected_at=NOW()
       RETURNING id`,
      [req.customerId, app_name, category || null, encrypted, status]
    );

    res.json({ success: true, app_name, status, id: result.rows[0]?.id });
  } catch (err) {
    console.error('Connect app error:', err);
    res.status(500).json({ error: 'Failed to connect app' });
  }
}

// POST /api/customer/apps/connect — connect an app (verify + store encrypted credentials)
router.post('/connect', handleConnect);

// POST /api/customer/apps/connect-cookies — connect an app using exported browser cookies
router.post('/connect-cookies', async (req, res) => {
  const { app_name, category, cookies } = req.body;
  if (!app_name || !cookies) {
    return res.status(400).json({ error: 'app_name and cookies are required' });
  }

  try {
    // Encrypt cookies the same way we encrypt credentials
    const encrypted = encryptJSON({ cookies }, req.customerId);

    const result = await pool.query(
      `INSERT INTO connected_apps (customer_id, app_name, app_category, credentials, auth_type, status)
       VALUES ($1, $2, $3, $4, 'cookies', 'connected')
       ON CONFLICT (customer_id, app_name) DO UPDATE
         SET credentials=$4, auth_type='cookies', app_category=COALESCE($3, connected_apps.app_category),
             status='connected', connected_at=NOW()
       RETURNING id`,
      [req.customerId, app_name, category || null, encrypted]
    );

    res.json({ success: true, app_name, status: 'connected', auth_type: 'cookies', id: result.rows[0]?.id });
  } catch (err) {
    console.error('Connect app cookies error:', err);
    res.status(500).json({ error: 'Failed to connect app' });
  }
});

// POST /api/customer/apps — backward-compatible connect endpoint
router.post('/', handleConnect);

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
