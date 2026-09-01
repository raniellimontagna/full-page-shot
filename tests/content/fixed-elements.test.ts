import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hideFixedElements, restoreFixedElements } from '../../src/content/fixed-elements'

function setup(html: string) {
  document.body.innerHTML = html
}

function attachShadowHost(parent: ParentNode = document.body): ShadowRoot {
  const host = document.createElement('div')
  parent.appendChild(host)
  return host.attachShadow({ mode: 'open' })
}

describe('fixed elements', () => {
  beforeEach(() => setup(''))
  afterEach(() => {
    document.body.removeAttribute('style')
    document.documentElement.removeAttribute('style')
  })

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

  it('hides a fixed element inside a shadow root', () => {
    const shadow = attachShadowHost()
    shadow.innerHTML = '<header id="h" style="position: fixed">nav</header>'
    hideFixedElements(document)
    expect(shadow.querySelector<HTMLElement>('#h')!.style.visibility).toBe('hidden')
  })

  it('restores a fixed element inside a shadow root with the exact previous inline visibility', () => {
    const shadow = attachShadowHost()
    shadow.innerHTML = '<header id="h" style="position: fixed; visibility: visible">nav</header>'
    hideFixedElements(document)
    restoreFixedElements(document)
    expect(shadow.querySelector<HTMLElement>('#h')!.style.visibility).toBe('visible')
  })

  it('reaches fixed elements inside nested shadow roots', () => {
    const outerShadow = attachShadowHost()
    const innerShadow = attachShadowHost(outerShadow)
    innerShadow.innerHTML = '<header id="h" style="position: fixed">nav</header>'
    hideFixedElements(document)
    expect(innerShadow.querySelector<HTMLElement>('#h')!.style.visibility).toBe('hidden')
  })

  it('hides and restores <body> itself when it is position:fixed', () => {
    setup('<p>text</p>')
    document.body.style.position = 'fixed'
    hideFixedElements(document)
    expect(document.body.style.visibility).toBe('hidden')
    restoreFixedElements(document)
    expect(document.body.style.visibility).toBe('')
  })

  it('is idempotent when restore runs without hide, with a shadow-DOM element present', () => {
    const shadow = attachShadowHost()
    shadow.innerHTML = '<header id="h" style="position: fixed">nav</header>'
    expect(() => restoreFixedElements(document)).not.toThrow()
    expect(shadow.querySelector<HTMLElement>('#h')!.style.visibility).toBe('')
  })

  it('is idempotent when restore runs twice, with a shadow-DOM element present', () => {
    const shadow = attachShadowHost()
    shadow.innerHTML = '<header id="h" style="position: fixed; visibility: visible">nav</header>'
    hideFixedElements(document)
    restoreFixedElements(document)
    restoreFixedElements(document)
    expect(shadow.querySelector<HTMLElement>('#h')!.style.visibility).toBe('visible')
  })
})
