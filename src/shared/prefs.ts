export interface Prefs {
  toClipboard: boolean
  toDownload: boolean
}

export const DEFAULT_PREFS: Prefs = { toClipboard: true, toDownload: true }

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

export async function loadPrefs(): Promise<Prefs> {
  // Passing DEFAULT_PREFS as the `get` argument makes Chrome fill in any key
  // the user has never set, so the result always has both fields.
  const stored = (await chrome.storage.sync.get(DEFAULT_PREFS)) as Partial<Prefs>
  return { toClipboard: !!stored.toClipboard, toDownload: !!stored.toDownload }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await chrome.storage.sync.set(prefs)
}
