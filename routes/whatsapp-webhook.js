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

// ── Phone number normalization ────────────────────────────────────────────
// Strips all non-digit characters, ensures leading +1 for US numbers
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/[^\d]/g, '');
  // If 10 digits, assume US — prepend +1
  if (digits.length === 10) return '+1' + digits;
  // If 11 digits starting with 1, prepend +
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  // Otherwise return as +digits
  return '+' + digits;
}

const SIGNUP_URL = 'https://dashboard-production-0a18.up.railway.app/signup';
const PORTAL_URL = 'https://dashboard-production-0a18.up.railway.app/portal';

// ── OpenClaw integration — detect and route action tasks ──────────────────

function needsOpenClawAction(message) {
  const actionPatterns = [
    /(?:book|reserve|make a reservation|schedule|sign up|register|order|buy|purchase)/i,
    /(?:go to|visit|open|check|look up|search|find|browse)\s+(?:the\s+)?(?:website|site|page|url|link|http)/i,
    /(?:fill out|fill in|submit|complete)\s+(?:the\s+)?(?:form|application|registration|signup)/i,
    /(?:look up|search for|find|check)\s+(?:prices?|availability|hours|menu|schedule|listings?|reviews?)/i,
    /(?:go online|go on the internet|use the internet|browse the web)/i,
    /(?:opentable|yelp|google maps|airbnb|booking\.com|amazon|ebay|zillow|expedia|kayak)/i,
    /(?:what are the hours|is .+ open|how much does|what's the price|menu|availability)/i,
  ];
  return actionPatterns.some(pattern => pattern.test(message));
}

async function sendToOpenClaw(task, customerPhone) {
  const OPENCLAW_URL = process.env.OPENCLAW_URL;
  if (!OPENCLAW_URL) {
    console.log('[OPENCLAW] No OPENCLAW_URL configured, skipping');
    return null;
  }
  try {
    console.log('[OPENCLAW] Sending task:', task.substring(0, 200));
    const response = await fetch(`${OPENCLAW_URL}/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: task,
        name: `WhatsApp task from ${customerPhone}`,
        timeout: 120
      })
    });
    const data = await response.json();
    console.log('[OPENCLAW] Response:', JSON.stringify(data).substring(0, 500));
    return data;
  } catch (err) {
    console.error('[OPENCLAW] Error:', err.message);
    return null;
  }
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
    // ── Step 1: Look up customer ─────────────────────────────────────
    // Sandbox mode: all messages go to the shared sandbox number, so we
    // look up the customer by their personal phone (From) which is stored
    // in whatsapp_to. Production mode: each customer has a dedicated
    // Twilio number, so we look up by the Twilio number (To).
    const sandboxNumber = process.env.TWILIO_WHATSAPP_NUMBER;
    const isSandbox = sandboxNumber && toNumber === sandboxNumber;

    const lookupNumber = isSandbox ? fromNumber : toNumber;
    const normalizedLookup = normalizePhone(lookupNumber);

    // Try exact match first, then normalized match
    let custResult = await pool.query(
      `SELECT c.id, c.name, c.subscription_status, c.whatsapp_from, c.plan
       FROM customers c
       WHERE c.whatsapp_to = $1`,
      [lookupNumber]
    );

    if (!custResult.rows.length && normalizedLookup !== lookupNumber) {
      custResult = await pool.query(
        `SELECT c.id, c.name, c.subscription_status, c.whatsapp_from, c.plan
         FROM customers c
         WHERE c.whatsapp_to = $1`,
        [normalizedLookup]
      );
    }

    // Also try matching by whatsapp_from (sender's number) in sandbox mode
    if (!custResult.rows.length && isSandbox) {
      custResult = await pool.query(
        `SELECT c.id, c.name, c.subscription_status, c.whatsapp_from, c.plan
         FROM customers c
         WHERE c.whatsapp_from = $1 OR c.whatsapp_from = $2`,
        [fromNumber, normalizedLookup]
      );
    }

    if (!custResult.rows.length) {
      console.warn(`No customer found for ${isSandbox ? 'sender' : 'number'} ${lookupNumber}`);
      await sendWhatsAppReply(toNumber, fromNumber,
        `Hey! You need a Kova account to use this service. Sign up at ${SIGNUP_URL}`);
      return;
    }

    const customer = custResult.rows[0];

    // ── Step 2: Validate customer status ────────────────────────────────
    if (customer.subscription_status !== 'active') {
      await sendWhatsAppReply(toNumber, fromNumber,
        `Your Kova subscription isn't active. Manage your billing at ${PORTAL_URL}`);
      return;
    }

    // ── Step 3: Check daily message limit ──────────────────────────────
    const PLAN_LIMITS = { pro: 100, assistant: 30 };
    const UNLIMITED_CUSTOMER_IDS = [1]; // Platform owner — no daily limit

    if (!UNLIMITED_CUSTOMER_IDS.includes(customer.id)) {
      const dailyLimit = PLAN_LIMITS[customer.plan] || 30;
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM conversations
         WHERE customer_id = $1 AND role = 'user'
           AND created_at >= NOW() - INTERVAL '24 hours'`,
        [customer.id]
      );
      const dailyCount = parseInt(countResult.rows[0].count, 10);
      if (dailyCount >= dailyLimit) {
        const upgradeHint = customer.plan !== 'pro' ? ' Upgrade to Kova Pro for 100 messages/day.' : '';
        await sendWhatsAppReply(toNumber, fromNumber,
          `You've reached your daily message limit (${dailyLimit} messages). Your limit resets in 24 hours.${upgradeHint}`);
        return;
      }
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

    // ── Step 6: Check if this needs OpenClaw (web browsing / action) ──
    if (needsOpenClawAction(messageContent) && process.env.OPENCLAW_URL) {
      await sendWhatsAppReply(toNumber, fromNumber,
        "On it! I'm looking into that for you now. This might take a minute...");

      const openclawResult = await sendToOpenClaw(messageContent, fromNumber);

      if (openclawResult && openclawResult.response) {
        const chunks = splitMessage(openclawResult.response, 1500);
        for (const chunk of chunks) {
          await sendWhatsAppReply(toNumber, fromNumber, chunk);
        }
        console.log(`✅ OpenClaw replied to ${fromNumber} (customer ${customer.id})`);
        await pool.query(
          `INSERT INTO activity_log (customer_id, event_type, description, metadata)
           VALUES ($1, 'openclaw_task', $2, $3)`,
          [customer.id, `OpenClaw task from ${fromNumber}`, JSON.stringify({
            message_sid: MessageSid, from: fromNumber, task: messageContent.substring(0, 200),
          })]
        );
        return;
      }
      // If OpenClaw failed or returned nothing, fall through to Claude
      console.log('[OPENCLAW] No result, falling through to Claude');
    }

    // ── Step 7: Send to shared Claude assistant ────────────────────────
    console.log(`🤖 Sending to Claude for customer ${customer.id}`);
    const replyText = await handleMessage(customer.id, messageContent);

    // ── Step 8: Send AI response back via WhatsApp ──────────────────────
    // WhatsApp has a 1600 char limit per message — split if needed
    const chunks = splitMessage(replyText, 1500);
    for (const chunk of chunks) {
      await sendWhatsAppReply(toNumber, fromNumber, chunk);
    }

    console.log(`✅ Replied to ${fromNumber} (customer ${customer.id}, ${chunks.length} msg${chunks.length > 1 ? 's' : ''})`);

    // ── Step 9: Log to activity_log ─────────────────────────────────────
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
