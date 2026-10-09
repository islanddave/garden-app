// forms.js both ways in ONE worker, as the frostsent test of lambda/daily-plan loads handler.js: two scripts under
// one URL, and vitest gives both of them vite's start offset because it looks the offset up by path.
import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import imported from './forms.js'

const required = createRequire(import.meta.url)('./forms.js')

test('forms.js, imported and required', () => {
  expect(required).not.toBe(imported)
  expect(imported.throughVite(-1)).toBe('not positive')
  expect(required.byNode(1)).toBe('positive')
})
