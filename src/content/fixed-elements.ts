const MARKER = 'data-fps-prev-visibility'

/**
 * Hides fixed and sticky elements so they are not repeated on every frame.
 * The previous inline value is stored on the element itself, so restore
 * works even if this module is re-injected.
 */
export function hideFixedElements(doc: Document): void {
  for (const element of doc.querySelectorAll<HTMLElement>('body *')) {
    if (element.hasAttribute(MARKER)) continue
    const position = doc.defaultView?.getComputedStyle(element).position
    if (position !== 'fixed' && position !== 'sticky') continue
    element.setAttribute(MARKER, element.style.visibility)
    element.style.visibility = 'hidden'
  }
}

export function restoreFixedElements(doc: Document): void {
  for (const element of doc.querySelectorAll<HTMLElement>(`[${MARKER}]`)) {
    element.style.visibility = element.getAttribute(MARKER) ?? ''
    element.removeAttribute(MARKER)
  }
}
