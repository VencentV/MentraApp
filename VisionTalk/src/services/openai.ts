import type { PhotoData } from '@mentra/sdk'
import { vtLog } from '../log'
import { ENV } from '../config'
import type { Message } from '../types'

export async function analyzeImageWithGPT4V(
  photo: PhotoData,
  recordEvent?: (stage: string, detail?: any, error?: string) => void
): Promise<string> {
  recordEvent?.('openai_request_init')
  const base64Image = photo.buffer.toString('base64')
  const imageUrl = `data:${photo.mimeType};base64,${base64Image}`

  const messages: Message[] = [
    {
      role: 'system',
      content:
        'You are VisionTalk, an AI assistant that helps people understand what they\'re looking at through smart glasses. ' +
        'When shown an image, provide a clear, helpful explanation of what you see. ' +
        'Focus on being informative and conversational. ' +
        "If it's text (like homework, signs, documents), read and explain it. " +
        "If it's an object or scene, describe it and provide relevant context or advice. " +
        "If it's something technical, explain how it works or how to use it. " +
        'For mathematical problems, provide step-by-step solutions with clear reasoning. ' +
        'For complex proofs, break them down into logical steps and explain the methodology. ' +
        'Keep responses thorough but conversational - aim for 60-120 seconds of speaking time for complex topics. ' +
        'Be friendly and educational.'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: "What do you see in this image? Please analyze it and explain what's happening, what it means, or how I might use this information." },
        { type: 'image_url', image_url: { url: imageUrl } }
      ] as any
    }
  ]

  const payload = { model: 'gpt-4o', messages, max_tokens: 600, temperature: 0.7 }

  vtLog('debug', '[GPT-4V] Sending image analysis request')
  recordEvent?.('openai_request_sent')
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
  const analysis = json.choices?.[0]?.message?.content?.trim()
  if (!analysis) {
    recordEvent?.('openai_empty_response')
    throw new Error('No analysis received from GPT-4V')
  }
  vtLog('debug', `[GPT-4V] Analysis complete: ${analysis.substring(0, 100)}...`)
  // Record both an excerpt (for compact timeline) and length metadata.
  recordEvent?.('openai_response_ok', { excerpt: analysis.substring(0, 160), length: analysis.length })
  return analysis
}
