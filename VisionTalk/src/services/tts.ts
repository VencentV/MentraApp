import type { AppSession } from '@mentra/sdk'
import { ENV } from '../config'
import { vtLog } from '../log'
import type { UserState, VoiceConfig } from '../types'

// Unified signature:
// speakWithEvent(session, text, voiceConfig?, recordEvent?, state?, tag?)
export async function speakWithEvent(
  session: AppSession,
  text: string,
  voiceConfig?: VoiceConfig,
  recordEvent?: (stage: string, detail?: any, error?: string) => void,
  state?: UserState,
  tag: string = 'tts'
) {
  // Optional duplicate suppression
  try {
    if (state) {
      const now = Date.now()
      const hash = simpleHash(text)
      const withinWindow = state.lastTTSAt && (now - state.lastTTSAt) < ENV.AUDIO_DUPLICATE_SUPPRESS_MS
      if (withinWindow && state.lastTTSHash === hash) {
        vtLog('debug', 'Suppressing duplicate TTS', { tag, msSinceLast: now - (state.lastTTSAt || 0) })
        recordEvent?.(tag + '_suppressed', { textExcerpt: text.slice(0, 80) })
        return { success: true, suppressed: true }
      }
      state.lastTTSAt = now
      state.lastTTSHash = hash
    }
  } catch {}

  recordEvent?.(tag + '_start', { textExcerpt: text.substring(0, 120) })
  try {
    const res = await session.audio.speak(text, voiceConfig as any)
    recordEvent?.(tag + '_done', { success: res?.success, duration: res?.duration })
    return res
  } catch (err: any) {
    vtLog('warn', 'TTS speak failed', { tag, error: String(err) })
    recordEvent?.(tag + '_error', { message: String(err) })
    throw err
  }
}

// Unified signature:
// playTTSInChunks(session, text, voiceConfig?, recordEvent?, state?, tag?)
export async function playTTSInChunks(
  session: AppSession,
  text: string,
  voiceConfig?: VoiceConfig,
  recordEvent?: (stage: string, detail?: any, error?: string) => void,
  state?: UserState,
  tag: string = 'tts_chunk'
) {
  const chunks = chunkText(text, 350)
  for (let i = 0; i < chunks.length; i++) {
    const ctag = `${tag}_${i + 1}/${chunks.length}`
    await speakWithEvent(session, chunks[i], voiceConfig, recordEvent, state, ctag)
  }
}

function chunkText(s: string, maxLen: number): string[] {
  if (!s) return []
  if (s.length <= maxLen) return [s]
  const parts: string[] = []
  let start = 0
  while (start < s.length) {
    let end = Math.min(start + maxLen, s.length)
    // try not to split mid-sentence
    const period = s.lastIndexOf('.', end)
    if (period > start + maxLen * 0.6) end = period + 1
    parts.push(s.slice(start, end).trim())
    start = end
  }
  return parts.filter(Boolean)
}

function simpleHash(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h) + input.charCodeAt(i)
    h |= 0
  }
  return String(h)
}
