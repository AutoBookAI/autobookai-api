const router = require('express').Router();
const bcrypt = require('bcryptjs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');

/**
 * POST /api/signup
 * Public endpoint — creates a customer account and returns a Stripe Checkout URL.
 * The customer is assigned to admin_id=1 (the platform owner).
 *
 * NOTE: WhatsApp number assignment and OpenClaw provisioning happen AFTER payment,
 * in the checkout.session.completed Stripe webhook handler (stripe-webhook.js).
 * This prevents wasting numbers and Railway resources on abandoned checkouts.
 */
router.post('/', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if email already exists — use generic error to prevent email enumeration
    const existing = await client.query('SELECT id FROM customers WHERE email=$1', [email]);
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Unable to create account. Please try a different email or contact support.' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create customer record (assigned to admin_id=1, the platform owner)
    // No WhatsApp number or OpenClaw yet — those are assigned after payment in stripe-webhook.js
    const cResult = await client.query(
      `INSERT INTO customers
         (admin_id, name, email, password_hash, plan)
       VALUES (1, $1, $2, $3, 'assistant')
       RETURNING id, name, email`,
      [name, email, passwordHash]
    );
    const customer = cResult.rows[0];

    // Create empty profile
    await client.query(
      'INSERT INTO customer_profiles (customer_id) VALUES ($1)',
      [customer.id]
    );

    await client.query('COMMIT');

    // Create Stripe Customer + Checkout Session
    const stripeCustomer = await stripe.customers.create({
      email,
      name,
      metadata: { customer_id: String(customer.id) },
    });

    await pool.query(
      'UPDATE customers SET stripe_customer_id=$1 WHERE id=$2',
      [stripeCustomer.id, customer.id]
    );

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomer.id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/signup`,
      metadata: { customer_id: String(customer.id), plan: 'assistant' },
    });

    res.json({ checkoutUrl: session.url });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Signup error:', err);
    if (err.code === '23505') return res.status(400).json({ error: 'Unable to create account. Please try a different email or contact support.' });
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/signup/status?session_id=xxx
 * After Stripe Checkout, the success page polls this to get the customer's info.
 * Number assignment + provisioning happen in the Stripe webhook, so this endpoint
 * is polled until whatsapp_to appears (meaning webhook has fired and assigned a number).
 *
 * SECURITY: Only returns the minimum fields needed by the success page.
 */
router.get('/status', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const customerId = session.metadata?.customer_id;

    if (!customerId) {
      return res.status(404).json({ error: 'Not found' });
    }

    const result = await pool.query(
      `SELECT name, whatsapp_to, subscription_status, openclaw_status
       FROM customers WHERE id=$1`,
      [customerId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

module.exports = router;
