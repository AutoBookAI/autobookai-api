/**
 * Voice TTS — OpenAI text-to-speech for ultra-realistic phone voices.
 *
 * Uses OpenAI's tts-1-hd model which produces near-human speech.
 * Audio is cached in-memory and served via /voice/audio/:id endpoint.
 *
 * Requires: OPENAI_API_KEY
 *
 * Voice mapping:
 *   Female → "nova" (warm, natural conversational voice)
 *   Male   → "echo" (clear, natural male voice)
 */

const crypto = require('crypto');

// In-memory audio cache — keyed by UUID, auto-cleaned every minute
const audioCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of audioCache) {
    if (now - entry.createdAt > 5 * 60 * 1000) {
      audioCache.delete(id);
    }
  }
}, 60 * 1000);

// OpenAI TTS voices — these sound almost indistinguishable from real humans
const VOICES = {
  female: 'nova',   // Warm, friendly, natural female
  male: 'echo',     // Clear, natural male
};

/**
 * Generate speech audio via OpenAI TTS API.
 *
 * @param {string} text - Text to speak
 * @param {'male'|'female'} gender - Voice gender
 * @returns {string|null} Audio ID for retrieval, or null if unavailable
 */
async function generateSpeech(text, gender = 'female') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const voice = VOICES[gender] || VOICES.female;

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
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

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`OpenAI TTS failed: ${response.status} ${response.statusText} — ${errText}`);
      return null;
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const audioId = crypto.randomUUID();
    audioCache.set(audioId, { buffer: audioBuffer, createdAt: Date.now() });

    console.log(`🔊 OpenAI TTS audio generated: ${audioId} (${audioBuffer.length} bytes, voice=${voice})`);
    return audioId;
  } catch (err) {
    console.error('OpenAI TTS error:', err.message);
    return null;
  }
}

/**
 * Retrieve cached audio buffer by ID.
 */
function getAudio(audioId) {
  const entry = audioCache.get(audioId);
  if (!entry) return null;
  return entry.buffer;
}

/**
 * Check if OpenAI TTS is configured.
 */
function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

module.exports = { generateSpeech, getAudio, isConfigured };
