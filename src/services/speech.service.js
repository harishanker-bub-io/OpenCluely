const fs = require('fs');
const { EventEmitter } = require('events');
const { Groq } = require('groq-sdk');
const config = require('../core/config');
const logger = require('../core/logger').createServiceLogger('SPEECH');

class SpeechService extends EventEmitter {
  constructor() {
    super();
    this.provider = 'groq';
    this.isRecording = false;
    this.available = false;
    this.client = null;
    this.initializeClient();
  }

  initializeClient() {
    const apiKey = config.getApiKey('GROQ');
    this.available = Boolean(apiKey && apiKey !== 'your_groq_api_key_here');
    this.client = this.available ? new Groq({ apiKey }) : null;
    this.emit('status', this.available
      ? 'Groq voice transcription ready'
      : 'Add a Groq API key to enable voice transcription');
  }

  isAvailable() {
    return this.available;
  }

  getStatus() {
    return {
      isInitialized: this.available,
      isRecording: this.isRecording,
      provider: this.provider,
    };
  }

  startRecording() {
    if (!this.available) {
      const error = 'Groq voice transcription is unavailable. Add a Groq API key in Settings.';
      this.emit('error', error);
      return this.getStatus();
    }
    if (this.isRecording) return this.getStatus();
    this.isRecording = true;
    this.emit('recording-started');
    this.emit('status', 'Recording audio');
    return this.getStatus();
  }

  stopRecording() {
    if (!this.isRecording) return this.getStatus();
    this.isRecording = false;
    this.emit('recording-stopped');
    this.emit('status', 'Processing audio');
    return this.getStatus();
  }

  async transcribeFile(filePath, fileName = 'recording.webm') {
    if (!this.available || !this.client) {
      throw new Error('Groq voice transcription is unavailable. Add a Groq API key in Settings.');
    }
    if (!fs.existsSync(filePath)) {
      throw new Error('Recorded audio file was not found');
    }

    logger.info('Submitting completed recording to Groq', { fileName });
    const transcription = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3-turbo',
      temperature: 0,
      response_format: 'verbose_json',
    });
    const text = String(transcription && transcription.text || '').trim();
    if (!text) {
      throw new Error('No speech was detected in this recording');
    }
    return { text, segments: transcription.segments || [] };
  }
}

module.exports = new SpeechService();
