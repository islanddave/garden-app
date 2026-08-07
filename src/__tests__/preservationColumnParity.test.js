// V4-PUTUPPROV-001 — column parity across the FOUR hand-maintained enumerations that must agree:
//   1. the INSERT column list          (lambda/preservation/index.js)
//   2. the full-replace UPDATE SET list (lambda/preservation/index.js)
//   3. projectRow's read whitelist      (lambda/preservation/index.js)
//   4. buildFullPayload                 (src/pages/PutUp.jsx)
//
// Adding a column to four hand-lists is the defect generator, not the column itself. This file is
// the tripwire; the Lambda's COALESCE-preserve UPDATE is the safety net. Both ship.
//
// STATIC SOURCE INSPECTION, deliberately: index.js imports neon/clerk/aws and cannot be imported
// under `npm ci`. Direct precedent in this repo — lambda/plants/select-columns.test.js exists for
// exactly this bug class ("POST persisted it, the GET SELECT never listed it").
//
// WHY THIS TEST AND NOT A CHECKLIST: the Q6 change-list in the design brief was itself incomplete
// twice. A derived Set-equality assertion catches a missing key, an extra key, AND the next column
// somebody adds — none of which a hand-written toContain('source_kind') would.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PRESERVATION_EDITABLE_COLUMNS } from '../../lambda/preservation/provenance.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const lambdaSrc = readFileSync(resolve(root, 'lambda/preservation/index.js'), 'utf8')
const pageSrc = readFileSync(resolve(root, 'src/pages/PutUp.jsx'), 'utf8')

// Columns the SERVER owns on write — never sent by a client, so never in the editable set.
const SERVER_OWNED = ['id', 'user_id', 'created_at', 'updated_at', 'deleted_at']

describe('lambda/preservation/index.js write + read paths list every editable column', () => {
  // Scoped to the COLUMN LIST, not to the whole statement. Slicing through to `RETURNING *`
  // swallowed the VALUES clause, where every column name reappears as `${body.method}` etc — so the
  // assertion below was satisfied by the bound parameter even when the column had been deleted from
  // the list. Verified by mutation: removing `method` from the column list left this file green,
  // creating put-ups with a NULL method (the record's defining field) while RETURNING * echoed the
  // request back so a smoke test looked fine. Two independent looseness bugs stacked here — this
  // span, and a bare toContain that `method_other_text` also satisfied.
  const insertStart = lambdaSrc.indexOf('INSERT INTO preservation_log (')
  const insertBlock = lambdaSrc.slice(insertStart, lambdaSrc.indexOf(') VALUES (', insertStart))
  const updateBlock = lambdaSrc.slice(
    lambdaSrc.indexOf('UPDATE preservation_log SET'),
    lambdaSrc.indexOf('updated_at          = NOW()'))
  const projectBlock = lambdaSrc.slice(
    lambdaSrc.indexOf('function projectRow(r) {'),
    lambdaSrc.indexOf('use_by_status:'))

  // consumed_at is CORRECTLY absent from the INSERT: a put-up cannot be already-consumed at the
  // moment it is created. It is set later, by the decrement path, which is a PUT — so it is asserted
  // on the UPDATE below but excluded here. (This exclusion was on the wrong statement in the first
  // draft, and this test caught it.)
  it.each(PRESERVATION_EDITABLE_COLUMNS.filter(c => c !== 'consumed_at'))(
    'INSERT writes %s', (col) => {
      // \b, not toContain: `method` is the ONE name in PRESERVATION_EDITABLE_COLUMNS that is a
      // substring of another (`method_other_text`), so a bare toContain('method') is satisfied by
      // method_other_text alone. Verified by mutation — deleting `method` from the INSERT column
      // list left this file green, and a put-up would be created with a NULL method, its defining
      // field, while RETURNING * echoed the request back so a smoke test looked fine. The UPDATE
      // arm (`${col} `) and projectRow arm (`${col}:`) were already anchored; this one was not.
      expect(insertBlock).toMatch(new RegExp(`\\b${col}\\b`))
    })

  it.each(PRESERVATION_EDITABLE_COLUMNS)('full-replace UPDATE sets %s', (col) => {
    expect(updateBlock).toContain(`${col} `)
  })

  // The asymmetry that makes an omission here invisible: POST and PUT return raw rows[0] from
  // RETURNING *, so a create smoke-test echoes the new field back correctly while every one of the
  // four GET routes renders blank. projectRow is the only projection and the only place to catch it.
  it.each(PRESERVATION_EDITABLE_COLUMNS)('projectRow returns %s', (col) => {
    expect(projectBlock).toContain(`${col}:`)
  })

  it('never lets a client write a server-owned column', () => {
    for (const c of SERVER_OWNED) expect(PRESERVATION_EDITABLE_COLUMNS).not.toContain(c)
  })
})

describe('buildFullPayload carries every editable column', () => {
  // The single choke point for the one-tap decrement and, via ...overrides, for RowEditor.
  const block = pageSrc.slice(
    pageSrc.indexOf('function buildFullPayload(rec, overrides = {}) {'),
    pageSrc.indexOf('...overrides,'))

  it.each(PRESERVATION_EDITABLE_COLUMNS)('sends %s', (col) => {
    expect(block).toContain(`${col}:`)
  })

  it('is anchored to a real function (guards against the slice silently matching nothing)', () => {
    expect(block.length).toBeGreaterThan(200)
    expect(pageSrc).toContain('function buildFullPayload(rec, overrides = {})')
  })
})

describe('the provenance deviation from house style is documented in place', () => {
  // The COALESCE-preserve write is the one thing standing between a stale cached bundle and silent
  // provenance erasure on every "Mark used" tap. It looks like a house-style violation, so a future
  // editor WILL be tempted to normalize it. This test makes that a red build rather than a
  // regression nobody notices for a season.
  it('the UPDATE preserves source_kind instead of nulling an absent key', () => {
    expect(lambdaSrc).toMatch(/source_kind\s+= COALESCE\(/)
  })

  // The ::text casts are load-bearing, not cosmetic: a bare placeholder in `WHEN $n IS NULL` gives
  // Postgres no type context and the neon driver sends untyped params, so the whole PUT 500s with
  // "could not determine data type of parameter". That shipped once and NO unit or static test
  // caught it — only the real-Postgres integration suite did. This assertion is the cheap guard so
  // it cannot come back the next time someone reformats this block.
  it('every placeholder in the source_label CASE is explicitly ::text cast', () => {
    const caseBlock = lambdaSrc.slice(
      lambdaSrc.indexOf('source_label        = CASE'),
      lambdaSrc.indexOf('updated_at          = NOW()'))
    const placeholders = caseBlock.match(/\$\{[^}]+\}/g) ?? []
    expect(placeholders.length).toBeGreaterThan(0)
    for (const ph of placeholders) {
      const at = caseBlock.indexOf(ph)
      expect(caseBlock.slice(at + ph.length, at + ph.length + 6)).toBe('::text')
    }
  })

  it('the source_label CASE keys on the REQUEST kind, not the stored kind', () => {
    // Keying on COALESCE(request, stored) would null the label whenever the row was ALREADY
    // own_garden — which is the bug the boss pass caught in the first draft.
    const caseBlock = lambdaSrc.slice(
      lambdaSrc.indexOf('source_label        = CASE'),
      lambdaSrc.indexOf('updated_at          = NOW()'))
    expect(caseBlock).toMatch(/IS NULL\s+THEN source_label/)
    expect(caseBlock).not.toContain('COALESCE(')
  })
})
