import { describe, expect, it } from 'vitest'
import { planCapture } from '../../src/core/page-metrics'
import { computeFramePlacements } from '../../src/core/stitch-plan'
import type { PageMeasurements } from '../../src/core/types'

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
})
