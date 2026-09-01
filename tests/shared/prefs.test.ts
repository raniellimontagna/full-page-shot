import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, buildFilename, isCapturableUrl } from '../../src/shared/prefs'

describe('DEFAULT_PREFS', () => {
  it('downloads and copies by default', () => {
    expect(DEFAULT_PREFS).toEqual({ toClipboard: true, toDownload: true })
  })
})

describe('isCapturableUrl', () => {
  it('accepts http and https pages', () => {
    expect(isCapturableUrl('https://example.com')).toBe(true)
    expect(isCapturableUrl('http://example.com')).toBe(true)
  })

  it.each([
    'chrome://extensions',
    'chrome-extension://abc/page.html',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
    'devtools://devtools/bundled/x.html',
    'about:blank',
    'file:///Users/me/doc.pdf',
  ])('rejects %s', (url) => {
    expect(isCapturableUrl(url)).toBe(false)
  })

  it('rejects an undefined url', () => {
    expect(isCapturableUrl(undefined)).toBe(false)
  })
})

describe('buildFilename', () => {
  it('includes the hostname and a sortable timestamp', () => {
    const name = buildFilename(new Date('2026-09-01T14:05:09Z'), 'example.com')
    expect(name).toBe('full-page-shot/example.com-2026-09-01T14-05-09.png')
  })

  it('sanitises a hostname with characters illegal in filenames', () => {
    const name = buildFilename(new Date('2026-09-01T00:00:00Z'), 'sub.example.com:8443')
    expect(name).toBe('full-page-shot/sub.example.com-8443-2026-09-01T00-00-00.png')
  })
})
