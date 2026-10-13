import { describe, expect, it } from 'vitest'
import { splitShortcut, toShortcutRows } from '../../src/options/shortcuts'

describe('splitShortcut', () => {
  it('splits the Windows/Linux "+"-joined form', () => {
    expect(splitShortcut('Ctrl+Shift+Y')).toEqual(['Ctrl', 'Shift', 'Y'])
  })

  it('splits the macOS symbol form into one key per modifier', () => {
    expect(splitShortcut('⇧⌘Y')).toEqual(['⇧', '⌘', 'Y'])
  })

  it('keeps a multi-character key whole on macOS', () => {
    expect(splitShortcut('⌥⌘Space')).toEqual(['⌥', '⌘', 'Space'])
  })

  it('returns no keys for an unassigned command', () => {
    expect(splitShortcut('')).toEqual([])
    expect(splitShortcut(undefined)).toEqual([])
  })
})

describe('toShortcutRows', () => {
  it('labels the three capture commands in a fixed order, whatever order Chrome returns', () => {
    const rows = toShortcutRows([
      { name: 'capture-selection', shortcut: '' },
      { name: '_execute_action', shortcut: 'Ctrl+Shift+Y' },
      { name: 'capture-viewport', shortcut: 'Ctrl+Shift+U' },
    ])

    expect(rows).toEqual([
      { id: '_execute_action', label: 'Capture with the default mode', keys: ['Ctrl', 'Shift', 'Y'] },
      { id: 'capture-viewport', label: 'Capture visible area', keys: ['Ctrl', 'Shift', 'U'] },
      { id: 'capture-selection', label: 'Capture selected area', keys: [] },
    ])
  })

  it('ignores commands it does not know about', () => {
    expect(toShortcutRows([{ name: 'something-else', shortcut: 'Ctrl+Shift+K' }])).toEqual([])
  })
})
