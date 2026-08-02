const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, globalShortcut, session, ipcMain } = require("electron");

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), so the canonical config
// lives in Electron's userData directory. We still prefer an existing
// project-local .env in development (npm start) so the dev workflow is
// unchanged. Both onboarding (FirstRunManager) and persistEnvUpdates() write
// to this same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    const projectEnv = path.join(process.cwd(), ".env");
    // Prefer a project .env only when it already exists and userData has none
    // (i.e. a developer running from the repo). Otherwise use userData.
    if (!fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
      return projectEnv;
    }
    return userDataEnv;
  } catch (_) {
    return path.join(process.cwd(), ".env");
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token — essential
// for Whisper commands like:  "C:\Users\Jane Doe\...\python.exe" -m whisper
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). OpenCluely's UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");
// Allow the renderer's AudioContext to start without a user gesture. Speech
// is triggered by global shortcuts, so the renderer never sees the gesture
// that Chromium's autoplay policy requires for Web Audio capture.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Set a stable Windows AppUserModelId so the app appears under its own
// name in Windows microphone privacy settings. Must be called before any
// windows are created. The stealth name is cosmetic (window title + taskbar);
// the AppUserModelId stays fixed so Windows can track permissions across runs.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.opencluely.app');
}

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");

// ── Global crash guard ──
// The speech path spawns external processes (Whisper CLI, and on macOS/Linux
// the sox/rec/arecord recorders via node-record-lpcm16). A missing recorder
// binary makes that library emit an 'error' on its child process with no
// listener, which would otherwise become an uncaughtException and quit the
// entire app the moment the user clicks the mic. We log and stay alive — the
// speech service surfaces a friendly status to the UI instead.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const audioRecordingService = require("./src/services/audio-recording.service");
const llmService = require("./src/services/llm.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    this.activeSkill = "dsa";
  // Default to C++ so language is enforced from first run
  this.codingLanguage = "cpp";
    this.resume = "";
    this.speechAvailable = false;
    this.microphoneDeviceId = "default";
    this.windowOpacity = 1.0;

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of several slow, half-answered ones.
    this._utteranceBuffer = "";
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;
    this._activeLlmRequests = new Map();

    // First-run onboarding: detects missing .env / API key and triggers
    // a settings-window prompt on first launch so users don't have to
    // dig through docs to figure out they need a Gemini API key.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), ".opencluely-firstrun-completed"),
    });
    this.isFirstRun = false;

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "OpenCluely" },
      chat: { title: "Chat" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    
    // Load persisted user settings from disk (survives restarts)
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (data.resume !== undefined) this.resume = data.resume;
        if (data.codingLanguage) this.codingLanguage = data.codingLanguage;
        if (data.activeSkill) this.activeSkill = data.activeSkill;
        if (data.windowOpacity !== undefined) this.windowOpacity = data.windowOpacity;
        if (data.microphoneDeviceId) this.microphoneDeviceId = data.microphoneDeviceId;
        // Also feed resume to prompt-loader
        const { promptLoader } = require('./prompt-loader');
        promptLoader.setResume(this.resume || '');
      }
    } catch (e) { /* settings file missing or corrupt — use defaults */ }
    
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();
      this.setupNetworkConfiguration();
      this.speechAvailable = speechService.isAvailable();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      let status;
      try {
        this.firstRunManager.ensureEnv();
        status = this.firstRunManager.getStatus();
        this.isFirstRun = status.needsOnboarding;
        logger.info("First-run status", status);
      } catch (e) {
        logger.warn("First-run check failed", { error: e.message });
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      }
      const isFirstRun = status.needsOnboarding;

      await windowManager.initializeWindows({ showMainWindow: !isFirstRun });
      windowManager.setAllWindowsOpacity(this.windowOpacity);
      // Defer broadcast so renderer scripts have time to register IPC listeners
      setTimeout(() => {
        windowManager.broadcastToAllWindows('opacity-changed', { opacity: this.windowOpacity });
      }, 500);
      this.setupGlobalShortcuts();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.starting = false;
      this.isReady = true;

      // Launch the onboarding wizard if this is the first run.
      if (this.isFirstRun) {
        // Defer slightly so all windows finish loading before we pop
        // the wizard on top of them.
        setTimeout(() => {
          try {
            windowManager.showOnboarding();
            windowManager.broadcastToAllWindows("first-run", status);
            logger.info("First-run onboarding: wizard opened");
          } catch (e) {
            logger.warn("Could not open first-run onboarding window", {
              error: e.message
            });
            // Fallback to legacy settings prompt
            try { this.showSettings(); } catch (_) { /* ignore */ }
          }
        }, 800);
      } else {
        // Already configured — mark completed so we never nag again.
        this.firstRunManager.markCompleted();
      }

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupNetworkConfiguration() {
    // Default Chromium network verification is used for all hosts.
    // We do not override User-Agent or bypass certificate checks because
    // that weakens security and is unnecessary for the Gemini API.
    logger.debug('Network configuration: using default Chromium behavior');
  }

  setupPermissions() {
    // Chromium/Electron requests "media" for getUserMedia (mic/camera).
    // Older handlers that only allow "microphone"/"camera" silently deny
    // capture — which surfaces as "Renderer audio capture failed" with an
    // empty/unknown error message after structured-clone drops DOMException
    // fields across the contextBridge.
    const allowedPermissions = new Set([
      "media",
      "microphone",
      "camera",
      "display-capture",
      "mediaKeySystem",
    ]);

    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        const granted = allowedPermissions.has(permission);
        logger.info("Permission request", {
          permission,
          granted,
          requestingUrl: details && details.requestingUrl,
        });
        callback(granted);
      }
    );

    // Without a check handler, some Chromium code paths treat media as
    // denied even when the request handler would grant it.
    session.defaultSession.setPermissionCheckHandler(
      (_webContents, permission, _requestingOrigin, details) => {
        if (allowedPermissions.has(permission)) {
          return true;
        }
        // mediaTypes is present for "media" checks (e.g. audio / video).
        if (
          permission === "media" ||
          (details &&
            Array.isArray(details.mediaTypes) &&
            details.mediaTypes.some((t) => t === "audio" || t === "video"))
        ) {
          return true;
        }
        return false;
      }
    );

    if (typeof session.defaultSession.setDevicePermissionHandler === "function") {
      session.defaultSession.setDevicePermissionHandler((details) => {
        const allowed =
          details.deviceType === "microphone" ||
          details.deviceType === "camera" ||
          details.deviceType === "speaker";
        logger.debug("Device permission", {
          deviceType: details.deviceType,
          origin: details.origin,
          allowed,
        });
        return allowed;
      });
    }
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+Shift+[": () => this.adjustOpacity(-0.05),
      "CommandOrControl+Shift+]": () => this.adjustOpacity(0.05),
      "CommandOrControl+,": () => windowManager.toggleSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      // Context-sensitive shortcuts based on interaction mode
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Global shortcut registered", { accelerator, success });
    });
  }

  setupServiceEventHandlers() {
    // Single path for UI + chat window: windowManager broadcasts to all
    // renderers and shows/hides the chat overlay. Speech service only emits
    // events — do not also call global.windowManager from speech.service or
    // getUserMedia will race against a second start/stop cycle.
    speechService.on("recording-started", () => {
      windowManager.handleRecordingStarted();
    });

    speechService.on("recording-stopped", () => {
      windowManager.handleRecordingStopped();
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  setupIPCHandlers() {
  ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());
  ipcMain.handle("list-displays", () => captureService.listDisplays());
  ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));
    
    // Provide reliable clipboard write via main process
    ipcMain.handle("copy-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });
    
    ipcMain.handle("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    ipcMain.handle("start-speech-recognition", () => {
      speechService.startRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("submit-audio-recording", async (_event, payload) => {
      let recording = null;
      const generation = (payload && typeof payload.generation === 'number') ? payload.generation : undefined;
      try {
        const byteLength = payload && payload.bytes
          ? (payload.bytes.byteLength || payload.bytes.length || 0)
          : 0;
        logger.info("Audio recording received from renderer", {
          byteLength,
          mimeType: payload && payload.mimeType,
          durationMs: payload && payload.durationMs,
          generation,
        });
        recording = audioRecordingService.save(
          payload && payload.bytes,
          payload && payload.mimeType,
          payload && payload.durationMs
        );
        windowManager.broadcastToAllWindows("audio-recording-saved", { recording });
        windowManager.broadcastToAllWindows("speech-status", { status: "Transcribing audio", available: true });
        const transcription = await speechService.transcribeFile(
          audioRecordingService.getPath(recording.recordingId),
          recording.fileName
        );
        await this.handleCompletedRecording(recording, transcription.text, generation);
        return { success: true, recording, text: transcription.text };
      } catch (error) {
        logger.error("Audio transcription failed", { error: error.message, recordingId: recording && recording.recordingId });
        // Do NOT persist this as a conversation event: a failed/empty
        // transcription (e.g. "No speech was detected") is not something the
        // user said, so it must never show up as a fake "user" chat message
        // or leak into the LLM's session history context on later requests.
        // The renderer shows a transient, local-only error via the
        // "audio-transcription-failed" broadcast below instead.
        windowManager.broadcastToAllWindows("audio-transcription-failed", {
          recordingId: recording && recording.recordingId,
          error: error.message,
          generation,
        });
        return { success: false, recording, error: error.message };
      }
    });

    ipcMain.handle("get-audio-recording", (_event, recordingId) => {
      try {
        return { success: true, ...audioRecordingService.get(recordingId) };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.on("audio-recording-timeout", () => {
      windowManager.broadcastToAllWindows("speech-status", {
        status: "One-minute recording limit reached; transcribing audio",
        available: true,
      });
    });

    // Renderer audio capture errors — surface them to the terminal so the
    // user can see what went wrong (renderer console.log goes to DevTools).
    ipcMain.on("audio-capture-error", (_event, data) => {
      logger.error('Renderer audio capture failed', {
        error: (data && (data.error || data.message)) || 'unknown',
        name: (data && data.name) || 'Error',
        constraint: (data && data.constraint) || undefined,
        stack: (data && data.stack) || undefined
      });
      // A capture failure here means no MediaRecorder/audio ever gets
      // submitted, so any window's "Transcribing" wave indicator would
      // otherwise wait forever. Broadcast a failure so it can unstick itself.
      windowManager.broadcastToAllWindows("audio-transcription-failed", {
        recordingId: null,
        error: (data && (data.error || data.message)) || 'Microphone capture failed',
      });
    });

    // Lifecycle/status pings from the renderer capture pipeline. Renderer
    // console logs are not visible in the terminal, so this lets us trace
    // where capture stalls directly from main-process logs.
    let _captureStatusLogCounter = 0;
    ipcMain.on("audio-capture-status", (_event, data) => {
      _captureStatusLogCounter++;
      if (_captureStatusLogCounter <= 20 || (data && data.stage === 'error')) {
        logger.info('Renderer capture status', {
          stage: data && data.stage,
          detail: data && data.detail
        });
      }
    });

    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      speechService.stopRecording();
    });

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        // Enforce horizontal constraints: min ~one icon, max original width
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          // Match content size to the DOM so no extra transparent area remains
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (e) {
          // Fallback in case setContentSize isn’t available on some platform
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
        logger.debug("Main window resized (content)", { width: clampedWidth, height });
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("get-full-conversation-history", () => {
      return sessionManager.getFullConversationHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      this.clearSessionMemory();
      return { success: true };
    });

    // Load a screenshot PNG from disk and return it as a data URL.
    // This lets the chat window restore screenshot thumbnails after restart
    // without storing large base64 blobs in session-memory.json.
    ipcMain.handle("load-screenshot-file", (_event, screenshotPath) => {
      try {
        const fs = require('fs');
        if (!screenshotPath || !fs.existsSync(screenshotPath)) {
          return { success: false, error: 'Screenshot file not found' };
        }
        const buffer = fs.readFileSync(screenshotPath);
        const ext = screenshotPath.split('.').pop().toLowerCase();
        const mimeType = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
        const base64 = buffer.toString('base64');
        return { success: true, dataUrl: `data:${mimeType};base64,${base64}` };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: text.length });

      // Typed messages need the full skill pipeline (with history context),
      // NOT the voice "intelligent filter" pipeline. Voice keeps its filter
      // behaviour; typed chat goes through processWithLLM so it gets real
      // answers using the active skill prompt and recent conversation history.
      (async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      })();

      return { success: true };
    });

    ipcMain.handle("cancel-llm-request", (_event, messageId) => {
      const request = this._activeLlmRequests.get(messageId);
      if (!request || request.controller.signal.aborted) {
        return { aborted: false };
      }
      request.controller.abort();
      return { aborted: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();
        
        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    // First-run onboarding status — renderer can query to know whether
    // to show the welcome banner / prompt for API-key entry.
    ipcMain.handle("get-first-run-status", () => {
      try {
        return this.firstRunManager.getStatus();
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    ipcMain.handle("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the main overlay window now that onboarding is done
        // and API keys are configured.
        await windowManager.showMainWindow();
        // Broadcast speech availability so the mic button appears
        const { BrowserWindow } = require("electron");
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Open a URL in the system browser (used by the GitHub star button
    // in onboarding).
    ipcMain.handle("open-external", async (_event, url) => {
      try {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: "Invalid URL" };
        }
        const { shell } = require("electron");
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        logger.warn("Failed to open external URL", { url, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    ipcMain.handle("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      const window = windowManager.windows.forEach((win, type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-updated", { skill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        speechService.stopRecording();
        logger.info("Speech recognition stopped via global shortcut");
      } catch (error) {
        logger.error("Error stopping speech recognition:", error);
      }
    } else {
      try {
        // Ensure the main overlay renderer is active before starting capture.
        // The renderer's AudioContext / ScriptProcessor needs the window to
        // be the foreground Chromium view on some Windows configurations.
        if (windowManager && typeof windowManager.showMainWindow === 'function') {
          windowManager.showMainWindow().catch(() => {});
        }
        speechService.startRecording();
        windowManager.showChatWindow();
        logger.info("Speech recognition started via global shortcut");
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      audioRecordingService.clear();
      const screenshotsDir = path.join(config.get('app.dataDir'), 'screenshots');
      try {
        fs.rmSync(screenshotsDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn('Failed to clear persisted screenshots', { error: error.message, screenshotsDir });
      }
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  startLlmRequest(messageId, source) {
    const request = {
      controller: new AbortController(),
      partialText: "",
      source,
    };
    this._activeLlmRequests.set(messageId, request);
    return request;
  }

  appendLlmDelta(messageId, delta) {
    const request = this._activeLlmRequests.get(messageId);
    if (request && delta) {
      request.partialText += delta;
    }
  }

  finishLlmRequest(messageId) {
    if (messageId) this._activeLlmRequests.delete(messageId);
  }

  handleCancelledLlmRequest(messageId, metadata = {}) {
    const request = this._activeLlmRequests.get(messageId);
    const partialText = request?.partialText?.trim() || "";
    if (partialText) {
      sessionManager.addModelResponse(partialText, {
        ...metadata,
        messageId,
        source: request.source,
        cancelled: true,
      });
    }
    windowManager.broadcastToAllWindows("llm-request-aborted", {
      messageId,
      partialText,
    });
    this.finishLlmRequest(messageId);
  }

  async handleCompletedRecording(recording, text, generation) {
    const transcription = String(text || '').trim();
    if (!transcription) {
      throw new Error('No speech was detected in this recording');
    }
    const audio = {
      recordingId: recording.recordingId,
      mimeType: recording.mimeType,
      durationMs: recording.durationMs,
    };
    // Do NOT persist to session memory or call the LLM here. The user gets to
    // review/edit the transcription in the chat input box first; session
    // memory + LLM processing only happen once they actually submit it via
    // the normal "send-chat-message" path (see sendMessage() in chat-window.js).
    windowManager.broadcastToAllWindows('transcription-draft-ready', {
      text: transcription,
      audio,
      generation,
    });
    // Make sure the chat window (where the editable draft lands) is visible
    // and focused, even if it was hidden mid-recording or the recording was
    // started from the main overlay's mic button.
    windowManager.showChatWindow();
  }

  adjustOpacity(delta) {
    const current = this.windowOpacity !== undefined ? this.windowOpacity : 1.0;
    const next = Math.min(1, Math.max(0, Math.round((current + delta) * 100) / 100));
    this.windowOpacity = next;
    windowManager.setAllWindowsOpacity(next);
    this._saveUserSettings({
      resume: this.resume,
      codingLanguage: this.codingLanguage,
      activeSkill: this.activeSkill,
      windowOpacity: this.windowOpacity,
    });
    windowManager.broadcastToAllWindows('opacity-changed', { opacity: next });
    logger.info('Window opacity adjusted via shortcut', { opacity: next });
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "dsa",
      "programming",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;

    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    let messageId = null;
    try {

  const capture = await captureService.captureAndProcess();

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        this.broadcastOCRError("Failed to capture screenshot image");
        return;
      }

      // Persist screenshot PNG to disk so thumbnails survive restarts.
      const fs = require('fs');
      const screenshotsDir = path.join(config.get('app.dataDir'), 'screenshots');
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }
      const screenshotId = `ss-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      const screenshotFileName = `${screenshotId}.png`;
      const screenshotPath = path.join(screenshotsDir, screenshotFileName);
      fs.writeFileSync(screenshotPath, capture.imageBuffer);

      // Add a user-facing session event so the screenshot record persists
      // in session-memory.json and the chat can restore the thumbnail.
      sessionManager.addConversationEvent({
        role: 'user',
        content: 'Screenshot captured',
        action: 'screenshot_captured',
        metadata: {
          screenshotId,
          screenshotPath,
          screenshotMimeType: capture.mimeType || 'image/png',
          screenshotSize: capture.imageBuffer.length,
          screenshotDimensions: capture.metadata && capture.metadata.dimensions
        }
      });

      // Send the captured image to the chat window so the user can see
      // what was captured alongside the AI response.
      const imageBase64 = Buffer.from(capture.imageBuffer).toString('base64');
      const imageDataUrl = `data:${capture.mimeType || 'image/png'};base64,${imageBase64}`;
      logger.info('Broadcasting screenshot to chat', { size: capture.imageBuffer.length, screenshotId });
      windowManager.broadcastToAllWindows("screenshot-captured", {
        imageData: imageDataUrl,
        screenshotId,
        screenshotPath,
        timestamp: Date.now()
      });

      // Use image directly with LLM and active skill; do not send chat messages here
      const sessionHistory = sessionManager.getOptimizedHistory();

      const skillsRequiringProgrammingLanguage = ['dsa', 'programming'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `img-${Date.now()}-${this._responseSeq}`;
      const activeRequest = this.startLlmRequest(messageId, 'image');
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });

      const llmResult = await llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.appendLlmDelta(messageId, delta);
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        },
        activeRequest.controller.signal
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      this.broadcastTranscriptionLLMResponse(llmResult);
      this.finishLlmRequest(messageId);
    } catch (error) {
      if (llmService.isCancellationError(error)) {
        this.handleCancelledLlmRequest(messageId, {
          skill: this.activeSkill,
          isImageAnalysis: true,
        });
        return;
      }
      this.finishLlmRequest(messageId);
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      this.broadcastOCRError(error.message, messageId);
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  async processWithLLM(text, sessionHistory) {
    let messageId = null;
    try {
      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa', 'programming'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      logger.info('LLM processing started', {
        provider: config.getProviderFor('text'),
        model: config.getModelFor('text'),
        skill: this.activeSkill,
        userInput: (text || '').substring(0, 200),
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable'
      });

      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `chat-${Date.now()}-${this._responseSeq}`;
      const activeRequest = this.startLlmRequest(messageId, 'chat');
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      const llmResult = await llmService.processTextWithSkillStream(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.appendLlmDelta(messageId, delta);
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        },
        activeRequest.controller.signal
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      logger.info("LLM processing completed, showing response", {
        provider: llmService.provider,
        model: llmService.model,
        userInput: (text || '').substring(0, 200),
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastTranscriptionLLMResponse(llmResult);
      this.finishLlmRequest(messageId);
    } catch (error) {
      if (llmService.isCancellationError(error)) {
        this.handleCancelledLlmRequest(messageId, { skill: this.activeSkill });
        return;
      }
      this.finishLlmRequest(messageId);
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message, messageId);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment(text) {
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }

    // Show the live transcript right away in all windows.
    sessionManager.addUserInput(fragment, 'speech');
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("transcription-received", { text: fragment });
    });

    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
    }
    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const combined = this._utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this._utteranceBuffer = "";
    this._utteranceDispatchInFlight = true;

    try {
      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    // Hoisted so the catch block can tie a fallback answer to the same UI
    // bubble the streaming start event created; otherwise a total failure
    // leaves an empty streamed bubble stranded next to the fallback message.
    let messageId = null;
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa', 'programming'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      // Stream the answer so it renders progressively in the chat + overlay.
      // A unique messageId ties the start/chunk/final events to one bubble so
      // the UI never duplicates or interleaves concurrent responses.
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `tr-${Date.now()}-${this._responseSeq}`;
      const activeRequest = this.startLlmRequest(messageId, 'transcription');
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      const llmResult = await llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.appendLlmDelta(messageId, delta);
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        },
        activeRequest.controller.signal
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      // Send response to chat windows
      this.broadcastTranscriptionLLMResponse(llmResult);
      this.finishLlmRequest(messageId);

      logger.info("Transcription LLM response completed", {
        provider: llmService.provider,
        model: llmService.model,
        userInput: (cleanText || '').substring(0, 200),
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      if (llmService.isCancellationError(error)) {
        this.handleCancelledLlmRequest(messageId, {
          skill: this.activeSkill,
          isTranscriptionResponse: true,
        });
        return;
      }
      this.finishLlmRequest(messageId);
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      // Try to provide a fallback response
      try {
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);
        // Carry the streaming messageId so the chat/overlay replace the live
        // bubble instead of leaving it stuck and appending a duplicate.
        if (messageId) {
          fallbackResult.metadata = { ...fallbackResult.metadata, messageId };
        }

        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.broadcastTranscriptionLLMResponse(fallbackResult);
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });
        
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
        this.broadcastLLMError(error.message, messageId);
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage, messageId = null) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      messageId,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage, messageId = null) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      messageId,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    // All callers already log the outcome at info level with richer context
    // (skill, programmingLanguage, processingTime, fallback reason, etc.).
    logger.debug("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getSettings() {
    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "dsa",
      resume: this.resume || "",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      windowGap: windowManager.windowGap,
      windowOpacity: this.windowOpacity !== undefined ? this.windowOpacity : 1.0,
      microphoneDeviceId: this.microphoneDeviceId || 'default',

      geminiKey: process.env.GEMINI_API_KEY || "",
      groqKey: process.env.GROQ_API_KEY || "",
      cerebrasKey: process.env.CEREBRAS_API_KEY || "",
      assemblyaiKey: process.env.ASSEMBLYAI_API_KEY || "",
      elevenlabsKey: process.env.ELEVENLABS_API_KEY || "",
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
      GROQ_API_KEY: process.env.GROQ_API_KEY || "",
      CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY || "",
      ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || "",
      ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
      modelSelection: config.getAllModelSelections(),
      speechProvider: process.env.SPEECH_PROVIDER || 'groq',
      llmProvider: config.getLLMProvider(),
      speechAvailable: this.speechAvailable
    };
  }

  saveSettings(settings) {
    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.resume !== undefined) {
        this.resume = settings.resume;
        const { promptLoader } = require('./prompt-loader');
        promptLoader.setResume(settings.resume);
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }
      if (settings.windowGap !== undefined) {
        const gap = Number(settings.windowGap);
        if (Number.isFinite(gap)) windowManager.setWindowGap(gap);
      }
      if (settings.windowOpacity !== undefined) {
        const opacity = parseFloat(settings.windowOpacity);
        if (Number.isFinite(opacity)) {
          this.windowOpacity = Math.min(1, Math.max(0, opacity));
          windowManager.setAllWindowsOpacity(this.windowOpacity);
        }
      }
      if (settings.microphoneDeviceId !== undefined) {
        this.microphoneDeviceId = settings.microphoneDeviceId || 'default';
      }

      // ── Persist provider / API-key fields back to .env ──
      const envUpdates = {};

      // Model selection per category → TEXT_PROVIDER, TEXT_MODEL, etc.
      if (settings.modelSelection) {
        const cats = ['text', 'image', 'voice'];
        cats.forEach(cat => {
          const sel = settings.modelSelection[cat];
          if (sel && sel.provider) {
            envUpdates[`${cat.toUpperCase()}_PROVIDER`] = sel.provider;
          }
          if (sel && sel.model) {
            envUpdates[`${cat.toUpperCase()}_MODEL`] = sel.model;
          }
        });
        // Also set legacy LLM_PROVIDER / SPEECH_PROVIDER for backward compat
        if (settings.modelSelection.text && settings.modelSelection.text.provider) {
          envUpdates.LLM_PROVIDER = settings.modelSelection.text.provider;
        }
        if (settings.modelSelection.voice && settings.modelSelection.voice.provider) {
          envUpdates.SPEECH_PROVIDER = settings.modelSelection.voice.provider;
        }
      }

      // API keys — sent as env-var names directly (e.g. GEMINI_API_KEY)
      ['GEMINI_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'ASSEMBLYAI_API_KEY', 'ELEVENLABS_API_KEY'].forEach(k => {
        if (settings[k] !== undefined) envUpdates[k] = settings[k];
      });

      // Legacy single-provider keys (backward compat during transition)
      if (settings.geminiKey !== undefined) envUpdates.GEMINI_API_KEY = settings.geminiKey;
      if (settings.groqKey !== undefined) envUpdates.GROQ_API_KEY = settings.groqKey;
      if (settings.cerebrasKey !== undefined) envUpdates.CEREBRAS_API_KEY = settings.cerebrasKey;
      if (settings.assemblyaiKey !== undefined) envUpdates.ASSEMBLYAI_API_KEY = settings.assemblyaiKey;
      if (settings.elevenlabsKey !== undefined) envUpdates.ELEVENLABS_API_KEY = settings.elevenlabsKey;
      if (settings.speechProvider !== undefined) envUpdates.SPEECH_PROVIDER = settings.speechProvider;
      if (settings.llmProvider !== undefined) envUpdates.LLM_PROVIDER = settings.llmProvider;

    // Capture the previous speech provider BEFORE persisting
      const prevVoiceProvider = config.getProviderFor('voice') || 'groq';

      const persistedKeys = this.persistEnvUpdates(envUpdates);

      // Reinitialize LLM when text/image provider/model or any API key changes
      const llmProviderChanged = settings.modelSelection &&
        (settings.modelSelection.text || settings.modelSelection.image);
      const anyLLMKeyChanged = settings.GEMINI_API_KEY !== undefined ||
        settings.GROQ_API_KEY !== undefined || settings.CEREBRAS_API_KEY !== undefined ||
        settings.geminiKey !== undefined || settings.groqKey !== undefined ||
        settings.cerebrasKey !== undefined || settings.llmProvider !== undefined;

      if (llmProviderChanged || anyLLMKeyChanged) {
        try {
          llmService.initializeClient();
          logger.info("LLM service reinitialized after provider or key update", {
            textProvider: config.getProviderFor('text'),
            imageProvider: config.getProviderFor('image'),
          });
        } catch (e) {
          logger.warn("Failed to reinitialize LLM service after provider or key update", {
            error: e.message
          });
        }
      }

      // Reinitialize speech service when voice provider/model or key changes
      const voiceChanged = settings.modelSelection && settings.modelSelection.voice;
      const voiceKeyChanged = settings.GROQ_API_KEY !== undefined ||
        settings.ASSEMBLYAI_API_KEY !== undefined ||
        settings.ELEVENLABS_API_KEY !== undefined ||
        settings.speechProvider !== undefined;

      if (voiceChanged || voiceKeyChanged) {
        try {
          speechService.initializeClient();
          this.speechAvailable = speechService.isAvailable
            ? speechService.isAvailable()
            : false;
          // Broadcast so any open window (settings, overlay, chat)
          // can react immediately — especially the main overlay's
          // mic button, which queries availability on load.
          const { BrowserWindow } = require("electron");
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("speech-availability", { available: this.speechAvailable });
            }
          });
          logger.info('Speech service reinitialized after settings change', {
            voiceChanged: !!voiceChanged,
            voiceKeyChanged,
            speechAvailable: this.speechAvailable,
          });
        } catch (e) {
          logger.warn("Failed to reinitialize speech service after settings change", {
            error: e.message
          });
        }
      }

      logger.info("Settings saved successfully", {
        ...settings,
        persistedEnvKeys: persistedKeys
      });

      // Persist user settings (resume, skill, language, opacity) to disk
      this._saveUserSettings({
        resume: this.resume,
        codingLanguage: this.codingLanguage,
        activeSkill: this.activeSkill,
        windowOpacity: this.windowOpacity,
        microphoneDeviceId: this.microphoneDeviceId,
      });

      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Persist user settings to a JSON file in userData so they survive restarts.
   */
  _saveUserSettings(settings) {
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      let existing = {};
      if (fs.existsSync(settingsPath)) {
        try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (_) {}
      }
      Object.assign(existing, settings);
      fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf8');
      logger.debug('User settings persisted to disk');
    } catch (error) {
      logger.warn('Failed to persist user settings', { error: error.message });
    }
  }

  persistSettings(settings) {
    // You can extend this to save to a file or database
    // For now, we'll just keep them in memory
    logger.debug("Settings persisted", settings);
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const updated = new Set();
    const outLines = [];

    for (const line of existingLines) {
      // Match "KEY=" (with optional whitespace) but skip comment lines
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        const key = m[1];
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Append any keys that weren't already present
    for (const key of keys) {
      if (!updated.has(key)) {
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      }
    }

    // Update process.env so the running app picks up the new values
    // immediately (and so the settings UI reads the same source of truth).
    for (const key of keys) {
      process.env[key] = String(updates[key]);
    }

    const newContent = outLines.join("\n");
    try {
      const tmpPath = envPath + ".tmp";
      fs.writeFileSync(tmpPath, newContent, "utf8");
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }

    logger.info("Persisted .env updates", { keys: Array.from(updated) });
    return Array.from(updated);
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon
        app.dock.setIcon(fullIconPath);

        // Force dock refresh with multiple attempts
        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 100);

        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 500);
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Force update the bundle name for macOS stealth
        const { execSync } = require("child_process");
        try {
          // Update the app's Info.plist CFBundleName in memory
          if (process.mainModule && process.mainModule.filename) {
            const appPath = process.mainModule.filename;
            // Force set the bundle name directly
            process.env.CFBundleName = appName.trim();
          }
        } catch (e) {
          // Silently fail if we can't modify bundle info
        }

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping.
      // Use the stable com.opencluely.app ID so Windows microphone
      // privacy settings persist across runs and stealth name changes.
      if (process.platform === 'win32') {
        app.setAppUserModelId('com.opencluely.app');
      }

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
