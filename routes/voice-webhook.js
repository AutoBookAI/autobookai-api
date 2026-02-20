/**
 * Voice Webhook — Twilio Gather + ElevenLabs TTS (Play) with Claude Haiku.
 *
 * Uses ElevenLabs cloned voice for natural-sounding speech instead of Twilio's
 * built-in TTS. Audio is generated via ElevenLabs API, saved as MP3, served
 * statically, and played with Twilio's <Play> verb.
 *
 * Flow:
 *   1. Call comes in → GET/POST / → ElevenLabs greeting → <Play> + <Gather>
 *   2. Caller speaks → POST /respond → Claude Haiku → ElevenLabs TTS → <Play> + <Gather>
 *   3. Call ends → POST /status → clean up history + audio files
 */

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { activeCallSessions } = require('../services/twilio-voice');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Config ───────────────────────────────────────────────────────────────────

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const TTS_MODEL = 'eleven_turbo_v2_5';
const BASE_URL = process.env.MASTER_API_URL || 'https://bountiful-growth-production.up.railway.app';
const AUDIO_DIR = path.join(os.tmpdir(), 'voice-audio');
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 100;
const MAX_HISTORY = 8;
const FALLBACK_VOICE = 'Polly.Joanna';

const DEFAULT_GREETING = 'Hi! This is Kova, your AI assistant. How can I help you today?';
const SYSTEM_PROMPT = 'You are Kova, a friendly AI phone assistant. Reply in 1-2 short sentences. Sound natural and conversational. Never use markdown or formatting. Never say as an AI.';

// Create audio directory
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Conversation history per call
const callHistory = new Map();

// Clean up stale history every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of callHistory) {
    if (now - entry.createdAt > 30 * 60 * 1000) callHistory.delete(sid);
  }
}, 10 * 60 * 1000);

// Clean up old audio files every 2 minutes
function cleanupOldAudio() {
  try {
    const files = fs.readdirSync(AUDIO_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(AUDIO_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 5 * 60 * 1000) fs.unlinkSync(fp);
    }
  } catch (e) { /* ignore */ }
}
setInterval(cleanupOldAudio, 2 * 60 * 1000);

// ── ElevenLabs TTS ──────────────────────────────────────────────────────────

async function generateSpeech(text, callSid) {
  const filename = callSid + '-' + Date.now() + '.mp3';
  const filepath = path.join(AUDIO_DIR, filename);

  const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + VOICE_ID, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: text,
      model_id: TTS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error('ElevenLabs API error: ' + response.status + ' ' + errBody);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filepath, buffer);
  console.log(`[VOICE] Generated audio: ${filename} (${buffer.length} bytes)`);
  return BASE_URL + '/voice-audio/' + filename;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getSessionForCall(req) {
  const callId = req.query.callId;
  if (callId && activeCallSessions.has(callId)) return activeCallSessions.get(callId);
  return null;
}

function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;
}

// ── GET and POST / — greeting ───────────────────────────────────────────────

async function handleIncoming(req, res) {
  try {
    const session = getSessionForCall(req);
    const callId = req.query.callId || '';
    const callSid = req.body?.CallSid || req.query?.CallSid || 'greeting-' + Date.now();

    let greeting = DEFAULT_GREETING;
    if (session) {
      greeting = session.initialMessage || DEFAULT_GREETING;
      console.log(`[VOICE] Outbound call connected: callId=${callId} callSid=${callSid} to=${session.to}`);
    } else {
      console.log(`[VOICE] Incoming call: callSid=${callSid}`);
    }

    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';

    // Generate greeting with ElevenLabs
    const audioUrl = await generateSpeech(greeting, callSid);

    res.type('text/xml').send(twiml([
      `  <Play>${escapeXml(audioUrl)}</Play>`,
      `  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" method="POST">`,
      `  </Gather>`,
      `  <Say voice="${FALLBACK_VOICE}">Goodbye!</Say>`,
    ].join('\n')));

  } catch (err) {
    console.error('[VOICE] Incoming error:', err.message);
    // Fallback to Twilio TTS if ElevenLabs fails
    const callId = req.query.callId || '';
    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';
    res.type('text/xml').send(twiml([
      `  <Say voice="${FALLBACK_VOICE}">Hi, this is Kova. How can I help you?</Say>`,
      `  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" method="POST">`,
      `  </Gather>`,
      `  <Say voice="${FALLBACK_VOICE}">Goodbye!</Say>`,
    ].join('\n')));
  }
}

router.get('/', handleIncoming);
router.post('/', handleIncoming);

// ── POST /respond — Claude Haiku + ElevenLabs TTS ──────────────────────────

router.post('/respond', async (req, res) => {
  try {
    const speech = req.body.SpeechResult || '';
    const callSid = req.body.CallSid || 'unknown';
    const callId = req.query.callId || '';
    const session = getSessionForCall(req);

    console.log(`[VOICE] [${callSid}] Caller said: "${speech}"`);

    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';

    if (!speech) {
      // No speech detected — try ElevenLabs for the prompt, fallback to Say
      try {
        const audioUrl = await generateSpeech("I didn't catch that. Could you say that again?", callSid);
        res.type('text/xml').send(twiml([
          `  <Play>${escapeXml(audioUrl)}</Play>`,
          `  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" method="POST">`,
          `  </Gather>`,
          `  <Say voice="${FALLBACK_VOICE}">Goodbye.</Say>`,
        ].join('\n')));
      } catch (ttsErr) {
        res.type('text/xml').send(twiml([
          `  <Say voice="${FALLBACK_VOICE}">I didn't catch that. Could you say that again?</Say>`,
          `  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" method="POST">`,
          `  </Gather>`,
          `  <Say voice="${FALLBACK_VOICE}">Goodbye.</Say>`,
        ].join('\n')));
      }
      return;
    }

    // Build system prompt with context from session
    let systemPrompt = SYSTEM_PROMPT;
    if (session) {
      const parts = [SYSTEM_PROMPT];
      if (session.purpose) parts.push(`Goal of this call: ${session.purpose}`);
      if (session.customerName) parts.push(`You are calling on behalf of: ${session.customerName}`);
      if (session.profileSummary) parts.push(`Client preferences:\n${session.profileSummary}`);
      parts.push('When the conversation goal is achieved or the person wants to end the call, say exactly [END_CALL] at the end of your response.');
      systemPrompt = parts.join('\n\n');
    }

    // Get or create conversation history
    const historyKey = callId || callSid;
    if (!callHistory.has(historyKey)) {
      callHistory.set(historyKey, { messages: [], createdAt: Date.now() });
    }
    const history = callHistory.get(historyKey);
    history.messages.push({ role: 'user', content: speech });

    if (history.messages.length > MAX_HISTORY) {
      history.messages = history.messages.slice(-MAX_HISTORY);
    }

    // Call Claude Haiku
    let aiText = "Sorry, could you repeat that?";
    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: history.messages,
      });
      aiText = response.content[0]?.text || aiText;
    } catch (claudeErr) {
      console.error('[VOICE] Claude API error:', claudeErr.message);
    }

    // Check for end call signal
    const shouldEnd = aiText.includes('[END_CALL]');
    aiText = aiText.replace('[END_CALL]', '').trim();

    history.messages.push({ role: 'assistant', content: aiText });
    if (history.messages.length > MAX_HISTORY) {
      history.messages = history.messages.slice(-MAX_HISTORY);
    }

    console.log(`[VOICE] [${callSid}] Kova said: "${aiText}"`);

    // Generate speech with ElevenLabs
    const audioUrl = await generateSpeech(aiText, callSid);

    if (shouldEnd) {
      console.log(`[VOICE] [${callSid}] Call ending (goal achieved)`);
      res.type('text/xml').send(twiml([
        `  <Play>${escapeXml(audioUrl)}</Play>`,
        `  <Say voice="${FALLBACK_VOICE}">Goodbye!</Say>`,
      ].join('\n')));
    } else {
      res.type('text/xml').send(twiml([
        `  <Play>${escapeXml(audioUrl)}</Play>`,
        `  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" method="POST">`,
        `  </Gather>`,
        `  <Say voice="${FALLBACK_VOICE}">Are you still there? Goodbye.</Say>`,
      ].join('\n')));
    }

  } catch (err) {
    console.error('[VOICE] Respond error:', err.message, err.stack);
    const callId = req.query.callId || '';
    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';
    res.type('text/xml').send(twiml([
      `  <Say voice="${FALLBACK_VOICE}">Sorry, could you repeat that?</Say>`,
      `  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" method="POST">`,
      `  </Gather>`,
      `  <Say voice="${FALLBACK_VOICE}">Goodbye.</Say>`,
    ].join('\n')));
  }
});

// ── POST /status — clean up ─────────────────────────────────────────────────

router.post('/status', (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const status = req.body.CallStatus;
    const callId = req.query.callId || '';

    console.log(`[VOICE] Call status: ${callSid} → ${status}`);

    if (callSid && callHistory.has(callSid)) {
      callHistory.delete(callSid);
      console.log(`[VOICE] Cleared history for callSid=${callSid}`);
    }
    if (callId && callHistory.has(callId)) {
      callHistory.delete(callId);
      console.log(`[VOICE] Cleared history for callId=${callId}`);
    }
    if (callId && activeCallSessions.has(callId)) {
      activeCallSessions.delete(callId);
      console.log(`[VOICE] Cleaned up session for callId=${callId}`);
    }
  } catch (err) {
    console.error('[VOICE] Status error:', err.message);
  }
  res.sendStatus(200);
});

// ── GET and POST /fallback ──────────────────────────────────────────────────

function handleFallback(req, res) {
  try {
    console.error('[VOICE] Fallback triggered:', JSON.stringify(req.body || req.query));
    res.type('text/xml').send(twiml(
      `  <Say voice="${FALLBACK_VOICE}">Sorry, something went wrong. Please try calling back. Goodbye.</Say>`
    ));
  } catch (err) {
    console.error('[VOICE] Fallback error:', err.message);
    res.type('text/xml').send(twiml(
      '  <Say>Sorry, something went wrong. Goodbye.</Say>'
    ));
  }
}

router.get('/fallback', handleFallback);
router.post('/fallback', handleFallback);

module.exports = router;
