/**
 * Voice Webhook — Twilio ConversationRelay + Gather/Say fallback.
 *
 * Primary: ConversationRelay WebSocket with Claude Haiku streaming
 *   1. Twilio hits GET/POST /webhook/voice → returns ConversationRelay TwiML
 *   2. Twilio opens WebSocket to /voice-ws
 *   3. Person speaks → {"type":"prompt","voicePrompt":"..."} → Claude Haiku streams tokens back
 *
 * Fallback: Gather + Say (if ConversationRelay doesn't work on this account)
 *   1. Twilio hits GET/POST /webhook/voice/gather → returns Gather+Say TwiML
 *   2. Person speaks → Twilio hits POST /webhook/voice/respond with SpeechResult
 *   3. Claude Haiku generates response → returned as Say TwiML
 *
 * TTS: Google en-US-Journey-F via ConversationRelay (or Google.en-US-Neural2-F for Say)
 * STT: Google via ConversationRelay (or Twilio enhanced for Gather)
 * AI:  Claude Haiku (streaming for WS, non-streaming for Gather)
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { activeCallSessions, escapeXml } = require('../services/twilio-voice');

const anthropic = new Anthropic();

const VOICE_SYSTEM_PROMPT = 'You are Kova, a friendly and helpful AI phone assistant. Keep ALL responses to 1-2 sentences maximum. Be warm, natural, and conversational. You are on a live phone call, so speak like a real person, not a chatbot. Never use markdown, bullet points, or formatting. Never say "as an AI" or "as a language model".';

const DEFAULT_GREETING = 'Hi! This is Kova, your AI assistant. How can I help you today?';

// ── Safe WebSocket send ─────────────────────────────────────────────────────
function safeSend(ws, msg) {
  try {
    if (ws.readyState === 1) { // OPEN
      ws.send(JSON.stringify(msg));
    }
  } catch (err) {
    console.error('❌ WS send error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PRIMARY: ConversationRelay
// ══════════════════════════════════════════════════════════════════════════════

// GET and POST / — return ConversationRelay TwiML
function handleIncoming(req, res) {
  try {
    const callId = req.query.callId || '';
    const masterApiUrl = process.env.MASTER_API_URL || 'https://bountiful-growth-production.up.railway.app';
    const wsBase = masterApiUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    const wsUrl = callId
      ? `${wsBase}/voice-ws?callId=${encodeURIComponent(callId)}`
      : `${wsBase}/voice-ws`;

    // For outbound calls, use the session's initial message as greeting
    let greeting = DEFAULT_GREETING;
    if (callId) {
      const session = activeCallSessions.get(callId);
      if (session && session.initialMessage) {
        greeting = session.initialMessage;
      }
    }

    console.log(`📞 Voice TwiML: callId=${callId || 'inbound'}, wsUrl=${wsUrl}`);

    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" ttsProvider="google" voice="en-US-Journey-F" transcriptionProvider="google" welcomeGreeting="${escapeXml(greeting)}" interruptible="true" />
  </Connect>
</Response>`);
  } catch (err) {
    console.error('❌ Voice TwiML error:', err.message);
    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Neural2-F">Sorry, something went wrong. Please try again later.</Say>
</Response>`);
  }
}

router.get('/', handleIncoming);
router.post('/', handleIncoming);

// ── WebSocket handler for ConversationRelay (exported for server.js) ────────

function handleVoiceWebSocket(ws, callId) {
  try {
    // Outbound calls have a pre-existing session from makeCall()
    const session = callId ? activeCallSessions.get(callId) : null;
    const history = session ? session.history : [];

    console.log(`🔌 WS connected: callId=${callId || 'inbound'}, hasSession=${!!session}`);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'setup') {
          console.log(`✅ ConversationRelay setup: callSid=${msg.callSid}, from=${msg.from}, to=${msg.to}`);
        } else if (msg.type === 'prompt') {
          const speech = msg.voicePrompt;
          console.log(`🎙️ Caller said: "${speech}"`);
          history.push({ role: 'user', content: speech });
          await streamClaudeResponse(ws, history);
        } else if (msg.type === 'interrupt') {
          console.log('⚡ Caller interrupted TTS');
        } else if (msg.type === 'dtmf') {
          console.log(`🔢 DTMF digit: ${msg.digit}`);
        } else if (msg.type === 'error') {
          console.error('❌ ConversationRelay error:', msg.description || JSON.stringify(msg));
        } else {
          console.log(`📨 WS message type=${msg.type}:`, JSON.stringify(msg).substring(0, 200));
        }
      } catch (err) {
        console.error('❌ WS message handler error:', err.message, err.stack);
        safeSend(ws, {
          type: 'text',
          token: "I'm sorry, I had a brief hiccup. Could you say that again?",
          last: true,
        });
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 WS closed: callId=${callId || 'inbound'}, code=${code}, reason=${reason || 'none'}`);
    });

    ws.on('error', (err) => {
      console.error(`❌ WS error: callId=${callId || 'inbound'}`, err.message);
    });
  } catch (err) {
    console.error('❌ WS handler setup error:', err.message, err.stack);
    try { ws.close(); } catch {}
  }
}

// ── Claude Haiku streaming — each token sent IMMEDIATELY ────────────────────

async function streamClaudeResponse(ws, history) {
  const startMs = Date.now();

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-haiku-4-5-20250929',
      max_tokens: 150,
      system: VOICE_SYSTEM_PROMPT,
      messages: history,
    });

    let fullResponse = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const token = event.delta.text;
        fullResponse += token;

        // Send each token IMMEDIATELY — no buffering
        safeSend(ws, { type: 'text', token: token, last: false });
      }
    }

    // Signal end of response
    safeSend(ws, { type: 'text', token: '', last: true });

    const ms = Date.now() - startMs;
    console.log(`🤖 AI [${ms}ms]: "${fullResponse.substring(0, 120)}"`);

    history.push({ role: 'assistant', content: fullResponse });
  } catch (err) {
    console.error('❌ Claude stream error:', err.message, err.stack);
    safeSend(ws, {
      type: 'text',
      token: "I'm sorry, I had a brief hiccup. Could you say that again?",
      last: true,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FALLBACK: Gather + Say (if ConversationRelay doesn't work on this account)
// ══════════════════════════════════════════════════════════════════════════════

function handleGather(req, res) {
  try {
    const callId = req.query.callId || '';
    let greeting = DEFAULT_GREETING;

    if (callId) {
      const session = activeCallSessions.get(callId);
      if (session && session.initialMessage) {
        greeting = session.initialMessage;
      }
    }

    console.log(`📞 Gather TwiML: callId=${callId || 'inbound'}`);

    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" action="/webhook/voice/respond?callId=${encodeURIComponent(callId)}" method="POST">
    <Say voice="Google.en-US-Neural2-F">${escapeXml(greeting)}</Say>
  </Gather>
  <Say voice="Google.en-US-Neural2-F">I didn't hear anything. Goodbye!</Say>
</Response>`);
  } catch (err) {
    console.error('❌ Gather TwiML error:', err.message);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong.</Say></Response>');
  }
}

router.get('/gather', handleGather);
router.post('/gather', handleGather);

router.post('/respond', async (req, res) => {
  try {
    const callId = req.query.callId || '';
    const speech = req.body.SpeechResult;

    if (!speech) {
      console.log('📞 Gather: no speech detected');
      res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" action="/webhook/voice/respond?callId=${encodeURIComponent(callId)}" method="POST">
    <Say voice="Google.en-US-Neural2-F">I didn't catch that. Could you try again?</Say>
  </Gather>
  <Say voice="Google.en-US-Neural2-F">Goodbye!</Say>
</Response>`);
      return;
    }

    console.log(`🎙️ Gather speech: "${speech}"`);

    // Get or create history for this call
    const session = callId ? activeCallSessions.get(callId) : null;
    const history = session ? session.history : [];

    history.push({ role: 'user', content: speech });

    // Non-streaming Claude call (Gather+Say needs full response upfront)
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20250929',
      max_tokens: 150,
      system: VOICE_SYSTEM_PROMPT,
      messages: history,
    });

    const aiText = response.content[0]?.text || "I'm sorry, could you say that again?";
    history.push({ role: 'assistant', content: aiText });

    console.log(`🤖 AI: "${aiText}"`);

    res.type('text/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" action="/webhook/voice/respond?callId=${encodeURIComponent(callId)}" method="POST">
    <Say voice="Google.en-US-Neural2-F">${escapeXml(aiText)}</Say>
  </Gather>
  <Say voice="Google.en-US-Neural2-F">Are you still there?</Say>
  <Gather input="speech" speechTimeout="auto" action="/webhook/voice/respond?callId=${encodeURIComponent(callId)}" method="POST"></Gather>
  <Say voice="Google.en-US-Neural2-F">Alright, goodbye!</Say>
</Response>`);
  } catch (err) {
    console.error('❌ Gather respond error:', err.message, err.stack);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Google.en-US-Neural2-F">Sorry, I had a technical issue. Goodbye!</Say></Response>');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CALL STATUS + ADMIN ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

router.post('/status', async (req, res) => {
  const callId = req.query.callId;
  const status = req.body.CallStatus;
  console.log(`📞 Status: callId=${callId}, status=${status}`);
  res.sendStatus(200);

  const session = activeCallSessions.get(callId);
  if (!session) return;

  try {
    if (status === 'completed' && session.history.length > 0) {
      sendCallSummary(session).catch(err => console.error('❌ Summary error:', err.message));
    } else if (['busy', 'no-answer', 'failed'].includes(status)) {
      sendCallFailureNotice(session, status).catch(err => console.error('❌ Failure notice error:', err.message));
    }
  } catch (err) {
    console.error('❌ Status handler error:', err.message);
  } finally {
    activeCallSessions.delete(callId);
  }
});

// Admin diagnostic endpoints
function requireAdminAuth(req, res, next) {
  try {
    const jwt = require('jsonwebtoken');
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Auth required' });
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded.adminId) return res.status(403).json({ error: 'Admin only' });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

router.get('/test-call', requireAdminAuth, async (req, res) => {
  try {
    const { makeCall } = require('../services/twilio-voice');
    const to = req.query.to;
    if (!to) return res.status(400).json({ error: 'Missing ?to= parameter' });
    const result = await makeCall({
      to,
      message: 'Hi, this is Kova. Just a quick test call. How are you?',
      purpose: 'Test call to verify voice system',
      customerId: 1,
    });
    res.json({ success: true, ...result, activeSessions: activeCallSessions.size });
  } catch (err) {
    console.error('❌ Test call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/debug', requireAdminAuth, (req, res) => {
  const sessions = [];
  for (const [id, s] of activeCallSessions) {
    sessions.push({
      callId: id, to: s.to, purpose: s.purpose,
      historyLen: s.history.length,
      age: Math.round((Date.now() - s.createdAt) / 1000) + 's',
    });
  }
  res.json({ activeSessions: sessions.length, sessions });
});

// ── Post-call notifications ─────────────────────────────────────────────────

async function sendCallSummary(session) {
  try {
    const transcript = session.history.map(m =>
      `${m.role === 'user' ? 'Them' : 'Kova'}: ${m.content}`
    ).join('\n');

    const summary = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20250929',
      max_tokens: 150,
      messages: [{ role: 'user', content: `Summarize this call in 1-2 sentences.\n\nPurpose: ${session.purpose}\n\n${transcript}` }],
    });

    const text = summary.content[0]?.text || 'Call completed.';
    const msg = `📞 Call to ${session.to} done:\n\n${text}`;

    if (session.customerWhatsappFrom) {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const from = process.env.TWILIO_WHATSAPP_NUMBER;
      if (from) {
        await twilio.messages.create({
          from: `whatsapp:${from}`,
          to: `whatsapp:${session.customerWhatsappFrom}`,
          body: msg,
        });
      }
    }

    if (session.customerId) {
      pool.query(
        'INSERT INTO activity_log (customer_id, event_type, description, metadata) VALUES ($1, $2, $3, $4)',
        [session.customerId, 'voice_call_completed', `Call to ${session.to}`,
         JSON.stringify({ purpose: session.purpose, turns: session.history.length, transcript })]
      ).catch(() => {});
    }
  } catch (err) {
    console.error('❌ Summary error:', err.message);
  }
}

async function sendCallFailureNotice(session, status) {
  try {
    if (!session.customerWhatsappFrom) return;
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const from = process.env.TWILIO_WHATSAPP_NUMBER;
    if (!from) return;
    const reason = status === 'busy' ? 'Line was busy' : status === 'no-answer' ? 'No answer' : 'Call failed';
    await twilio.messages.create({
      from: `whatsapp:${from}`,
      to: `whatsapp:${session.customerWhatsappFrom}`,
      body: `📞 Call to ${session.to}: ${reason}. Want me to try again?`,
    });
    if (session.customerId) {
      pool.query(
        'INSERT INTO activity_log (customer_id, event_type, description) VALUES ($1, $2, $3)',
        [session.customerId, 'voice_call_failed', `Call to ${session.to}: ${reason}`]
      ).catch(() => {});
    }
  } catch (err) {
    console.error('❌ Failure notice error:', err.message);
  }
}

// Export router + WebSocket handler
router.handleVoiceWebSocket = handleVoiceWebSocket;
module.exports = router;
