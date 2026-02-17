/**
 * Tools API — called by OpenClaw instances to perform actions.
 *
 * Auth: Bearer token = short-lived HMAC of customer ID + timestamp.
 * Each endpoint scoped to /api/tools/:customerId/*
 *
 * Security:
 *  - Per-customer rate limiting (separate from global)
 *  - Auth token verified via HMAC (not stored in system prompt)
 *  - Input validation on all endpoints
 *  - Call SIDs scoped to authenticated customer
 */

const router = require('express').Router({ mergeParams: true });
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { decrypt } = require('../services/encryption');

// ── Per-customer rate limits ────────────────────────────────────────────────

const emailLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `email:${req.customerId}`,
  message: { error: 'Email rate limit exceeded. Max 20 per 15 minutes.' },
});

const callLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `call:${req.customerId}`,
  message: { error: 'Call rate limit exceeded. Max 10 per 15 minutes.' },
});

const searchLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `search:${req.customerId}`,
  message: { error: 'Search rate limit exceeded. Max 60 per 15 minutes.' },
});

const calendarLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `calendar:${req.customerId}`,
  message: { error: 'Calendar rate limit exceeded. Max 30 per 15 minutes.' },
});

// ── Auth middleware — verify HMAC-based tools token ─────────────────────────

/**
 * Tools auth uses HMAC(customerId + timestamp, setupPassword).
 * The OpenClaw instance generates tokens using its TOOLS_API_KEY env var.
 * Token format: timestamp.hmac
 * Valid for 5 minutes.
 */
async function toolAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = authHeader.slice(7);
  const { customerId } = req.params;

  // Validate customerId is numeric
  if (!/^\d+$/.test(customerId)) {
    return res.status(400).json({ error: 'Invalid customer ID' });
  }

  try {
    const result = await pool.query(
      `SELECT cp.openclaw_password, c.id
       FROM customers c
       JOIN customer_profiles cp ON cp.customer_id = c.id
       WHERE c.id = $1`,
      [customerId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Decrypt the stored password using per-customer key
    const storedPassword = decrypt(result.rows[0].openclaw_password, parseInt(customerId));

    if (!storedPassword) {
      return res.status(401).json({ error: 'Tools API not configured for this customer' });
    }

    // Verify: token can be either a raw password match (legacy) or HMAC-based
    // HMAC format: timestamp.hmac_hex
    const parts = token.split('.');
    if (parts.length === 2) {
      const [timestamp, hmac] = parts;
      const ts = parseInt(timestamp);
      const now = Math.floor(Date.now() / 1000);

      // Token valid for 5 minutes
      if (Math.abs(now - ts) > 300) {
        return res.status(401).json({ error: 'Token expired' });
      }

      const expected = crypto.createHmac('sha256', storedPassword)
        .update(`${customerId}:${timestamp}`)
        .digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'))) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    } else {
      // Legacy: raw password comparison (for backwards compat during migration)
      if (token !== storedPassword) {
        return res.status(401).json({ error: 'Invalid tools API token' });
      }
    }

    req.customerId = parseInt(customerId);
    next();
  } catch (err) {
    console.error('Tool auth error:', err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

router.use('/:customerId', toolAuth);

// ── Email ──────────────────────────────────────────────────────────────────

router.post('/:customerId/email', emailLimit, async (req, res) => {
  const { to, subject, body, cc, bcc } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Missing required fields: to, subject, body' });
  }
  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Invalid email address format' });
  }
  try {
    const { sendEmail } = require('../services/email');
    const result = await sendEmail(req.customerId, { to, subject, body, cc, bcc });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`Email tool error (customer ${req.customerId}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Phone calls ────────────────────────────────────────────────────────────

// Track call SIDs per customer for scoping
const customerCallSids = new Map(); // customerId → Set<callSid>

router.post('/:customerId/call', callLimit, async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: 'Missing required fields: to, message' });
  }
  try {
    const { makeCall } = require('../services/twilio-voice');
    const custResult = await pool.query(
      'SELECT whatsapp_to FROM customers WHERE id=$1', [req.customerId]
    );
    const from = custResult.rows[0]?.whatsapp_to;
    const result = await makeCall({ to, message, from, voice: req.body.voice });

    // Track this call SID for this customer
    if (!customerCallSids.has(req.customerId)) customerCallSids.set(req.customerId, new Set());
    customerCallSids.get(req.customerId).add(result.callSid);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`Call tool error (customer ${req.customerId}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:customerId/call/:callSid', async (req, res) => {
  // Scope: only allow looking up call SIDs that this customer initiated
  const sids = customerCallSids.get(req.customerId);
  if (!sids || !sids.has(req.params.callSid)) {
    return res.status(403).json({ error: 'Call not found for this customer' });
  }
  try {
    const { getCallStatus } = require('../services/twilio-voice');
    const result = await getCallStatus(req.params.callSid);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Web search ─────────────────────────────────────────────────────────────

router.post('/:customerId/search', searchLimit, async (req, res) => {
  const { query, count } = req.body;
  if (!query || typeof query !== 'string' || query.length > 500) {
    return res.status(400).json({ error: 'Missing or invalid search query (max 500 chars)' });
  }
  try {
    const { search } = require('../services/web-search');
    const results = await search(query, Math.min(count || 5, 10));
    res.json({ results });
  } catch (err) {
    console.error(`Search tool error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:customerId/fetch', searchLimit, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing URL' });
  }
  // Only allow http/https URLs
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Only http/https URLs are allowed' });
  }
  // Block internal/private network URLs (SSRF prevention)
  if (/^https?:\/\/(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(url)) {
    return res.status(400).json({ error: 'Internal URLs are not allowed' });
  }
  try {
    const { fetchPage } = require('../services/web-search');
    const result = await fetchPage(url, Math.min(req.body.maxLength || 5000, 10000));
    res.json(result);
  } catch (err) {
    console.error(`Fetch tool error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Calendar ───────────────────────────────────────────────────────────────

router.get('/:customerId/calendar', calendarLimit, async (req, res) => {
  try {
    const { listEvents } = require('../services/google-calendar');
    const events = await listEvents(req.customerId, {
      maxResults: Math.min(parseInt(req.query.maxResults) || 10, 50),
      timeMin: req.query.timeMin,
    });
    res.json({ events });
  } catch (err) {
    console.error(`Calendar list error (customer ${req.customerId}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:customerId/calendar', calendarLimit, async (req, res) => {
  const { summary, start } = req.body;
  if (!summary || !start) {
    return res.status(400).json({ error: 'Missing required fields: summary, start' });
  }
  try {
    const { createEvent } = require('../services/google-calendar');
    const event = await createEvent(req.customerId, req.body);
    res.json({ success: true, event });
  } catch (err) {
    console.error(`Calendar create error (customer ${req.customerId}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:customerId/calendar/:eventId', calendarLimit, async (req, res) => {
  try {
    const { deleteEvent } = require('../services/google-calendar');
    await deleteEvent(req.customerId, req.params.eventId);
    res.json({ success: true });
  } catch (err) {
    console.error(`Calendar delete error (customer ${req.customerId}):`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
