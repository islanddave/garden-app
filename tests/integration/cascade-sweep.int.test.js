// tests/integration/cascade-sweep.int.test.js
// V4-CASCADESWEEP-001 — the four remaining destructive CASCADEs from the V4-SOFTDEL-001 audit.
// Closes BUG-PHOTOINVCASCADE-001 (I2), BUG-ACHIEVECASCADE-001 (I4), BUG-SHARELOGCASCADE-001 (I5),
// BUG-FINDINGSCASCADE-001 (I6).
//
// THE DEFECT. Four foreign keys carried ON DELETE CASCADE onto user-authored content, each one
// `DELETE FROM <parent>` away from destroying rows the application layer promises never to remove:
//   photos.inventory_item_id         -> inventory_items   6 photos, ALL sole-anchored
//   user_achievements.achievement_id -> achievements      33 earned badges vs a 39-row catalog
//   share_log.photo_id               -> photos            0 rows, but a documented CONTRADICTION
//   findings.garden_node_id          -> plants            0 rows, defence in depth
//
// WHY RESTRICT WAS THE ONLY OPTION, not merely the preferred one — and this file pins both halves:
//   * three of the four child columns are NOT NULL, so a SET NULL cascade would 23502 rather than
//     degrade;
//   * the fourth, photos.inventory_item_id, is an ARM of the disjunctive CHECK photos_must_have_parent
//     and all 6 prod rows carry it as their SOLE anchor — so SET NULL there is the exact
//     BUG-EVTANCHORDEL-001 defect (the cascade's own UPDATE nulls the last anchor, and the CHECK then
//     rejects the row the cascade just produced, 23514), on 6 of 6 rows rather than latently.
//
// share_log is the sharpest of the four. lambda/photos/photoDelete.js:14-16 already states in prose
// that a hard photo delete "would SILENTLY DESTROY share history via share_log.photo_id (ON DELETE
// CASCADE)", and its DD4 classification records share_log as the one LEDGER pointer that must
// RETAIN. The code declared the invariant and named the schema as violating it; this migration makes
// the schema agree with the prose.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId } from './_harness.js'

const RUN = testRunId()
const USER = `cascadesweep-${RUN}`

let itemId, emptyItemId, photoId, sharePhotoId, shareRowId
let achievementId, userAchievementId
let plantId, findingId

async function sqlstateOf(fn) {
  try { await fn(); return null } catch (e) { return e.code ?? e.sourceError?.code ?? String(e.message) }
}

beforeAll(async () => {
  // ── photos.inventory_item_id fixtures ────────────────────────────────────────────────────────
  const it1 = await directSql`
    INSERT INTO inventory_items (user_id, type, name, category, created_by, quantity)
    VALUES (${USER}, 'durable', ${'cascadesweep-item-' + RUN}, 'tools', ${USER}, 1) RETURNING id`
  itemId = it1[0].id
  const it2 = await directSql`
    INSERT INTO inventory_items (user_id, type, name, category, created_by, quantity)
    VALUES (${USER}, 'durable', ${'cascadesweep-empty-' + RUN}, 'tools', ${USER}, 1) RETURNING id`
  emptyItemId = it2[0].id

  // Anchored ONLY by inventory_item_id — the shape all 6 prod rows have, and the shape that makes
  // SET NULL a 23514 rather than a graceful degradation.
  const ph = await directSql`
    INSERT INTO photos (inventory_item_id, storage_path, created_by)
    VALUES (${itemId}, ${'cascadesweep/' + RUN + '/a.jpg'}, ${USER}) RETURNING id`
  photoId = ph[0].id

  // ── share_log.photo_id fixtures ──────────────────────────────────────────────────────────────
  const ph2 = await directSql`
    INSERT INTO photos (inventory_item_id, storage_path, created_by)
    VALUES (${itemId}, ${'cascadesweep/' + RUN + '/b.jpg'}, ${USER}) RETURNING id`
  sharePhotoId = ph2[0].id
  const sl = await directSql`
    INSERT INTO share_log (post_group_id, photo_id, target, status, requested_by)
    // 'facebook', not 'facebook_page'. The fixture carried a target value the app has NEVER written
    // — lambda/facebook-share/index.js:301 inserts 'facebook' — and share_log_target_valid allows
    // only facebook / instagram / threads / pinterest. It passed from 2026-08-13 until the
    // constraint reached staging, at which point every integration run started failing here: this
    // suite forks its ephemeral branch FROM STAGING and applies no migrations, so a schema change
    // made out-of-band lands on the next run whatever the commit contains. The constraint is right
    // and the fixture was wrong, so the fixture moved.
    VALUES (gen_random_uuid(), ${sharePhotoId}, 'facebook', 'posted', ${USER}) RETURNING id`
  shareRowId = sl[0].id

  // ── user_achievements.achievement_id fixtures ────────────────────────────────────────────────
  const ac = await directSql`
    INSERT INTO achievements (slug, name, description, trigger_type)
    VALUES (${'cascadesweep-ach-' + RUN}, 'Cascade Sweep', 'test fixture', 'manual') RETURNING id`
  achievementId = ac[0].id
  const ua = await directSql`
    INSERT INTO user_achievements (user_id, achievement_id)
    VALUES (${USER}, ${achievementId}) RETURNING id`
  userAchievementId = ua[0].id

  // ── findings.garden_node_id fixtures ─────────────────────────────────────────────────────────
  const pl = await directSql`
    INSERT INTO plants (name, created_by) VALUES (${'cascadesweep-plant-' + RUN}, ${USER}) RETURNING id`
  plantId = pl[0].id
  // A trigger auto-registers the planting's `entity` row; findings.entity_id references it.
  const [ent] = await directSql`
    SELECT id FROM entity WHERE entity_type = 'planting' AND planting_ref_id = ${plantId}`
  const fd = await directSql`
    INSERT INTO findings (engine_version, garden_node_id, entity_id, finding_type, finding_kind,
                          statement, severity, confidence_local, confidence_transferable,
                          confidence_band, assertion_mode, decay_state, trend, channel)
    VALUES ('cascadesweep-test', ${plantId}, ${ent.id}, 'test', 'diagnostic',
            'cascade sweep fixture', 'low', 0.5, 0.5, 'low', 'assert', 'fresh', 'steady', 'ambient')
    RETURNING id`
  findingId = fd[0].id
})

afterAll(async () => {
  // CHILD-FIRST throughout — the discipline these four RESTRICTs now enforce.
  await directSql`DELETE FROM findings WHERE engine_version = 'cascadesweep-test'`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${plantId}`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
  await directSql`DELETE FROM achievements WHERE slug = ${'cascadesweep-ach-' + RUN}`
  await directSql`DELETE FROM share_log WHERE requested_by = ${USER}`
  await directSql`DELETE FROM photos WHERE created_by = ${USER}`
  await directSql`DELETE FROM inventory_items WHERE created_by = ${USER}`
})

describe('V4-CASCADESWEEP-001 — photos.inventory_item_id (BUG-PHOTOINVCASCADE-001)', () => {
  it('the fixture photo is SOLE-anchored, which is why SET NULL was never an option', async () => {
    // Documents the alternative rather than asserting only the chosen action. All 6 prod rows have
    // this shape: nulling inventory_item_id would leave photos_must_have_parent unsatisfiable.
    const [row] = await directSql`
      SELECT event_id, project_id, location_id, plant_id, space_id, intake_status
        FROM photos WHERE id = ${photoId}`
    expect(row.event_id).toBeNull()
    expect(row.project_id).toBeNull()
    expect(row.location_id).toBeNull()
    expect(row.plant_id).toBeNull()
    expect(row.space_id).toBeNull()
    expect(row.intake_status === 'pending_tag').toBe(false)
  })

  it('hard-deleting an inventory item that has photos fails 23503', async () => {
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM inventory_items WHERE id = ${itemId}`)).toBe('23503')
  })

  it('NOTHING is half-done: the photos survive the refused delete', async () => {
    const rows = await directSql`
      SELECT id, inventory_item_id FROM photos WHERE id IN (${photoId}, ${sharePhotoId})`
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.inventory_item_id).toBe(itemId)
  })

  it('did NOT over-block: an inventory item with no photos still deletes cleanly', async () => {
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM inventory_items WHERE id = ${emptyItemId}`)).toBeNull()
    const rows = await directSql`SELECT id FROM inventory_items WHERE id = ${emptyItemId}`
    expect(rows).toHaveLength(0)
  })
})

describe('V4-CASCADESWEEP-001 — share_log.photo_id (BUG-SHARELOGCASCADE-001)', () => {
  it('hard-deleting a shared photo fails 23503 — the schema now matches photoDelete.js DD4', async () => {
    // A post to an external Facebook page cannot be retracted by deleting our local record of it,
    // so erasing the record would make the ledger lie. photoDelete.js called this "a correctness
    // decision, not laziness" while the FK did the opposite.
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM photos WHERE id = ${sharePhotoId}`)).toBe('23503')
  })

  it('the share record survives, which is the entire point of the RETAIN classification', async () => {
    const [row] = await directSql`SELECT id, photo_id FROM share_log WHERE id = ${shareRowId}`
    expect(row.photo_id).toBe(sharePhotoId)
  })

  it('SOFT-deleting the photo is still allowed — the supported path is unaffected', async () => {
    // The fix must not break the thing the app actually does. photoDelete.js soft-deletes and
    // deliberately retains the share row; RESTRICT only ever refuses a HARD delete.
    await directSql`UPDATE photos SET deleted_at = NOW() WHERE id = ${sharePhotoId}`
    const [p] = await directSql`SELECT deleted_at FROM photos WHERE id = ${sharePhotoId}`
    expect(p.deleted_at).not.toBeNull()
    const [s] = await directSql`SELECT id FROM share_log WHERE id = ${shareRowId}`
    expect(s.id, 'the ledger row is retained across a soft delete').toBe(shareRowId)
    await directSql`UPDATE photos SET deleted_at = NULL WHERE id = ${sharePhotoId}`
  })
})

describe('V4-CASCADESWEEP-001 — user_achievements.achievement_id (BUG-ACHIEVECASCADE-001)', () => {
  it('deleting a catalog achievement that has been earned fails 23503', async () => {
    // 33 badges are live in prod against a 39-row catalog; tidying one catalog row destroyed every
    // badge earned against it.
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM achievements WHERE id = ${achievementId}`)).toBe('23503')
  })

  it('the earned badge survives — rewards are never clawed back', async () => {
    const [row] = await directSql`SELECT id FROM user_achievements WHERE id = ${userAchievementId}`
    expect(row.id).toBe(userAchievementId)
  })
})

describe('V4-CASCADESWEEP-001 — findings.garden_node_id (BUG-FINDINGSCASCADE-001)', () => {
  it('hard-deleting a planting with findings fails 23503', async () => {
    // Defence in depth: a planting hard delete is ALREADY refused by event_log/photos/entity and
    // (since v4-entitytagorphan-001) the entity_tag guard. This stops findings being the one child
    // that would still be destroyed if any of those upstream guards were relaxed. The entity row is
    // cleared first so the refusal we observe is this FK and not that one.
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${plantId}`
      .catch(() => {})
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM plants WHERE id = ${plantId}`)).toBe('23503')
    const [f] = await directSql`SELECT garden_node_id FROM findings WHERE id = ${findingId}`
    expect(f.garden_node_id).toBe(plantId)
  })
})

describe('V4-CASCADESWEEP-001 — schema pins and the class gate', () => {
  it('all four FKs are RESTRICT and VALIDATED', async () => {
    const rows = await directSql`
      SELECT conname, confdeltype, convalidated FROM pg_constraint
       WHERE conname IN ('photos_inventory_item_id_fkey','user_achievements_achievement_id_fkey',
                         'share_log_photo_id_fkey','findings_garden_node_id_fkey')`
    expect(rows).toHaveLength(4)
    for (const r of rows) {
      expect(r.confdeltype, `${r.conname} must be RESTRICT`).toBe('r')
      expect(r.convalidated, `${r.conname} must be validated, not NOT VALID`).toBe(true)
    }
  })

  it('three of the four child columns are NOT NULL — SET NULL was never available', async () => {
    // Pins the argument, not just the conclusion. If one of these ever becomes nullable, the
    // "RESTRICT was the only option" reasoning in the migration header stops being true and the
    // decision deserves re-reading.
    const rows = await directSql`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE (table_name, column_name) IN
             (('findings','garden_node_id'),('user_achievements','achievement_id'),
              ('share_log','photo_id'))`
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.is_nullable, `${r.table_name}.${r.column_name}`).toBe('NO')
  })

  it('user_achievements.trigger_event_id is DELIBERATELY still SET NULL', async () => {
    // The intended asymmetry, in the same table as one of the flips: the badge is protected, its
    // provenance pointer is not, because nulling provenance costs no user-visible data and rewards
    // are never clawed back (V4-EVTCASCADE-001). Without this pin the pair reads like an oversight
    // and a future sweep "corrects" it.
    const [row] = await directSql`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'user_achievements_trigger_event_id_fkey'`
    expect(row.confdeltype).toBe('n')
  })

  // ── The one that matters most ────────────────────────────────────────────────────────────────
  // The audit had to enumerate destructive FKs by hand to find these four. This asserts the class
  // instead: a table carrying `deleted_at` has declared itself soft-delete-only, so no FK may
  // CASCADE into it. Note the honest scope — it covers only TWO of this migration's four flips,
  // because share_log and user_achievements are append-only and carry no deleted_at. A broader
  // criterion (deleted_at OR created_by OR user_id) was measured and rejected: it needs a five-entry
  // allow-list of things that SHOULD cascade and still misses share_log.
  it('no FK CASCADEs into a soft-deletable table (class guard)', async () => {
    const ALLOWED = new Set([
      // Derived caches and closure rows: rebuilt from live data, correct to die with their parent.
      'entity_memory_plant_id_fkey', 'entity_memory_project_id_fkey',
      'entity_memory_location_id_fkey',
      'container_closure_ancestor_id_fkey', 'container_closure_descendant_id_fkey',
      'inactive_project_dismissals_project_id_fkey',
    ])
    const rows = await directSql`
      SELECT c.conname, t.relname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
       WHERE c.contype = 'f' AND c.confdeltype = 'c'
         AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.conrelid AND a.attname = 'deleted_at'
                        AND NOT a.attisdropped)`
    const offenders = rows.filter(r => !ALLOWED.has(r.conname)).map(r => `${r.relname} (${r.conname})`)
    expect(offenders,
      'a CASCADE into a table that carries deleted_at — that table has declared itself ' +
      'soft-delete-only, so either the FK is wrong or the deleted_at column is').toEqual([])
  })
})
