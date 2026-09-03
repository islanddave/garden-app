/**
 * BUG-EVTMETARAWKEYS-001 — every metadata key live in prod is either LABELLED or HIDDEN.
 *
 * WHY THIS FILE EXISTS. The Details block on /events/:id filters metadata with a DENYLIST, not an
 * allowlist: `EventDetail.jsx` drops null/empty values and keys in METADATA_HIDDEN_KEYS, and nothing
 * hides an unknown key. So a key nobody thought about renders to the user as raw monospace
 * `key value` — and that is not hypothetical. Measured against prod 2026-09-03: 35 distinct metadata
 * keys live, 7 labelled, 1 hidden, and **27 rendering raw**, including `batch_id` (a bare uuid) and
 * `batch_v` on 12,920 events each.
 *
 * It drifted that far because the render path had NO test at all — a search for METADATA_LABELS or
 * metadataEntries across the whole test tree returned zero hits before this file. A denylist with no
 * census guard silently rots every time a writer adds a key, which is exactly what happened.
 *
 * This asserts the census, not the implementation: for each key OBSERVED IN PROD, the page must have
 * made a decision about it. It deliberately does NOT assert which decision — hiding vs labelling is a
 * judgement that can change without this test caring. It fails only when a key is left undecided.
 *
 * MAINTENANCE, and read this before "fixing" a failure: PROD_METADATA_KEYS is a snapshot of a live
 * census, not a wish list. If a new writer ships a key, this test SHOULD go red — the fix is to add
 * the key to METADATA_LABELS or METADATA_HIDDEN_KEYS in EventDetail.jsx, then add it here. Deleting
 * the row from this list to get green re-opens the exact defect the file exists to close.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Parsed from source rather than imported: EventDetail.jsx is a page component that drags routing,
// Clerk and the data cache behind it, and this assertion is about two literals. Reading the file is
// both cheaper and harder to fool — an import could be satisfied by a re-export that is not what the
// component actually consumes.
// Resolved from the vitest root rather than import.meta.url: under this config import.meta.url is
// not a file: URL and readFileSync rejects it.
const SRC = readFileSync(resolve(process.cwd(), 'src/pages/EventDetail.jsx'), 'utf8')

function labelledKeys() {
  const block = SRC.match(/const METADATA_LABELS = \{([\s\S]*?)\n\}/)
  expect(block, 'METADATA_LABELS block not found — was it renamed?').toBeTruthy()
  return new Set([...block[1].matchAll(/^\s{2}([a-z_][a-z0-9_]*):\s*'/gim)].map((m) => m[1]))
}

function hiddenKeys() {
  const block = SRC.match(/const METADATA_HIDDEN_KEYS = new Set\(([\s\S]*?)\)\n/)
  expect(block, 'METADATA_HIDDEN_KEYS block not found — was it renamed?').toBeTruthy()
  return new Set([...block[1].matchAll(/'([a-z_][a-z0-9_]*)'/gi)].map((m) => m[1]))
}

// The live census. Every distinct key present in prod event_log.metadata on non-deleted rows,
// measured 2026-09-03, with its row count for triage weight.
const PROD_METADATA_KEYS = [
  ['batch_v', 12920], ['batch_id', 12920],
  ['precip_source', 2130], ['gauge_in', 2130], ['station_series', 2130], ['rain_backfill', 2130],
  ['water_depth_source', 1332], ['water_depth', 1332],
  ['auto_logged', 434],
  ['status_from', 300], ['status_to', 300], ['entity_level', 300], ['schema', 300],
  ['source', 150], ['harvest_input_source', 86],
  ['pest', 75], ['method', 75], ['target_pest', 75],
  ['product', 70], ['active_ingredient', 70], ['reapply_after_rain', 70], ['protection_class', 70],
  ['patrol', 8], ['migrate_to_location', 8], ['target_location_id', 8], ['trend', 8],
  ['scope_intended', 8],
  ['loss_reason', 6], ['qty_reduced', 6],
  ['non_chemical', 5], ['issue_label', 4],
  ['health', 3], ['count', 2], ['depth_mm', 2], ['medium', 1],
]

describe('BUG-EVTMETARAWKEYS-001 — no live metadata key renders raw', () => {
  it('every key observed in prod is either labelled or hidden', () => {
    const labelled = labelledKeys()
    const hidden = hiddenKeys()
    const undecided = PROD_METADATA_KEYS
      .filter(([k]) => !labelled.has(k) && !hidden.has(k))
      .map(([k, n]) => `${k} (${n} rows)`)
    // Named in the message so a failure says WHICH key and how much it is worth, rather than a count.
    expect(undecided, `these keys would render raw to the user: ${undecided.join(', ')}`).toEqual([])
  })

  it('the two Dave named are hidden, not labelled', () => {
    // batch_id is a bare uuid and batch_v a schema integer, on 12,920 events each — the largest
    // instance of the defect and the reason it was raised. A label here would be wrong: there is no
    // human-meaningful rendering of either, so the row should not exist at all.
    const hidden = hiddenKeys()
    const labelled = labelledKeys()
    for (const k of ['batch_id', 'batch_v']) {
      expect(hidden.has(k), `${k} must be hidden`).toBe(true)
      expect(labelled.has(k), `${k} must NOT be labelled`).toBe(false)
    }
  })

  it('keys holding user-entered content are LABELLED, never hidden', () => {
    // The other half of the split, and the one a careless "just hide them all" would break. Each of
    // these is something a person recorded — a gauge reading, a hand-entered quantity, an ingredient
    // read off a bottle. Hiding them deletes real content from the page.
    const hidden = hiddenKeys()
    const labelled = labelledKeys()
    for (const k of ['gauge_in', 'qty_reduced', 'active_ingredient', 'target_pest', 'issue_label']) {
      expect(labelled.has(k), `${k} holds user content and must be labelled`).toBe(true)
      expect(hidden.has(k), `${k} must NOT be hidden`).toBe(false)
    }
  })

  it('a key is never BOTH labelled and hidden', () => {
    // The filter runs before the label lookup, so hidden would win silently and the label would be
    // dead code that reads as live. Cheap to assert, invisible otherwise.
    const overlap = [...hiddenKeys()].filter((k) => labelledKeys().has(k))
    expect(overlap).toEqual([])
  })
})
