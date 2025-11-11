import type { PhotoData } from '@mentra/sdk'
import { ENV } from '../config'

// Minimalist: preserve color, only optional center crop.
export async function produceCenterCrop(photo: PhotoData, recordEvent?: (stage: string, detail?: any, error?: string) => void): Promise<{ buffer: Buffer; steps: string[]; mime: string }> {
  const steps: string[] = []
  let sharpLib: any
  try { sharpLib = require('sharp') } catch { return { buffer: photo.buffer as Buffer, steps: ['sharp_missing'], mime: photo.mimeType } }
  let img = sharpLib(photo.buffer).rotate() // EXIF safe
  const meta = await img.metadata().catch(() => ({}))
  const width = meta.width || 0
  const height = meta.height || 0
  if (ENV.PHOTO_CENTER_CROP && width && height) {
    const f = ENV.PHOTO_CENTER_CROP_FACTOR || 0.6
    const side = Math.floor(Math.min(width, height) * f)
    const left = Math.max(0, Math.floor((width - side) / 2))
    const top = Math.max(0, Math.floor((height - side) / 2))
    try {
      img = img.extract({ left, top, width: side, height: side })
      steps.push(`center_crop_${left}_${top}_${side}x${side}`)
      recordEvent?.('photo_center_crop_applied', { left, top, width: side, height: side, factor: f })
    } catch (err: any) {
      recordEvent?.('photo_center_crop_error', {}, err?.message || String(err))
    }
  } else {
    recordEvent?.('photo_center_crop_skipped', { reason: 'disabled_or_no_meta' })
  }
  // Preserve original format when possible
  let out: Buffer
  try { out = await img.toBuffer() } catch { out = photo.buffer as Buffer }
  return { buffer: out, steps, mime: photo.mimeType }
}
