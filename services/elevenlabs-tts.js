/**
 * ElevenLabs Text-to-Speech integration.
 *
 * Generates ultra-realistic speech audio using ElevenLabs API.
 * Audio is cached in-memory and served via /voice/audio/:id endpoint.
 *
 * Requires: ELEVENLABS_API_KEY
 * Optional: ELEVENLABS_FEMALE_VOICE_ID, ELEVENLABS_MALE_VOICE_ID
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

// Default ElevenLabs voice IDs (natural-sounding conversational voices)
const DEFAULT_FEMALE_VOICE = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const DEFAULT_MALE_VOICE = 'TxGEqnHWrfWFTfGW9XjX';   // Josh

/**
 * Generate speech audio via ElevenLabs API.
 *
 * @param {string} text - Text to speak
 * @param {'male'|'female'} gender - Voice gender
 * @returns {string|null} Audio ID for retrieval, or null if ElevenLabs unavailable
 */
async function generateSpeech(text, gender = 'female') {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const voiceId = gender === 'male'
    ? (process.env.ELEVENLABS_MALE_VOICE_ID || DEFAULT_MALE_VOICE)
    : (process.env.ELEVENLABS_FEMALE_VOICE_ID || DEFAULT_FEMALE_VOICE);

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
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
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
        },
      }),
    });

    if (!response.ok) {
      console.error(`ElevenLabs TTS failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const audioId = crypto.randomUUID();
    audioCache.set(audioId, { buffer: audioBuffer, createdAt: Date.now() });

    console.log(`🔊 ElevenLabs audio generated: ${audioId} (${audioBuffer.length} bytes, ${gender})`);
    return audioId;
  } catch (err) {
    console.error('ElevenLabs TTS error:', err.message);
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
 * Check if ElevenLabs is configured.
 */
function isConfigured() {
  return !!process.env.ELEVENLABS_API_KEY;
}

module.exports = { generateSpeech, getAudio, isConfigured };
