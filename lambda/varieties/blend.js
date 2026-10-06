// blend.js — V5-VARIETYBLEND-001: the named mix. POST /api/varieties/blend finds, or creates, the
// ONE variety row that stands for "seed saved from these varieties together".
//
// WHY THIS IS ITS OWN MODULE AND NOT MORE SQL IN index.js. select-columns.test.js pins index.js to
// exactly one INSERT INTO public.cultivar (binding fourteen body.* columns a mix does not have) and
// exactly four full-row SELECTs; cultivar-care-profile.test.js pins it to exactly one care_profile
// INSERT. A mix writes the same two tables with a different column set, so its statements live here
// behind their own pins (blend-route.test.js, variety-blend-component-columns.test.js).
//
// NO RUNTIME DEPENDENCY, like lambda/inventory-items/seed-lot-parents.js: the driver, the
// rate-limit spend and the id mint are handed in, so the unit suite can import this file and run
// every helper. The one import is ./validate.js (pure), for auditActor: this file writes the audited
// table, and lambda/audit-actor-empty.test.js requires every such writer to bind the actor through
// the normalizer AT the bind, not to trust a caller to have done it.
//
// THE KEY (contract section 1). blend_key = the LEAF variety ids, lower-case, in uuid order, joined
// by ','. A leaf is a variety whose own blend_key IS NULL. Components are FLAT: a mix named as a
// component is replaced by its own leaves (blend_key.split(',')), so {mix of A and B, C} and
// {A, B, C} are one row. Lower-case hex in the fixed 8-4-4-4-12 layout sorts by code unit exactly as
// Postgres orders the uuid type (bytewise), so the key built here equals
//   (SELECT string_agg(u::text, ',' ORDER BY u) FROM unnest($1::uuid[]) u)
// which is the fragment the other Lambdas use.
//
// WHO OWNS UNIQUENESS. The database keeps one live row per (created_by, blend_key)
// (uq_plant_varieties_creator_blend_key_live). "One per HOUSEHOLD" is kept HERE: the find below runs
// before every write and reads the whole household, and a true race between two members lands on
// uq_plant_varieties_name_species (same leaves -> same automatic name and species), which the
// 23505 arm answers by finding again. The household is an environment variable, not a column, so no
// index could say it.

import { auditActor } from './validate.js';

// Same regex as index.js and household.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MIN_BLEND_LEAVES = 2;
export const MAX_BLEND_LEAVES = 12;   // chk_plant_varieties_blend_key_format admits 2-12 ids

// The Function URL is callable directly, so the request array needs a bound of its own. It is on the
// ids NAMED, before flattening, and is deliberately far above the leaf bound: twelve plantings can
// name at most twelve varieties, but a mix plus its own components legitimately names more ids than
// it has leaves. Past this the body is refused as malformed rather than read.
export const MAX_COMPONENT_IDS = 48;

// " (2)" .. " (9)" — tried in order when the automatic name is already taken by a row that is not
// this household's mix (uq_plant_varieties_name_species is across ALL users).
export const NAME_SUFFIXES = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => ` (${n})`);

export const BLEND_ERRORS = {
  component_unknown: 'One of those varieties could not be found. Reload and try again.',
  blend_needs_two: 'A mix needs at least two different varieties.',
  blend_too_many: `A mix can hold at most ${MAX_BLEND_LEAVES} varieties.`,
  mixed_crop_components: 'A mix is filed under one crop. These varieties are recorded as different crops.',
};

// What the restore arm (and the revive here) answers when un-deleting a variety trips a unique
// index. Both are bare indexes with no pg_constraint row; Postgres still reports the index name in
// err.constraint.
export const RESTORE_CONFLICT_MESSAGES = {
  uq_plant_varieties_creator_blend_key_live:
    'This mix was made again after it was deleted, so a live one already stands for the same varieties. Use that one.',
  uq_plant_varieties_name_species:
    'Another variety already uses this name. Rename that one, then restore this one.',
};
export const RESTORE_CONFLICT_DEFAULT = 'This variety clashes with one that already exists, so it was not restored.';
export const restoreConflictMessage = (err) => RESTORE_CONFLICT_MESSAGES[err?.constraint] ?? RESTORE_CONFLICT_DEFAULT;

// ── The mix's cadence profile row (contract section 2, the OPEN item) ───────────────────────────────
//
// The ordinary create writes NEW_CULTIVAR_PROFILE, _basis 'unresearched'. A mix must NOT carry that
// label: v4-cadencerefill-001's standing gate post_no_live_planting_rests_on_an_unresearched_placeholder
// counts every live planting whose cultivar row says _basis = 'unresearched' while v_resolved_care
// supplies no cadence, so the first planting sown under a mix would red it — and nobody can ever
// clear it the way that gate intends, because there is nothing to research about a mix that is not
// already research about its components. The gate's own note names the exit: "_basis is relabelled
// for a deliberate watering-free decision". This row is that: it exists (so the sibling gate
// post_no_live_planting_lacks_a_cadence_profile is satisfied), it says what it is, and it carries no
// watering key, no key engine.js reads past the adopt gate, and no crop/genus string — for the
// reasons index.js gives above NEW_CULTIVAR_PROFILE, all of which hold here unchanged. A planting
// under a mix therefore waters on the bundled fallback exactly as a new cultivar's does.
//
// KNOWN COST, not hidden: v5-rekeystrand-001's guard excuses a stranded profile only while _basis is
// 'unresearched'. A mix whose last live planting is re-keyed to another variety will flag there
// until its profile is deleted or given a _retained sentence. See the lane report.
export const BLEND_PROFILE = {
  _source: 'blend-create',
  _basis: 'blend',
  notes: 'Auto-created with a named mix so its variety has a cadence profile row '
       + '(DRG-CADENCEFLOOR-001). A mix has no care of its own to research: it is seed from several '
       + 'varieties, listed in variety_blend_component. Carries NO watering keys, so cadence resolves '
       + 'through the bundled fallback.',
};

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────────

// Request body -> { ids, create } or { error }. REFUSED, never repaired (the seed-lot-parents rule):
// one element that is not a uuid is a 400 for the whole body, and a non-uuid never reaches Postgres
// (22P02 is unmapped and would fall through as an opaque 500). Lower-cased before deduping because
// Postgres reads a uuid case-insensitively. `create` must be a real boolean: a creating route must
// not be reachable by a truthy accident, and the preview must not be reachable by a missing key.
export function parseBlendBody(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be an object with component_variety_ids and create' };
  }
  const value = body.component_variety_ids;
  if (!Array.isArray(value)) return { error: 'component_variety_ids must be an array of variety ids' };
  if (typeof body.create !== 'boolean') return { error: 'create must be true or false' };
  const ids = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
      return { error: 'component_variety_ids must contain only variety ids' };
    }
    const id = raw.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
    if (ids.length > MAX_COMPONENT_IDS) {
      return { error: `component_variety_ids can name at most ${MAX_COMPONENT_IDS} varieties` };
    }
  }
  return { ids, create: body.create };
}

// FLATTEN. Each named id becomes itself, or — when its row carries a blend_key — that key's ids.
// No table read: a keyed row's leaves are its key. `byId` must hold a row for every id in `ids`.
export function flattenLeafIds(ids, byId) {
  const leaves = [];
  for (const id of ids) {
    const key = byId.get(id)?.blend_key;
    for (const leaf of (key ? String(key).toLowerCase().split(',') : [id])) {
      if (!leaves.includes(leaf)) leaves.push(leaf);
    }
  }
  return leaves;
}

export const blendKey = (leafIds) => [...new Set(leafIds.map((id) => String(id).toLowerCase()))].sort().join(',');

// Leaves in NAME order: lower(name), then id. Plain code-unit comparison, never localeCompare — the
// automatic name is built from this order and must not depend on the runtime's ICU data.
export function sortLeaves(leaves) {
  const k = (l) => String(l.name ?? '').toLowerCase();
  return [...leaves].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)));
}

const SAYS_MIX = /\b(?:mix|blend)\b/i;

// The automatic name. Two or three leaves: every name, joined with " + ", then " mix" — unless every
// leaf name already says "mix" or "blend" as a whole word ("Alaska Mix + Jewel Mix Nasturtium").
// Four or more: the first two and a count. No year, no crop word. `leaves` in sortLeaves order.
export function automaticBlendName(leaves) {
  const names = leaves.map((l) => String(l.name ?? '').trim());
  if (names.length >= 4) return `${names[0]} + ${names[1]} + ${names.length - 2} more`;
  const joined = names.join(' + ');
  return names.every((n) => SAYS_MIX.test(n)) ? joined : `${joined} mix`;
}

// Distinct crops among the leaves. NULL is a value of its own: two leaves with no crop are one
// crop, a leaf with none beside a tomato is two.
export const distinctCrops = (leaves) => [...new Set(leaves.map((l) => l.crop_type_slug ?? null))];

// WHAT THE MIX ROW CARRIES AT BIRTH (contract section 2; geneticist Q3). The shared crop; species,
// genus and lifecycle only when EVERY leaf records the same value; a heat ENVELOPE (lowest minimum,
// highest maximum) only when every leaf has a whole range, labelled 'inference'. Nothing else is
// derived: maturity, origin, photo, source URL, care text, habit and every sowing column stay NULL,
// because copying one parent's fact onto a population of several would be a claim nobody made.
export function birthFacts(leaves) {
  const agree = (k) => {
    const v = leaves[0]?.[k] ?? null;
    return v != null && leaves.every((l) => l[k] === v) ? v : null;
  };
  const ranged = leaves.length > 0 && leaves.every((l) => l.scoville_min != null && l.scoville_max != null);
  return {
    crop_type_slug: leaves[0]?.crop_type_slug ?? null,
    species: agree('species'),
    genus: agree('genus'),
    lifecycle: agree('lifecycle'),
    scoville_min: ranged ? Math.min(...leaves.map((l) => Number(l.scoville_min))) : null,
    scoville_max: ranged ? Math.max(...leaves.map((l) => Number(l.scoville_max))) : null,
    scoville_source: ranged ? 'inference' : null,
  };
}

// One reply element per LEAF, never filtered by the leaf's state: a soft-deleted variety can still
// be a planting's variety, so it can still be a component, and the client is told so.
export const componentOf = (leaf) => ({
  id: leaf.id,
  name: leaf.name,
  variety_rank: leaf.variety_rank ?? null,
  deleted: leaf.deleted_at != null,
});

// ── Statement builders. None awaits: the caller awaits one, or places it in sql.transaction([...]). ──

// Trigger trg_audit_plant_varieties reads this GUC. auditActor THROWS on an absent subject rather
// than bind '' (BUG-VARIETYACTOREMPTY-001), and it is the first element of each transaction array
// below, so the throw happens while the batch is being built and nothing is submitted.
export const setActor = (sql, userId) => sql`SELECT set_config('app.actor_clerk_sub', ${auditActor(userId)}, true)`;

// The rows behind a set of ids — the ids a request named, or the leaves a named mix brought with it.
// NO owner predicate and NO deleted_at filter, both on purpose: the varieties list is global (any
// signed-in user may put any variety on a planting), and a soft-deleted variety still counts as a
// planting's variety, so it must still resolve here.
export function readVarieties(sql, ids) {
  return sql`
    SELECT id, display_name AS name, variety_rank, crop_type_slug, blend_key, deleted_at,
           species, genus, lifecycle, scoville_min, scoville_max
      FROM public.cultivar
     WHERE id = ANY(${ids}::uuid[])
  `;
}

// THE FIND. This household's row for the key: live first, else soft-deleted; oldest, then id, so two
// rows (two members racing, or a hand-made duplicate) always resolve to the same one. Projects what
// the ordinary POST returns plus variety_rank and blend_key, and is the ONLY full-row projection in
// this file: every write below reads its result back through it.
export function findBlend(sql, key, household) {
  return sql`
    SELECT id, display_name AS name, species, genus, days_to_maturity_min, days_to_maturity_max,
           care_notes, soil_notes, sun_requirements, common_diseases, expected_yield_notes,
           photo_id, source_url, crop_type_slug, lifecycle, scoville_min, scoville_max,
           growth_habit, produces_scape, created_by, created_at, updated_at, deleted_at,
           source_proj_rescope_project_id, origin_country, origin_region, model_version,
           determinacy, day_length_response, grown_as, start_method,
           start_indoor_weeks_min, start_indoor_weeks_max, direct_sow_timing, sow_depth_in,
           seed_spacing_in, row_spacing_in, days_to_germ_min, days_to_germ_max, sow_season, sow_notes,
           breeding_system, breeding_source, scoville_source, variety_rank, blend_key
      FROM public.cultivar
     WHERE blend_key = ${key}
       AND created_by = ANY(${household})
     ORDER BY (deleted_at IS NOT NULL), created_at, id
     LIMIT 1
  `;
}

// The mix row. Plain VALUES through the view, the shape the ordinary POST has proven; the column list
// IS the birth rule — a column not named here is NULL (or its default) on a new mix, and
// blend-route.test.js pins the list. breeding_system / breeding_source / breeding_confidence are
// absent on purpose: a mix has no breeding system, and chk_plant_varieties_op_requires_cultivar then
// keeps a rank-'blend' row from ever being marked open-pollinated.
export function insertBlend(sql, { id, name, userId, key, facts }) {
  return sql`
    INSERT INTO public.cultivar (
      id, display_name, created_by, variety_rank, blend_key,
      crop_type_slug, species, genus, lifecycle,
      scoville_min, scoville_max, scoville_source
    ) VALUES (
      ${id}::uuid, ${name}, ${userId}, 'blend', ${key},
      ${facts.crop_type_slug}, ${facts.species}, ${facts.genus}, ${facts.lifecycle},
      ${facts.scoville_min}, ${facts.scoville_max}, ${facts.scoville_source}
    )
    RETURNING id
  `;
}

// One live row per leaf, mirroring the key. They exist for foreign-key integrity (a component cannot
// be hard-deleted from under a mix) and readable ancestry; nothing here reads them back.
export function insertBlendComponents(sql, { id, leafIds, userId }) {
  return sql`
    INSERT INTO public.variety_blend_component (blend_variety_id, component_variety_id, created_by)
    SELECT ${id}::uuid, u, ${userId}::text
      FROM unnest(${leafIds}::uuid[]) AS u
  `;
}

// The cadence profile row, in the same transaction as the row it describes — index.js's statement
// with BLEND_PROFILE in place of NEW_CULTIVAR_PROFILE. DO NOTHING, never DO UPDATE.
export function insertBlendProfile(sql, id) {
  return sql`
    INSERT INTO public.care_profile (scope, scope_id, profile, model_version)
    VALUES ('cultivar'::care_scope, ${id}::uuid, ${JSON.stringify(BLEND_PROFILE)}::jsonb, 1)
    ON CONFLICT (scope, scope_id) WHERE scope <> 'system' DO NOTHING
  `;
}

// REVIVE a soft-deleted mix: clear deleted_at, as the restore arm does. `name` is NULL except on the
// retry after the stored name was taken while the mix was deleted (COALESCE keeps the stored one).
// A rename never changes the key.
export function reviveBlend(sql, { id, household, name = null }) {
  return sql`
    UPDATE public.cultivar
       SET deleted_at = NULL,
           display_name = COALESCE(${name}, display_name)
     WHERE id = ${id}::uuid
       AND created_by = ANY(${household})
       AND deleted_at IS NOT NULL
    RETURNING id, deleted_at
  `;
}

// ── The route ───────────────────────────────────────────────────────────────────────────────────────
//
// ctx: { body, userId, household, spendCreate, newId }
//   spendCreate  async () => boolean — one draw on the plant_varieties.create bucket
//   newId        () => uuid — minted here, not by the column default, so the component and profile
//                rows can bind it inside the same transaction (index.js, BUG-CULTIVARNOPROFILE-001)
// Returns { status, body, derive? } — `derive` is the id of a row CREATED by this request, for the
// caller's post-commit tag derive.
//
// create:false NEVER writes: it issues at most three SELECTs and returns before the first statement
// that could change anything, the rate-limit draw included.
export async function blendRoute(sql, { body, userId, household, spendCreate, newId }) {
  const refuse = (code) => ({ status: 400, body: { error: BLEND_ERRORS[code], code } });

  const parsed = parseBlendBody(body);
  if (parsed.error) return { status: 400, body: { error: parsed.error } };
  const { ids, create } = parsed;

  const byId = new Map();
  const load = async (wanted) => {
    for (const r of (wanted.length ? await readVarieties(sql, wanted) : [])) {
      byId.set(String(r.id).toLowerCase(), { ...r, id: String(r.id).toLowerCase() });
    }
  };
  await load(ids);
  if (ids.some((id) => !byId.has(id))) return refuse('component_unknown');

  const leafIds = flattenLeafIds(ids, byId);
  if (leafIds.length < MIN_BLEND_LEAVES) return refuse('blend_needs_two');
  if (leafIds.length > MAX_BLEND_LEAVES) return refuse('blend_too_many');

  // A named mix brings leaves the request did not name; their rows are needed for the crop rule and
  // the names. One more read, and only then.
  await load(leafIds.filter((id) => !byId.has(id)));
  if (leafIds.some((id) => !byId.has(id))) return refuse('component_unknown');

  const leaves = sortLeaves(leafIds.map((id) => byId.get(id)));
  if (distinctCrops(leaves).length > 1) return refuse('mixed_crop_components');

  const key = blendKey(leafIds);
  const autoName = automaticBlendName(leaves);
  const components = leaves.map(componentOf);
  const facts = birthFacts(leaves);

  const withRow = (row, created) => ({
    ...row,
    id: row.id,
    name: row.name,
    variety_rank: row.variety_rank,
    crop_type_slug: row.crop_type_slug ?? null,
    blend_key: row.blend_key,
    exists: true,
    created,
    components,
  });
  const live = (rows) => (rows?.[0] && rows[0].deleted_at == null ? rows[0] : null);
  const clash = { status: 409, body: { error: 'This mix was changed at the same moment. Reload and try again.' } };

  const [found] = await findBlend(sql, key, household);
  if (found && found.deleted_at == null) return { status: 200, body: withRow(found, false) };

  if (!create) {
    return {
      status: 200,
      body: {
        id: null, name: autoName, variety_rank: 'blend', crop_type_slug: facts.crop_type_slug,
        blend_key: key, exists: false, created: false, components,
      },
    };
  }

  // On 23505 from either write below: find again. A live household row means someone got there
  // first, and that row is the answer. None means the NAME was the collision — try the next suffix.
  const settle = async (err) => {
    if (err?.code !== '23505') throw err;
    return live(await findBlend(sql, key, household));
  };

  if (found) {
    // Soft-deleted: revive it rather than mint a second row for the same key, which would leave the
    // first unrestorable (R2-15). No rate-limit draw — nothing is created.
    for (const suffix of ['', ...NAME_SUFFIXES]) {
      try {
        const [, , back] = await sql.transaction([
          setActor(sql, userId),
          reviveBlend(sql, { id: found.id, household, name: suffix ? `${found.name}${suffix}` : null }),
          findBlend(sql, key, household),
        ]);
        const row = live(back);
        return row ? { status: 200, body: withRow(row, false) } : clash;
      } catch (err) {
        const row = await settle(err);
        if (row) return { status: 200, body: withRow(row, false) };
      }
    }
    return { status: 409, body: { error: RESTORE_CONFLICT_MESSAGES.uq_plant_varieties_name_species } };
  }

  if (!await spendCreate()) {
    return { status: 429, body: { error: 'Rate limit exceeded — 60/hour for plant_varieties.create' } };
  }

  const sortedLeafIds = key.split(',');
  for (const suffix of ['', ...NAME_SUFFIXES]) {
    const id = String(newId()).toLowerCase();
    try {
      const [, , , , back] = await sql.transaction([
        setActor(sql, userId),
        insertBlend(sql, { id, name: `${autoName}${suffix}`, userId, key, facts }),
        insertBlendComponents(sql, { id, leafIds: sortedLeafIds, userId }),
        insertBlendProfile(sql, id),
        findBlend(sql, key, household),
      ]);
      const row = live(back);
      if (!row) return clash;
      const created = String(row.id).toLowerCase() === id;
      return { status: created ? 201 : 200, body: withRow(row, created), ...(created ? { derive: id } : {}) };
    } catch (err) {
      const row = await settle(err);
      if (row) return { status: 200, body: withRow(row, false) };
    }
  }
  return { status: 409, body: { error: 'A variety already uses every name this mix could take. Rename one of them and try again.' } };
}
