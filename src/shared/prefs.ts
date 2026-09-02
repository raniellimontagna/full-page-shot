export type CaptureMode = 'full' | 'viewport'
export type Scale = 1 | 2
export type DownloadFormat = 'png' | 'jpeg' | 'webp'

export interface Prefs {
  toClipboard: boolean
  toDownload: boolean
  captureMode: CaptureMode
  scale: Scale
  downloadFormat: DownloadFormat
}

export const DEFAULT_PREFS: Prefs = {
  toClipboard: true,
  toDownload: true,
  captureMode: 'full',
  scale: 1,
  downloadFormat: 'png',
}

// Fixed quality used when encoding a lossy download format (jpeg/webp). Not
// user-configurable — see Global Constraints in the v1.1 plan.
export const LOSSY_QUALITY = 0.85

// Schemes a content script can never be injected into, so a capture would
// fail with an opaque error rather than a useful one. `file://` is listed
// because injection there requires a per-extension user opt-in we do not ask
// for; `about:` covers `about:blank` and friends.
const BLOCKED_PREFIXES = ['chrome://', 'chrome-extension://', 'devtools://', 'about:', 'file://']
// Chrome blocks extension scripting on the Web Store even though the URL is
// an ordinary https one, so the prefix check above cannot catch these.
const BLOCKED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com']

// Returns a type guard rather than a plain boolean so callers that go on to
// parse the URL (the service worker needs its hostname for the filename)
// don't need a non-null assertion to undo the check they just performed.
export function isCapturableUrl(url: string | undefined): url is string {
  if (!url) return false
  if (BLOCKED_PREFIXES.some((prefix) => url.startsWith(prefix))) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return !BLOCKED_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * `chrome.downloads.download` rejects a filename containing `:` (and other
 * path-hostile characters), which both an ISO timestamp and a host:port
 * authority contain — hence the two substitutions. The timestamp keeps ISO
 * field order so the files sort chronologically by name.
 */
export function buildFilename(now: Date, hostname: string): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const safeHost = hostname.replace(/[^a-zA-Z0-9.-]/g, '-')
  return `full-page-shot/${safeHost}-${stamp}.png`
}

function coerceCaptureMode(value: unknown): CaptureMode {
  return value === 'full' || value === 'viewport' ? value : DEFAULT_PREFS.captureMode
}

function coerceScale(value: unknown): Scale {
  return value === 1 || value === 2 ? value : DEFAULT_PREFS.scale
}

function coerceDownloadFormat(value: unknown): DownloadFormat {
  return value === 'png' || value === 'jpeg' || value === 'webp' ? value : DEFAULT_PREFS.downloadFormat
}

export async function loadPrefs(): Promise<Prefs> {
  // Passing DEFAULT_PREFS as the `get` argument makes Chrome fill in any key
  // the user has never set, so the result always has every field — but a
  // 1.0.0 user's stored object only has the two booleans, and any stored
  // value could in principle be garbage (a future downgrade, manual edits to
  // sync storage, etc.), so every field is still coerced explicitly rather
  // than trusted as-is.
  const stored = (await chrome.storage.sync.get(DEFAULT_PREFS)) as Partial<Prefs>
  return {
    toClipboard: !!stored.toClipboard,
    toDownload: !!stored.toDownload,
    captureMode: coerceCaptureMode(stored.captureMode),
    scale: coerceScale(stored.scale),
    downloadFormat: coerceDownloadFormat(stored.downloadFormat),
  }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await chrome.storage.sync.set(prefs)
}
