import { beforeEach, describe, expect, it } from 'vitest'
import { hideFixedElements, restoreFixedElements } from '../../src/content/fixed-elements'

function setup(html: string) {
  document.body.innerHTML = html
}

describe('fixed elements', () => {
  beforeEach(() => setup(''))

  it('hides a position:fixed element', () => {
    setup('<header id="h" style="position: fixed">nav</header>')
    hideFixedElements(document)
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('hidden')
  })

  it('hides a position:sticky element', () => {
    setup('<div id="s" style="position: sticky">bar</div>')
    hideFixedElements(document)
    expect(document.querySelector<HTMLElement>('#s')!.style.visibility).toBe('hidden')
  })

  it('leaves static elements untouched', () => {
    setup('<p id="p">text</p>')
    hideFixedElements(document)
    expect(document.querySelector<HTMLElement>('#p')!.style.visibility).toBe('')
  })

  it('restores the exact previous inline visibility', () => {
    setup('<header id="h" style="position: fixed; visibility: visible">nav</header>')
    hideFixedElements(document)
    restoreFixedElements(document)
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('visible')
  })

  it('restores an element that had no inline visibility to empty', () => {
    setup('<header id="h" style="position: fixed">nav</header>')
    hideFixedElements(document)
    restoreFixedElements(document)
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('')
  })

  it('is idempotent when restore runs without hide', () => {
    setup('<header id="h" style="position: fixed">nav</header>')
    expect(() => restoreFixedElements(document)).not.toThrow()
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('')
  })

  it('is idempotent when restore runs twice', () => {
    setup('<header id="h" style="position: fixed; visibility: visible">nav</header>')
    hideFixedElements(document)
    restoreFixedElements(document)
    restoreFixedElements(document)
    expect(document.querySelector<HTMLElement>('#h')!.style.visibility).toBe('visible')
  })
})
