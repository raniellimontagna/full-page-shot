import { describe, expect, it } from 'vitest'
import { MIN_SELECTION_PX } from '../../src/shared/selection'

describe('MIN_SELECTION_PX', () => {
  it('is a small, non-zero CSS px threshold', () => {
    expect(MIN_SELECTION_PX).toBe(4)
  })
})
