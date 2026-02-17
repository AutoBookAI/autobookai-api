/**
 * WhatsApp Webhook — receives inbound messages from Twilio and routes
 * them to the correct customer's OpenClaw AI instance.
 *
 * Flow:
 *  1. Twilio sends POST with From, To, Body (URL-encoded)
 *  2. We verify the Twilio signature
 *  3. Respond immediately with empty TwiML (avoids 15s timeout)
 *  4. Background: look up customer → forward to OpenClaw → send reply via Twilio REST API
 *
 * Auth: Twilio signature verification (HMAC of URL + body params using TWILIO_AUTH_TOKEN)
 * Body: application/x-www-form-urlencoded (parsed by express.urlencoded in server.js)
 */

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { handleMessage } = require('../services/assistant');

// ── Rate limiting — keyed on sender phone number, not IP ──────────────────
// Twilio sends all webhooks from shared IPs, so IP-based limiting would
// block all customers at once. Per-sender limiting prevents a single
// phone number from flooding the system.
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.body?.From || req.ip,
  handler: (req, res) => {
    res.type('text/xml').status(429).send('<Response/>');
  },
});

// ── Twilio signature verification ─────────────────────────────────────────
// Prevents spoofed webhook calls. Twilio signs every request using
// the auth token + the full public URL + the POST body params.
function validateTwilioSignature(req, res, next) {
  const twilio = require('twilio');
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('TWILIO_AUTH_TOKEN not set — cannot validate webhook');
    return res.type('text/xml').status(500).send('<Response/>');
  }

  // Twilio signs against the full public URL. Behind Railway's proxy,
  // we reconstruct it from MASTER_API_URL (same env var used in railway.js).
  const webhookUrl = `${process.env.MASTER_API_URL}/webhook/twilio`;

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    console.warn('Missing X-Twilio-Signature header');
    return res.type('text/xml').status(403).send('<Response/>');
  }

  const isValid = twilio.validateRequest(
    authToken,
    signature,
    webhookUrl,
    req.body
  );

  if (!isValid) {
    console.warn('Invalid Twilio signature — rejecting webhook');
    return res.type('text/xml').status(403).send('<Response/>');
  }

  next();
}

// ── Main webhook handler ──────────────────────────────────────────────────
router.post('/', webhookLimiter, validateTwilioSignature, async (req, res) => {
  // Respond immediately with empty TwiML — Twilio requires a response
  // within 15 seconds. We send the AI's reply asynchronously via REST API.
  res.type('text/xml').status(200).send('<Response/>');

  const {
    From,                // e.g. "whatsapp:+14155551234"
    To,                  // e.g. "whatsapp:+18005551234"
    Body,                // Message text
    NumMedia,            // Number of media attachments
    MessageSid,          // Unique message ID from Twilio
  } = req.body;

  // Strip "whatsapp:" prefix to get raw E.164 numbers
  const fromNumber = From?.replace('whatsapp:', '');
  const toNumber = To?.replace('whatsapp:', '');

  if (!fromNumber || !toNumber) {
    console.error('Webhook missing From/To fields');
    return;
  }

  console.log(`📨 WhatsApp from ${fromNumber} to ${toNumber}: "${(Body || '').slice(0, 80)}"`);

  try {
    // ── Step 1: Look up customer by their assigned Twilio number ────────
    const custResult = await pool.query(
      `SELECT c.id, c.name, c.subscription_status, c.whatsapp_from
       FROM customers c
       WHERE c.whatsapp_to = $1`,
      [toNumber]
    );

    if (!custResult.rows.length) {
      console.warn(`No customer found for number ${toNumber}`);
      await sendWhatsAppReply(toNumber, fromNumber,
        'Sorry, this number is not currently active. Please contact support.');
      return;
    }

    const customer = custResult.rows[0];

    // ── Step 2: Validate customer status ────────────────────────────────
    if (customer.subscription_status !== 'active') {
      await sendWhatsAppReply(toNumber, fromNumber,
        `Your subscription is not currently active. Please visit ${process.env.FRONTEND_URL}/portal to reactivate.`);
      return;
    }

    // ── Step 3: Check daily message limit (100 messages/day) ────────────
    const DAILY_MESSAGE_LIMIT = 30;
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM conversations
       WHERE customer_id = $1 AND role = 'user'
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [customer.id]
    );
    const dailyCount = parseInt(countResult.rows[0].count, 10);
    if (dailyCount >= DAILY_MESSAGE_LIMIT) {
      await sendWhatsAppReply(toNumber, fromNumber,
        `You've reached your daily message limit (${DAILY_MESSAGE_LIMIT} messages). Your limit resets in 24 hours. Need more? Contact support to upgrade your plan.`);
      return;
    }

    // ── Step 4: Auto-learn whatsapp_from on first message ───────────────
    if (!customer.whatsapp_from) {
      await pool.query(
        'UPDATE customers SET whatsapp_from = $1, updated_at = NOW() WHERE id = $2',
        [fromNumber, customer.id]
      );
      console.log(`📱 Learned whatsapp_from for customer ${customer.id}: ${fromNumber}`);
    }

    // ── Step 5: Build message content ───────────────────────────────────
    let messageContent = Body || '';

    // Handle media attachments (images, audio, documents)
    const numMedia = parseInt(NumMedia) || 0;
    if (numMedia > 0) {
      const mediaDescriptions = [];
      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = req.body[`MediaUrl${i}`];
        const mediaType = req.body[`MediaContentType${i}`];
        if (mediaUrl) {
          mediaDescriptions.push(`[Attached ${mediaType || 'file'}: ${mediaUrl}]`);
        }
      }
      if (mediaDescriptions.length) {
        messageContent = messageContent
          ? `${messageContent}\n\n${mediaDescriptions.join('\n')}`
          : mediaDescriptions.join('\n');
      }
    }

    if (!messageContent.trim()) {
      console.warn(`Empty message from ${fromNumber} — ignoring`);
      return;
    }

    // ── Step 6: Send to shared Claude assistant ────────────────────────
    console.log(`🤖 Sending to Claude for customer ${customer.id}`);
    const replyText = await handleMessage(customer.id, messageContent);

    // ── Step 7: Send AI response back via WhatsApp ──────────────────────
    // WhatsApp has a 1600 char limit per message — split if needed
    const chunks = splitMessage(replyText, 1500);
    for (const chunk of chunks) {
      await sendWhatsAppReply(toNumber, fromNumber, chunk);
    }

    console.log(`✅ Replied to ${fromNumber} (customer ${customer.id}, ${chunks.length} msg${chunks.length > 1 ? 's' : ''})`);

    // ── Step 8: Log to activity_log ─────────────────────────────────────
    await pool.query(
      `INSERT INTO activity_log (customer_id, event_type, description, metadata)
       VALUES ($1, 'whatsapp_message', $2, $3)`,
      [
        customer.id,
        `WhatsApp message from ${fromNumber}`,
        JSON.stringify({
          message_sid: MessageSid,
          from: fromNumber,
          has_media: numMedia > 0,
          response_length: replyText.length,
        }),
      ]
    );

  } catch (err) {
    console.error('WhatsApp webhook error:', err);
    try {
      await sendWhatsAppReply(toNumber, fromNumber,
        'Sorry, I encountered an error processing your message. Please try again.');
    } catch (replyErr) {
      console.error('Failed to send error reply:', replyErr.message);
    }
  }
});

// ── Helper: Send WhatsApp message via Twilio REST API ─────────────────────

let _twilioClient = null;

function getTwilioClient() {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio not configured');
  _twilioClient = require('twilio')(sid, token);
  return _twilioClient;
}

async function sendWhatsAppReply(from, to, body) {
  const client = getTwilioClient();
  await client.messages.create({
    from: `whatsapp:${from}`,
    to: `whatsapp:${to}`,
    body,
  });
}

// ── Helper: Split long messages for WhatsApp's 1600 char limit ────────────

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Split at paragraph break, then sentence end, then word boundary
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex < maxLength * 0.3) splitIndex = remaining.lastIndexOf('. ', maxLength);
    if (splitIndex < maxLength * 0.3) splitIndex = remaining.lastIndexOf(' ', maxLength);
    if (splitIndex < maxLength * 0.3) splitIndex = maxLength;

    chunks.push(remaining.slice(0, splitIndex + 1).trim());
    remaining = remaining.slice(splitIndex + 1).trim();
  }
  return chunks;
}

module.exports = router;
