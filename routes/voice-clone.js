/**
 * Voice Cloning — ElevenLabs voice cloning for custom call voices.
 *
 * Mounted at /api/customer/voice (behind customerAuth middleware).
 *
 * Flow:
 *   1. Customer records voice sample in browser (MediaRecorder → WebM/WAV)
 *   2. POST /api/customer/voice/clone uploads to ElevenLabs Instant Voice Cloning
 *   3. ElevenLabs returns a voice_id, stored in customer_profiles.voice_clone_id
 *   4. Future calls use this voice_id via ElevenLabs TTS
 */

const router = require('express').Router();
const { pool } = require('../db');

// ── GET /api/customer/voice/status — check if customer has a cloned voice ───
router.get('/status', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT voice_clone_id FROM customer_profiles WHERE customer_id=$1',
      [req.customerId]
    );
    const voiceId = result.rows[0]?.voice_clone_id || null;
    res.json({ hasVoice: !!voiceId, voiceId });
  } catch {
    res.status(500).json({ error: 'Failed to check voice status' });
  }
});

// ── POST /api/customer/voice/clone — upload voice sample to ElevenLabs ──────
router.post('/clone', async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Voice cloning not available — ElevenLabs not configured' });
  }

  try {
    // Expect raw audio in request body (audio/webm, audio/wav, etc.)
    const contentType = req.headers['content-type'] || 'audio/webm';

    // Read raw body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length < 1000) {
      return res.status(400).json({ error: 'Audio sample too short. Please record at least 10 seconds.' });
    }

    if (audioBuffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Audio sample too large. Maximum 10MB.' });
    }

    // Get customer name for the voice label
    const custResult = await pool.query('SELECT name FROM customers WHERE id=$1', [req.customerId]);
    const customerName = custResult.rows[0]?.name || 'Customer';

    // Check if customer already has a cloned voice — delete old one first
    const existing = await pool.query(
      'SELECT voice_clone_id FROM customer_profiles WHERE customer_id=$1',
      [req.customerId]
    );
    if (existing.rows[0]?.voice_clone_id) {
      // Delete old voice from ElevenLabs (best effort)
      await fetch(`https://api.elevenlabs.io/v1/voices/${existing.rows[0].voice_clone_id}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': apiKey },
      }).catch(() => {});
    }

    // Upload to ElevenLabs Instant Voice Cloning (uses Node 18+ native FormData)
    const form = new FormData();
    form.append('name', `Kova-${customerName.replace(/[^a-zA-Z0-9]/g, '-')}`);
    form.append('description', `Custom voice clone for ${customerName}`);
    const ext = contentType.includes('wav') ? 'wav' : contentType.includes('mp4') ? 'mp4' : 'webm';
    form.append('files', new Blob([audioBuffer], { type: contentType }), `voice-sample.${ext}`);

    const resp = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('ElevenLabs clone error:', resp.status, errText);
      return res.status(502).json({ error: 'Voice cloning failed. Please try again with a clearer recording.' });
    }

    const data = await resp.json();
    const voiceId = data.voice_id;

    if (!voiceId) {
      return res.status(502).json({ error: 'Voice cloning failed — no voice ID returned' });
    }

    // Store voice_clone_id in customer_profiles
    await pool.query(
      'UPDATE customer_profiles SET voice_clone_id=$1, updated_at=NOW() WHERE customer_id=$2',
      [voiceId, req.customerId]
    );

    console.log(`Voice cloned for customer ${req.customerId}: ${voiceId}`);
    res.json({ success: true, voiceId });

  } catch (err) {
    console.error('Voice clone error:', err.message);
    res.status(500).json({ error: 'Voice cloning failed' });
  }
});

// ── DELETE /api/customer/voice/clone — remove cloned voice ──────────────────
router.delete('/clone', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT voice_clone_id FROM customer_profiles WHERE customer_id=$1',
      [req.customerId]
    );
    const voiceId = result.rows[0]?.voice_clone_id;

    if (voiceId && process.env.ELEVENLABS_API_KEY) {
      // Delete from ElevenLabs (best effort)
      await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      }).catch(() => {});
    }

    await pool.query(
      'UPDATE customer_profiles SET voice_clone_id=NULL, voice_sample_url=NULL, updated_at=NOW() WHERE customer_id=$1',
      [req.customerId]
    );

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete voice' });
  }
});

module.exports = router;
