/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  WARNING: INBOUND VOICE CALLS ARE HANDLED BY ELEVENLABS            ║
 * ║                                                                     ║
 * ║  The Twilio voice webhook for +19785588477 points to:              ║
 * ║  https://api.us.elevenlabs.io/twilio/inbound_call                  ║
 * ║                                                                     ║
 * ║  DO NOT change the Twilio phone number's Voice URL.                ║
 * ║  This file is ONLY used as a backup / for outbound call fallback.  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Voice Webhook — Twilio Gather + ElevenLabs Play with Claude Haiku.
 *
 * Optimized for low latency:
 *  - eleven_flash_v2_5 (~75ms) with mp3_22050_32 (small files)
 *  - claude-haiku-4-5 with 80 max_tokens, short system prompt
 *  - Pre-generated greeting audio on startup
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

// Pre-generated greeting audio URL
let preGeneratedGreetingUrl = null;

// Clean up stale history every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of callHistory) {
    if (now - entry.createdAt > 30 * 60 * 1000) callHistory.delete(sid);
  }
}, 10 * 60 * 1000);

// Clean up old audio files every 2 minutes (keep for 5 min)
setInterval(() => {
  try {
    const files = fs.readdirSync(AUDIO_DIR);
    const now = Date.now();
    for (const f of files) {
      if (f === 'greeting.mp3') continue;
      const fp = path.join(AUDIO_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > 5 * 60 * 1000) fs.unlinkSync(fp);
    }
  } catch (e) { /* ignore */ }
}, 2 * 60 * 1000);

// ── ElevenLabs TTS ──────────────────────────────────────────────────────────

async function generateSpeech(text, callSid) {
  const filename = callSid + '-' + Date.now() + '.mp3';
  const filepath = path.join(AUDIO_DIR, filename);

  const res = await fetch(
    'https://api.elevenlabs.io/v1/text-to-speech/' + VOICE_ID + '?output_format=mp3_22050_32',
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: TTS_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!res.ok) throw new Error('ElevenLabs error: ' + res.status);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filepath, buffer);
  return BASE_URL + '/voice-audio/' + filename;
}

// Pre-generate greeting on startup
(async () => {
  try {
    const filepath = path.join(AUDIO_DIR, 'greeting.mp3');
    const res = await fetch(
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
    if (!res.ok) throw new Error('ElevenLabs ' + res.status);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filepath, buffer);
    preGeneratedGreetingUrl = BASE_URL + '/voice-audio/greeting.mp3';
    console.log(`[VOICE] Pre-generated greeting (${buffer.length} bytes)`);
  } catch (err) {
    console.error('[VOICE] Greeting pre-gen failed:', err.message);
  }
})();

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeXml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function getSession(req) {
  const id = req.query.callId;
  return id && activeCallSessions.has(id) ? activeCallSessions.get(id) : null;
}

function xml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;
}

// ── GET and POST / — greeting ───────────────────────────────────────────────

async function handleIncoming(req, res) {
  try {
    const session = getSession(req);
    const callId = req.query.callId || '';
    const callSid = req.body?.CallSid || req.query?.CallSid || 'greeting-' + Date.now();

    const action = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';

    let audioUrl;
    if (session && session.initialMessage && session.initialMessage !== DEFAULT_GREETING) {
      console.log(`[VOICE] Outbound call: callId=${callId} to=${session.to}`);
      audioUrl = await generateSpeech(session.initialMessage, callSid);
    } else {
      console.log(`[VOICE] Incoming call: callSid=${callSid}`);
      audioUrl = preGeneratedGreetingUrl || await generateSpeech(DEFAULT_GREETING, callSid);
    }

    res.type('text/xml').send(xml([
      `  <Play>${escapeXml(audioUrl)}</Play>`,
      `  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST">`,
      `  </Gather>`,
      `  <Say voice="${FALLBACK_VOICE}">Goodbye!</Say>`,
    ].join('\n')));
  } catch (err) {
    console.error('[VOICE] Incoming error:', err.message);
    const action = (req.query.callId || '')
      ? `/webhook/voice/respond?callId=${encodeURIComponent(req.query.callId)}`
      : '/webhook/voice/respond';
    res.type('text/xml').send(xml([
      `  <Say voice="${FALLBACK_VOICE}">Hi, this is Kova. How can I help?</Say>`,
      `  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST">`,
      `  </Gather>`,
      `  <Say voice="${FALLBACK_VOICE}">Goodbye!</Say>`,
    ].join('\n')));
  }
}

router.get('/', handleIncoming);
router.post('/', handleIncoming);

// ── POST /respond — Claude + ElevenLabs ─────────────────────────────────────

router.post('/respond', async (req, res) => {
  const t0 = Date.now();
  try {
    const speech = req.body.SpeechResult || '';
    const callSid = req.body.CallSid || 'unknown';
    const callId = req.query.callId || '';
    const session = getSession(req);

    console.log(`[VOICE] [${callSid}] Caller: "${speech}"`);

    const action = callId
      ? `/webhook/voice/respond?callId=${encodeURIComponent(callId)}`
      : '/webhook/voice/respond';

    if (!speech) {
      try {
        const url = await generateSpeech("I didn't catch that. Could you say that again?", callSid);
        res.type('text/xml').send(xml([
          `  <Play>${escapeXml(url)}</Play>`,
          `  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST"></Gather>`,
          `  <Say voice="${FALLBACK_VOICE}">Goodbye.</Say>`,
        ].join('\n')));
      } catch (_) {
        res.type('text/xml').send(xml([
          `  <Say voice="${FALLBACK_VOICE}">I didn't catch that. Could you say that again?</Say>`,
          `  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST"></Gather>`,
          `  <Say voice="${FALLBACK_VOICE}">Goodbye.</Say>`,
        ].join('\n')));
      }
      return;
    }

    // System prompt
    let sys = SYSTEM_PROMPT;
    if (session) {
      const p = [SYSTEM_PROMPT];
      if (session.purpose) p.push(`Goal: ${session.purpose}`);
      if (session.customerName) p.push(`Calling for: ${session.customerName}`);
      p.push('Say [END_CALL] when done.');
      sys = p.join(' ');
    }

    // History
    const key = callId || callSid;
    if (!callHistory.has(key)) callHistory.set(key, { messages: [], createdAt: Date.now() });
    const hist = callHistory.get(key);
    hist.messages.push({ role: 'user', content: speech });
    if (hist.messages.length > MAX_HISTORY) hist.messages = hist.messages.slice(-MAX_HISTORY);

    // Claude
    const t1 = Date.now();
    let aiText = "Sorry, could you repeat that?";
    try {
      const r = await anthropic.messages.create({
        model: MODEL, max_tokens: MAX_TOKENS, system: sys, messages: hist.messages,
      });
      aiText = r.content[0]?.text || aiText;
    } catch (e) {
      console.error('[VOICE] Claude error:', e.message);
    }
    console.log(`[VOICE] [${callSid}] Claude: ${Date.now()-t1}ms`);

    const shouldEnd = aiText.includes('[END_CALL]');
    aiText = aiText.replace('[END_CALL]', '').trim();

    hist.messages.push({ role: 'assistant', content: aiText });
    if (hist.messages.length > MAX_HISTORY) hist.messages = hist.messages.slice(-MAX_HISTORY);

    console.log(`[VOICE] [${callSid}] Kova: "${aiText}"`);

    // ElevenLabs
    const t2 = Date.now();
    const audioUrl = await generateSpeech(aiText, callSid);
    console.log(`[VOICE] [${callSid}] TTS: ${Date.now()-t2}ms, total: ${Date.now()-t0}ms`);

    if (shouldEnd) {
      res.type('text/xml').send(xml([
        `  <Play>${escapeXml(audioUrl)}</Play>`,
        `  <Say voice="${FALLBACK_VOICE}">Goodbye!</Say>`,
      ].join('\n')));
    } else {
      res.type('text/xml').send(xml([
        `  <Play>${escapeXml(audioUrl)}</Play>`,
        `  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST"></Gather>`,
        `  <Say voice="${FALLBACK_VOICE}">Are you still there? Goodbye.</Say>`,
      ].join('\n')));
    }
  } catch (err) {
    console.error('[VOICE] Respond error:', err.message);
    const action = (req.query.callId || '')
      ? `/webhook/voice/respond?callId=${encodeURIComponent(req.query.callId)}`
      : '/webhook/voice/respond';
    res.type('text/xml').send(xml([
      `  <Say voice="${FALLBACK_VOICE}">Sorry, could you repeat that?</Say>`,
      `  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST"></Gather>`,
      `  <Say voice="${FALLBACK_VOICE}">Goodbye.</Say>`,
    ].join('\n')));
  }
});

// ── POST /status ────────────────────────────────────────────────────────────

router.post('/status', (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const callId = req.query.callId || '';
    console.log(`[VOICE] Status: ${callSid} → ${req.body.CallStatus}`);
    if (callSid) callHistory.delete(callSid);
    if (callId) { callHistory.delete(callId); activeCallSessions.delete(callId); }
  } catch (e) { console.error('[VOICE] Status error:', e.message); }
  res.sendStatus(200);
});

// ── GET and POST /fallback ──────────────────────────────────────────────────

function handleFallback(req, res) {
  console.error('[VOICE] Fallback triggered');
  res.type('text/xml').send(xml(
    `  <Say voice="${FALLBACK_VOICE}">Sorry, something went wrong. Please try calling back.</Say>`
  ));
}

router.get('/fallback', handleFallback);
router.post('/fallback', handleFallback);

module.exports = router;
