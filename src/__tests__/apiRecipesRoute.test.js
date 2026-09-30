// Put-Up release 4 — '/api/recipes' is a row of the REAL prefix table, bound to the preservation Lambda's
// variable, so the recipe library (GET/POST/PATCH/DELETE /api/recipes[/:id], /api/recipes/types[/:id],
// POST /api/recipes/from-batch/:batchId) reaches the Lambda that matches the path (recipeRoutes.js).
// The apiPantryRoute.test.js shape: resolveUrl over the real FUNCTION_URLS keys, and the table's own text.
// MUTATION: delete the row -> both red; bind it to another variable -> the text arm reds.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { resolveUrl, FUNCTION_URLS } from '../lib/api.js'

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../lib/api.js'), 'utf8')

describe("api.js — the '/api/recipes' row", () => {
  it.each(['/api/recipes', '/api/recipes/types', '/api/recipes/from-batch/abc'])('resolves %s through the real prefix table', (path) => {
    const probe = Object.fromEntries(Object.keys(FUNCTION_URLS).map((k) => [k, `https://${encodeURIComponent(k)}.probe`]))
    expect(resolveUrl(path, probe)).toBe(`https://${encodeURIComponent('/api/recipes')}.probe${path}`)
  })

  it('binds it to the preservation Lambda', () => {
    expect(src).toMatch(/'\/api\/recipes':\s+import\.meta\.env\.VITE_API_PRESERVATION\s/)
  })
})
