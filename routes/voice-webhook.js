/**
 * Voice Webhook — Twilio Gather + ElevenLabs TTS (Play) with Claude Haiku.
 *
 * Optimized for low latency:
 *  - eleven_flash_v2_5 (~75ms) with mp3_22050_32 output (small files)
 *  - claude-haiku-4-5 with 80 max_tokens and short system prompt
 *  - Pre-generated greeting audio (no TTS call on incoming)
 *  - 4-message conversation history limit
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
const TTS_MODEL = 'eleven_flash_v2_5';
const BASE_URL = process.env.MASTER_API_URL || 'https://bountiful-growth-production.up.railway.app';
const AUDIO_DIR = path.join(os.tmpdir(), 'voice-audio');
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 80;
const MAX_HISTORY = 4;
const FALLBACK_VOICE = 'Polly.Joanna';

const DEFAULT_GREETING = 'Hi, this is Kova. How can I help?';
const SYSTEM_PROMPT = 'You are Kova, a phone assistant. Reply in 1 sentence. Be brief and natural.';

// Create audio directory
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Conversation history per call
const callHistory = new Map();

// Pre-generated greeting audio URL (set on startup)
let preGeneratedGreetingUrl = null;

// Clean up stale history every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of callHistory) {
    if (now - entry.createdAt > 30 * 60 * 1000) callHistory.delete(sid);
  }
}, 10 * 60 * 1000);

// Clean up old audio files every 2 minutes (keep files for 5 min)
function cleanupOldAudio() {
  try {
    const files = fs.readdirSync(AUDIO_DIR);
    const now = Date.now();
    for (const f of files) {
      if (f === 'greeting.mp3') continue; // never delete pre-generated greeting
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

  const response = await fetch(
    'https://api.elevenlabs.io/v1/text-to-speech/' + VOICE_ID + '?output_format=mp3_22050_32',
    {
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
    }
  );

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error('ElevenLabs API error: ' + response.status + ' ' + errBody);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filepath, buffer);
  return BASE_URL + '/voice-audio/' + filename;
}

// Pre-generate greeting audio on startup
async function preGenerateGreeting() {
  try {
    const filepath = path.join(AUDIO_DIR, 'greeting.mp3');
    const response = await fetch(
      'https://api.elevenlabs.io/v1/text-to-speech/' + VOICE_ID + '?output_format=mp3_22050_32',
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: DEFAULT_GREETING,
          model_id: TTS_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );
    if (!response.ok) throw new Error('ElevenLabs ' + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filepath, buffer);
    preGeneratedGreetingUrl = BASE_URL + '/voice-audio/greeting.mp3';
    console.log(`[VOICE] Pre-generated greeting audio (${buffer.length} bytes)`);
  } catch (err) {
    console.error('[VOICE] Failed to pre-generate greeting:', err.message);
  }
}
preGenerateGreeting();

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

    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';

    let audioUrl;

    if (session && session.initialMessage && session.initialMessage !== DEFAULT_GREETING) {
      // Outbound call with custom greeting — generate fresh
      console.log(`[VOICE] Outbound call connected: callId=${callId} callSid=${callSid} to=${session.to}`);
      audioUrl = await generateSpeech(session.initialMessage, callSid);
    } else {
      // Incoming call or default greeting — use pre-generated
      console.log(`[VOICE] Incoming call: callSid=${callSid}`);
      if (preGeneratedGreetingUrl) {
        audioUrl = preGeneratedGreetingUrl;
      } else {
        audioUrl = await generateSpeech(DEFAULT_GREETING, callSid);
      }
    }

    res.type('text/xml').send(twiml([
      `  <Play>${escapeXml(audioUrl)}</Play>`,
      `  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" method="POST">`,
      `  </Gather>`,
      `  <Say voice="${FALLBACK_VOICE}">Goodbye!</Say>`,
    ].join('\n')));

  } catch (err) {
    console.error('[VOICE] Incoming error:', err.message);
    const callId = req.query.callId || '';
    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';
    res.type('text/xml').send(twiml([
      `  <Say voice="${FALLBACK_VOICE}">Hi, this is Kova. How can I help?</Say>`,
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
  const startTime = Date.now();
  try {
    const speech = req.body.SpeechResult || '';
    const callSid = req.body.CallSid || 'unknown';
    const callId = req.query.callId || '';
    const session = getSessionForCall(req);

    console.log(`[VOICE] [${callSid}] Request received at ${startTime}`);
    console.log(`[VOICE] [${callSid}] Caller said: "${speech}"`);

    const actionUrl = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';

    if (!speech) {
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
      if (session.purpose) parts.push(`Goal: ${session.purpose}`);
      if (session.customerName) parts.push(`Calling for: ${session.customerName}`);
      parts.push('Say [END_CALL] when done.');
      systemPrompt = parts.join(' ');
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
    const claudeStart = Date.now();
    console.log(`[VOICE] [${callSid}] Calling Claude at ${claudeStart}`);

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

    const claudeEnd = Date.now();
    console.log(`[VOICE] [${callSid}] Claude responded at ${claudeEnd}, took ${claudeEnd - claudeStart}ms`);

    // Check for end call signal
    const shouldEnd = aiText.includes('[END_CALL]');
    aiText = aiText.replace('[END_CALL]', '').trim();

    history.messages.push({ role: 'assistant', content: aiText });
    if (history.messages.length > MAX_HISTORY) {
      history.messages = history.messages.slice(-MAX_HISTORY);
    }

    console.log(`[VOICE] [${callSid}] Kova said: "${aiText}"`);

    // Generate speech with ElevenLabs
    const ttsStart = Date.now();
    console.log(`[VOICE] [${callSid}] Calling ElevenLabs at ${ttsStart}`);

    const audioUrl = await generateSpeech(aiText, callSid);

    const ttsEnd = Date.now();
    console.log(`[VOICE] [${callSid}] ElevenLabs responded at ${ttsEnd}, took ${ttsEnd - ttsStart}ms`);

    console.log(`[VOICE] [${callSid}] Sending TwiML at ${Date.now()}, total ${Date.now() - startTime}ms`);

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
