export type CodingLanguage = 'cpp' | 'c' | 'python' | 'java' | 'javascript';

export type ActiveSkill = 'dsa' | 'programming';

export type VoiceMimeType = 'audio/webm' | 'audio/webm;codecs=opus';

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface SettingsPatch {
  codingLanguage?: CodingLanguage;
  activeSkill?: ActiveSkill;
  resume?: string;
  appIcon?: 'terminal' | 'activity' | 'settings';
  selectedIcon?: 'terminal' | 'activity' | 'settings';
  windowGap?: number;
  windowOpacity?: number;
  microphoneDeviceId?: string;
  speechProvider?: string;
  llmProvider?: string;
  modelSelection?: Partial<Record<'text' | 'image' | 'voice', ModelSelection>>;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  ASSEMBLYAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
}

export interface RecordingPayload {
  bytes: ArrayBuffer | Uint8Array;
  mimeType: VoiceMimeType;
  durationMs: number;
  generation?: number;
}

export interface TranscriptionDraftReadyEvent {
  text: string;
  audio: {
    recordingId: string;
    mimeType: VoiceMimeType;
    durationMs: number;
  };
  generation?: number;
}

export interface LlmResponseStartEvent {
  messageId: string;
  skill: ActiveSkill;
}

export interface LlmResponseChunkEvent {
  messageId: string;
  delta: string;
}

export interface LlmRequestAbortedEvent {
  messageId: string;
  partialText: string;
}

const RECORDING_MIME_TYPES = new Set<VoiceMimeType>([
  'audio/webm',
  'audio/webm;codecs=opus',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isByteBuffer(value: unknown): value is ArrayBuffer | Uint8Array {
  return value instanceof ArrayBuffer || value instanceof Uint8Array;
}

export function assertRecordingPayload(value: unknown): asserts value is RecordingPayload {
  if (!isRecord(value)) {
    throw new TypeError('Recording payload must be an object');
  }
  if (!isByteBuffer(value.bytes)) {
    throw new TypeError('Recording payload bytes must be an ArrayBuffer or Uint8Array');
  }
  if (typeof value.mimeType !== 'string' || !RECORDING_MIME_TYPES.has(value.mimeType as VoiceMimeType)) {
    throw new TypeError('Unsupported recorded-audio format');
  }
  if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 60000) {
    throw new TypeError('Recording duration must be between 0 and 60000 milliseconds');
  }
  const generation = value.generation;
  if (generation !== undefined && (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0)) {
    throw new TypeError('Recording generation must be a non-negative integer');
  }
}

export function assertSettingsPatch(value: unknown): asserts value is SettingsPatch {
  if (!isRecord(value)) {
    throw new TypeError('Settings patch must be an object');
  }
  if (value.resume !== undefined && typeof value.resume !== 'string') {
    throw new TypeError('Resume must be a string');
  }
  if (value.windowGap !== undefined && (!numberInRange(value.windowGap, 0, 100))) {
    throw new TypeError('Window gap must be between 0 and 100');
  }
  if (value.windowOpacity !== undefined && (!numberInRange(value.windowOpacity, 0, 1))) {
    throw new TypeError('Window opacity must be between 0 and 1');
  }
  if (value.microphoneDeviceId !== undefined && typeof value.microphoneDeviceId !== 'string') {
    throw new TypeError('Microphone device ID must be a string');
  }
}

function numberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}
