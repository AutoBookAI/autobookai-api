/**
 * Voice Webhook — handles Twilio voice call conversation loop.
 *
 * When the AI makes an outbound call, Twilio hits these endpoints:
 *   POST /voice/outbound  — Initial connect + each speech turn
 *   POST /voice/status    — Call status updates (completed, failed, etc.)
 *   GET  /audio/:id       — Serve ElevenLabs-generated audio clips
 *
 * The conversation flow:
 *   1. Call connects → speak greeting → <Gather> to listen
 *   2. Person speaks → Twilio transcribes → we send to Claude → speak response → <Gather>
 *   3. Repeat until Claude signals [END_CALL] or person hangs up
 *   4. Status callback sends WhatsApp summary to customer
 *
 * TTS priority: ElevenLabs (if ELEVENLABS_API_KEY set) → Twilio Neural2 fallback
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { activeCallSessions, escapeXml } = require('../services/twilio-voice');
const { generateSpeech, getAudio, isConfigured: elevenLabsConfigured } = require('../services/elevenlabs-tts');

const anthropic = new Anthropic();

// ── TTS helpers ──────────────────────────────────────────────────────────────

// Wrap text in SSML prosody for natural pacing (Twilio fallback only)
function ssml(text) {
  const escaped = escapeXml(text);
  const withPauses = escaped
    .replace(/\. /g, '. <break time="250ms"/> ')
    .replace(/\? /g, '? <break time="300ms"/> ')
    .replace(/! /g, '! <break time="250ms"/> ');
  return `<speak><prosody rate="94%">${withPauses}</prosody></speak>`;
}

/**
 * Generate TwiML speech element — tries ElevenLabs first, falls back to Twilio <Say>.
 *
 * @param {string} text - Text to speak
 * @param {object} session - Call session (for voice/gender info)
 * @returns {string} TwiML fragment (<Play> or <Say>)
 */
async function speak(text, session) {
  if (elevenLabsConfigured()) {
    const gender = session.voiceGender || 'female';
    const audioId = await generateSpeech(text, gender);
    if (audioId) {
      const masterApiUrl = process.env.MASTER_API_URL;
      return `<Play>${masterApiUrl}/voice/audio/${audioId}</Play>`;
    }
  }
  // Fallback to Twilio TTS
  const voice = session.voice || 'Google.en-US-Neural2-F';
  return `<Say voice="${voice}">${ssml(text)}</Say>`;
}

// Quick Twilio <Say> for short filler phrases (no ElevenLabs needed)
function sayQuick(text, session) {
  const voice = session.voice || 'Google.en-US-Neural2-F';
  return `<Say voice="${voice}">${ssml(text)}</Say>`;
}

// ── GET /audio/:id — Serve ElevenLabs audio clips ───────────────────────────
router.get('/audio/:id', (req, res) => {
  const buffer = getAudio(req.params.id);
  if (!buffer) return res.sendStatus(404);
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'no-cache');
  res.send(buffer);
});

// ── POST /voice/outbound — Main conversation loop ───────────────────────────
router.post('/outbound', async (req, res) => {
  const callId = req.query.callId;
  const session = activeCallSessions.get(callId);

  if (!session) {
    console.warn(`⚠️ Voice webhook: no session for callId ${callId}`);
    res.type('text/xml').send('<Response><Say>Sorry, something went wrong. Goodbye.</Say></Response>');
    return;
  }

  const speechResult = req.body.SpeechResult;
  const actionUrl = `/voice/outbound?callId=${encodeURIComponent(callId)}`;

  try {
    if (!speechResult) {
      // First hit — call just connected, deliver the greeting
      console.log(`📞 Call connected (callId: ${callId}), delivering greeting`);
      const greetingTwiml = await speak(session.initialMessage, session);
      res.type('text/xml').send(
`<Response>
  ${greetingTwiml}
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US" enhanced="true">
    <Pause length="10"/>
  </Gather>
  ${sayQuick("I didn't hear a response. Let me try once more.", session)}
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="5" language="en-US" enhanced="true">
    ${sayQuick("Are you there?", session)}
  </Gather>
  ${sayQuick("It seems like you're not available. I'll let my client know. Goodbye!", session)}
</Response>`
      );
    } else {
      // Person spoke — add to conversation history and get AI response
      console.log(`🎙️ Speech received (callId: ${callId}): "${speechResult}"`);
      session.history.push({ role: 'user', content: speechResult });

      const aiResponse = await getVoiceAIResponse(session);
      session.history.push({ role: 'assistant', content: aiResponse.text });

      console.log(`🤖 AI response (callId: ${callId}): "${aiResponse.text}" [endCall=${aiResponse.endCall}]`);

      const responseTwiml = await speak(aiResponse.text, session);

      if (aiResponse.endCall) {
        res.type('text/xml').send(
`<Response>
  ${responseTwiml}
</Response>`
        );
      } else {
        res.type('text/xml').send(
`<Response>
  ${responseTwiml}
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="2" language="en-US" enhanced="true">
    <Pause length="10"/>
  </Gather>
  ${sayQuick("Are you still there?", session)}
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="3" language="en-US" enhanced="true">
    <Pause length="5"/>
  </Gather>
  ${sayQuick("I'll end the call now. Thank you for your time. Goodbye!", session)}
</Response>`
        );
      }
    }
  } catch (err) {
    console.error(`❌ Voice webhook error (callId: ${callId}):`, err.message);
    res.type('text/xml').send(
      `<Response><Say>I'm sorry, I encountered a technical issue. Goodbye.</Say></Response>`
    );
  }
});

// ── POST /voice/status — Call status updates ─────────────────────────────────
router.post('/status', async (req, res) => {
  const callId = req.query.callId;
  const callStatus = req.body.CallStatus;
  const callDuration = req.body.CallDuration;

  console.log(`📞 Call status (callId: ${callId}): ${callStatus}, duration: ${callDuration}s`);

  res.sendStatus(200);

  const session = activeCallSessions.get(callId);
  if (!session) return;

  try {
    if (callStatus === 'completed' && session.history.length > 0) {
      await sendCallSummary(session);
    } else if (callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
      await sendCallFailureNotice(session, callStatus);
    }
  } catch (err) {
    console.error(`Failed to send call notification (callId: ${callId}):`, err.message);
  } finally {
    activeCallSessions.delete(callId);
  }
});

// ── Claude voice response generator (Haiku for speed) ────────────────────────

async function getVoiceAIResponse(session) {
  const systemPrompt = `You are Kova, an AI assistant on a live phone call for your client ${session.customerName}.

CALL PURPOSE: ${session.purpose}

${session.profileSummary ? `CLIENT INFO:\n${session.profileSummary}\n` : ''}RULES:
- This is a LIVE phone call. Be brief and natural.
- MAX 1-2 sentences per response. Never more.
- Be conversational, warm, and efficient.
- Use the client's name and preferences when booking.
- When the goal is achieved or the person wants to end the call, include [END_CALL] at the end.
- Only use [END_CALL] on your final goodbye.
- You are calling on behalf of your client. Don't say you're AI unless asked directly.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: systemPrompt,
    messages: session.history,
  });

  const text = response.content[0]?.text || "I'm sorry, could you repeat that?";
  const endCall = text.includes('[END_CALL]');

  return {
    text: text.replace(/\[END_CALL\]/g, '').trim(),
    endCall,
  };
}

// ── WhatsApp call summary ────────────────────────────────────────────────────

async function sendCallSummary(session) {
  try {
    const transcript = session.history
      .map(m => `${m.role === 'user' ? 'Them' : 'Kova'}: ${m.content}`)
      .join('\n');

    const summary = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Summarize this phone call in 2-3 concise sentences. What was the outcome?\n\nCall purpose: ${session.purpose}\n\nTranscript:\n${transcript}`,
      }],
    });

    const summaryText = summary.content[0]?.text || 'Call completed.';
    const whatsappMsg = `📞 Call to ${session.to} completed:\n\n${summaryText}`;

    if (session.customerWhatsappFrom) {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
      if (fromNumber) {
        await twilio.messages.create({
          from: `whatsapp:${fromNumber}`,
          to: `whatsapp:${session.customerWhatsappFrom}`,
          body: whatsappMsg,
        });
        console.log(`📱 Call summary sent via WhatsApp to ${session.customerWhatsappFrom}`);
      }
    }

    if (session.customerId) {
      await pool.query(
        'INSERT INTO activity_log (customer_id, event_type, description, metadata) VALUES ($1, $2, $3, $4)',
        [session.customerId, 'voice_call_completed',
         `Conversational call to ${session.to}`,
         JSON.stringify({ purpose: session.purpose, turns: session.history.length, transcript })]
      );
    }
  } catch (err) {
    console.error('Failed to send call summary:', err.message);
  }
}

async function sendCallFailureNotice(session, status) {
  try {
    if (!session.customerWhatsappFrom) return;

    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
    if (!fromNumber) return;

    const statusMsg = status === 'busy' ? 'The line was busy'
      : status === 'no-answer' ? 'No one answered'
      : 'The call could not be completed';

    await twilio.messages.create({
      from: `whatsapp:${fromNumber}`,
      to: `whatsapp:${session.customerWhatsappFrom}`,
      body: `📞 Call to ${session.to}: ${statusMsg}. Would you like me to try again?`,
    });

    if (session.customerId) {
      await pool.query(
        'INSERT INTO activity_log (customer_id, event_type, description) VALUES ($1, $2, $3)',
        [session.customerId, 'voice_call_failed', `Call to ${session.to}: ${statusMsg}`]
      );
    }
  } catch (err) {
    console.error('Failed to send call failure notice:', err.message);
  }
}

module.exports = router;
