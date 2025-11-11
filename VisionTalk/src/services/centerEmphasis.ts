import { ENV } from '../config'

export async function applyCenterEmphasis(buffer: Buffer): Promise<Buffer> {
  if (!ENV.PHOTO_CENTER_EMPHASIS) return buffer
  let sharpLib: any
  try { sharpLib = require('sharp') } catch { return buffer }
  const base = sharpLib(buffer).rotate()
  const meta = await base.metadata()
  const w = meta.width || 0
  const h = meta.height || 0
  if (!w || !h) return buffer

  const sigma = ENV.PHOTO_SHARPEN_SIGMA || 0.8
  const enhanced = await base.clone().sharpen({ sigma }).toBuffer()

  // Build a radial alpha mask (opaque center -> transparent edges for overlaying enhanced)
  const cx = w / 2, cy = h / 2
  const maxR = Math.min(w, h) / 2
  const startFrac = ENV.PHOTO_VIGNETTE_START || 0.55 // where emphasis begins
  const strength = ENV.PHOTO_VIGNETTE_STRENGTH || 0.35 // 0..1
  const startR = maxR * startFrac
  const bytes = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      const dy = y - cy
      const r = Math.sqrt(dx*dx + dy*dy)
      let a = 0
      if (r <= startR) {
        a = 255 * strength
      } else {
        const t = Math.min(1, (maxR - r) / Math.max(1, maxR - startR))
        a = 255 * strength * Math.max(0, t)
      }
      const idx = (y*w + x) * 4
      // Put the enhanced image later; for now mask is just alpha channel placeholder
      // We'll composite by using enhanced as layer with this alpha
      bytes[idx] = 255 // dummy color (will be replaced)
      bytes[idx+1] = 255
      bytes[idx+2] = 255
      bytes[idx+3] = a
    }
  }
  const mask = sharpLib(Buffer.from(bytes), { raw: { width: w, height: h, channels: 4 }})
  // Prepare enhanced RGBA and set its alpha from mask
  let enh = sharpLib(enhanced)
  const enhMeta = await enh.metadata()
  if ((enhMeta.channels || 3) < 4) enh = enh.ensureAlpha(1)
  const maskA = await mask.extractChannel(3).toBuffer()
  // Replace alpha channel: remove existing alpha then join mask as alpha
  const enhNoA = await enh.removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const enhRaw = enhNoA.data
  const channels = 3
  const withA = new Uint8ClampedArray((enhRaw.length / channels) * 4)
  for (let i = 0, j = 0; i < enhRaw.length; i += channels, j += 4) {
    withA[j] = enhRaw[i]
    withA[j+1] = enhRaw[i+1]
    withA[j+2] = enhRaw[i+2]
    withA[j+3] = maskA[j/4] // alpha from mask
  }
  const enhRgba = sharpLib(Buffer.from(withA), { raw: { width: w, height: h, channels: 4 }})

  // Composite: place enhanced over base using center-weighted alpha
  const out = await base.composite([{ input: await enhRgba.png().toBuffer(), blend: 'over' }]).toBuffer()
  return out
}
