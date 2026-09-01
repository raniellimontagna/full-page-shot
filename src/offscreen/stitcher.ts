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

  toBlob(): Promise<Blob> {
    return this.canvas.convertToBlob({ type: 'image/png' })
  }
}
