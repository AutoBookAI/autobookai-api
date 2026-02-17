const router = require('express').Router();
const crypto = require('crypto');
const { pool } = require('../db');
const auth = require('../middleware/auth');
const { encrypt, decrypt, encryptJSON, decryptJSON } = require('../services/encryption');
const { provisionOpenClawInstance } = require('../services/railway');
const { syncProfileToOpenClaw } = require('../services/openclaw');

router.use(auth);

// GET /api/customers
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.email, c.whatsapp_from, c.whatsapp_to,
              c.subscription_status, c.plan, c.openclaw_status,
              c.railway_service_url, c.onboarding_complete, c.created_at,
              p.dietary_restrictions, p.preferred_airlines, p.cabin_class
       FROM customers c
       LEFT JOIN customer_profiles p ON p.customer_id = c.id
       WHERE c.admin_id = $1
       ORDER BY c.created_at DESC`,
      [req.adminId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// GET /api/customers/:id
router.get('/:id', async (req, res) => {
  try {
    // SECURITY: Explicitly select columns — never expose password_hash or internal IDs
    const cResult = await pool.query(
      `SELECT id, name, email, whatsapp_from, whatsapp_to,
              stripe_customer_id, subscription_status, plan,
              railway_service_url, openclaw_status, onboarding_complete,
              created_at, updated_at
       FROM customers WHERE id = $1 AND admin_id = $2`,
      [req.params.id, req.adminId]
    );
    if (!cResult.rows.length) return res.status(404).json({ error: 'Not found' });

    const pResult = await pool.query(
      `SELECT customer_id, dietary_restrictions, cuisine_preferences,
              preferred_restaurants, dining_budget, preferred_airlines,
              seat_preference, cabin_class, hotel_preferences,
              loyalty_numbers, full_name, date_of_birth, passport_number,
              preferred_contact, timezone, gmail_app_password,
              google_calendar_token
       FROM customer_profiles WHERE customer_id = $1`,
      [req.params.id]
    );

    const customer = cResult.rows[0];
    const profile  = pResult.rows[0] || {};
    const cid = parseInt(req.params.id);

    // Decrypt sensitive fields using per-customer key before sending to dashboard
    if (profile.loyalty_numbers) profile.loyalty_numbers = decryptJSON(profile.loyalty_numbers, cid);
    if (profile.passport_number) profile.passport_number = decrypt(profile.passport_number, cid);
    if (profile.date_of_birth)   profile.date_of_birth   = decrypt(profile.date_of_birth, cid);

    // Never expose secrets — just indicate whether they're set
    profile.has_gmail_app_password = !!profile.gmail_app_password;
    delete profile.gmail_app_password;
    profile.calendar_connected = !!profile.google_calendar_token;
    delete profile.google_calendar_token;

    res.json({ ...customer, profile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

// POST /api/customers — create + auto-provision OpenClaw
router.post('/', async (req, res) => {
  const { name, email, whatsapp_from, plan } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Assign a Twilio number from the pool
    const numResult = await client.query(
      'SELECT * FROM whatsapp_numbers WHERE is_assigned = FALSE LIMIT 1 FOR UPDATE'
    );
    const whatsappTo = numResult.rows[0]?.number || null;

    // Generate a secure random password for this customer's OpenClaw UI
    const openclawPassword = crypto.randomBytes(16).toString('hex');

    // Create customer record
    const cResult = await client.query(
      `INSERT INTO customers
         (admin_id, name, email, whatsapp_from, whatsapp_to, plan)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [req.adminId, name, email, whatsapp_from || null, whatsappTo, plan || 'assistant']
    );
    const customer = cResult.rows[0];

    // Create empty profile
    await client.query(
      'INSERT INTO customer_profiles (customer_id) VALUES ($1)',
      [customer.id]
    );

    // Mark number assigned
    if (whatsappTo) {
      await client.query(
        'UPDATE whatsapp_numbers SET is_assigned=TRUE, customer_id=$1 WHERE number=$2',
        [customer.id, whatsappTo]
      );
    }

    await client.query('COMMIT');

    // Provision OpenClaw asynchronously (takes ~30s, don't block the response)
    if (whatsappTo) {
      provisionOpenClawInstance({
        customerId:       customer.id,
        customerName:     name,
        anthropicApiKey:  process.env.ANTHROPIC_API_KEY,
        twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
        twilioAuthToken:  process.env.TWILIO_AUTH_TOKEN,
        whatsappNumber:   whatsappTo,
        setupPassword:    openclawPassword,
      }).then(async ({ serviceId, serviceUrl }) => {
        await pool.query(
          `UPDATE customers SET
             railway_service_id=$1, railway_service_url=$2,
             openclaw_status='active', updated_at=NOW()
           WHERE id=$3`,
          [serviceId, serviceUrl, customer.id]
        );
        // Store the password encrypted with per-customer key
        await pool.query(
          'UPDATE customer_profiles SET openclaw_password=$1 WHERE customer_id=$2',
          [encrypt(openclawPassword, customer.id), customer.id]
        );
        console.log(`✅ OpenClaw provisioned for ${name}`);
      }).catch(err => {
        console.error(`❌ OpenClaw provisioning failed for ${name}:`, err.message);
        pool.query(
          "UPDATE customers SET openclaw_status='error' WHERE id=$1",
          [customer.id]
        );
      });
    }

    res.json({ ...customer, message: 'Customer created. AI agent is being provisioned (~30s).' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create customer' });
  } finally {
    client.release();
  }
});

// PATCH /api/customers/:id/profile — update preferences
router.patch('/:id/profile', async (req, res) => {
  const {
    dietary_restrictions, cuisine_preferences, preferred_restaurants, dining_budget,
    preferred_airlines, seat_preference, cabin_class, hotel_preferences,
    loyalty_numbers, full_name, date_of_birth, passport_number, preferred_contact,
    timezone, gmail_app_password,
  } = req.body;

  try {
    // Verify ownership
    const check = await pool.query(
      'SELECT id, railway_service_url FROM customers WHERE id=$1 AND admin_id=$2',
      [req.params.id, req.adminId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    const serviceUrl = check.rows[0].railway_service_url;

    // Encrypt sensitive fields using per-customer key
    // Empty string "" → null to allow clearing via COALESCE
    const cid = parseInt(req.params.id);
    const encryptedLoyalty = loyalty_numbers && (Array.isArray(loyalty_numbers) ? loyalty_numbers.length : true)
      ? encryptJSON(loyalty_numbers, cid) : (loyalty_numbers === '' || (Array.isArray(loyalty_numbers) && !loyalty_numbers.length) ? null : undefined);
    const encryptedPassport = passport_number ? encrypt(passport_number, cid) : (passport_number === '' ? null : undefined);
    const encryptedDOB = date_of_birth ? encrypt(date_of_birth, cid) : (date_of_birth === '' ? null : undefined);
    const encryptedGmail = gmail_app_password ? encrypt(gmail_app_password, cid) : (gmail_app_password === '' ? null : undefined);

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
         gmail_app_password   = COALESCE($15, gmail_app_password),
         updated_at           = NOW()
       WHERE customer_id = $16`,
      [
        dietary_restrictions, cuisine_preferences, preferred_restaurants, dining_budget,
        preferred_airlines, seat_preference, cabin_class, hotel_preferences,
        encryptedLoyalty, full_name, encryptedDOB, encryptedPassport, preferred_contact,
        timezone, encryptedGmail, req.params.id,
      ]
    );

    // Push updated profile to their OpenClaw instance so Claude knows the new prefs
    // SECURITY: Fetch the OpenClaw password from DB, never from the request body
    if (serviceUrl) {
      const profileResult = await pool.query(
        `SELECT dietary_restrictions, cuisine_preferences, preferred_restaurants,
                dining_budget, preferred_airlines, seat_preference, cabin_class,
                hotel_preferences, loyalty_numbers, full_name, preferred_contact,
                openclaw_password
         FROM customer_profiles WHERE customer_id=$1`, [req.params.id]
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

// POST /api/customers/:id/reprovision — retry failed OpenClaw deployment
router.post('/:id/reprovision', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, whatsapp_to, openclaw_status, railway_service_id, railway_service_url
       FROM customers WHERE id=$1 AND admin_id=$2`,
      [req.params.id, req.adminId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const customer = result.rows[0];
    if (customer.openclaw_status === 'active' && customer.railway_service_url) {
      return res.status(400).json({ error: 'AI agent is already active' });
    }

    // If there's an existing broken service, tear it down first
    if (customer.railway_service_id) {
      const { deprovisionOpenClawInstance } = require('../services/railway');
      await deprovisionOpenClawInstance(customer.railway_service_id).catch(() => {});
    }

    // Mark as pending
    await pool.query(
      "UPDATE customers SET openclaw_status='pending', railway_service_id=NULL, railway_service_url=NULL WHERE id=$1",
      [customer.id]
    );

    // Reprovision
    const openclawPassword = require('crypto').randomBytes(16).toString('hex');
    const whatsappNumber = customer.whatsapp_to;

    if (!whatsappNumber) {
      return res.status(400).json({ error: 'No WhatsApp number assigned. Assign one first.' });
    }

    provisionOpenClawInstance({
      customerId:       customer.id,
      customerName:     customer.name,
      anthropicApiKey:  process.env.ANTHROPIC_API_KEY,
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
      twilioAuthToken:  process.env.TWILIO_AUTH_TOKEN,
      whatsappNumber:   whatsappNumber,
      setupPassword:    openclawPassword,
    }).then(async ({ serviceId, serviceUrl }) => {
      await pool.query(
        `UPDATE customers SET
           railway_service_id=$1, railway_service_url=$2,
           openclaw_status='active', updated_at=NOW()
         WHERE id=$3`,
        [serviceId, serviceUrl, customer.id]
      );
      await pool.query(
        'UPDATE customer_profiles SET openclaw_password=$1 WHERE customer_id=$2',
        [encrypt(openclawPassword, customer.id), customer.id]
      );
      console.log(`✅ OpenClaw reprovisioned for ${customer.name}`);
    }).catch(err => {
      console.error(`❌ OpenClaw reprovisioning failed for ${customer.name}:`, err.message);
      pool.query(
        "UPDATE customers SET openclaw_status='error' WHERE id=$1",
        [customer.id]
      );
    });

    res.json({ message: 'AI agent reprovisioning started. This takes about 30-60 seconds.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reprovision' });
  }
});

// DELETE /api/customers/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT railway_service_id FROM customers WHERE id=$1 AND admin_id=$2',
      [req.params.id, req.adminId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const { deprovisionOpenClawInstance } = require('../services/railway');
    if (result.rows[0].railway_service_id) {
      deprovisionOpenClawInstance(result.rows[0].railway_service_id).catch(console.error);
    }

    await pool.query(
      'UPDATE whatsapp_numbers SET is_assigned=FALSE, customer_id=NULL WHERE customer_id=$1',
      [req.params.id]
    );
    await pool.query('DELETE FROM customers WHERE id=$1', [req.params.id]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

module.exports = router;
