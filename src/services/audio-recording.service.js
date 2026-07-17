const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const logger = require('../core/logger').createServiceLogger('AUDIO_STORE');

const MIME_TYPES = new Set(['audio/webm', 'audio/webm;codecs=opus']);

class AudioRecordingService {
  get storagePath() {
    return path.join(app.getPath('userData'), 'audio-recordings');
  }

  ensureStoragePath() {
    fs.mkdirSync(this.storagePath, { recursive: true });
  }

  save(bytes, mimeType, durationMs) {
    const normalizedMimeType = String(mimeType || '').toLowerCase();
    if (!MIME_TYPES.has(normalizedMimeType)) {
      throw new Error('Unsupported recorded-audio format');
    }
    const buffer = Buffer.from(bytes);
    if (!buffer.length) throw new Error('Recorded audio is empty');
    if (buffer.length > 12 * 1024 * 1024) throw new Error('Recorded audio exceeds the 12 MB limit');

    this.ensureStoragePath();
    const recordingId = crypto.randomUUID();
    const fileName = `${recordingId}.webm`;
    const filePath = path.join(this.storagePath, fileName);
    fs.writeFileSync(filePath, buffer, { mode: 0o600 });
    logger.info('Audio recording saved', { recordingId, bytes: buffer.length, durationMs });
    return { recordingId, fileName, mimeType: 'audio/webm', durationMs: Number(durationMs) || 0 };
  }

  get(recordingId) {
    if (!/^[a-f0-9-]{36}$/i.test(String(recordingId || ''))) {
      throw new Error('Invalid recording identifier');
    }
    const filePath = path.join(this.storagePath, `${recordingId}.webm`);
    if (!fs.existsSync(filePath)) throw new Error('Recording is no longer available');
    return { recordingId, mimeType: 'audio/webm', bytes: fs.readFileSync(filePath) };
  }

  getPath(recordingId) {
    if (!/^[a-f0-9-]{36}$/i.test(String(recordingId || ''))) {
      throw new Error('Invalid recording identifier');
    }
    return path.join(this.storagePath, `${recordingId}.webm`);
  }

  clear() {
    try {
      fs.rmSync(this.storagePath, { recursive: true, force: true });
      logger.info('Persisted audio recordings cleared');
    } catch (error) {
      logger.warn('Failed to clear persisted audio recordings', { error: error.message });
      throw error;
    }
  }
}

module.exports = new AudioRecordingService();
