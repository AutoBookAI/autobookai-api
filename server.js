require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const { pool, initDB } = require('./db');

const app = express();

// ── Trust proxy (Railway sits behind a reverse proxy) ─────────────────────────
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── Stripe webhook — must receive raw body ─────────────────────────────────────
app.use(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  require('./routes/stripe-webhook')
);

// ── Twilio WhatsApp webhook — receives URL-encoded form data ────────────────────
app.use(
  '/webhook/twilio',
  express.urlencoded({ extended: false }),
  require('./routes/whatsapp-webhook')
);

// ── Standard middleware ────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' })); // Prevent large payload attacks
app.use(cors({
  origin: function(origin, callback) {
    // Allow: dashboard frontend, OpenClaw instances on Railway, and no-origin (server-to-server)
    if (!origin
        || origin === (process.env.FRONTEND_URL || 'http://localhost:3000')
        || origin.endsWith('.up.railway.app')) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
}));

// ── Rate limiting ──────────────────────────────────────────────────────────────
app.use('/api/auth',           rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));  // Strict on auth
app.use('/api/signup',         rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));  // Strict on signup
app.use('/api/customer/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));  // Customer login
app.use('/api',                rateLimit({ windowMs: 15 * 60 * 1000, max: 300 })); // General

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth/social', require('./routes/social-auth')); // Social OAuth (Google, FB, etc.)
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/signup',    require('./routes/signup'));   // Public self-signup
app.use('/api/customers', require('./routes/customers'));
app.use('/api/billing',   require('./routes/billing'));
app.use('/api/numbers',   require('./routes/numbers'));
app.use('/api/tools',     require('./routes/tools'));    // Tool endpoints for OpenClaw instances
app.use('/api/customer',  require('./routes/customer-auth')); // Customer portal

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'disconnected', ts: new Date().toISOString() });
  }
});
app.get('/',       (_, res) => res.json({ service: 'WhatsApp AI Assistant API', version: '2.0.0' }));

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
initDB()
  .then(() => {
    const server = app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));

    function shutdown(signal) {
      console.log(`${signal} received. Shutting down gracefully...`);
      server.close(async () => {
        try { await pool.end(); } catch {}
        console.log('Shutdown complete.');
        process.exit(0);
      });
      setTimeout(() => { process.exit(1); }, 10000);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
