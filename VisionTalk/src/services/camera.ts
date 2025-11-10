import type { AppSession, PhotoData } from '@mentra/sdk'
import { vtLog } from '../log'

export async function requestPhotoWithTimeout(
  session: AppSession,
  timeoutMs: number,
  recordEvent?: (stage: string, detail?: any, error?: string) => void,
  size: 'small' | 'medium' | 'large' = 'medium'
): Promise<PhotoData> {
  recordEvent?.('photo_request_start', { timeoutMs, size })
  let timeoutHandle: NodeJS.Timeout | null = null
  try {
    const photo = await Promise.race([
      session.camera.requestPhoto({ size }),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('photo_request_timeout')), timeoutMs)
      })
    ])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    recordEvent?.('photo_request_ok')
    return photo as PhotoData
  } catch (err: any) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const msg = err?.message || String(err)
    recordEvent?.('photo_request_error', {}, msg)
    vtLog('warn', 'Photo request failed', { error: msg })
    throw err
  }
}

export type PhotoOptions = {
  attempts?: number
  initialTimeoutMs?: number
  backoffMs?: number
  size?: 'small' | 'medium' | 'large'
}

export async function requestPhotoRobust(
  session: AppSession,
  recordEvent?: (stage: string, detail?: any, error?: string) => void,
  options: PhotoOptions = {}
): Promise<PhotoData> {
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
    try {
      recordEvent?.('photo_request_attempt', { attempt: i + 1, size })
      vtLog('debug', `requestPhoto options: ${JSON.stringify({ size })}`)
      const photo = await requestPhotoWithTimeout(session, timeoutMs, recordEvent, size)
      recordEvent?.('photo_request_success', { attempt: i + 1, requestId: (photo as any).requestId })
      return photo
    } catch (err: any) {
      lastErr = err
      const msg = err?.message || String(err)
      recordEvent?.('photo_request_attempt_failed', { attempt: i + 1 }, msg)
      vtLog('warn', 'Photo request attempt failed', { attempt: i + 1, error: msg })
      if (msg.includes('permission') || msg.includes('not_available')) break
      if (i < attempts - 1) await sleep(backoffMs * (i + 1))
    }
  }
  recordEvent?.('photo_request_failed_all_attempts', {}, lastErr?.message)
  throw lastErr || new Error('photo_request_failed_all_attempts')
}

function sleep(ms: number) {
  return new Promise<void>(res => setTimeout(res, ms))
}
