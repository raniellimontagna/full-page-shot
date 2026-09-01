import type { CapturePlan, CaptureStep, PageMeasurements } from './types'

/**
 * Chrome's 2D canvas ceilings. Exceeding either one yields a blank canvas
 * with no error, so the plan has to clamp before a single frame is captured.
 */
export const CANVAS_LIMITS = {
  maxDimension: 65_535,
  maxArea: 268_435_456,
} as const

export function planCapture(m: PageMeasurements): CapturePlan {
  const dpr = m.devicePixelRatio
  const widthCss = m.viewportWidth
  let heightCss = m.scrollHeight
  let truncated = false

  // Derive the height ceiling from the *rounded* canvas width, not the raw
  // CSS width: rounding up a fractional width would otherwise push the final
  // area back over the limit.
  const canvasWidth = Math.round(widthCss * dpr)
  const maxHeightByDimension = CANVAS_LIMITS.maxDimension / dpr
  const maxHeightByArea = CANVAS_LIMITS.maxArea / (canvasWidth * dpr)
  const maxHeightCss = Math.floor(Math.min(maxHeightByDimension, maxHeightByArea))

  if (heightCss > maxHeightCss) {
    heightCss = maxHeightCss
    truncated = true
  }

  const stepCount = Math.max(1, Math.ceil(heightCss / m.viewportHeight))
  const lastScrollY = Math.max(0, heightCss - m.viewportHeight)

  const steps: CaptureStep[] = []
  for (let index = 0; index < stepCount; index += 1) {
    steps.push({ index, scrollY: Math.min(index * m.viewportHeight, lastScrollY) })
  }

  return {
    steps,
    canvasWidth,
    canvasHeight: Math.round(heightCss * dpr),
    truncated,
  }
}
