import { describe, expect, it, vi } from 'vitest'
import { measurePage, scrollToStep } from '../../src/content/scroll-driver'

describe('measurePage', () => {
  it('reads dimensions from the document and window', () => {
    document.body.innerHTML = '<div style="height: 3000px"></div>'
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 3000,
      configurable: true,
    })
    const m = measurePage(window)
    expect(m.scrollHeight).toBe(3000)
    expect(m.viewportWidth).toBe(window.innerWidth)
    expect(m.viewportHeight).toBe(window.innerHeight)
    expect(m.devicePixelRatio).toBe(window.devicePixelRatio)
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
    const order: string[] = []
    const win = {
      scrollTo: () => order.push('scroll'),
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        order.push('frame')
        cb(0)
        return 0
      },
      setTimeout: (cb: () => void) => {
        order.push('settle')
        cb()
        return 0
      },
    } as unknown as Window

    await scrollToStep(win, 100)
    expect(order).toEqual(['scroll', 'frame', 'frame', 'settle'])
  })
})
