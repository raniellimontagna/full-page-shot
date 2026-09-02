import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BADGE_FAILURE,
  BADGE_PARTIAL,
  BADGE_SUCCESS,
  DOWNLOAD_COMPLETION_TIMEOUT_MS,
  badgeForCapture,
  badgeForDelivery,
  copyViaContentScript,
  deliverCapture,
  downloadDataUrl,
  type DeliveryResult,
} from '../../src/background/sinks'

const DATA_URL = 'data:image/png;base64,AAAA'

type ChangedListener = (delta: chrome.downloads.DownloadDelta) => void

interface DownloadsStub {
  listeners: ChangedListener[]
  downloadArgs: unknown[]
  searchResult: Partial<chrome.downloads.DownloadItem>[]
  emit: (delta: chrome.downloads.DownloadDelta) => void
}

/**
 * A `chrome.downloads` that behaves the way the real one does in the two ways
 * this module depends on: `download()` resolves as soon as the download is
 * *queued* (never when it is written), and terminal states arrive later
 * through `onChanged`.
 */
function stubDownloads(options: { downloadId?: number; fail?: Error } = {}): DownloadsStub {
  const stub: DownloadsStub = {
    listeners: [],
    downloadArgs: [],
    searchResult: [],
    emit: (delta) => {
      for (const listener of stub.listeners) listener(delta)
    },
  }
  vi.stubGlobal('chrome', {
    downloads: {
      download: vi.fn(async (args: unknown) => {
        stub.downloadArgs.push(args)
        if (options.fail) throw options.fail
        return options.downloadId ?? 7
      }),
      search: vi.fn(async () => stub.searchResult),
      onChanged: {
        addListener: (listener: ChangedListener) => stub.listeners.push(listener),
        removeListener: (listener: ChangedListener) => {
          stub.listeners = stub.listeners.filter((candidate) => candidate !== listener)
        },
      },
    },
  })
  return stub
}

/** Lets the promise chain inside `downloadDataUrl` run before we assert. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('downloadDataUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('hands the data URL straight to chrome.downloads without an object URL', async () => {
    // A service worker has no `URL.createObjectURL`, which is why the image
    // travels as a data URL at all. Nothing here may reach for one -- and
    // because nothing does, there is also nothing to revoke, which is what
    // removes the whole blob-URL-lifetime problem from this code path.
    const createObjectURL = vi.fn(() => 'blob:nope')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })

    const downloads = stubDownloads({ downloadId: 3 })
    downloads.searchResult = [{ state: 'complete' }]

    await expect(downloadDataUrl(DATA_URL, 'shot.png')).resolves.toBe('complete')
    expect(downloads.downloadArgs).toEqual([{ url: DATA_URL, filename: 'shot.png', saveAs: false }])
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('waits for the onChanged completion rather than the queued download', async () => {
    const downloads = stubDownloads({ downloadId: 11 })
    let settled: string | null = null
    const pending = downloadDataUrl(DATA_URL, 'shot.png').then((outcome) => (settled = outcome))

    await flush()
    // `chrome.downloads.download()` has already resolved -- the download is
    // queued -- and this must NOT be reported as delivered yet.
    expect(settled).toBeNull()

    downloads.emit({ id: 11, state: { previous: 'in_progress', current: 'complete' } })
    await pending
    expect(settled).toBe('complete')
  })

  it('ignores state changes belonging to another download', async () => {
    const downloads = stubDownloads({ downloadId: 11 })
    let settled: string | null = null
    const pending = downloadDataUrl(DATA_URL, 'shot.png').then((outcome) => (settled = outcome))

    await flush()
    downloads.emit({ id: 12, state: { previous: 'in_progress', current: 'complete' } })
    downloads.emit({ id: 12, state: { previous: 'in_progress', current: 'interrupted' } })
    await flush()
    expect(settled).toBeNull()

    downloads.emit({ id: 11, state: { previous: 'in_progress', current: 'complete' } })
    await pending
    expect(settled).toBe('complete')
  })

  it('catches a download that finished before the listener was attached', async () => {
    // Small file, fast disk: the terminal state can be reached between
    // `download()` resolving and `onChanged` being subscribed, and onChanged
    // never re-fires for a state the download has already passed through.
    const downloads = stubDownloads({ downloadId: 5 })
    downloads.searchResult = [{ state: 'complete' }]
    await expect(downloadDataUrl(DATA_URL, 'shot.png')).resolves.toBe('complete')
  })

  it('rejects when the download is interrupted', async () => {
    const downloads = stubDownloads({ downloadId: 9 })
    const pending = downloadDataUrl(DATA_URL, 'shot.png')
    await flush()
    downloads.emit({
      id: 9,
      state: { previous: 'in_progress', current: 'interrupted' },
      error: { previous: undefined, current: 'FILE_NO_SPACE' },
    })
    await expect(pending).rejects.toThrow(/download interrupted: FILE_NO_SPACE/)
  })

  it('resolves rather than rejects when the completion wait times out', async () => {
    // A slow write is not a failure. Rejecting would tell the user their
    // capture did not work when it most likely did; they can see for
    // themselves whether the file arrived.
    vi.useFakeTimers()
    stubDownloads({ downloadId: 4 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = downloadDataUrl(DATA_URL, 'shot.png')

    await vi.advanceTimersByTimeAsync(DOWNLOAD_COMPLETION_TIMEOUT_MS - 1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toBe('timeout')
    expect(warn).toHaveBeenCalled()
  })

  it('settles once: a late interruption cannot overturn a completed download', async () => {
    const downloads = stubDownloads({ downloadId: 2 })
    const pending = downloadDataUrl(DATA_URL, 'shot.png')
    await flush()

    downloads.emit({ id: 2, state: { previous: 'in_progress', current: 'complete' } })
    await expect(pending).resolves.toBe('complete')

    // The single `settle()` choke point removed the listener, so a delta that
    // arrives afterwards has nothing to reject an already-resolved promise
    // with -- an unhandled rejection that no caller could ever catch.
    expect(downloads.listeners).toHaveLength(0)
    expect(() => {
      downloads.emit({ id: 2, state: { previous: 'complete', current: 'interrupted' } })
    }).not.toThrow()
  })

  it('propagates a download that Chrome refused outright', async () => {
    stubDownloads({ fail: new Error('Invalid filename') })
    await expect(downloadDataUrl(DATA_URL, '../escape.png')).rejects.toThrow('Invalid filename')
  })
})

describe('copyViaContentScript', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubTabs(response: unknown): { sent: unknown[] } {
    const sent: unknown[] = []
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: vi.fn(async (tabId: number, request: unknown) => {
          sent.push([tabId, request])
          return response
        }),
      },
    })
    return { sent }
  }

  it('asks the captured tab to copy the image', async () => {
    const { sent } = stubTabs({ ok: true })
    await copyViaContentScript(42, DATA_URL)
    expect(sent).toEqual([[42, { type: 'copyImage', dataUrl: DATA_URL }]])
  })

  it('fails with the page-side reason when the copy is refused', async () => {
    stubTabs({ ok: false, error: 'NotAllowedError: Document is not focused' })
    await expect(copyViaContentScript(1, DATA_URL)).rejects.toThrow(/Document is not focused/)
  })

  it('fails loudly when nothing answers', async () => {
    stubTabs(undefined)
    await expect(copyViaContentScript(1, DATA_URL)).rejects.toThrow(/did not answer/)
  })
})

describe('deliverCapture', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs only the sinks the preferences ask for', async () => {
    const copy = vi.fn(async () => {})
    const download = vi.fn(async () => {})
    const result = await deliverCapture({ toClipboard: false, toDownload: true }, { copy, download })

    expect(copy).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ attempted: ['download'], succeeded: ['download'], failed: [] })
  })

  it('attempts nothing when both sinks are disabled', async () => {
    const copy = vi.fn(async () => {})
    const download = vi.fn(async () => {})
    const result = await deliverCapture(
      { toClipboard: false, toDownload: false },
      { copy, download },
    )
    expect(copy).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(result).toEqual({ attempted: [], succeeded: [], failed: [] })
  })

  // The defect this whole module exists to fix: with the shipped defaults, the
  // clipboard write threw and took the download down with it, so a default
  // install delivered nothing at all.
  it('still downloads when the clipboard write fails', async () => {
    const copy = vi.fn(async () => {
      throw new Error('Document is not focused')
    })
    const download = vi.fn(async () => {})
    const result = await deliverCapture({ toClipboard: true, toDownload: true }, { copy, download })

    expect(download).toHaveBeenCalledTimes(1)
    expect(result.succeeded).toEqual(['download'])
    expect(result.failed).toEqual([{ sink: 'clipboard', reason: 'Document is not focused' }])
  })

  it('still copies when the download fails', async () => {
    const copy = vi.fn(async () => {})
    const download = vi.fn(async () => {
      throw new Error('download interrupted: FILE_NO_SPACE')
    })
    const result = await deliverCapture({ toClipboard: true, toDownload: true }, { copy, download })

    expect(result.succeeded).toEqual(['clipboard'])
    expect(result.failed).toEqual([
      { sink: 'download', reason: 'download interrupted: FILE_NO_SPACE' },
    ])
  })

  it('starts both sinks before awaiting either', async () => {
    // Sequential awaits would make the download wait out a slow clipboard
    // write; worse, that ordering is what let one sink's failure cancel the
    // other in the first place.
    let releaseCopy = (): void => {}
    const copy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCopy = resolve
        }),
    )
    const download = vi.fn(async () => {})

    const pending = deliverCapture({ toClipboard: true, toDownload: true }, { copy, download })
    await Promise.resolve()
    expect(download).toHaveBeenCalledTimes(1)

    releaseCopy()
    await expect(pending).resolves.toMatchObject({ succeeded: ['clipboard', 'download'] })
  })

  it('names the failing sink and its reason in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await deliverCapture(
      { toClipboard: true, toDownload: false },
      {
        copy: async () => {
          throw new Error('Document is not focused')
        },
        download: async () => {},
      },
    )
    expect(warn.mock.calls.flat().join(' ')).toMatch(/clipboard.*Document is not focused/)
  })
})

describe('badgeForDelivery', () => {
  const result = (partial: Partial<DeliveryResult>): DeliveryResult => ({
    attempted: [],
    succeeded: [],
    failed: [],
    ...partial,
  })

  it('shows success when every enabled sink delivered', () => {
    expect(
      badgeForDelivery(result({ attempted: ['clipboard'], succeeded: ['clipboard'] })),
    ).toEqual(BADGE_SUCCESS)
  })

  it('shows success when the user asked for no sink at all', () => {
    expect(badgeForDelivery(result({}))).toEqual(BADGE_SUCCESS)
  })

  it('shows failure only when every enabled sink failed', () => {
    expect(
      badgeForDelivery(
        result({
          attempted: ['clipboard', 'download'],
          failed: [
            { sink: 'clipboard', reason: 'a' },
            { sink: 'download', reason: 'b' },
          ],
        }),
      ),
    ).toEqual(BADGE_FAILURE)
  })

  // A ✓ here would be a lie the user only discovers when the file is missing;
  // a ✕ would send them re-capturing a page that was already saved.
  it('shows its own state when the sinks disagree', () => {
    const badge = badgeForDelivery(
      result({
        attempted: ['clipboard', 'download'],
        succeeded: ['download'],
        failed: [{ sink: 'clipboard', reason: 'Document is not focused' }],
      }),
    )
    expect(badge).toEqual(BADGE_PARTIAL)
    expect(badge.text).not.toBe(BADGE_SUCCESS.text)
    expect(badge.text).not.toBe(BADGE_FAILURE.text)
  })
})

// `truncated` used to be set by the planner and read by nobody: a page clamped
// to Chrome's canvas ceilings was delivered cropped under a plain ✓, and the
// spec's error table promised the user would be warned.
describe('badgeForCapture', () => {
  const result = (partial: Partial<DeliveryResult>): DeliveryResult => ({
    attempted: [],
    succeeded: [],
    failed: [],
    ...partial,
  })

  const delivered = result({ attempted: ['download'], succeeded: ['download'] })
  const halfDelivered = result({
    attempted: ['clipboard', 'download'],
    succeeded: ['download'],
    failed: [{ sink: 'clipboard', reason: 'Document is not focused' }],
  })
  const undelivered = result({
    attempted: ['download'],
    failed: [{ sink: 'download', reason: 'download interrupted: USER_CANCELED' }],
  })

  it('defers to the delivery badge when nothing was truncated', () => {
    expect(badgeForCapture(delivered, false)).toEqual(BADGE_SUCCESS)
    expect(badgeForCapture(halfDelivered, false)).toEqual(BADGE_PARTIAL)
    expect(badgeForCapture(undelivered, false)).toEqual(BADGE_FAILURE)
  })

  // The file is real and worth keeping, but it is the top of the page rather
  // than the page — "you got something, but not everything", which is exactly
  // what the amber badge already means.
  it('downgrades a fully delivered but truncated capture to partial', () => {
    expect(badgeForCapture(delivered, true)).toEqual(BADGE_PARTIAL)
  })

  it('keeps a partial delivery partial', () => {
    expect(badgeForCapture(halfDelivered, true)).toEqual(BADGE_PARTIAL)
  })

  // Nothing arrived, so how complete it would have been is beside the point.
  it('keeps a failed delivery a failure', () => {
    expect(badgeForCapture(undelivered, true)).toEqual(BADGE_FAILURE)
  })
})
