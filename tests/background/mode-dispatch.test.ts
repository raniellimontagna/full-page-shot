import { describe, expect, it } from 'vitest'
// `?raw` for the same reason as `build-entries.test.ts`: importing the service
// worker's entry would register its Chrome listeners, and there is no Chrome
// here. What is asserted is the wiring in the source text -- the table both
// listeners dispatch through, and the menu items that feed it.
import backgroundSource from '../../src/background/index.ts?raw'
import manifest from '../../src/manifest.config'

/** `const MENU_FULL = 'capture-full'` → `MENU_FULL` ⇒ `capture-full`. */
const menuIds = new Map<string, string>(
  [...backgroundSource.matchAll(/const (MENU_[A-Z_]+) = '([^']+)'/g)].map((match) => [
    match[1] ?? '',
    match[2] ?? '',
  ]),
)

/** The `MODE_BY_ID` literal, resolved through the constants above. */
const modeById = new Map<string, string>(
  [
    ...(/const MODE_BY_ID: Record<string, CaptureMode> = \{([^}]*)\}/.exec(backgroundSource)?.[1] ??
      ''
    ).matchAll(/\[(MENU_[A-Z_]+)\]:\s*'([a-z]+)'/g),
  ].map((match) => [menuIds.get(match[1] ?? '') ?? '', match[2] ?? '']),
)

describe('mode dispatch', () => {
  it('maps each menu id to the mode it names', () => {
    expect(Object.fromEntries(modeById)).toEqual({
      'capture-full': 'full',
      'capture-viewport': 'viewport',
      'capture-selection': 'selection',
    })
  })

  // The command listener looks the command name up in the *same* table as the
  // context-menu listener, so a command the table does not know is silently
  // inert: the shortcut fires, `MODE_BY_ID[command]` is undefined, and the
  // listener returns without capturing anything. Nothing else would catch it.
  it('knows every custom command the manifest declares', () => {
    const custom = Object.keys(manifest.commands ?? {}).filter((name) => !name.startsWith('_'))
    expect(custom.sort()).toEqual(['capture-selection', 'capture-viewport'])
    for (const command of custom) expect(modeById.has(command)).toBe(true)
  })

  // The toolbar click names no mode and must keep taking the user's default
  // (`resolveCaptureMode(undefined, prefs)`); only the menu items and the two
  // custom shortcuts override it. A `_execute_action` entry in the table would
  // never fire anyway -- Chrome routes it to `action.onClicked` -- but its
  // presence would mean someone had wired the default click to a fixed mode.
  it('leaves the default-mode entry point out of the table', () => {
    expect(modeById.has('_execute_action')).toBe(false)
  })

  it('offers area selection as a third item on the action menu', () => {
    const create =
      /chrome\.contextMenus\.removeAll\(\(\) => \{([\s\S]*?)\n {2}\}\)/.exec(backgroundSource)?.[1] ??
      ''
    expect(create).toContain('MENU_SELECTION')
    expect(create).toContain("title: 'Capture selected area'")
    // On the toolbar icon only: the extension adds nothing to a right-click in
    // the page the user is reading.
    expect([...create.matchAll(/contexts: \['action'\]/g)]).toHaveLength(3)
  })
})
