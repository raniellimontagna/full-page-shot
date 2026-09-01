import { useEffect, useState } from 'react'
import type { Prefs } from '../shared/prefs'

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
    </main>
  )
}
