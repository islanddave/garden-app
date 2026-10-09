// forms.js through vite only: this worker holds one script of it, vite's text behind vitest's wrapper. And
// only-vite.mjs, which no case loads any other way.
import { test, expect } from 'vitest'
import forms from './forms.js'
import { late, loaded } from './late.mjs'
import { called } from './only-vite.mjs'

test('forms.js, imported', () => {
  expect([1, 2, 3].map((n) => forms.throughVite(n))).toEqual(['positive', 'positive', 'positive'])
  expect(forms.bothWays(2)).toBe('even')
})

test('late.mjs, loaded to the end', () => {
  expect(loaded).toEqual(['early', 'open'])
  expect([late(), late()]).toEqual(['late', 'late'])
})

test('only-vite.mjs, imported and nothing else', () => {
  expect([called(1), called(2), called(3)]).toEqual(['small', 'small', 'small'])
})
