import type { PageMeasurements } from '../core/types'

/** Milliseconds to wait after painting, for lazy-loaded content to swap in. */
export const SETTLE_DELAY_MS = 120

/**
 * Measures the page for the planner.
 *
 * The viewport comes from `visualViewport`, not `innerWidth`/`innerHeight`,
 * and that is a bug fix rather than a preference. Chrome rounds `innerHeight`
 * to an integer: on a 1280x900 window at devicePixelRatio 1.25 it reports 814
 * where the true CSS height is 813.6. The planner then sizes frames at
 * `round(814 * 1.25) = 1018` device pixels while `captureVisibleTab` really
 * returns 1017, so `drawImage` clamps every frame one row short of its slot
 * and the stitched PNG ships with transparent rows -- including along its
 * bottom edge. `round(813.6 * 1.25)` is exactly the 1017 Chrome produces.
 * Measured, not deduced: see `e2e/fractional-dpi.spec.ts`.
 *
 * `innerWidth`/`innerHeight` remain the fallback for any context without a
 * `visualViewport` (and they are what the integer case reports anyway).
 * `visualViewport` can also read *smaller* than the layout viewport -- it
 * excludes scrollbars, and it shrinks under pinch zoom -- which is the safe
 * direction: an underestimated frame height makes consecutive frames overlap
 * slightly, where an overestimated one leaves holes that nothing downstream
 * can fill.
 */
export function measurePage(win: Window): PageMeasurements {
  const doc = win.document.documentElement
  const visual = win.visualViewport
  return {
    scrollWidth: doc.scrollWidth,
    scrollHeight: doc.scrollHeight,
    viewportWidth: visual?.width ?? win.innerWidth,
    viewportHeight: visual?.height ?? win.innerHeight,
    devicePixelRatio: win.devicePixelRatio,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
  }
}

function nextFrame(win: Window): Promise<void> {
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()))
}

export async function scrollToStep(win: Window, y: number): Promise<void> {
  win.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior })
  await nextFrame(win)
  await nextFrame(win)
  await new Promise<void>((resolve) => win.setTimeout(resolve, SETTLE_DELAY_MS))
}
