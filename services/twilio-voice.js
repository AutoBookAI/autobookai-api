/**
 * Twilio Voice — make outbound phone calls with TTS.
 *
 * The AI agent can:
 *  1. Call a number and speak a message (one-way TTS)
 *  2. Call a number and connect to a human (call forwarding)
 *
 * Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 */

let twilioClient = null;

function getClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio not configured (missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)');
  twilioClient = require('twilio')(sid, token);
  return twilioClient;
}

/**
 * Make an outbound call and speak a TTS message.
 *
 * @param {object} opts
 * @param {string} opts.to       - Phone number to call (E.164 format)
 * @param {string} opts.message  - Text to speak via TTS
 * @param {string} opts.from     - Caller ID (customer's Twilio number)
 * @param {string} [opts.voice]  - TTS voice (default: 'Polly.Joanna')
 * @returns {{ callSid, status }}
 */
// Allowlisted Twilio TTS voices — prevents TwiML injection via voice param
const ALLOWED_VOICES = new Set([
  'Polly.Joanna', 'Polly.Matthew', 'Polly.Amy', 'Polly.Brian',
  'Polly.Kendra', 'Polly.Kimberly', 'Polly.Salli', 'Polly.Joey',
  'Polly.Ivy', 'Polly.Justin', 'Polly.Ruth', 'Polly.Stephen',
  'Google.en-US-Standard-A', 'Google.en-US-Standard-B',
  'Google.en-US-Standard-C', 'Google.en-US-Standard-D',
]);

async function makeCall({ to, message, from, voice }) {
  if (!to || !message) throw new Error('Missing required fields: to, message');

  // Validate phone number format (E.164)
  if (!/^\+[1-9]\d{1,14}$/.test(to)) {
    throw new Error('Invalid phone number format. Use E.164 format (e.g. +14155551234)');
  }

  const client = getClient();
  const callerNumber = from || process.env.TWILIO_PHONE_NUMBER;
  if (!callerNumber) throw new Error('No caller number. Set TWILIO_PHONE_NUMBER or pass from.');

  // Validate voice against allowlist — prevents TwiML attribute injection
  const safeVoice = ALLOWED_VOICES.has(voice) ? voice : 'Polly.Joanna';

  // TwiML that speaks the message then hangs up
  const twiml = `<Response><Say voice="${safeVoice}">${escapeXml(message)}</Say></Response>`;

  const call = await client.calls.create({
    to,
    from: callerNumber,
    twiml,
  });

  console.log(`📞 Call initiated for ${to}: ${call.sid}`);
  return { callSid: call.sid, status: call.status };
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

module.exports = { makeCall, getCallStatus };
