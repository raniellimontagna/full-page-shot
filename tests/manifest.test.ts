import { describe, expect, it } from 'vitest'
import manifest from '../src/manifest.config'

describe('manifest', () => {
  it('targets Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3)
  })

  it('requests exactly the permissions the spec allows', () => {
    expect([...(manifest.permissions ?? [])].sort()).toEqual(
      ['activeTab', 'clipboardWrite', 'downloads', 'offscreen', 'scripting', 'storage'].sort(),
    )
  })

  it('never requests the debugger permission', () => {
    expect(manifest.permissions).not.toContain('debugger')
  })

  it('does not declare static content scripts', () => {
    expect(manifest).not.toHaveProperty('content_scripts')
  })
})
