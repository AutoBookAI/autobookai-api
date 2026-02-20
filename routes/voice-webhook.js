/**
 * Voice Webhook — Twilio ConversationRelay with ElevenLabs TTS + Claude streaming.
 *
 * ConversationRelay handles real-time streaming: Deepgram STT → our WebSocket →
 * Claude streaming tokens → ConversationRelay → ElevenLabs TTS → caller hears speech.
 * Sub-500ms latency because tokens stream as they arrive.
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Config ───────────────────────────────────────────────────────────────────

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const WS_URL = 'wss://bountiful-growth-production.up.railway.app/voice-ws';
const SYSTEM_PROMPT = 'You are Kova, a phone assistant. Reply in 1 sentence. Be brief and natural.';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 80;
const MAX_HISTORY = 6;

// Conversation history per call, keyed by callSid
const callSessions = new Map();

// Clean up stale sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of callSessions) {
    if (now - entry.createdAt > 30 * 60 * 1000) callSessions.delete(sid);
  }
}, 10 * 60 * 1000);

// ── TwiML Webhook — returns ConversationRelay TwiML ─────────────────────────

function handleIncoming(req, res) {
  try {
    const callSid = req.body?.CallSid || req.query?.CallSid || 'unknown';
    console.log(`[VOICE] Incoming call: callSid=${callSid}`);

    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${WS_URL}" ttsProvider="ElevenLabs" voice="${VOICE_ID}" transcriptionProvider="deepgram" welcomeGreeting="Hi, this is Kova. How can I help?" interruptible="true" />
  </Connect>
</Response>`
    );
  } catch (err) {
    console.error('[VOICE] Incoming error:', err.message);
    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, something went wrong. Please try again later.</Say>
</Response>`
    );
  }
}

router.get('/', handleIncoming);
router.post('/', handleIncoming);

// ── POST /status — call status callback ─────────────────────────────────────

router.post('/status', (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const status = req.body.CallStatus;
    console.log(`[VOICE] Call status: ${callSid} → ${status}`);
    if (callSid && callSessions.has(callSid)) {
      callSessions.delete(callSid);
      console.log(`[VOICE] Cleared session for ${callSid}`);
    }
  } catch (err) {
    console.error('[VOICE] Status error:', err.message);
  }
  res.sendStatus(200);
});

// ── GET and POST /fallback ──────────────────────────────────────────────────

function handleFallback(req, res) {
  try {
    console.error('[VOICE] Fallback triggered:', JSON.stringify(req.body || req.query));
  } catch (e) { /* ignore */ }
  res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, something went wrong. Please try again later.</Say>
</Response>`
  );
}

router.get('/fallback', handleFallback);
router.post('/fallback', handleFallback);

// ── WebSocket handler for ConversationRelay ─────────────────────────────────

function handleVoiceWebSocket(ws, req) {
  let callSid = 'unknown';

  ws.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (e) {
      console.error('[VOICE-WS] Invalid JSON:', e.message);
      return;
    }

    const type = message.type;

    if (type === 'setup') {
      callSid = message.callSid || 'unknown';
      callSessions.set(callSid, { messages: [], createdAt: Date.now() });
      console.log('[VOICE-WS] Call connected:', callSid);
      return;
    }

    if (type === 'prompt') {
      const userText = message.voicePrompt || '';
      console.log(`[VOICE-WS] [${callSid}] User said: "${userText}"`);

      if (!userText.trim()) return;

      // Get or create conversation history
      if (!callSessions.has(callSid)) {
        callSessions.set(callSid, { messages: [], createdAt: Date.now() });
      }
      const session = callSessions.get(callSid);
      session.messages.push({ role: 'user', content: userText });

      if (session.messages.length > MAX_HISTORY) {
        session.messages = session.messages.slice(-MAX_HISTORY);
      }

      try {
        // Stream Claude response and send tokens in real time
        const stream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: session.messages,
        });

        let fullResponse = '';

        stream.on('text', (text) => {
          fullResponse += text;
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'text', token: text, last: false }));
          }
        });

        await stream.finalMessage();

        // Send the final signal
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'text', token: '', last: true }));
        }

        // Save to history
        session.messages.push({ role: 'assistant', content: fullResponse });
        if (session.messages.length > MAX_HISTORY) {
          session.messages = session.messages.slice(-MAX_HISTORY);
        }

        console.log(`[VOICE-WS] [${callSid}] Kova said: "${fullResponse}"`);

      } catch (claudeErr) {
        console.error('[VOICE-WS] Claude error:', claudeErr.message);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'text', token: "Sorry, could you repeat that?", last: true }));
        }
      }
      return;
    }

    if (type === 'interrupt') {
      console.log(`[VOICE-WS] [${callSid}] Caller interrupted`);
      return;
    }

    if (type === 'dtmf') {
      console.log(`[VOICE-WS] [${callSid}] DTMF: ${message.digit}`);
      return;
    }

    if (type === 'error') {
      console.error(`[VOICE-WS] [${callSid}] Error:`, message.description || JSON.stringify(message));
      return;
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[VOICE-WS] Call ended: ${callSid} (code=${code})`);
    callSessions.delete(callSid);
  });

  ws.on('error', (err) => {
    console.error(`[VOICE-WS] WebSocket error for ${callSid}:`, err.message);
  });
}

module.exports = router;
module.exports.handleVoiceWebSocket = handleVoiceWebSocket;
