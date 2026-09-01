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

export function computeFramePlacements(
  plan: CapturePlan,
  m: PageMeasurements,
): FramePlacement[] {
  const dpr = m.devicePixelRatio
  const frameHeight = Math.round(m.viewportHeight * dpr)

  // Clamp each destY against the previous frame's reach. With fractional devicePixelRatio
  // (1.25, 1.5, 1.75 — common on Windows and ChromeOS), Math.round(scrollY * dpr) does
  // not advance by frameHeight each step. Independently rounded values can leave gaps
  // between frames (e.g., frame 1 reaches row 2002, frame 2 starts at row 2003).
  //
  // We couple the clamping: each destY is clamped to not exceed prev + frameHeight, so
  // sourceHeight will naturally fit within frameHeight. This is critical because Task 6's
  // drawImage will clamp sourceHeight by the actual bitmap.height (which is frameHeight).
  // If sourceHeight > frameHeight and we cap it downstream, the gap reopens. Preventing
  // sourceHeight > frameHeight in the first place (via coupled destY clamping) keeps that
  // clamp from creating gaps: the actual painted height will always be contiguous.
  const destYs: number[] = []
  for (const [i, step] of plan.steps.entries()) {
    const raw = Math.round(step.scrollY * dpr)
    const prev = destYs[i - 1]
    destYs.push(prev === undefined ? raw : Math.min(raw, prev + frameHeight))
  }

  return plan.steps.map((step, i) => {
    const destY = destYs[i] ?? 0
    const nextDestY = destYs[i + 1] ?? plan.canvasHeight
    const span = Math.min(nextDestY, plan.canvasHeight) - destY
    const sourceHeight = Math.max(0, Math.min(frameHeight, span))
    return { index: step.index, destY, sourceHeight }
  })
}
