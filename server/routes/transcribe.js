'use strict';

/**
 * Transcribe route — speech-to-text via OpenAI Whisper API.
 *
 * POST /api/transcribe
 *   Accepts multipart/form-data with an `audio` field (webm/mp4/wav).
 *   Returns { success, text, duration_ms }.
 */

const { Router } = require('express');
const multer = require('multer');
const logger = require('../utils/logger');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const API_KEY = process.env.MERMATE_AI_API_KEY || '';
const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({ success: false, error: 'no_api_key', details: 'MERMATE_AI_API_KEY is not configured. Speech-to-text requires an API key.' });
  }

  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ success: false, error: 'no_audio', details: 'No audio file received.' });
  }

  const startMs = Date.now();

  try {
    const ext = _guessExtension(req.file.mimetype);
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });

    const form = new FormData();
    form.append('file', blob, `recording.${ext}`);
    form.append('model', 'whisper-1');
    form.append('response_format', 'json');
    form.append('language', 'en');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    const whisperRes = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!whisperRes.ok) {
      const errBody = await whisperRes.text().catch(() => '');
      logger.warn('transcribe.whisper_error', { status: whisperRes.status, body: errBody.slice(0, 200) });
      return res.status(whisperRes.status).json({
        success: false,
        error: 'transcription_failed',
        details: `Whisper API returned ${whisperRes.status}`,
      });
    }

    const data = await whisperRes.json();
    const text = (data.text || '').trim();
    const durationMs = Date.now() - startMs;

    if (!text) {
      return res.json({ success: true, text: '', duration_ms: durationMs, warning: 'No speech detected in recording.' });
    }

    logger.info('transcribe.success', { chars: text.length, duration_ms: durationMs });
    return res.json({ success: true, text, duration_ms: durationMs });

  } catch (err) {
    logger.error('transcribe.error', { error: err.message });
    if (err.name === 'AbortError') {
      return res.status(504).json({ success: false, error: 'timeout', details: 'Transcription timed out.' });
    }
    return res.status(500).json({ success: false, error: 'internal_error', details: 'An internal error occurred during transcription' });
  }
});

function _guessExtension(mime) {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

module.exports = router;
