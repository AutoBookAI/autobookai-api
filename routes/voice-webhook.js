/**
 * Voice Webhook — Twilio voice call conversation loop.
 *
 * Optimized for minimum latency:
 *   - Claude Haiku with max_tokens=40 for ultra-short replies
 *   - No DB calls in the hot path
 *   - speechTimeout=1, timeout=3 for fast turn-taking
 *
 * TTS: Amazon Polly Generative voices via Twilio <Say> (no extra API key)
 * STT: Twilio enhanced speech recognition
 * AI:  Claude Haiku (fast, 1 short sentence max)
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { activeCallSessions, escapeXml, makeCall } = require('../services/twilio-voice');

const anthropic = new Anthropic();

// ── Twilio signature verification for voice webhooks ──────────────────────
function validateTwilioVoiceSignature(req, res, next) {
  const twilio = require('twilio');
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return next(); // Skip in dev if not configured

  const baseUrl = process.env.MASTER_API_URL;
  if (!baseUrl) return next();

  const webhookUrl = `${baseUrl}${req.originalUrl}`;
  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    console.warn('Missing X-Twilio-Signature on voice webhook');
    return res.type('text/xml').status(403).send('<Response/>');
  }

  const isValid = twilio.validateRequest(authToken, signature, webhookUrl, req.body);
  if (!isValid) {
    console.warn('Invalid Twilio signature on voice webhook — rejecting');
    return res.type('text/xml').status(403).send('<Response/>');
  }
  next();
}

// ── TTS helper ───────────────────────────────────────────────────────────────

function say(text, session) {
  const v = session.voice || 'Polly.Ruth-Generative';
  return `<Say voice="${v}"><prosody rate="95%">${escapeXml(text)}</prosody></Say>`;
}

function gather(action, session) {
  return `<Gather input="speech" action="${action}" method="POST" speechTimeout="1" timeout="3" language="en-US" enhanced="true" bargeIn="true"></Gather>`;
}

// ── Admin-only guard for diagnostic endpoints ───────────────────────────────
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

// ── GET /voice/test-call — make a test call from WITHIN the server process ──
router.get('/test-call', requireAdminAuth, async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ error: 'Missing ?to= parameter' });
  try {
    const result = await makeCall({
      to,
      message: 'Hi, this is Kova. Just a quick test call to make sure everything is working. How are you?',
      purpose: 'Test call to verify voice system works end-to-end',
      customerId: 1,
    });
    console.log(`🧪 Test call initiated: ${JSON.stringify(result)}`);
    console.log(`🧪 Active sessions: ${activeCallSessions.size}, keys: [${[...activeCallSessions.keys()].join(', ')}]`);
    res.json({ success: true, ...result, activeSessions: activeCallSessions.size });
  } catch (err) {
    console.error('Test call failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /voice/debug — show active sessions ─────────────────────────────────
router.get('/debug', requireAdminAuth, (req, res) => {
  const sessions = [];
  for (const [id, s] of activeCallSessions) {
    sessions.push({ callId: id, to: s.to, purpose: s.purpose, voice: s.voice, historyLen: s.history.length, age: Math.round((Date.now() - s.createdAt) / 1000) + 's' });
  }
  res.json({ activeSessions: sessions.length, sessions });
});

// ── POST /voice/outbound ────────────────────────────────────────────────────
router.post('/outbound', validateTwilioVoiceSignature, async (req, res) => {
  const callId = req.query.callId;
  console.log(`📞 Voice webhook hit: callId=${callId}, activeSessions=${activeCallSessions.size}`);

  const session = activeCallSessions.get(callId);

  if (!session) {
    console.error(`❌ No session found for callId=${callId}. Active keys: [${[...activeCallSessions.keys()].join(', ')}]`);
    res.type('text/xml').send(`<Response><Say voice="Polly.Ruth-Generative">Sorry, I couldn't connect this call. Please try again.</Say></Response>`);
    return;
  }

  const speech = req.body.SpeechResult;
  const action = `/voice/outbound?callId=${encodeURIComponent(callId)}`;

  try {
    if (!speech) {
      // Call just connected — deliver greeting immediately
      console.log(`📞 Call connected (${callId}), delivering greeting`);
      res.type('text/xml').send(
`<Response>
  ${say(session.initialMessage, session)}
  ${gather(action, session)}
  ${say("Hello?", session)}
  ${gather(action, session)}
  ${say("Alright, I'll let you go. Bye!", session)}
</Response>`);
      return;
    }

    // Hot path: person spoke → respond FAST
    console.log(`🎙️ Speech (${callId}): "${speech}"`);
    session.history.push({ role: 'user', content: speech });

    // Fire Claude request immediately (no DB calls, no delays)
    const ai = await getVoiceAIResponse(session);
    session.history.push({ role: 'assistant', content: ai.text });
    console.log(`🤖 AI (${callId}): "${ai.text}" [end=${ai.endCall}]`);

    if (ai.endCall) {
      res.type('text/xml').send(`<Response>${say(ai.text, session)}</Response>`);
    } else {
      res.type('text/xml').send(
`<Response>
  ${say(ai.text, session)}
  ${gather(action, session)}
  ${say("You there?", session)}
  ${gather(action, session)}
  ${say("Okay, bye!", session)}
</Response>`);
    }
  } catch (err) {
    console.error(`❌ Voice error (${callId}):`, err.message, err.stack);
    res.type('text/xml').send(`<Response><Say voice="Polly.Ruth-Generative">Sorry, technical issue. Goodbye.</Say></Response>`);
  }
});

// ── POST /voice/status ──────────────────────────────────────────────────────
router.post('/status', validateTwilioVoiceSignature, async (req, res) => {
  const callId = req.query.callId;
  const status = req.body.CallStatus;
  console.log(`📞 Call status (${callId}): ${status}`);
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

// ── Claude voice AI — ultra-fast, ultra-brief ───────────────────────────────

async function getVoiceAIResponse(session) {
  const sys = `You are on a live phone call. You are Kova, calling on behalf of ${session.customerName}.

PURPOSE: ${session.purpose}
${session.profileSummary ? `\nCLIENT: ${session.profileSummary}` : ''}

CRITICAL RULES:
- Respond in 1 short sentence ONLY. Max 10 words. Be extremely brief.
- Sound human. Use: "yeah", "sure", "got it", "cool", "right", "perfect".
- Use contractions: I'm, that's, I'll, don't, won't.
- When booking, give client's full name.
- When done, end with [END_CALL].
- Never say you're AI.

EXAMPLES:
"Hey, calling for ${session.customerName} — table for four tonight?"
"Perfect, 7:30 works great."
"Under ${session.customerName}, thanks!"
"Awesome, thanks! Bye! [END_CALL]"`;

  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 40,
    system: sys,
    messages: session.history,
  });

  const text = r.content[0]?.text || "Could you repeat that?";
  const endCall = text.includes('[END_CALL]');
  return { text: text.replace(/\[END_CALL\]/g, '').trim(), endCall };
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

module.exports = router;
