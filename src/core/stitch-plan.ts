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

  // sourceHeight must be derived from where the NEXT frame actually lands, not
  // from a constant frameHeight. With a fractional devicePixelRatio (1.25, 1.5,
  // 1.75 — common on Windows and ChromeOS), round(scrollY * dpr) does not
  // advance by round(viewportHeight * dpr) each step, and the drift leaves
  // uncovered rows.
  return plan.steps.map((step, i) => {
    const destY = Math.round(step.scrollY * dpr)
    const next = plan.steps[i + 1]
    const nextDestY = next ? Math.round(next.scrollY * dpr) : plan.canvasHeight
    // sourceHeight is the distance to the next frame or canvas end, not capped by frameHeight.
    // With fractional DPR, frames can overlap and this distance may exceed frameHeight.
    const sourceHeight = Math.max(0, Math.min(nextDestY, plan.canvasHeight) - destY)
    return { index: step.index, destY, sourceHeight }
  })
}
