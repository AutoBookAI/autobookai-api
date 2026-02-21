/**
 * Voice calls — ElevenLabs Conversational AI outbound calls via Twilio.
 *
 * Outbound calls are initiated through the ElevenLabs Conversational AI API,
 * which handles the full voice conversation (STT, LLM, TTS) autonomously.
 * Customer context is passed as dynamic variables to the ElevenLabs agent.
 *
 * Post-call, the ElevenLabs webhook sends a summary which we route back
 * to the customer via WhatsApp using the pendingCalls map.
 *
 * Requires: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID
 */

// ── Active call sessions ────────────────────────────────────────────────────
// Keyed by callId (UUID). Each session holds conversation state for the voice webhook.

const activeCallSessions = new Map();

// ── Pending calls ───────────────────────────────────────────────────────────
// Keyed by ElevenLabs conversation_id. Used by the post-call webhook to look up
// which customer the call belonged to so we can send a WhatsApp summary.

const pendingCalls = new Map();

// Clean up stale sessions every 30 minutes (calls should never last that long)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeCallSessions) {
    if (now - session.createdAt > 30 * 60 * 1000) {
      activeCallSessions.delete(id);
    }
  }
  for (const [id, entry] of pendingCalls) {
    if (now - entry.createdAt > 30 * 60 * 1000) {
      pendingCalls.delete(id);
    }
  }
}, 30 * 60 * 1000);

/**
 * Make an outbound conversational call via ElevenLabs Conversational AI.
 *
 * ElevenLabs handles the full voice conversation autonomously (STT, LLM, TTS).
 * Customer context is passed as dynamic variables to the ElevenLabs agent.
 *
 * @param {object} opts
 * @param {string} opts.to           - Phone number to call (E.164 format)
 * @param {string} opts.message      - Initial greeting / context for the call
 * @param {string} opts.purpose      - Goal of the call (e.g. "book a table for 4 at 7pm")
 * @param {string} opts.task         - Structured task description for the ElevenLabs agent
 * @param {string} opts.preferences  - Customer preferences for the call (times, party size, etc.)
 * @param {number} opts.customerId   - Customer ID for profile loading
 * @returns {{ conversationId, callSid, status, mode }}
 */
async function makeCall({ to, message, customerId, purpose, task, preferences }) {
  if (!to || !message) throw new Error('Missing required fields: to, message');

  // Validate phone number format (E.164)
  if (!/^\+[1-9]\d{1,14}$/.test(to)) {
    throw new Error('Invalid phone number format. Use E.164 format (e.g. +14155551234)');
  }

  // Validate ElevenLabs configuration
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const phoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
  if (!apiKey || !agentId || !phoneNumberId) {
    throw new Error('ElevenLabs not configured (missing ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, or ELEVENLABS_PHONE_NUMBER_ID)');
  }

  // Load customer info and voice clone for dynamic variables
  let customerName = 'a client';
  let customerWhatsappFrom = null;
  let voiceCloneId = null;

  if (customerId) {
    const { pool } = require('../db');
    const custResult = await pool.query(
      `SELECT c.name, c.whatsapp_from, cp.voice_clone_id
       FROM customers c
       LEFT JOIN customer_profiles cp ON cp.customer_id = c.id
       WHERE c.id=$1`,
      [customerId]
    );
    if (custResult.rows.length) {
      customerName = custResult.rows[0].name;
      customerWhatsappFrom = custResult.rows[0].whatsapp_from;
      voiceCloneId = custResult.rows[0].voice_clone_id || null;
    }
  }

  // Build ElevenLabs request body
  const requestBody = {
    agent_id: agentId,
    agent_phone_number_id: phoneNumberId,
    to_number: to,
    conversation_initiation_client_data: {
      dynamic_variables: {
        customer_name: customerName,
        purpose: purpose || message,
        initial_message: message,
        task: task || purpose || message,
        preferences: preferences || 'No specific preferences',
        customer_whatsapp: customerWhatsappFrom || '',
      },
    },
  };

  // Override agent voice with customer's cloned voice if available
  if (voiceCloneId) {
    requestBody.conversation_initiation_client_data.overrides = {
      agent: { tts: { voice_id: voiceCloneId } },
    };
    console.log(`🎙️ Using cloned voice ${voiceCloneId} for customer ${customerId}`);
  }

  // Call ElevenLabs Conversational AI outbound call API
  const response = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`ElevenLabs outbound call failed (${response.status}): ${errorBody}`);
  }

  const result = await response.json();
  const conversationId = result.conversation_id || null;
  const callSid = result.callSid || null;

  // Store in activeCallSessions (keyed by conversationId) for webhook lookups
  if (conversationId) {
    activeCallSessions.set(conversationId, {
      customerId,
      customerName,
      customerWhatsappFrom,
      to,
      purpose: purpose || message,
      initialMessage: message,
      createdAt: Date.now(),
    });

    // Store in pendingCalls for post-call webhook to send WhatsApp summaries
    pendingCalls.set(conversationId, {
      customerId,
      customerName,
      customerWhatsappFrom,
      purpose: purpose || message,
      to,
      createdAt: Date.now(),
    });
  }

  console.log(`📞 ElevenLabs outbound call initiated to ${to} (conversationId: ${conversationId}, callSid: ${callSid})`);

  // Store call context in call_memory for inbound callback awareness
  try {
    const { pool } = require('../db');
    await pool.query(
      `INSERT INTO call_memory (customer_id, customer_whatsapp, business_phone, business_name, call_purpose, call_task, call_preferences, elevenlabs_conversation_id, direction)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'outbound')`,
      [customerId, customerWhatsappFrom, to, task || purpose || message, purpose || message, task, preferences, conversationId]
    );
    console.log(`[CALL-MEMORY] Stored outbound call context: ${to} for customer ${customerId}`);
  } catch (memErr) {
    console.error('[CALL-MEMORY] Failed to store call context:', memErr.message);
  }

  return { conversationId, callSid, status: 'initiated', mode: 'elevenlabs' };
}

/**
 * Get the status of an ongoing/completed call via Twilio.
 */
async function getCallStatus(callSid) {
  let twilioClient = null;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio not configured (missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)');
  twilioClient = require('twilio')(sid, token);

  const call = await twilioClient.calls(callSid).fetch();
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

module.exports = { makeCall, getCallStatus, activeCallSessions, pendingCalls, escapeXml };
