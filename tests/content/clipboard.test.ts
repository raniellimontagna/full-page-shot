import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyDataUrlToClipboard } from '../../src/content/clipboard'

const DATA_URL = 'data:image/png;base64,AAAA'

interface WrittenItem {
  data: Record<string, Blob>
}

/**
 * jsdom has neither `ClipboardItem` nor `navigator.clipboard`, so both are
 * stubbed. What is being pinned here is the *shape* of the call — a PNG blob,
 * decoded from the data URL, handed to `navigator.clipboard.write` — because
 * that shape is what makes the image land on the clipboard as an image rather
 * than as text.
 */
function stubClipboard(options: { write?: () => Promise<void> } = {}): {
  written: WrittenItem[]
  fetched: string[]
} {
  const written: WrittenItem[] = []
  const fetched: string[] = []

  vi.stubGlobal(
    'ClipboardItem',
    class {
      data: Record<string, Blob>
      constructor(data: Record<string, Blob>) {
        this.data = data
      }
    },
  )
  vi.stubGlobal('fetch', async (input: string) => {
    fetched.push(input)
    return { blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) }
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: vi.fn(async (items: WrittenItem[]) => {
        written.push(...items)
        if (options.write) await options.write()
      }),
    },
  })

  return { written, fetched }
}

describe('copyDataUrlToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('writes the decoded PNG to the clipboard as an image', async () => {
    const { written, fetched } = stubClipboard()
    await copyDataUrlToClipboard(DATA_URL)

    expect(fetched).toEqual([DATA_URL])
    expect(written).toHaveLength(1)
    const blob = written[0]?.data['image/png']
    expect(blob).toBeInstanceOf(Blob)
    expect(blob?.type).toBe('image/png')
    expect(await blob?.arrayBuffer().then((b) => b.byteLength)).toBe(3)
  })

  // The caller turns this into a named sink failure and a badge the user can
  // act on, so it must not be swallowed here.
  it('propagates a refused clipboard write', async () => {
    stubClipboard({
      write: () => Promise.reject(new Error('NotAllowedError: Document is not focused')),
    })
    await expect(copyDataUrlToClipboard(DATA_URL)).rejects.toThrow(/Document is not focused/)
  })
})
