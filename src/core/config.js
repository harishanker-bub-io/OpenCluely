const path = require('path');
const os = require('os');
const fs = require('fs');

class ConfigManager {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.appDataDir = path.join(os.homedir(), '.OpenCluely');
    this.loadConfiguration();
  }

  loadConfiguration() {
    const compiledPreload = path.join(__dirname, '../preload/preload.js');
    const sourcePreload = path.join(__dirname, '../../preload.js');
    const preloadPath = fs.existsSync(compiledPreload) ? compiledPreload : sourcePreload;

    // ── Provider registry ──────────────────────────────────────────
    // Each provider declares its capabilities (text / image / voice) and
    // the models available per category.  Adding a new provider is just a
    // matter of adding an entry here + the corresponding SDK wiring in
    // llm.service.js / speech.service.js — the Settings UI builds itself
    // from this registry automatically.
    this.providers = {
      gemini: {
        name: 'Google Gemini',
        apiKeyEnv: 'GEMINI_API_KEY',
        capabilities: { text: true, image: true, voice: false },
        models: {
          text:  ['gemini-3.1-flash-lite', 'gemma-4-31b-it', 'gemini-3.5-flash-lite'],
          image: ['gemini-3.1-flash-lite', 'gemma-4-31b-it', 'gemini-3.5-flash-lite'],
        },
        generation: {
          temperature: 0.7, topK: 32, topP: 0.9,
          maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 }
        },
        fallbackModels: ['gemini-2.5-flash-lite', 'gemini-3.5-flash'],
        maxRetries: 3, timeout: 30000,
        fallbackEnabled: true, enableFallbackMethod: true,
      },
      groq: {
        name: 'Groq',
        apiKeyEnv: 'GROQ_API_KEY',
        capabilities: { text: true, image: true, voice: true },
        models: {
          text:  ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'meta-llama/llama-4-maverick-17b-128e-instruct'],
          image: ['qwen/qwen3.6-27b'],
          voice: ['whisper-large-v3-turbo'],
        },
        generation: { temperature: 0.6, topP: 0.95, maxTokens: 4096 },
        maxRetries: 3, timeout: 30000,
      },
      cerebras: {
        name: 'Cerebras',
        apiKeyEnv: 'CEREBRAS_API_KEY',
        capabilities: { text: true, image: true, voice: false },
        models: {
          text: ['zai-glm-4.7', 'gemma-4-31b'],
          image: ['gemma-4-31b'],
        },
        generation: { temperature: 0.6, topP: 0.95, maxTokens: 65000 },
        maxRetries: 3, timeout: 120000,
      },
      assemblyai: {
        name: 'AssemblyAI',
        apiKeyEnv: 'ASSEMBLYAI_API_KEY',
        capabilities: { text: false, image: false, voice: true },
        models: { voice: ['universal-3-5-pro'] },
        pollIntervalMs: 1000, timeoutMs: 120000,
      },
      elevenlabs: {
        name: 'ElevenLabs',
        apiKeyEnv: 'ELEVENLABS_API_KEY',
        capabilities: { text: false, image: false, voice: true },
        models: { voice: ['scribe_v2'] },
        timeoutMs: 120000,
      },
    };

    // ── Active model selection defaults ───────────────────────────
    this._defaultSelection = {
      text:  { provider: 'gemini',   model: 'gemini-3.5-flash-lite' },
      image: { provider: 'gemini',   model: 'gemini-3.5-flash-lite' },
      voice: { provider: 'groq',     model: 'whisper-large-v3-turbo' },
    };

    this.config = {
      app: {
        name: 'OpenCluely', version: '1.0.0', processTitle: 'OpenCluely',
        dataDir: this.appDataDir,
        isDevelopment: this.env === 'development',
        isProduction: this.env === 'production'
      },
      window: {
        defaultWidth: 400, defaultHeight: 600, minWidth: 300, minHeight: 400,
        webPreferences: {
          nodeIntegration: false, contextIsolation: true,
          enableRemoteModule: false,
          preload: preloadPath
        }
      },
      ocr: { language: 'eng', tempDir: os.tmpdir(), cleanupDelay: 5000 },

      // ── Legacy flat keys kept for backward compat ─────────────────
      llm: {
        provider: 'gemini',
        gemini: {
          model: 'gemini-3.1-flash-lite',
          fallbackModels: ['gemini-2.5-flash-lite', 'gemini-3.5-flash'],
          maxRetries: 3, timeout: 30000, fallbackEnabled: true,
          enableFallbackMethod: true,
          generation: {
            temperature: 0.7, topK: 32, topP: 0.9,
            maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 }
          }
        },
        groq: {
          model: 'qwen/qwen3.6-27b', visionModel: 'qwen/qwen3.6-27b',
          maxRetries: 3, timeout: 30000,
          generation: { temperature: 0.6, topP: 0.95, maxTokens: 4096 }
        },
        cerebras: {
          model: 'zai-glm-4.7', maxRetries: 3, timeout: 120000,
          generation: { temperature: 0.6, topP: 0.95, maxTokens: 65000 }
        }
      },

      speech: {
        provider: 'groq',
        assemblyai: {
          model: 'universal-3-5-pro', languageCode: 'en',
          pollIntervalMs: 1000, timeoutMs: 120000
        },
        groq: { model: 'whisper-large-v3-turbo' },
        azure: {
          language: 'en-US', enableDictation: true,
          enableAudioLogging: false, outputFormat: 'detailed'
        },
        whisper: {
          model: 'turbo', language: 'en', segmentMs: 4000,
          vadEnabled: true, silenceHangoverMs: 700, minUtteranceMs: 350,
          maxUtteranceMs: 15000, preRollMs: 300, vadEnergyFloor: 0.008
        }
      },

      session: { maxMemorySize: 1000, compressionThreshold: 500, clearOnRestart: false },
      stealth: { hideFromDock: true, noAttachConsole: true, disguiseProcess: true }
    };
  }

  // ── Generic helpers ──────────────────────────────────────────────
  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }
  set(keyPath, value) {
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => obj[key] = obj[key] || {}, this.config);
    target[lastKey] = value;
  }
  getApiKey(service) {
    return process.env[`${service.toUpperCase()}_API_KEY`];
  }
  isFeatureEnabled(feature) {
    return this.get(`features.${feature}`) !== false;
  }

  // ── Provider registry helpers ────────────────────────────────────
  getProviderConfig(name) { return this.providers[name] || null; }

  getProvidersForCategory(category) {
    return Object.entries(this.providers)
      .filter(([, p]) => p.capabilities && p.capabilities[category])
      .map(([key, p]) => ({ key, name: p.name }));
  }

  getModelsForProvider(provider, category) {
    const p = this.providers[provider];
    return (p && p.models && p.models[category]) ? p.models[category] : [];
  }

  // ── Active model selection ───────────────────────────────────────
  /**
   * Resolve {provider, model} for a category.
   * Order: TEXT_PROVIDER/TEXT_MODEL → LLM_PROVIDER (legacy) → default.
   * Voice uses SPEECH_PROVIDER as its legacy fallback.
   */
  getModelSelection(category) {
    const cat = String(category).toUpperCase();
    const legacy = process.env.LLM_PROVIDER || this._defaultSelection.text.provider;
    const legacyVoice = process.env.SPEECH_PROVIDER || this._defaultSelection.voice.provider;
    let provider = process.env[`${cat}_PROVIDER`]
      || (category === 'voice' ? legacyVoice : legacy);
    const def = this._defaultSelection[category] || this._defaultSelection.text;

    // If the resolved provider doesn't actually support this category
    // (e.g. LLM_PROVIDER=cerebras but cerebras has no image capability),
    // fall back to the hard default for that category.
    const p = this.providers[provider];
    if (!p || !p.capabilities || !p.capabilities[category]) {
      provider = def.provider;
    }

    const models = this.getModelsForProvider(provider, category);
    return {
      provider,
      model: process.env[`${cat}_MODEL`] || models[0] || def.model,
    };
  }

  getProviderFor(category)  { return this.getModelSelection(category).provider; }
  getModelFor(category)     { return this.getModelSelection(category).model; }

  getActiveGenerationConfig(category) {
    const sel = this.getModelSelection(category);
    const p = this.providers[sel.provider];
    return (p && p.generation) ? { ...p.generation } : {};
  }

  getAllModelSelections() {
    return {
      text:  this.getModelSelection('text'),
      image: this.getModelSelection('image'),
      voice: this.getModelSelection('voice'),
    };
  }

  /** @deprecated — use getProviderFor('text') */
  getLLMProvider() { return this.getProviderFor('text'); }
}

module.exports = new ConfigManager();