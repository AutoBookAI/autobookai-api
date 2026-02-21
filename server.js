require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const os        = require('os');
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

// ── Twilio Voice webhook — Gather + ElevenLabs Play ─────────────────────────────
app.use(
  '/webhook/voice',
  express.urlencoded({ extended: true }),
  require('./routes/voice-webhook')
);

// ── Serve generated voice audio files ───────────────────────────────────────────
app.use('/voice-audio', express.static(path.join(os.tmpdir(), 'voice-audio')));

// ── Standard middleware ────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(cors({
  origin: function(origin, callback) {
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
app.use('/api/auth',           rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api/signup',         rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));
app.use('/api/customer/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use('/api',                rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth/social', require('./routes/social-auth'));
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/signup',    require('./routes/signup'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/billing',   require('./routes/billing'));
app.use('/api/numbers',   require('./routes/numbers'));
app.use('/api/tools',     require('./routes/tools'));
app.use('/api/customer',  require('./routes/customer-auth'));
app.use('/webhook/elevenlabs', require('./routes/elevenlabs-webhook'));

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'disconnected', ts: new Date().toISOString() });
  }
});
app.get('/', (_, res) => res.json({ service: 'WhatsApp AI Assistant API', version: '2.0.0' }));

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
  })
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
