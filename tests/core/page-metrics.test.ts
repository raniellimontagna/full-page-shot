import { describe, expect, it } from 'vitest'
import { CANVAS_LIMITS, planCapture } from '../../src/core/page-metrics'
import type { PageMeasurements } from '../../src/core/types'

const base: PageMeasurements = {
  scrollWidth: 1200,
  scrollHeight: 3000,
  viewportWidth: 1200,
  viewportHeight: 800,
  devicePixelRatio: 1,
  scrollX: 0,
  scrollY: 0,
}

describe('planCapture', () => {
  it('produces a single step when the page fits in the viewport', () => {
    const plan = planCapture({ ...base, scrollHeight: 600 })
    expect(plan.steps).toEqual([{ index: 0, scrollY: 0 }])
    expect(plan.canvasHeight).toBe(600)
  })

  it('produces one step per viewport for an exact multiple', () => {
    const plan = planCapture({ ...base, scrollHeight: 2400 })
    expect(plan.steps.map((s) => s.scrollY)).toEqual([0, 800, 1600])
  })

  it('clamps the final step so it never scrolls past the bottom', () => {
    const plan = planCapture({ ...base, scrollHeight: 2000 })
    // 2000 / 800 => 3 steps; the last one would be 1600 but the page bottoms out at 1200
    expect(plan.steps.map((s) => s.scrollY)).toEqual([0, 800, 1200])
  })

  it('scales the canvas by devicePixelRatio', () => {
    const plan = planCapture({ ...base, scrollHeight: 1600, devicePixelRatio: 2 })
    expect(plan.canvasWidth).toBe(2400)
    expect(plan.canvasHeight).toBe(3200)
  })

  it('truncates a page that exceeds the max canvas dimension', () => {
    const plan = planCapture({ ...base, scrollHeight: CANVAS_LIMITS.maxDimension + 5000 })
    expect(plan.truncated).toBe(true)
    expect(plan.canvasHeight).toBeLessThanOrEqual(CANVAS_LIMITS.maxDimension)
  })

  it('truncates a page that exceeds the max canvas area', () => {
    const wide = Math.floor(CANVAS_LIMITS.maxArea / 10000)
    const plan = planCapture({
      ...base,
      scrollWidth: wide,
      viewportWidth: wide,
      scrollHeight: 20000,
    })
    expect(plan.truncated).toBe(true)
    expect(plan.canvasWidth * plan.canvasHeight).toBeLessThanOrEqual(CANVAS_LIMITS.maxArea)
  })

  it('never emits a step below the truncated height', () => {
    const plan = planCapture({ ...base, scrollHeight: CANVAS_LIMITS.maxDimension + 5000 })
    const maxScroll = Math.max(...plan.steps.map((s) => s.scrollY))
    expect(maxScroll).toBeLessThanOrEqual(plan.canvasHeight / base.devicePixelRatio)
  })
})
