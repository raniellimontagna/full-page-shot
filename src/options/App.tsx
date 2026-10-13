import { useEffect, useState, type ReactNode } from 'react'
import type { CaptureMode, DownloadFormat, Prefs, Scale } from '../shared/prefs'
import type { ShortcutRow } from './shortcuts'

const REPO_URL = 'https://github.com/raniellimontagna/full-page-shot'

interface Props {
  load: () => Promise<Prefs>
  save: (prefs: Prefs) => Promise<void>
  /** Omitted outside the extension (tests, previews): the section is then left out. */
  loadShortcuts?: () => Promise<ShortcutRow[]>
  openShortcutSettings?: () => void
  version?: string
}

const MODES: ReadonlyArray<{ value: CaptureMode; title: string; description: string; glyph: ReactNode }> = [
  {
    value: 'full',
    title: 'Full page',
    description: 'Top to bottom, stitched into one image.',
    glyph: (
      <>
        <rect x="24" y="3" width="24" height="42" rx="3" />
        <path d="M29 10h14M29 15h10M29 21h14M29 26h8M29 32h14M29 37h11" opacity=".55" />
        <path d="M18 6V3h4M54 6V3h-4M18 42v3h4M54 42v3h-4" strokeWidth="2" />
      </>
    ),
  },
  {
    value: 'viewport',
    title: 'Visible area',
    description: "What's on screen right now, in one frame.",
    glyph: (
      <>
        <rect x="24" y="3" width="24" height="42" rx="3" opacity=".35" strokeDasharray="2 3" />
        <rect x="14" y="14" width="44" height="20" rx="3" />
        <path d="M20 21h20M20 27h14" opacity=".55" />
      </>
    ),
  },
  {
    value: 'selection',
    title: 'Selected area',
    description: 'Drag a rectangle and keep only that part.',
    glyph: (
      <>
        <rect x="10" y="6" width="52" height="36" rx="3" opacity=".35" />
        <rect x="20" y="13" width="26" height="17" rx="1.5" strokeDasharray="3 2.5" />
        <path d="m44 28 9 9-4 .6 2.3 4.4-2 1-2.3-4.4-3 2.6z" fill="currentColor" stroke="none" />
      </>
    ),
  },
]

const SCALES: ReadonlyArray<{ value: Scale; label: string }> = [
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
]

const FORMATS: ReadonlyArray<{ value: DownloadFormat; label: string }> = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
]

export function App({ load, save, loadShortcuts, openShortcutSettings, version }: Props) {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [shortcuts, setShortcuts] = useState<ShortcutRow[] | null>(null)

  useEffect(() => {
    void load().then(setPrefs)
  }, [load])

  useEffect(() => {
    if (loadShortcuts) void loadShortcuts().then(setShortcuts)
  }, [loadShortcuts])

  if (!prefs) return <main className="page" aria-busy="true" />

  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    void save(next)
  }

  return (
    <main className="page">
      <header className="masthead">
        <img src="/icons/icon.svg" alt="" width="44" height="44" />
        <div>
          <h1>Full Page Shot</h1>
          <p>Options · changes save as you make them</p>
        </div>
        {version && <span className="version">v{version}</span>}
      </header>

      <section aria-labelledby="h-after">
        <div className="section-head">
          <h2 id="h-after">After a capture</h2>
        </div>
        <div className="panel">
          <Toggle
            id="clipboard"
            title="Copy to clipboard"
            description="Always a PNG, ready to paste into any app."
            checked={prefs.toClipboard}
            onChange={(checked) => update({ toClipboard: checked })}
          />
          <Toggle
            id="download"
            title="Save as a download"
            description="Goes to your Downloads folder, in the format chosen below."
            checked={prefs.toDownload}
            onChange={(checked) => update({ toDownload: checked })}
          />
        </div>
        {!prefs.toClipboard && !prefs.toDownload && (
          <p className="alert" role="alert">
            Pick at least one output, or the capture goes nowhere.
          </p>
        )}
      </section>

      <section>
        <fieldset>
          <legend className="section-head">
            <h2>Default capture mode</h2>
            <span>Toolbar click and the main shortcut</span>
          </legend>
          <div className="modes">
            {MODES.map((mode) => (
              <label className="mode" key={mode.value}>
                <input
                  type="radio"
                  name="captureMode"
                  value={mode.value}
                  checked={prefs.captureMode === mode.value}
                  onChange={() => update({ captureMode: mode.value })}
                  aria-labelledby={`mode-${mode.value}`}
                  aria-describedby={`mode-${mode.value}-desc`}
                />
                <span className="mode-body">
                  <span className="glyph" aria-hidden="true">
                    <svg viewBox="0 0 72 48" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      {mode.glyph}
                    </svg>
                  </span>
                  <span className="mode-title">
                    <span id={`mode-${mode.value}`}>{mode.title}</span>
                    <span className="check" aria-hidden="true">
                      <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M2 5.2 4.2 7.3 8 3" />
                      </svg>
                    </span>
                  </span>
                  <span className="mode-desc" id={`mode-${mode.value}-desc`}>
                    {mode.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section aria-labelledby="h-image">
        <div className="section-head">
          <h2 id="h-image">Image</h2>
        </div>
        <div className="panel">
          <Segmented
            name="scale"
            title="Scale"
            hint="1× keeps files small. 2× keeps every pixel on a Retina screen."
            options={SCALES}
            value={prefs.scale}
            onChange={(scale) => update({ scale })}
          />
          <Segmented
            name="downloadFormat"
            title="Download format"
            hint="The clipboard always uses PNG, regardless of this setting."
            options={FORMATS}
            value={prefs.downloadFormat}
            onChange={(downloadFormat) => update({ downloadFormat })}
          />
        </div>
      </section>

      {shortcuts && (
        <section aria-labelledby="h-keys">
          <div className="section-head">
            <h2 id="h-keys">Keyboard shortcuts</h2>
            {openShortcutSettings && (
              <button className="link" type="button" onClick={openShortcutSettings}>
                Change shortcuts
              </button>
            )}
          </div>
          <div className="panel">
            <ul className="shortcuts" aria-labelledby="h-keys">
              {shortcuts.map((row) => (
                <li key={row.id}>
                  <span>{row.label}</span>
                  {row.keys.length > 0 ? (
                    <span className="keys">
                      {row.keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </span>
                  ) : (
                    <span className="unset">Not set</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <footer>
        <span className="note">Settings sync through your Chrome profile. Captures never leave your browser.</span>
        <nav aria-label="Project links">
          <a href={`${REPO_URL}/blob/main/docs/store/privacy-policy.md`} target="_blank" rel="noreferrer">
            Privacy
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source
          </a>
          <a href={`${REPO_URL}/issues/new`} target="_blank" rel="noreferrer">
            Report an issue
          </a>
        </nav>
      </footer>
    </main>
  )
}

interface ToggleProps {
  id: string
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}

// A native checkbox drawn as a switch, so the label, keyboard handling and
// form semantics stay the browser's own.
function Toggle({ id, title, description, checked, onChange }: ToggleProps) {
  return (
    <label className="row">
      <span className="row-text">
        <span className="row-title" id={`${id}-title`}>
          {title}
        </span>
        <span className="row-desc" id={`${id}-desc`}>
          {description}
        </span>
      </span>
      <input
        className="switch"
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
      />
    </label>
  )
}

interface SegmentedProps<T extends string | number> {
  name: string
  title: string
  hint: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}

// A radio group styled as a segmented control; each option keeps a plain
// `<label>` so its accessible name is exactly the visible text ("PNG", "2×").
// The group is named by a visually hidden `<legend>` rather than
// `aria-labelledby`: a legend names its fieldset without giving the group a
// label of its own, so "Download format" never competes with the download
// switch for the name "download".
function Segmented<T extends string | number>({ name, title, hint, options, value, onChange }: SegmentedProps<T>) {
  return (
    <fieldset className="setting" aria-describedby={`${name}-hint`}>
      <legend className="visually-hidden">{title}</legend>
      <div>
        <span className="row-title" aria-hidden="true">
          {title}
        </span>
        <p className="setting-hint" id={`${name}-hint`}>
          {hint}
        </p>
      </div>
      <div className="seg">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
