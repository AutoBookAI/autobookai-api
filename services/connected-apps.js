/**
 * Connected Apps service — internal functions for credential lookup.
 *
 * Used by the AI assistant (assistant.js) and OpenClaw integration
 * (whatsapp-webhook.js) to retrieve decrypted credentials at runtime.
 */

const { pool } = require('../db');
const { decryptJSON } = require('./encryption');

/**
 * Get decrypted credentials for a specific app.
 * Returns { auth_type, username, password } or { auth_type, cookies } or null.
 */
async function getCredentialsForTask(customerId, appName) {
  const result = await pool.query(
    `SELECT credentials, auth_type FROM connected_apps
     WHERE customer_id = $1 AND LOWER(app_name) = LOWER($2) AND status = 'connected'`,
    [customerId, appName]
  );
  if (result.rows.length === 0) return null;

  // Update last_used_at
  pool.query(
    `UPDATE connected_apps SET last_used_at = NOW()
     WHERE customer_id = $1 AND LOWER(app_name) = LOWER($2)`,
    [customerId, appName]
  ).catch(() => {});

  const decrypted = decryptJSON(result.rows[0].credentials, customerId);
  const authType = result.rows[0].auth_type || 'credentials';
  return { auth_type: authType, ...decrypted };
}

/**
 * Get all connected apps for a customer (no credentials).
 */
async function getAllConnectedApps(customerId) {
  const result = await pool.query(
    `SELECT app_name, app_category, status, auth_type, connected_at
     FROM connected_apps WHERE customer_id = $1`,
    [customerId]
  );
  return result.rows;
}

/**
 * Given a task message, find which connected app credentials are relevant.
 * Returns array of { app: string, credentials: { username, password } }.
 */
async function getRelevantCredentials(customerId, taskMessage) {
  const apps = await getAllConnectedApps(customerId);
  const taskLower = taskMessage.toLowerCase();

  const relevant = [];
  for (const app of apps) {
    if (app.status !== 'connected') continue;
    const appLower = app.app_name.toLowerCase();
    // Check if the task mentions this app (full name, no-spaces, or first word)
    if (
      taskLower.includes(appLower) ||
      taskLower.includes(appLower.replace(/\s+/g, '')) ||
      taskLower.includes(appLower.split(' ')[0])
    ) {
      const creds = await getCredentialsForTask(customerId, app.app_name);
      if (creds) {
        relevant.push({ app: app.app_name, ...creds });
      }
    }
  }
  return relevant;
}

module.exports = { getCredentialsForTask, getAllConnectedApps, getRelevantCredentials };
