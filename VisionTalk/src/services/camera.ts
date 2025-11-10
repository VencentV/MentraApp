import type { AppSession, PhotoData } from '@mentra/sdk'
import { vtLog } from '../log'

export async function requestPhotoWithTimeout(
  session: AppSession,
  timeoutMs: number,
  recordEvent: (stage: string, detail?: any, error?: string) => void
): Promise<PhotoData> {
  recordEvent('photo_request_start', { timeoutMs })
  let timeoutHandle: NodeJS.Timeout | null = null
  try {
    const photo = await Promise.race([
      session.camera.requestPhoto(),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('photo_request_timeout')), timeoutMs)
      })
    ])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    recordEvent('photo_request_ok')
    return photo as PhotoData
  } catch (err: any) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const msg = err?.message || String(err)
    recordEvent('photo_request_error', {}, msg)
    vtLog('warn', 'Photo request failed', { error: msg })
    if (msg === 'photo_request_timeout') {
      recordEvent('photo_request_retry', { attempt: 1 })
      try {
        const retryPhoto = await Promise.race([
          session.camera.requestPhoto(),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('photo_request_timeout_retry')), Math.max(5000, timeoutMs / 2)))
        ])
        recordEvent('photo_request_ok_retry')
        return retryPhoto as PhotoData
      } catch (retryErr: any) {
        const rmsg = retryErr?.message || String(retryErr)
        recordEvent('photo_request_error_retry', {}, rmsg)
        vtLog('error', 'Photo request retry failed', { error: rmsg })
        throw retryErr
      }
    }
    throw err
  }
}
