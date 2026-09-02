import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFS, buildFilename, isCapturableUrl, loadPrefs } from '../../src/shared/prefs'

describe('DEFAULT_PREFS', () => {
  it('downloads and copies by default, full page, 1x, png', () => {
    expect(DEFAULT_PREFS).toEqual({
      toClipboard: true,
      toDownload: true,
      captureMode: 'full',
      scale: 1,
      downloadFormat: 'png',
    })
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

describe('loadPrefs', () => {
  function mockStorage(stored: Record<string, unknown>) {
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: vi.fn(async (defaults: Record<string, unknown>) => ({ ...defaults, ...stored })),
        },
      },
    })
  }

  it('returns defaults when nothing is stored', async () => {
    mockStorage({})
    await expect(loadPrefs()).resolves.toEqual(DEFAULT_PREFS)
  })

  it('merges a 1.0.0 upgrade — only the two booleans stored — with the new defaults', async () => {
    mockStorage({ toClipboard: false, toDownload: true })
    await expect(loadPrefs()).resolves.toEqual({
      toClipboard: false,
      toDownload: true,
      captureMode: 'full',
      scale: 1,
      downloadFormat: 'png',
    })
  })

  it('coerces invalid stored values back to defaults', async () => {
    mockStorage({
      captureMode: 'zoomed',
      scale: 4,
      downloadFormat: 'bmp',
    })
    await expect(loadPrefs()).resolves.toEqual({
      toClipboard: true,
      toDownload: true,
      captureMode: 'full',
      scale: 1,
      downloadFormat: 'png',
    })
  })
})
