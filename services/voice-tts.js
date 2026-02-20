/**
 * Voice TTS — ElevenLabs primary, OpenAI fallback.
 *
 * Priority:
 *   1. ElevenLabs (ELEVENLABS_API_KEY) — most human-sounding
 *   2. OpenAI tts-1-hd (OPENAI_API_KEY) — excellent fallback
 *   3. null → Twilio <Say> used by voice-webhook
 *
 * ElevenLabs voices: Rachel (female), Josh (male)
 * OpenAI voices: nova (female), echo (male)
 */

const crypto = require('crypto');

// In-memory audio cache — auto-cleaned every minute
const audioCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of audioCache) {
    if (now - entry.createdAt > 5 * 60 * 1000) audioCache.delete(id);
  }
}, 60 * 1000);

// ElevenLabs voice IDs
const ELEVEN_VOICES = {
  female: '21m00Tcm4TlvDq8ikWAM', // Rachel
  male: 'TxGEqnHWrfWFTfGW9XjX',   // Josh
};

// OpenAI voice names
const OPENAI_VOICES = {
  female: 'nova',
  male: 'echo',
};

function storeAudio(buffer) {
  const id = crypto.randomUUID();
  audioCache.set(id, { buffer, createdAt: Date.now() });
  return id;
}

// ── ElevenLabs TTS ──────────────────────────────────────────────────────────

async function elevenLabsTTS(text, gender) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const voiceId = ELEVEN_VOICES[gender] || ELEVEN_VOICES.female;

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8,
          style: 0.35,
          use_speaker_boost: true,
        },
      }),
    });

    if (!res.ok) {
      console.error(`ElevenLabs TTS failed: ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const audioId = storeAudio(buffer);
    console.log(`🔊 ElevenLabs TTS: ${audioId} (${buffer.length}B, ${gender})`);
    return audioId;
  } catch (err) {
    console.error('ElevenLabs error:', err.message);
    return null;
  }
}

// ── OpenAI TTS ──────────────────────────────────────────────────────────────

async function openaiTTS(text, gender) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const voice = OPENAI_VOICES[gender] || OPENAI_VOICES.female;

  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1-hd',
        voice,
        input: text,
        response_format: 'mp3',
        speed: 1.0,
      }),
    });

    if (!res.ok) {
      console.error(`OpenAI TTS failed: ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const audioId = storeAudio(buffer);
    console.log(`🔊 OpenAI TTS: ${audioId} (${buffer.length}B, voice=${voice})`);
    return audioId;
  } catch (err) {
    console.error('OpenAI TTS error:', err.message);
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

async function generateSpeech(text, gender = 'female') {
  // Try ElevenLabs first, then OpenAI
  return (await elevenLabsTTS(text, gender)) || (await openaiTTS(text, gender));
}

function getAudio(audioId) {
  const entry = audioCache.get(audioId);
  return entry ? entry.buffer : null;
}

function isConfigured() {
  return !!(process.env.ELEVENLABS_API_KEY || process.env.OPENAI_API_KEY);
}

module.exports = { generateSpeech, getAudio, isConfigured };
