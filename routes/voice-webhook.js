/**
 * Voice Webhook — handles Twilio voice call conversation loop.
 *
 * When the AI makes an outbound call, Twilio hits these endpoints:
 *   POST /voice/outbound  — Initial connect + each speech turn
 *   POST /voice/status    — Call status updates (completed, failed, etc.)
 *
 * The conversation flow:
 *   1. Call connects → speak greeting → <Gather> to listen
 *   2. Person speaks → Twilio transcribes → we send to Claude → speak response → <Gather>
 *   3. Repeat until Claude signals [END_CALL] or person hangs up
 *   4. Status callback sends WhatsApp summary to customer
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { activeCallSessions, escapeXml } = require('../services/twilio-voice');

const anthropic = new Anthropic();

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
  const voice = session.voice || 'Polly.Joanna';
  const actionUrl = `/voice/outbound?callId=${encodeURIComponent(callId)}`;

  try {
    if (!speechResult) {
      // First hit — call just connected, deliver the greeting
      console.log(`📞 Call connected (callId: ${callId}), delivering greeting`);
      res.type('text/xml').send(
`<Response>
  <Say voice="${voice}">${escapeXml(session.initialMessage)}</Say>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US" enhanced="true">
    <Say voice="${voice}"> </Say>
  </Gather>
  <Say voice="${voice}">I didn't hear a response. Let me try once more.</Say>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="5" language="en-US" enhanced="true">
    <Say voice="${voice}">Are you there?</Say>
  </Gather>
  <Say voice="${voice}">It seems like you're not available. I'll let my client know. Goodbye!</Say>
</Response>`
      );
    } else {
      // Person spoke — add to conversation history and get AI response
      console.log(`🎙️ Speech received (callId: ${callId}): "${speechResult}"`);
      session.history.push({ role: 'user', content: speechResult });

      const aiResponse = await getVoiceAIResponse(session);
      session.history.push({ role: 'assistant', content: aiResponse.text });

      console.log(`🤖 AI response (callId: ${callId}): "${aiResponse.text}" [endCall=${aiResponse.endCall}]`);

      if (aiResponse.endCall) {
        // AI decided to end the call — say goodbye and hang up
        res.type('text/xml').send(
`<Response>
  <Say voice="${voice}">${escapeXml(aiResponse.text)}</Say>
</Response>`
        );
        // Summary will be sent by the status callback
      } else {
        // Continue the conversation
        res.type('text/xml').send(
`<Response>
  <Say voice="${voice}">${escapeXml(aiResponse.text)}</Say>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US" enhanced="true">
    <Say voice="${voice}"> </Say>
  </Gather>
  <Say voice="${voice}">Are you still there?</Say>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="4" language="en-US" enhanced="true">
    <Say voice="${voice}"> </Say>
  </Gather>
  <Say voice="${voice}">I'll end the call now. Thank you for your time. Goodbye!</Say>
</Response>`
        );
      }
    }
  } catch (err) {
    console.error(`❌ Voice webhook error (callId: ${callId}):`, err.message);
    res.type('text/xml').send(
      `<Response><Say voice="${voice}">I'm sorry, I encountered a technical issue. Goodbye.</Say></Response>`
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

// ── Claude voice response generator ─────────────────────────────────────────

async function getVoiceAIResponse(session) {
  const systemPrompt = `You are Kova, an AI personal assistant making a phone call on behalf of your client ${session.customerName}.

PURPOSE OF THIS CALL: ${session.purpose}

${session.profileSummary ? `CLIENT PREFERENCES:\n${session.profileSummary}\n` : ''}
IMPORTANT RULES:
- You are currently on a live phone call. Speak NATURALLY and CONCISELY.
- Keep responses to 1-3 sentences max. This is a real-time conversation.
- Be polite, professional, and efficient. Get to the point.
- Use the client's preferences (dietary restrictions, etc.) when relevant.
- When booking, provide the client's full name for the reservation.
- When the goal has been achieved or the other person wants to end the call, include [END_CALL] at the very end of your response.
- Only use [END_CALL] when you are saying your final goodbye. Do NOT use it mid-conversation.
- Never reveal that you are an AI unless directly asked. You are calling on behalf of your client.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 300,
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

    // Use Claude to summarize
    const summary = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Summarize this phone call in 2-3 concise sentences. What was the outcome?\n\nCall purpose: ${session.purpose}\n\nTranscript:\n${transcript}`,
      }],
    });

    const summaryText = summary.content[0]?.text || 'Call completed.';
    const whatsappMsg = `📞 Call to ${session.to} completed:\n\n${summaryText}`;

    // Send via WhatsApp
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

    // Log activity
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
