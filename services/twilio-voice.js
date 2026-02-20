/**
 * Twilio Voice — conversational AI phone calls.
 *
 * When the AI calls someone, it has a real back-and-forth conversation using:
 *  - Twilio <Gather input="speech"> for speech-to-text
 *  - Claude for generating contextual responses
 *  - Twilio <Say> for text-to-speech
 *
 * Call sessions are stored in-memory (Map) keyed by UUID.
 * The voice-webhook route handles the Twilio callback loop.
 *
 * Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, MASTER_API_URL
 */

const crypto = require('crypto');

let twilioClient = null;

function getClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio not configured (missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)');
  twilioClient = require('twilio')(sid, token);
  return twilioClient;
}

// Allowlisted Twilio TTS voices — prevents TwiML attribute injection
const ALLOWED_VOICES = new Set([
  'Polly.Joanna', 'Polly.Matthew', 'Polly.Amy', 'Polly.Brian',
  'Polly.Kendra', 'Polly.Kimberly', 'Polly.Salli', 'Polly.Joey',
  'Polly.Ivy', 'Polly.Justin', 'Polly.Ruth', 'Polly.Stephen',
  'Google.en-US-Standard-A', 'Google.en-US-Standard-B',
  'Google.en-US-Standard-C', 'Google.en-US-Standard-D',
  // Neural / natural-sounding voices
  'Google.en-US-Neural2-F', 'Google.en-US-Neural2-D',
  'Google.en-US-Neural2-A', 'Google.en-US-Neural2-C',
  'Polly.Joanna-Neural', 'Polly.Matthew-Neural',
]);

// Map customer's Kova voice preference to a natural-sounding TTS voice
const VOICE_FOR_PREFERENCE = {
  'Kova (Female)': 'Google.en-US-Neural2-F',
  'Kova (Male)':   'Google.en-US-Neural2-D',
};
const DEFAULT_VOICE = 'Google.en-US-Neural2-F';

// ── Active call sessions ────────────────────────────────────────────────────
// Keyed by callId (UUID). Each session holds conversation state for the voice webhook.

const activeCallSessions = new Map();

// Clean up stale sessions every 30 minutes (calls should never last that long)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeCallSessions) {
    if (now - session.createdAt > 30 * 60 * 1000) {
      activeCallSessions.delete(id);
    }
  }
}, 30 * 60 * 1000);

/**
 * Make an outbound conversational call.
 *
 * The call connects to our voice webhook which handles the back-and-forth
 * conversation using Twilio Gather + Claude.
 *
 * @param {object} opts
 * @param {string} opts.to        - Phone number to call (E.164 format)
 * @param {string} opts.message   - Initial greeting to speak when the call connects
 * @param {string} opts.purpose   - Goal of the call (e.g. "book a table for 4 at 7pm")
 * @param {number} opts.customerId - Customer ID for profile loading
 * @param {string} [opts.from]    - Caller ID override
 * @param {string} [opts.voice]   - TTS voice (default: 'Polly.Joanna')
 * @returns {{ callSid, status, callId, mode }}
 */
async function makeCall({ to, message, from, voice, customerId, purpose }) {
  if (!to || !message) throw new Error('Missing required fields: to, message');

  // Validate phone number format (E.164)
  if (!/^\+[1-9]\d{1,14}$/.test(to)) {
    throw new Error('Invalid phone number format. Use E.164 format (e.g. +14155551234)');
  }

  const client = getClient();
  const callerNumber = from || process.env.TWILIO_PHONE_NUMBER;
  if (!callerNumber) throw new Error('No caller number. Set TWILIO_PHONE_NUMBER or pass from.');

  const masterApiUrl = process.env.MASTER_API_URL;
  if (!masterApiUrl) throw new Error('MASTER_API_URL not set — needed for voice webhooks');

  // Generate unique call ID for session tracking
  const callId = crypto.randomUUID();

  // Load customer info for the call session
  let customerName = 'a client';
  let customerWhatsappFrom = null;
  let profileSummary = '';
  let assistantName = null;

  if (customerId) {
    const { pool } = require('../db');
    const custResult = await pool.query(
      'SELECT name, whatsapp_from FROM customers WHERE id=$1',
      [customerId]
    );
    if (custResult.rows.length) {
      customerName = custResult.rows[0].name;
      customerWhatsappFrom = custResult.rows[0].whatsapp_from;
    }
    const profileResult = await pool.query(
      `SELECT dietary_restrictions, cuisine_preferences, preferred_restaurants,
              dining_budget, preferred_airlines, seat_preference, cabin_class,
              hotel_preferences, full_name, assistant_name
       FROM customer_profiles WHERE customer_id=$1`,
      [customerId]
    );
    if (profileResult.rows.length) {
      const p = profileResult.rows[0];
      assistantName = p.assistant_name || null;
      const parts = [];
      if (p.full_name) parts.push(`Full name: ${p.full_name}`);
      if (p.dietary_restrictions) parts.push(`Dietary restrictions: ${p.dietary_restrictions}`);
      if (p.cuisine_preferences) parts.push(`Cuisine preferences: ${p.cuisine_preferences}`);
      if (p.preferred_restaurants) parts.push(`Preferred restaurants: ${p.preferred_restaurants}`);
      if (p.dining_budget) parts.push(`Dining budget: ${p.dining_budget}`);
      if (p.preferred_airlines) parts.push(`Preferred airlines: ${p.preferred_airlines}`);
      if (p.seat_preference) parts.push(`Seat preference: ${p.seat_preference}`);
      if (p.cabin_class) parts.push(`Cabin class: ${p.cabin_class}`);
      if (p.hotel_preferences) parts.push(`Hotel preferences: ${p.hotel_preferences}`);
      profileSummary = parts.join('\n');
    }
  }

  // Select voice: explicit override → customer preference → default neural voice
  let safeVoice;
  if (voice && ALLOWED_VOICES.has(voice)) {
    safeVoice = voice;
  } else if (assistantName && VOICE_FOR_PREFERENCE[assistantName]) {
    safeVoice = VOICE_FOR_PREFERENCE[assistantName];
  } else {
    safeVoice = DEFAULT_VOICE;
  }

  // Determine voice gender for ElevenLabs
  const voiceGender = (assistantName === 'Kova (Male)') ? 'male' : 'female';

  // Store session for the voice webhook
  activeCallSessions.set(callId, {
    customerId,
    customerName,
    customerWhatsappFrom,
    to,
    purpose: purpose || message,
    initialMessage: message,
    voice: safeVoice,
    voiceGender,
    history: [],
    profileSummary,
    createdAt: Date.now(),
  });

  // Create the call with webhook URL (not inline TwiML)
  const call = await client.calls.create({
    to,
    from: callerNumber,
    url: `${masterApiUrl}/voice/outbound?callId=${encodeURIComponent(callId)}`,
    statusCallback: `${masterApiUrl}/voice/status?callId=${encodeURIComponent(callId)}`,
    statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer'],
  });

  console.log(`📞 Conversational call initiated to ${to}: ${call.sid} (callId: ${callId})`);
  return { callSid: call.sid, status: call.status, callId, mode: 'conversational' };
}

/**
 * Get the status of an ongoing/completed call.
 */
async function getCallStatus(callSid) {
  const client = getClient();
  const call = await client.calls(callSid).fetch();
  return {
    callSid: call.sid,
    status: call.status,
    duration: call.duration,
    to: call.to,
    from: call.from,
    startTime: call.startTime,
    endTime: call.endTime,
  };
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { makeCall, getCallStatus, activeCallSessions, escapeXml };
