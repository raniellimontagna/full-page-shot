export async function copyToClipboard(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

/**
 * How long `downloadBlob` waits for Chrome to report the download as
 * `complete` before giving up. Generous on purpose — a large screenshot
 * written to a slow disk (or a download the user paused) is legitimate,
 * not a bug. Exported so callers/tests can tune it.
 */
export const DOWNLOAD_COMPLETION_TIMEOUT_MS = 120_000

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

  try {
    // `chrome.downloads.download()` resolves once the download is queued,
    // not once Chrome has finished reading the blob. Waiting here for the
    // real completion event (rather than a fixed delay before revoking) is
    // what lets the caller safely tear down this whole document —
    // `chrome.offscreen.closeDocument()` destroys the JS realm and its
    // blob-URL registry with it, which aborts an in-flight download exactly
    // like a premature `revokeObjectURL` would.
    await waitForDownloadCompletion(downloadId)
  } finally {
    // Reached only once the download is genuinely finished (success or
    // interrupted) or the wait timed out — safe to release the blob URL on
    // every one of those paths.
    URL.revokeObjectURL(url)
  }
}

function waitForDownloadCompletion(downloadId: number): Promise<void> {
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
        settle(() => resolve())
      } else if (state === 'interrupted') {
        settle(() => reject(new Error(`download interrupted: ${error ?? 'unknown reason'}`)))
      }
    }

    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) return
      handleState(delta.state?.current, delta.error?.current)
    }

    const timeoutId = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `download ${downloadId} did not complete within the ${DOWNLOAD_COMPLETION_TIMEOUT_MS}ms timeout`,
          ),
        ),
      )
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
