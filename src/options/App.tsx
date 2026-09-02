import { useEffect, useState } from 'react'
import type { CaptureMode, DownloadFormat, Prefs, Scale } from '../shared/prefs'

interface Props {
  load: () => Promise<Prefs>
  save: (prefs: Prefs) => Promise<void>
}

export function App({ load, save }: Props) {
  const [prefs, setPrefs] = useState<Prefs | null>(null)

  useEffect(() => {
    void load().then(setPrefs)
  }, [load])

  if (!prefs) return <p>Loading…</p>

  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    void save(next)
  }

  return (
    <main>
      <h1>Full Page Shot</h1>
      <p>What happens after a capture:</p>

      <label>
        <input
          type="checkbox"
          checked={prefs.toClipboard}
          onChange={(e) => update({ toClipboard: e.target.checked })}
        />
        Copy to clipboard
      </label>

      <label>
        <input
          type="checkbox"
          checked={prefs.toDownload}
          onChange={(e) => update({ toDownload: e.target.checked })}
        />
        Save as a PNG download
      </label>

      {!prefs.toClipboard && !prefs.toDownload && (
        <p role="alert">Pick at least one output, or the capture goes nowhere.</p>
      )}

      <fieldset>
        <legend>Capture mode</legend>
        <label>
          <input
            type="radio"
            name="captureMode"
            value="full"
            checked={prefs.captureMode === 'full'}
            onChange={() => update({ captureMode: 'full' as CaptureMode })}
          />
          Full page
        </label>
        <label>
          <input
            type="radio"
            name="captureMode"
            value="viewport"
            checked={prefs.captureMode === 'viewport'}
            onChange={() => update({ captureMode: 'viewport' as CaptureMode })}
          />
          Visible area
        </label>
        <label>
          <input
            type="radio"
            name="captureMode"
            value="selection"
            checked={prefs.captureMode === 'selection'}
            onChange={() => update({ captureMode: 'selection' as CaptureMode })}
          />
          Selected area
        </label>
      </fieldset>

      <fieldset>
        <legend>Image scale</legend>
        <label>
          <input
            type="radio"
            name="scale"
            value="1"
            checked={prefs.scale === 1}
            onChange={() => update({ scale: 1 as Scale })}
          />
          1× (smaller files)
        </label>
        <label>
          <input
            type="radio"
            name="scale"
            value="2"
            checked={prefs.scale === 2}
            onChange={() => update({ scale: 2 as Scale })}
          />
          2× (Retina)
        </label>
      </fieldset>

      <fieldset>
        <legend>Download format</legend>
        <label>
          <input
            type="radio"
            name="downloadFormat"
            value="png"
            checked={prefs.downloadFormat === 'png'}
            onChange={() => update({ downloadFormat: 'png' as DownloadFormat })}
          />
          PNG
        </label>
        <label>
          <input
            type="radio"
            name="downloadFormat"
            value="jpeg"
            checked={prefs.downloadFormat === 'jpeg'}
            onChange={() => update({ downloadFormat: 'jpeg' as DownloadFormat })}
          />
          JPEG
        </label>
        <label>
          <input
            type="radio"
            name="downloadFormat"
            value="webp"
            checked={prefs.downloadFormat === 'webp'}
            onChange={() => update({ downloadFormat: 'webp' as DownloadFormat })}
          />
          WebP
        </label>
        <p>The clipboard always uses PNG, regardless of this setting.</p>
      </fieldset>
    </main>
  )
}
