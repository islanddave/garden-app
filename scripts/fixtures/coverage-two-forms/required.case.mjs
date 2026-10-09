// forms.js by Node only: this worker holds one script of it, the file's own text, and vitest records no start
// offset for it. And only-node.js, which no case loads any other way.
import { test, expect } from 'vitest'
import { createRequire } from 'node:module'

const forms = createRequire(import.meta.url)('./forms.js')
const onlyNode = createRequire(import.meta.url)('./only-node.js')

test('forms.js, required', () => {
  expect([forms.byNode(-1), forms.byNode(-2)]).toEqual(['not positive', 'not positive'])
  expect(forms.bothWays(3)).toBe('odd')
})

test('only-node.js, required and nothing else', () => {
  expect([onlyNode.called(1), onlyNode.called(2)]).toEqual(['small', 'small'])
})
