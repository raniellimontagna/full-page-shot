import { describe, expect, it } from 'vitest'
import { planCapture } from '../../src/core/page-metrics'
import { computeFramePlacements } from '../../src/core/stitch-plan'
import type { CapturePlan, PageMeasurements } from '../../src/core/types'

const base: PageMeasurements = {
  scrollWidth: 1200,
  scrollHeight: 2000,
  viewportWidth: 1200,
  viewportHeight: 800,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
}

describe('computeFramePlacements', () => {
  it('places each frame at its scroll offset in device pixels', () => {
    const m = { ...base, scrollHeight: 2400 }
    const placements = computeFramePlacements(planCapture(m), m)
    expect(placements.map((p) => p.destY)).toEqual([0, 800, 1600])
  })

  it('overlaps the clamped final frame instead of leaving a gap', () => {
    const placements = computeFramePlacements(planCapture(base), base)
    expect(placements.map((p) => p.destY)).toEqual([0, 800, 1200])
  })

  it('covers every row of the canvas with no gap', () => {
    const plan = planCapture(base)
    const placements = computeFramePlacements(plan, base)
    const covered = new Set<number>()
    for (const p of placements) {
      for (let y = p.destY; y < p.destY + p.sourceHeight; y += 1) covered.add(y)
    }
    for (let y = 0; y < plan.canvasHeight; y += 1) {
      expect(covered.has(y), `row ${y} uncovered`).toBe(true)
    }
  })

  it('scales placements by devicePixelRatio', () => {
    const m = { ...base, scrollHeight: 2400, devicePixelRatio: 2 }
    const placements = computeFramePlacements(planCapture(m), m)
    expect(placements.map((p) => p.destY)).toEqual([0, 1600, 3200])
    expect(placements[0]?.sourceHeight).toBe(1600)
  })

  it('trims the final frame so nothing is drawn past the canvas', () => {
    const plan = planCapture(base)
    const placements = computeFramePlacements(plan, base)
    for (const p of placements) {
      expect(p.destY + p.sourceHeight).toBeLessThanOrEqual(plan.canvasHeight)
    }
  })

  it('fractional DPR regression: covers every row with dpr=1.25, viewportHeight=801, scrollHeight=2500', () => {
    // This tests the fix for rounding drift accumulation. With fractional DPR,
    // a constant frameHeight does not match the actual distance between destY values,
    // leaving uncovered rows. The fix derives sourceHeight from the next frame's destY.
    const m: PageMeasurements = {
      scrollWidth: 1200,
      scrollHeight: 2500,
      viewportWidth: 1200,
      viewportHeight: 801,
      devicePixelRatio: 1.25,
      scrollX: 0,
      scrollY: 0,
    }
    const plan = planCapture(m)
    const placements = computeFramePlacements(plan, m)
    const covered = new Set<number>()
    for (const p of placements) {
      for (let y = p.destY; y < p.destY + p.sourceHeight; y += 1) covered.add(y)
    }
    for (let y = 0; y < plan.canvasHeight; y += 1) {
      expect(covered.has(y), `row ${y} uncovered at dpr=1.25`).toBe(true)
    }
  })

  it('covers every row across multiple fractional DPR values with non-round viewportHeight', () => {
    const dprValues = [1, 1.25, 1.5, 1.75, 2]
    for (const dpr of dprValues) {
      const m: PageMeasurements = {
        scrollWidth: 1200,
        scrollHeight: 2500,
        viewportWidth: 1200,
        viewportHeight: 801, // Not divisible by common DPR values
        devicePixelRatio: dpr,
        scrollX: 0,
        scrollY: 0,
      }
      const plan = planCapture(m)
      const placements = computeFramePlacements(plan, m)
      const covered = new Set<number>()
      for (const p of placements) {
        for (let y = p.destY; y < p.destY + p.sourceHeight; y += 1) covered.add(y)
        // Verify no negative sourceHeight
        expect(p.sourceHeight).toBeGreaterThanOrEqual(0)
      }
      for (let y = 0; y < plan.canvasHeight; y += 1) {
        expect(covered.has(y), `row ${y} uncovered at dpr=${dpr}`).toBe(true)
      }
    }
  })

  it('never draws past canvasHeight and never produces negative sourceHeight', () => {
    const m: PageMeasurements = {
      scrollWidth: 1200,
      scrollHeight: 2500,
      viewportWidth: 1200,
      viewportHeight: 801,
      devicePixelRatio: 1.25,
      scrollX: 0,
      scrollY: 0,
    }
    const plan = planCapture(m)
    const placements = computeFramePlacements(plan, m)
    for (const p of placements) {
      expect(p.sourceHeight).toBeGreaterThanOrEqual(0)
      expect(p.destY + p.sourceHeight).toBeLessThanOrEqual(plan.canvasHeight)
    }
  })

  it('sourceHeight never exceeds round(viewportHeight * dpr) across fractional DPR values', () => {
    const dprValues = [1, 1.25, 1.5, 1.75, 2]
    for (const dpr of dprValues) {
      const m: PageMeasurements = {
        scrollWidth: 1200,
        scrollHeight: 2500,
        viewportWidth: 1200,
        viewportHeight: 801,
        devicePixelRatio: dpr,
        scrollX: 0,
        scrollY: 0,
      }
      const plan = planCapture(m)
      const placements = computeFramePlacements(plan, m)
      const frameHeight = Math.round(801 * dpr)
      for (const p of placements) {
        expect(p.sourceHeight, `placement at destY=${p.destY} with dpr=${dpr}`).toBeLessThanOrEqual(frameHeight)
      }
    }
  })

  it('covers every row when accounting for drawImage clamp of sourceHeight by bitmap.height', () => {
    // This models Task 6's behavior: drawImage clamps sourceHeight to bitmap.height (frameHeight).
    // Even though placements may report sourceHeight > frameHeight, the actual painted coverage
    // must still be complete when that clamp is applied downstream.
    const m: PageMeasurements = {
      scrollWidth: 1200,
      scrollHeight: 2500,
      viewportWidth: 1200,
      viewportHeight: 801,
      devicePixelRatio: 1.25,
      scrollX: 0,
      scrollY: 0,
    }
    const plan = planCapture(m)
    const placements = computeFramePlacements(plan, m)
    const frameHeight = Math.round(801 * 1.25)
    const covered = new Set<number>()
    for (const p of placements) {
      // Simulate what drawImage does: clamp sourceHeight to the bitmap height
      const actualHeight = Math.min(p.sourceHeight, frameHeight)
      for (let y = p.destY; y < p.destY + actualHeight; y += 1) covered.add(y)
    }
    for (let y = 0; y < plan.canvasHeight; y += 1) {
      expect(covered.has(y), `row ${y} uncovered when accounting for drawImage clamp`).toBe(true)
    }
  })

  // The cross-module invariant is not expressible in the type system, so computeFramePlacements
  // asserts it at runtime. This proves the guard actually fires — an unexercised guard is not
  // a guard. The plan below is hand-built to violate the contract the way a future regression
  // in planCapture would: two frames of 941 device px cannot cover 1883 rows.
  it('throws when canvasHeight exceeds what the frames can physically cover', () => {
    const m: PageMeasurements = {
      scrollWidth: 1200,
      scrollHeight: 1506,
      viewportWidth: 1200,
      viewportHeight: 753,
      devicePixelRatio: 1.25,
      scrollX: 0,
      scrollY: 0,
    }
    const brokenPlan: CapturePlan = {
      steps: [
        { index: 0, scrollY: 0 },
        { index: 1, scrollY: 753 },
      ],
      canvasWidth: 1500,
      // What the old, unclamped round(scrollHeight * dpr) produced. Row 1882 is uncoverable.
      canvasHeight: 1883,
      truncated: false,
    }
    expect(() => computeFramePlacements(brokenPlan, m)).toThrow(
      /canvasHeight 1883 exceeds what 2 frame\(s\) of 941 device px can cover \(1882\)/,
    )
    // The plan planCapture actually produces for these measurements is accepted.
    expect(planCapture(m).canvasHeight).toBe(1882)
    expect(() => computeFramePlacements(planCapture(m), m)).not.toThrow()
  })

  // Property test: the exhaustive sweep that validated the uniform frame grid.
  //
  // For every (dpr, viewportHeight, scrollHeight) combination, walk the plan the way
  // Task 6 actually paints it — each frame contributes Math.min(sourceHeight, frameHeight)
  // rows starting at destY, because drawImage cannot read more rows than the bitmap has —
  // and assert the canvas ends up fully covered with nothing spilling past it.
  //
  // This fails against independently rounded destY values (round(scrollY * dpr)) and
  // against an unclamped canvasHeight (round(scrollHeight * dpr)); it is the regression
  // guard for both modules at once.
  it('property: every canvas row is covered across the dpr/viewport/scroll grid', () => {
    const dprValues = [1, 1.25, 1.33, 1.5, 1.75, 2, 2.5, 3]
    const viewportHeights = [400, 720, 753, 800, 801, 823, 1080]

    const failures: string[] = []
    let checked = 0
    let maxInteriorDrift = 0

    for (const dpr of dprValues) {
      for (const viewportHeight of viewportHeights) {
        for (let scrollHeight = 200; scrollHeight <= 6000; scrollHeight += 3) {
          checked += 1
          const m: PageMeasurements = {
            scrollWidth: 1200,
            scrollHeight,
            viewportWidth: 1200,
            viewportHeight,
            devicePixelRatio: dpr,
            scrollX: 0,
            scrollY: 0,
          }
          const plan = planCapture(m)
          const placements = computeFramePlacements(plan, m)
          const frameHeight = Math.round(viewportHeight * dpr)
          const where = `dpr=${dpr}, viewportHeight=${viewportHeight}, scrollHeight=${scrollHeight}`

          for (const [i, p] of placements.entries()) {
            // The final frame is anchored to the canvas bottom, so it is exempt by design.
            if (i === placements.length - 1) continue
            const trueDestY = Math.round((plan.steps[i]?.scrollY ?? 0) * dpr)
            maxInteriorDrift = Math.max(maxInteriorDrift, Math.abs(p.destY - trueDestY))
          }

          const covered = new Uint8Array(plan.canvasHeight)
          for (const p of placements) {
            if (p.sourceHeight > frameHeight) {
              failures.push(`${where}: sourceHeight ${p.sourceHeight} exceeds frameHeight ${frameHeight}`)
            }
            if (p.sourceHeight < 0) {
              failures.push(`${where}: negative sourceHeight ${p.sourceHeight}`)
            }
            if (p.destY < 0) {
              failures.push(`${where}: negative destY ${p.destY}`)
            }
            // drawImage can only read as many rows as the frame bitmap holds.
            const painted = Math.min(p.sourceHeight, frameHeight)
            if (p.destY + painted > plan.canvasHeight) {
              failures.push(
                `${where}: frame ${p.index} paints to row ${p.destY + painted} past canvasHeight ${plan.canvasHeight}`,
              )
            }
            for (let y = p.destY; y < Math.min(p.destY + painted, plan.canvasHeight); y += 1) {
              covered[y] = 1
            }
          }

          for (let y = 0; y < plan.canvasHeight; y += 1) {
            if (!covered[y]) {
              failures.push(`${where}: first uncovered row ${y} of canvasHeight ${plan.canvasHeight}`)
              break // one report per combination is enough to identify it
            }
          }
        }
      }
    }

    expect(checked).toBe(108_304)
    expect(
      failures,
      `${failures.length} failing combination(s):\n${failures.slice(0, 20).join('\n')}`,
    ).toEqual([])

    // Drift bound, measured — not chosen. Over this grid the worst interior frame sits
    // 3 device px from its true position (dpr 1.33, viewportHeight 720, scrollHeight 5762,
    // frame 7 of 9). Pages here top out at 6000 CSS px; the long-page bound is asserted
    // separately below. Locked so a change that makes seams materially worse fails loudly.
    expect(maxInteriorDrift, `interior drift grew to ${maxInteriorDrift} device px`).toBeLessThanOrEqual(3)
  })

  // Frames are an integer round(viewportHeight * dpr) tall, but the page content they show
  // advances by the exact viewportHeight * dpr. The sub-pixel residue accumulates down the
  // uniform grid, so interior seams on a long fractional-dpr page land slightly off their
  // true position. This is accepted (the alternative is uncovered rows — see the coverage
  // property above), but it must not silently get worse, so the magnitude is pinned here.
  //
  // Only destY arithmetic is exercised, no per-row coverage walk, so this can afford much
  // longer pages than the coverage sweep: scrollHeight up to 60,000 CSS px.
  it('property: interior seam drift stays within its measured bound on very long pages', () => {
    const dprValues = [1, 1.25, 1.33, 1.5, 1.75, 2, 2.5, 3]
    const viewportHeights = [400, 720, 753, 800, 801, 823, 1080]

    let maxDrift = 0
    let worst = 'none'
    let checked = 0

    for (const dpr of dprValues) {
      for (const viewportHeight of viewportHeights) {
        for (let scrollHeight = 200; scrollHeight <= 60_000; scrollHeight += 7) {
          checked += 1
          const m: PageMeasurements = {
            scrollWidth: 1200,
            scrollHeight,
            viewportWidth: 1200,
            viewportHeight,
            devicePixelRatio: dpr,
            scrollX: 0,
            scrollY: 0,
          }
          const plan = planCapture(m)
          const placements = computeFramePlacements(plan, m)

          for (const [i, p] of placements.entries()) {
            // The final frame is anchored to the canvas bottom by design, so its offset
            // from the true position is intended, not drift. The page bottom stays exact.
            if (i === placements.length - 1) continue
            const trueDestY = Math.round((plan.steps[i]?.scrollY ?? 0) * dpr)
            const drift = Math.abs(p.destY - trueDestY)
            if (drift > maxDrift) {
              maxDrift = drift
              worst = `dpr=${dpr}, viewportHeight=${viewportHeight}, scrollHeight=${scrollHeight}, frame ${i} of ${placements.length}`
            }
          }
        }
      }
    }

    expect(checked).toBe(478_408)
    // 31 device px (~23 CSS px at dpr 1.33) is what this grid actually produces, at
    // dpr 1.33 / viewportHeight 753 / ~48,200 CSS px, frame 63. It is stable: sweeping the
    // same grid at scrollHeight steps of 7, 13, 31, 61 and 101 all report exactly 31. It is
    // also near the structural ceiling — drift is bounded by
    // (canvas row limit / frameHeight) x the sub-pixel residue, which is under 0.5 per step.
    expect(maxDrift, `worst interior drift ${maxDrift} device px at ${worst}`).toBeLessThanOrEqual(31)
  })
})
