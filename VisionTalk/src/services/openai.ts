import type { PhotoData } from '@mentra/sdk'
import { vtLog } from '../log'
import { ENV } from '../config'
import type { Message } from '../types'
import { SYSTEM_PROMPT, USER_PROMPT_PREFIX, FEW_SHOT_EXAMPLES, OUTPUT_FORMAT_RULES } from '../prompts'
import { enhanceForOCR } from './imageEnhance'

import { AnalysisResult } from '../types'

export async function analyzeImageWithGPT4V(
  photo: PhotoData,
  recordEvent?: (stage: string, detail?: any, error?: string) => void
): Promise<AnalysisResult> {
  recordEvent?.('openai_request_init')
  let workingBuffer = photo.buffer as Buffer
  let mimeType = photo.mimeType
  let enhanceSteps: string[] = []
  if (ENV.PHOTO_ENHANCE) {
    try {
      const enh = await enhanceForOCR(photo, recordEvent)
      workingBuffer = enh.buffer
      enhanceSteps = enh.steps
      // If converted to PNG we update mime
      if (enhanceSteps.includes('to_png')) mimeType = 'image/png'
    } catch (err: any) {
      recordEvent?.('photo_enhance_unhandled_error', {}, err?.message || String(err))
    }
  } else {
    recordEvent?.('photo_enhance_skipped', { reason: 'disabled' })
  }
  const base64Image = workingBuffer.toString('base64')
  const imageUrl = `data:${mimeType};base64,${base64Image}`

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: FEW_SHOT_EXAMPLES },
    { role: 'system', content: OUTPUT_FORMAT_RULES },
    { role: 'user', content: [
      { type: 'text', text: USER_PROMPT_PREFIX },
      { type: 'image_url', image_url: { url: imageUrl } }
    ] as any }
  ]

  const payload = { model: ENV.OPENAI_MODEL, messages, max_tokens: 850, temperature: 0.6 }

  vtLog('debug', '[GPT-4V] Sending image analysis request')
  recordEvent?.('openai_request_sent', { model: ENV.OPENAI_MODEL, max_tokens: payload.max_tokens, enhanceSteps })
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ENV.OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    vtLog('warn', `[GPT-4V] Error ${res.status} ${res.statusText}`)
    recordEvent?.('openai_error', { status: res.status, statusText: res.statusText, body: errText })
    throw new Error(`OpenAI API error: ${res.status} ${res.statusText}`)
  }

  const json = (await res.json()) as any
  const raw = json.choices?.[0]?.message?.content?.trim()
  if (!raw) {
    recordEvent?.('openai_empty_response')
    throw new Error('No analysis received from GPT-4V')
  }
  // Try to split ANSWER and ANALYSIS blocks
  let answer: string | undefined
  let analysis: string = raw
  const answerMatch = raw.match(/ANSWER:\s*([\s\S]*?)(?:\n\s*ANALYSIS:|$)/i)
  if (answerMatch) {
    answer = answerMatch[1].trim()
    const analysisMatch = raw.match(/ANALYSIS:\s*([\s\S]*)/i)
    if (analysisMatch) analysis = analysisMatch[1].trim()
  }
  vtLog('debug', `[GPT-4V] Analysis parsed (len=${analysis.length}) answerLen=${answer?.length || 0}`)
  recordEvent?.('openai_response_ok', { excerpt: analysis.substring(0, 160), length: analysis.length, hasAnswer: !!answer })
  return { analysis, answer }
}
