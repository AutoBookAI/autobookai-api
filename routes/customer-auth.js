/**
 * Customer Portal API — endpoints for self-service customers.
 *
 * Mounted at /api/customer
 * All routes except /login are protected by customerAuth middleware.
 *
 * Security:
 *  - Customer ID always comes from JWT (req.customerId), never from URL params
 *  - No IDOR possible — customers can only access their own data
 *  - Admin tokens rejected by customerAuth (checks customerId, not adminId)
 */

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');
const customerAuth = require('../middleware/customerAuth');
const { encrypt, decrypt, encryptJSON, decryptJSON } = require('../services/encryption');
const { syncProfileToOpenClaw } = require('../services/openclaw');

// ── Login ─────────────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, name, password_hash FROM customers WHERE email=$1',
      [email]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const customer = result.rows[0];

    // Admin-created customers don't have password_hash — cannot log in via portal
    if (!customer.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!await bcrypt.compare(password, customer.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ customerId: customer.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      customer: { id: customer.id, name: customer.name, email: customer.email },
    });
  } catch {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Protected routes ──────────────────────────────────────────────────────────

router.use(customerAuth);

// GET /api/customer/me — safe fields only
router.get('/me', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, whatsapp_to, subscription_status,
              openclaw_status, plan, created_at
       FROM customers WHERE id=$1`,
      [req.customerId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Failed' });
  }
});

// GET /api/customer/profile — decrypted preferences
router.get('/profile', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT customer_id, dietary_restrictions, cuisine_preferences,
              preferred_restaurants, dining_budget, preferred_airlines,
              seat_preference, cabin_class, hotel_preferences,
              loyalty_numbers, full_name, date_of_birth, passport_number,
              preferred_contact, timezone
       FROM customer_profiles WHERE customer_id=$1`,
      [req.customerId]
    );

    const profile = result.rows[0] || {};
    const cid = req.customerId;

    // Decrypt sensitive fields
    if (profile.loyalty_numbers) profile.loyalty_numbers = decryptJSON(profile.loyalty_numbers, cid);
    if (profile.passport_number) profile.passport_number = decrypt(profile.passport_number, cid);
    if (profile.date_of_birth) profile.date_of_birth = decrypt(profile.date_of_birth, cid);

    res.json(profile);
  } catch {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PATCH /api/customer/profile — update preferences + sync to OpenClaw
router.patch('/profile', async (req, res) => {
  const {
    dietary_restrictions, cuisine_preferences, preferred_restaurants, dining_budget,
    preferred_airlines, seat_preference, cabin_class, hotel_preferences,
    loyalty_numbers, full_name, date_of_birth, passport_number, preferred_contact,
    timezone,
  } = req.body;

  try {
    const check = await pool.query(
      'SELECT id, railway_service_url FROM customers WHERE id=$1',
      [req.customerId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    const serviceUrl = check.rows[0].railway_service_url;

    // Encrypt sensitive fields with per-customer key
    // Empty string "" → null to allow clearing via COALESCE
    const cid = req.customerId;
    const encryptedLoyalty = loyalty_numbers && (Array.isArray(loyalty_numbers) ? loyalty_numbers.length : true)
      ? encryptJSON(loyalty_numbers, cid) : (loyalty_numbers === '' || (Array.isArray(loyalty_numbers) && !loyalty_numbers.length) ? null : undefined);
    const encryptedPassport = passport_number ? encrypt(passport_number, cid) : (passport_number === '' ? null : undefined);
    const encryptedDOB = date_of_birth ? encrypt(date_of_birth, cid) : (date_of_birth === '' ? null : undefined);

    await pool.query(
      `UPDATE customer_profiles SET
         dietary_restrictions = COALESCE($1, dietary_restrictions),
         cuisine_preferences  = COALESCE($2, cuisine_preferences),
         preferred_restaurants= COALESCE($3, preferred_restaurants),
         dining_budget        = COALESCE($4, dining_budget),
         preferred_airlines   = COALESCE($5, preferred_airlines),
         seat_preference      = COALESCE($6, seat_preference),
         cabin_class          = COALESCE($7, cabin_class),
         hotel_preferences    = COALESCE($8, hotel_preferences),
         loyalty_numbers      = COALESCE($9, loyalty_numbers),
         full_name            = COALESCE($10, full_name),
         date_of_birth        = COALESCE($11, date_of_birth),
         passport_number      = COALESCE($12, passport_number),
         preferred_contact    = COALESCE($13, preferred_contact),
         timezone             = COALESCE($14, timezone),
         updated_at           = NOW()
       WHERE customer_id = $15`,
      [
        dietary_restrictions, cuisine_preferences, preferred_restaurants, dining_budget,
        preferred_airlines, seat_preference, cabin_class, hotel_preferences,
        encryptedLoyalty, full_name, encryptedDOB, encryptedPassport, preferred_contact,
        timezone, req.customerId,
      ]
    );

    // Sync updated profile to their OpenClaw AI instance
    if (serviceUrl) {
      const profileResult = await pool.query(
        `SELECT dietary_restrictions, cuisine_preferences, preferred_restaurants,
                dining_budget, preferred_airlines, seat_preference, cabin_class,
                hotel_preferences, loyalty_numbers, full_name, preferred_contact,
                openclaw_password
         FROM customer_profiles WHERE customer_id=$1`, [req.customerId]
      );
      const profile = profileResult.rows[0] || {};
      if (profile.loyalty_numbers) profile.loyalty_numbers = decryptJSON(profile.loyalty_numbers, cid);
      const openclawPwd = decrypt(profile.openclaw_password, cid);
      if (openclawPwd) {
        syncProfileToOpenClaw(serviceUrl, openclawPwd, profile).catch(console.error);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/customer/billing/portal — open Stripe billing portal
router.post('/billing/portal', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT stripe_customer_id FROM customers WHERE id=$1',
      [req.customerId]
    );
    if (!result.rows[0]?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: result.rows[0].stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/portal`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// GET /api/customer/activity — paginated activity log
router.get('/activity', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  try {
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM activity_log WHERE customer_id=$1',
      [req.customerId]
    );
    const result = await pool.query(
      `SELECT id, event_type, description, metadata, created_at
       FROM activity_log WHERE customer_id=$1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.customerId, limit, offset]
    );
    res.json({
      activities: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
