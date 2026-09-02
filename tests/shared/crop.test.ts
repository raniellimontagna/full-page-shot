import { describe, expect, it } from 'vitest'

import { planCrop } from '../../src/shared/crop'

const FRAME = { width: 1600, height: 1200 }

describe('planCrop', () => {
  it('rounds all four edges at dpr 1 (identity)', () => {
    expect(planCrop({ x: 10, y: 20, width: 100, height: 50 }, 1, FRAME)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    })
  })

  it('rounds all four edges at dpr 1.25', () => {
    // x1 = round(10*1.25)=13, y1=round(20*1.25)=25
    // x2 = round(110*1.25)=138 -> width 125, y2=round(70*1.25)=88 -> height 63
    expect(planCrop({ x: 10, y: 20, width: 100, height: 50 }, 1.25, FRAME)).toEqual({
      x: 13,
      y: 25,
      width: 125,
      height: 63,
    })
  })

  it('rounds all four edges at dpr 1.5', () => {
    // x1=round(10*1.5)=15, x2=round(110*1.5)=165 -> width 150
    // y1=round(20*1.5)=30, y2=round(70*1.5)=105 -> height 75
    expect(planCrop({ x: 10, y: 20, width: 100, height: 50 }, 1.5, FRAME)).toEqual({
      x: 15,
      y: 30,
      width: 150,
      height: 75,
    })
  })

  it('rounds all four edges at dpr 2', () => {
    expect(planCrop({ x: 10, y: 20, width: 100, height: 50 }, 2, FRAME)).toEqual({
      x: 20,
      y: 40,
      width: 200,
      height: 100,
    })
  })

  it('rounds a rect whose edges land on a half-pixel boundary without independent width rounding drift', () => {
    // x=1 -> round(1*1.25)=1 (banker's? no, Math.round(1.25)=1); width from x=1 to x+width=99 -> edges 1 -> round(1.25)=1, x2 = round(99*1.25)=round(123.75)=124
    // Using odd numbers where naive width-rounding would differ from edge-rounding.
    const rect = { x: 3, y: 7, width: 97, height: 41 }
    const dpr = 1.5
    const x1 = Math.round(rect.x * dpr)
    const y1 = Math.round(rect.y * dpr)
    const x2 = Math.round((rect.x + rect.width) * dpr)
    const y2 = Math.round((rect.y + rect.height) * dpr)
    expect(planCrop(rect, dpr, FRAME)).toEqual({
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
    })
  })

  it('produces adjacent device rects with no gap or overlap for two CSS rects sharing a vertical border', () => {
    const dpr = 1.5
    const left = planCrop({ x: 0, y: 0, width: 33, height: 10 }, dpr, FRAME)
    const right = planCrop({ x: 33, y: 0, width: 33, height: 10 }, dpr, FRAME)
    expect(left.x + left.width).toBe(right.x)
  })

  it('produces adjacent device rects with no gap or overlap for two CSS rects sharing a horizontal border', () => {
    const dpr = 1.25
    const top = planCrop({ x: 0, y: 0, width: 10, height: 17 }, dpr, FRAME)
    const bottom = planCrop({ x: 0, y: 17, width: 10, height: 17 }, dpr, FRAME)
    expect(top.y + top.height).toBe(bottom.y)
  })

  it('clamps a rect extending past the right/bottom frame edge', () => {
    expect(planCrop({ x: 1590, y: 1190, width: 50, height: 50 }, 1, FRAME)).toEqual({
      x: 1590,
      y: 1190,
      width: 10,
      height: 10,
    })
  })

  it('clamps a rect extending past the left/top frame edge (negative origin)', () => {
    expect(planCrop({ x: -20, y: -10, width: 40, height: 30 }, 1, FRAME)).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    })
  })

  it('clamps at the frame edge exactly (rect flush with the boundary)', () => {
    expect(planCrop({ x: 0, y: 0, width: FRAME.width, height: FRAME.height }, 1, FRAME)).toEqual({
      x: 0,
      y: 0,
      width: FRAME.width,
      height: FRAME.height,
    })
  })

  it('throws when the rect is entirely outside the frame to the right', () => {
    expect(() => planCrop({ x: 2000, y: 0, width: 50, height: 50 }, 1, FRAME)).toThrow()
  })

  it('throws when the rect is entirely outside the frame to the left', () => {
    expect(() => planCrop({ x: -200, y: 0, width: 50, height: 50 }, 1, FRAME)).toThrow()
  })

  it('throws when the rect is entirely outside the frame above/below', () => {
    expect(() => planCrop({ x: 0, y: -200, width: 50, height: 50 }, 1, FRAME)).toThrow()
    expect(() => planCrop({ x: 0, y: 5000, width: 50, height: 50 }, 1, FRAME)).toThrow()
  })

  it('throws for a zero-width rect', () => {
    expect(() => planCrop({ x: 10, y: 10, width: 0, height: 50 }, 1, FRAME)).toThrow()
  })

  it('throws for a zero-height rect', () => {
    expect(() => planCrop({ x: 10, y: 10, width: 50, height: 0 }, 1, FRAME)).toThrow()
  })

  it('throws with a clear, informative error message', () => {
    expect(() => planCrop({ x: 2000, y: 0, width: 50, height: 50 }, 1, FRAME)).toThrow(/empty/i)
  })
})
