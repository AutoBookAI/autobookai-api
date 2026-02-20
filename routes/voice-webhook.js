/**
 * Voice Webhook — Twilio ConversationRelay with Claude Haiku streaming.
 *
 * Architecture:
 *   1. makeCall() creates outbound call → Twilio hits /voice/outbound
 *   2. Returns ConversationRelay TwiML (ElevenLabs TTS) → Twilio opens WS to /voice-ws
 *   3. Person speaks → Twilio sends {"type": "prompt", "voicePrompt": "..."}
 *   4. Claude Haiku streams tokens → each sent IMMEDIATELY to ConversationRelay
 *   5. ElevenLabs speaks each token in real-time
 *
 * TTS: ElevenLabs via ConversationRelay (customer clone or Rachel default)
 * STT: Twilio Deepgram
 * AI:  Claude Haiku (streaming, fastest model)
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { activeCallSessions, escapeXml } = require('../services/twilio-voice');

const anthropic = new Anthropic();

// ElevenLabs default voice (Rachel) — used when customer has no clone
const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

// Short system prompt for minimum latency
const VOICE_SYSTEM_PROMPT = 'You are Kova, a helpful AI phone assistant. Keep all responses to 1-2 sentences. Be conversational and natural. You\'re on a phone call, not writing an essay.';

// ── Twilio signature verification ───────────────────────────────────────────
function validateTwilioVoiceSignature(req, res, next) {
  try {
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
  } catch (err) {
    console.error('❌ Twilio signature validation error:', err.message);
    next(); // Don't block on validation errors
  }
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
    console.error('❌ Test call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/debug', requireAdminAuth, (req, res) => {
  const sessions = [];
  for (const [id, s] of activeCallSessions) {
    sessions.push({
      callId: id, to: s.to, purpose: s.purpose,
      voiceId: s.customVoiceId || ELEVENLABS_DEFAULT_VOICE,
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

  try {
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

    // Use customer's cloned voice or ElevenLabs Rachel default
    const voiceId = session.customVoiceId || ELEVENLABS_DEFAULT_VOICE;
    const greeting = escapeXml(session.initialMessage);

    console.log(`📞 ConversationRelay: voiceId=${voiceId}, clone=${!!session.customVoiceId}`);

    res.type('text/xml').send(
`<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}/voice-ws?callId=${encodeURIComponent(callId)}" ttsProvider="ElevenLabs" voice="${voiceId}" elevenlabsTextNormalization="on" interruptible="true" dtmfDetection="true" welcomeGreeting="${greeting}" />
  </Connect>
</Response>`);

  } catch (err) {
    console.error(`❌ Outbound TwiML error (${callId}):`, err.message);
    res.type('text/xml').send(
      `<Response><Say voice="Polly.Ruth-Generative">Sorry, something went wrong. Please try again later.</Say></Response>`
    );
  }
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
      sendCallSummary(session).catch(err => console.error('Summary error:', err.message));
    } else if (['busy', 'no-answer', 'failed'].includes(status)) {
      sendCallFailureNotice(session, status).catch(err => console.error('Failure notice error:', err.message));
    }
  } catch (err) {
    console.error(`❌ Status handler error (${callId}):`, err.message);
  } finally {
    activeCallSessions.delete(callId);
  }
});

// ── WebSocket handler for ConversationRelay ─────────────────────────────────

function handleVoiceWebSocket(ws, callId) {
  try {
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
          console.error(`❌ ConversationRelay error (${callId}):`, msg.description || JSON.stringify(msg));
        }
      } catch (err) {
        console.error(`❌ WS message error (${callId}):`, err.message, err.stack);
        try {
          ws.send(JSON.stringify({
            type: 'text',
            token: "I'm sorry, I had a brief hiccup. Could you say that again?",
            last: true,
          }));
        } catch (sendErr) {
          console.error(`❌ WS fallback send failed (${callId}):`, sendErr.message);
        }
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 WS closed: callId=${callId}, code=${code}, reason=${reason || 'none'}`);
    });

    ws.on('error', (err) => {
      console.error(`❌ WS error (${callId}):`, err.message, err.stack);
    });

  } catch (err) {
    console.error(`❌ WS handler setup error (${callId}):`, err.message, err.stack);
    try { ws.close(); } catch {}
  }
}

// ── Claude Haiku streaming — each token sent IMMEDIATELY ────────────────────

async function streamClaudeResponse(ws, session, callId) {
  const startMs = Date.now();

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-haiku-4-5-20250929',
      max_tokens: 150,
      system: VOICE_SYSTEM_PROMPT,
      messages: session.history,
    });

    let fullResponse = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const token = event.delta.text;
        fullResponse += token;

        // Send each token IMMEDIATELY — no buffering
        try {
          ws.send(JSON.stringify({
            type: 'text',
            token: token,
            last: false,
          }));
        } catch (sendErr) {
          console.error(`❌ WS send error (${callId}):`, sendErr.message);
          break;
        }
      }
    }

    // Send final empty token to signal end of response
    try {
      ws.send(JSON.stringify({
        type: 'text',
        token: '',
        last: true,
      }));
    } catch (sendErr) {
      console.error(`❌ WS final send error (${callId}):`, sendErr.message);
    }

    const claudeMs = Date.now() - startMs;

    // Store clean response in history
    const endCall = fullResponse.includes('[END_CALL]');
    const cleanText = fullResponse.replace(/\[END_CALL\]/g, '').trim();
    session.history.push({ role: 'assistant', content: cleanText });
    console.log(`🤖 AI (${callId}): "${cleanText}" [${claudeMs}ms, end=${endCall}]`);

    // End call if Claude signaled it
    if (endCall) {
      setTimeout(() => {
        try { ws.send(JSON.stringify({ type: 'end' })); } catch {}
      }, 4000);
    }

  } catch (err) {
    console.error(`❌ Claude stream error (${callId}):`, err.message, err.stack);
    try {
      ws.send(JSON.stringify({
        type: 'text',
        token: "I'm sorry, I had a brief hiccup. Could you say that again?",
        last: true,
      }));
    } catch (sendErr) {
      console.error(`❌ WS fallback send failed (${callId}):`, sendErr.message);
    }
  }
}

// ── Post-call notifications (async, never blocks) ───────────────────────────

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
  } catch (err) { console.error('❌ Summary error:', err.message); }
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
  } catch (err) { console.error('❌ Failure notice error:', err.message); }
}

// Export router + WebSocket handler
router.handleVoiceWebSocket = handleVoiceWebSocket;
module.exports = router;
