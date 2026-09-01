import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// `@testing-library/react` only auto-registers its `afterEach(cleanup)` when
// it detects a *global* `afterEach` (Jest-style globals). This project does
// not set `test.globals: true`, so without this the DOM from one test leaks
// into the next: a later `render()` mounts a second tree next to the first,
// and queries like `findByLabelText` can resolve against the stale node from
// the previous test, wired to that test's now-irrelevant mocks.
afterEach(() => cleanup())
