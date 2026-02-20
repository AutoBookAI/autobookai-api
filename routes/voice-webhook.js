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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VOICE = 'Google.en-US-Journey-F';
const LANG = 'en-US';
const GREETING = 'Hi, this is Kova, your AI assistant. How can I help you today?';
const SYSTEM_PROMPT = 'You are Kova, a phone assistant. Reply in 1 sentence. Be natural and brief.';

// Conversation history per call, keyed by CallSid. Max 6 messages per call.
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

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── GET and POST / — greeting + first Gather ────────────────────────────────

function handleIncoming(req, res) {
  try {
    console.log('📞 Incoming voice call');
    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="${LANG}">${escapeXml(GREETING)}</Say>
  <Gather input="speech" speechTimeout="auto" action="/webhook/voice/respond" method="POST">
  </Gather>
  <Say voice="${VOICE}" language="${LANG}">I didn&apos;t catch that, goodbye.</Say>
</Response>`);
  } catch (err) {
    console.error('❌ Voice incoming error:', err.message);
    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, something went wrong. Goodbye.</Say>
</Response>`);
  }
}

router.get('/', handleIncoming);
router.post('/', handleIncoming);

// ── POST /respond — Claude Haiku responds to caller speech ──────────────────

router.post('/respond', async (req, res) => {
  try {
    const speech = req.body.SpeechResult || '';
    const callSid = req.body.CallSid || 'unknown';

    console.log(`🎙️ [${callSid}] Caller: "${speech}"`);

    if (!speech) {
      res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="${LANG}">I didn&apos;t catch that. Could you say that again?</Say>
  <Gather input="speech" speechTimeout="auto" action="/webhook/voice/respond" method="POST">
  </Gather>
  <Say voice="${VOICE}" language="${LANG}">Goodbye.</Say>
</Response>`);
      return;
    }

    // Get or create conversation history for this call
    if (!callHistory.has(callSid)) {
      callHistory.set(callSid, { messages: [], createdAt: Date.now() });
    }
    const history = callHistory.get(callSid);
    history.messages.push({ role: 'user', content: speech });

    // Keep only last 6 messages
    if (history.messages.length > 6) {
      history.messages = history.messages.slice(-6);
    }

    // Call Claude Haiku
    let aiText = "Sorry, could you repeat that?";
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: SYSTEM_PROMPT,
        messages: history.messages,
      });
      aiText = response.content[0]?.text || aiText;
    } catch (claudeErr) {
      console.error('❌ Claude API error:', claudeErr.message);
      // aiText stays as the fallback
    }

    history.messages.push({ role: 'assistant', content: aiText });

    // Keep only last 6 messages
    if (history.messages.length > 6) {
      history.messages = history.messages.slice(-6);
    }

    console.log(`🤖 [${callSid}] Kova: "${aiText}"`);

    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="${LANG}">${escapeXml(aiText)}</Say>
  <Gather input="speech" speechTimeout="auto" action="/webhook/voice/respond" method="POST">
  </Gather>
  <Say voice="${VOICE}" language="${LANG}">Are you still there? Goodbye.</Say>
</Response>`);

  } catch (err) {
    console.error('❌ Voice respond error:', err.message, err.stack);
    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="${LANG}">Sorry, could you repeat that?</Say>
  <Gather input="speech" speechTimeout="auto" action="/webhook/voice/respond" method="POST">
  </Gather>
  <Say voice="${VOICE}" language="${LANG}">Goodbye.</Say>
</Response>`);
  }
});

// ── POST /status — clean up history when call ends ──────────────────────────

router.post('/status', (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const status = req.body.CallStatus;
    console.log(`📞 Call status: ${callSid} → ${status}`);
    if (callSid && callHistory.has(callSid)) {
      callHistory.delete(callSid);
      console.log(`🗑️ Cleared history for ${callSid}`);
    }
  } catch (err) {
    console.error('❌ Status error:', err.message);
  }
  res.sendStatus(200);
});

// ── POST /fallback — Twilio calls this if the main webhook fails ────────────

router.post('/fallback', (req, res) => {
  try {
    console.error('❌ Voice fallback triggered:', JSON.stringify(req.body));
    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}" language="${LANG}">Sorry, something went wrong. Please try calling back. Goodbye.</Say>
</Response>`);
  } catch (err) {
    console.error('❌ Fallback error:', err.message);
    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, something went wrong. Goodbye.</Say>
</Response>`);
  }
});

module.exports = router;
