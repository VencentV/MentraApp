import type { Buffer } from 'node:buffer'

export interface StoredPhoto {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string;
  size: number;
  sha256?: string;
}

export type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

export interface VoiceConfig {
  voice_id?: string;
  model_id?: string;
  voice_settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    speed?: number;
  };
}

export interface UserState {
  isProcessing: boolean;
  photoHistory: StoredPhoto[];
  welcomePlayed?: boolean;
  startupDebounceUntil?: number;
  lastTTSHash?: string | null;
  lastTTSAt?: number;
}

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'
