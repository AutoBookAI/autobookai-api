/**
 * Voice Webhook — Twilio Gather + Say with Claude Haiku.
 *
 * Pure HTTP, no WebSockets. Twilio calls our endpoints, we return TwiML.
 *
 * Flow:
 *   1. Call comes in → GET/POST / → Say greeting + Gather (speech)
 *   2. Caller speaks → POST /respond → Claude Haiku → Say response + Gather (loop)
 *   3. Call ends → POST /status → clean up history
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { activeCallSessions, escapeXml } = require('../services/twilio-voice');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VOICE = 'Google.en-US-Chirp3-HD-Aoede';
const LANG = 'en-US';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 100;
const MAX_HISTORY = 8;

const DEFAULT_GREETING = 'Hi, this is Kova, your AI assistant. How can I help you today?';
const DEFAULT_SYSTEM = 'You are Kova, a friendly AI phone assistant. Reply in 1-2 short sentences. Sound natural and conversational like a real person on the phone. Never use markdown, lists, bullet points, asterisks, or any formatting. Never say as an AI or as a language model. Just talk like a helpful friend.';

// Conversation history per call, keyed by CallSid. Max 8 messages per call.
const callHistory = new Map();

// Clean up stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of callHistory) {
    if (now - entry.createdAt > 30 * 60 * 1000) {
      callHistory.delete(sid);
    }
  }
}, 10 * 60 * 1000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSessionForCall(req) {
  const callId = req.query.callId;
  if (callId && activeCallSessions.has(callId)) {
    return activeCallSessions.get(callId);
  }
  return null;
}

function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;
}

function sayTag(text, voice, lang) {
  return `  <Say voice="${voice || VOICE}" language="${lang || LANG}">${escapeXml(text)}</Say>`;
}

function gatherWithPrompt(actionPath, promptText, voice, lang) {
  const v = voice || VOICE;
  const l = lang || LANG;
  return [
    `  <Gather input="speech" speechTimeout="auto" action="${actionPath}" method="POST">`,
    `    <Say voice="${v}" language="${l}">${escapeXml(promptText)}</Say>`,
    `  </Gather>`,
  ].join('\n');
}

// ── GET and POST / — greeting + first Gather ────────────────────────────────

function handleIncoming(req, res) {
  try {
    const session = getSessionForCall(req);
    const callId = req.query.callId || '';
    const callSid = req.body?.CallSid || req.query.CallSid || 'unknown';

    let greeting = DEFAULT_GREETING;
    let voice = VOICE;

    if (session) {
      greeting = session.initialMessage || DEFAULT_GREETING;
      voice = session.voice || VOICE;
      console.log(`[VOICE] Outbound call connected: callId=${callId} callSid=${callSid} to=${session.to}`);
    } else {
      console.log(`[VOICE] Incoming call: callSid=${callSid}`);
    }

    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';

    res.type('text/xml').send(twiml([
      sayTag(greeting, voice),
      gatherWithPrompt(actionUrl, "I'm listening.", voice),
      sayTag("I didn't catch that, goodbye.", voice),
    ].join('\n')));

  } catch (err) {
    console.error('[VOICE] Incoming error:', err.message);
    res.type('text/xml').send(twiml(
      '  <Say>Sorry, something went wrong. Goodbye.</Say>'
    ));
  }
}

router.get('/', handleIncoming);
router.post('/', handleIncoming);

// ── POST /respond — Claude Haiku responds to caller speech ──────────────────

router.post('/respond', async (req, res) => {
  try {
    const speech = req.body.SpeechResult || '';
    const callSid = req.body.CallSid || 'unknown';
    const callId = req.query.callId || '';
    const session = getSessionForCall(req);

    const voice = session?.voice || VOICE;

    console.log(`[VOICE] [${callSid}] Caller said: "${speech}"`);

    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';

    if (!speech) {
      res.type('text/xml').send(twiml([
        sayTag("I didn't catch that. Could you say that again?", voice),
        gatherWithPrompt(actionUrl, "I'm listening.", voice),
        sayTag('Goodbye.', voice),
      ].join('\n')));
      return;
    }

    // Build system prompt with context from session
    let systemPrompt = DEFAULT_SYSTEM;
    if (session) {
      const parts = [DEFAULT_SYSTEM];
      if (session.purpose) parts.push(`Goal of this call: ${session.purpose}`);
      if (session.customerName) parts.push(`You are calling on behalf of: ${session.customerName}`);
      if (session.profileSummary) parts.push(`Client preferences:\n${session.profileSummary}`);
      parts.push('When the conversation goal is achieved or the person wants to end the call, say exactly [END_CALL] at the end of your response.');
      systemPrompt = parts.join('\n\n');
    }

    // Get or create conversation history for this call
    const historyKey = callId || callSid;
    if (!callHistory.has(historyKey)) {
      callHistory.set(historyKey, { messages: [], createdAt: Date.now() });
    }
    const history = callHistory.get(historyKey);
    history.messages.push({ role: 'user', content: speech });

    // Keep only last N messages
    if (history.messages.length > MAX_HISTORY) {
      history.messages = history.messages.slice(-MAX_HISTORY);
    }

    // Call Claude Haiku (non-streaming)
    let aiText = "Sorry, could you repeat that?";
    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: history.messages,
      });
      aiText = response.content[0]?.text || aiText;
    } catch (claudeErr) {
      console.error('[VOICE] Claude API error:', claudeErr.message);
    }

    // Check for end call signal
    const shouldEnd = aiText.includes('[END_CALL]');
    aiText = aiText.replace('[END_CALL]', '').trim();

    history.messages.push({ role: 'assistant', content: aiText });

    // Keep only last N messages
    if (history.messages.length > MAX_HISTORY) {
      history.messages = history.messages.slice(-MAX_HISTORY);
    }

    console.log(`[VOICE] [${callSid}] Kova said: "${aiText}"`);

    if (shouldEnd) {
      console.log(`[VOICE] [${callSid}] Call ending (goal achieved)`);
      res.type('text/xml').send(twiml([
        sayTag(aiText, voice),
        sayTag('Goodbye!', voice),
      ].join('\n')));
    } else {
      res.type('text/xml').send(twiml([
        sayTag(aiText, voice),
        gatherWithPrompt(actionUrl, 'Is there anything else?', voice),
        sayTag('Are you still there? Goodbye.', voice),
      ].join('\n')));
    }

  } catch (err) {
    console.error('[VOICE] Respond error:', err.message, err.stack);
    const callId = req.query.callId || '';
    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';
    res.type('text/xml').send(twiml([
      `  <Say voice="${VOICE}" language="${LANG}">Sorry, could you repeat that?</Say>`,
      `  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" method="POST">`,
      `    <Say voice="${VOICE}" language="${LANG}">I'm listening.</Say>`,
      `  </Gather>`,
      `  <Say voice="${VOICE}" language="${LANG}">Goodbye.</Say>`,
    ].join('\n')));
  }
});

// ── POST /status — clean up history when call ends ──────────────────────────

router.post('/status', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const status = req.body.CallStatus;
    const callId = req.query.callId || '';

    console.log(`[VOICE] Call status: ${callSid} → ${status}`);

    // Clean up call history
    if (callSid && callHistory.has(callSid)) {
      callHistory.delete(callSid);
      console.log(`[VOICE] Cleared history for callSid=${callSid}`);
    }
    if (callId && callHistory.has(callId)) {
      callHistory.delete(callId);
      console.log(`[VOICE] Cleared history for callId=${callId}`);
    }

    // Send WhatsApp summary if this was an outbound call with a session
    if (callId && activeCallSessions.has(callId)) {
      const session = activeCallSessions.get(callId);
      if (session.customerWhatsappFrom && session.history && session.history.length > 0) {
        try {
          const summary = session.history
            .map(m => `${m.role === 'user' ? 'Them' : 'Kova'}: ${m.content}`)
            .join('\n');
          console.log(`[VOICE] Call summary for ${session.customerName}:\n${summary}`);
        } catch (summaryErr) {
          console.error('[VOICE] Summary error:', summaryErr.message);
        }
      }
      activeCallSessions.delete(callId);
      console.log(`[VOICE] Cleaned up session for callId=${callId}`);
    }
  } catch (err) {
    console.error('[VOICE] Status error:', err.message);
  }
  res.sendStatus(200);
});

// ── GET and POST /fallback — Twilio calls this if the main webhook fails ────

function handleFallback(req, res) {
  try {
    console.error('[VOICE] Fallback triggered:', JSON.stringify(req.body || req.query));
    res.type('text/xml').send(twiml(
      sayTag('Sorry, something went wrong. Please try calling back. Goodbye.')
    ));
  } catch (err) {
    console.error('[VOICE] Fallback error:', err.message);
    res.type('text/xml').send(twiml(
      '  <Say>Sorry, something went wrong. Goodbye.</Say>'
    ));
  }
}

router.get('/fallback', handleFallback);
router.post('/fallback', handleFallback);

module.exports = router;
