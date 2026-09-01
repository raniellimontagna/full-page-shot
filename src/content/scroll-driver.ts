import type { PageMeasurements } from '../core/types'

/** Milliseconds to wait after painting, for lazy-loaded content to swap in. */
export const SETTLE_DELAY_MS = 120

export function measurePage(win: Window): PageMeasurements {
  const doc = win.document.documentElement
  return {
    scrollWidth: doc.scrollWidth,
    scrollHeight: doc.scrollHeight,
    viewportWidth: win.innerWidth,
    viewportHeight: win.innerHeight,
    devicePixelRatio: win.devicePixelRatio,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
  }
}

function nextFrame(win: Window): Promise<void> {
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()))
}

export async function scrollToStep(win: Window, y: number): Promise<void> {
  win.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior })
  await nextFrame(win)
  await nextFrame(win)
  await new Promise<void>((resolve) => win.setTimeout(resolve, SETTLE_DELAY_MS))
}
