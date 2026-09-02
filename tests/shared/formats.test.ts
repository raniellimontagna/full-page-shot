import { describe, expect, it } from 'vitest'

import { extensionFor, isLossy, mimeFor, planEncode } from '../../src/shared/formats'
import { LOSSY_QUALITY, type DownloadFormat } from '../../src/shared/prefs'

// Exhaustive over the union: adding a format without updating the tables here
// (or the tables in formats.ts) fails one of these.
const ALL_FORMATS: DownloadFormat[] = ['png', 'jpeg', 'webp']

describe('mimeFor', () => {
  it('maps every format to its canvas mime type', () => {
    expect(ALL_FORMATS.map(mimeFor)).toEqual(['image/png', 'image/jpeg', 'image/webp'])
  })
})

describe('extensionFor', () => {
  it('maps every format to its file extension', () => {
    expect(ALL_FORMATS.map(extensionFor)).toEqual(['.png', '.jpg', '.webp'])
  })
})

describe('isLossy', () => {
  it('is true for jpeg and webp only', () => {
    expect(ALL_FORMATS.map(isLossy)).toEqual([false, true, true])
  })
})

describe('planEncode', () => {
  it('keeps the canvas size at 2x, whatever the device pixel ratio', () => {
    expect(planEncode({ scale: 2, devicePixelRatio: 2, format: 'png', width: 800, height: 1200 }))
      .toEqual({ mime: 'image/png', targetWidth: 800, targetHeight: 1200 })
  })

  it('downscales by the device pixel ratio at 1x on a hidpi screen', () => {
    expect(planEncode({ scale: 1, devicePixelRatio: 2, format: 'png', width: 800, height: 1200 }))
      .toEqual({ mime: 'image/png', targetWidth: 400, targetHeight: 600 })
  })

  it('rounds the downscaled size and never goes below one pixel', () => {
    expect(planEncode({ scale: 1, devicePixelRatio: 3, format: 'png', width: 801, height: 2 }))
      .toEqual({ mime: 'image/png', targetWidth: 267, targetHeight: 1 })
  })

  it('leaves the size alone at 1x when the screen is not hidpi', () => {
    expect(planEncode({ scale: 1, devicePixelRatio: 1, format: 'png', width: 800, height: 1200 }))
      .toEqual({ mime: 'image/png', targetWidth: 800, targetHeight: 1200 })
  })

  it('carries the fixed quality for lossy formats only', () => {
    expect(
      planEncode({ scale: 2, devicePixelRatio: 1, format: 'jpeg', width: 10, height: 10 }).quality,
    ).toBe(LOSSY_QUALITY)
    expect(
      planEncode({ scale: 2, devicePixelRatio: 1, format: 'webp', width: 10, height: 10 }).quality,
    ).toBe(LOSSY_QUALITY)
    expect(
      planEncode({ scale: 2, devicePixelRatio: 1, format: 'png', width: 10, height: 10 }).quality,
    ).toBeUndefined()
  })

  it('treats a nonsense device pixel ratio as 1', () => {
    expect(planEncode({ scale: 1, devicePixelRatio: 0, format: 'png', width: 800, height: 600 }))
      .toEqual({ mime: 'image/png', targetWidth: 800, targetHeight: 600 })
  })
})
