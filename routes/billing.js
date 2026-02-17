const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');
const auth = require('../middleware/auth');

router.get('/plans', (req, res) => {
  res.json([
    {
      id: 'assistant',
      name: 'AI Assistant',
      price: 49.99,
      description: 'Your personal AI assistant — book restaurants, flights, handle issues via WhatsApp',
      stripePriceId: process.env.STRIPE_PRICE_ID,
      features: [
        'WhatsApp AI assistant 24/7',
        'Restaurant bookings (OpenTable, Resy, direct call)',
        'Flight & hotel bookings',
        'Email & phone on your behalf',
        'Remembers all your preferences',
        'Handles travel disruptions',
        'Calendar management',
      ]
    }
  ]);
});

// POST /api/billing/checkout — send Stripe payment link to customer
router.post('/checkout', auth, async (req, res) => {
  const { customerId, plan } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, name, email, stripe_customer_id FROM customers WHERE id=$1 AND admin_id=$2',
      [customerId, req.adminId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Customer not found' });
    const customer = result.rows[0];

    let stripeCustomerId = customer.stripe_customer_id;
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({
        email: customer.email,
        name:  customer.name,
        metadata: { customer_id: String(customer.id) }
      });
      stripeCustomerId = sc.id;
      await pool.query(
        'UPDATE customers SET stripe_customer_id=$1 WHERE id=$2',
        [stripeCustomerId, customer.id]
      );
    }

    const priceId = process.env.STRIPE_PRICE_ID;

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Collect billing details for Stripe Issuing (virtual card for AI bookings)
      payment_method_collection: 'always',
      success_url: `${process.env.FRONTEND_URL}/dashboard?payment=success&customer=${customer.id}`,
      cancel_url:  `${process.env.FRONTEND_URL}/dashboard?payment=cancelled`,
      metadata: { customer_id: String(customer.id), plan }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

// POST /api/billing/portal
router.post('/portal', auth, async (req, res) => {
  const { customerId } = req.body;
  try {
    const result = await pool.query(
      'SELECT stripe_customer_id FROM customers WHERE id=$1 AND admin_id=$2',
      [customerId, req.adminId]
    );
    if (!result.rows[0]?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer:   result.rows[0].stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/customers/${customerId}`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

module.exports = router;
