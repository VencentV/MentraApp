import type { PhotoData } from '@mentra/sdk'
import { ENV } from '../config'
import { vtLog } from '../log'

// Enhance image for OCR / math clarity. Operations are conservative to avoid artifacts.
// Returns new buffer and list of steps applied.
export async function enhanceForOCR(photo: PhotoData, recordEvent?: (stage: string, detail?: any, error?: string) => void): Promise<{ buffer: Buffer; steps: string[] }> {
  const steps: string[] = []
  recordEvent?.('photo_enhance_start', { requestId: photo.requestId })
  let sharpLib: any
  try {
    sharpLib = require('sharp')
  } catch {
    vtLog('warn', 'sharp not available; skipping enhancement')
    recordEvent?.('photo_enhance_skipped', { reason: 'sharp_missing' })
    return { buffer: photo.buffer as Buffer, steps }
  }

  let img = sharpLib(photo.buffer).rotate() // orient
  const meta = await img.metadata().catch(() => ({}))

  // Read raw buffer (preliminary grayscale) for metrics
  let preBuf: Buffer = await img.clone().removeAlpha().raw().toBuffer({ resolveWithObject: false }).catch(() => photo.buffer as Buffer)
  const width = meta.width || 0
  const height = meta.height || 0
  let brightnessAvg = 0
  let contrastApprox = 0
  if (width && height && preBuf.length >= width * height) {
    // For grayscale or first channel only
    let sum = 0
    let sumSq = 0
    const stride = Math.floor(preBuf.length / (width * height)) || 1
    for (let i = 0, px = 0; px < width * height && i < preBuf.length; px++, i += stride) {
      const v = preBuf[i]
      sum += v
      sumSq += v * v
    }
    const n = width * height
    brightnessAvg = sum / n
    const meanSq = sumSq / n
    contrastApprox = Math.sqrt(Math.max(0, meanSq - brightnessAvg * brightnessAvg))
    recordEvent?.('photo_quality_metrics', { brightnessAvg: Number(brightnessAvg.toFixed(1)), contrastApprox: Number(contrastApprox.toFixed(1)), width, height })
    steps.push(`metrics_b${brightnessAvg.toFixed(0)}_c${contrastApprox.toFixed(0)}`)
  }

  // Conditional upscale if width small
  if (width && width < 900) {
    img = img.resize(900, null, { kernel: 'lanczos3' })
    steps.push(`resize_${width}_to_900`)
    recordEvent?.('photo_enhance_step', { step: 'resize', from: width, to: 900 })
  }

  img = img.grayscale()
  steps.push('grayscale')
  recordEvent?.('photo_enhance_step', { step: 'grayscale' })

  // Adaptive normalization: only if contrast low (<45)
  if (contrastApprox < 45) {
    try {
      img = img.normalize()
      steps.push('normalize')
      recordEvent?.('photo_enhance_step', { step: 'normalize', contrastApprox })
    } catch {}
  }

  // Adaptive gamma: dim brightnessAvg < 120 -> boost
  if (brightnessAvg < 120) {
    img = img.gamma(1.25)
    steps.push('gamma_1.25')
    recordEvent?.('photo_enhance_step', { step: 'gamma', value: 1.25 })
  } else {
    img = img.gamma(1.1)
    steps.push('gamma_1.1')
    recordEvent?.('photo_enhance_step', { step: 'gamma', value: 1.1 })
  }

  // Sharpen more aggressively if contrast still low
  if (contrastApprox < 35) {
    img = img.sharpen({ sigma: 1 })
    steps.push('sharpen_sigma1')
    recordEvent?.('photo_enhance_step', { step: 'sharpen', mode: 'sigma1' })
  } else {
    img = img.sharpen()
    steps.push('sharpen_default')
    recordEvent?.('photo_enhance_step', { step: 'sharpen', mode: 'default' })
  }

  // Text region crop via projection if enabled
  if (ENV.PHOTO_CROP_TEXT_REGION && width && height) {
    try {
      const gray = await img.clone().raw().toBuffer({ resolveWithObject: false })
      const channels = meta.channels || 1
      const stride = channels
      // Horizontal & vertical projection
      const rowDark: number[] = new Array(height).fill(0)
      const colDark: number[] = new Array(width).fill(0)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * stride
          const v = gray[idx]
          if (v < 200) { // treat <200 as ink-ish
            rowDark[y]++
            colDark[x]++
          }
        }
      }
      const rowThresh = Math.max(2, Math.floor(width * 0.01))
      const colThresh = Math.max(2, Math.floor(height * 0.01))
      let top = 0, bottom = height - 1
      while (top < height && rowDark[top] < rowThresh) top++
      while (bottom > top && rowDark[bottom] < rowThresh) bottom--
      let left = 0, right = width - 1
      while (left < width && colDark[left] < colThresh) left++
      while (right > left && colDark[right] < colThresh) right--
      const cropW = right - left + 1
      const cropH = bottom - top + 1
      const coverage = (cropW * cropH) / (width * height)
      if (coverage > 0.15 && coverage < 0.95) { // avoid over/under cropping extremes
        img = img.extract({ left, top, width: cropW, height: cropH })
        steps.push(`crop_${left}_${top}_${cropW}x${cropH}`)
        recordEvent?.('photo_crop_applied', { left, top, width: cropW, height: cropH, coverage: Number(coverage.toFixed(2)) })
      } else {
        recordEvent?.('photo_crop_skipped', { coverage: Number(coverage.toFixed(2)) })
      }
    } catch (err: any) {
      recordEvent?.('photo_crop_error', {}, err?.message || String(err))
    }
  } else {
    recordEvent?.('photo_crop_skipped', { reason: 'disabled_or_no_meta' })
  }

  img = img.png({ compressionLevel: 9 })
  steps.push('to_png')
  recordEvent?.('photo_enhance_step', { step: 'to_png' })

  let out: Buffer
  try {
    out = await img.toBuffer()
  } catch (err: any) {
    recordEvent?.('photo_enhance_error', {}, err?.message || String(err))
    vtLog('warn', 'Enhancement failed; returning original', { error: String(err) })
    return { buffer: photo.buffer as Buffer, steps }
  }

  recordEvent?.('photo_enhance_done', { requestId: photo.requestId, steps })
  return { buffer: out, steps }
}
