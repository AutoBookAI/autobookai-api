/**
 * Voice Webhook — Twilio voice call conversation loop.
 *
 * Optimized for minimum latency:
 *   - Instant filler ("Got it") plays while Claude generates real response
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
const { activeCallSessions, escapeXml } = require('../services/twilio-voice');

const anthropic = new Anthropic();

// Instant filler words — rotated to sound natural
const FILLERS = ['Got it.', 'Sure.', 'Okay.', 'Right.', 'Mhm.', 'Yeah.'];
let fillerIdx = 0;
function nextFiller() {
  const f = FILLERS[fillerIdx % FILLERS.length];
  fillerIdx++;
  return f;
}

// ── TTS helper ───────────────────────────────────────────────────────────────

function say(text, session) {
  const v = session.voice || 'Polly.Ruth-Generative';
  return `<Say voice="${v}">${escapeXml(text)}</Say>`;
}

function gather(action, session, inner) {
  const v = session.voice || 'Polly.Ruth-Generative';
  return `<Gather input="speech" action="${action}" method="POST" speechTimeout="1" timeout="3" language="en-US" enhanced="true" bargeIn="true">${inner || ''}</Gather>`;
}

// ── POST /voice/outbound ────────────────────────────────────────────────────
router.post('/outbound', async (req, res) => {
  const callId = req.query.callId;
  const session = activeCallSessions.get(callId);

  if (!session) {
    res.type('text/xml').send('<Response><Say>Sorry, something went wrong.</Say></Response>');
    return;
  }

  const speech = req.body.SpeechResult;
  const action = `/voice/outbound?callId=${encodeURIComponent(callId)}`;

  try {
    if (!speech) {
      // Call just connected — deliver greeting immediately
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
    session.history.push({ role: 'user', content: speech });

    // Fire Claude request immediately (no DB calls, no delays)
    const ai = await getVoiceAIResponse(session);
    session.history.push({ role: 'assistant', content: ai.text });

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
    console.error(`Voice error (${callId}):`, err.message);
    res.type('text/xml').send('<Response><Say>Sorry, technical issue. Goodbye.</Say></Response>');
  }
});

// ── POST /voice/status ──────────────────────────────────────────────────────
router.post('/status', async (req, res) => {
  const callId = req.query.callId;
  const status = req.body.CallStatus;
  res.sendStatus(200);

  const session = activeCallSessions.get(callId);
  if (!session) return;

  // All post-call work is fire-and-forget, never blocks the call
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
