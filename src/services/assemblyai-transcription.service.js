const fs = require('fs');
const logger = require('../core/logger').createServiceLogger('ASSEMBLYAI');
const config = require('../core/config');

const BASE_URL = 'https://api.assemblyai.com';
const POLL_INTERVAL_MS = config.get('speech.assemblyai.pollIntervalMs') || 3000;
const TIMEOUT_MS = config.get('speech.assemblyai.timeoutMs') || 60000;

/**
 * Upload an audio file to AssemblyAI and return the upload URL.
 */
async function uploadAudio(filePath, apiKey) {
  const stats = fs.statSync(filePath);
  logger.info('Uploading audio to AssemblyAI', { filePath, bytes: stats.size });

  // Stream the file instead of buffering it entirely in memory (much faster for large files)
  const fileStream = fs.createReadStream(filePath);
  const response = await fetch(`${BASE_URL}/v2/upload`, {
    method: 'POST',
    headers: {
      'authorization': apiKey,
      'content-type': 'application/octet-stream',
      'transfer-encoding': 'chunked',
    },
    body: fileStream,
    duplex: 'half',
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(`AssemblyAI upload failed: ${result.error || response.statusText}`);
  }
  logger.info('AssemblyAI upload complete', { uploadUrl: result.upload_url });
  return result.upload_url;
}

/**
 * Submit a transcription job and poll until complete.
 */
async function transcribe(filePath) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey || apiKey === 'your_assemblyai_api_key_here') {
    throw new Error('AssemblyAI API key is not configured. Add it in Settings.');
  }

  const model = config.get('speech.assemblyai.model') || 'best';
  const languageCode = config.get('speech.assemblyai.languageCode') || 'en';
  const startTime = Date.now();

  // Step 1: Upload audio
  const audioUrl = await uploadAudio(filePath, apiKey);

  // Step 2: Submit transcription job
  logger.info('Submitting AssemblyAI transcription', { model, audioUrl });
  const submitResp = await fetch(`${BASE_URL}/v2/transcript`, {
    method: 'POST',
    headers: {
      'authorization': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_models: [model],
      language_code: languageCode,
    }),
  });

  const submitResult = await submitResp.json();
  if (!submitResp.ok) {
    throw new Error(`AssemblyAI transcription submission failed: ${submitResult.error || submitResp.statusText}`);
  }

  const transcriptId = submitResult.id;
  logger.info('AssemblyAI transcription submitted', { transcriptId });

  // Step 3: Poll until complete or timeout
  while (Date.now() - startTime < TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const pollResp = await fetch(`${BASE_URL}/v2/transcript/${transcriptId}`, {
      method: 'GET',
      headers: { 'authorization': apiKey },
    });

    const pollResult = await pollResp.json();
    if (!pollResp.ok) {
      throw new Error(`AssemblyAI polling failed: ${pollResult.error || pollResp.statusText}`);
    }

    if (pollResult.status === 'completed') {
      const text = (pollResult.text || '').trim();
      if (!text) {
        throw new Error('No speech was detected in this recording');
      }
      logger.info('AssemblyAI transcription completed', {
        transcriptId,
        textLength: text.length,
        durationMs: Date.now() - startTime,
      });
      return {
        text,
        segments: pollResult.utterances || pollResult.words || [],
      };
    }

    if (pollResult.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${pollResult.error}`);
    }

    logger.debug('AssemblyAI transcription pending', { transcriptId, status: pollResult.status });
  }

  throw new Error('AssemblyAI transcription timed out after ' + (TIMEOUT_MS / 1000) + ' seconds');
}

module.exports = { transcribe };
