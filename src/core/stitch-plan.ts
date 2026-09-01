import type { CapturePlan, PageMeasurements } from './types'

export interface FramePlacement {
  index: number
  /** Y offset on the destination canvas, in device pixels. */
  destY: number
  /** How many device-pixel rows of the frame to draw. */
  sourceHeight: number
}

export function computeFramePlacements(
  plan: CapturePlan,
  m: PageMeasurements,
): FramePlacement[] {
  const dpr = m.devicePixelRatio
  const frameHeight = Math.round(m.viewportHeight * dpr)

  return plan.steps.map((step) => {
    const destY = Math.round(step.scrollY * dpr)
    const sourceHeight = Math.min(frameHeight, plan.canvasHeight - destY)
    return { index: step.index, destY, sourceHeight }
  })
}
