import type { AppSession } from '@mentra/sdk'
import { vtLog } from '../log'

type PhotoDetail = {
  buffer: Buffer
  mimeType: string
  size: number
  filename?: string
  // requestId may not be present in SDK response; keep optional
  requestId?: string
  timestamp?: Date
}

type PhotoOptions = {
  attempts?: number
  initialTimeoutMs?: number
  backoffMs?: number
  size?: 'small' | 'medium' | 'large'
}

export async function requestPhotoRobust(
  session: AppSession,
  recordEvent?: (stage: string, detail?: any, error?: string) => void,
  options: PhotoOptions = {}
): Promise<PhotoDetail> {
  const attempts = options.attempts ?? 3
  const timeoutMs = options.initialTimeoutMs ?? 15000
  const backoffMs = options.backoffMs ?? 750
  const size = options.size ?? 'medium'

  if (!session.capabilities?.hasCamera) {
    vtLog('error', 'Camera not available on device')
    recordEvent?.('camera_not_available')
    throw new Error('camera_not_available')
  }

  let lastErr: any
  for (let i = 0; i < attempts; i++) {
    recordEvent?.('photo_request_attempt', { attempt: i + 1, size })
    vtLog('debug', `requestPhoto options: ${JSON.stringify({ size })}`)
    try {
      const photo = await withTimeout(session.camera.requestPhoto({ size }) as any, timeoutMs)
      if (!photo?.buffer || photo.buffer.length === 0) {
        throw new Error('empty_photo_buffer')
      }
      const detail: PhotoDetail = {
        buffer: photo.buffer,
        mimeType: photo.mimeType || 'image/jpeg',
        size: photo.size ?? photo.buffer.length,
        filename: photo.filename,
        requestId: (photo as any).requestId,
        timestamp: new Date()
      }
      recordEvent?.('photo_request_success', { attempt: i + 1, size: detail.size, mimeType: detail.mimeType })
      return detail
    } catch (err: any) {
      lastErr = err
      const msg = err?.message || String(err)
      vtLog('warn', 'Photo request attempt failed', { attempt: i + 1, error: msg })
      recordEvent?.('photo_request_attempt_failed', { attempt: i + 1 }, msg)

      if (msg.includes('permission') || msg.includes('not_available')) break
      if (i < attempts - 1) {
        await sleep(backoffMs * (i + 1))
      }
    }
  }

  recordEvent?.('photo_request_failed_all_attempts', {}, lastErr?.message)
  throw lastErr || new Error('photo_request_failed_all_attempts')
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let to: NodeJS.Timeout
  return await Promise.race<T>([
    p,
    new Promise<T>((_, reject) => {
      to = setTimeout(() => reject(new Error('photo_request_timeout')), ms)
    })
  ]).finally(() => clearTimeout(to!))
}

function sleep(ms: number) {
  return new Promise<void>(res => setTimeout(res, ms))
}
