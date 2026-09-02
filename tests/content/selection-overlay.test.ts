import { afterEach, describe, expect, it } from 'vitest'
import { MIN_SELECTION_PX } from '../../src/shared/selection'
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
