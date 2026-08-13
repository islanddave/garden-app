// tests/integration/entity-tag-orphan.int.test.js
// BUG-ENTITYTAGORPHAN-001 — the polymorphic edge on entity_tag.entity_id.
//
// THE DEFECT. entity_tag is polymorphic: (entity_type, entity_id), where entity_type is
// CHECK-constrained to 'plant' | 'cultivar' | 'location' | 'project' and entity_id is a bare uuid.
// No foreign key is POSSIBLE — the referent table is chosen by a sibling column, which Postgres
// cannot express — so nothing at the database level ever stopped a parent being deleted out from
// under its tags. Three AFTER DELETE triggers looked like cover; every one of them deletes from the
// LEGACY PLURAL `entity_tags` debris table (2 rows), not `entity_tag`. They are no-ops wearing the
// costume of a guarantee, and they cover plant/project/location — the three types that hold ZERO
// tags — while cultivar, which holds all 1,016, had no trigger at all.
//
// v4-entitytagorphan-001 adds one read-only function and four BEFORE DELETE triggers that raise
// 23503: a polymorphic foreign key, spelled as a trigger because it cannot be spelled as a
// constraint.
//
// WHAT THIS FILE PROVES, in order:
//   1. the premise — entity_id genuinely carries no FK, so a trigger is doing a constraint's job;
//   2. the fix, on ALL FOUR parent types, not just the one that has data today;
//   3. that it counts SOFT-DELETED associations too — the load-bearing design choice, since a
//      foreign key does not know what a soft delete is and an association whose referent is gone
//      cannot be restored, only resurrected as a dangling pointer;
//   4. that it did NOT over-block — an untagged parent still deletes;
//   5. the escape hatch — withdrawing the associations explicitly unblocks the delete;
//   6. that the guard fires through the `cultivar` VIEW, which is the spelling the app and the
//      other suites actually use;
//   7. a CLASS guard: every entity_type the CHECK admits has a guard on its parent table.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, insertProject } from './_harness.js'

const RUN = testRunId()
const USER = `entitytagorphan-${RUN}`

let tagId
let plantId, cultivarId, locationId, projectId
let untaggedCultivarId, escapeCultivarId

async function sqlstateOf(fn) {
  try { await fn(); return null } catch (e) { return e.code ?? e.sourceError?.code ?? String(e.message) }
}

async function tag(entityType, entityId) {
  const rows = await directSql`
    INSERT INTO public.entity_tag (tag_id, entity_type, entity_id, created_by)
    VALUES (${tagId}, ${entityType}, ${entityId}, ${USER}) RETURNING id`
  return rows[0].id
}

beforeAll(async () => {
  const t = await directSql`
    INSERT INTO public.tag (facet, label, slug, owner_id, created_by, visibility)
    VALUES ('group', ${'etorphan-' + RUN}, ${'etorphan-' + RUN}, ${USER}, ${USER}, 'shared')
    RETURNING id`
  tagId = t[0].id

  projectId = (await insertProject({ name: `etorphan-proj-${RUN}`, createdBy: USER })).id

  const p = await directSql`
    INSERT INTO plants (name, created_by) VALUES (${'etorphan-plant-' + RUN}, ${USER}) RETURNING id`
  plantId = p[0].id

  const v = await directSql`
    INSERT INTO plant_varieties (name, created_by)
    VALUES (${'etorphan-cv-' + RUN}, ${USER}) RETURNING id`
  cultivarId = v[0].id

  const v2 = await directSql`
    INSERT INTO plant_varieties (name, created_by)
    VALUES (${'etorphan-cv-untagged-' + RUN}, ${USER}) RETURNING id`
  untaggedCultivarId = v2[0].id

  const v3 = await directSql`
    INSERT INTO plant_varieties (name, created_by)
    VALUES (${'etorphan-cv-escape-' + RUN}, ${USER}) RETURNING id`
  escapeCultivarId = v3[0].id

  const l = await directSql`
    INSERT INTO locations (name, slug, created_by)
    VALUES (${'etorphan-loc-' + RUN}, ${'etorphan-loc-' + RUN}, ${USER}) RETURNING id`
  locationId = l[0].id

  await tag('plant', plantId)
  await tag('cultivar', cultivarId)
  await tag('location', locationId)
  await tag('project', projectId)
  await tag('cultivar', escapeCultivarId)
})

afterAll(async () => {
  // entity_tag FIRST — that is the whole point of this migration, and this teardown is the shape
  // every suite touching a tagged entity now has to adopt. Then `tag`, because entity_tag.tag_id ->
  // tag(id) is RESTRICT in the other direction.
  await directSql`DELETE FROM public.entity_tag WHERE created_by = ${USER}`
  await directSql`DELETE FROM public.tag WHERE owner_id = ${USER}`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${plantId}`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity WHERE cultivar_ref_id IN (
    SELECT id FROM plant_varieties WHERE created_by = ${USER})`
  await directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`
  await directSql`DELETE FROM locations WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('BUG-ENTITYTAGORPHAN-001 — the premise: no foreign key is possible here', () => {
  it('entity_tag.entity_id carries no declared FK, which is why a trigger does the job', async () => {
    const rows = await directSql`
      SELECT 1 FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f' AND c.conrelid = 'public.entity_tag'::regclass
         AND a.attname = 'entity_id'`
    expect(rows).toHaveLength(0)
  })

  it('tag_id DOES carry a real FK — the contrast that shows the gap was structural, not an oversight', async () => {
    const [row] = await directSql`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'entity_tag_tag_id_fkey'`
    expect(row.confdeltype).toBe('r')
  })
})

describe('BUG-ENTITYTAGORPHAN-001 — the fix refuses on all four parent types', () => {
  it('a tagged CULTIVAR cannot be hard-deleted (all 1,016 prod rows are this type)', async () => {
    // The type that had no trigger of any kind, protected until now only by the side effect of an
    // unrelated ticket's FK (entity.cultivar_ref_id RESTRICT) which the staging purge routes around.
    await directSql`DELETE FROM entity WHERE cultivar_ref_id = ${cultivarId}`
    const code = await sqlstateOf(() =>
      directSql`DELETE FROM plant_varieties WHERE id = ${cultivarId}`)
    expect(code).toBe('23503')
  })

  it('a tagged PLANT cannot be hard-deleted', async () => {
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${plantId}`
    expect(await sqlstateOf(() => directSql`DELETE FROM plants WHERE id = ${plantId}`)).toBe('23503')
  })

  it('a tagged LOCATION cannot be hard-deleted', async () => {
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM locations WHERE id = ${locationId}`)).toBe('23503')
  })

  it('a tagged PROJECT cannot be hard-deleted', async () => {
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM plant_projects WHERE id = ${projectId}`)).toBe('23503')
  })

  it('the refusal names entity_tag, so the obstacle is diagnosable from the error alone', async () => {
    let msg = ''
    try { await directSql`DELETE FROM locations WHERE id = ${locationId}` }
    catch (e) { msg = `${e.message} ${e.sourceError?.message ?? ''} ${e.hint ?? ''}` }
    expect(msg).toMatch(/entity_tag/)
  })

  it('NOTHING is half-done: parent and association both survive a refused delete', async () => {
    const [loc] = await directSql`SELECT id FROM locations WHERE id = ${locationId}`
    expect(loc.id).toBe(locationId)
    const links = await directSql`
      SELECT id FROM public.entity_tag WHERE entity_type = 'location' AND entity_id = ${locationId}`
    expect(links).toHaveLength(1)
  })

  it('fires through the `cultivar` VIEW too — the spelling the app and other suites use', async () => {
    // plant_varieties is the base table; `cultivar` is a view over it. A DELETE through the view is
    // rewritten onto the base table, so the row trigger fires — but that is a property of the
    // rewrite, not something the migration states, so it is asserted rather than assumed.
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM cultivar WHERE id = ${cultivarId}`)).toBe('23503')
  })
})

describe('BUG-ENTITYTAGORPHAN-001 — it counts soft-deleted associations too', () => {
  it('a SOFT-DELETED association still blocks the parent delete', async () => {
    // The load-bearing design choice. A foreign key does not know what a soft delete is, and
    // V4-SOFTDEL-001's second promise is that data stays RECOVERABLE — an association whose
    // referent no longer exists cannot be restored, only resurrected as a dangling pointer. If this
    // ever goes green with the guard filtering on deleted_at IS NULL, the orphan count starts
    // creeping up invisibly and post_no_orphaned_entity_tag_rows stops being true.
    await directSql`
      UPDATE public.entity_tag SET deleted_at = NOW()
       WHERE entity_type = 'location' AND entity_id = ${locationId}`
    const code = await sqlstateOf(() =>
      directSql`DELETE FROM locations WHERE id = ${locationId}`)
    expect(code, 'a withdrawn association is still a reference').toBe('23503')
    await directSql`
      UPDATE public.entity_tag SET deleted_at = NULL
       WHERE entity_type = 'location' AND entity_id = ${locationId}`
  })
})

describe('BUG-ENTITYTAGORPHAN-001 — did not over-block, and the escape hatch works', () => {
  it('an UNTAGGED parent still deletes cleanly', async () => {
    // A guard that refuses everything would pass every test above while breaking the one operation
    // that must keep working.
    await directSql`DELETE FROM entity WHERE cultivar_ref_id = ${untaggedCultivarId}`
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM plant_varieties WHERE id = ${untaggedCultivarId}`)).toBeNull()
    const rows = await directSql`SELECT id FROM plant_varieties WHERE id = ${untaggedCultivarId}`
    expect(rows).toHaveLength(0)
  })

  it('withdrawing the associations explicitly unblocks the delete', async () => {
    await directSql`DELETE FROM entity WHERE cultivar_ref_id = ${escapeCultivarId}`
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM plant_varieties WHERE id = ${escapeCultivarId}`)).toBe('23503')

    await directSql`
      DELETE FROM public.entity_tag WHERE entity_type = 'cultivar' AND entity_id = ${escapeCultivarId}`

    expect(await sqlstateOf(() =>
      directSql`DELETE FROM plant_varieties WHERE id = ${escapeCultivarId}`)).toBeNull()
  })
})

describe('BUG-ENTITYTAGORPHAN-001 — schema pins and the class guard', () => {
  it('the guard function exists and is READ-ONLY', async () => {
    // A BEFORE DELETE trigger that MODIFIES rows can defuse a downstream RESTRICT before it fires,
    // leaving a constraint that looks armed and guards nothing. v4-plantrehomefk-001 originally
    // banned BEFORE DELETE triggers on plants/plant_projects outright for that reason; that ban was
    // relaxed to a property check so this migration's guards could exist, which makes this
    // assertion load-bearing for BOTH migrations.
    const [row] = await directSql`
      SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'guard_entity_tag_parent_delete'`
    expect(row, 'the guard function must exist').toBeTruthy()
    expect(row.prosrc).not.toMatch(/insert\s+into/i)
    expect(row.prosrc).not.toMatch(/update\s+public\./i)
    expect(row.prosrc).not.toMatch(/delete\s+from/i)
  })

  // ── The one that matters most ────────────────────────────────────────────────────────────────
  // The guard set is complete only RELATIVE to the entity types entity_tag admits. The legacy
  // triggers are themselves the cautionary tale: cover existed for three types with no tags while
  // the type holding all 1,016 had none, and nothing detected that for as long as it was true. This
  // derives the expected set from the CHECK rather than hardcoding it, so a fifth entity_type fails
  // here instead of shipping with no parent guard.
  it('every entity_type the CHECK admits has a guard on its parent table (class guard)', async () => {
    const PARENT_OF = {
      plant: 'plants',
      cultivar: 'plant_varieties',
      location: 'locations',
      project: 'plant_projects',
    }
    const [chk] = await directSql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'entity_tag_entity_type_check'`
    const admitted = [...chk.def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort()
    expect(admitted.length, 'the CHECK must enumerate its types as literals').toBeGreaterThan(0)

    const unmapped = admitted.filter(t => !(t in PARENT_OF))
    expect(unmapped,
      'entity_tag admits an entity_type with no known parent table — add it to PARENT_OF and give ' +
      'it a guard trigger in a migration').toEqual([])

    const guards = await directSql`
      SELECT t.relname AS parent FROM pg_trigger g
        JOIN pg_class t ON t.oid = g.tgrelid
       WHERE NOT g.tgisinternal AND g.tgname LIKE 'trg_guard_entity_tag_%'`
    const guarded = new Set(guards.map(g => g.parent))

    const unguarded = admitted.filter(t => !guarded.has(PARENT_OF[t]))
    expect(unguarded,
      'an admitted entity_type whose parent table has no guard trigger — a hard delete there ' +
      'orphans associations silently, which is the defect this migration closed').toEqual([])
  })
})
