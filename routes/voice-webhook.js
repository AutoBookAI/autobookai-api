/**
 * Voice Webhook — Twilio ConversationRelay with real-time Claude streaming.
 *
 * Architecture:
 *   1. makeCall() creates outbound call → Twilio hits /voice/outbound
 *   2. Returns ConversationRelay TwiML → Twilio opens WebSocket to /voice-ws
 *   3. Person speaks → Twilio sends {"type": "prompt", "voicePrompt": "..."}
 *   4. Claude streams response → tokens sent as {"type": "text", "token": "...", "last": bool}
 *   5. Twilio speaks each token via Google TTS in real-time (~300ms latency)
 *
 * TTS: Google via ConversationRelay (no external TTS API needed)
 * STT: Twilio enhanced speech recognition
 * AI:  Claude Sonnet (streaming, ~500ms first token)
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { activeCallSessions, escapeXml } = require('../services/twilio-voice');

const anthropic = new Anthropic();

// Google TTS voices for ConversationRelay
const GOOGLE_VOICE = {
  female: 'en-US-Standard-F',
  male: 'en-US-Standard-D',
};

// ── Twilio signature verification ───────────────────────────────────────────
function validateTwilioVoiceSignature(req, res, next) {
  const twilio = require('twilio');
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return next();
  const baseUrl = process.env.MASTER_API_URL;
  if (!baseUrl) return next();
  const webhookUrl = `${baseUrl}${req.originalUrl}`;
  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    console.warn('Missing X-Twilio-Signature on voice webhook');
    return res.type('text/xml').status(403).send('<Response/>');
  }
  if (!twilio.validateRequest(authToken, signature, webhookUrl, req.body)) {
    console.warn('Invalid Twilio signature on voice webhook');
    return res.type('text/xml').status(403).send('<Response/>');
  }
  next();
}

// ── Admin auth for diagnostic endpoints ─────────────────────────────────────
function requireAdminAuth(req, res, next) {
  const jwt = require('jsonwebtoken');
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Auth required' });
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded.adminId) return res.status(403).json({ error: 'Admin only' });
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Diagnostic endpoints (admin only) ───────────────────────────────────────

router.get('/test-call', requireAdminAuth, async (req, res) => {
  const { makeCall } = require('../services/twilio-voice');
  const to = req.query.to;
  if (!to) return res.status(400).json({ error: 'Missing ?to= parameter' });
  try {
    const result = await makeCall({
      to,
      message: 'Hi, this is Kova. Just a quick test call. How are you?',
      purpose: 'Test call to verify voice system works end-to-end',
      customerId: 1,
    });
    res.json({ success: true, ...result, activeSessions: activeCallSessions.size });
  } catch (err) {
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

// ── POST /voice/outbound — returns ConversationRelay TwiML ──────────────────
router.post('/outbound', validateTwilioVoiceSignature, async (req, res) => {
  const callId = req.query.callId;
  console.log(`📞 Webhook: callId=${callId}, sessions=${activeCallSessions.size}`);

  const session = activeCallSessions.get(callId);
  if (!session) {
    console.error(`❌ No session for callId=${callId}`);
    res.type('text/xml').send(
      `<Response><Say voice="Polly.Ruth-Generative">Sorry, I couldn't connect this call.</Say></Response>`
    );
    return;
  }

  const masterApiUrl = process.env.MASTER_API_URL;
  const wsUrl = masterApiUrl
    .replace('https://', 'wss://')
    .replace('http://', 'ws://');

  const voice = GOOGLE_VOICE[session.voiceGender] || GOOGLE_VOICE.female;
  const greeting = escapeXml(session.initialMessage);

  res.type('text/xml').send(
`<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}/voice-ws?callId=${encodeURIComponent(callId)}" dtmfDetection="true" voice="${voice}" ttsProvider="google" welcomeGreeting="${greeting}" />
  </Connect>
</Response>`);
});

// ── POST /voice/status — call lifecycle ─────────────────────────────────────
router.post('/status', validateTwilioVoiceSignature, async (req, res) => {
  const callId = req.query.callId;
  const status = req.body.CallStatus;
  console.log(`📞 Status (${callId}): ${status}`);
  res.sendStatus(200);

  const session = activeCallSessions.get(callId);
  if (!session) return;

  try {
    if (status === 'completed' && session.history.length > 0) {
      sendCallSummary(session).catch(() => {});
    } else if (['busy', 'no-answer', 'failed'].includes(status)) {
      sendCallFailureNotice(session, status).catch(() => {});
    }
  } finally {
    activeCallSessions.delete(callId);
  }
});

// ── WebSocket handler for ConversationRelay ─────────────────────────────────

function handleVoiceWebSocket(ws, callId) {
  const session = activeCallSessions.get(callId);
  if (!session) {
    console.error(`❌ WS: No session for callId=${callId}`);
    ws.close();
    return;
  }

  console.log(`🔌 WS connected: callId=${callId}, to=${session.to}`);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'setup') {
        console.log(`✅ ConversationRelay setup (${callId}): callSid=${msg.callSid || 'n/a'}`);
      } else if (msg.type === 'prompt') {
        const speech = msg.voicePrompt;
        console.log(`🎙️ (${callId}): "${speech}"`);
        session.history.push({ role: 'user', content: speech });
        await streamClaudeResponse(ws, session, callId);
      } else if (msg.type === 'interrupt') {
        console.log(`⚡ Barge-in (${callId})`);
      } else if (msg.type === 'dtmf') {
        console.log(`🔢 DTMF (${callId}): ${msg.digit}`);
      } else if (msg.type === 'error') {
        console.error(`❌ ConversationRelay error (${callId}):`, msg.description || msg);
      }
    } catch (err) {
      console.error(`❌ WS message error (${callId}):`, err.message);
      try {
        ws.send(JSON.stringify({
          type: 'text',
          token: "Sorry, I'm having a moment. Could you say that again?",
          last: true,
        }));
      } catch {}
    }
  });

  ws.on('close', () => {
    console.log(`🔌 WS closed: callId=${callId}`);
  });

  ws.on('error', (err) => {
    console.error(`❌ WS error (${callId}):`, err.message);
  });
}

// ── Claude streaming response ───────────────────────────────────────────────

async function streamClaudeResponse(ws, session, callId) {
  const sys = `Live phone call. You are Kova calling for ${session.customerName}.
PURPOSE: ${session.purpose}
${session.profileSummary ? `CLIENT INFO: ${session.profileSummary}` : ''}
RULES:
- 1-2 sentences max. Be concise.
- Sound casual and human. Say "gonna" not "going to", "wanna" not "want to".
- Use "yeah", "sure", "got it", "mm-hmm", "cool", "right", "perfect", "awesome".
- Use contractions: I'm, that's, I'll, don't, won't, can't.
- Natural pauses: "So... table for four?" or "Right, got it."
- Give client's full name when booking.
- Say [END_CALL] when the conversation is wrapping up.
- Never reveal you're AI.`;

  const startMs = Date.now();

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      system: sys,
      messages: session.history,
    });

    let fullText = '';
    let buffer = '';

    stream.on('text', (text) => {
      fullText += text;
      buffer += text;

      // Send complete words to Twilio for immediate TTS
      const lastSpace = buffer.lastIndexOf(' ');
      if (lastSpace > 0) {
        let toSend = buffer.substring(0, lastSpace + 1);
        buffer = buffer.substring(lastSpace + 1);

        // Strip [END_CALL] marker — never speak it
        toSend = toSend.replace(/\[END_CALL\]/g, '');
        if (toSend.trim()) {
          try {
            ws.send(JSON.stringify({ type: 'text', token: toSend, last: false }));
          } catch {}
        }
      }
    });

    await stream.finalMessage();

    const claudeMs = Date.now() - startMs;

    // Send remaining buffer as last token
    const endCall = fullText.includes('[END_CALL]');
    const remaining = buffer.replace(/\[END_CALL\]/g, '').trim();

    try {
      ws.send(JSON.stringify({
        type: 'text',
        token: remaining || '.',
        last: true,
      }));
    } catch {}

    // Store clean response in history
    const cleanText = fullText.replace(/\[END_CALL\]/g, '').trim();
    session.history.push({ role: 'assistant', content: cleanText });
    console.log(`🤖 AI (${callId}): "${cleanText}" [${claudeMs}ms, end=${endCall}]`);

    // End call if Claude signaled it
    if (endCall) {
      setTimeout(() => {
        try { ws.send(JSON.stringify({ type: 'end' })); } catch {}
      }, 4000); // Wait for TTS to finish speaking
    }

  } catch (err) {
    console.error(`❌ Claude stream error (${callId}):`, err.message);
    try {
      ws.send(JSON.stringify({
        type: 'text',
        token: "Sorry, could you repeat that?",
        last: true,
      }));
    } catch {}
  }
}

// ── Post-call notifications (async, never blocks) ───────────────────────────

async function sendCallSummary(session) {
  try {
    const transcript = session.history.map(m =>
      `${m.role === 'user' ? 'Them' : 'Kova'}: ${m.content}`
    ).join('\n');

    const summary = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: `Summarize this call in 1-2 sentences.\n\nPurpose: ${session.purpose}\n\n${transcript}` }],
    });

    const text = summary.content[0]?.text || 'Call completed.';
    const msg = `📞 Call to ${session.to} done:\n\n${text}`;

    if (session.customerWhatsappFrom) {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const from = process.env.TWILIO_WHATSAPP_NUMBER;
      if (from) {
        await twilio.messages.create({ from: `whatsapp:${from}`, to: `whatsapp:${session.customerWhatsappFrom}`, body: msg });
      }
    }

    if (session.customerId) {
      pool.query(
        'INSERT INTO activity_log (customer_id, event_type, description, metadata) VALUES ($1, $2, $3, $4)',
        [session.customerId, 'voice_call_completed', `Call to ${session.to}`,
         JSON.stringify({ purpose: session.purpose, turns: session.history.length, transcript })]
      ).catch(() => {});
    }
  } catch (err) { console.error('Summary error:', err.message); }
}

async function sendCallFailureNotice(session, status) {
  try {
    if (!session.customerWhatsappFrom) return;
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const from = process.env.TWILIO_WHATSAPP_NUMBER;
    if (!from) return;
    const reason = status === 'busy' ? 'Line was busy' : status === 'no-answer' ? 'No answer' : 'Call failed';
    await twilio.messages.create({
      from: `whatsapp:${from}`, to: `whatsapp:${session.customerWhatsappFrom}`,
      body: `📞 Call to ${session.to}: ${reason}. Want me to try again?`,
    });
    if (session.customerId) {
      pool.query('INSERT INTO activity_log (customer_id, event_type, description) VALUES ($1, $2, $3)',
        [session.customerId, 'voice_call_failed', `Call to ${session.to}: ${reason}`]).catch(() => {});
    }
  } catch (err) { console.error('Failure notice error:', err.message); }
}

// Export router + WebSocket handler
router.handleVoiceWebSocket = handleVoiceWebSocket;
module.exports = router;
