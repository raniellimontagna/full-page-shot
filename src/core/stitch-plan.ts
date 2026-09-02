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
 *
 * Accepted cost: the grid drifts from each frame's true device-pixel position. Frames are
 * an integer `round(vh * dpr)` tall while the page content advances by the exact
 * `vh * dpr`, so the sub-pixel residue accumulates down the page: roughly
 * `0.5 * stepCount` device px, which means it grows as the viewport gets shorter and the
 * page needs more frames. Over the swept range (viewport 400-1080 CSS px, dpr 1 to 3) the
 * worst case measured is 35 device px, at step 70 of a ~51,000 px page at dpr 1.25; a
 * 250 px viewport on the same pages reaches 104. It is not an artefact of this particular
 * grid: a drift-minimising variant that keeps true positions wherever they do not break
 * contiguity was swept over 24,472 combinations and produced the *same* maximum.
 * Removing it would mean drawing frames a fraction taller than the bitmap actually is.
 * The real choice is drift or holes, and holes are worse. The final frame is exempt — it
 * is anchored to the canvas bottom, so the page bottom is always exact. See
 * `docs/superpowers/specs/2026-09-01-full-page-shot-design.md`, "Known limitations".
 */
export function computeFramePlacements(
  plan: CapturePlan,
  m: PageMeasurements,
): FramePlacement[] {
  const dpr = m.devicePixelRatio
  const frameHeight = Math.round(m.viewportHeight * dpr)

  // Defence in depth for the cross-module contract. planCapture owns it: it caps
  // canvasHeight at stepCount * frameHeight precisely so the grid below can cover
  // every row. TypeScript cannot express the invariant, so if someone changes how
  // planCapture derives its step count or its canvas height without re-running the
  // property test, fail loudly here rather than silently emitting a screenshot with
  // uncovered rows at the bottom.
  const reach = plan.steps.length * frameHeight
  if (plan.canvasHeight > reach) {
    throw new Error(
      `computeFramePlacements: canvasHeight ${plan.canvasHeight} exceeds what ` +
        `${plan.steps.length} frame(s) of ${frameHeight} device px can cover (${reach}). ` +
        'planCapture must clamp canvasHeight to stepCount * round(viewportHeight * dpr).',
    )
  }

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
