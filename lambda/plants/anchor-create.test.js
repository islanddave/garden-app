// anchor-create.test.js — V4-ANCHORBASE-001, the create-path half of the derivation maintainer.
//
// THE DEFECT. public.plant_anchor_derivation was populated once, by 0b-backfill.sql on 2026-08-12,
// and nothing derived an anchor afterwards: deriveAnchor() in lambda/harvests/anchorDerive.js had
// ZERO runtime callers in any Lambda. A planting created since then with no sown_at /
// transplanted_at / planted_out_at therefore got no derived row, and lambda/harvests/watch.js
// dropped it from the harvest watch band with no_anchor. Confirmed read-only against live prod
// 2026-08-16: two of the three anchorless plantings created since the backfill hold no derivation,
// and BOTH are project-less — which 0b's INNER JOIN to plant_projects would not have rescued.
//
// TWO LAYERS, per this Lambda's convention (L-072), and the split is the same one
// anchor-supersede.test.js argues for. ./anchorCreate.js takes its sql handle as an argument, so it
// is EXECUTED here against a recording mock and the real emitted statement plus its BOUND PARAMS are
// inspected. index.js imports neon/clerk/aws at module load and has no runtime seam, so its call
// site is pinned by source assertions (and by the call-site try/catch assertion in
// lambda/anchor-derivation-hard-dependency.test.js).
//
// WHAT A MOCK CANNOT PROVE, said plainly rather than papered over. The decision "this planting is
// anchorless, so derive" is evaluated by Postgres, in the statement's WHERE clause, against the row
// the INSERT just wrote — deliberately, for the reason the plants PUT gives at its own retire: a
// JS mirror of a SQL predicate is one edit away from disagreeing with it. A tagged-template mock
// records the predicate; it does not execute it. So the row-level outcome is asserted the way every
// other site's is — the predicate's PRESENCE and shape here, and gates.yml's continuous
// post_no_derived_beside_observed against real Postgres.
//
// THE DRIFT GUARD IS ON VALUES, NOT ON SQL TEXT. anchorDerive.js cannot be imported at runtime (each
// Lambda zips from its own directory), so its tier vocabulary is restated in anchorCreate.js. This
// file imports the canonical module and asserts the BOUND PARAMS equal it, which makes
// anchorDerive.js the owner of the vocabulary despite nothing importing it at runtime: change a
// tier's source, field or confidence there, or the offset, and this goes red.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveAnchorOnCreate } from './anchorCreate.js'
import {
  ANCHOR_DERIVE_MODEL_VERSION, ADD_DATE_OFFSET_DAYS, DERIVATION_TIERS, OBSERVED_ANCHOR_FIELDS,
} from '../harvests/anchorDerive.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// A construct NAMED IN A COMMENT is not that construct — source assertions run against decommented
// source, same helper the sibling guards in this directory use.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n')

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'))
const MODULE_SRC = decomment(readFileSync(resolve(__dirname, 'anchorCreate.js'), 'utf8'))

const PLANT = '44444444-3333-4444-8555-666666666666'

// Tagged-template recorder, same shape as anchor-supersede.test.js's — placeholders rendered in
// position so an assertion can pin WHICH slot a value binds to, not merely that it appears.
function mockSql(rows = []) {
  const calls = []
  const render = (strings, values) =>
    strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i}` : ''), '')
  const sql = (strings, ...values) => {
    calls.push({ text: render(strings, values), values })
    return Promise.resolve(rows)
  }
  sql.calls = calls
  return sql
}

const derivedRow = () => ({
  id: 'der-1', plant_id: PLANT, user_id: 'user_dave', anchor_date: '2026-08-16',
  anchor_field: 'transplanted_at', source: 'add_date_baseline', confidence: 'baseline',
  model_version: ANCHOR_DERIVE_MODEL_VERSION, evidence_date: '2026-08-16', offset_days: 7,
  offset_source: 'stated_baseline', offset_sample_n: 112, clamped_to_today: true,
  derived_on: '2026-08-16', plausibility: null,
})

const emit = async (rows = [derivedRow()]) => {
  const sql = mockSql(rows)
  const result = await deriveAnchorOnCreate(sql, PLANT)
  return { sql, result, call: sql.calls[0] }
}

describe('a newly created anchorless planting gets a derived anchor', () => {
  it('issues exactly one statement, and it INSERTs a derivation', async () => {
    const { sql, call } = await emit()
    expect(sql.calls).toHaveLength(1)
    expect(call.text).toMatch(/INSERT INTO public\.plant_anchor_derivation/)
  })

  it('returns the row it wrote, so a caller can log or assert on it', async () => {
    const { result } = await emit()
    expect(result.plant_id).toBe(PLANT)
    expect(result.source).toBe('add_date_baseline')
  })

  it('returns null when the statement correctly wrote nothing', async () => {
    // The row already has an observed date, is in a dead status, or already holds a live derivation.
    // All three are decided by the WHERE clause, so "no rows" is the success shape, not an error.
    const { result } = await emit([])
    expect(result).toBeNull()
  })

  it('sends no statement at all without a plant id', async () => {
    const sql = mockSql()
    expect(await deriveAnchorOnCreate(sql, null)).toBeNull()
    expect(sql.calls).toHaveLength(0)
  })

  it('is scoped to the planting that was just created', async () => {
    const { call } = await emit()
    expect(call.values).toContain(PLANT)
    expect(call.text).toMatch(/WHERE gp\.id = \$\d+::uuid/)
  })

  it('writes ONLY the derivation table — public.plants keeps its updated_at and version', async () => {
    // The same guarantee 0c check 6 proves for the backfill, and the whole reason the derivation
    // lives in a standalone relation: public.plants carries four row-level UPDATE triggers, two of
    // which would fire (set_updated_at, garden_node_bump) and make a batch guess look like Dave's
    // own edit.
    const { call } = await emit()
    expect(call.text).not.toMatch(/UPDATE\s+public\.garden_node/i)
    expect(call.text).not.toMatch(/UPDATE\s+public\.plants/i)
    expect(call.text.match(/INSERT INTO/gi)).toHaveLength(1)
  })
})

describe('the tier-3 vocabulary matches lambda/harvests/anchorDerive.js', () => {
  const tier3 = DERIVATION_TIERS.find((t) => t.source === 'add_date_baseline')

  it('anchorDerive.js still owns a tier-3 baseline — the guard is vacuous without it', () => {
    expect(tier3).toBeTruthy()
    expect(tier3.field).toBe('transplanted_at')
    expect(tier3.confidence).toBe('baseline')
  })

  it.each([
    ['source', () => tier3.source],
    ['anchor_field', () => tier3.field],
    ['confidence', () => tier3.confidence],
    ['model_version', () => ANCHOR_DERIVE_MODEL_VERSION],
    ['offset_days', () => ADD_DATE_OFFSET_DAYS],
  ])('binds the canonical %s', async (_label, expected) => {
    const { call } = await emit()
    expect(call.values).toContain(expected())
  })

  it('records the offset as the STATED baseline, never a household median', async () => {
    // 0b's header records the measured reversal: over Dave's 112 dual-dated plantings the stated +7
    // hits 68.8% within a week and the household median +9 hits 46.4%. The constant is the decision,
    // so offset_source has to say so or a later refit cannot tell a decision from a fallback.
    const { call } = await emit()
    expect(call.values).toContain('stated_baseline')
  })

  it('clamps a future anchor to today and RECORDS the clamp', async () => {
    // At create time add_date IS today, so add_date + 7 is always ahead of it and this always binds.
    // mark() in anchorDerive.js clamps rather than drops for the same reason: the clamp is
    // information — it says no elapsed time yet — and dropping it would lose that.
    expect(MODULE_SRC).toMatch(/LEAST\(dts\.add_date \+ \$\{OFFSET_DAYS\}::int, dts\.et_today\)/)
    expect(MODULE_SRC).toMatch(/\(dts\.add_date \+ \$\{OFFSET_DAYS\}::int\) > dts\.et_today/)
  })

  it('stands the anchor in for a column, and never writes that column', async () => {
    // Layer 1 of the marking rule. anchor_field says which observed column the guess stands for;
    // writing the guess INTO that column is the laundering the whole item exists to prevent.
    const { call } = await emit()
    expect(call.values).toContain('transplanted_at')
    for (const field of OBSERVED_ANCHOR_FIELDS) {
      expect(call.text).not.toMatch(new RegExp(`SET\\s+${field}`, 'i'))
    }
  })
})

describe('the derivation only fires for a planting that has nothing of its own', () => {
  it.each(OBSERVED_ANCHOR_FIELDS)('requires %s IS NULL', async (field) => {
    // The OBSERVED set is imported, not restated: adding a fourth observed column to the marking
    // rule and forgetting this predicate would otherwise ship a derivation that contradicts a real
    // date on the very row that carries it.
    const { call } = await emit()
    expect(new RegExp(`gp\\.${field} IS NULL`, 'i').test(call.text),
      `the create derive does not require ${field} to be absent`).toBe(true)
  })

  it('has a re-run guard — a live derivation is never duplicated', async () => {
    const { call } = await emit()
    expect(call.text).toMatch(/NOT EXISTS/)
    expect(call.text).toMatch(/FROM public\.plant_anchor_derivation x/)
    expect(call.text).toMatch(/x\.superseded_at IS NULL/)
  })

  it('skips a planting created straight into a dead status', async () => {
    // 0b's live definition, mirrored. Deriving an anchor for a planting entered as already failed or
    // ended predicts a harvest for something that will not have one.
    const { call } = await emit()
    expect(call.values.some((v) => Array.isArray(v) && v.includes('failed') && v.includes('ended')
      && v.includes('dormant'))).toBe(true)
    expect(call.text).toMatch(/gp\.status IS NULL OR NOT \(gp\.status = ANY/)
  })

  it('RETIRES nothing and DELETES nothing — this half only ever adds', async () => {
    // The retire is the PUT's job and the sweep's. A create-path statement that could retire would
    // be a second copy of a rule that already has four.
    // `\s+FROM`, not a bare DELETE: gp.deleted_at IS NULL is a soft-delete PREDICATE and matching it
    // as a destructive statement is how a guard passes for the wrong reason.
    const { call } = await emit()
    expect(call.text).not.toMatch(/DELETE\s+FROM/i)
    expect(call.text).not.toMatch(/superseded_by/i)
    expect(MODULE_SRC).not.toMatch(/DELETE\s+FROM\s+(public\.)?plant_anchor_derivation/i)
  })
})

describe('ownership and plausibility', () => {
  it('attributes a PROJECT-LESS planting to its own creator — 0b could not', async () => {
    // The measured blind spot: both live plantings created since the backfill and still missing a
    // derivation are project-less, and 0b takes user_id from an INNER JOIN to plant_projects. Two
    // arms, project owner preferred, matching BUG-ANCHORNOPROJ-001 on the transplant write.
    const { call } = await emit()
    expect(call.text).toMatch(/COALESCE\(c\.created_by, gp\.created_by\)/)
    expect(call.text).toMatch(/LEFT JOIN public\.container c ON c\.id = gp\.container_id/)
  })

  it('stamps rescue_suspect the way 0b does', async () => {
    // The add-date of a rescue is an ACQUISITION date, not a planting date — a different quantity,
    // not a noisier estimate of the same one. watch-route.js drops any non-NULL plausibility.
    const { call } = await emit()
    expect(call.text).toMatch(/ILIKE '%rescue%'/)
    expect(call.text).toMatch(/gp\.status IN \('flowering', 'fruiting'\)/)
    expect(call.text).toMatch(/'rescue_suspect'/)
  })

  it('never stamps post_frost_impossible — this Lambda has no frost anchor', async () => {
    // Deliberate, and covered elsewhere rather than dropped: watch.js condition 3 suppresses a
    // derived row whose watch would open inside the frost window, at read time, using the frost
    // anchor it already owns. Inventing a second one here would be a copy that drifts.
    const { call } = await emit()
    expect(call.text).not.toMatch(/post_frost_impossible/)
  })
})

describe('the POST call site', () => {
  const POST = (() => {
    const start = SRC.indexOf("if (method === 'POST') {", SRC.indexOf('const ALLOWED_LOSS'))
    return SRC.slice(start > -1 ? start : 0)
  })()

  it('derives on the create path', () => {
    expect(POST).toMatch(/await deriveAnchorOnCreate\(sql, newPlant\.id\)/)
  })

  it('runs AFTER the planting exists, so the statement can read the row it derives for', () => {
    const insert = POST.indexOf('INSERT INTO public.garden_node')
    const derive = POST.indexOf('deriveAnchorOnCreate(sql')
    expect(insert).toBeGreaterThan(-1)
    expect(derive).toBeGreaterThan(insert)
  })

  it('runs before the succession early-return, so it fires on BOTH response paths', () => {
    // The succession self-reference UPDATE returns 201 from inside its own branch. A derive placed
    // after it would be skipped for every head-of-chain planting — which is most of them.
    const derive = POST.indexOf('deriveAnchorOnCreate(sql')
    const succession = POST.indexOf('SET succession_group_id = id')
    expect(succession).toBeGreaterThan(derive)
  })

  it('cannot fail the planting save', () => {
    // A satellite table holding an inferred value. Losing a derivation costs one planting its place
    // in a watch band until the next re-derivation; failing the POST costs Dave the planting he just
    // entered. Same posture as the PUT's weight-sample re-attribution hook.
    const derive = POST.indexOf('deriveAnchorOnCreate(sql')
    expect(POST.slice(derive - 40, derive + 240)).toMatch(/try\s*\{[\s\S]*?\}\s*catch\s*\(/)
  })
})
