const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  try {
    // Idempotency: skip already-processed events (Stripe may retry)
    const already = await pool.query(
      'SELECT 1 FROM processed_stripe_events WHERE event_id=$1',
      [event.id]
    );
    if (already.rows.length) {
      console.log(`Skipping duplicate Stripe event ${event.id}`);
      return res.json({ received: true, duplicate: true });
    }

    switch (event.type) {

      case 'checkout.session.completed': {
        const customerId = obj.metadata?.customer_id;
        const plan = obj.metadata?.plan || 'assistant';
        if (!customerId) break;

        // 1. Activate subscription
        await pool.query(
          `UPDATE customers SET
             subscription_status='active',
             stripe_subscription_id=$1,
             plan=$2, updated_at=NOW()
           WHERE id=$3`,
          [obj.subscription, plan, customerId]
        );
        console.log(`✅ Activated subscription for customer ${customerId}`);

        // 2. Assign WhatsApp number (only if not already assigned)
        const custCheck = await pool.query(
          'SELECT id, name, whatsapp_to FROM customers WHERE id=$1',
          [customerId]
        );
        const customer = custCheck.rows[0];
        if (!customer) break;

        if (!customer.whatsapp_to) {
          const numResult = await pool.query(
            'SELECT number FROM whatsapp_numbers WHERE is_assigned = FALSE LIMIT 1 FOR UPDATE'
          );
          const whatsappTo = numResult.rows[0]?.number || null;

          if (whatsappTo) {
            await pool.query(
              'UPDATE customers SET whatsapp_to=$1, updated_at=NOW() WHERE id=$2',
              [whatsappTo, customerId]
            );
            await pool.query(
              'UPDATE whatsapp_numbers SET is_assigned=TRUE, customer_id=$1 WHERE number=$2',
              [customerId, whatsappTo]
            );
            console.log(`📱 Assigned number ${whatsappTo} to customer ${customerId}`);

            // 3. Mark AI assistant as active (shared Claude handler, no provisioning needed)
            await pool.query(
              "UPDATE customers SET openclaw_status='active', updated_at=NOW() WHERE id=$1",
              [customerId]
            );
          } else {
            console.error(`🚨 CRITICAL: No WhatsApp numbers available for customer ${customerId} — number pool empty!`);
          }
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        await pool.query(
          `UPDATE customers SET subscription_status='active', updated_at=NOW()
           WHERE stripe_subscription_id=$1`,
          [obj.subscription]
        );
        break;
      }

      case 'invoice.payment_failed': {
        const failedCust = await pool.query(
          `UPDATE customers SET subscription_status='past_due', updated_at=NOW()
           WHERE stripe_subscription_id=$1 RETURNING name, email`,
          [obj.subscription]
        );
        // Send payment failed email
        if (failedCust.rows[0]) {
          const { sendPaymentFailedEmail } = require('../services/notifications');
          sendPaymentFailedEmail(failedCust.rows[0].name, failedCust.rows[0].email).catch(() => {});
        }
        break;
      }

      case 'customer.subscription.deleted': {
        await pool.query(
          `UPDATE customers SET subscription_status='cancelled', updated_at=NOW()
           WHERE stripe_subscription_id=$1`,
          [obj.id]
        );
        break;
      }

      case 'customer.subscription.updated': {
        // Normalize: treat 'trialing' as 'active' (customers on trial should have full access)
        const rawStatus = obj.status;
        const status = (rawStatus === 'active' || rawStatus === 'trialing') ? 'active' : rawStatus;
        await pool.query(
          `UPDATE customers SET subscription_status=$1, updated_at=NOW()
           WHERE stripe_subscription_id=$2`,
          [status, obj.id]
        );
        break;
      }
    }

    // Record event as processed
    await pool.query(
      'INSERT INTO processed_stripe_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [event.id, event.type]
    );

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Processing failed' });
  }
});

module.exports = router;
