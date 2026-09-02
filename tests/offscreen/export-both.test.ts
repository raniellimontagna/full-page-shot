import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { exportBoth as ExportBoth, Exportable } from '../../src/offscreen/index'
import type { ExportRequestFields } from '../../src/shared/messages'

/**
 * `src/offscreen/index.ts` registers a `chrome.runtime.onMessage` listener
 * at module scope, so it cannot be statically imported in plain Node --
 * `chrome` does not exist there. Stub it before a dynamic import, the same
 * pattern `tests/content/index.test.ts` uses for the content script.
 */
/**
 * `blobToDataUrl` reads the fake blob through `FileReader`, which -- like
 * `chrome` -- does not exist in plain Node. The exact data URL value is
 * irrelevant to this test; only how many times `Stitcher.export` was called
 * matters, so this stub just needs to resolve with something string-shaped.
 */
class FakeFileReader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(blob: Blob): void {
    void blob
    this.result = 'data:image/png;base64,fake'
    queueMicrotask(() => this.onload?.())
  }
}

async function loadExportBoth(): Promise<typeof ExportBoth> {
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener: vi.fn() } } })
  vi.stubGlobal('FileReader', FakeFileReader)
  vi.resetModules()
  const mod = await import('../../src/offscreen/index')
  return mod.exportBoth
}

// Guards the single-encode contract that e2e/modes-and-size.spec.ts's
// `toBe(probe.clipboardDataUrl)` assertion cannot: PNG encoding of a given
// canvas is deterministic, so encoding twice would produce the identical
// string and that e2e assertion would still pass. Only counting calls to
// `Stitcher.export` -- which this fake does -- can tell "encoded once, handed
// back twice" apart from "encoded twice, byte-for-byte the same both times".

function fakeStitcher(): { stitcher: Exportable; exportSpy: ReturnType<typeof vi.fn> } {
  const exportSpy = vi.fn(async () => new Blob(['x']))
  return { stitcher: { export: exportSpy }, exportSpy }
}

const baseFields: Omit<ExportRequestFields, 'downloadFormat'> = {
  scale: 1,
  devicePixelRatio: 1,
}

describe('exportBoth', () => {
  let exportBoth: typeof ExportBoth

  beforeEach(async () => {
    exportBoth = await loadExportBoth()
  })

  it('encodes once when downloadFormat is png, and hands the same string to both sinks', async () => {
    const { stitcher, exportSpy } = fakeStitcher()

    const response = await exportBoth(stitcher, { ...baseFields, downloadFormat: 'png' })

    expect(exportSpy).toHaveBeenCalledTimes(1)
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.downloadDataUrl).toBe(response.clipboardDataUrl)
    }
  })

  it('encodes twice when downloadFormat is jpeg: once for the PNG clipboard, once for the lossy download', async () => {
    const { stitcher, exportSpy } = fakeStitcher()

    const response = await exportBoth(stitcher, { ...baseFields, downloadFormat: 'jpeg' })

    expect(exportSpy).toHaveBeenCalledTimes(2)
    expect(exportSpy.mock.calls[0]?.[0]).toMatchObject({ format: 'png' })
    expect(exportSpy.mock.calls[1]?.[0]).toMatchObject({ format: 'jpeg' })
    expect(response.ok).toBe(true)
  })
})
