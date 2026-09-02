import { afterEach, describe, expect, it, vi } from 'vitest'
import { MIN_SELECTION_PX } from '../../src/shared/selection'
import { FRAME_TIMEOUT_MS } from '../../src/content/next-frame'
import {
  OVERLAY_TAG,
  removeSelectionOverlay,
  selectArea,
} from '../../src/content/selection-overlay'

/**
 * jsdom implements `PointerEvent`, but not `Element.setPointerCapture` — which
 * is why the overlay listens on the document for move/up rather than capturing
 * the pointer. No polyfill is needed here; these helpers just build the events
 * the real browser would deliver.
 */
function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number): void {
  const target = document.querySelector(OVERLAY_TAG)
  if (!target) throw new Error(`no <${OVERLAY_TAG}> mounted to dispatch ${type} on`)
  target.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }),
  )
}

function drag(from: [number, number], to: [number, number]): void {
  pointer('pointerdown', from[0], from[1])
  pointer('pointermove', to[0], to[1])
  pointer('pointerup', to[0], to[1])
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

function host(): Element | null {
  return document.querySelector(OVERLAY_TAG)
}

describe('selection overlay', () => {
  afterEach(() => {
    removeSelectionOverlay(document)
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('mounts a single host with a shadow root while a selection is in progress', async () => {
    const pending = selectArea(document)

    const mounted = host()
    expect(mounted).not.toBeNull()
    expect(mounted?.shadowRoot).not.toBeNull()
    expect(document.querySelectorAll(OVERLAY_TAG)).toHaveLength(1)

    pressEscape()
    await pending
  })

  // Page CSS must not be able to restyle or un-stack the overlay, and the
  // overlay must sit above everything the page can produce.
  it('pins the host with !important inline styles', async () => {
    const pending = selectArea(document)

    const style = (host() as HTMLElement).style
    expect(style.getPropertyValue('position')).toBe('fixed')
    expect(style.getPropertyPriority('position')).toBe('important')
    expect(style.getPropertyValue('z-index')).toBe('2147483647')
    expect(style.getPropertyPriority('z-index')).toBe('important')
    expect(style.getPropertyValue('cursor')).toBe('crosshair')
    expect(style.getPropertyValue('touch-action')).toBe('none')
    expect(style.getPropertyValue('user-select')).toBe('none')

    pressEscape()
    await pending
  })

  it('resolves a drag as a viewport-relative CSS rect', async () => {
    const pending = selectArea(document)
    drag([100, 120], [400, 320])

    await expect(pending).resolves.toEqual({ x: 100, y: 120, width: 300, height: 200 })
    expect(host()).toBeNull()
  })

  it('normalises a reverse drag to the identical rect', async () => {
    const forward = selectArea(document)
    drag([100, 120], [400, 320])
    const forwardRect = await forward

    const backward = selectArea(document)
    drag([400, 320], [100, 120])
    const backwardRect = await backward

    expect(backwardRect).toEqual(forwardRect)
    expect(backwardRect).toEqual({ x: 100, y: 120, width: 300, height: 200 })
    expect(host()).toBeNull()
  })

  it('clamps the rect to the viewport', async () => {
    const pending = selectArea(document)
    pointer('pointerdown', -50, -50)
    pointer('pointermove', window.innerWidth + 500, window.innerHeight + 500)
    pointer('pointerup', window.innerWidth + 500, window.innerHeight + 500)

    await expect(pending).resolves.toEqual({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    })
  })

  it('cancels on Escape', async () => {
    const pending = selectArea(document)
    pointer('pointerdown', 100, 100)
    pointer('pointermove', 400, 400)
    pressEscape()

    await expect(pending).resolves.toBeNull()
    expect(host()).toBeNull()
  })

  it('cancels a click without a drag', async () => {
    const pending = selectArea(document)
    pointer('pointerdown', 200, 200)
    pointer('pointerup', 200, 200)

    await expect(pending).resolves.toBeNull()
    expect(host()).toBeNull()
  })

  it('cancels a drag smaller than the minimum in either dimension', async () => {
    const tooNarrow = selectArea(document)
    drag([100, 100], [100 + MIN_SELECTION_PX - 1, 400])
    await expect(tooNarrow).resolves.toBeNull()

    const tooShort = selectArea(document)
    drag([100, 100], [400, 100 + MIN_SELECTION_PX - 1])
    await expect(tooShort).resolves.toBeNull()

    expect(host()).toBeNull()
  })

  it('honours an overridden minimum', async () => {
    const pending = selectArea(document, { minPx: 100 })
    drag([100, 100], [150, 150])

    await expect(pending).resolves.toBeNull()
  })

  // The service worker calls `captureVisibleTab` the moment the reply arrives,
  // so the overlay must be gone *and painted away* before the promise settles.
  it('removes the host before resolving, in every outcome', async () => {
    for (const outcome of ['drag', 'escape', 'click'] as const) {
      const pending = selectArea(document)
      if (outcome === 'drag') drag([10, 10], [200, 200])
      if (outcome === 'escape') pressEscape()
      if (outcome === 'click') {
        pointer('pointerdown', 10, 10)
        pointer('pointerup', 10, 10)
      }
      await pending
      expect(host(), `host left behind after ${outcome}`).toBeNull()
    }
  })

  it('cancels an in-flight selection when a second one starts', async () => {
    const first = selectArea(document)
    pointer('pointerdown', 10, 10)

    const second = selectArea(document)
    await expect(first).resolves.toBeNull()

    // Exactly one overlay is mounted: the second one, unaffected by the
    // first session's cleanup.
    expect(document.querySelectorAll(OVERLAY_TAG)).toHaveLength(1)

    drag([100, 120], [400, 320])
    await expect(second).resolves.toEqual({ x: 100, y: 120, width: 300, height: 200 })
    expect(host()).toBeNull()
  })

  it('removeSelectionOverlay resolves an active selection as a cancel', async () => {
    const pending = selectArea(document)
    expect(host()).not.toBeNull()

    removeSelectionOverlay(document)

    expect(host()).toBeNull()
    await expect(pending).resolves.toBeNull()
  })

  it('removeSelectionOverlay is a no-op when nothing is mounted', () => {
    expect(host()).toBeNull()
    expect(() => {
      removeSelectionOverlay(document)
      removeSelectionOverlay(document)
    }).not.toThrow()
    expect(host()).toBeNull()
  })

  // A cancelled session must not keep answering document-level events, or a
  // later drag would resolve two promises and the page would keep a stale
  // keydown handler for the life of the tab.
  it('detaches its document listeners once resolved', async () => {
    const pending = selectArea(document)
    pressEscape()
    await pending

    // No overlay is mounted, so these would throw inside the helper; dispatch
    // straight at the document instead and assert nothing blows up.
    expect(() => {
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5 }))
      document.dispatchEvent(new PointerEvent('pointerup', { clientX: 5, clientY: 5 }))
      pressEscape()
    }).not.toThrow()
    expect(host()).toBeNull()
  })
})

/**
 * The one guarantee the service worker leans on: it calls `captureVisibleTab`
 * the instant the reply lands, so by then the overlay must be not merely
 * detached but *painted away*. Asserting "the host is gone once the promise
 * resolves" does not test that at all -- it passes with both waits deleted.
 * These tests drive the frames by hand so the ordering itself is pinned.
 */
describe('selection overlay frame discipline', () => {
  afterEach(() => {
    removeSelectionOverlay(document)
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('detaches the host, then waits two painted frames before resolving', async () => {
    const frames: FrameRequestCallback[] = []
    const hostWhenRequested: (Element | null)[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      hostWhenRequested.push(host())
      frames.push(cb)
      return frames.length
    })

    const pending = selectArea(document)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    drag([100, 120], [400, 320])
    await flush()

    // First frame requested, and the host is already out of the document —
    // the frame is waiting for the paint that *follows* the removal.
    expect(raf).toHaveBeenCalledTimes(1)
    expect(hostWhenRequested[0]).toBeNull()
    expect(host()).toBeNull()
    expect(settled).toBe(false)

    frames[0]?.(0)
    await flush()
    expect(raf).toHaveBeenCalledTimes(2)
    // Still not settled: one frame is not enough. The first only queues the
    // paint; the second is what proves it happened.
    expect(settled).toBe(false)

    frames[1]?.(0)
    await expect(pending).resolves.toEqual({ x: 100, y: 120, width: 300, height: 200 })
    expect(raf).toHaveBeenCalledTimes(2)
  })

  it('waits the same two frames on a cancel', async () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })

    const pending = selectArea(document)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    pressEscape()
    await flush()

    expect(raf).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    frames[0]?.(0)
    await flush()
    expect(settled).toBe(false)
    frames[1]?.(0)
    await expect(pending).resolves.toBeNull()
    expect(raf).toHaveBeenCalledTimes(2)
  })

  // A tab hidden between `pointerup` and the paint stops being served frames
  // at all. The reply still has to arrive, or the service worker waits forever
  // on a message that is never coming.
  it('still resolves when the tab is hidden and no frame ever arrives', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)

    const pending = selectArea(document)
    drag([100, 120], [400, 320])

    await vi.advanceTimersByTimeAsync(FRAME_TIMEOUT_MS * 2 + 10)
    await expect(pending).resolves.toEqual({ x: 100, y: 120, width: 300, height: 200 })
    expect(host()).toBeNull()
  })
})

/**
 * A cancelled capture must leave the page exactly as it found it. A page that
 * sees the user's Escape closes its modal; one that sees the pointer stream
 * runs its own drag, lightbox or editor gesture. Either is the capture
 * altering the page -- the rule that outranks everything else here.
 */
describe('selection overlay event isolation', () => {
  afterEach(() => {
    removeSelectionOverlay(document)
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  interface PageSpy {
    counts: Record<string, number>
    detach: () => void
  }

  /** Stands in for a page with its own document-level handlers. */
  function watchPage(): PageSpy {
    const counts: Record<string, number> = {
      keydown: 0,
      pointerdown: 0,
      pointermove: 0,
      pointerup: 0,
      wheel: 0,
    }
    const handlers = Object.keys(counts).map((type) => {
      const handler = (): void => {
        counts[type] = (counts[type] ?? 0) + 1
      }
      document.addEventListener(type, handler)
      return { type, handler }
    })
    return {
      counts,
      detach: () => {
        for (const { type, handler } of handlers) document.removeEventListener(type, handler)
      },
    }
  }

  it('keeps a full drag away from the page', async () => {
    const page = watchPage()
    const pending = selectArea(document)

    drag([100, 120], [400, 320])
    await pending

    expect(page.counts).toMatchObject({ pointerdown: 0, pointermove: 0, pointerup: 0 })
    page.detach()
  })

  it('keeps the Escape cancel away from the page', async () => {
    const page = watchPage()
    const pending = selectArea(document)

    pointer('pointerdown', 100, 100)
    pointer('pointermove', 300, 300)
    pressEscape()
    await pending

    expect(page.counts.keydown).toBe(0)
    expect(page.counts.pointerdown).toBe(0)
    page.detach()
  })

  // `touch-action: none` on the host covers touch only. A wheel still scrolls
  // the page out from under a viewport-fixed rectangle, so the region the user
  // framed is not the region that gets captured.
  it('swallows the wheel so the page cannot scroll under the selection', async () => {
    const page = watchPage()
    const pending = selectArea(document)

    const mounted = host()
    const wheel = new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true })
    mounted?.dispatchEvent(wheel)

    expect(wheel.defaultPrevented).toBe(true)
    expect(page.counts.wheel).toBe(0)

    pressEscape()
    await pending
    page.detach()
  })

  it('stops swallowing events once the overlay is gone', async () => {
    const pending = selectArea(document)
    pressEscape()
    await pending

    const page = watchPage()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(page.counts.keydown).toBe(1)
    expect(page.counts.pointerdown).toBe(1)
    page.detach()
  })
})

/**
 * The overlay is up for as long as the user takes to choose a region, which is
 * routinely longer than the restore watchdog's patience. Abandonment means no
 * *input*, not no *reply*, so the overlay reports the user's activity back and
 * the watchdog measures silence from the page, not from the worker.
 */
describe('selection overlay activity reporting', () => {
  afterEach(() => {
    removeSelectionOverlay(document)
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports pointer and key activity, throttled to at most one call a second', async () => {
    vi.useFakeTimers()
    const onActivity = vi.fn()
    const pending = selectArea(document, { onActivity })

    pointer('pointerdown', 100, 100)
    for (let i = 0; i < 20; i += 1) pointer('pointermove', 100 + i, 100 + i)
    // A burst of pointermove is one gesture, not twenty reasons to re-arm.
    expect(onActivity).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1001)
    pointer('pointermove', 300, 300)
    expect(onActivity).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1001)
    pressEscape()
    expect(onActivity).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(FRAME_TIMEOUT_MS * 2 + 10)
    await expect(pending).resolves.toBeNull()
  })

  it('works without an onActivity callback', async () => {
    const pending = selectArea(document)
    drag([100, 120], [400, 320])
    await expect(pending).resolves.toEqual({ x: 100, y: 120, width: 300, height: 200 })
  })
})
