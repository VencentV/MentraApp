import crypto from 'crypto'
import type { PhotoData } from '@mentra/sdk'
import { StoredPhoto, UserState } from '../types'

// Lazy load heavy deps only if needed
let sharp: any | null = null
let exifParser: any | null = null

async function ensureDeps() {
  if (!sharp) {
    try { sharp = require('sharp') } catch { /* not installed yet */ }
  }
  if (!exifParser) {
    try { exifParser = require('exif-parser') } catch { /* not installed yet */ }
  }
}

export async function cachePhoto(
  photo: PhotoData,
  userId: string,
  userState: UserState,
  recordEvent?: (stage: string, detail?: any, error?: string) => void
): Promise<StoredPhoto> {
  const sha256 = crypto.createHash('sha256').update(photo.buffer).digest('hex')
  let workingBuffer = photo.buffer as Buffer
  let orientationOriginal: number | undefined
  let rotated = false
  let orientationApplied: string | undefined

  await ensureDeps()
  if (exifParser) {
    try {
      const parser = exifParser.create(workingBuffer)
      const exif = parser.parse()
      orientationOriginal = exif.tags?.Orientation
      if (orientationOriginal) {
        recordEvent?.('photo_orientation_detected', { requestId: photo.requestId, orientation: orientationOriginal })
      }
    } catch (err: any) {
      recordEvent?.('photo_orientation_exif_error', {}, err?.message || String(err))
    }
  }

  // Auto-rotate if sharp present; sharp's rotate() with no args uses EXIF
  if (sharp) {
    try {
      const rotatedImage = await sharp(workingBuffer).rotate().toBuffer()
      // If buffer size differs, assume rotation or other transform happened
      if (rotatedImage.length !== workingBuffer.length) {
        workingBuffer = rotatedImage
        rotated = true
        orientationApplied = 'auto-rotate'
        recordEvent?.('photo_orientation_rotated', { requestId: photo.requestId, original: orientationOriginal })
      } else {
        orientationApplied = 'none'
      }
    } catch (err: any) {
      orientationApplied = 'rotate_failed'
      recordEvent?.('photo_orientation_rotate_error', {}, err?.message || String(err))
    }
  } else {
    orientationApplied = 'sharp_missing'
  }

  const stored: StoredPhoto = {
    requestId: photo.requestId,
    buffer: workingBuffer,
    timestamp: photo.timestamp,
    userId,
    mimeType: photo.mimeType,
    filename: photo.filename,
    size: workingBuffer.length,
    sha256,
    orientationOriginal,
    orientationApplied,
    rotated,
  }
  userState.photoHistory.push(stored)
  // Trim history
  if (userState.photoHistory.length > 10) userState.photoHistory.shift()
  return stored
}

export function getLatestPhoto(userState: UserState): StoredPhoto | undefined {
  const hist = userState.photoHistory
  return hist[hist.length - 1]
}
