/**
 * ElevenLabs Post-Call Webhook
 *
 * Receives transcript after a voice call ends, summarizes with Claude,
 * and sends the summary to the customer via WhatsApp.
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { pendingCalls } = require('../services/twilio-voice');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post('/', async (req, res) => {
  // Always respond 200 immediately (ElevenLabs requires it)
  res.sendStatus(200);

  try {
    const { type, data } = req.body;

    if (type !== 'post_call_transcription' || !data) {
      console.log('[ELEVENLABS-WEBHOOK] Ignoring non-transcription event:', type);
      return;
    }

    const { conversation_id, transcript, status } = data;
    console.log(`[ELEVENLABS-WEBHOOK] Received transcript for conversation ${conversation_id}, status: ${status}`);

    if (!transcript || !transcript.length) {
      console.log('[ELEVENLABS-WEBHOOK] Empty transcript, skipping');
      return;
    }

    // Look up the pending call to find the customer
    const callInfo = pendingCalls.get(conversation_id);
    if (!callInfo) {
      console.warn(`[ELEVENLABS-WEBHOOK] No pending call found for conversation ${conversation_id}`);
      return;
    }

    // Clean up
    pendingCalls.delete(conversation_id);

    const { customerId, customerWhatsappFrom, purpose, to } = callInfo;

    if (!customerWhatsappFrom) {
      console.warn(`[ELEVENLABS-WEBHOOK] No WhatsApp number for customer ${customerId}`);
      return;
    }

    // Format transcript for Claude
    const transcriptText = transcript
      .map(t => `${t.role === 'agent' ? 'Kova' : 'Caller'}: ${t.message}`)
      .join('\n');

    // Summarize with Claude
    const summaryResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'Summarize this phone call as a brief update to the customer who asked for this call. Include: what was accomplished, any confirmations (reservation time, appointment date, confirmation number), what the customer needs to know, and any follow-up needed. Be friendly and concise. Start with a checkmark if successful or an X if unsuccessful. Example: "Done! Reservation confirmed — table for 4 at Olive Garden, Saturday 7:30pm. They said to ask for the booth section when you arrive." Do not use markdown.',
      messages: [{
        role: 'user',
        content: `Phone call to ${to}\nPurpose: ${purpose}\n\nTranscript:\n${transcriptText}`,
      }],
    });

    const summary = summaryResponse.content[0]?.text || 'Call completed but could not generate summary.';

    // Send WhatsApp message to customer
    const twilioClient = require('twilio')(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const kovaNumber = process.env.TWILIO_PHONE_NUMBER || process.env.KOVA_WHATSAPP_NUMBER;

    await twilioClient.messages.create({
      from: `whatsapp:${kovaNumber}`,
      to: `whatsapp:${customerWhatsappFrom}`,
      body: `Call update:\n\n${summary}`,
    });

    console.log(`[ELEVENLABS-WEBHOOK] Sent call summary to ${customerWhatsappFrom} for customer ${customerId}`);

    // Update call_memory with outcome and transcript
    try {
      await pool.query(
        `UPDATE call_memory SET call_outcome = $1, call_transcript = $2, updated_at = NOW()
         WHERE elevenlabs_conversation_id = $3`,
        [summary, transcriptText, conversation_id]
      );
      console.log(`[ELEVENLABS-WEBHOOK] Updated call_memory for conversation ${conversation_id}`);
    } catch (memErr) {
      console.error('[ELEVENLABS-WEBHOOK] Failed to update call_memory:', memErr.message);
    }

    // Log to activity_log
    await pool.query(
      `INSERT INTO activity_log (customer_id, event_type, description, metadata)
       VALUES ($1, 'call_summary', $2, $3)`,
      [
        customerId,
        `Call summary sent for call to ${to}`,
        JSON.stringify({
          conversation_id,
          to,
          purpose,
          transcript_length: transcript.length,
          summary,
        }),
      ]
    );

    // Track call_minutes usage (estimate ~1 minute per 10 transcript entries, minimum 1)
    const estimatedMinutes = Math.max(1, Math.round(transcript.length / 10));
    const { incrementUsage } = require('../services/usage');
    await incrementUsage(customerId, 'call_minutes', estimatedMinutes);

  } catch (err) {
    console.error('[ELEVENLABS-WEBHOOK] Error processing post-call webhook:', err.message);
  }
});

module.exports = router;
