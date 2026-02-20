/**
 * Voice Webhook — Twilio voice call conversation loop.
 *
 * Endpoints:
 *   POST /voice/outbound  — Initial connect + each speech turn
 *   POST /voice/status    — Call status updates
 *
 * TTS: Amazon Polly Generative voices via Twilio <Say> (no extra API key)
 *      Ruth-Generative (female), Matthew-Generative (male)
 * STT: Twilio enhanced speech recognition
 * AI:  Claude Haiku (fast) with natural conversational prompt
 *
 * Features: barge-in, 1s speech timeout, natural fillers
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { activeCallSessions, escapeXml } = require('../services/twilio-voice');

const anthropic = new Anthropic();

// ── TTS helper ───────────────────────────────────────────────────────────────

function say(text, session) {
  const v = session.voice || 'Polly.Ruth-Generative';
  return `<Say voice="${v}">${escapeXml(text)}</Say>`;
}

// ── POST /voice/outbound ────────────────────────────────────────────────────
router.post('/outbound', async (req, res) => {
  const callId = req.query.callId;
  const session = activeCallSessions.get(callId);

  if (!session) {
    console.warn(`⚠️ Voice: no session for ${callId}`);
    res.type('text/xml').send('<Response><Say>Sorry, something went wrong.</Say></Response>');
    return;
  }

  const speech = req.body.SpeechResult;
  const action = `/voice/outbound?callId=${encodeURIComponent(callId)}`;

  try {
    if (!speech) {
      // Call just connected — deliver greeting
      console.log(`📞 Connected (${callId})`);
      const greeting = say(session.initialMessage, session);
      res.type('text/xml').send(
`<Response>
  ${greeting}
  <Gather input="speech" action="${action}" method="POST" speechTimeout="1" language="en-US" enhanced="true" bargeIn="true">
    <Pause length="10"/>
  </Gather>
  ${say("Hello? You still there?", session)}
  <Gather input="speech" action="${action}" method="POST" speechTimeout="3" language="en-US" enhanced="true" bargeIn="true">
    ${say("Are you there?", session)}
  </Gather>
  ${say("Alright, seems like you're busy. I'll let my client know. Bye!", session)}
</Response>`);
    } else {
      console.log(`🎙️ Speech (${callId}): "${speech}"`);
      session.history.push({ role: 'user', content: speech });

      const ai = await getVoiceAIResponse(session);
      session.history.push({ role: 'assistant', content: ai.text });
      console.log(`🤖 AI (${callId}): "${ai.text}" [end=${ai.endCall}]`);

      const twiml = say(ai.text, session);

      if (ai.endCall) {
        res.type('text/xml').send(`<Response>${twiml}</Response>`);
      } else {
        res.type('text/xml').send(
`<Response>
  ${twiml}
  <Gather input="speech" action="${action}" method="POST" speechTimeout="1" language="en-US" enhanced="true" bargeIn="true">
    <Pause length="10"/>
  </Gather>
  ${say("Hey, you still there?", session)}
  <Gather input="speech" action="${action}" method="POST" speechTimeout="3" language="en-US" enhanced="true" bargeIn="true">
    <Pause length="5"/>
  </Gather>
  ${say("Alright, I'll let you go. Thanks! Bye.", session)}
</Response>`);
      }
    }
  } catch (err) {
    console.error(`❌ Voice error (${callId}):`, err.message);
    res.type('text/xml').send('<Response><Say>Sorry, technical issue. Goodbye.</Say></Response>');
  }
});

// ── POST /voice/status ──────────────────────────────────────────────────────
router.post('/status', async (req, res) => {
  const callId = req.query.callId;
  const status = req.body.CallStatus;
  console.log(`📞 Status (${callId}): ${status}, ${req.body.CallDuration}s`);
  res.sendStatus(200);

  const session = activeCallSessions.get(callId);
  if (!session) return;

  try {
    if (status === 'completed' && session.history.length > 0) {
      await sendCallSummary(session);
    } else if (['busy', 'no-answer', 'failed'].includes(status)) {
      await sendCallFailureNotice(session, status);
    }
  } catch (err) {
    console.error(`Notification error (${callId}):`, err.message);
  } finally {
    activeCallSessions.delete(callId);
  }
});

// ── Claude voice AI ─────────────────────────────────────────────────────────

async function getVoiceAIResponse(session) {
  const sys = `You are on a live phone call. Sound like a real human. You are Kova, calling on behalf of ${session.customerName}.

CALL PURPOSE: ${session.purpose}
${session.profileSummary ? `\nCLIENT INFO:\n${session.profileSummary}` : ''}

RULES:
- Keep responses to 1 SHORT sentence. Max 15 words.
- Sound human. Use casual words: "yeah", "sure", "got it", "oh nice", "cool", "so", "right".
- Start with a filler sometimes: "So,", "Oh,", "Yeah,", "Sure thing,", "Got it,", "Mhm,".
- Use contractions always: I'm, we're, that's, I'll, don't, can't, won't.
- Never sound scripted or robotic. Talk like a friend on the phone.
- Add "um" or "uh" very occasionally for natural flow.
- When booking, give client's full name.
- When done or they want to hang up, end with [END_CALL].
- Don't say you're AI unless asked directly.

EXAMPLES:
"Hey! So, I'm calling for ${session.customerName} — got any tables open tonight?"
"Oh perfect, yeah 7:30 works great."
"Got it, that'll be under ${session.customerName}."
"Awesome, thanks so much! Bye!"`;

  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    system: sys,
    messages: session.history,
  });

  const text = r.content[0]?.text || "Sorry, could you say that again?";
  const endCall = text.includes('[END_CALL]');
  return { text: text.replace(/\[END_CALL\]/g, '').trim(), endCall };
}

// ── Call summary / failure ──────────────────────────────────────────────────

async function sendCallSummary(session) {
  try {
    const transcript = session.history.map(m =>
      `${m.role === 'user' ? 'Them' : 'Kova'}: ${m.content}`
    ).join('\n');

    const summary = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: `Summarize this call in 2 sentences. Outcome?\n\nPurpose: ${session.purpose}\n\n${transcript}` }],
    });

    const text = summary.content[0]?.text || 'Call completed.';
    const msg = `📞 Call to ${session.to} completed:\n\n${text}`;

    if (session.customerWhatsappFrom) {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const from = process.env.TWILIO_WHATSAPP_NUMBER;
      if (from) {
        await twilio.messages.create({ from: `whatsapp:${from}`, to: `whatsapp:${session.customerWhatsappFrom}`, body: msg });
        console.log(`📱 Summary sent to ${session.customerWhatsappFrom}`);
      }
    }

    if (session.customerId) {
      await pool.query(
        'INSERT INTO activity_log (customer_id, event_type, description, metadata) VALUES ($1, $2, $3, $4)',
        [session.customerId, 'voice_call_completed', `Call to ${session.to}`,
         JSON.stringify({ purpose: session.purpose, turns: session.history.length, transcript })]
      );
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
      await pool.query('INSERT INTO activity_log (customer_id, event_type, description) VALUES ($1, $2, $3)',
        [session.customerId, 'voice_call_failed', `Call to ${session.to}: ${reason}`]);
    }
  } catch (err) { console.error('Failure notice error:', err.message); }
}

module.exports = router;
