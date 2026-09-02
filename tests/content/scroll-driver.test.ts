import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTLE_DELAY_MS, measurePage, scrollToStep } from '../../src/content/scroll-driver'

const FRAME_DELAY_MS = 16

describe('measurePage', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'visualViewport')
  })

  it('reads dimensions from the document and window', () => {
    document.body.innerHTML = '<div style="height: 3000px"></div>'
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 3000,
      configurable: true,
    })
    const m = measurePage(window)
    expect(m.scrollHeight).toBe(3000)
    expect(m.devicePixelRatio).toBe(window.devicePixelRatio)
  })

  // The fractional-DPI defect in one assertion. Chrome rounds `innerHeight` to
  // 814 where the viewport is really 813.6 CSS px, and at devicePixelRatio 1.25
  // that rounding sizes every frame one device pixel taller than the surface
  // `captureVisibleTab` actually returns -- which ships transparent rows,
  // including along the image's bottom edge. The true value is the one to plan
  // against.
  it('prefers the fractional visual viewport over the rounded window size', () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 1279.2, height: 813.5999755859375 },
    })
    const m = measurePage(window)
    expect(m.viewportHeight).toBe(813.5999755859375)
    expect(m.viewportWidth).toBe(1279.2)
    expect(Math.round(m.viewportHeight * 1.25)).toBe(1017)
    expect(Math.round(window.innerHeight * 1.25)).not.toBe(1017)
  })

  // Not every context has a visual viewport, and where it is missing the
  // rounded window size is both the fallback and what Chrome would have
  // reported anyway.
  it('falls back to the window size where there is no visual viewport', () => {
    expect(window.visualViewport).toBeUndefined()
    const m = measurePage(window)
    expect(m.viewportWidth).toBe(window.innerWidth)
    expect(m.viewportHeight).toBe(window.innerHeight)
  })
})

describe('scrollToStep', () => {
  it('scrolls the window to the requested offset', async () => {
    const scrollTo = vi.fn()
    const win = {
      scrollTo,
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        cb(0)
        return 0
      },
      setTimeout: (cb: () => void) => {
        cb()
        return 0
      },
    } as unknown as Window

    await scrollToStep(win, 1600)
    expect(scrollTo).toHaveBeenCalledWith({ top: 1600, left: 0, behavior: 'instant' })
  })

  it('resolves only after the frames and the settle delay', async () => {
    vi.useFakeTimers()

    // Genuinely asynchronous fakes: each callback fires on a later macrotask
    // (via the real timer queue, which vi.useFakeTimers() now controls)
    // instead of being invoked inline. If `scrollToStep` ever dropped an
    // `await`, the two `requestAnimationFrame` calls would be issued back
    // to back instead of one-after-the-other, and the assertions below
    // (which check `order` and `resolved` after each individual time
    // advance) would observe frames landing together instead of staggered.
    const order: string[] = []
    const win = {
      scrollTo: () => order.push('scroll'),
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        return setTimeout(() => {
          order.push('frame')
          cb(0)
        }, FRAME_DELAY_MS) as unknown as number
      },
      setTimeout: ((cb: () => void, ms?: number) => {
        return setTimeout(() => {
          order.push('settle')
          cb()
        }, ms) as unknown as number
      }) as Window['setTimeout'],
    } as unknown as Window

    let resolved = false
    void scrollToStep(win, 100).then(() => {
      resolved = true
    })

    // scrollTo runs synchronously before the first await; nothing else has
    // had a chance to run yet.
    expect(order).toEqual(['scroll'])
    expect(resolved).toBe(false)

    // First animation frame fires; the second must not have been requested
    // and fired yet — that only happens once the first frame's promise is
    // actually awaited.
    await vi.advanceTimersByTimeAsync(FRAME_DELAY_MS)
    expect(order).toEqual(['scroll', 'frame'])
    expect(resolved).toBe(false)

    // Second animation frame fires.
    await vi.advanceTimersByTimeAsync(FRAME_DELAY_MS)
    expect(order).toEqual(['scroll', 'frame', 'frame'])
    expect(resolved).toBe(false)

    // Work queued after scrollToStep must not have run before the settle
    // delay fully elapses.
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS - 1)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['scroll', 'frame', 'frame', 'settle'])
    expect(resolved).toBe(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})
