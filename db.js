const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- ── Admin accounts (you) ──────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS admins (
        id            SERIAL PRIMARY KEY,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name          VARCHAR(255) NOT NULL,
        created_at    TIMESTAMP DEFAULT NOW()
      );

      -- ── Paying AI assistant customers ──────────────────────────────────────
      CREATE TABLE IF NOT EXISTS customers (
        id                     SERIAL PRIMARY KEY,
        admin_id               INTEGER REFERENCES admins(id) ON DELETE CASCADE,
        name                   VARCHAR(255) NOT NULL,
        email                  VARCHAR(255) UNIQUE NOT NULL,
        password_hash          VARCHAR(255),          -- for self-signup customers

        -- WhatsApp routing
        whatsapp_from          VARCHAR(50),   -- number they text FROM
        whatsapp_to            VARCHAR(50),   -- their assigned Twilio number

        -- Stripe billing
        stripe_customer_id     VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        stripe_virtual_card_id VARCHAR(255),  -- Stripe Issuing card for AI to use
        subscription_status    VARCHAR(50) DEFAULT 'inactive',
        plan                   VARCHAR(50) DEFAULT 'assistant',

        -- OpenClaw instance on Railway
        railway_service_id     VARCHAR(255),  -- the Railway service hosting their OpenClaw
        railway_service_url    VARCHAR(500),  -- URL of their OpenClaw instance
        openclaw_status        VARCHAR(50) DEFAULT 'pending',  -- pending/active/error

        -- Onboarding
        onboarding_complete    BOOLEAN DEFAULT FALSE,
        created_at             TIMESTAMP DEFAULT NOW(),
        updated_at             TIMESTAMP DEFAULT NOW()
      );

      -- ── Customer preferences (stored encrypted) ───────────────────────────
      -- We NEVER store raw card numbers — Stripe holds those.
      -- We store preferences, loyalty numbers, dietary needs, etc.
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id                    SERIAL PRIMARY KEY,
        customer_id           INTEGER UNIQUE REFERENCES customers(id) ON DELETE CASCADE,

        -- Dining preferences
        dietary_restrictions  TEXT,          -- e.g. "vegetarian, nut allergy"
        cuisine_preferences   TEXT,          -- e.g. "Italian, Japanese"
        preferred_restaurants TEXT,          -- e.g. "Nobu, Zuma"
        dining_budget         VARCHAR(50),   -- e.g. "$100-200 per person"

        -- Travel preferences
        preferred_airlines    TEXT,          -- e.g. "BA, Emirates"
        seat_preference       VARCHAR(50),   -- e.g. "aisle, window"
        cabin_class           VARCHAR(50),   -- e.g. "business"
        hotel_preferences     TEXT,          -- e.g. "5-star, sea view"

        -- Loyalty programs (encrypted at rest)
        loyalty_numbers       TEXT,          -- JSON, AES-256 encrypted

        -- Personal info for bookings
        full_name             VARCHAR(255),
        date_of_birth         VARCHAR(50),   -- encrypted
        passport_number       VARCHAR(255),  -- encrypted

        -- Calendar
        google_calendar_token TEXT,          -- encrypted OAuth token

        -- Communication preferences
        preferred_contact     VARCHAR(20) DEFAULT 'whatsapp',

        created_at            TIMESTAMP DEFAULT NOW(),
        updated_at            TIMESTAMP DEFAULT NOW()
      );

      -- ── Twilio number pool ────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS whatsapp_numbers (
        id          SERIAL PRIMARY KEY,
        number      VARCHAR(50) UNIQUE NOT NULL,
        is_assigned BOOLEAN DEFAULT FALSE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        created_at  TIMESTAMP DEFAULT NOW()
      );

      -- ── Audit log ─────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS activity_log (
        id          SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        event_type  VARCHAR(100) NOT NULL,  -- e.g. 'booking_made', 'message_sent'
        description TEXT,
        metadata    JSONB,
        created_at  TIMESTAMP DEFAULT NOW()
      );

      -- ── Conversation history ─────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS conversations (
        id          SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        role        VARCHAR(20) NOT NULL,
        content     TEXT NOT NULL,
        created_at  TIMESTAMP DEFAULT NOW()
      );

      -- ── Connected apps (encrypted credentials for AI to use) ──────────
      CREATE TABLE IF NOT EXISTS connected_apps (
        id          SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        app_name    VARCHAR(100) NOT NULL,
        credentials TEXT NOT NULL,  -- AES-256 encrypted JSON {username, password}
        connected_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(customer_id, app_name)
      );

      -- ── Stripe webhook idempotency ──────────────────────────────────────
      CREATE TABLE IF NOT EXISTS processed_stripe_events (
        event_id     VARCHAR(255) PRIMARY KEY,
        event_type   VARCHAR(100) NOT NULL,
        processed_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── Migrations (safe to re-run) ───────────────────────────────────────
    await client.query(`
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS gmail_app_password TEXT;
      ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS openclaw_password TEXT;
      ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/Los_Angeles';
      ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS assistant_name VARCHAR(100);

      -- Encrypted fields need TEXT, not VARCHAR(50) — ciphertext is ~90+ chars
      ALTER TABLE customer_profiles ALTER COLUMN date_of_birth TYPE TEXT;
    `);

    // ── Indexes (safe to re-run) ────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_customers_whatsapp_to ON customers(whatsapp_to);
      CREATE INDEX IF NOT EXISTS idx_customers_stripe_sub_id ON customers(stripe_subscription_id);
      CREATE INDEX IF NOT EXISTS idx_activity_log_customer_id ON activity_log(customer_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_customer_id ON conversations(customer_id);
    `);

    console.log('✅ Database ready');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
