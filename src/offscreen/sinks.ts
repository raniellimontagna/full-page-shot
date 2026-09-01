export async function copyToClipboard(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

/**
 * How long `downloadBlob` waits for Chrome to report the download as
 * `complete` (or `interrupted`) before giving up on watching it. Generous
 * on purpose — a large screenshot written to a slow disk (or a download
 * the user paused) is legitimate, not a bug. Exported so callers/tests can
 * tune it.
 */
export const DOWNLOAD_COMPLETION_TIMEOUT_MS = 120_000

/**
 * How long to keep the blob URL alive after `DOWNLOAD_COMPLETION_TIMEOUT_MS`
 * elapses without a terminal state. This is deliberately a *separate*,
 * much longer constant from `DOWNLOAD_COMPLETION_TIMEOUT_MS`: the
 * completion timeout marks the point where we stop actively watching a
 * download and let `downloadBlob` return, but the download itself may
 * still be genuinely in progress at that moment. Revoking the URL right
 * away would risk truncating a write that was going to succeed — so this
 * fallback exists purely to eventually release the URL if the download
 * really did stall forever, on a horizon long enough that any download
 * that was ever going to finish already has.
 */
export const DOWNLOAD_TIMEOUT_FALLBACK_REVOKE_MS = 10 * 60_000

type DownloadWaitOutcome = 'complete' | 'timeout'

/**
 * Delivers `blob` as a downloaded file.
 *
 * Lifetime contract: this function does not resolve until the download is
 * genuinely finished (or we have deliberately given up waiting on it — see
 * the timeout branch below). That is what lets the caller safely call
 * `chrome.offscreen.closeDocument()` the moment this resolves:
 * `chrome.downloads.download()` itself only resolves once the download is
 * *queued*, not once Chrome has finished reading the blob, and closing
 * this document destroys the JS realm — and its blob-URL registry — out
 * from under an in-flight download exactly like a premature
 * `revokeObjectURL` would. Do not "simplify" this into a bare
 * `chrome.downloads.download()` call without the wait — that reintroduces
 * the corruption this function exists to prevent.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  let downloadId: number
  try {
    downloadId = await chrome.downloads.download({ url, filename, saveAs: false })
  } catch (error) {
    // The download never started — nothing holds the object URL, revoke now.
    URL.revokeObjectURL(url)
    throw error
  }

  let outcome: DownloadWaitOutcome
  try {
    outcome = await waitForDownloadCompletion(downloadId)
  } catch (error) {
    // Interrupted: the download is genuinely over (and failed), so — unlike
    // the timeout case below — it is both safe and necessary to revoke here
    // rather than leak the URL.
    URL.revokeObjectURL(url)
    throw error
  }

  if (outcome === 'timeout') {
    // We stopped waiting without ever observing `complete` or `interrupted`.
    // Chrome accepted the download and it is most likely still writing, so:
    //   - We do NOT revoke the object URL now — that would risk truncating
    //     a download that was going to succeed, which is exactly the
    //     premature-revoke corruption this whole function exists to
    //     prevent, just self-inflicted via our own timeout instead of via
    //     document teardown. A long fallback revoke (see
    //     `DOWNLOAD_TIMEOUT_FALLBACK_REVOKE_MS`) still runs so the URL
    //     isn't held forever if the download really did stall.
    //   - We resolve rather than reject: reporting failure here would tell
    //     the user their capture did not work when it probably did. An
    //     unconfirmed success is the lesser lie — the user can see for
    //     themselves whether the file arrived — versus a false failure
    //     for a capture that actually succeeded.
    console.warn(
      `full-page-shot: download ${downloadId} had not reached a terminal state after ` +
        `DOWNLOAD_COMPLETION_TIMEOUT_MS (${DOWNLOAD_COMPLETION_TIMEOUT_MS}ms); it is likely still ` +
        `writing, so treating this capture as delivered and revoking its object URL later`,
    )
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_TIMEOUT_FALLBACK_REVOKE_MS)
    return
  }

  // outcome === 'complete' — the download is genuinely over, safe to revoke now.
  URL.revokeObjectURL(url)
}

function waitForDownloadCompletion(downloadId: number): Promise<DownloadWaitOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false

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
