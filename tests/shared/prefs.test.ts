import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFS,
  buildFilename,
  isCapturableUrl,
  loadPrefs,
  resolveCaptureMode,
} from '../../src/shared/prefs'

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
  const full = { mode: 'full', format: 'png' } as const

  it('includes the hostname and a sortable timestamp', () => {
    const name = buildFilename(new Date('2026-09-01T14:05:09Z'), 'example.com', full)
    expect(name).toBe('full-page-shot/example.com-2026-09-01T14-05-09.png')
  })

  it('sanitises a hostname with characters illegal in filenames', () => {
    const name = buildFilename(new Date('2026-09-01T00:00:00Z'), 'sub.example.com:8443', full)
    expect(name).toBe('full-page-shot/sub.example.com-8443-2026-09-01T00-00-00.png')
  })

  // The suffix is what tells a viewport shot apart from a full-page one of the
  // same page in the same second, which is otherwise indistinguishable on disk.
  it('marks a viewport capture with a suffix', () => {
    const name = buildFilename(new Date('2026-09-01T14:05:09Z'), 'example.com', {
      mode: 'viewport',
      format: 'png',
    })
    expect(name).toBe('full-page-shot/example.com-2026-09-01T14-05-09-viewport.png')
  })

  it.each([
    ['png', '.png'],
    ['jpeg', '.jpg'],
    ['webp', '.webp'],
  ] as const)('uses the extension of the %s download format', (format, extension) => {
    const name = buildFilename(new Date('2026-09-01T14:05:09Z'), 'example.com', {
      mode: 'full',
      format,
    })
    expect(name.endsWith(extension)).toBe(true)
  })

  it('puts the mode suffix before the extension', () => {
    const name = buildFilename(new Date('2026-09-01T14:05:09Z'), 'example.com', {
      mode: 'viewport',
      format: 'jpeg',
    })
    expect(name).toBe('full-page-shot/example.com-2026-09-01T14-05-09-viewport.jpg')
  })

  // Same reasoning as the viewport suffix: without it a selection shot and a
  // full-page (or viewport) shot of the same host in the same second are
  // indistinguishable on disk.
  it.each([
    ['png', '.png'],
    ['jpeg', '.jpg'],
    ['webp', '.webp'],
  ] as const)('marks a selection capture with a suffix before the %s extension', (format, extension) => {
    const name = buildFilename(new Date('2026-09-01T14:05:09Z'), 'example.com', {
      mode: 'selection',
      format,
    })
    expect(name).toBe(`full-page-shot/example.com-2026-09-01T14-05-09-selection${extension}`)
  })
})

describe('resolveCaptureMode', () => {
  it('falls back to the stored preference when no mode was requested', () => {
    expect(resolveCaptureMode(undefined, { ...DEFAULT_PREFS, captureMode: 'viewport' })).toBe(
      'viewport',
    )
  })

  // The right-click menu and the second shortcut both name a mode explicitly,
  // and that choice is a deliberate override of the default -- not a hint.
  it('prefers an explicit mode over the stored preference', () => {
    expect(resolveCaptureMode('full', { ...DEFAULT_PREFS, captureMode: 'viewport' })).toBe('full')
    expect(resolveCaptureMode('viewport', { ...DEFAULT_PREFS, captureMode: 'full' })).toBe(
      'viewport',
    )
    expect(resolveCaptureMode('selection', { ...DEFAULT_PREFS, captureMode: 'full' })).toBe(
      'selection',
    )
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

  it('lets a stored "selection" capture mode survive coercion', async () => {
    mockStorage({ captureMode: 'selection' })
    const prefs = await loadPrefs()
    expect(prefs.captureMode).toBe('selection')
  })

  it('falls back a garbage capture mode to "full", not "selection"', async () => {
    mockStorage({ captureMode: 'not-a-mode' })
    const prefs = await loadPrefs()
    expect(prefs.captureMode).toBe('full')
  })
})
