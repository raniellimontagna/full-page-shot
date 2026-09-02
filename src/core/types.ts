export interface PageMeasurements {
  scrollWidth: number
  scrollHeight: number
  /**
   * CSS pixels, and **not necessarily an integer**. These come from
   * `visualViewport`, which reports the viewport's true fractional size;
   * `window.innerWidth`/`innerHeight` round it, and that rounding is what
   * produced unpainted rows at fractional device pixel ratios. Anything
   * consuming these must be sound for fractional input -- see the property
   * sweeps in `tests/core/stitch-plan.test.ts`.
   */
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
