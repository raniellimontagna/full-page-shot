import type { ContentRequest, ContentResponse } from '../shared/messages'
import { hideFixedElements, restoreFixedElements } from './fixed-elements'
import { measurePage, scrollToStep } from './scroll-driver'

let originalScrollY: number | null = null

async function handle(request: ContentRequest): Promise<ContentResponse> {
  switch (request.type) {
    case 'measure': {
      const measurements = measurePage(window)
      // Only remember the position from the FIRST measure of a capture.
      // If the orchestrator ever re-sends `measure` mid-capture (e.g. a
      // retry) while the page has already been scrolled, overwriting this
      // would make `restore` land on the scrolled position instead of
      // where the user actually started — a real page alteration the spec
      // forbids. Each `measure` still returns fresh measurements; only the
      // remembered original position is sticky, and only `restore` clears it.
      if (originalScrollY === null) {
        originalScrollY = measurements.scrollY
      }
      return { ok: true, measurements }
    }
    case 'hideFixed':
      hideFixedElements(document)
      return { ok: true }
    case 'scrollTo':
      await scrollToStep(window, request.y)
      return { ok: true }
    case 'restore':
      restoreFixedElements(document)
      if (originalScrollY !== null) {
        window.scrollTo({ top: originalScrollY, left: 0, behavior: 'instant' as ScrollBehavior })
        originalScrollY = null
      }
      return { ok: true }
  }
}

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
  handle(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: String(error) } satisfies ContentResponse)
    })
  return true
})
