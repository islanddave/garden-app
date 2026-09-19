// BUG-VARIETIESLIMIT500-001 — GET /api/varieties must not silently drop cultivars.
//
// Both list branches read `LIMIT 500` against 495 live cultivars (2026-09-18). The unsearched list is
// what VarietyPicker and header Search filter on the client, so cultivar 501 onward (alphabetically)
// would have vanished from both, with a 200 and no error anywhere. The fix is one shared cap with
// years of headroom, and a CloudWatch line when a page comes back full.
//
// Static, like select-columns.test.js beside it: importing index.js drags @neondatabase/serverless,
// @clerk/backend and @aws-sdk/* into a unit run (lambdas install per directory; CI installs root only).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Same decommenting as select-columns.test.js: a construct named in a comment is not that construct.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n')
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'))

// The two list branches: the only SELECTs FROM public.cultivar that ORDER BY display_name.
const listBlocks = [...SRC.matchAll(/SELECT[\s\S]*?FROM\s+public\.cultivar[\s\S]*?ORDER BY display_name ASC\s+LIMIT\s+([^\n]+)/g)]
  .map((m) => m[1].trim())

describe('GET /api/varieties list cap (BUG-VARIETIESLIMIT500-001)', () => {
  const caps = [...SRC.matchAll(/export const VARIETY_LIST_CAP = (\d+)/g)].map((m) => Number(m[1]))

  it('declares exactly one cap', () => {
    expect(caps.length).toBe(1)
  })

  it('leaves real headroom over the ~500 live cultivars, and a full page stays far under Lambda\'s 6 MB response limit', () => {
    // ~1.3 kB per projected row measured on prod 2026-09-19 (937 kB for 495 full rows; the list
    // projection is narrower). 3000 rows would already be ~4 MB.
    expect(caps[0]).toBeGreaterThanOrEqual(1500)
    expect(caps[0]).toBeLessThanOrEqual(3000)
  })

  it('both list branches (search and unsearched) take their LIMIT from the one cap — no literal', () => {
    expect(listBlocks.length).toBe(2)
    for (const l of listBlocks) expect(l).toBe('${VARIETY_LIST_CAP}::int')
    expect(SRC).not.toMatch(/LIMIT\s+500\b/)
  })

  it('a full page is logged, not swallowed', () => {
    expect(SRC).toMatch(/if \(rows\.length >= VARIETY_LIST_CAP\) console\.error\(/)
  })
})
