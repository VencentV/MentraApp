import { LogLevel } from './types'
import { ENV } from './config'

const levelOrder: Record<LogLevel, number> = { silent: 99, error: 0, warn: 1, info: 2, debug: 3 }

export function shouldLog(level: LogLevel): boolean {
  const current = (ENV.VT_LOG_LEVEL in levelOrder ? ENV.VT_LOG_LEVEL : 'info') as LogLevel
  return levelOrder[level] <= levelOrder[current]
}

export function vtLog(level: LogLevel, msg: string, meta?: any): void {
  if (!shouldLog(level)) return
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg
  switch (level) {
    case 'error':
      console.error('[VisionTalk]', line); break
    case 'warn':
      console.warn('[VisionTalk]', line); break
    default:
      console.log('[VisionTalk]', line); break
  }
}
