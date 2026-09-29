// Put-Up release F (06 §1.3 item 2) — '/api/pantry' is a row of the REAL prefix table, bound to the
// preservation Lambda's variable, so Mark used / Used up (POST /api/pantry/uses) reach the Lambda that
// matches the path. Asserted two ways: through resolveUrl over the real FUNCTION_URLS keys (a missing
// row throws "No Lambda URL configured"), and against the table's own text (the env values are empty
// in tests, so comparing resolved URLs would be vacuous). MUTATION: delete the row -> both red; bind it
// to another variable -> the text arm reds.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { resolveUrl, FUNCTION_URLS } from '../lib/api.js'

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../lib/api.js'), 'utf8')

describe("api.js — the '/api/pantry' row", () => {
  it('resolves /api/pantry/uses through the real prefix table', () => {
    const probe = Object.fromEntries(Object.keys(FUNCTION_URLS).map((k) => [k, `https://${encodeURIComponent(k)}.probe`]))
    expect(resolveUrl('/api/pantry/uses', probe)).toBe(`https://${encodeURIComponent('/api/pantry')}.probe/api/pantry/uses`)
  })

  it('binds it to the preservation Lambda', () => {
    expect(src).toMatch(/'\/api\/pantry':\s+import\.meta\.env\.VITE_API_PRESERVATION\s/)
  })
})
