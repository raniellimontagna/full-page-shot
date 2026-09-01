import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentRequest, ContentResponse } from '../../src/shared/messages'

type Listener = (
  request: ContentRequest,
  sender: unknown,
  sendResponse: (response: ContentResponse) => void,
) => boolean

/**
 * Stubs `chrome.runtime.onMessage.addListener`, imports a fresh instance of
 * the content script (so its module-level `originalScrollY` state starts
 * clean), and returns the listener it registered.
 */
async function loadContentScript(): Promise<Listener> {
  let captured: Listener | undefined
  const addListener = vi.fn((cb: Listener) => {
    captured = cb
  })
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener } } })
  vi.resetModules()
  await import('../../src/content/index')
  if (!captured) throw new Error('content script did not register a listener')
  return captured
}

function send(listener: Listener, request: ContentRequest): Promise<ContentResponse> {
  return new Promise((resolve) => {
    const keptChannelOpen = listener(request, {}, (response) => resolve(response))
    expect(keptChannelOpen).toBe(true)
  })
}

describe('content script message handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('restores the FIRST measured scroll position, even when measure is re-sent mid-capture', async () => {
    const listener = await loadContentScript()

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
})
