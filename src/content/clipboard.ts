/**
 * Writes the stitched capture to the system clipboard.
 *
 * This runs in the *content script* of the captured tab, and that location is
 * the whole point. `navigator.clipboard.write()` rejects with
 * `NotAllowedError: Document is not focused` unless it is called from a
 * focused document. The offscreen document where this used to live has no
 * window and can never be focused, so the copy could never work there — while
 * the captured tab is, by construction, the active tab of the focused window
 * (the capture loop aborts the moment it stops being).
 *
 * The image arrives as a `data:` URL because that is the only shape that
 * survives the two message hops from the offscreen canvas (a `Blob` does not
 * cross `chrome.runtime` messaging, and a blob URL is scoped to the document
 * that created it). `fetch` is the browser's own decoder for it.
 */
export async function copyDataUrlToClipboard(dataUrl: string): Promise<void> {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}
