// tests/integration/_cleanup.js — BUG-INTFIXTURELEAK-001.
//
// Namespace-guarded, idempotent teardown for the real-Postgres integration suite.
//
// WHY THIS EXISTS: every integration fixture identity is built from testRunId() in _harness.js,
// which returns `int-test-<epoch_ms>-<base36>`. That makes the literal substring `int-test-` the ONE
// marker every fixture row carries — either directly in a text column (created_by / user_id /
// actor_clerk_sub / slug / name) or transitively through an FK to a row that does. This module
// deletes rows anchored to that marker and nothing else.
//
// THREE INDEPENDENT SAFETY GUARDS (a teardown that can reach a real row is worse than the leak):
//   1. Every statement is a STATIC string — no interpolation, no parameters. A caller cannot widen
//      the predicate at runtime, because there is no runtime input to widen.
//   2. assertGuarded() refuses to execute any DELETE whose text does not contain the literal
//      '%int-test-%'. A future edit that drops the guard throws instead of running.
//   3. Every UUID-keyed child is scoped through a subselect that is itself guard-bearing, so the
//      guard survives arbitrary FK depth.
//
// SOFT-DELETE-ONLY RULE: hard DELETE here is correct and sanctioned. The rule names test-data
// teardown as an explicit carve-out from normal flow. Guards 1-3 make real user rows unreachable by
// construction — this module never issues an unqualified or variable-qualified DELETE.
//
// RESILIENCE: statements are attempted independently. One failure (missing table on an older branch,
// a lock, a trigger) can never suppress the remaining deletes — the exact defect that leaked the
// 2026-08-03 cal1 fixtures, where an ALTER TABLE outside the try aborted the 8 deletes after it.

export const GUARD = '%int-test-%'
const NS = `'${GUARD}'`

// testRunId() shape: int-test-<13-digit epoch ms>-<5 char base36>
const FIXTURE_ID_RE = /int-test-\d{10,}-[a-z0-9]{3,}/

// Long-lived Neon endpoints that the integration suite must NEVER be pointed at. CI provisions a
// throwaway branch per run (integration-test.yml); anything else is a human/agent mistake, and it is
// exactly how the staging debris got there — nothing in the repo ever targets staging.
const PROTECTED_ENDPOINTS = [
  'ep-lucky-bird-amju6iqt', // prod  (NEON_DATABASE_URL)
  'ep-mute-firefly-amq424mj',  // staging br-polished-art-am12o4ue (NEON_STAGING_URL)
]

/** Throws unless `id` carries the fixture namespace marker. Use before any per-file scoped delete. */
export function assertFixtureId(...ids) {
  for (const id of ids) {
    if (typeof id !== 'string' || !FIXTURE_ID_RE.test(id)) {
      throw new Error(`refusing to use "${id}" as a teardown scope: not a testRunId() fixture identity`)
    }
  }
  return ids
}

/**
 * Fail-closed check that INT_DATABASE_URL is a disposable branch.
 * Set INT_ALLOW_PROTECTED_DB=1 to override (deliberate, logged, and still namespace-guarded).
 */
export function assertEphemeralDatabase(url = process.env.INT_DATABASE_URL) {
  if (!url) throw new Error('INT_DATABASE_URL is required for integration tests')
  const host = (url.match(/@([^/?]+)/)?.[1] ?? '').toLowerCase()
  const hit = PROTECTED_ENDPOINTS.find((ep) => host.includes(ep))
  if (!hit) return { host, protected: false }
  if (process.env.INT_ALLOW_PROTECTED_DB === '1') {
    console.warn(`[int-cleanup] WARNING: running against PROTECTED endpoint ${hit} (INT_ALLOW_PROTECTED_DB=1)`)
    return { host, protected: true }
  }
  throw new Error(
    `REFUSING TO RUN: INT_DATABASE_URL points at a protected long-lived endpoint (${hit}).\n` +
    'The integration suite seeds and hard-deletes fixture data and must only ever run against an\n' +
    'ephemeral Neon branch (integration-test.yml provisions one per CI run).\n' +
    'This guard exists because BUG-INTFIXTURELEAK-001 leaked fixtures into staging exactly this way.\n' +
    'Override deliberately with INT_ALLOW_PROTECTED_DB=1 if you truly mean it.',
  )
}

function assertGuarded(stmt) {
  if (!stmt.includes(NS)) {
    throw new Error(`[int-cleanup] BLOCKED: statement lacks the ${NS} namespace guard:\n${stmt}`)
  }
  return stmt
}

// ---- guard-bearing scope subselects (each nests the guard, so FK depth never loses it) ----
const NS_PROJECTS  = `SELECT id FROM plant_projects WHERE created_by LIKE ${NS} OR name LIKE ${NS} OR slug LIKE ${NS}`
const NS_PLANTS    = `SELECT id FROM plants WHERE created_by LIKE ${NS} OR project_id IN (${NS_PROJECTS})`
const NS_VARIETIES = `SELECT id FROM plant_varieties WHERE created_by LIKE ${NS} OR name LIKE ${NS} OR crop_type_slug LIKE ${NS}`
const NS_ENTITY    = `SELECT id FROM entity WHERE display_name LIKE ${NS} OR planting_ref_id IN (${NS_PLANTS}) OR cultivar_ref_id IN (${NS_VARIETIES})`
const NS_EVENTLOG  = `SELECT id FROM event_log WHERE created_by LIKE ${NS} OR logged_by LIKE ${NS} OR project_id IN (${NS_PROJECTS}) OR plant_id IN (${NS_PLANTS})`
const NS_HARVEST   = `SELECT id FROM harvest_log WHERE created_by LIKE ${NS} OR project_id IN (${NS_PROJECTS}) OR event_id IN (${NS_EVENTLOG})`

const SAMPLE_PRED = `created_by LIKE ${NS} OR cultivar_id IN (${NS_VARIETIES}) OR source_event_id IN (${NS_EVENTLOG})`

// FK-ordered: children strictly before parents. Verified against pg_constraint on the staging branch
// (see BUG-INTFIXTURELEAK-001 investigation) — every FK into plants / plant_varieties /
// plant_projects / crop_types / entity / event_log / harvest_log / cultivar_weight_sample is covered.
const STEPS = [
  ['cultivar_weight_void',        `DELETE FROM cultivar_weight_void WHERE created_by LIKE ${NS} OR sample_id IN (SELECT id FROM cultivar_weight_sample WHERE ${SAMPLE_PRED})`],
  ['preservation_log',            `DELETE FROM preservation_log WHERE user_id LIKE ${NS} OR crop_type_slug LIKE ${NS} OR plant_id IN (${NS_PLANTS}) OR variety_id IN (${NS_VARIETIES}) OR harvest_log_id IN (${NS_HARVEST})`],
  ['photos',                      `DELETE FROM photos WHERE created_by LIKE ${NS} OR plant_id IN (${NS_PLANTS}) OR project_id IN (${NS_PROJECTS}) OR event_id IN (${NS_EVENTLOG})`],
  ['user_achievements',           `DELETE FROM user_achievements WHERE user_id LIKE ${NS} OR trigger_event_id IN (${NS_EVENTLOG})`],
  ['harvest_log',                 `DELETE FROM harvest_log WHERE created_by LIKE ${NS} OR project_id IN (${NS_PROJECTS}) OR event_id IN (${NS_EVENTLOG})`],
  // cultivar_weight_sample is handled by purgeImmutableSamples() — BEFORE DELETE trigger.
  ['evidence',                    `DELETE FROM evidence WHERE created_by LIKE ${NS} OR entity_id IN (${NS_ENTITY}) OR garden_node_id IN (${NS_PLANTS})`],
  ['findings',                    `DELETE FROM findings WHERE entity_id IN (${NS_ENTITY}) OR garden_node_id IN (${NS_PLANTS})`],
  ['slug_alias',                  `DELETE FROM slug_alias WHERE entity_id IN (${NS_ENTITY})`],
  ['favorites',                   `DELETE FROM favorites WHERE user_id LIKE ${NS} OR entity_id IN (${NS_ENTITY})`],
  ['seen_event',                  `DELETE FROM seen_event WHERE leaf_id IN (${NS_PLANTS})`],
  ['critter_state',               `DELETE FROM critter_state WHERE created_by LIKE ${NS} OR plant_id IN (${NS_PLANTS})`],
  ['entity_memory',               `DELETE FROM entity_memory WHERE plant_id IN (${NS_PLANTS}) OR project_id IN (${NS_PROJECTS})`],
  ['proj_rescope_events',         `DELETE FROM proj_rescope_events WHERE plant_id IN (${NS_PLANTS}) OR project_id IN (${NS_PROJECTS})`],
  ['event_log',                   `DELETE FROM event_log WHERE created_by LIKE ${NS} OR logged_by LIKE ${NS} OR project_id IN (${NS_PROJECTS}) OR plant_id IN (${NS_PLANTS})`],
  ['entity',                      `DELETE FROM entity WHERE display_name LIKE ${NS} OR planting_ref_id IN (${NS_PLANTS}) OR cultivar_ref_id IN (${NS_VARIETIES})`],
  ['inventory_items',             `DELETE FROM inventory_items WHERE created_by LIKE ${NS} OR user_id LIKE ${NS} OR name LIKE ${NS} OR variety_id IN (${NS_VARIETIES})`],
  ['plants',                      `DELETE FROM plants WHERE created_by LIKE ${NS} OR name LIKE ${NS} OR project_id IN (${NS_PROJECTS})`],
  ['plant_varieties',             `DELETE FROM plant_varieties WHERE created_by LIKE ${NS} OR name LIKE ${NS} OR crop_type_slug LIKE ${NS}`],
  ['crop_types',                  `DELETE FROM crop_types WHERE slug LIKE ${NS} OR created_by LIKE ${NS}`],
  ['container_closure',           `DELETE FROM container_closure WHERE ancestor_id IN (${NS_PROJECTS}) OR descendant_id IN (${NS_PROJECTS})`],
  ['inactive_project_dismissals', `DELETE FROM inactive_project_dismissals WHERE user_id LIKE ${NS} OR project_id IN (${NS_PROJECTS})`],
  ['tasks',                       `DELETE FROM tasks WHERE created_by LIKE ${NS} OR project_id IN (${NS_PROJECTS})`],
  ['plant_projects',              `DELETE FROM plant_projects WHERE created_by LIKE ${NS} OR name LIKE ${NS} OR slug LIKE ${NS}`],
  ['locations',                   `DELETE FROM locations WHERE created_by LIKE ${NS} OR name LIKE ${NS} OR slug LIKE ${NS}`],
  ['spaces',                      `DELETE FROM spaces WHERE created_by LIKE ${NS} OR name LIKE ${NS}`],
  ['storage_location',            `DELETE FROM storage_location WHERE user_id LIKE ${NS}`],
  // Side-effect / telemetry tables. NONE of these were torn down by any test file before this fix —
  // they leaked on every single run (audit_events, rate_limit_buckets, event_batches, critter_state).
  ['xp_events',                   `DELETE FROM xp_events WHERE user_id LIKE ${NS}`],
  ['user_stats',                  `DELETE FROM user_stats WHERE user_id LIKE ${NS}`],
  ['app_events',                  `DELETE FROM app_events WHERE user_clerk_sub LIKE ${NS}`],
  ['audit_events',                `DELETE FROM audit_events WHERE actor_clerk_sub LIKE ${NS}`],
  ['rate_limit_buckets',          `DELETE FROM rate_limit_buckets WHERE actor_clerk_sub LIKE ${NS}`],
  ['event_batches',               `DELETE FROM event_batches WHERE created_by LIKE ${NS} OR idempotency_key LIKE ${NS}`],
].map(([table, stmt]) => [table, assertGuarded(stmt)])

async function tableExists(sql, table) {
  const r = await sql(`SELECT to_regclass('public.${table}') IS NOT NULL AS ok`)
  return r[0].ok
}

// cultivar_weight_sample carries BEFORE DELETE trg_cws_immutable (RAISE EXCEPTION: append-only).
// Teardown is the one sanctioned place to lift it. The disable/enable pair is fully contained here:
// the ALTER is inside the try, the ENABLE is in the finally, and a failure of either can never
// suppress a later step (the caller catches per-step). Production corrections still use the void
// ledger. NOTE: DISABLE TRIGGER is a catalog change, briefly global — one more reason this suite
// must only ever run against an ephemeral branch (assertEphemeralDatabase).
async function purgeImmutableSamples(sql) {
  if (!(await tableExists(sql, 'cultivar_weight_sample'))) return 0
  const pending = await sql(`SELECT count(*)::int AS n FROM cultivar_weight_sample WHERE ${assertGuarded(SAMPLE_PRED)}`)
  if (!pending[0].n) return 0
  const hasTrg = (await sql(
    `SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgname='trg_cws_immutable' AND tgrelid='cultivar_weight_sample'::regclass AND NOT tgisinternal`,
  ))[0].n > 0
  let disabled = false
  try {
    if (hasTrg) {
      await sql('ALTER TABLE cultivar_weight_sample DISABLE TRIGGER trg_cws_immutable')
      disabled = true
    }
    const rows = await sql(assertGuarded(`DELETE FROM cultivar_weight_sample WHERE ${SAMPLE_PRED} RETURNING id`))
    return rows.length
  } finally {
    if (disabled) {
      await sql('ALTER TABLE cultivar_weight_sample ENABLE TRIGGER trg_cws_immutable')
        .catch((e) => console.error(`[int-cleanup] CRITICAL: failed to re-enable trg_cws_immutable: ${e.message}`))
    }
  }
}

/**
 * Delete every fixture row in the `int-test-` namespace, in FK-safe order.
 * Idempotent (a second run deletes 0 rows) and error-contained (one failure never blocks the rest).
 * Returns { deleted: {table: n}, total, failures: [{table, error}] }.
 */
export async function sweepFixtures(sql, { verbose = true } = {}) {
  const deleted = {}
  const failures = []
  let total = 0

  const run = async (table, fn) => {
    try {
      const n = await fn()
      if (n > 0) { deleted[table] = n; total += n }
    } catch (e) {
      failures.push({ table, error: e.message })
    }
  }

  for (const [table, stmt] of STEPS) {
    // cultivar_weight_sample slots in after harvest_log, before evidence — see STEPS comment.
    if (table === 'evidence') await run('cultivar_weight_sample', () => purgeImmutableSamples(sql))
    // eslint-disable-next-line no-await-in-loop
    await run(table, async () => {
      if (!(await tableExists(sql, table))) return 0
      const rows = await sql(`${stmt} RETURNING 1 AS x`)
      return rows.length
    })
  }

  if (verbose) {
    if (total === 0) console.log('[int-cleanup] sweep: 0 fixture rows remaining (clean)')
    else console.log(`[int-cleanup] sweep: removed ${total} fixture rows — ${JSON.stringify(deleted)}`)
    for (const f of failures) console.error(`[int-cleanup] FAILED ${f.table}: ${f.error}`)
  }
  return { deleted, total, failures }
}

/**
 * Run every teardown thunk even if earlier ones throw, then report the failures together.
 *
 * A bare `await a(); await b(); await c()` chain in an afterAll is the BUG-INTFIXTURELEAK-001 defect:
 * one failing statement silently abandons every delete after it. Use this instead — each step is
 * attempted independently, and the aggregate error still surfaces so a broken teardown stays visible.
 */
export async function settle(label, steps) {
  const errors = []
  for (const step of steps) {
    // eslint-disable-next-line no-await-in-loop
    try { await step() } catch (e) { errors.push(e.message) }
  }
  if (errors.length) {
    console.error(`[int-cleanup] ${label}: ${errors.length}/${steps.length} teardown step(s) failed:`)
    for (const e of errors) console.error(`  - ${e}`)
  }
  return errors
}

/** Count rows still carrying the fixture namespace. Used by the sweeper's own proof/assertions. */
export async function countFixtureResidue(sql) {
  const probes = [
    ['plant_projects', `created_by LIKE ${NS} OR name LIKE ${NS} OR slug LIKE ${NS}`],
    ['plants', `created_by LIKE ${NS}`],
    ['plant_varieties', `created_by LIKE ${NS}`],
    ['crop_types', `slug LIKE ${NS}`],
    ['event_log', `created_by LIKE ${NS}`],
    ['cultivar_weight_sample', `created_by LIKE ${NS}`],
    ['audit_events', `actor_clerk_sub LIKE ${NS}`],
    ['rate_limit_buckets', `actor_clerk_sub LIKE ${NS}`],
    ['event_batches', `created_by LIKE ${NS}`],
    ['critter_state', `created_by LIKE ${NS}`],
    ['entity', `display_name LIKE ${NS}`],
  ]
  const out = {}
  let total = 0
  for (const [table, pred] of probes) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await tableExists(sql, table))) continue
    // eslint-disable-next-line no-await-in-loop
    const r = await sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${assertGuarded(pred)}`)
    if (r[0].n > 0) { out[table] = r[0].n; total += r[0].n }
  }
  return { byTable: out, total }
}
