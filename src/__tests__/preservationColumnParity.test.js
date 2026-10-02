// V4-PUTUPPROV-001 — column parity across the FOUR hand-maintained enumerations that must agree:
//   1. the INSERT column list          (lambda/preservation/index.js)
//   2. the full-replace UPDATE SET list (lambda/preservation/index.js)
//   3. projectRow's read whitelist      (lambda/preservation/jarRules.js — index.js until Put-Up 1a)
//   4. buildFullPayload                 (src/pages/PutUp.jsx) — RETIRED in release F; the client's list
//      is now the jar editor's PATCH keys, pinned against JAR_PATCH_KEYS below
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
import { JAR_PATCH_KEYS } from '../../lambda/preservation/jarRoutes.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const lambdaSrc = readFileSync(resolve(root, 'lambda/preservation/index.js'), 'utf8')
// projectRow moved verbatim into jarRules.js (Put-Up release 1a); the INSERT and the UPDATE did not move.
const jarRulesSrc = readFileSync(resolve(root, 'lambda/preservation/jarRules.js'), 'utf8')
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
  const projectBlock = jarRulesSrc.slice(
    jarRulesSrc.indexOf('function projectRow(r) {'),
    jarRulesSrc.indexOf('use_by_status:'))

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

// Release F retired the fourth list: buildFullPayload, the full-replace echo every Edit and Mark used
// sent, is gone from the client. Mark used / Used up are POST /api/pantry/uses and an Edit is ONE PATCH
// of what changed (RowEditor.save), so the client's copy of the column list is now the PATCH's keys —
// and the PATCH refuses any key outside JAR_PATCH_KEYS, so a key the editor builds that the route does
// not take is a 400 behind an ordinary Save. The legacy PUT's echo is pinned where it still lives:
// putUpDateEcho.tz.test.js keeps a frozen copy of the shape the shipped bundles send.
describe('the jar editor writes only what the jar PATCH takes (the client list since release F)', () => {
  const at = pageSrc.indexOf('function RowEditor(')
  const block = pageSrc.slice(at, pageSrc.indexOf('\n  return (', at))
  const sent = [...new Set([...block.matchAll(/\bpatch\.(\w+)\s*=/g)].map(m => m[1]))]

  it('is anchored to the real save (guards against the slice silently matching nothing)', () => {
    expect(at).toBeGreaterThan(-1)
    expect(block).toContain('function save()')
    // The ten keys the editor builds, each written through one key (method_other_text with method; R2a:
    // source_kind with source_label, always both).
    expect(sent.sort()).toEqual(['discard_by', 'label', 'method', 'method_other_text', 'notes', 'package_count',
      'quantity_unit', 'quantity_value', 'source_kind', 'source_label'])
  })

  // MUTATION: add `patch.remaining_count = …` (or any key the route refuses) to RowEditor.save -> reds.
  it('every key it builds is one the PATCH takes', () => {
    for (const k of sent) expect(JAR_PATCH_KEYS).toContain(k)
  })

  // Uses go through their own route; from F the legacy PUT refuses a remaining_count on a drawn jar.
  it.each(['remaining_count', 'consumed_at'])('never writes %s', (col) => {
    expect(PRESERVATION_EDITABLE_COLUMNS).toContain(col)      // green control: still editable server-side
    expect(block).not.toMatch(new RegExp(`\\b${col}\\b`))
  })

  // MUTATION: bring buildFullPayload back -> reds. A second copy of the full echo in the client is the
  // defect generator this file exists for, with nothing left to keep it in step.
  it('no full-replace echo is left in the page', () => {
    expect(pageSrc).not.toMatch(/function buildFullPayload\s*\(/)
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
