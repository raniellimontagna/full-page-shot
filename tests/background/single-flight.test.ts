import { describe, expect, it } from 'vitest'
import { createSingleFlight } from '../../src/background/single-flight'

/** A body that stays pending until the test releases it. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('createSingleFlight', () => {
  it('runs the body exactly once when two captures overlap', async () => {
    const runExclusive = createSingleFlight()
    const gate = deferred()
    let runs = 0
    let rejected = 0

    const first = runExclusive(async () => {
      runs += 1
      await gate.promise
    }, async () => {
      rejected += 1
    })

    // The second click lands while the first capture is still mid-flight --
    // the double-click case, and the two-windows case, both of which used to
    // put two captures on one offscreen canvas.
    await runExclusive(async () => {
      runs += 1
    }, async () => {
      rejected += 1
    })

    expect(runs).toBe(1)
    expect(rejected).toBe(1)

    gate.release()
    await first
  })

  it('lets the next capture through once the first one finishes', async () => {
    const runExclusive = createSingleFlight()
    let runs = 0
    const body = async (): Promise<void> => {
      runs += 1
    }
    const busy = async (): Promise<void> => {
      throw new Error('should not be busy')
    }

    await runExclusive(body, busy)
    await runExclusive(body, busy)

    expect(runs).toBe(2)
  })

  it('releases the lock when the body throws', async () => {
    const runExclusive = createSingleFlight()
    let runs = 0

    await expect(
      runExclusive(async () => {
        runs += 1
        throw new Error('capture failed')
      }, async () => {}),
    ).rejects.toThrow('capture failed')

    // Without the `finally`, one failed capture wedges the toolbar button for
    // the rest of the service worker's life.
    await runExclusive(async () => {
      runs += 1
    }, async () => {
      throw new Error('lock was never released')
    })

    expect(runs).toBe(2)
  })

  it('never touches the page on a rejected capture', async () => {
    const runExclusive = createSingleFlight()
    const gate = deferred()
    const events: string[] = []

    const first = runExclusive(async () => {
      events.push('inject')
      await gate.promise
    }, async () => {
      events.push('busy')
    })
    await runExclusive(async () => {
      events.push('inject')
    }, async () => {
      events.push('busy')
    })

    gate.release()
    await first

    // One injection, not two: `onBusy` runs *instead of* the body.
    expect(events).toEqual(['inject', 'busy'])
  })
})
