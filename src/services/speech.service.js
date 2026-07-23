const fs = require('fs');
const { EventEmitter } = require('events');
const { Groq } = require('groq-sdk');
const config = require('../core/config');
const logger = require('../core/logger').createServiceLogger('SPEECH');
const assemblyaiTranscriber = require('./assemblyai-transcription.service');

class SpeechService extends EventEmitter {
  constructor() {
    super();
    this.isRecording = false;
    this.available = false;
    this.client = null;
    this.initializeClient();
  }

  initializeClient() {
    const sel = config.getModelSelection('voice');
    this.provider = sel.provider;
    this.model = sel.model;

    if (this.provider === 'assemblyai') {
      const apiKey = config.getApiKey('ASSEMBLYAI');
      this.available = Boolean(apiKey && apiKey !== 'your_assemblyai_api_key_here');
      this.client = null; // No SDK client needed for AssemblyAI (uses fetch)
      this.emit('status', this.available
        ? 'AssemblyAI voice transcription ready'
        : 'Add an AssemblyAI API key to enable voice transcription');
      return;
    }

    if (this.provider === 'elevenlabs') {
      const apiKey = config.getApiKey('ELEVENLABS');
      this.available = Boolean(apiKey && apiKey !== 'your_elevenlabs_api_key_here' && apiKey.startsWith('sk_'));
      this.client = null; // No SDK needed — uses native https
      this.emit('status', this.available
        ? 'ElevenLabs voice transcription ready'
        : 'Add an ElevenLabs API key to enable voice transcription');
      return;
    }

    // Default: Groq
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
      const providerName = this.provider === 'assemblyai' ? 'AssemblyAI' : this.provider === 'elevenlabs' ? 'ElevenLabs' : 'Groq';
      const error = `${providerName} voice transcription is unavailable. Add a ${providerName} API key in Settings.`;
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
    if (!this.available) {
      const providerName = this.provider === 'assemblyai' ? 'AssemblyAI' : this.provider === 'elevenlabs' ? 'ElevenLabs' : 'Groq';
      throw new Error(`${providerName} voice transcription is unavailable. Add a ${providerName} API key in Settings.`);
    }
    if (!fs.existsSync(filePath)) {
      throw new Error('Recorded audio file was not found');
    }

    // Route to the correct provider
    if (this.provider === 'assemblyai') {
      logger.info('Transcribing with AssemblyAI', { fileName });
      return await assemblyaiTranscriber.transcribe(filePath);
    }

    if (this.provider === 'elevenlabs') {
      logger.info('Transcribing with ElevenLabs', { fileName });
      return await this._transcribeWithElevenLabs(filePath);
    }

    // Default: Groq / Whisper
    logger.info('Submitting completed recording to Groq', { fileName });
    const transcription = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3-turbo',
      temperature: 0,
      language: 'en',
      response_format: 'verbose_json',
    });
    const text = String(transcription && transcription.text || '').trim();
    if (!text) {
      throw new Error('No speech was detected in this recording');
    }
    return { text, segments: transcription.segments || [] };
  }

  async _transcribeWithElevenLabs(filePath) {
    const https = require('https');
    const apiKey = config.getApiKey('ELEVENLABS');
    const timeoutMs = config.get('llm.elevenlabs')?.timeoutMs || 120000;

    const fileBuffer = fs.readFileSync(filePath);
    const boundary = `----ElevenLabsBoundary${Date.now()}`;

    // Build multipart/form-data body manually
    const parts = [];
    const crlf = Buffer.from('\r\n', 'utf8');
    const addPart = (name, value, filename) => {
      let header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
      if (filename) {
        header += `; filename="${filename}"\r\nContent-Type: application/octet-stream`;
      }
      header += '\r\n\r\n';
      parts.push(Buffer.from(header, 'utf8'));
      parts.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
      parts.push(crlf);
    };

    addPart('model_id', 'scribe_v2');
    addPart('language_code', 'eng');
    addPart('file', fileBuffer, 'recording.webm');
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

    const body = Buffer.concat(parts);

    const options = {
      method: 'POST',
      hostname: 'api.elevenlabs.io',
      path: '/v1/speech-to-text',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`ElevenLabs HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const json = JSON.parse(data);
            const text = String(json.text || '').trim();
            if (!text) {
              throw new Error('No speech was detected in this recording');
            }
            resolve({ text, segments: [] });
          } catch (err) {
            reject(err instanceof SyntaxError
              ? new Error(`ElevenLabs response parse error: ${err.message}`)
              : err);
          }
        });
        res.on('error', (err) => reject(new Error(`ElevenLabs response error: ${err.message}`)));
      });

      req.on('error', (err) => reject(new Error(`ElevenLabs request failed: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('ElevenLabs request timed out'));
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = new SpeechService();
