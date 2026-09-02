import type { ContentRequest, ContentResponse } from '../shared/messages'
import type { Prefs } from '../shared/prefs'

/**
 * How long `downloadDataUrl` waits for Chrome to report the download as
 * `complete` (or `interrupted`) before giving up on watching it. Generous
 * on purpose — a large screenshot written to a slow disk (or a download
 * the user paused) is legitimate, not a bug. Exported so callers/tests can
 * tune it.
 */
export const DOWNLOAD_COMPLETION_TIMEOUT_MS = 120_000

/**
 * How `downloadDataUrl` left the download, accounting for all three ways it
 * can end:
 *
 *   - `'complete'`: the download reached Chrome's terminal "finished"
 *     state before this function returned. The file is genuinely written.
 *   - `'timeout'`: this function gave up *watching* the download after
 *     `DOWNLOAD_COMPLETION_TIMEOUT_MS`. The download itself is most likely
 *     still writing, so this is reported as a (qualified) success.
 *   - Interrupted downloads are not part of this type at all:
 *     `downloadDataUrl` *rejects* with an `Error` in that case instead of
 *     resolving, since an interrupted download is genuinely over (and failed).
 *
 * Resolving does not, by itself, mean the download finished — only the
 * resolved value does. Putting that in the type is deliberate: a comment
 * saying "this always means the download is done" would go stale exactly
 * on the branch that matters.
 */
export type DownloadOutcome = 'complete' | 'timeout'

/**
 * Delivers `dataUrl` as a downloaded file, from the service worker.
 *
 * This lives in the service worker and nowhere else: `chrome.downloads` is
 * simply `undefined` inside an offscreen document, which is where this code
 * used to sit — `downloadBlob` threw a `TypeError` before a byte was ever
 * written and no capture was ever downloaded (see task-9-report.md). A service
 * worker has no `URL.createObjectURL`, so the image crosses the message
 * boundary as a `data:` URL and `chrome.downloads` reads it directly. Nothing
 * here owns an object URL, so — unlike the offscreen version this replaces —
 * there is nothing to revoke and no document whose teardown could truncate the
 * write.
 *
 * Do not "simplify" this into a bare `chrome.downloads.download()` call
 * without the completion wait: `chrome.downloads.download()` itself only
 * resolves once the download is *queued*, not once Chrome has finished
 * writing it, and that gap is exactly what this function exists to close.
 */
export async function downloadDataUrl(dataUrl: string, filename: string): Promise<DownloadOutcome> {
  const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false })
  const outcome = await waitForDownloadCompletion(downloadId)

  if (outcome === 'timeout') {
    // We stopped waiting without ever observing `complete` or `interrupted`.
    // Chrome accepted the download and it is most likely still writing, so we
    // resolve rather than reject: reporting failure here would tell the user
    // their capture did not work when it probably did. An unconfirmed success
    // is the lesser lie — the user can see for themselves whether the file
    // arrived — versus a false failure for a capture that actually succeeded.
    console.warn(
      `full-page-shot: download ${String(downloadId)} had not reached a terminal state after ` +
        `DOWNLOAD_COMPLETION_TIMEOUT_MS (${String(DOWNLOAD_COMPLETION_TIMEOUT_MS)}ms); it is ` +
        'likely still writing, so treating this capture as delivered',
    )
  }
  return outcome
}

function waitForDownloadCompletion(downloadId: number): Promise<DownloadOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false

    // The single choke point: every exit from this promise goes through it, so
    // the listener and the timer are torn down exactly once no matter which
    // path wins the race (and a late `onChanged` after a timeout cannot
    // re-settle an already-settled promise). `settled` is set synchronously,
    // before `action` runs, precisely so two events in the same task cannot
    // both get through.
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      chrome.downloads.onChanged.removeListener(listener)
      action()
    }

    const handleState = (state: string | undefined, error: string | undefined): void => {
      if (state === 'complete') {
        settle(() => resolve('complete'))
      } else if (state === 'interrupted') {
        settle(() => reject(new Error(`download interrupted: ${error ?? 'unknown reason'}`)))
      }
    }

    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) return
      handleState(delta.state?.current, delta.error?.current)
    }

    const timeoutId = setTimeout(() => {
      settle(() => resolve('timeout'))
    }, DOWNLOAD_COMPLETION_TIMEOUT_MS)

    chrome.downloads.onChanged.addListener(listener)

    // Guard against a race where the download already finished (small file,
    // fast disk) between `chrome.downloads.download()` resolving and this
    // listener being attached — onChanged wouldn't fire again for a state
    // this download already passed through.
    void chrome.downloads.search({ id: downloadId }).then((items) => {
      const item = items[0]
      if (item) handleState(item.state, item.error)
    })
  })
}

/**
 * Copies the capture to the clipboard *from the captured tab's content
 * script*, which is a real, focused document.
 *
 * This cannot be done from the offscreen document, and that is not a Chrome
 * bug to work around: `navigator.clipboard.write()` requires a focused
 * document, an offscreen document has no window and can never be focused, and
 * `reasons: [CLIPBOARD]` grants the API without lifting that requirement. It
 * fails headless and headed alike, while an ordinary page in the same browser
 * writes the clipboard fine (measured — see task-9-report.md).
 *
 * The message legitimately arrives *after* `restore`, so the content script's
 * watchdog guard exempts `copyImage` the way it exempts `measure`. Without
 * that exemption every copy is rejected with "capture abandoned".
 */
export async function copyViaContentScript(tabId: number, dataUrl: string): Promise<void> {
  const request: ContentRequest = { type: 'copyImage', dataUrl }
  const response = (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse | undefined
  if (!response) throw new Error('the page did not answer the clipboard request')
  if (!response.ok) throw new Error(response.error)
}

export type SinkName = 'clipboard' | 'download'

export interface SinkFailure {
  sink: SinkName
  reason: string
}

export interface DeliveryResult {
  /** The sinks the user's preferences asked for, in a stable order. */
  attempted: SinkName[]
  succeeded: SinkName[]
  failed: SinkFailure[]
}

/**
 * Runs the enabled sinks and reports what each one did.
 *
 * `Promise.allSettled`, not sequential awaits: the sinks are independent
 * deliveries of the same image and one failing must never cancel the other.
 * The shipped defaults enable both, and the previous sequential version meant
 * a clipboard failure destroyed a perfectly good download — a default install
 * delivered nothing at all and showed a red badge.
 *
 * Both sinks are started before either is awaited, so a slow download does not
 * delay the clipboard write.
 */
export async function deliverCapture(
  prefs: Prefs,
  sinks: { copy: () => Promise<unknown>; download: () => Promise<unknown> },
): Promise<DeliveryResult> {
  const attempted: SinkName[] = []
  const running: Promise<unknown>[] = []
  if (prefs.toClipboard) {
    attempted.push('clipboard')
    running.push(sinks.copy())
  }
  if (prefs.toDownload) {
    attempted.push('download')
    running.push(sinks.download())
  }

  const settled = await Promise.allSettled(running)

  const succeeded: SinkName[] = []
  const failed: SinkFailure[] = []
  for (const [i, result] of settled.entries()) {
    const sink = attempted[i]
    if (!sink) continue
    if (result.status === 'fulfilled') {
      succeeded.push(sink)
    } else {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason as unknown)
      failed.push({ sink, reason })
      // Named, not just counted: a badge can say "one of them failed" but only
      // the log can say which one and why.
      console.warn(`full-page-shot: the ${sink} sink failed: ${reason}`)
    }
  }

  return { attempted, succeeded, failed }
}

export interface Badge {
  text: string
  color: string
}

export const BADGE_SUCCESS: Badge = { text: '✓', color: '#1e8e3e' }
export const BADGE_FAILURE: Badge = { text: '✕', color: '#b3261e' }
/** Amber, and neither of the other two glyphs: a split result is its own state. */
export const BADGE_PARTIAL: Badge = { text: '!', color: '#f9ab00' }

/**
 * Encodes the delivery honestly.
 *
 * A ✓ when one of two enabled sinks silently failed would be a lie the user
 * cannot detect until they go looking for a file that is not there; a ✕ when
 * the download did land would send them re-capturing a page that was already
 * saved. Partial success is therefore its own badge rather than being rounded
 * to whichever neighbour is convenient.
 *
 * With no sink enabled at all, `attempted` is empty and every enabled sink
 * (vacuously) succeeded: the capture did everything it was asked to do, so ✓.
 */
export function badgeForDelivery(result: DeliveryResult): Badge {
  if (result.failed.length === 0) return BADGE_SUCCESS
  if (result.succeeded.length === 0) return BADGE_FAILURE
  return BADGE_PARTIAL
}

/**
 * The badge for the capture as a whole: delivery *and* completeness.
 *
 * A capture the planner had to clamp to Chrome's canvas ceilings is not a ✓.
 * The file is real and worth keeping -- it is the top of the page, correctly
 * stitched -- but it is not the page the user asked for, and a plain ✓ on a
 * silently cropped screenshot is the same lie as a ✓ on a sink that failed:
 * undetectable until they go looking for content that is not there. So a
 * truncated-but-delivered capture takes the amber partial badge, the same
 * "you got something, but not everything" signal a half-failed delivery gets.
 *
 * A truncated capture that also failed to deliver stays ✕: nothing arrived, so
 * how complete it would have been is beside the point.
 */
export function badgeForCapture(result: DeliveryResult, truncated: boolean): Badge {
  const delivery = badgeForDelivery(result)
  if (!truncated) return delivery
  if (delivery === BADGE_FAILURE) return BADGE_FAILURE
  return BADGE_PARTIAL
}

/**
 * The two finished images of one capture.
 *
 * They are separate fields rather than one `dataUrl` because they genuinely
 * differ: the clipboard is always PNG (`ClipboardItem` with `image/png` is the
 * only widely-pasteable image type) while the download carries whichever
 * format the user chose. They hold the same string only when that format is
 * PNG too.
 */
export interface CaptureImages {
  clipboardDataUrl: string
  downloadDataUrl: string
}

/**
 * `deliverCapture` with the routing done here instead of at every call site.
 *
 * Two capture paths now deliver, and the failure mode this prevents is silent:
 * hand `clipboardDataUrl` to the download sink and the user gets a `.jpg` file
 * containing a PNG — a file that still opens, under a green badge, so nothing
 * anywhere reports a problem. Doing the pairing once, in the module that owns
 * the sinks, makes that mistake a compile error rather than a bug report.
 */
export async function deliverImages(
  prefs: Prefs,
  images: CaptureImages,
  filename: string,
  io: {
    copy: (dataUrl: string) => Promise<unknown>
    download: (dataUrl: string, filename: string) => Promise<unknown>
  },
): Promise<DeliveryResult> {
  return await deliverCapture(prefs, {
    copy: () => io.copy(images.clipboardDataUrl),
    download: () => io.download(images.downloadDataUrl, filename),
  })
}
