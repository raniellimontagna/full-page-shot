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

  // Clamp canvas width to maxDimension; a narrowed capture is a truncated one.
  let canvasWidth = Math.round(widthCss * dpr)
  if (canvasWidth > CANVAS_LIMITS.maxDimension) {
    canvasWidth = CANVAS_LIMITS.maxDimension
    truncated = true
  }

  // Derive the height ceiling from the *clamped* canvas width, not the raw
  // CSS width or unclamped device-pixel width: this ensures the area guard
  // is computed against a width the canvas will actually have.
  const maxHeightByDimension = CANVAS_LIMITS.maxDimension / dpr
  const maxHeightByArea = CANVAS_LIMITS.maxArea / (canvasWidth * dpr)
  const maxHeightCss = Math.max(1, Math.floor(Math.min(maxHeightByDimension, maxHeightByArea)))

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
