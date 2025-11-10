import type { AppSession } from '@mentra/sdk'
import { vtLog } from '../log'
import { ENV } from '../config'
import type { VoiceConfig, UserState } from '../types'

export async function speakWithEvent(
  session: AppSession,
  text: string,
  voice: VoiceConfig,
  recordEvent: (stage: string, detail?: any, error?: string) => void,
  state: UserState,
  stage: string
): Promise<void> {
  recordEvent(stage + '_start', { textExcerpt: text.substring(0, 120) })
  // Duplicate suppression per user
  try {
    const hash = await hashText(text + JSON.stringify(voice || {}))
    if (state.lastTTSHash === hash && state.lastTTSAt && (Date.now() - state.lastTTSAt) < ENV.AUDIO_DUPLICATE_SUPPRESS_MS) {
      vtLog('warn', 'Suppressing near-duplicate TTS', { stage, sinceMs: Date.now() - (state.lastTTSAt || 0) })
      recordEvent('tts_duplicate_suppressed', { stage, excerpt: text.substring(0, 80) })
      return
    }
    state.lastTTSHash = hash
    state.lastTTSAt = Date.now()
  } catch {}

  try {
    await session.audio.speak(text, voice as any)
    recordEvent(stage + '_done')
  } catch (err: any) {
    vtLog('error', `TTS speak error on stage ${stage}`, { error: err?.message || String(err) })
    recordEvent(stage + '_error', {}, err?.message || String(err))
    throw err
  }
}

export async function playTTSInChunks(
  session: AppSession,
  text: string,
  voice: VoiceConfig,
  recordEvent: (stage: string, detail?: any, error?: string) => void,
  state: UserState,
  maxCharsPerChunk: number = 450
) {
  const chunks = splitIntoChunks(text, maxCharsPerChunk)
  recordEvent('tts_chunking', { chunks: chunks.length, strategy: 'sequential_speak' })
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    recordEvent('tts_chunk_start', { chunk: i + 1, total: chunks.length })
    try {
      await speakWithEvent(session, chunk, voice, recordEvent, state, `tts_chunk_${i + 1}`)
      recordEvent('tts_chunk_done', { chunk: i + 1, total: chunks.length })
    } catch (err: any) {
      vtLog('error', 'TTS chunk speak error', { chunk: i + 1, error: err?.message || String(err) })
      recordEvent('tts_analysis_error', { chunk: i + 1, message: err?.message || String(err) }, err?.toString?.())
      break
    }
  }
}

function splitIntoChunks(text: string, maxChars: number): string[] {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let current = ''
  for (const s of sentences) {
    if (!s) continue
    const candidate = current ? current + ' ' + s : s
    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      if (current) chunks.push(current)
      if (s.length <= maxChars) {
        current = s
      } else {
        let idx = 0
        while (idx < s.length) {
          chunks.push(s.slice(idx, idx + maxChars))
          idx += maxChars
        }
        current = ''
      }
    }
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : [text]
}

async function hashText(text: string): Promise<string> {
  const { createHash } = await import('crypto')
  return createHash('sha256').update(text).digest('hex')
}
