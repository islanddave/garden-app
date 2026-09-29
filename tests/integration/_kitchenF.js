// tests/integration/_kitchenF.js — shared fixtures + route-presence probes for the Put-Up 1b + Ferment (F)
// integration files: kitchen-draw, kitchen-ferment, kitchen-legacy-matrix (06-ferment-path §5.2, lane L4).
//
// WRITTEN AGAINST THE FROZEN CONTRACT, AHEAD OF THE ROUTES. contract-F.md (§2) is the spec; lanes L2a/L2b built
// the routes concurrently. A describe that needs a route that is not on the branch is SKIPPED through landed().
// Since the ferment Lambda landed on putup-train (b33fe37) every route is present, so a skip is now a defect,
// and two things keep one from reading as a pass (absence of signal is not green):
//   * REQUIRE IS THE DEFAULT: each file's "route probes" test is RED while any probe it lists is pending, so a
//     probe that stops matching (a renamed code, a moved route) fails the run instead of silently skipping the
//     tests behind it. KITCHEN_F_REQUIRE=0 turns that off (a branch that genuinely lacks the routes);
//   * KITCHEN_F_FORCE=1 treats every probe as landed, so a missing route fails in its own tests instead.
// The probe is a marker in the preservation Lambda's non-test source, chosen from the contract's own
// vocabulary (an error code or a literal path the route must contain). A marker is a presence hint, not a
// proof — the tests behind it are the proof.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, testRunId, insertProject, setTestUserId } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import { handler as preservationHandler } from '../../lambda/preservation/index.js'

const LAMBDA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../lambda/preservation')
const SRC = readdirSync(LAMBDA_DIR)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .map((f) => readFileSync(join(LAMBDA_DIR, f), 'utf8'))
  .join('\n')

// key → [marker, the contract route it stands for]
export const PROBES = {
  getBatchF3:     ['garden_names', 'GET /api/kitchen-batches/:id — F3 shape (§2.1)'],
  mergePutF:      ['has_salt_line', 'PUT /api/kitchen-batches/:id — vessel/no_salt/typed SHU/recipe_ref (§2.1)'],
  batchDeleteF1:  ['has_jars', 'DELETE /api/kitchen-batches/:id — 1b soft delete + F1 reversal (§2.1)'],
  keyedLines:     ['already_in', 'POST /:id/inputs keyed form, no ON CONFLICT (§2.2 F3)'],
  draws:          ['jar_used_up', 'POST /:id/inputs put_up draws + F2 refusals (§2.2)'],
  linePatch:      ['take it out and add it again', 'PATCH /:id/inputs/:lineId (§2.2)'],
  lineRestore:    [/['"`]restore['"`]/, 'soft DELETE /:id/inputs/:lineId + POST …/restore (§2.2)'],
  lineSearch:     ['line-search', 'GET /api/kitchen-batches/line-search (§2.2)'],
  stagePostF:     ['pushed_under', 'POST /:id/stages — acts, void, ph_read_at bounds (§2.3)'],
  // Behavioural, not textual (mash_in_g is also a put-up word): see STAGE_PATCH_ROUTED below.
  stagePatch:     [() => STAGE_PATCH_ROUTED, 'PATCH /:id/stages/:stageId (§2.3)'],
  putUp:          ['batch_closed', 'POST /:id/put-up (§2.4)'],
  putUpUndo:      ['put_up_in_use', 'POST /:id/put-up/:stageId/undo (§2.4)'],
  shuEstimate:    ['shu_cannot_compute', 'GET /:id/shu-estimate + POST …/save (§2.5)'],
  pantryUses:     ['/api/pantry/uses', 'POST /api/pantry/uses (§2.6)'],
  jarPatch:       ['handleJarRoute', 'PATCH /api/preservation/:id (1b, §2.6)'],
  legacyDeltaRef: [/delta_at/, 'legacy PUT: remaining_count key + delta_at set → 409 client_stale (§2.6)'],
  closedPolicyF:  [(src) => !/return closedForEdits/.test(src), 'closed batch accepts content writes (§2 common, F §3.13)'],
  mergeKbi:       [() => PLANTS_MERGE_SRC.includes('kitchen_batch_input'), 'plants merge SURFACES repoints kbi.plant_id (§5.5, RIA-I3)'],
}
const PLANTS_MERGE_SRC = readFileSync(join(LAMBDA_DIR, '../plants/merge.js'), 'utf8')

// PATCH on a batch id nobody owns: with the route, the kitchen gate answers 404 (batch not found); without
// it, parseKitchenRoute returns null for a stages/<id> path and index.js ends in 405. No fixture needed.
const STAGE_PATCH_ROUTED = (await callHandler(preservationHandler, {
  method: 'PATCH', path: `/api/kitchen-batches/${randomUUID()}/stages/${randomUUID()}`, body: {},
  userId: `kf-probe-${testRunId()}`,
})).status !== 405

export const FORCE = process.env.KITCHEN_F_FORCE === '1'
export const HAS = Object.fromEntries(Object.entries(PROBES).map(([k, [m]]) => {
  const hit = typeof m === 'string' ? SRC.includes(m) : m instanceof RegExp ? m.test(SRC) : m(SRC)
  return [k, FORCE || hit]
}))
/** true when every named route is on this branch (or KITCHEN_F_FORCE=1). */
export const landed = (...keys) => keys.every((k) => {
  if (!(k in HAS)) throw new Error(`unknown kitchen-F probe "${k}"`)
  return HAS[k]
})
export const pendingOf = (keys) => keys.filter((k) => !HAS[k])

/** One `it` per file: lists what that file skipped; red while anything is pending unless KITCHEN_F_REQUIRE=0. */
export function routeProbeReport(it, expect, file, keys) {
  it(`${file}: route probes (a skip here is NOT a pass — see _kitchenF.js)`, () => {
    const pending = pendingOf(keys)
    if (pending.length) {
      console.warn(`[kitchen-F] ${file}: SKIPPED until the route lands: ${pending.map((k) => `${k} (${PROBES[k][1]})`).join('; ')}`)
    }
    if (process.env.KITCHEN_F_REQUIRE !== '0') expect(pending, 'every route this file covers must be present (KITCHEN_F_REQUIRE=0 to allow skips)').toEqual([])
  })
}

// ── household ───────────────────────────────────────────────────────────────────────────────────
export function makeHousehold(tag) {
  const RUN = testRunId()
  return { RUN, DAVE: `kf-${tag}-dave-${RUN}`, JEN: `kf-${tag}-jen-${RUN}`, STRANGER: `kf-${tag}-str-${RUN}` }
}

/** householdScope() reads GARDEN_HOUSEHOLD_IDS per call: DAVE+JEN one household, STRANGER outside. */
export function useHousehold(h, beforeAll, afterAll) {
  let saved
  beforeAll(() => { saved = process.env.GARDEN_HOUSEHOLD_IDS; process.env.GARDEN_HOUSEHOLD_IDS = `${h.DAVE},${h.JEN}` })
  afterAll(async () => {
    if (saved === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS; else process.env.GARDEN_HOUSEHOLD_IDS = saved
    await teardownHousehold(h)
  })
}

// The harness's verifyToken stub answers the sub set by setTestUserId (not the bearer header), and it reads it when
// the handler awaits verifyToken — so two calls as DIFFERENT users must not be in flight at once.
export const call = (userId, method, path, body) => {
  setTestUserId(userId)
  return callHandler(preservationHandler, { method, path, body, userId })
}
export const key = () => randomUUID()

// Real crop slugs (FK to crop_types). A pepper slug when the vocabulary has one.
export const CROP = (await directSql`SELECT slug FROM crop_types ORDER BY slug LIMIT 1`)[0].slug
export const PEPPER = (await directSql`SELECT slug FROM crop_types WHERE slug ILIKE '%pepper%' ORDER BY slug LIMIT 1`)[0]?.slug ?? CROP

export async function errOf(fn) {
  try { await fn(); return null } catch (e) {
    return { code: e.code ?? e.sourceError?.code, constraint: e.constraint ?? e.sourceError?.constraint, message: `${e.message} ${e.sourceError?.message ?? ''}` }
  }
}

// ── seeds (direct SQL; the route under test is never its own fixture) ─────────────────────────────
export async function seedBatch(owner, { label = 'kf batch', kind = 'ferment', closed = false, startedDaysAgo = 3 } = {}) {
  const [b] = await directSql`
    INSERT INTO kitchen_batch (user_id, label, kind, started_at, start_precision)
    VALUES (${owner}, ${label}, ${kind}, now() - make_interval(days => ${startedDaysAgo}::int), 'day')
    RETURNING id`
  const [s] = await directSql`
    INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, created_by)
    VALUES (${b.id}, 'started', now() - make_interval(days => ${startedDaysAgo}::int), 'day', ${owner})
    RETURNING id`
  if (closed) await closeBatchDirect(b.id, owner)
  return { id: b.id, startedStageId: s.id }
}

export async function closeBatchDirect(batchId, owner) {
  await directSql`UPDATE kitchen_batch SET closed_at = now(), outcome = 'consumed' WHERE id = ${batchId}`
  await directSql`
    INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, created_by)
    VALUES (${batchId}, 'finished', now(), 'exact', ${owner})`
}

/**
 * A jar. Counted by default (3 × 2 lb). weighed: package_count 1 in grams (100 g), per §1.4's stock-mode rule.
 * remaining_amount is left NULL unless given, so the route's COALESCE(remaining_amount, quantity_g) is exercised.
 */
export async function seedJar(owner, {
  count = 3, qty, unit, weighed = false, method = 'whole_freeze', crop = CROP,
  remaining = null, remainingAmount = null, consumed = false, deleted = false, deltaAt = false,
  useByInDays = null, sourceKind = null, sourceLabel = null, varietyId = null, plantId = null, notes = null,
} = {}) {
  const pc = weighed ? 1 : count
  const qv = qty ?? (weighed ? 100 : 2)
  const qu = unit ?? (weighed ? 'g' : 'lb')
  const [j] = await directSql`
    INSERT INTO preservation_log (user_id, crop_type_slug, variety_id, plant_id, preserved_at, method,
                                  quantity_value, quantity_unit, package_count, remaining_count,
                                  remaining_amount, consumed_at, deleted_at, delta_at, use_by_target,
                                  source_kind, source_label, notes)
    VALUES (${owner}, ${crop}, ${varietyId}, ${plantId}, (now() - interval '60 days')::date, ${method},
            ${qv}, ${qu}, ${pc}, ${remaining}, ${remainingAmount},
            ${consumed ? new Date().toISOString() : null}::timestamptz,
            ${deleted ? new Date().toISOString() : null}::timestamptz,
            ${deltaAt ? new Date().toISOString() : null}::timestamptz,
            ${useByInDays == null ? null : new Date(Date.now() + useByInDays * 864e5).toISOString().slice(0, 10)}::date,
            ${sourceKind}, ${sourceLabel}, ${notes})
    RETURNING id`
  return j.id
}

export async function seedPlanting(owner, { name = 'kf planting' } = {}) {
  const proj = await insertProject({ name: `${name}-proj-${owner}`, createdBy: owner })
  const [pl] = await directSql`
    INSERT INTO plants (project_id, name, created_by) VALUES (${proj.id}, ${`${name}-${owner}`}, ${owner}) RETURNING id`
  return { projectId: proj.id, plantId: pl.id }
}

export async function seedHarvest(owner, { projectId, plantId, qty = 2, unit = 'lb' }) {
  const [ev] = await directSql`
    INSERT INTO event_log (plant_id, project_id, event_type, event_date, logged_by, created_by)
    VALUES (${plantId}, ${projectId}, 'harvest', now(), ${owner}, ${owner}) RETURNING id`
  const [hv] = await directSql`
    INSERT INTO harvest_log (event_id, project_id, quantity, unit, created_by)
    VALUES (${ev.id}, ${projectId}, ${qty}, ${unit}, ${owner}) RETURNING id`
  return hv.id
}

// 1b's uq_storage_location_user_kind_label is UNIQUE (user_id, kind, lower(label)) over live rows, so each call
// gets its own label (a file seeds more than one place per owner).
let placeSeq = 0
export async function seedPlace(owner, { kind = 'deep_freezer' } = {}) {
  placeSeq += 1
  const [s] = await directSql`
    INSERT INTO storage_location (user_id, label, kind)
    VALUES (${owner}, ${`kf place ${placeSeq} ${owner}`}, ${kind}) RETURNING id`
  return s.id
}

/** A line inserted by hand — for schema-level tests that must not depend on a route. */
export async function seedLine(owner, batchId, { kind = 'other', label = 'kf line', qty = null, unit = null, jarId = null, role = null } = {}) {
  const [l] = await directSql`
    INSERT INTO kitchen_batch_input (batch_id, input_kind, label, qty, qty_unit, preservation_log_id, role, created_by)
    VALUES (${batchId}, ${kind}, ${label}, ${qty}, ${unit}, ${jarId}, ${role}, ${owner}) RETURNING id`
  return l.id
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────────
export async function readJar(id) {
  const [r] = await directSql`
    SELECT id, package_count, remaining_count, remaining_amount, consumed_at, delta_at, deleted_at, updated_at
    FROM preservation_log WHERE id = ${id}`
  return r
}
export const usesOf = (jarId) => directSql`
  SELECT id, count_used, fate, kitchen_batch_input_id, reverses_use_id, idempotency_key, created_by
  FROM pantry_use WHERE preservation_log_id = ${jarId} ORDER BY created_at, id`
export const linesOf = (batchId) => directSql`
  SELECT * FROM kitchen_batch_input WHERE batch_id = ${batchId} ORDER BY ordinal NULLS FIRST, added_at, id`
export async function unreversedDrawn(jarId) {
  const [r] = await directSql`
    SELECT COALESCE(sum(u.count_used), 0)::int AS n FROM pantry_use u WHERE u.preservation_log_id = ${jarId}`
  return r.n
}
export async function readBatchRow(id) {
  const [r] = await directSql`SELECT * FROM kitchen_batch WHERE id = ${id}`
  return r
}

// ── teardown: hard delete in FK order, scoped to this household's ids (the global sweep backs it up) ──
export async function teardownHousehold(h) {
  const ids = [h.DAVE, h.JEN, h.STRANGER]
  assertFixtureId(...ids)
  await settle(`kitchen-F teardown ${h.RUN}`, [
    () => directSql`DELETE FROM pantry_use WHERE reverses_use_id IS NOT NULL AND (created_by = ANY(${ids}) OR preservation_log_id IN (SELECT id FROM preservation_log WHERE user_id = ANY(${ids})))`,
    () => directSql`DELETE FROM pantry_use WHERE created_by = ANY(${ids}) OR preservation_log_id IN (SELECT id FROM preservation_log WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM kitchen_batch_input WHERE created_by = ANY(${ids}) OR batch_id IN (SELECT id FROM kitchen_batch WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM preservation_source WHERE preservation_log_id IN (SELECT id FROM preservation_log WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM preservation_log WHERE user_id = ANY(${ids})`,
    () => directSql`DELETE FROM kitchen_stage_log WHERE batch_id IN (SELECT id FROM kitchen_batch WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM kitchen_batch WHERE user_id = ANY(${ids})`,
    () => directSql`DELETE FROM storage_location WHERE user_id = ANY(${ids})`,
    () => directSql`DELETE FROM photos WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM harvest_log WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM event_log WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM entity WHERE planting_ref_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM plants WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM entity WHERE cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM plant_varieties WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM audit_events WHERE actor_clerk_sub = ANY(${ids})`,
  ])
}
