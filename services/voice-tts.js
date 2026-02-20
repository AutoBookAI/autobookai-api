/**
 * Voice TTS — multi-provider text-to-speech with fallback chain.
 *
 * Provider priority: Deepgram Aura → OpenAI TTS → ElevenLabs → Twilio <Say> fallback
 *
 * Generated audio is cached in-memory and served via /voice/audio/:id
 * Custom cloned voices always use ElevenLabs regardless of priority chain.
 */

const crypto = require('crypto');

// ── In-memory audio cache ──────────────────────────────────────────────────
const audioCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of audioCache) {
    if (now - entry.createdAt > CACHE_TTL) audioCache.delete(id);
  }
}, 5 * 60 * 1000);

// ── Voice mappings per provider ─────────────────────────────────────────────
const VOICES = {
  deepgram:   { female: 'aura-asteria-en', male: 'aura-orion-en' },
  openai:     { female: 'nova',            male: 'onyx' },
  elevenlabs: { female: '21m00Tcm4TlvDq8ikWAM', male: 'TxGEqnHWrfWFTfGW9XjX' },
};

// ── Provider detection ──────────────────────────────────────────────────────
function getProvider() {
  if (process.env.DEEPGRAM_API_KEY) return 'deepgram';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  return null;
}

function storeAudio(buffer, contentType = 'audio/mpeg') {
  const id = crypto.randomUUID();
  audioCache.set(id, { buffer, contentType, createdAt: Date.now() });
  return id;
}

function getAudio(audioId) {
  return audioCache.get(audioId) || null;
}

// ── Deepgram Aura TTS ──────────────────────────────────────────────────────
async function generateDeepgram(text, gender) {
  const model = VOICES.deepgram[gender] || VOICES.deepgram.female;
  const resp = await fetch(
    `https://api.deepgram.com/v1/speak?model=${model}&encoding=mp3`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(4000),
    }
  );
  if (!resp.ok) throw new Error(`Deepgram TTS: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return storeAudio(buffer);
}

// ── OpenAI TTS ──────────────────────────────────────────────────────────────
async function generateOpenAI(text, gender) {
  const voice = VOICES.openai[gender] || VOICES.openai.female;
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice,
      input: text,
      response_format: 'mp3',
      speed: 0.95,
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!resp.ok) throw new Error(`OpenAI TTS: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return storeAudio(buffer);
}

// ── ElevenLabs TTS ──────────────────────────────────────────────────────────
async function generateElevenLabs(text, voiceId) {
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(4000),
    }
  );
  if (!resp.ok) throw new Error(`ElevenLabs TTS: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return storeAudio(buffer);
}

// ── Main TTS function ───────────────────────────────────────────────────────
/**
 * Generate speech audio. Returns audioId if external TTS available, null for Twilio fallback.
 */
async function generateSpeech(text, gender = 'female', customVoiceId = null) {
  // Custom cloned voice always uses ElevenLabs
  if (customVoiceId && process.env.ELEVENLABS_API_KEY) {
    try {
      return await generateElevenLabs(text, customVoiceId);
    } catch (err) {
      console.error('Custom voice TTS failed:', err.message);
    }
  }

  const provider = getProvider();
  if (!provider) return null;

  // Try primary provider, then fall through chain
  const chain = [];
  if (process.env.DEEPGRAM_API_KEY) chain.push(() => generateDeepgram(text, gender));
  if (process.env.OPENAI_API_KEY) chain.push(() => generateOpenAI(text, gender));
  if (process.env.ELEVENLABS_API_KEY) chain.push(() => generateElevenLabs(text, VOICES.elevenlabs[gender]));

  for (const fn of chain) {
    try {
      return await fn();
    } catch (err) {
      console.error(`TTS provider failed, trying next:`, err.message);
    }
  }
  return null;
}

// ── Filler audio pre-generation ─────────────────────────────────────────────
const FILLERS = ['Mm-hmm', 'Got it', 'Sure', 'Yeah', 'Okay', 'Right'];
const fillerCache = { female: {}, male: {} };

async function initFillers() {
  const provider = getProvider();
  if (!provider) {
    console.log('No external TTS — using Twilio <Say> for fillers');
    return;
  }
  console.log(`Pre-generating filler audio via ${provider}...`);
  for (const gender of ['female', 'male']) {
    for (const filler of FILLERS) {
      try {
        const audioId = await generateSpeech(filler, gender);
        if (audioId) fillerCache[gender][filler] = audioId;
      } catch {}
    }
  }
  const count = Object.keys(fillerCache.female).length + Object.keys(fillerCache.male).length;
  console.log(`Pre-generated ${count} filler audio clips`);
}

function getRandomFiller(gender = 'female') {
  const cache = fillerCache[gender] || {};
  const keys = Object.keys(cache);
  if (!keys.length) return null;
  const key = keys[Math.floor(Math.random() * keys.length)];
  return { text: key, audioId: cache[key] };
}

function getRandomFillerText() {
  return FILLERS[Math.floor(Math.random() * FILLERS.length)];
}

module.exports = {
  generateSpeech,
  getAudio,
  getProvider,
  initFillers,
  getRandomFiller,
  getRandomFillerText,
  FILLERS,
};
