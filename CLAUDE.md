# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Backend API for the WhatsApp AI Assistant SaaS platform. Handles customer management, Stripe billing, WhatsApp message routing (via Twilio), and per-customer OpenClaw AI agent provisioning on Railway. The frontend dashboard lives in `../dashboard`.

## Commands

```bash
npm start            # Production: node server.js
npm run dev          # Development: nodemon server.js
```

## Environment Variables

See `.env.example` for the full list. Critical ones:

- `DATABASE_URL` — PostgreSQL connection string (Railway auto-sets)
- `JWT_SECRET` — 32+ chars, HS256 signing. Server refuses to start if weak.
- `ENCRYPTION_KEY` — 32+ chars, AES-256-GCM master key. Server refuses to start if missing.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` — Stripe billing
- `RAILWAY_API_TOKEN`, `RAILWAY_PROJECT_ID` — Railway GraphQL API for OpenClaw provisioning
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — WhatsApp messaging
- `ANTHROPIC_API_KEY` — Passed to each customer's OpenClaw instance
- `MASTER_API_URL` — Public URL of this API (used for Twilio signature verification and tools API callbacks)
- `FRONTEND_URL` — Dashboard URL (used for CORS, Stripe redirects, WhatsApp messages)

## Architecture

### Request Flow

```
Customer WhatsApp → Twilio → /webhook/twilio → lookup customer → forward to OpenClaw → reply via Twilio REST
Customer signup   → /api/signup → Stripe Checkout → /webhook/stripe → assign number + provision OpenClaw
OpenClaw AI tools → /api/tools/:customerId/* → email, call, search, calendar, browser
```

### Middleware Order (server.js)

**Order matters.** Stripe and Twilio webhooks MUST be mounted before `express.json()` because they need raw/urlencoded bodies respectively.

```
1. helmet()
2. /webhook/stripe    (express.raw)
3. /webhook/twilio    (express.urlencoded)
4. express.json({ limit: '10kb' })
5. CORS
6. Rate limiting (per-route)
7. API routes
```

### Auth Patterns

| Context | Mechanism | Middleware | Claim |
|---------|-----------|-----------|-------|
| Admin dashboard | JWT Bearer | `middleware/auth.js` | `adminId` |
| Customer portal | JWT Bearer | `middleware/customerAuth.js` | `customerId` |
| OpenClaw tools | HMAC (`timestamp.hmac`) | inline in `routes/tools.js` | `customerId` from URL |
| Stripe webhook | Signature header | `stripe.webhooks.constructEvent` | — |
| Twilio webhook | Signature header | `twilio.validateRequest` | — |

JWT tokens use **HS256 algorithm pinning** to prevent `alg:none` attacks.

### Encryption (services/encryption.js)

AES-256-GCM with **per-customer key derivation** via HKDF:
- Master key: `ENCRYPTION_KEY` env var
- Customer key: `HKDF(SHA256, masterKey, customerId)`
- Format: `iv:authTag:ciphertext`

Functions: `encrypt(plaintext, customerId)`, `decrypt(ciphertext, customerId)`, `encryptJSON(obj, customerId)`, `decryptJSON(ciphertext, customerId)`.

Encrypted fields: `loyalty_numbers`, `passport_number`, `date_of_birth`, `openclaw_password`, `gmail_app_password`, `google_calendar_token`.

### Profile Updates & COALESCE

Profile PATCH routes use `COALESCE($1, column)` so only provided fields update. For encrypted fields, empty string `""` is converted to `null` before the query to allow clearing the field (otherwise COALESCE would keep the old value).

## API Routes

### Admin (require `middleware/auth.js`)
```
POST   /api/auth/register              — One-time setup (requires SETUP_KEY)
POST   /api/auth/login                 — Admin login
GET    /api/auth/me                    — Current admin
GET    /api/customers                  — List customers
POST   /api/customers                  — Create customer + provision OpenClaw
GET    /api/customers/:id              — Customer detail + decrypted profile
PATCH  /api/customers/:id/profile      — Update preferences + sync to OpenClaw
POST   /api/customers/:id/reprovision  — Retry failed deployment
DELETE /api/customers/:id              — Delete customer + deprovision
POST   /api/billing/checkout           — Stripe checkout session
POST   /api/billing/portal             — Stripe billing portal
```

### Customer Portal (require `middleware/customerAuth.js`)
```
POST   /api/customer/login             — Customer login
GET    /api/customer/me                — Safe customer fields
GET    /api/customer/profile           — Decrypted preferences
PATCH  /api/customer/profile           — Update preferences + sync to OpenClaw
POST   /api/customer/billing/portal    — Stripe billing portal
GET    /api/customer/activity           — Paginated activity log
```

### Public
```
POST   /api/signup                     — Create account → Stripe Checkout URL
GET    /api/signup/status?session_id=  — Poll for number assignment
```

### Webhooks
```
POST   /webhook/stripe                 — Stripe events (idempotent via processed_stripe_events table)
POST   /webhook/twilio                 — WhatsApp messages (Twilio signature verified)
```

### Tools (HMAC auth, called by OpenClaw instances)
```
POST   /api/tools/:customerId/email    — Send email via customer's Gmail
POST   /api/tools/:customerId/call     — Make phone call via Twilio
POST   /api/tools/:customerId/search   — Web search (Brave/SERP)
POST   /api/tools/:customerId/fetch    — Fetch webpage (SSRF-protected)
GET    /api/tools/:customerId/calendar — List calendar events
POST   /api/tools/:customerId/calendar — Create calendar event
```

## Database Schema (db.js)

Tables: `admins`, `customers`, `customer_profiles`, `whatsapp_numbers`, `activity_log`, `processed_stripe_events`.

Key relationships:
- `customers.admin_id` → `admins.id`
- `customer_profiles.customer_id` → `customers.id` (1:1)
- `whatsapp_numbers.customer_id` → `customers.id`
- `activity_log.customer_id` → `customers.id`

Indexes: `idx_customers_whatsapp_to`, `idx_customers_stripe_sub_id`, `idx_activity_log_customer_id`.

Schema auto-creates on startup via `initDB()`. Migrations use `ADD COLUMN IF NOT EXISTS` — safe to re-run.

## Key Services

- **`services/railway.js`** — Provisions OpenClaw instances via Railway GraphQL API. Creates service, domain, env vars, triggers deploy, polls health.
- **`services/openclaw.js`** — Syncs customer profile to OpenClaw memory, sends messages, checks health. `buildMemoryDocument()` formats profile as structured text.
- **`services/encryption.js`** — AES-256-GCM with HKDF per-customer keys.
- **`services/email.js`** — Sends email via customer's Gmail app password (nodemailer).
- **`services/twilio-voice.js`** — Makes phone calls via Twilio, generates TwiML.
- **`services/web-search.js`** — Web search via Brave Search API with fallback to SERP API.

## Deployment

Railway.app via Nixpacks. Config in `railway.json`. Deploy with `railway up` from this directory. Health check at `GET /health` verifies DB connectivity. Server handles SIGTERM/SIGINT for graceful shutdown.

## Stripe Webhook Flow

`checkout.session.completed` → activate subscription → assign WhatsApp number from pool → provision OpenClaw (async). This happens AFTER payment, not at signup. The `processed_stripe_events` table prevents duplicate processing.
