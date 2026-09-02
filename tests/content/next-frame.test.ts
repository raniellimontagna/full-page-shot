import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRAME_TIMEOUT_MS, nextFrame } from '../../src/content/next-frame'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('nextFrame', () => {
  it('resolves on the animation frame when one arrives', async () => {
    vi.useFakeTimers()
    const frames: FrameRequestCallback[] = []
    const clearTimeoutSpy = vi.fn((id: number) => clearTimeout(id))
    const win = {
      requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb),
      setTimeout: ((cb: () => void, ms?: number) =>
        setTimeout(cb, ms) as unknown as number) as Window['setTimeout'],
      clearTimeout: clearTimeoutSpy as unknown as Window['clearTimeout'],
    } as unknown as Window

    let resolved = false
    void nextFrame(win).then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)

    frames[0]?.(0)
    await Promise.resolve()
    expect(resolved).toBe(true)
    // The safety timer must not be left running once the frame has landed.
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1)
  })

  // A background tab never services `requestAnimationFrame`. Without this
  // timeout the content script would hang inside its `finally` and never reply
  // -- and the restore watchdog cannot rescue a promise, only the page.
  it('resolves anyway when the frame never comes, as in a hidden tab', async () => {
    vi.useFakeTimers()
    const win = {
      requestAnimationFrame: () => 1,
      setTimeout: ((cb: () => void, ms?: number) =>
        setTimeout(cb, ms) as unknown as number) as Window['setTimeout'],
      clearTimeout: ((id: number) => clearTimeout(id)) as unknown as Window['clearTimeout'],
    } as unknown as Window

    let resolved = false
    void nextFrame(win).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(FRAME_TIMEOUT_MS - 1)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
  })

  // A synchronous frame (as some fakes and some polyfills provide) must not
  // reach for a timer it then has to clear.
  it('never schedules a timer when the frame is synchronous', async () => {
    const setTimeoutSpy = vi.fn()
    const win = {
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        cb(0)
        return 1
      },
      setTimeout: setTimeoutSpy as unknown as Window['setTimeout'],
      clearTimeout: (() => {}) as unknown as Window['clearTimeout'],
    } as unknown as Window

    await nextFrame(win)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })
})
