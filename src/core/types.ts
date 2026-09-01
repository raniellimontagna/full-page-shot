export interface PageMeasurements {
  scrollWidth: number
  scrollHeight: number
  viewportWidth: number
  viewportHeight: number
  devicePixelRatio: number
  scrollX: number
  scrollY: number
}

/** scrollY is in CSS pixels — the unit window.scrollTo expects. */
export interface CaptureStep {
  index: number
  scrollY: number
}

/** canvasWidth/canvasHeight are in device pixels — the unit captureVisibleTab returns. */
export interface CapturePlan {
  steps: CaptureStep[]
  canvasWidth: number
  canvasHeight: number
  truncated: boolean
}
