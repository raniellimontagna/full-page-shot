import type { CapturePlan, PageMeasurements } from './types'

export interface FramePlacement {
  index: number
  /** Y offset on the destination canvas, in device pixels. */
  destY: number
  /** How many device-pixel rows of the frame to draw. */
  sourceHeight: number
}

// Assumption: when planCapture clamps canvasWidth below the captured frame width,
// frames are wider than the canvas. This module emits no destX/sourceWidth because
// canvas drawImage clips horizontal overflow at the destination bounds (Task 6).

/**
 * Lays the captured frames out on the destination canvas.
 *
 * Units: `step.scrollY` arrives in CSS pixels (what window.scrollTo takes), while
 * `destY` and `sourceHeight` are emitted in device pixels (what captureVisibleTab
 * returns and what the canvas is sized in).
 *
 * The grid is deliberately uniform: frame `i` sits at exactly `i * frameHeight`,
 * never at `round(scrollY * dpr)`. Rounding each position independently is the bug
 * this replaces. With a fractional devicePixelRatio (1.25, 1.5, 1.75 — standard
 * Windows and ChromeOS scale factors), independently rounded positions do not advance
 * by frameHeight per step, so consecutive frames drift apart and leave uncovered
 * device-pixel rows. Worse, the drift cannot be papered over by widening sourceHeight:
 * a frame's bitmap is only frameHeight tall, so drawImage clamps sourceHeight back down
 * to frameHeight and the gap reopens downstream.
 *
 * Only the final frame is positioned by subtraction — `canvasHeight - frameHeight` —
 * so it lands flush with the canvas bottom. That is what absorbs the last capture
 * step being clamped to the page bottom (planCapture caps the final scrollY at
 * `heightCss - viewportHeight`, so the last frame overlaps its predecessor and repaints
 * the shared band with identical pixels).
 *
 * This is only sound because planCapture caps canvasHeight at `stepCount * frameHeight`;
 * the two modules have to stay in step. Do not "simplify" either side back into
 * independent rounding — see the worked counterexample in page-metrics.ts.
 */
export function computeFramePlacements(
  plan: CapturePlan,
  m: PageMeasurements,
): FramePlacement[] {
  const dpr = m.devicePixelRatio
  const frameHeight = Math.round(m.viewportHeight * dpr)

  const last = plan.steps.length - 1
  const destYs = plan.steps.map((_, i) =>
    i === last ? Math.max(0, plan.canvasHeight - frameHeight) : i * frameHeight,
  )

  return plan.steps.map((step, i) => {
    const destY = destYs[i] ?? 0
    const nextDestY = destYs[i + 1] ?? plan.canvasHeight
    const span = Math.min(nextDestY, plan.canvasHeight) - destY
    const sourceHeight = Math.max(0, Math.min(frameHeight, span))
    return { index: step.index, destY, sourceHeight }
  })
}
