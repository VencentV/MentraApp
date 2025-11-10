import crypto from 'crypto'
import type { PhotoData } from '@mentra/sdk'
import { StoredPhoto, UserState } from '../types'

export function cachePhoto(photo: PhotoData, userId: string, userState: UserState): StoredPhoto {
  const sha256 = crypto.createHash('sha256').update(photo.buffer).digest('hex')
  const stored: StoredPhoto = {
    requestId: photo.requestId,
    buffer: photo.buffer,
    timestamp: photo.timestamp,
    userId,
    mimeType: photo.mimeType,
    filename: photo.filename,
    size: photo.size,
    sha256,
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
