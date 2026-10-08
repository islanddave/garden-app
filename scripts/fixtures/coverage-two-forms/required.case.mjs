// forms.js by Node only: this worker holds one script of it, the file's own text, and vitest records no start
// offset for it.
import { test, expect } from 'vitest'
import { createRequire } from 'node:module'

const forms = createRequire(import.meta.url)('./forms.js')

test('forms.js, required', () => {
  expect([forms.byNode(-1), forms.byNode(-2)]).toEqual(['not positive', 'not positive'])
  expect(forms.bothWays(3)).toBe('odd')
})
