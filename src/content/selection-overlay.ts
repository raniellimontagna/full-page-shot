import type { CssRect } from '../shared/messages'
import { MIN_SELECTION_PX } from '../shared/selection'

/**
 * The overlay's host tag. A hyphenated, extension-prefixed name so it can
 * never collide with a page element, and so the E2E suite can assert the DOM
 * is clean again by tag name alone.
 */
export const OVERLAY_TAG = 'fps-selection-overlay'

/**
 * The one in-flight selection, if any. Module-level rather than per-call
 * because the two entry points below both need to reach it: a second
 * `selectArea` cancels the first, and the content script's restore watchdog
 * cancels an abandoned one through `removeSelectionOverlay`.
 */
let active: { cancel: () => void } | null = null

/**
 * Everything inside the shadow root. Page CSS cannot reach in here, so these
 * rules need no `!important` — only the host does (see `mountHost`).
 *
 * The backdrop dims the page before the drag starts; once a rectangle exists
 * the backdrop hides and the rectangle's outsized box-shadow does the dimming
 * instead, which leaves the selected region at full brightness so the user can
 * see what they are actually capturing.
 */
const SHADOW_CSS = `
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
  }
  .rect {
    position: fixed;
    display: none;
    box-sizing: border-box;
    border: 1px solid #fff;
    box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.35);
  }
  .label {
    position: fixed;
    display: none;
    padding: 2px 6px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.75);
    color: #fff;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap;
    pointer-events: none;
  }
`

/**
 * The host is the only thing the page's stylesheets can see, so every property
 * that keeps the overlay usable is set inline and `!important`: an inline
 * `!important` declaration outranks any author rule, however specific. Without
 * it a page rule as ordinary as `* { position: static }` would drop the
 * overlay into the document flow, and a `z-index` of its own could paint over
 * it — which would end up in the screenshot.
 */
const HOST_STYLE: readonly (readonly [string, string])[] = [
  ['position', 'fixed'],
  ['inset', '0'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['display', 'block'],
  ['z-index', '2147483647'],
  ['cursor', 'crosshair'],
  ['touch-action', 'none'],
  ['user-select', 'none'],
  ['-webkit-user-select', 'none'],
  ['pointer-events', 'auto'],
  ['background', 'transparent'],
]

interface OverlayParts {
  host: HTMLElement
  backdrop: HTMLElement
  box: HTMLElement
  label: HTMLElement
}

function mountOverlay(doc: Document): OverlayParts {
  const host = doc.createElement(OVERLAY_TAG)
  for (const [property, value] of HOST_STYLE) {
    host.style.setProperty(property, value, 'important')
  }

  const root = host.attachShadow({ mode: 'open' })
  const style = doc.createElement('style')
  style.textContent = SHADOW_CSS
  const backdrop = doc.createElement('div')
  backdrop.className = 'backdrop'
  const box = doc.createElement('div')
  box.className = 'rect'
  const label = doc.createElement('div')
  label.className = 'label'
  root.append(style, backdrop, box, label)

  // `documentElement` is the fallback for the (theoretical, at `document_idle`)
  // case of no body yet; a fixed host works the same under either parent.
  const mount: Element = doc.body ?? doc.documentElement
  mount.append(host)

  return { host, backdrop, box, label }
}

function paint(parts: OverlayParts, rect: CssRect): void {
  parts.backdrop.style.display = 'none'
  parts.box.style.display = 'block'
  parts.box.style.left = `${rect.x}px`
  parts.box.style.top = `${rect.y}px`
  parts.box.style.width = `${rect.width}px`
  parts.box.style.height = `${rect.height}px`

  parts.label.style.display = 'block'
  parts.label.style.left = `${rect.x}px`
  parts.label.style.top = `${rect.y + rect.height + 6}px`
  parts.label.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
}

/** Origin and current point in either order produce the same rect. */
function normalise(a: { x: number; y: number }, b: { x: number; y: number }): CssRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}

function nextFrame(win: Window): Promise<void> {
  return new Promise((resolve) => win.requestAnimationFrame(() => resolve()))
}

/**
 * Tears down any overlay, cancelling an in-flight `selectArea` as it goes.
 *
 * Safe to call when there is nothing mounted, which is the normal case: the
 * content script's restore watchdog calls this on every abandoned capture,
 * selection or not. Cancelling the session as well as removing the node
 * matters — a host ripped out from under a live session would otherwise leave
 * that promise pending forever, and its document listeners installed.
 */
export function removeSelectionOverlay(doc: Document): void {
  const cancelled = active
  active = null
  cancelled?.cancel()
  for (const host of doc.querySelectorAll(OVERLAY_TAG)) {
    host.remove()
  }
}

/**
 * Puts a selection overlay on the page and resolves with the region the user
 * dragged, in CSS pixels relative to the viewport — or `null` if they
 * cancelled (Escape, a click with no drag, or a rectangle under `minPx` in
 * either dimension). Cancel is not failure; the caller reports nothing.
 *
 * The host is removed in a `finally` and the promise settles only after two
 * `requestAnimationFrame`s, because the service worker calls
 * `captureVisibleTab` the instant this reply lands: one frame queues the paint
 * that follows the removal, the second waits for it to have happened. Without
 * that wait the overlay itself shows up in the screenshot.
 */
export async function selectArea(
  doc: Document,
  opts: { minPx?: number } = {},
): Promise<CssRect | null> {
  const minPx = opts.minPx ?? MIN_SELECTION_PX
  const win = doc.defaultView
  if (win === null) return null

  // Idempotence: whatever was up is cancelled and gone before we mount.
  removeSelectionOverlay(doc)
  const parts = mountOverlay(doc)

  let settle: (rect: CssRect | null) => void = () => {}
  const selection = new Promise<CssRect | null>((resolve) => {
    settle = resolve
  })

  const clampX = (value: number): number => Math.min(Math.max(value, 0), win.innerWidth)
  const clampY = (value: number): number => Math.min(Math.max(value, 0), win.innerHeight)
  const pointOf = (event: PointerEvent): { x: number; y: number } => ({
    x: clampX(event.clientX),
    y: clampY(event.clientY),
  })

  let origin: { x: number; y: number } | null = null

  // Every pointer event is `preventDefault`ed so the drag cannot start a text
  // selection, a native image drag, or a touch scroll underneath the overlay.
  const onPointerDown = (event: PointerEvent): void => {
    if (origin !== null) return
    event.preventDefault()
    origin = pointOf(event)
    paint(parts, { x: origin.x, y: origin.y, width: 0, height: 0 })
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (origin === null) return
    event.preventDefault()
    paint(parts, normalise(origin, pointOf(event)))
  }
  const onPointerUp = (event: PointerEvent): void => {
    if (origin === null) return
    event.preventDefault()
    const rect = normalise(origin, pointOf(event))
    // A click, or a drag too small to have been meant: a cancel, not an error.
    settle(rect.width < minPx || rect.height < minPx ? null : rect)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    settle(null)
  }

  // `pointerdown` on the host (it covers the viewport, so it is the target),
  // but move/up on the document: jsdom has no `setPointerCapture`, and without
  // capture a drag that slips past the host still has to be followed.
  parts.host.addEventListener('pointerdown', onPointerDown)
  doc.addEventListener('pointermove', onPointerMove)
  doc.addEventListener('pointerup', onPointerUp)
  // Capture phase, so a page that swallows keydown cannot trap the user in the
  // overlay with no way out.
  doc.addEventListener('keydown', onKeyDown, true)

  const session = { cancel: (): void => settle(null) }
  active = session

  try {
    return await selection
  } finally {
    if (active === session) active = null
    parts.host.removeEventListener('pointerdown', onPointerDown)
    doc.removeEventListener('pointermove', onPointerMove)
    doc.removeEventListener('pointerup', onPointerUp)
    doc.removeEventListener('keydown', onKeyDown, true)
    parts.host.remove()
    await nextFrame(win)
    await nextFrame(win)
  }
}
