const MARKER = 'data-fps-prev-visibility'

/**
 * Walks every element reachable from `root`, descending into open shadow
 * roots so fixed/sticky elements inside web components are not missed.
 * `root.querySelectorAll('*')` on a Document already includes <html>,
 * <head> and <body> themselves (they are descendants of the document),
 * so no separate step is needed to include those.
 *
 * hideFixedElements and restoreFixedElements both use this helper so their
 * traversal can never drift apart — a mismatch there would mean an element
 * hidden by one pass is unreachable by the other, permanently altering the
 * page in violation of the idempotency contract.
 */
function* walkElements(root: Document | ShadowRoot): Generator<HTMLElement> {
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    yield element
    if (element.shadowRoot) {
      yield* walkElements(element.shadowRoot)
    }
  }
}

/**
 * Hides fixed and sticky elements (including inside shadow DOM) so they are
 * not repeated on every frame. The previous inline value is stored on the
 * element itself, so restore works even if this module is re-injected.
 */
export function hideFixedElements(doc: Document): void {
  for (const element of walkElements(doc)) {
    if (element.hasAttribute(MARKER)) continue
    const position = doc.defaultView?.getComputedStyle(element).position
    if (position !== 'fixed' && position !== 'sticky') continue
    element.setAttribute(MARKER, element.style.visibility)
    element.style.visibility = 'hidden'
  }
}

export function restoreFixedElements(doc: Document): void {
  for (const element of walkElements(doc)) {
    if (!element.hasAttribute(MARKER)) continue
    element.style.visibility = element.getAttribute(MARKER) ?? ''
    element.removeAttribute(MARKER)
  }
}
