/**
 * Voice Webhook — Twilio voice call conversation loop.
 *
 * Architecture for minimum latency:
 *   1. Person speaks → Twilio sends SpeechResult
 *   2. Immediately return filler ("Got it") + <Redirect> to /voice/respond
 *   3. Meanwhile, start Claude + TTS processing in background
 *   4. When redirect hits /voice/respond, result may already be ready
 *   5. Return <Play> (external TTS) or <Say> (Polly fallback)
 *
 * TTS chain: Deepgram Aura → OpenAI → ElevenLabs → Polly.Ruth-Generative
 * STT: Twilio enhanced speech recognition
 * AI:  Claude Haiku (fast, max_tokens=40, 1 short sentence)
 */

const crypto = require('crypto');
const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { activeCallSessions, escapeXml, makeCall } = require('../services/twilio-voice');
const tts = require('../services/voice-tts');

const anthropic = new Anthropic();

// ── Pending response promises (for filler+redirect overlap) ─────────────────
const pendingResponses = new Map();

// Clean up stale pending responses
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pendingResponses) {
    if (now - p.createdAt > 30000) pendingResponses.delete(id);
  }
}, 30000);

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

// ── TTS helpers ─────────────────────────────────────────────────────────────

function sayTwiml(text, session) {
  const v = session.voice || 'Polly.Ruth-Generative';
  return `<Say voice="${v}"><prosody rate="93%"><break time="100ms"/>${escapeXml(text)}</prosody></Say>`;
}

function playOrSay(audioId, text, session) {
  const masterUrl = process.env.MASTER_API_URL;
  if (audioId && masterUrl) {
    return `<Play>${masterUrl}/voice/audio/${audioId}</Play>`;
  }
  return sayTwiml(text, session);
}

function gatherTwiml(action) {
  return `<Gather input="speech" action="${action}" method="POST" speechTimeout="1" timeout="3" language="en-US" enhanced="true" bargeIn="true"></Gather>`;
}

// ── Audio serving endpoint ──────────────────────────────────────────────────
router.get('/audio/:id', (req, res) => {
  const audio = tts.getAudio(req.params.id);
  if (!audio) return res.status(404).send('Not found');
  res.set('Content-Type', audio.contentType || 'audio/mpeg');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(audio.buffer);
});

// ── Diagnostic endpoints (admin only) ───────────────────────────────────────

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
    res.json({ success: true, ...result, activeSessions: activeCallSessions.size, ttsProvider: tts.getProvider() || 'twilio' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/debug', requireAdminAuth, (req, res) => {
  const sessions = [];
  for (const [id, s] of activeCallSessions) {
    sessions.push({ callId: id, to: s.to, purpose: s.purpose, voice: s.voice, historyLen: s.history.length, age: Math.round((Date.now() - s.createdAt) / 1000) + 's' });
  }
  res.json({ activeSessions: sessions.length, ttsProvider: tts.getProvider() || 'twilio', sessions });
});

// ── POST /voice/outbound — main Twilio webhook ─────────────────────────────
router.post('/outbound', validateTwilioVoiceSignature, async (req, res) => {
  const callId = req.query.callId;
  console.log(`📞 Webhook: callId=${callId}, sessions=${activeCallSessions.size}`);

  const session = activeCallSessions.get(callId);
  if (!session) {
    console.error(`❌ No session for callId=${callId}`);
    res.type('text/xml').send(`<Response><Say voice="Polly.Ruth-Generative">Sorry, I couldn't connect this call.</Say></Response>`);
    return;
  }

  const speech = req.body.SpeechResult;
  const action = `/voice/outbound?callId=${encodeURIComponent(callId)}`;

  try {
    if (!speech) {
      // Call just connected — deliver greeting
      console.log(`📞 Connected (${callId}), greeting`);

      // Try external TTS for greeting
      const greetAudioId = await tts.generateSpeech(
        session.initialMessage, session.voiceGender, session.customVoiceId
      ).catch(() => null);

      res.type('text/xml').send(
`<Response>
  ${playOrSay(greetAudioId, session.initialMessage, session)}
  ${gatherTwiml(action)}
  ${sayTwiml("Hello?", session)}
  ${gatherTwiml(action)}
  ${sayTwiml("Alright, I'll let you go. Bye!", session)}
</Response>`);
      return;
    }

    // ── HOT PATH: Person spoke → respond as fast as possible ──────────
    console.log(`🎙️ (${callId}): "${speech}"`);
    session.history.push({ role: 'user', content: speech });

    // Start Claude + TTS processing IMMEDIATELY in background
    const processId = crypto.randomUUID();
    const processPromise = processVoiceResponse(session);
    pendingResponses.set(processId, { promise: processPromise, createdAt: Date.now() });

    // Return filler INSTANTLY — person hears acknowledgment < 500ms
    const filler = tts.getRandomFiller(session.voiceGender);
    const fillerText = filler ? filler.text : tts.getRandomFillerText();
    const respondUrl = `/voice/respond?callId=${encodeURIComponent(callId)}&pid=${processId}`;

    res.type('text/xml').send(
`<Response>
  ${filler ? playOrSay(filler.audioId, fillerText, session) : sayTwiml(fillerText, session)}
  <Redirect method="POST">${respondUrl}</Redirect>
</Response>`);

  } catch (err) {
    console.error(`❌ Voice error (${callId}):`, err.message);
    res.type('text/xml').send(`<Response><Say voice="Polly.Ruth-Generative">Sorry, technical issue. Goodbye.</Say></Response>`);
  }
});

// ── POST /voice/respond — deliver AI response after filler ──────────────────
router.post('/respond', validateTwilioVoiceSignature, async (req, res) => {
  const callId = req.query.callId;
  const processId = req.query.pid;

  const session = activeCallSessions.get(callId);
  if (!session) {
    res.type('text/xml').send(`<Response><Say voice="Polly.Ruth-Generative">Goodbye.</Say></Response>`);
    return;
  }

  const action = `/voice/outbound?callId=${encodeURIComponent(callId)}`;

  try {
    const pending = pendingResponses.get(processId);
    if (!pending) {
      // Fallback: process inline (shouldn't happen)
      const ai = await processVoiceResponse(session);
      return sendVoiceResponse(res, ai, session, action);
    }

    // Await the result — it was started during /outbound, may already be done
    const ai = await pending.promise;
    pendingResponses.delete(processId);

    sendVoiceResponse(res, ai, session, action);

  } catch (err) {
    console.error(`❌ Respond error (${callId}):`, err.message);
    res.type('text/xml').send(`<Response><Say voice="Polly.Ruth-Generative">Sorry about that. Could you repeat that?</Say>${gatherTwiml(action)}</Response>`);
  }
});

function sendVoiceResponse(res, ai, session, action) {
  session.history.push({ role: 'assistant', content: ai.text });
  console.log(`🤖 AI: "${ai.text}" [end=${ai.endCall}] [tts=${ai.audioId ? 'external' : 'twilio'}]`);

  if (ai.endCall) {
    res.type('text/xml').send(
      `<Response>${playOrSay(ai.audioId, ai.text, session)}</Response>`
    );
  } else {
    res.type('text/xml').send(
`<Response>
  ${playOrSay(ai.audioId, ai.text, session)}
  ${gatherTwiml(action)}
  ${sayTwiml("You there?", session)}
  ${gatherTwiml(action)}
  ${sayTwiml("Okay, bye!", session)}
</Response>`);
  }
}

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

// ── Claude voice AI + TTS generation (runs in background) ───────────────────

async function processVoiceResponse(session) {
  const startMs = Date.now();

  // Ultra-minimal system prompt for speed (~150 words)
  const sys = `Live phone call. You are Kova calling for ${session.customerName}.
PURPOSE: ${session.purpose}
${session.profileSummary ? `CLIENT INFO: ${session.profileSummary}` : ''}
RULES:
- 1 sentence max. Under 12 words.
- Sound natural: use "yeah", "sure", "got it", "mm-hmm", "cool", "right", "perfect", "awesome".
- Use contractions: I'm, that's, I'll, don't, won't, can't.
- Add natural pauses: "So... table for four?" or "Right, got it."
- Give client's full name when booking.
- Say [END_CALL] when done.
- Never reveal you're AI.`;

  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 40,
    system: sys,
    messages: session.history,
  });

  let text = r.content[0]?.text || "Could you repeat that?";
  const endCall = text.includes('[END_CALL]');
  text = text.replace(/\[END_CALL\]/g, '').trim();

  const claudeMs = Date.now() - startMs;
  console.log(`⚡ Claude: ${claudeMs}ms`);

  // Generate TTS audio (if external provider available)
  let audioId = null;
  try {
    audioId = await tts.generateSpeech(text, session.voiceGender, session.customVoiceId);
  } catch {}

  const totalMs = Date.now() - startMs;
  console.log(`⚡ Total process: ${totalMs}ms (Claude ${claudeMs}ms + TTS ${totalMs - claudeMs}ms)`);

  return { text, endCall, audioId };
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
