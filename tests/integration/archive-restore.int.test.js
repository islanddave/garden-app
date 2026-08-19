// tests/integration/archive-restore.int.test.js
// OPS-ARCHRESTORE-001 — event_log_archive / harvest_log_archive preserved a full row_data snapshot
// and nothing reconstituted it. Closed by migrations/v4-archrestore-001, in BOTH directions.
//
// THE FINDING BEHIND THE FINDING, and it is what decides this suite's shape. The ticket reads as
// "write the inverse routine". It is not: both archive routines DETACH photos before deleting the
// events — photos.event_id is set to NULL (and, in the container routine, project_id cleared and
// plant_id / location_id COALESCEd forward) — and the severed value was written NOWHERE. Not into
// row_data, which is to_jsonb() over the EVENT row, not the photos. Not into the archive tables. An
// un-archive built alone would therefore have shipped a "restore" that silently gives back less
// than archiving took, which is the exact class the soft-delete audit's own §5 keeps naming: a
// guarantee that is vacuous in the direction nobody measured.
//
// So the ARCHIVE side is fixed first, in the same migration, and this suite proves the round trip
// rather than proving the inverse routine in isolation. Both archive tables held 0 rows in prod at
// authoring time, so no backfill was owed and nothing historical was lost by that ordering.
//
// WHY A TABLE AND NOT A COLUMN, pinned by test 6 below. The recon proposed a detached_photo_ids /
// photo_links COLUMN on event_log_archive. That cannot hold the whole detach set:
// archive_container_events() detaches on the PROJECT axis for photos with no event in the batch
// (12 such photos in live prod 2026-08-12), and an event-less container archives ZERO rows while
// still detaching. In both cases a per-archive-row column has nowhere to write.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, insertProject } from './_harness.js'

const RUN = testRunId()
const USER = `archrestore-${RUN}`

let projectId, otherProjectId, plantId, locId, doomedLocId
let eventRichId, eventDoomedId, harvestId, photoId, foreignPhotoId, foreignEventId

async function errOf(fn) {
  try { await fn(); return null } catch (e) { return `${e.message} ${e.sourceError?.message ?? ''} ${e.hint ?? ''} ${e.detail ?? ''}` }
}

// Re-seed the archivable world. Called before each archive-dependent block so a block that leaves
// the world archived cannot poison the next one.
async function seed() {
  const ev = await directSql`
    INSERT INTO event_log
      (plant_id, project_id, location_id, event_type, event_date, created_by, logged_by,
       title, notes, private_notes, quantity, quantity_numeric, is_public, metadata,
       flagged_as_issue, severity, resolved_at, resolved_by, treatment_category, treatment_amount,
       pest_target, source, deleted_at, created_at, updated_at)
    VALUES
      (${plantId}, ${projectId}, ${locId}, 'harvest', '2026-07-01T12:00:00Z', ${USER}, ${USER + '-logger'},
       'title', 'notes', 'private', '3 lb', 3.5, false, ${'{"k":"v"}'}::jsonb,
       true, 2, '2026-07-02T00:00:00Z', ${USER + '-res'}, 'pest_control', '2 tbsp',
       'aphid', 'import', '2026-07-03T00:00:00Z', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z')
    RETURNING id`
  eventRichId = ev[0].id

  const ev2 = await directSql`
    INSERT INTO event_log (plant_id, project_id, location_id, event_type, event_date, created_by)
    VALUES (${plantId}, ${projectId}, ${doomedLocId}, 'note', '2026-07-04T00:00:00Z', ${USER})
    RETURNING id`
  eventDoomedId = ev2[0].id

  const hv = await directSql`
    INSERT INTO harvest_log
      (event_id, project_id, quantity, unit, created_by, quality_rating, notes,
       weight_grams, weight_estimated, weight_basis, created_at, updated_at)
    VALUES (${eventRichId}, ${projectId}, 3.5, 'lb', ${USER}, 4, 'harvest note',
            1587.6, true, 'cultivar_sample', '2026-06-03T00:00:00Z', '2026-06-04T00:00:00Z')
    RETURNING id`
  harvestId = hv[0].id

  // A photo whose only live parent is the event. It survives Guard 2 because the event carries a
  // project the detach can COALESCE forward — which is also why the un-archive deliberately does
  // NOT revert that gained parent (see test 3).
  const ph = await directSql`
    INSERT INTO photos (event_id, storage_path, created_by)
    VALUES (${eventRichId}, ${'archrestore/' + RUN + '.jpg'}, ${USER}) RETURNING id`
  photoId = ph[0].id
}

async function drainArchives() {
  await directSql`DELETE FROM harvest_log_archive  WHERE archived_plant_id = ${plantId} OR archived_project_id IN (${projectId}, ${otherProjectId})`
  await directSql`DELETE FROM event_log_archive    WHERE archived_plant_id = ${plantId} OR archived_project_id IN (${projectId}, ${otherProjectId})`
  await directSql`DELETE FROM photo_detach_archive WHERE archived_plant_id = ${plantId} OR archived_project_id IN (${projectId}, ${otherProjectId})`
}

beforeAll(async () => {
  projectId      = (await insertProject({ name: `archrestore-proj-${RUN}`,  createdBy: USER })).id
  otherProjectId = (await insertProject({ name: `archrestore-proj2-${RUN}`, createdBy: USER })).id

  const pl = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${projectId}, ${'archrestore-plant-' + RUN}, ${USER}) RETURNING id`
  plantId = pl[0].id

  const l1 = await directSql`
    INSERT INTO locations (name, slug, created_by)
    VALUES (${'archrestore-loc-' + RUN}, ${'archrestore-loc-' + RUN}, ${USER}) RETURNING id`
  locId = l1[0].id
  const l2 = await directSql`
    INSERT INTO locations (name, slug, created_by)
    VALUES (${'archrestore-doomed-' + RUN}, ${'archrestore-doomed-' + RUN}, ${USER}) RETURNING id`
  doomedLocId = l2[0].id

  await seed()
})

afterAll(async () => {
  // The archive tables are NOT swept by tests/integration/_cleanup.js (a pre-existing gap this
  // migration does not widen — archive-preservation-guard.int.test.js already leaves rows behind).
  // Drain our own, by provenance key, before the parents go.
  await drainArchives()
  await directSql`DELETE FROM photos      WHERE created_by = ${USER}`
  await directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM event_log   WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity      WHERE entity_type='planting' AND planting_ref_id = ${plantId}`
  await directSql`DELETE FROM plants      WHERE created_by = ${USER}`
  await directSql`DELETE FROM locations   WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

// ═══ 1. The premise ═══════════════════════════════════════════════════════════════════════════
describe('OPS-ARCHRESTORE-001 — the mechanism the capture exists to close', () => {
  it('row_data snapshots the EVENT row, so the photo linkage was never in it', async () => {
    // Pins the premise rather than assuming it. If row_data ever grows a photo key, the capture
    // table becomes redundant and this assertion is the one that should break first.
    const [row] = await directSql`
      SELECT to_jsonb(e) AS snap FROM event_log e WHERE e.id = ${eventRichId}`
    expect(Object.keys(row.snap)).not.toContain('photo_id')
    expect(Object.keys(row.snap)).not.toContain('photos')
  })

  it('the un-archive routines exist and are symmetric with the archive ones', async () => {
    const rows = await directSql`
      SELECT p.proname, pg_get_function_result(p.oid) AS result
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
       WHERE p.proname IN ('unarchive_plant_events','unarchive_container_events')`
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.result).toBe(
        'TABLE(events_restored integer, harvests_restored integer, photos_relinked integer)')
    }
  })
})

// ═══ 2. Round trip ════════════════════════════════════════════════════════════════════════════
describe('OPS-ARCHRESTORE-001 — archive -> unarchive is a true round trip', () => {
  it('archiving captures the detach and stamps a schema fingerprint', async () => {
    const before = await directSql`SELECT * FROM event_log WHERE id = ${eventRichId}`
    expect(before[0].event_id).toBeUndefined()

    const res = await directSql`SELECT * FROM archive_plant_events(${plantId}::uuid, 'int-test')`
    expect(res[0].events_archived).toBe(2)
    expect(res[0].harvests_archived).toBe(1)
    expect(res[0].photos_detached).toBe(1)

    const cap = await directSql`
      SELECT photo_id, pre_image FROM photo_detach_archive WHERE archived_plant_id = ${plantId}`
    expect(cap, 'the severed link must be recorded, not just discarded').toHaveLength(1)
    expect(cap[0].photo_id).toBe(photoId)
    expect(cap[0].pre_image.event_id, 'this is the value that used to go nowhere').toBe(eventRichId)

    const [fp] = await directSql`
      SELECT DISTINCT schema_fingerprint AS fp FROM event_log_archive WHERE archived_plant_id = ${plantId}`
    expect(fp.fp, 'a NULL fingerprint would make drift undetectable').toBeTruthy()

    // and the photo really is detached
    const [ph] = await directSql`SELECT event_id FROM photos WHERE id = ${photoId}`
    expect(ph.event_id).toBeNull()
  })

  it('unarchiving restores EVERY event_log column, including the row_data-only ones', async () => {
    const snapBefore = await directSql`
      SELECT row_data FROM event_log_archive WHERE id = ${eventRichId}`
    const snap = snapBefore[0].row_data

    const res = await directSql`SELECT * FROM unarchive_plant_events(${plantId}::uuid)`
    expect(res[0].events_restored).toBe(2)
    expect(res[0].harvests_restored).toBe(1)
    expect(res[0].photos_relinked).toBe(1)

    const [live] = await directSql`SELECT to_jsonb(e) AS row FROM event_log e WHERE e.id = ${eventRichId}`
    // Column-by-column, not a spot check: these are precisely the columns event_log_archive does
    // NOT denormalise, i.e. the ones recoverable only from row_data.
    for (const col of ['title', 'notes', 'private_notes', 'quantity', 'quantity_numeric', 'is_public',
                       'metadata', 'flagged_as_issue', 'severity', 'resolved_at', 'resolved_by',
                       'treatment_category', 'treatment_amount', 'pest_target', 'source',
                       'logged_by', 'deleted_at', 'created_at', 'updated_at', 'created_by']) {
      expect(live.row[col], `event_log.${col} must round-trip`).toEqual(snap[col])
    }
  })

  it('updated_at and created_by survive verbatim — the triggers are UPDATE-only, not INSERT', async () => {
    // Measured, not assumed: pg_trigger.tgtype = 19 (ROW|BEFORE|UPDATE) for both
    // prevent_ownership_transfer and set_updated_at on event_log. A BEFORE INSERT variant of either
    // would silently rewrite the restored row, and every other assertion here would still pass.
    const rows = await directSql`
      SELECT t.tgname, t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'event_log' AND NOT t.tgisinternal ORDER BY t.tgname`
    // v4-harvestaudit-001 adds trg_audit_event_log_upd/_del (AFTER ... FOR EACH STATEMENT) to this
    // table, so a bare count of 2 no longer holds. Asserting 4 instead would only move the same
    // brittleness one bundle along, so pin the two row-level triggers this test is ABOUT by name and
    // then assert the actual hazard directly against every trigger present, whatever arrives later.
    const byName = Object.fromEntries(rows.map(r => [r.tgname, r.tgtype]))
    for (const n of ['prevent_ownership_transfer', 'set_updated_at']) {
      expect(byName[n], `${n} must still exist on event_log`).toBeDefined()
      expect(byName[n], `${n} must be BEFORE UPDATE ROW only`).toBe(19)
    }
    // The hazard, stated once and checked against ALL triggers: nothing on event_log may fire BEFORE
    // INSERT, which would rewrite a restored row while every other assertion here still passed.
    // tgtype bits: 0x01 ROW, 0x02 BEFORE, 0x04 INSERT, 0x08 DELETE, 0x10 UPDATE.
    for (const r of rows) {
      const beforeInsert = (r.tgtype & 0x02) === 0x02 && (r.tgtype & 0x04) === 0x04
      expect(beforeInsert, `${r.tgname} must not fire BEFORE INSERT`).toBe(false)
    }

    const [e] = await directSql`SELECT updated_at, created_by FROM event_log WHERE id = ${eventRichId}`
    expect(e.updated_at.toISOString()).toBe(new Date('2026-06-02T00:00:00Z').toISOString())
    expect(e.created_by).toBe(USER)
  })

  it('harvest_log round-trips too, including the columns only row_data carried', async () => {
    const [h] = await directSql`SELECT * FROM harvest_log WHERE id = ${harvestId}`
    expect(h.quality_rating).toBe(4)
    expect(h.notes).toBe('harvest note')
    expect(Number(h.weight_grams)).toBe(1587.6)
    expect(h.weight_estimated).toBe(true)
    expect(h.weight_basis).toBe('cultivar_sample')
    expect(h.created_by).toBe(USER)
    expect(h.updated_at.toISOString()).toBe(new Date('2026-06-04T00:00:00Z').toISOString())
  })

  it('the cold store is drained in the same transaction — a move, not a copy', async () => {
    const rows = await directSql`
      SELECT (SELECT count(*) FROM event_log_archive    WHERE archived_plant_id = ${plantId}) AS ev,
             (SELECT count(*) FROM harvest_log_archive  WHERE archived_plant_id = ${plantId}) AS hv,
             (SELECT count(*) FROM photo_detach_archive WHERE archived_plant_id = ${plantId}) AS ph`
    expect(Number(rows[0].ev)).toBe(0)
    expect(Number(rows[0].hv)).toBe(0)
    expect(Number(rows[0].ph)).toBe(0)
  })

  it('a second un-archive is a clean zero, not an error', async () => {
    const res = await directSql`SELECT * FROM unarchive_plant_events(${plantId}::uuid)`
    expect(res[0].events_restored).toBe(0)
    expect(res[0].harvests_restored).toBe(0)
    expect(res[0].photos_relinked).toBe(0)
  })
})

// ═══ 3. Photo links ═══════════════════════════════════════════════════════════════════════════
describe('OPS-ARCHRESTORE-001 — the photo link comes back', () => {
  it('the severed event_id is restored, and the COALESCEd-forward parent is deliberately kept', async () => {
    const [ph] = await directSql`SELECT * FROM photos WHERE id = ${photoId}`
    expect(ph.event_id, 'THE headline assertion of this ticket').toBe(eventRichId)
    // The detach gave the photo its event's project as a parent. The un-archive does NOT revert
    // that: it is additive, semantically true, and reverting it is the one way this routine could
    // destroy information rather than restore it. Restoration is of the SEVERED link only.
    expect(ph.project_id).toBe(projectId)
  })

  it('a photo re-parented after archiving is a refusal, never an overwrite', async () => {
    await drainArchives()
    await directSql`SELECT * FROM archive_plant_events(${plantId}::uuid, 'int-test-conflict')`
    // someone hangs the photo off a different event while it sits detached
    const other = await directSql`
      INSERT INTO event_log (project_id, event_type, event_date, created_by)
      VALUES (${otherProjectId}, 'note', NOW(), ${USER}) RETURNING id`
    foreignEventId = other[0].id
    await directSql`UPDATE photos SET event_id = ${foreignEventId} WHERE id = ${photoId}`

    const msg = await errOf(() => directSql`SELECT * FROM unarchive_plant_events(${plantId}::uuid)`)
    expect(msg, 'silently skipping would be the same under-restore the ticket exists to stop').toBeTruthy()
    expect(msg).toMatch(/conflict/i)

    // and nothing is half-done: the events are still archived, the photo still points where the
    // user put it.
    const [ph] = await directSql`SELECT event_id FROM photos WHERE id = ${photoId}`
    expect(ph.event_id).toBe(foreignEventId)
    const [c] = await directSql`SELECT count(*) AS n FROM event_log_archive WHERE archived_plant_id = ${plantId}`
    expect(Number(c.n)).toBe(2)

    // unblock and finish
    await directSql`UPDATE photos SET event_id = NULL WHERE id = ${photoId}`
    await directSql`DELETE FROM event_log WHERE id = ${foreignEventId}`
    const res = await directSql`SELECT * FROM unarchive_plant_events(${plantId}::uuid)`
    expect(res[0].photos_relinked).toBe(1)
  })
})

// ═══ 4. Refusals ══════════════════════════════════════════════════════════════════════════════
describe('OPS-ARCHRESTORE-001 — it refuses rather than half-restoring', () => {
  it('a missing parent planting refuses, naming what to restore first', async () => {
    await drainArchives()
    await directSql`SELECT * FROM archive_plant_events(${plantId}::uuid, 'int-test-parent')`

    // Take the planting away without disturbing the archive rows (they carry no FKs, by design).
    const saved = await directSql`SELECT * FROM plants WHERE id = ${plantId}`
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${plantId}`
    await directSql`DELETE FROM plants WHERE id = ${plantId}`

    const msg = await errOf(() => directSql`SELECT * FROM unarchive_plant_events(${plantId}::uuid)`)
    expect(msg, 'event_log.plant_id is RESTRICT, so this is mandatory not advisory').toBeTruthy()
    expect(msg).toMatch(/no longer exists/)
    expect(msg).toMatch(/RESTRICT/)

    await directSql`
      INSERT INTO plants (id, project_id, name, created_by, created_at, updated_at)
      VALUES (${plantId}, ${saved[0].project_id}, ${saved[0].name}, ${saved[0].created_by},
              ${saved[0].created_at}, ${saved[0].updated_at})`
  })

  it('an id that already exists live refuses — never ON CONFLICT DO NOTHING', async () => {
    // Re-create one of the archived events by hand: a partial prior un-archive, or an id collision.
    await directSql`
      INSERT INTO event_log (id, plant_id, project_id, event_type, event_date, created_by)
      VALUES (${eventDoomedId}, ${plantId}, ${projectId}, 'note', NOW(), ${USER})`

    const msg = await errOf(() => directSql`SELECT * FROM unarchive_plant_events(${plantId}::uuid)`)
    expect(msg, 'a skip here would report a partial restore as a complete one').toBeTruthy()
    expect(msg).toMatch(/already exist/)
    expect(msg).toContain(eventDoomedId)

    await directSql`DELETE FROM event_log WHERE id = ${eventDoomedId}`
  })

  it('no un-archive routine contains ON CONFLICT at all — pinned structurally', async () => {
    const rows = await directSql`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname='public'
       WHERE p.proname IN ('unarchive_plant_events','unarchive_container_events','unarchive_events_apply')
         AND p.prosrc ~* 'on\\s+conflict'`
    expect(rows, 'a future "make it forgiving" edit must not land quietly').toHaveLength(0)
  })

  it('a dangling location_id is NULLED, matching that FK own SET NULL — not refused', async () => {
    // The one column treated differently, and deliberately so: event_log_location_id_fkey is
    // ON DELETE SET NULL, so if the location has since gone, SET NULL is exactly what the database
    // would have done to a live row. Every other FK-bearing column is RESTRICT and refuses.
    await directSql`DELETE FROM locations WHERE id = ${doomedLocId}`

    const res = await directSql`SELECT * FROM unarchive_plant_events(${plantId}::uuid)`
    expect(res[0].events_restored).toBe(2)

    const [e] = await directSql`SELECT * FROM event_log WHERE id = ${eventDoomedId}`
    expect(e.location_id, 'nulled, not refused').toBeNull()
    expect(e.event_type, 'and every other column still round-trips').toBe('note')
    expect(e.plant_id).toBe(plantId)

    // the rich event's SURVIVING location is untouched — the null is targeted, not blanket
    const [rich] = await directSql`SELECT location_id FROM event_log WHERE id = ${eventRichId}`
    expect(rich.location_id).toBe(locId)
  })

  it('schema drift refuses rather than silently defaulting the missing column', async () => {
    await drainArchives()
    await directSql`SELECT * FROM archive_plant_events(${plantId}::uuid, 'int-test-drift')`
    // Simulate a snapshot taken before `notes` existed, and a fingerprint from an older schema.
    await directSql`
      UPDATE event_log_archive SET row_data = row_data - 'notes', schema_fingerprint = 'stale-0.0.0'
       WHERE archived_plant_id = ${plantId}`

    const msg = await errOf(() => directSql`SELECT * FROM unarchive_plant_events(${plantId}::uuid)`)
    expect(msg, 'jsonb_populate_record would have defaulted it with no signal').toBeTruthy()
    expect(msg).toMatch(/schema has changed/)
    expect(msg).toMatch(/missing=\[notes\]/)

    // The escape hatch the HINT describes actually works.
    await directSql`
      UPDATE event_log_archive
         SET row_data = row_data || jsonb_build_object('notes', 'notes'),
             schema_fingerprint = public.current_schema_fingerprint()
       WHERE archived_plant_id = ${plantId}`
    const res = await directSql`SELECT * FROM unarchive_plant_events(${plantId}::uuid)`
    expect(res[0].events_restored).toBe(2)
  })
})

// ═══ 5. The container arm, and the design decision it forced ══════════════════════════════════
describe('OPS-ARCHRESTORE-001 — the container routine, and why the capture is a TABLE', () => {
  it('captures a PROJECT-AXIS-ONLY photo, which no column on event_log_archive could hold', async () => {
    // This photo hangs off an event in a DIFFERENT container, so it has no event in this batch and
    // therefore no event_log_archive row to carry a column. Its project_id is still cleared by the
    // detach. A column-shaped capture loses it silently — the same defect one level down.
    const fe = await directSql`
      INSERT INTO event_log (project_id, event_type, event_date, created_by)
      VALUES (${otherProjectId}, 'note', NOW(), ${USER}) RETURNING id`
    foreignEventId = fe[0].id
    const fp = await directSql`
      INSERT INTO photos (event_id, project_id, plant_id, storage_path, created_by)
      VALUES (${foreignEventId}, ${projectId}, ${plantId}, ${'archrestore/x-' + RUN + '.jpg'}, ${USER})
      RETURNING id`
    foreignPhotoId = fp[0].id

    const res = await directSql`SELECT * FROM archive_container_events(${projectId}::uuid, 'int-test-c')`
    expect(res[0].photos_detached).toBeGreaterThanOrEqual(2)

    const [cleared] = await directSql`SELECT project_id FROM photos WHERE id = ${foreignPhotoId}`
    expect(cleared.project_id, 'the detach really did sever it').toBeNull()

    const cap = await directSql`
      SELECT pre_image FROM photo_detach_archive
       WHERE archived_project_id = ${projectId} AND photo_id = ${foreignPhotoId}`
    expect(cap, 'THE reason the capture is a table and not a column').toHaveLength(1)
    expect(cap[0].pre_image.project_id).toBe(projectId)
    expect(cap[0].pre_image.event_id, 'its event is untouched and must stay recorded').toBe(foreignEventId)
  })

  it('unarchiving the container restores that project-axis link too', async () => {
    const res = await directSql`SELECT * FROM unarchive_container_events(${projectId}::uuid)`
    expect(res[0].photos_relinked).toBeGreaterThanOrEqual(2)

    const [ph] = await directSql`SELECT project_id, event_id FROM photos WHERE id = ${foreignPhotoId}`
    expect(ph.project_id).toBe(projectId)
    expect(ph.event_id).toBe(foreignEventId)

    await directSql`DELETE FROM photos WHERE id = ${foreignPhotoId}`
    await directSql`DELETE FROM event_log WHERE id = ${foreignEventId}`
  })

  it('an EVENT-LESS container archives zero rows and still captures its detach', async () => {
    // The second case a column cannot serve: no archive row exists at all, yet a photo was severed.
    const empty = (await insertProject({ name: `archrestore-empty-${RUN}`, createdBy: USER })).id
    const ph = await directSql`
      INSERT INTO photos (project_id, plant_id, storage_path, created_by)
      VALUES (${empty}, ${plantId}, ${'archrestore/empty-' + RUN + '.jpg'}, ${USER}) RETURNING id`

    const res = await directSql`SELECT * FROM archive_container_events(${empty}::uuid, 'int-test-empty')`
    expect(res[0].events_archived).toBe(0)
    expect(res[0].photos_detached).toBe(1)

    const cap = await directSql`SELECT count(*) AS n FROM photo_detach_archive WHERE archived_project_id = ${empty}`
    expect(Number(cap[0].n), 'zero archive rows, one severed link — it still has a home').toBe(1)

    const back = await directSql`SELECT * FROM unarchive_container_events(${empty}::uuid)`
    expect(back[0].photos_relinked).toBe(1)
    const [p2] = await directSql`SELECT project_id FROM photos WHERE id = ${ph[0].id}`
    expect(p2.project_id).toBe(empty)

    await directSql`DELETE FROM photos WHERE id = ${ph[0].id}`
    await directSql`DELETE FROM photo_detach_archive WHERE archived_project_id = ${empty}`
    await directSql`DELETE FROM plant_projects WHERE id = ${empty}`
  })
})

// ═══ 6. Nothing was dropped by the CREATE OR REPLACE ══════════════════════════════════════════
describe('OPS-ARCHRESTORE-001 — the pre-existing archive guards all survive', () => {
  it('every guard from v4-archpreservguard-001 and its ancestors is still in both bodies', async () => {
    // A CREATE OR REPLACE that silently lost a guard would leave every behavioural test above
    // green. Asserted by the text each guard raises, not by a line count.
    const rows = await directSql`
      SELECT p.proname, p.prosrc FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
       WHERE p.proname IN ('archive_plant_events','archive_container_events')`
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.prosrc, `${r.proname}: calibration guard`).toMatch(/cultivar_weight_sample/)
      expect(r.prosrc, `${r.proname}: parentless-photo guard`).toMatch(/no parent/)
      expect(r.prosrc, `${r.proname}: preservation guard`).toMatch(/preservation_log/)
    }
    const container = rows.find(r => r.proname === 'archive_container_events')
    expect(container.prosrc, 'cross-container harvest tripwire').toMatch(/strand detail off a surviving event/)
  })

  it('the ordering invariants both sibling migrations pin still hold', async () => {
    const rows = await directSql`
      SELECT p.proname,
             regexp_instr(p.prosrc, 'event_id\\s*=\\s*(NULL|CASE)')            AS detach_at,
             regexp_instr(p.prosrc, 'INSERT INTO public\\.photo_detach_archive') AS capture_at,
             regexp_instr(p.prosrc, 'DELETE FROM public\\.event_log')          AS ev_delete_at,
             position('preservation_log' in p.prosrc)                          AS guard_at,
             position('DELETE FROM public.harvest_log' in p.prosrc)            AS hv_delete_at
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
       WHERE p.proname IN ('archive_plant_events','archive_container_events')`
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      // v4-softdelcascade-001 post_archive_functions_detach_photos_before_deleting_events
      expect(Number(r.detach_at), `${r.proname}: detach present`).toBeGreaterThan(0)
      expect(Number(r.detach_at), `${r.proname}: detach before event delete`)
        .toBeLessThan(Number(r.ev_delete_at))
      // this migration: the capture must record a link that still exists
      expect(Number(r.capture_at), `${r.proname}: capture before event delete`)
        .toBeLessThan(Number(r.ev_delete_at))
      // v4-archpreservguard-001 post_preservation_guard_precedes_the_harvest_delete
      expect(Number(r.guard_at), `${r.proname}: preservation guard before harvest delete`)
        .toBeLessThan(Number(r.hv_delete_at))
    }
  })

  it('the archive tables and the new cold store all carry NO foreign keys, by design', async () => {
    const rows = await directSql`
      SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname IN ('event_log_archive','harvest_log_archive','photo_detach_archive')
         AND c.contype = 'f'`
    expect(rows, 'an FK would make the cold store refuse the rows it exists to hold').toHaveLength(0)
  })
})
