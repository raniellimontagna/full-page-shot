import { LOSSY_QUALITY, type DownloadFormat, type Scale } from './prefs'

const MIME: Record<DownloadFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

// `.jpg` rather than `.jpeg`: the mime type is `image/jpeg`, but the
// conventional extension users expect on disk is `.jpg`.
const EXTENSION: Record<DownloadFormat, string> = {
  png: '.png',
  jpeg: '.jpg',
  webp: '.webp',
}

export function mimeFor(format: DownloadFormat): string {
  return MIME[format]
}

export function extensionFor(format: DownloadFormat): string {
  return EXTENSION[format]
}

export function isLossy(format: DownloadFormat): boolean {
  return format !== 'png'
}

export interface EncodePlanInput {
  scale: Scale
  devicePixelRatio: number
  format: DownloadFormat
  width: number
  height: number
}

export interface EncodePlan {
  mime: string
  /** Absent for lossless formats: `convertToBlob` must not be given one. */
  quality?: number
  targetWidth: number
  targetHeight: number
}

/**
 * The whole scale/format decision, as arithmetic on plain numbers.
 *
 * The canvas is always stitched in *device* pixels, so on a hidpi screen it
 * already is a 2x image. "2x" therefore means "ship the canvas as it is", and
 * "1x" means "divide it back down by the device pixel ratio" — which is a
 * no-op on an ordinary 1x screen. Scaling happens exactly once, here, on the
 * finished canvas; the stitching arithmetic is never told about it.
 */
export function planEncode({
  scale,
  devicePixelRatio,
  format,
  width,
  height,
}: EncodePlanInput): EncodePlan {
  // A ratio of 0, NaN or a negative from a hostile/odd sender would otherwise
  // produce a zero-sized or infinite canvas.
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const divisor = scale === 1 ? ratio : 1
  const plan: EncodePlan = {
    mime: mimeFor(format),
    targetWidth: Math.max(1, Math.round(width / divisor)),
    targetHeight: Math.max(1, Math.round(height / divisor)),
  }
  if (isLossy(format)) plan.quality = LOSSY_QUALITY
  return plan
}
