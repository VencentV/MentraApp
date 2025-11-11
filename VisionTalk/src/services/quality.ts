import sharp from 'sharp'

// Compute a simple sharpness score using a 3x3 Laplacian filter and variance of the response.
// Higher values indicate sharper images. Results are roughly 0-~50+ for handheld capture.
export async function computeSharpnessScore(buffer: Buffer): Promise<number> {
  try {
    const img = sharp(buffer)
    // Use grayscale to simplify edge response and avoid channel mixing
    const gray = img.grayscale()
    const kernel = {
      width: 3,
      height: 3,
      // 4-neighbor Laplacian
      kernel: [
        0,  1,  0,
        1, -4,  1,
        0,  1,  0
      ]
    }
    const conv = await gray.convolve(kernel).raw().toBuffer()
    // Values are clamped to 0..255 by sharp after convolution; we can still use variance as a proxy
    let sum = 0
    let sumSq = 0
    const n = conv.length
    for (let i = 0; i < n; i++) {
      const v = conv[i]
      sum += v
      sumSq += v * v
    }
    const mean = sum / n
    const variance = Math.max(0, (sumSq / n) - mean * mean)
    // Normalize to a friendlier scale
    return Math.sqrt(variance)
  } catch {
    return 0
  }
}
