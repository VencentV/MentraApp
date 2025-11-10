import type { LogLevel } from './types'
import { ENV } from './config'

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 5,
  error: 4,
  warn: 3,
  info: 2,
  debug: 1,
}

function levelAllowed(level: LogLevel): boolean {
  const current = ENV.VT_LOG_LEVEL || 'info'
  // If current is silent, block everything
  if (current === 'silent') return false
  const want = LEVEL_ORDER[level] ?? LEVEL_ORDER.info
  const have = LEVEL_ORDER[current] ?? LEVEL_ORDER.info
  // Allow if requested level severity is >= configured threshold
  return want >= have
}

export function shouldLog(level: LogLevel): boolean {
  return levelAllowed(level)
}

export function vtLog(level: LogLevel, message: string, meta?: any): void {
  if (!levelAllowed(level)) return
  const ts = new Date().toISOString()
  const payload = meta ? ` ${JSON.stringify(meta)}` : ''
  switch (level) {
    case 'error':
      console.error(`[VisionTalk ${ts}] ERROR: ${message}${payload}`)
      break
    case 'warn':
      console.warn(`[VisionTalk ${ts}] WARN: ${message}${payload}`)
      break
    case 'info':
      console.log(`[VisionTalk ${ts}] INFO: ${message}${payload}`)
      break
    case 'debug':
      console.debug(`[VisionTalk ${ts}] DEBUG: ${message}${payload}`)
      break
    default:
      console.log(`[VisionTalk ${ts}] ${message}${payload}`)
  }
}
