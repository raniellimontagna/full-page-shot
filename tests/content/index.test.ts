import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentRequest, ContentResponse } from '../../src/shared/messages'

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
