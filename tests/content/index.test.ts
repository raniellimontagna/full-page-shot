import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentRequest, ContentResponse } from '../../src/shared/messages'
import { OVERLAY_TAG } from '../../src/content/selection-overlay'

type Listener = (
  request: ContentRequest,
  sender: unknown,
  sendResponse: (response: ContentResponse) => void,
) => boolean

interface InjectionScope {
  __fullPageShotListenerInstalled?: true
}

/** Undoes the page-lifetime injection sentinel between tests. */
function clearInjectionSentinel(): void {
  delete (globalThis as typeof globalThis & InjectionScope).__fullPageShotListenerInstalled
}

/**
 * Stubs `chrome.runtime.onMessage.addListener`, imports a fresh instance of
 * the content script (so its module-level state starts clean), and returns the
 * listener it registered along with the module's exported constants.
 */
async function loadContentScript(): Promise<{ listener: Listener; watchdogMs: number }> {
  let captured: Listener | undefined
  const addListener = vi.fn((cb: Listener) => {
    captured = cb
  })
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener } } })
  clearInjectionSentinel()
  vi.resetModules()
  const mod = await import('../../src/content/index')
  if (!captured) throw new Error('content script did not register a listener')
  return { listener: captured, watchdogMs: mod.RESTORE_WATCHDOG_MS }
}

function send(listener: Listener, request: ContentRequest): Promise<ContentResponse> {
  return new Promise((resolve) => {
    const keptChannelOpen = listener(request, {}, (response) => resolve(response))
    expect(keptChannelOpen).toBe(true)
  })
}

/**
 * jsdom has neither `ClipboardItem` nor `navigator.clipboard`. Stubbing them
 * lets the real `copyDataUrlToClipboard` run, so these tests exercise the
 * actual path a `copyImage` message takes rather than a mock of it.
 */
function stubClipboard(options: { write?: () => Promise<void> } = {}): { written: unknown[] } {
  const written: unknown[] = []
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(public data: Record<string, Blob>) {}
    },
  )
  vi.stubGlobal('fetch', async () => ({
    blob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
  }))
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: vi.fn(async (items: unknown[]) => {
        written.push(...items)
        if (options.write) await options.write()
      }),
    },
  })
  return { written }
}

function stubScrollPosition(y: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y })
}

describe('content script message handler', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearInjectionSentinel()
  })

  it('restores the FIRST measured scroll position, even when measure is re-sent mid-capture', async () => {
    const { listener } = await loadContentScript()

    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    let scrollY = 500
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })

    const first = await send(listener, { type: 'measure' })
    expect(first).toEqual({ ok: true, measurements: expect.objectContaining({ scrollY: 500 }) })

    // The page moves away from the original position mid-capture.
    scrollY = 1600
    await send(listener, { type: 'scrollTo', y: 1600 })

    // A second `measure` mid-capture (e.g. an orchestrator retry) must
    // still report fresh measurements, but must NOT overwrite the
    // remembered original position — otherwise `restore` would leave the
    // page at 1600 instead of putting it back where the user had it.
    const second = await send(listener, { type: 'measure' })
    expect(second).toEqual({ ok: true, measurements: expect.objectContaining({ scrollY: 1600 }) })

    await send(listener, { type: 'restore' })

    const lastScrollToCall = scrollTo.mock.calls.at(-1)
    expect(lastScrollToCall?.[0]).toEqual({ top: 500, left: 0, behavior: 'instant' })
  })

  // `executeScript` re-runs the file on every capture and the isolated world
  // outlives it, so without a sentinel a second capture leaves two listeners
  // answering every message with two independently latched scroll positions.
  it('registers exactly one listener across two captures on the same page', async () => {
    const addListener = vi.fn()
    vi.stubGlobal('chrome', { runtime: { onMessage: { addListener } } })
    clearInjectionSentinel()

    // Two injections into the same page: same globalThis, fresh module each
    // time, exactly as `chrome.scripting.executeScript` does it.
    vi.resetModules()
    await import('../../src/content/index')
    vi.resetModules()
    await import('../../src/content/index')

    expect(addListener).toHaveBeenCalledTimes(1)
  })
})

describe('content script clipboard sink', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'clipboard')
    clearInjectionSentinel()
  })

  // The single most breakable thing about moving the clipboard here. Delivery
  // happens *after* the page has been put back, so `originalScrollY` is null
  // by the time `copyImage` arrives and the post-restore guard -- which exists
  // to refuse `scrollTo`/`hideFixed` from an abandoned capture -- would
  // otherwise reject every copy the extension ever makes with "capture
  // abandoned; page already restored".
  it('accepts copyImage after the page has already been restored', async () => {
    const { listener } = await loadContentScript()
    const { written } = stubClipboard()
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    stubScrollPosition(500)

    await send(listener, { type: 'measure' })
    await send(listener, { type: 'restore' })

    const response = await send(listener, {
      type: 'copyImage',
      dataUrl: 'data:image/png;base64,AAAA',
    })
    expect(response).toEqual({ ok: true })
    expect(written).toHaveLength(1)
  })

  it('accepts copyImage on a page that was never in a capture', async () => {
    // The watchdog case: the service worker was evicted, the page restored
    // itself, and a later capture's copy must still be able to land.
    const { listener } = await loadContentScript()
    const { written } = stubClipboard()
    await send(listener, { type: 'copyImage', dataUrl: 'data:image/png;base64,AAAA' })
    expect(written).toHaveLength(1)
  })

  it('reports a refused clipboard write back to the service worker', async () => {
    const { listener } = await loadContentScript()
    stubClipboard({ write: () => Promise.reject(new Error('Document is not focused')) })
    const response = await send(listener, {
      type: 'copyImage',
      dataUrl: 'data:image/png;base64,AAAA',
    })
    expect(response).toEqual({ ok: false, error: expect.stringContaining('Document is not focused') })
  })

  // `copyImage` is the last message of a capture, sent after `restore` has
  // deliberately disarmed the watchdog. Re-arming it here would leave a timer
  // running on every page the extension has ever captured, to fire ten seconds
  // later and scroll a page that is no longer in a capture at all.
  it('does not re-arm the restore watchdog', async () => {
    vi.useFakeTimers()
    const { listener, watchdogMs } = await loadContentScript()
    stubClipboard()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    stubScrollPosition(500)

    await send(listener, { type: 'measure' })
    await send(listener, { type: 'restore' })
    scrollTo.mockClear()

    await send(listener, { type: 'copyImage', dataUrl: 'data:image/png;base64,AAAA' })
    vi.advanceTimersByTime(watchdogMs * 2)

    expect(scrollTo).not.toHaveBeenCalled()
  })
})

describe('content script restore watchdog', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearInjectionSentinel()
  })

  it('restores the page itself after the orchestrator goes silent', async () => {
    vi.useFakeTimers()
    const { listener, watchdogMs } = await loadContentScript()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    stubScrollPosition(500)

    await send(listener, { type: 'measure' })
    await send(listener, { type: 'hideFixed' })
    expect(scrollTo).not.toHaveBeenCalled()

    // Simulates the service worker being evicted mid-capture: no `restore`
    // ever arrives, so nothing but the page itself can undo the changes.
    vi.advanceTimersByTime(watchdogMs)

    expect(scrollTo).toHaveBeenCalledWith({ top: 500, left: 0, behavior: 'instant' })
  })

  // Without this the watchdog is invisible to the orchestrator: it would keep
  // scrolling and capturing against a page that has already put itself back,
  // repeating the un-hidden header down every remaining frame and -- because
  // `restorePage` nulls the latch -- stranding the page at the last frame's
  // scroll position when the trailing `restore` turns into a no-op.
  it('refuses capture commands once the watchdog has restored the page', async () => {
    vi.useFakeTimers()
    const { listener, watchdogMs } = await loadContentScript()
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    stubScrollPosition(500)

    await send(listener, { type: 'measure' })
    vi.advanceTimersByTime(watchdogMs)

    const response = await send(listener, { type: 'scrollTo', y: 800 })
    expect(response).toEqual({ ok: false, error: expect.stringContaining('already restored') })
  })

  it('does not fire while capture commands keep arriving', async () => {
    vi.useFakeTimers()
    const { listener, watchdogMs } = await loadContentScript()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    stubScrollPosition(500)

    await send(listener, { type: 'measure' })

    // Three quiet stretches, each just short of the timeout, separated by
    // commands. A watchdog armed once instead of re-armed would have fired
    // during the second stretch and un-hidden the header mid-capture.
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(watchdogMs - 1)
      await send(listener, { type: 'hideFixed' })
    }
    expect(scrollTo).not.toHaveBeenCalled()

    // ...and it still fires once the commands genuinely stop.
    vi.advanceTimersByTime(watchdogMs)
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, left: 0, behavior: 'instant' })
  })
})

describe('content script area selection', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearInjectionSentinel()
    document.querySelector(OVERLAY_TAG)?.remove()
  })

  function dispatchPointer(type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number): void {
    const host = document.querySelector(OVERLAY_TAG)
    if (!host) throw new Error(`no <${OVERLAY_TAG}> mounted`)
    host.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }))
  }

  // `selectArea` starts a capture rather than continuing one, so it arrives
  // with `originalScrollY === null` by definition. Behind the abandoned-capture
  // guard it would be refused every single time — the same trap `copyImage`
  // fell into. Hence its case sits above the guard, with `measure`.
  it('accepts selectArea on a page that was never in a capture, and returns the rect', async () => {
    const { listener } = await loadContentScript()

    const pending = send(listener, { type: 'selectArea' })
    dispatchPointer('pointerdown', 100, 120)
    dispatchPointer('pointermove', 400, 320)
    dispatchPointer('pointerup', 400, 320)

    expect(await pending).toEqual({ ok: true, rect: { x: 100, y: 120, width: 300, height: 200 } })
    expect(document.querySelector(OVERLAY_TAG)).toBeNull()
  })

  // Cancel is not failure: `ok: true` with a null rect, so the service worker
  // delivers nothing and shows the neutral badge instead of the failure one.
  it('reports a cancelled selection as ok with a null rect', async () => {
    const { listener } = await loadContentScript()

    const pending = send(listener, { type: 'selectArea' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    expect(await pending).toEqual({ ok: true, rect: null })
    expect(document.querySelector(OVERLAY_TAG)).toBeNull()
  })

  // The overlay is page state like a hidden header is: if the service worker
  // is evicted while it is up, nothing else is left alive to take it down, and
  // the user is stuck with a dimmed, crosshaired page that swallows clicks.
  it('lets the watchdog remove an overlay abandoned by an evicted worker', async () => {
    vi.useFakeTimers()
    const { listener, watchdogMs } = await loadContentScript()

    const pending = send(listener, { type: 'selectArea' })
    expect(document.querySelector(OVERLAY_TAG)).not.toBeNull()

    // Genuinely idle: no pointer, no key, nothing. An evicted worker produces
    // no input either, so this is exactly the case the watchdog exists for.
    await vi.advanceTimersByTimeAsync(watchdogMs + 1_000)

    expect(document.querySelector(OVERLAY_TAG)).toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(await pending).toEqual({ ok: true, rect: null })
  })

  // Ten seconds is an ordinary amount of time to spend choosing a region.
  // Arming the watchdog once and never re-arming it made deliberation
  // indistinguishable from abandonment: the overlay vanished mid-thought and
  // the user got a silent cancel. The overlay reports activity, so the timer
  // measures silence from the *page*, which is what abandonment actually is.
  it('keeps the overlay alive while the user is still working, past the watchdog', async () => {
    vi.useFakeTimers()
    const { listener, watchdogMs } = await loadContentScript()

    const pending = send(listener, { type: 'selectArea' })
    const host = document.querySelector(OVERLAY_TAG)
    if (!host) throw new Error('no overlay mounted')

    // The user hovers around the page for longer than the whole watchdog
    // period, deciding what to frame.
    for (let elapsed = 0; elapsed <= watchdogMs + 1_000; elapsed += 1_000) {
      host.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 50, clientY: 50, bubbles: true, cancelable: true }),
      )
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(document.querySelector(OVERLAY_TAG)).not.toBeNull()

    // ...and only then drags. The selection still lands.
    dispatchPointer('pointerdown', 100, 120)
    dispatchPointer('pointermove', 400, 320)
    dispatchPointer('pointerup', 400, 320)
    await vi.advanceTimersByTimeAsync(500)

    expect(await pending).toEqual({ ok: true, rect: { x: 100, y: 120, width: 300, height: 200 } })
  })

  // The reply is the end of this command, so the timer must not outlive it and
  // scroll a page that is no longer in a capture.
  it('clears the watchdog once the selection has been answered', async () => {
    vi.useFakeTimers()
    const { listener, watchdogMs } = await loadContentScript()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    stubScrollPosition(500)

    await send(listener, { type: 'measure' })
    const pending = send(listener, { type: 'selectArea' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await vi.advanceTimersByTimeAsync(100)
    await pending
    scrollTo.mockClear()

    await vi.advanceTimersByTimeAsync(watchdogMs * 2)

    expect(scrollTo).not.toHaveBeenCalled()
  })

  // Regression: a second `selectArea` cancels the first synchronously (via
  // `removeSelectionOverlay`), but session #1's promise only settles two
  // frames later. Its `handle` call's `finally { clearWatchdog() }` used to
  // run unconditionally — killing whatever timer was *currently* armed, which
  // by then was the second, live overlay's watchdog, not its own. A worker
  // eviction in that window would strand the second overlay with no watchdog
  // at all, violating the one absolute rule (a failed/cancelled capture never
  // leaves the page altered). A generation token now makes a session's
  // `finally` a no-op once a later selectArea has superseded it.
  it('keeps the watchdog protecting the second overlay after it supersedes and cancels the first', async () => {
    vi.useFakeTimers()
    const { listener, watchdogMs } = await loadContentScript()

    const first = send(listener, { type: 'selectArea' })
    const second = send(listener, { type: 'selectArea' })

    // Session #1 was cancelled synchronously the instant session #2 mounted.
    // Let its `await selection` and cleanup (including the two `nextFrame`s)
    // actually settle before asserting anything about the timers.
    await vi.advanceTimersByTimeAsync(500)
    expect(await first).toEqual({ ok: true, rect: null })
    expect(document.querySelectorAll(OVERLAY_TAG)).toHaveLength(1)

    // Total silence on the surviving overlay — exactly what an evicted worker
    // would also produce. The watchdog protecting it must still be armed.
    await vi.advanceTimersByTimeAsync(watchdogMs + 1_000)

    expect(document.querySelector(OVERLAY_TAG)).toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(await second).toEqual({ ok: true, rect: null })
  })
})
