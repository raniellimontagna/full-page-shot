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

  // The toolbar click, and its `_execute_action` shortcut, must keep taking the
  // user's default: `captureTab(tab)` with no mode, which is what makes
  // `resolveCaptureMode(undefined, prefs)` fall through to the preference. Pass
  // a mode here and the options page's capture-mode setting silently stops
  // meaning anything for the one entry point most users ever touch -- and every
  // test in this suite would still pass, because all three modes work.
  it('leaves the toolbar click on the user default', () => {
    const listener =
      /chrome\.action\.onClicked\.addListener\(\(tab\) => \{([\s\S]*?)\n\}\)/.exec(
        backgroundSource,
      )?.[1] ?? ''
    expect(listener).toContain('captureTab(tab)')
    expect(listener).not.toMatch(/captureTab\(tab,/)
  })

  // The cancel branch of `runOneCapture`. `badgeForCancelledCapture` is proven
  // neutral by the sinks suite, but nothing else proves the worker *calls* it:
  // swap it for `BADGE_FAILURE` and every other test in the project still
  // passes while every cancelled selection shows a red ✕ -- the one thing the
  // "cancel is not failure" rule forbids.
  it('badges a cancelled selection as neutral, never as a failure', () => {
    const branch =
      /if \(outcome\.status === 'cancelled'\) \{([\s\S]*?)\n {6}\}/.exec(backgroundSource)?.[1] ??
      ''
    expect(branch).toContain('badgeForCancelledCapture()')
    expect(branch).not.toContain('BADGE_FAILURE')
    // And it leaves: a cancel delivers nothing, so it must not fall through to
    // the filename, the sinks and the delivery badge below it.
    expect(branch).toMatch(/\breturn\b/)
  })

  it('returns from a cancelled selection before anything is delivered', () => {
    const cancelAt = backgroundSource.indexOf("outcome.status === 'cancelled'")
    const deliverAt = backgroundSource.indexOf('await deliverImages(')
    expect(cancelAt).toBeGreaterThan(-1)
    expect(deliverAt).toBeGreaterThan(cancelAt)

    // Position alone proves nothing: this would still pass with no `return`
    // anywhere in the file, or with one sitting outside the cancelled branch
    // entirely -- either way the cancel would silently fall through into
    // delivery. A `return` must actually appear in the stretch between the
    // two, not merely somewhere before `deliverImages`.
    const between = backgroundSource.slice(cancelAt, deliverAt)
    expect(between).toMatch(/\breturn\b/)
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
