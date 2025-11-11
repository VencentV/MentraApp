import dotenv from 'dotenv'
import { LogLevel } from './types'

dotenv.config()

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name]
  if (!v) {
    console.warn(`[VisionTalk] Missing env ${name}` + (fallback ? `, using fallback` : ''))
    return fallback ?? ''
  }
  return v
}

export const ENV = {
  PACKAGE_NAME: requireEnv('PACKAGE_NAME', 'com.visiontalk.assistant.dev'),
  MENTRAOS_API_KEY: requireEnv('MENTRAOS_API_KEY'),
  OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o',
  ELEVENLABS_API_KEY: requireEnv('ELEVENLABS_API_KEY'),
  PORT: parseInt(process.env.PORT || '3000', 10),
  PUBLIC_URL: process.env.PUBLIC_URL,
  CAPTURE_ONLY: (process.env.CAPTURE_ONLY || '').toLowerCase() === 'true',
  VT_LOG_LEVEL: (process.env.VT_LOG_LEVEL || 'info').toLowerCase() as LogLevel,
  VT_HTTP_LOG: (process.env.VT_HTTP_LOG || 'sampled').toLowerCase(),
  VT_HTTP_SAMPLE_RATE: Math.max(0, Math.min(1, parseFloat(process.env.VT_HTTP_SAMPLE_RATE || '0.033'))),
  STARTUP_CHIME: (process.env.STARTUP_CHIME || '').toLowerCase() === 'true',
  AUDIO_DUPLICATE_SUPPRESS_MS: Math.max(0, parseInt(process.env.AUDIO_DUPLICATE_SUPPRESS_MS || '1200', 10)),
  CAPTURE_CHIME_ENABLED: (process.env.CAPTURE_CHIME_ENABLED || 'true').toLowerCase() === 'true',
  PHOTO_CAPTURE_SIZE: (process.env.PHOTO_CAPTURE_SIZE || 'medium').toLowerCase(), // small|medium|large (default medium now)
  // Simple center crop only (no enhancement)
  PHOTO_CENTER_CROP: (process.env.PHOTO_CENTER_CROP || 'true').toLowerCase() === 'true',
  PHOTO_CENTER_CROP_FACTOR: Math.max(0.1, Math.min(1, parseFloat(process.env.PHOTO_CENTER_CROP_FACTOR || '0.6'))),
}

export function getServerUrl(): string {
  if (ENV.PUBLIC_URL) return ENV.PUBLIC_URL
  return `http://localhost:${ENV.PORT}`
}
