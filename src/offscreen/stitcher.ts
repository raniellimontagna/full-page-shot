import { planCrop, type DeviceRect } from '../shared/crop'
import { planEncode } from '../shared/formats'
import type { CssRect } from '../shared/messages'
import type { DownloadFormat, Scale } from '../shared/prefs'

export interface ExportOptions {
  scale: Scale
  devicePixelRatio: number
  format: DownloadFormat
}

/**
 * Owns the offscreen canvas that frames are drawn into.
 *
 * The service worker streams captured frames one at a time (it never holds
 * the whole page in memory), so this class accumulates state across
 * multiple `addFrame` calls rather than taking all frames up front.
 */
export class Stitcher {
  private readonly canvas: OffscreenCanvas
  private readonly context: OffscreenCanvasRenderingContext2D

  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height)
    const context = this.canvas.getContext('2d')
    if (!context) throw new Error('2d context unavailable')
    this.context = context
  }

  async addFrame(dataUrl: string, destY: number, sourceHeight: number): Promise<void> {
    const response = await fetch(dataUrl)
    const bitmap = await createImageBitmap(await response.blob())
    try {
      // `sourceHeight` is guaranteed by core/stitch-plan.ts to never exceed
      // the real captured frame height. The clamp below is defence in
      // depth only — it must not be relied on to reshape this draw call.
      const clampedHeight = Math.min(sourceHeight, bitmap.height)
      this.context.drawImage(
        bitmap,
        0,
        0,
        bitmap.width,
        clampedHeight,
        0,
        destY,
        bitmap.width,
        clampedHeight,
      )
    } finally {
      bitmap.close()
    }
  }

  /** Draws a whole decoded frame at the origin. See `stitcherFromFrame`. */
  drawBitmap(bitmap: ImageBitmap): void {
    this.context.drawImage(bitmap, 0, 0)
  }

  /**
   * Draws only `crop`'s source rect (already device px, already clamped to
   * the frame -- see `planCrop`) from a decoded frame, at the canvas
   * origin. The canvas is expected to already be sized to `crop.width` x
   * `crop.height` (selection mode's whole point: the exported image is just
   * the selected region, not the full frame with the rest discarded).
   */
  drawBitmapCropped(bitmap: ImageBitmap, crop: DeviceRect): void {
    this.context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    )
  }

  /**
   * Encodes the stitched canvas at the requested scale and format.
   *
   * Read-only with respect to the stitched canvas: downscaling draws onto a
   * *new* `OffscreenCanvas` rather than resizing this one, because the same
   * capture is exported more than once — PNG for the clipboard, and possibly a
   * lossy encode for the download — and the second export must see the same
   * pixels as the first.
   */
  async export({ scale, devicePixelRatio, format }: ExportOptions): Promise<Blob> {
    const plan = planEncode({
      scale,
      devicePixelRatio,
      format,
      width: this.canvas.width,
      height: this.canvas.height,
    })

    const source =
      plan.targetWidth === this.canvas.width && plan.targetHeight === this.canvas.height
        ? this.canvas
        : resample(this.canvas, plan.targetWidth, plan.targetHeight)

    // `quality` is deliberately spread rather than passed as `undefined`: some
    // implementations treat an explicit `undefined` quality on a lossless
    // encode as a value to interpret.
    return source.convertToBlob({
      type: plan.mime,
      ...(plan.quality === undefined ? {} : { quality: plan.quality }),
    })
  }

  /** Test/inspection seam: the stitched canvas size in device pixels. */
  get size(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height }
  }
}

/**
 * Decodes a captured frame's data URL into a bitmap.
 *
 * Split out from `stitcherFromFrame` (its only caller, below, in this same
 * file) so the crop path can decode once, read the bitmap's real dimensions
 * to plan the crop (`planCrop` needs the frame size), and draw from that same
 * bitmap -- instead of decoding again through `stitcherFromFrame`, which does
 * not have a way to report the dimensions of a frame it hasn't been asked to
 * draw yet. Not exported: `src/offscreen/index.ts` and everything else goes
 * through `stitcherFromFrame`, which is the one production path from a data
 * URL to a (possibly cropped) `Stitcher`.
 */
async function decodeFrame(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(dataUrl)).blob())
}

/**
 * Builds a Stitcher holding a single already-captured frame.
 *
 * Viewport mode has no plan, no scroll loop and no `beginCapture`: one
 * `captureVisibleTab` is the whole image. It still goes through the same
 * export path so scale and format behave identically in both modes.
 *
 * `crop`, when given, is selection mode's CSS-px rect plus the captured
 * tab's `devicePixelRatio` -- not yet a device-pixel rect. `planCrop` needs
 * the frame's real dimensions to convert and clamp it, which are only known
 * once this function has decoded the frame, so planning happens here rather
 * than in the caller: there is exactly one production path from a data URL
 * to a (possibly cropped) `Stitcher`, decoding exactly once. The bitmap is
 * closed in `finally` on every path, including a `planCrop` throw (an
 * out-of-frame or zero-size selection).
 */
export async function stitcherFromFrame(
  dataUrl: string,
  crop?: { rect: CssRect; devicePixelRatio: number },
): Promise<Stitcher> {
  const bitmap = await decodeFrame(dataUrl)
  try {
    if (crop) {
      const deviceRect = planCrop(crop.rect, crop.devicePixelRatio, {
        width: bitmap.width,
        height: bitmap.height,
      })
      const stitcher = new Stitcher(deviceRect.width, deviceRect.height)
      stitcher.drawBitmapCropped(bitmap, deviceRect)
      return stitcher
    }
    const stitcher = new Stitcher(bitmap.width, bitmap.height)
    stitcher.drawBitmap(bitmap)
    return stitcher
  } finally {
    bitmap.close()
  }
}

function resample(source: OffscreenCanvas, width: number, height: number): OffscreenCanvas {
  const target = new OffscreenCanvas(width, height)
  const context = target.getContext('2d')
  if (!context) throw new Error('2d context unavailable')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, source.width, source.height, 0, 0, width, height)
  return target
}
