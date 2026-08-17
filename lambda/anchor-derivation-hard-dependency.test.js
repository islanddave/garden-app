// anchor-derivation-hard-dependency.test.js — OPS-DERIVEDCTEDEP-001.
//
// public.plant_anchor_derivation is a HARD RUNTIME DEPENDENCY of shipped request paths, and nothing
// said so anywhere a maintainer would look. The ledger row was filed against one site — the `derived`
// CTE in harvests/watch-route.js, whose LEFT JOIN runs on every watch request regardless of
// DERIVED_ANCHOR_ENABLED and deliberately carries no try/catch. This file records the dependency,
// enforces it, and corrects the row's premise on one point (see THE JUDGEMENT below).
//
// THE JUDGEMENT (2026-08-16). The row offered flag-gating the join as the alternative: make
// DERIVED_ANCHOR_ENABLED=false remove the dependency entirely, as a rollback path. That option was
// available when the row was filed and is NOT available now. Since then V4-ANCHORSUPERSEDE-001 and
// V4-TRANSPLANTANCHOR-001 put SEVEN more unguarded statements against this relation on WRITE paths —
// the plants PUT, the merge cutover and both halves of the transplant event write — every one of them
// inside a sql.transaction() with no try/catch, and NONE of them reading DERIVED_ANCHOR_ENABLED or
// any other flag. Dropping or renaming the table today fails a plant edit and every transplant log,
// not just the watch band. So flag-gating the read would remove one of eight statements while
// advertising a rollback that does not exist: it converts a KNOWN hard dependency into a
// BELIEVED-ABSENT one, which is strictly worse than leaving it visible. The query is unchanged.
//
// The no-try/catch decision is likewise left alone, and its original argument still holds: the join
// is in the request's critical path, so a missing relation must fail loudly rather than silently
// degrade the queue to its pre-derivation shape. It is now further supported by a fact that postdates
// it — the write paths would fail regardless, so a fail-open read would buy a half-working app rather
// than a degraded-but-consistent one.
//
// WHAT EACH HALF OF THIS FILE IS FOR. The behavioural block executes the real handler against a
// recording/throwing tagged-template stub, in the style watch-route.test.js argues for: it fails if
// the join is flag-gated, and fails if it is wrapped in a try/catch. The census block reads source
// text, which is the right tool for "who else depends on this relation" and matches the existing
// cross-site drift guard (anchor-supersede-parity.test.js) — the set is the fact being pinned, so
// adding or removing a dependent has to be a deliberate edit to this list.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleWatchGet, handleDismissalPost } from './harvests/watch-route.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(resolve(__dirname, ...p), 'utf8')

const USER = 'user_dave'
const HOUSEHOLD = ['user_dave', 'user_jen']
const TZ = 'America/New_York'
const PLANT = '33333333-2222-4333-8444-555555555555'

const ctx = (sql, over = {}) => ({ sql, householdIds: HOUSEHOLD, userId: USER, tz: TZ, query: {}, ...over })

// Recording stub, same shape as watch-route.test.js's.
function makeSql(results) {
  const calls = []
  const queue = [...results]
  const sql = (strings, ...params) => {
    calls.push({ text: strings.join('?'), params })
    return Promise.resolve(queue.length ? queue.shift() : [])
  }
  sql.calls = calls
  return sql
}

// The relation-missing stub: statement `failAt` (0-based) rejects the way node-postgres reports a
// dropped or renamed table, everything else succeeds. That is the exact production failure this file
// exists to keep loud — 0r-rollback.sql part 2, a rename, or an environment where 0a never landed.
function makeSqlFailingAt(failAt, results = []) {
  const calls = []
  const queue = [...results]
  const sql = (strings, ...params) => {
    calls.push({ text: strings.join('?'), params })
    if (calls.length - 1 === failAt) {
      const e = new Error('relation "public.plant_anchor_derivation" does not exist')
      e.code = '42P01'
      return Promise.reject(e)
    }
    return Promise.resolve(queue.length ? queue.shift() : [])
  }
  sql.calls = calls
  return sql
}

const derivedRow = (over = {}) => ({
  plant_id: PLANT, project_id: '99999999-2222-4333-8444-555555555555',
  planting_name: 'Fingerling Potatoes', status: 'growing', location_id: null, location_name: null,
  sown_at: null, transplanted_at: null, planted_out_at: null,
  variety_id: '77777777-2222-4333-8444-555555555555', variety_name: 'Russian Banana',
  crop_type_slug: 'potato', days_to_maturity_min: 90, days_to_maturity_max: null,
  crop_display_name: 'Potato', harvest_habit: 'single', dtm_basis: null,
  set_to_first_pick_days: null, prior_harvest_count: 0, fruit_set_date: null,
  sibling_plant_id: null, sibling_planting_name: null, sibling_first_pick_date: null,
  dismissed_active: false, et_today: '2026-08-12', season_start: '2025-11-01',
  nursery_sample_n: 39, nursery_median_gap: 31,
  derived_anchor_date: '2026-05-10', derived_anchor_field: 'planted_out_at',
  derived_anchor_source: 'add_date_baseline', derived_anchor_confidence: 'baseline',
  ...over,
})

describe('OPS-DERIVEDCTEDEP-001 — the derived join is unconditional, by decision', () => {
  // The pin the row was filed for. watch-route.test.js already drives the tier on and off, but every
  // one of those cases runs with the join PRESENT in the fixture, so flag-gating the CTE would leave
  // that whole block green. This is the case that goes red instead.
  it.each([[false], [true]])('joins plant_anchor_derivation with derivedEnabled=%s', async (flag) => {
    const sql = makeSql([[derivedRow()]])
    await handleWatchGet(ctx(sql, { derivedEnabled: flag }))
    expect(sql.calls[0].text).toMatch(/FROM public\.plant_anchor_derivation/)
    expect(sql.calls[0].text).toMatch(/LEFT JOIN derived dv\s+ON dv\.plant_id = l\.plant_id/)
  })

  // The flag governs the TIER (whether a derived anchor may open a watch row), never the JOIN. Stated
  // as one assertion because the two are routinely confused — the CTE's own header once read as though
  // nothing selected the relation while the flag was false, and gates.yml said so outright.
  it('the flag changes what is served, not whether the relation is read', async () => {
    const off = makeSql([[derivedRow()]])
    const offRes = await handleWatchGet(ctx(off, { derivedEnabled: false }))
    const on = makeSql([[derivedRow()]])
    const onRes = await handleWatchGet(ctx(on, { derivedEnabled: true }))
    expect(offRes.body.candidates).toEqual([])
    expect(onRes.body.total_watching).toBe(1)
    expect(off.calls[0].text).toEqual(on.calls[0].text)
  })
})

describe('OPS-DERIVEDCTEDEP-001 — a missing relation fails loudly, by decision', () => {
  // The other half of the pin: wrapping the candidate query in a try/catch that returns a degraded
  // queue would make this test go green-by-silence, so it asserts the REJECTION rather than a status
  // code. index.js turns the throw into a 500 (its watch-route try/catch) — a visibly broken band,
  // which is the documented intent: a queue silently reverted to its pre-derivation shape looks
  // correct and is not.
  it('GET /api/harvests/watch rejects rather than degrading the queue', async () => {
    const sql = makeSqlFailingAt(0)
    await expect(handleWatchGet(ctx(sql, { derivedEnabled: true }))).rejects.toThrow(/does not exist/)
  })

  // With the tier OFF as well — the dependency is not something a flag flip can stand down, which is
  // the whole reason flag-gating the join was rejected as a rollback path.
  it('rejects with the tier disabled too', async () => {
    const sql = makeSqlFailingAt(0)
    await expect(handleWatchGet(ctx(sql, { derivedEnabled: false }))).rejects.toThrow(/does not exist/)
  })

  // The dismissal POST runs the same candidate query, so it carries the same dependency. A user who
  // could still see a cached band would get a 500 on the tap, not a silent no-op.
  it('POST /api/harvests/watch/dismissals rejects for the same reason', async () => {
    const sql = makeSqlFailingAt(0)
    await expect(handleDismissalPost(ctx(sql, {
      derivedEnabled: true, body: { plant_id: PLANT },
    }))).rejects.toThrow(/does not exist/)
  })

  // THE CONTRAST, and the reason the absence of a try/catch reads as a decision rather than an
  // oversight: the same handler's OTHER new-relation dependency is fail-open on purpose. Statement 1
  // is the impression write (V4-WATCHIMPRESSION-001); killing it must not touch the response. If a
  // future edit made the two paths uniform in either direction, exactly one of these two blocks goes
  // red and names which invariant was traded away.
  it('the impression writer stays fail-open — the asymmetry is the decision', async () => {
    const sql = makeSqlFailingAt(1, [[derivedRow()]])
    const res = await handleWatchGet(ctx(sql, { derivedEnabled: true }))
    expect(res.statusCode).toBe(200)
    expect(res.body.total_watching).toBe(1)
  })
})

// ── The census: every runtime path that hard-depends on the relation ─────────────────────────────
//
// Counted as SQL statements naming the relation, per Lambda source file (tests, migrations and
// one-off scripts excluded — a script failing is a person's problem, a request failing is Dave's).
// Seven of the ten are unguarded, which is the fact the ledger row records: this relation cannot be
// dropped, renamed or left unapplied in ANY environment the app runs against without breaking a
// shipped surface, and the watch band is only the most visible of them.
//
// The ninth and tenth arrived together (V4-ANCHORBASE-001 create path, 2026-08-16) and are the first
// addition since this list was written. They do NOT move the unguarded count: both live in
// plants/anchorCreate.js, whose single call site wraps it in a try/catch, because a derivation that
// fails leaves nothing — unlike a retire that fails, which leaves a guess standing beside a real date.
//
// The eleventh through thirteenth arrived the same day (V4-ANCHORRESWEEP-001, the nightly
// re-derivation sweep): a retire, an insert, and the insert's NOT EXISTS re-run guard, all in
// daily-plan/handler.js. They likewise do NOT move the unguarded count — each statement carries its
// own try/catch inside sweepRederiveAnchors, for the reason the pre-existing sweep entry gives.
//
// Note for whoever adds the fourteenth: adding a dependent is not the problem this list guards
// against — believing there are still five is.
const DEPENDENTS = {
  'harvests/watch-route.js': {
    statements: 1, guarded: false,
    note: 'the `derived` CTE. READ, request critical path, deliberately unwrapped.',
  },
  'plants/index.js': {
    statements: 1, guarded: false,
    note: 'V4-ANCHORSUPERSEDE-001 retire, in the PUT transaction — every client anchor write.',
  },
  'plants/anchorCreate.js': {
    statements: 2, guarded: true,
    note: 'V4-ANCHORBASE-001 create-path derive: the INSERT plus its NOT EXISTS re-run guard. '
      + 'Guarded at its POST call site, so a missing relation costs a derivation, not the planting.',
  },
  'plants/merge.js': {
    statements: 3, guarded: false,
    note: 'merge cutover: the live-anchor snapshot read plus the loser and winner retires.',
  },
  'events/index.js': {
    statements: 2, guarded: false,
    note: 'V4-TRANSPLANTANCHOR-001 retire, batch and single halves of the transplant write.',
  },
  'daily-plan/handler.js': {
    statements: 4, guarded: true,
    note: 'the nightly sweeps — the ONLY fail-open site; losing a night costs a stale marker. '
      + 'V4-ANCHORSUPERSEDE-001 observed-anchor retire, plus V4-ANCHORRESWEEP-001 re-derivation '
      + '(retire + insert + the insert NOT EXISTS guard), each separately try/caught.',
  },
}

// Two spellings of one pattern: the un-flagged form for search/test, the global for counting.
// merge.js writes the relation UNQUALIFIED while every other site schema-qualifies it, so the
// `public.` is optional here — a census that missed merge.js would understate the blast radius by
// three statements.
const STATEMENT_RE = /\b(from|update|join|into)\s+(public\.)?plant_anchor_derivation\b/i
const STATEMENT_RE_G = new RegExp(STATEMENT_RE.source, 'gi')

function lambdaSources(dir = resolve(__dirname), rel = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = join(dir, e.name)
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...lambdaSources(p, r))
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push([r, readFileSync(p, 'utf8')])
  }
  return out
}

describe('OPS-DERIVEDCTEDEP-001 — the runtime dependents of plant_anchor_derivation', () => {
  it('is exactly the enumerated set — a new dependent must be recorded here', () => {
    const found = lambdaSources().filter(([, src]) => STATEMENT_RE.test(src)).map(([r]) => r)
    expect(found.sort()).toEqual(Object.keys(DEPENDENTS).sort())
  })

  it.each(Object.entries(DEPENDENTS))('%s holds the recorded number of statements', (rel, spec) => {
    const src = read(...rel.split('/'))
    expect(src.match(STATEMENT_RE_G) ?? []).toHaveLength(spec.statements)
  })

  // The unguarded majority is the load-bearing claim, so it is asserted rather than left as prose.
  it('seven of the thirteen statements are unguarded — the dependency is not optional anywhere', () => {
    const total = Object.values(DEPENDENTS).reduce((n, s) => n + s.statements, 0)
    const guarded = Object.values(DEPENDENTS).reduce((n, s) => n + (s.guarded ? s.statements : 0), 0)
    expect(total).toBe(13)
    expect(total - guarded).toBe(7)
  })

  // The one guarded site keeps its guard. It is fail-open on a documented trade (a lost night of the
  // sweep costs a stale marker; a failed nightly plan costs Dave his Today), and that reading is only
  // true while the try/catch is actually there.
  it('the nightly sweep keeps its try/catch', () => {
    const src = read('daily-plan', 'handler.js')
    const body = src.slice(src.indexOf('async function sweepSupersededAnchors'))
    const stmt = body.search(STATEMENT_RE)
    expect(stmt).toBeGreaterThan(0)
    expect(body.slice(0, stmt)).toMatch(/try\s*\{/)
    expect(body.slice(stmt)).toMatch(/catch\s*\(/)
  })

  // V4-ANCHORRESWEEP-001's two statements are declared at module scope and issued from
  // sweepRederiveAnchors, so the census's `guarded: true` is a claim about the FUNCTION, not about
  // the text around the SQL — the shape the check above assumes does not apply. Assert it directly:
  // each await sits inside its own try, and each catch warns rather than rethrowing.
  it('the re-derivation sweep guards each statement separately and rethrows neither', () => {
    const src = read('daily-plan', 'handler.js')
    const body = src.slice(src.indexOf('async function sweepRederiveAnchors'),
      src.indexOf('// How far back the ledger fold looks'))
    expect(body).toBeTruthy()
    expect(body.match(/try\s*\{/g) ?? []).toHaveLength(2)
    expect(body.match(/catch\s*\(/g) ?? []).toHaveLength(2)
    expect(body.match(/await pg\.query\(REDERIVE_(RETIRE|INSERT)_SQL\)/g) ?? []).toHaveLength(2)
    expect(body).not.toMatch(/throw\b/)
  })

  // The other guarded site, and the one whose `guarded: true` is claimed for a statement that lives
  // in a DIFFERENT file from its try/catch: anchorCreate.js holds the INSERT, the POST branch of
  // plants/index.js holds the wrapper. That census entry is only honest while the call site wraps it.
  it('the create-path derive is wrapped at its call site', () => {
    const src = read('plants', 'index.js')
    const call = src.indexOf('await deriveAnchorOnCreate(')
    expect(call).toBeGreaterThan(0)
    expect(src.slice(call - 40, call + 200))
      .toMatch(/try\s*\{[\s\S]*deriveAnchorOnCreate[\s\S]*?\}\s*catch\s*\(/)
  })

  // The drop site. 0r-rollback.sql part 2 is the file someone opens to remove this table, so it is
  // where the runtime consequence has to be legible — a rollback whose header says only that nothing
  // holds an FK to the table reads as safe, and is not.
  it('0r-rollback.sql part 2 warns that the drop breaks running request paths', () => {
    const sql = read('..', 'migrations', 'v4-anchorbase-001', '0r-rollback.sql')
    const part2 = sql.slice(sql.indexOf('PART 2'))
    expect(part2).toMatch(/OPS-DERIVEDCTEDEP-001/)
    expect(part2).toMatch(/watch-route\.js/)
    for (const site of ['plants/index.js', 'plants/merge.js', 'events/index.js']) {
      expect(part2, `${site} is not named as a casualty of the drop`).toContain(site)
    }
  })
})
