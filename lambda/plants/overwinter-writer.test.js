// V4-OVERWINTERCARE-001 — the writer for the overwintering care attribute.
//
// Three layers, in descending order of how much they prove:
//   1. The core runs for real against a tagged-template mock (setOverwinterCore is import-able
//      precisely so this layer can exist; index.js is not — it loads @neondatabase/serverless +
//      @clerk/backend + @aws-sdk/* at module scope).
//   2. A ROUND TRIP against the shipped evaluator: what the writer stores is fed to the real
//      lambda/daily-plan/overwinter.js and asserted to change the cadence, and the cleared shape is
//      asserted to take it back. This is the guard that would have caught a writer emitting a key
//      the reader does not recognise — the failure mode a mock-only suite is blind to, and the one
//      that matters here because the reader shipped first and cannot be changed to match.
//   3. Source-text guards for the parts that live inside index.js (route wiring, the read-back
//      join), per the house constraint above.
//
// EVERY `it` BELOW NAMES THE SOURCE EDIT THAT TURNS IT RED, in an inline comment. This repo has
// shipped guards that passed while structurally unable to fail; the mutation table in the lane
// report is the evidence that these can.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REGIMES, parseOverwinterBody, setOverwinterCore } from './overwinterAttr.js'
// The evaluator, imported ACROSS Lambda directories on purpose. A test may reach across (it runs
// from the repo root); the runtime may not (deploy-lambda.yml zips each directory alone). That
// asymmetry is the whole reason REGIMES is duplicated, and this import is what keeps the duplicate
// honest.
import ow from '../daily-plan/overwinter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// A construct NAMED IN A COMMENT is not that construct — same decommenter every static guard in
// this directory uses, so a deleted line left behind as `// was: …` cannot satisfy an assertion.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n')
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'))

// ── mock sql ─────────────────────────────────────────────────────────────────────────────────────
// Tagged-template recorder, same shape as merge.test.js's: substring-matched canned responses,
// `.transaction()` records the batch.
function mockSql(responses = {}) {
  const calls = []
  const render = (strings, values) =>
    strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i}` : ''), '')
  const answer = (text) => {
    for (const [needle, rows] of Object.entries(responses)) {
      if (text.includes(needle)) return rows
    }
    return []
  }
  const sql = (strings, ...values) => {
    const text = render(strings, values)
    calls.push({ text, values })
    const p = Promise.resolve(answer(text))
    p.__text = text
    p.__values = values
    return p
  }
  sql.transaction = async (stmts) => {
    calls.push({ transaction: stmts.map((s) => s.__text ?? '') })
    return stmts.map((s) => answer(s.__text ?? ''))
  }
  sql.calls = calls
  sql.texts = () => calls.filter((c) => c.text).map((c) => c.text)
  sql.lastTransaction = () => calls.filter((c) => c.transaction).at(-1)?.transaction ?? []
  return sql
}

const PLANT = '11111111-1111-1111-1111-111111111111'
const HOUSEHOLD = ['user_a']
const OWNED = { 'FROM public.garden_node gn': [{ id: PLANT }] }
const upsertRow = (attr) => ({ 'INSERT INTO care_profile': [{ overwintering: attr }] })

const call = (body, responses = OWNED, plantId = PLANT) => {
  const sql = mockSql(responses)
  return setOverwinterCore(sql, { plantId, householdIds: HOUSEHOLD, body }).then((r) => ({ r, sql }))
}

// ── 1. body parsing ──────────────────────────────────────────────────────────────────────────────

describe('parseOverwinterBody', () => {
  // Mutation: drop the `!REGIMES.includes(regime)` conjunct — a typo'd regime is stored and the
  // planting silently runs on the engine's fallback forever.
  it('rejects a regime the model does not define', () => {
    expect(parseOverwinterBody({ regime: 'cold_frame' }).ok).toBe(false)
    expect(parseOverwinterBody({ regime: 'protected_productive' }).ok).toBe(true)
  })

  // Mutation: accept a missing regime by defaulting it. A save with no choice would then silently
  // enrol the planting in a 14-day check nobody picked.
  it('requires a regime when setting', () => {
    expect(parseOverwinterBody({}).ok).toBe(false)
    expect(parseOverwinterBody({ note: 'under the big cover' }).ok).toBe(false)
  })

  // Mutation: remove either clear arm. The UI's "Not overwintering" button would then be parsed as
  // a malformed SET and 400 — the attribute becomes one-way, which is the dormant trap this whole
  // design exists to avoid.
  it('reads all three off-shapes as CLEAR', () => {
    for (const body of [{ regime: null }, { overwintering: false }, { overwintering: null }]) {
      expect(parseOverwinterBody(body), JSON.stringify(body)).toEqual({ ok: true, clear: true })
    }
  })

  // Mutation: return `{regime, from, until, note}` unconditionally instead of building sparsely.
  // Explicit nulls are harmless to the evaluator but erase the distinction between a date Dave
  // chose and one the model computed.
  it('stores only the keys that were supplied', () => {
    expect(parseOverwinterBody({ regime: 'field_hardy' }).attr).toEqual({ regime: 'field_hardy' })
    expect(parseOverwinterBody({ regime: 'field_hardy', from: '11-01', until: '2027-03-15', note: ' cover  ' }).attr)
      .toEqual({ regime: 'field_hardy', from: '11-01', until: '2027-03-15', note: 'cover' })
  })

  // Mutation: drop the normDate regex. '3/15' reaches the column, overwinterProfile slices its last
  // five chars to '/3/15', and the window silently never opens.
  it('rejects a date it cannot slice to MM-DD', () => {
    expect(parseOverwinterBody({ regime: 'field_hardy', from: '3/15' }).ok).toBe(false)
    expect(parseOverwinterBody({ regime: 'field_hardy', until: 'March' }).ok).toBe(false)
    expect(parseOverwinterBody({ regime: 'field_hardy', from: '13-01' }).ok).toBe(false)
  })

  // Mutation: delete the `.slice(0, MAX_NOTE)`. An unbounded note is rendered straight into a care
  // row and into the daily-plan payload.
  it('caps the note', () => {
    const attr = parseOverwinterBody({ regime: 'field_hardy', note: 'x'.repeat(900) }).attr
    expect(attr.note.length).toBe(400)
  })
})

// ── 2. the core, against a mock ──────────────────────────────────────────────────────────────────

describe('setOverwinterCore', () => {
  // Mutation: delete the UUID_RE guard. '../../etc' reaches the ownership query as a bind value.
  it('404s a non-uuid id without touching the database', async () => {
    const { r, sql } = await call({ regime: 'field_hardy' }, OWNED, 'not-a-uuid')
    expect(r.status).toBe(404)
    expect(sql.calls).toHaveLength(0)
  })

  // Mutation: delete the `if (!owned)` early return. Another household's planting — or a
  // soft-deleted one — gets a care_profile row written against it.
  it('404s when the ownership preflight matches nothing, and writes nothing', async () => {
    const { r, sql } = await call({ regime: 'field_hardy' }, {})
    expect(r.status).toBe(404)
    expect(sql.texts().some((t) => t.includes('INSERT INTO care_profile'))).toBe(false)
  })

  // Mutation: remove the container-deleted / project-less arms from the preflight, or re-alias it
  // `p`. The first re-opens BUG-PLANTLESSWRITE-001 (every project-less planting 404s); the second
  // adds a 5th `FROM public.garden_node p` block and reds select-columns.test.js instead.
  it('preflights with the canonical ownership predicate, aliased gn', async () => {
    const { sql } = await call({ regime: 'field_hardy' })
    const pre = sql.texts()[0]
    expect(pre).toMatch(/FROM public\.garden_node gn/)
    expect(pre).toMatch(/gn\.deleted_at IS NULL/)
    expect(pre).toMatch(/pp\.deleted_at IS NULL/)
    expect(pre).toMatch(/gn\.container_id IS NULL AND gn\.created_by = ANY/)
    expect(pre).not.toMatch(/FROM public\.garden_node p\b/)
  })

  // Mutation: reject the body BEFORE the ownership preflight, or after the write. Order matters
  // only in that a 400 must not be reachable for a planting the caller cannot see; this pins that
  // a bad body never reaches a write.
  it('400s a bad body and writes nothing', async () => {
    const { r, sql } = await call({ regime: 'greenhouse' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/regime must be one of/)
    expect(sql.texts().some((t) => t.includes('INSERT INTO care_profile'))).toBe(false)
  })

  // Mutation: replace `care_profile.profile || excluded.profile` with `excluded.profile`. A leaf
  // water_interval_days override — the ONLY thing that puts 'leaf' in cadence_scopes — is deleted
  // the first time anyone marks that planting overwintering. Silent cadence regression.
  it('SET upserts a key-level MERGE at leaf scope, never a row replace', async () => {
    const attr = { regime: 'tender_indoors' }
    const { r, sql } = await call({ regime: 'tender_indoors' }, { ...OWNED, ...upsertRow(attr) })
    expect(r.status).toBe(200)
    expect(r.body.overwintering).toEqual(attr)
    const ins = sql.texts().find((t) => t.includes('INSERT INTO care_profile'))
    expect(ins).toMatch(/VALUES \('leaf', \$0::uuid/)
    expect(ins).toMatch(/jsonb_build_object\('overwintering'/)
    expect(ins).toMatch(/ON CONFLICT \(scope, scope_id\) WHERE scope <> 'system'/)
    expect(ins).toMatch(/DO UPDATE SET profile = care_profile\.profile \|\| excluded\.profile/)
  })

  // Mutation: drop the `::uuid` cast. scope_id is uuid and the bind arrives as text — Postgres
  // cannot infer the type across the ON CONFLICT arm and the whole route 42P18s at runtime, which
  // no mock can see. Pinned as source shape for that reason.
  it('casts the leaf scope_id to uuid on both the insert and the clear', async () => {
    const { sql: setSql } = await call({ regime: 'field_hardy' }, { ...OWNED, ...upsertRow({}) })
    expect(setSql.texts().find((t) => t.includes('INSERT INTO care_profile'))).toMatch(/\$0::uuid/)
    const { sql: clearSql } = await call({ regime: null })
    for (const stmt of clearSql.lastTransaction()) expect(stmt).toMatch(/scope_id = \$0::uuid/)
  })

  // Mutation: send the whole parsed attr where only the regime was asked for, or send the raw body
  // through. The bind must be the VALIDATED object, not the caller's.
  it('binds the validated attribute, not the request body', async () => {
    const { sql } = await call(
      { regime: 'field_hardy', note: '  trim me  ', bogus: 'ignored' },
      { ...OWNED, ...upsertRow({}) },
    )
    const ins = sql.calls.find((c) => c.text?.includes('INSERT INTO care_profile'))
    expect(JSON.parse(ins.values[1])).toEqual({ regime: 'field_hardy', note: 'trim me' })
  })

  // Mutation: replace the two clear statements with a single `UPDATE … profile - 'overwintering'`.
  // The row survives as `{}`, v_resolved_care.resolved_scopes keeps reporting 'leaf', and a cleared
  // planting is permanently indistinguishable from one carrying a real leaf profile.
  it('CLEAR removes the key and drops a row that becomes empty, atomically', async () => {
    const { r, sql } = await call({ regime: null })
    expect(r.status).toBe(200)
    expect(r.body.overwintering).toBeNull()
    const tx = sql.lastTransaction()
    expect(tx).toHaveLength(2)
    expect(tx[0]).toMatch(/DELETE FROM care_profile/)
    expect(tx[0]).toMatch(/\(profile - 'overwintering'\) = '\{\}'::jsonb/)
    expect(tx[1]).toMatch(/SET profile = profile - 'overwintering'/)
    // DELETE first: inside one statement the UPDATE's result is not visible to the DELETE, so the
    // other order leaves the emptied row behind. Mutation: swap the two.
    expect(tx[0].indexOf('DELETE')).toBeGreaterThan(-1)
    expect(sql.calls.filter((c) => c.transaction)).toHaveLength(1)
  })

  // Mutation: 404 when the clear matches no row. Clearing a planting that was never set is a
  // no-op, not an error — the /restore route's already_restored arm makes the same call.
  it('CLEAR is idempotent', async () => {
    const { r } = await call({ overwintering: false })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ id: PLANT, overwintering: null })
  })
})

// ── 3. round trip against the SHIPPED evaluator ──────────────────────────────────────────────────

describe('round trip: what the writer stores is what the reader acts on', () => {
  // The whole point of the lane. Mutation: rename the stored key to 'overwinter' (or nest it) —
  // readAttr returns null, the evaluator does nothing, and every assertion here reds while the
  // mock-only tests above stay green.
  const storedProfile = (body) => {
    const parsed = parseOverwinterBody(body)
    expect(parsed.ok).toBe(true)
    // The jsonb the upsert produces, in JS: jsonb_build_object('overwintering', <attr>) merged into
    // the existing profile. That merged blob is exactly what handler.js hands the engine as
    // p.db_cadence (v_resolved_care.resolved_profile).
    return { water_interval_days: 3, overwintering: parsed.attr }
  }

  it('a stored attribute makes the window open and lengthens the cadence', () => {
    const profile = storedProfile({ regime: 'protected_productive' })
    // Mid-December: inside the Persephone window at 42.51N by construction.
    const state = ow.overwinterState({ db_cadence: profile }, null, '2026-12-15')
    expect(state).not.toBeNull()
    expect(state.regime).toBe('protected_productive')
    expect(state.active).toBe(true)
    // REDUCED, never skipped, and monotone: a 3-day summer interval becomes 14, and a plant already
    // on 45 days is not pulled forward to 14.
    expect(ow.checkIntervalFor(state, 3)).toBe(14)
    expect(ow.checkIntervalFor(state, 45)).toBe(45)
    expect(ow.checkIntervalFor(state, 3)).toBeGreaterThan(3)
  })

  it('each regime the picker offers resolves to its own reduced interval', () => {
    for (const regime of REGIMES) {
      const state = ow.overwinterState({ db_cadence: storedProfile({ regime }) }, null, '2026-12-15')
      expect(state.regime, regime).toBe(regime)
      expect(state.unknown_regime, regime).toBeNull()
      expect(ow.checkIntervalFor(state, 3), regime).toBe(ow.OVERWINTER_REGIMES[regime].check_interval_days)
    }
  })

  // Mutation: have the writer store the regime under a different name, or store the raw label
  // instead of the key. unknown_regime goes non-null and the planting silently runs the default.
  it('the writer never produces an unknown_regime', () => {
    for (const regime of REGIMES) {
      const state = ow.overwinterState({ db_cadence: storedProfile({ regime }) }, null, '2026-12-15')
      expect(state.unknown_regime).toBeNull()
    }
  })

  // The clear path, expressed as the reader sees it: `profile - 'overwintering'` is the profile
  // without that key, and the evaluator must then return to doing nothing at all.
  it('clearing reverts: no attribute, no state, no cadence change', () => {
    const profile = storedProfile({ regime: 'tender_indoors' })
    expect(ow.overwinterState({ db_cadence: profile }, null, '2026-12-15')).not.toBeNull()
    const { overwintering: _cleared, ...rest } = profile   // what `profile - 'overwintering'` leaves
    expect(ow.overwinterState({ db_cadence: rest }, null, '2026-12-15')).toBeNull()
    // And the surviving key is untouched — the merge-not-replace property, from the reader's end.
    expect(rest.water_interval_days).toBe(3)
  })

  // Mutation: make the writer's default regime something other than the reader's DEFAULT_REGIME.
  it('the writer allowlist and the evaluator regime table are the same set', () => {
    expect([...REGIMES].sort()).toEqual(Object.keys(ow.OVERWINTER_REGIMES).sort())
    expect(REGIMES).toContain(ow.DEFAULT_REGIME)
  })
})

// ── 4. index.js wiring (source-text; index.js is not import-able) ─────────────────────────────────

describe('plants Lambda — /overwinter route wiring', () => {
  // Mutation: delete the matcher. The path falls through to idMatch's /([^/]+)$/ — which does not
  // match a two-segment suffix — and 404s.
  it('declares the /overwinter matcher', () => {
    expect(SRC).toMatch(/overwinterMatch = rawPath\.match\(\/\^\\\/api\\\/plants\\\/\(\[\^\/\]\+\)\\\/overwinter\$\/\)/)
  })

  // Mutation: drop the method check. A GET would run the writer with an empty body and 400, or
  // worse, a stray verb would clear the attribute.
  it('the branch is PATCH-only and delegates to the core', () => {
    const start = SRC.indexOf('if (overwinterMatch)')
    expect(start).toBeGreaterThan(-1)
    const block = SRC.slice(start, SRC.indexOf('if (archiveMatch)', start))
    expect(block).toMatch(/method !== 'PATCH'/)
    expect(block).toMatch(/setOverwinterCore\(sql, \{ plantId, householdIds, body \}\)/)
    // Bad JSON must 400, not throw into the outer catch as a 500.
    expect(block).toMatch(/Invalid JSON body/)
    // Mutation: inline the SQL here instead of delegating. A `FROM public.garden_node p` block in
    // this branch also reds select-columns.test.js's exactly-4 invariant.
    expect(/SELECT[\s\S]*FROM\s+public\.garden_node\s+p\b/.test(block)).toBe(false)
  })

  // Mutation: delete the read-back column or its join. The detail page reads "not set" on every
  // reload no matter what was saved — the write→read asymmetry that cost this file BUG-PLANTREAD-001
  // and V4-ACQMATURE-001, and the one that would make the control feel broken rather than absent.
  it('the by-id GET reads the leaf attribute back', () => {
    expect(SRC).toMatch(/ow\.profile -> 'overwintering' AS overwintering/)
    expect(SRC).toMatch(/LEFT JOIN care_profile ow ON ow\.scope = 'leaf'::care_scope AND ow\.scope_id = p\.id/)
  })

  // Mutation: point the read-back at v_resolved_care instead. An inherited cultivar-level value
  // would then render as this planting's setting, and Clear would appear to do nothing.
  //
  // NARROWED 2026-09-02 (V5-HEATRESPONSEDISPLAY-001). This asserted "the substring from the
  // overwintering projection to `WHERE p.id =` contains no v_resolved_care" — a PROXIMITY window,
  // which is a proxy for the claim rather than the claim. It has both failure directions: it fires
  // on any unrelated column in that span that legitimately reads the resolved view (heat_response
  // now does, deliberately — display prose that is MEANT to inherit), and it would have missed the
  // real mutation had the resolved read been placed outside the window. Both arms below name the
  // actual invariant instead: OVERWINTERING specifically is never read from a resolved profile,
  // and `ow` is never rebound to the view. Verified to still kill the original mutation.
  it('the read-back is leaf-scoped, not the resolved profile', () => {
    expect(SRC).not.toMatch(/resolved_profile\s*->>?\s*'overwintering'/)
    expect(SRC).not.toMatch(/v_resolved_care\s+ow\b/)
  })
})
