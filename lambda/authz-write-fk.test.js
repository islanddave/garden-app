// V4-AUTHZSWEEP-001 — write-FK ownership sweep.
//
// THE BUG CLASS: a column like plants.location_id or container.parent_id is settable straight from a
// request body. The DB-level FK enforces that the referenced row EXISTS; nothing enforces that the
// caller OWNS it. So any authenticated user could pin their own row to another household's location,
// planting, inventory item or project — which both writes a cross-household FK and leaks the
// referenced row's fields back through every read surface that JOINs it. preservation/index.js closed
// this for storage_location_id / harvest_log_id; this sweep closes the rest.
//
// TWO layers, because neither alone is sufficient:
//   (1) loader unit tests — prove each predicate binds householdIds and the RIGHT owner column
//       (they differ per table: locations/inventory_items/spaces use created_by, garden_node needs
//       its own OR its container's) and that a non-match returns null rather than throwing.
//   (2) a static call-site guard — proves each known-vulnerable write site actually CALLS a loader.
//       A perfect loader nobody invokes protects nothing, and that is the regression that would
//       silently reappear when one of these handlers is next refactored.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOwnedLocation, loadOwnedInventoryItem, loadOwnedSpace, loadOwnedPhoto, warnRejectedFk } from './household.js';
import { loadOwnedProject, loadOwnedPlantingRef, loadOwnedEvent } from './authz-parents.js';
// V5-SEEDMULTIPARENT-001 — the one ARRAY gate in the fleet. Dependency-free by design, so it is
// imported and executed here like the loaders above; the stubs are for the one assertion that runs
// the inventory-items handler itself to prove a refused array writes nothing.
import { ownsEveryPlanting } from './inventory-items/seed-lot-parents.js';
// V5-SEEDLOTADDITION-001 — the handler, imported STATICALLY for the one release-3 case that runs it
// (a seed addition naming a foreign planting). The older executed case below imports it lazily; that
// one is left as it was written.
import { handler as inventoryItemsHandler } from './inventory-items/index.js';
import { stubState, resetStubs } from './_test-stubs/state.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOUSE = ['user_a', 'user_b'];
// Every loader now UUID-guards its id before issuing SQL (V4-AUTHZRESIDUE-001), so predicate tests
// must pass a WELL-FORMED uuid or they assert the short-circuit instead of the predicate.
const ID = '00000000-0000-4000-8000-0000000000aa';

// Fake neon tagged-template: records the SQL text + bound values, returns a canned result.
function fakeSql(result = []) {
  const calls = [];
  const fn = (strings, ...values) => { calls.push({ text: strings.join('?'), values }); return Promise.resolve(result); };
  fn.calls = calls;
  return fn;
}
// A construct NAMED IN A COMMENT is not that construct: deleting a gate, an import, or an INSERT
// and leaving `// was: <it>` behind made the censuses below count their own epitaphs and pass.
// Reads that feed a POSITIVE assertion or a call-site COUNT are decommented. Reads that feed only
// a `not.toMatch` are deliberately left RAW — there a comment can only cause a safe failure, and
// stripping would relax the guard. The `//` arm is URL-safe (the `[^:]` guard keeps `https://`
// intact); the `--` arm requires surrounding space so a JS decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const textOf = (sql) => sql.calls[0].text.replace(/\s+/g, ' ');

describe('V4-AUTHZSWEEP-001: ownership loaders bind the correct owner column', () => {
  const CASES = [
    ['loadOwnedLocation', loadOwnedLocation, 'locations', /FROM locations/i, /created_by = ANY\(\?\)/, true],
    ['loadOwnedInventoryItem', loadOwnedInventoryItem, 'inventory_items', /FROM inventory_items/i, /created_by = ANY\(\?\)/, true],
    ['loadOwnedSpace', loadOwnedSpace, 'spaces', /FROM spaces/i, /created_by = ANY\(\?\)/, false],
    // BUG-AUTHZFKENUM-001: lifted out of lambda/preservation, where it was module-private, once a
    // second and third consumer appeared (varieties.photo_id, inventory-items.featured_image_id).
    // photos carries BOTH created_by and a stale uploaded_by; created_by is the owner column.
    ['loadOwnedPhoto', loadOwnedPhoto, 'photos', /FROM photos/i, /created_by = ANY\(\?\)/, true],
  ];

  for (const [name, fn, table, fromRe, ownerRe, expectsSoftDelete] of CASES) {
    it(`${name} scopes ${table} by household and returns the row on a match`, async () => {
      const sql = fakeSql([{ id: 'x', name: 'n' }]);
      const row = await fn(sql, ID, HOUSE);
      expect(row).toEqual({ id: 'x', name: 'n' });
      const t = textOf(sql);
      expect(t).toMatch(fromRe);
      expect(t).toMatch(ownerRe);
      // The id and the household array must both be BOUND parameters, never interpolated text.
      expect(sql.calls[0].values).toEqual([ID, HOUSE]);
    });

    it(`${name} returns null (no existence oracle) when nothing matches`, async () => {
      expect(await fn(fakeSql([]), ID, HOUSE)).toBeNull();
    });

    it(`${name} ${expectsSoftDelete ? 'excludes' : 'does NOT reference'} soft-deleted rows`, async () => {
      const sql = fakeSql([]);
      await fn(sql, ID, HOUSE);
      // spaces has NO deleted_at column (verified live, V-P2) — asserting one would 42703 in prod.
      if (expectsSoftDelete) expect(textOf(sql)).toMatch(/deleted_at IS NULL/i);
      else expect(textOf(sql)).not.toMatch(/deleted_at/i);
    });
  }

  // household.js loadOwnedPlanting was DELETED (consolidating sweep, 2026-08-10): it was a
  // byte-equivalent duplicate of authz-parents.js loadOwnedPlantingRef with ZERO callers, and
  // "two identical predicates with different names" is the condition that let the LOOSE dialect
  // survive the first sweep. Its coverage lives on in the loadOwnedPlantingRef tests below; the
  // "no loose two-arm planting predicate survives anywhere" guard further down is what keeps the
  // deleted dialect from being reintroduced under any name.

  it('household.js exports exactly one planting predicate — the duplicate stays deleted', () => {
    // A regression here means loadOwnedPlanting (or another alias of the same query) came back.
    // The risk is not the duplicate itself but that the two copies drift and the looser one wins.
    const src = readFileSync(join(here, 'household.js'), 'utf8');
    expect(src).not.toMatch(/export async function loadOwnedPlanting\s*\(/);
  });

  it('warnRejectedFk logs server-side only and never throws', () => {
    const seen = [];
    const orig = console.warn;
    console.warn = (m) => seen.push(m);
    try { warnRejectedFk('user_a', 'plants', 'location_id', 'loc-9'); } finally { console.warn = orig; }
    expect(seen).toHaveLength(1);
    const payload = JSON.parse(seen[0]);
    expect(payload).toMatchObject({ msg: 'authz-fk-reject', userId: 'user_a', table: 'plants', column: 'location_id', value: 'loc-9' });
  });
});

// ── Static call-site guard ────────────────────────────────────────────────────────────────────────
// Each entry: the handler, the body field it accepts, and the loader that must gate it. Written as a
// source scan because these are raw SQL handlers with no injectable seam — the same reason
// household-isolation.test.js and wxcoverloc.test.js are static.
// The 4th element is the EXACT number of gate call sites expected for that (handler, field).
// Presence was not enough: the old assertion matched `if (...) ... loader(sql, body.X,` against the
// whole file flattened to ONE line, so `.` spanned everything and the three tokens needed no
// structural relationship at all. Neutering the LAST of two gates still passed; so did rewriting a
// gate as `if (false && body.X != null)`; so did a synthetic `if (body.X != null) { logIt(); }`
// paired with an unrelated later loader call. A count is what makes a removed gate visible — and a
// removed gate is a live cross-household FK write plus a read leak through every JOINing surface.
const SITES = [
  ['plants/index.js', 'location_id', 'loadOwnedLocation', 2],
  ['plants/index.js', 'parent_plant_id', 'loadOwnedPlantingRef', 2],
  ['plants/index.js', 'source_inventory_item_id', 'loadOwnedInventoryItem', 2],
  ['inventory-items/index.js', 'location_id', 'loadOwnedLocation', 2],
  ['projects/index.js', 'location_id', 'loadOwnedLocation', 2],
  // V4-SPACEPHOTO-001: photos.space_id is attachable from the POST body, and the ?space_id gallery
  // reads back by it — an ungated attach is a live cross-household READ, not just a bad FK.
  ['photos/index.js', 'space_id', 'loadOwnedSpace', 1],
  // BUG-PARENTOWN-001 — the PARENT-id half of the same class, and the reason this table is the
  // enforcement mechanism rather than documentation: the V4-AUTHZSWEEP-001 pass gated the three
  // plants PUT columns above and left every POST column, the whole photos parent set, and
  // succession_group_id (settable on BOTH verbs) out of the table entirely, so nothing failed when
  // they stayed open. Adding a row here is now part of adding a body-settable FK.
  // plants/index.js::project_id is 0 HERE and pinned by its own `it()` below instead — see
  // "plants create still gates a CLIENT-SUPPLIED project_id". V4-AUTOPROJECT-001 (dev 1f567ae)
  // introduced a server-side fallback, so the create path now reads
  //   let resolvedProjectId = body.project_id ?? null;
  //   if (resolvedProjectId != null) { if (!await loadOwnedProject(sql, resolvedProjectId, ...
  // The gate is still there and still runs on every client-supplied value; the generic matcher
  // above cannot see it because it anchors on an expression ENDING IN the field name, and
  // `resolvedProjectId` does not.
  //
  // THIS IS NOT THE "verb stopped accepting the field" CASE the message below describes, and it
  // must not be filed as one: body.project_id is still accepted and still gated. Dropping the row
  // to 0 with nothing in its place would have left a live cross-household write column with no
  // guard at all, which is the exact failure this table exists to prevent. The replacement pin is
  // stricter than what it replaces — it asserts the gate AND the `?? null` read AND the else-arm.
  ['plants/index.js', 'project_id', 'loadOwnedProject', 0],
  ['plants/index.js', 'succession_group_id', 'loadOwnedPlantingRef', 2],
  ['photos/index.js', 'project_id', 'loadOwnedProject', 2],
  ['photos/index.js', 'plant_id', 'loadOwnedPlantingRef', 2],
  ['photos/index.js', 'event_id', 'loadOwnedEvent', 1],
  ['photos/index.js', 'location_id', 'loadOwnedLocation', 2],
  ['photos/index.js', 'inventory_item_id', 'loadOwnedInventoryItem', 1],
  // ── BUG-AUTHZFKENUM-001 — the seven live holes the enumeration audit found. ────────────────────
  // projects PUT was the ONE verb that set parent_project_id ungated (POST gates it inline against
  // container.created_by — see the dedicated assertion below; reparentCore validates its new
  // parent), and the read surface LEFT JOINs the parent with no household predicate to select
  // `p.display_name AS parent_project_name`, so it leaked the victim container's NAME.
  ['projects/index.js', 'parent_project_id', 'loadOwnedProject', 1],
  // locations POST *looked* gated — a household-scoped SELECT sat right above it — but that SELECT
  // only read the parent's `level`; a miss left level=0 and inserted body.parent_id verbatim. The
  // `locations_with_path` recursive view has NO created_by filter, so the attacker's own row's
  // full_path came back carrying the victim's ancestor names.
  ['locations/index.js', 'parent_id', 'loadOwnedLocation', 1],
  // varieties photo_id: 0 of 408 live cultivars set it and no picker exists, so no leak TODAY —
  // but GET /api/varieties and /:id are GLOBALLY readable and already return photo_id, so this is
  // gated before a resolver ships rather than after.
  ['varieties/index.js', 'photo_id', 'loadOwnedPhoto', 2],
  ['varieties/index.js', 'source_proj_rescope_project_id', 'loadOwnedProject', 1],
  // featured_image_id was the ungated twin of featured_photo_id three lines above it.
  ['inventory-items/index.js', 'featured_image_id', 'loadOwnedPhoto', 2],
  // treatment_product_id sat on the SAME statement as three gated siblings with no gate of its own.
  ['events/index.js', 'treatment_product_id', 'loadOwnedInventoryItem', 2],
  // evidence-ingest is the reason the ENUMERATION had to change, not just the gates: it never
  // spells `body.<x>_id` (validate.js destructures the body; the write reads `v.value.<x>`), so the
  // old scan found zero pairs in that dir and passed it while it carried two ungated FKs.
  ['evidence-ingest/index.js', 'garden_node_id', 'loadOwnedPlantingRef', 1],
];
// Which module each loader is imported from. Two homes today; authz-parents.js is a temporary one
// (see its header) and collapses into household.js in the consolidating sweep — at which point this
// map goes away rather than growing a third entry.
const LOADER_MODULE = {
  loadOwnedLocation: './household.js',
  loadOwnedInventoryItem: './household.js',
  loadOwnedSpace: './household.js',
  loadOwnedPhoto: './household.js',
  loadOwnedProject: './authz-parents.js',
  loadOwnedPlantingRef: './authz-parents.js',
  loadOwnedEvent: './authz-parents.js',
};


// ── THE ENUMERATION RATCHET (BUG-AUTHZFKENUM-001) ───────────────────────────────────────────────
//
// SITES is a HAND-MAINTAINED list, and its own comment says "Adding a row here is now part of
// adding a body-settable FK". Nothing enforced that, so this block closes the SET: every FK-shaped
// column any handler WRITES must appear either in SITES with a gate count, or below with a reason.
//
// WHY THE ENUMERATION WAS REWRITTEN (this is the fix that closes the CLASS, not seven instances).
// The first version of this ratchet walked `<dir>/index.js` only and matched only the literal token
// `body.<name>_id`. Three blind spots were PROVEN live, not theorised:
//   1. A HANDLER THAT DESTRUCTURES ITS BODY WAS ENTIRELY INVISIBLE. lambda/evidence-ingest never
//      spells `body.<x>_id` — validate.js destructures the body and the handler writes
//      `v.value.garden_node_id` — so the dir contributed ZERO pairs and the ratchet passed it while
//      it carried two ungated FKs. A guard that reports "nothing to see" on the file with the bug
//      in it is worse than no guard, because it reads as coverage.
//   2. `crop_type_slug` IS A REAL FOREIGN KEY WITH NO `_id` SUFFIX (plant_varieties/preservation_log
//      -> crop_types.slug, verified live) and could never match an `_id`-anchored regex.
//   3. lambda/photocdn-derivative ships `index.mjs`, so the `existsSync(index.js)` filter skipped
//      the dir outright — a dir could be added to the fleet and be born exempt.
// The scan is now: for EVERY non-test .js/.mjs in EVERY lambda subdir, take (a) every FK-shaped
// column named in an INSERT column list or a SET clause — the write ALWAYS names the column, which
// is why this catches a destructuring handler that no body-token scan can see — and (b) every
// `body.<fk-shaped>` reference, kept so the pairs the old scan found are not silently dropped.
//
// WHAT IT STILL CANNOT SEE (say it out loud rather than let it read as total coverage):
//   • A NEW non-`_id`-suffixed FK column that is not in FK_COLUMNS below. The suffix rule catches
//     any new `*_id`; a new `*_slug`/`*_ref` FK has to be added to that snapshot by hand. Refresh it
//     from live when the schema gains one (query in the FK_COLUMNS comment).
//   • Dynamically-assembled SQL — a column name built by string concatenation rather than written
//     literally in the template. No handler does this today (the neon tagged-template API takes no
//     interpolated identifiers, which is what keeps it true).
//   • WHETHER a listed pair is safe. This block only proves a DECISION was recorded. The gate
//     counts in the third describe block are what prove a gate exists.
// It also over-reports: `WHERE id = ${x}` inside a SET-clause slice, and server-derived columns
// (`user_id = ${userId}`, `workspace_id`), surface as pairs needing an exemption line. That is the
// deliberate direction to err in — a spurious entry costs one line, a missed one costs a CVE.
//
// FK-shaped columns with NO `_id` suffix. Snapshot of live prod 2026-08-10:
//   SELECT DISTINCT kcu.column_name FROM information_schema.table_constraints tc
//   JOIN information_schema.key_column_usage kcu USING (constraint_name)
//   WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public';
// (`_id`-suffixed names are matched by rule, so only the exceptions are listed here.)
const FK_COLUMNS = new Set(['crop_type_slug', 'source_tier']);
const isFkColumn = (c) => /_id$/.test(c) || FK_COLUMNS.has(c);

// Every non-test module in a Lambda dir, NOT just index.js — dashboard/handlers.js and
// events/batchSideEffects.js both write FK columns, and index.mjs dirs must not be skipped.
const handlerModules = (d) => readdirSync(join(here, d))
  .filter(f => /\.m?js$/.test(f) && !/\.test\.m?js$/.test(f) && statSync(join(here, d, f)).isFile())
  .sort();

const pairsOnDisk = () => {
  const dirs = readdirSync(here, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => e.name).sort();
  const out = new Set();
  for (const d of dirs) {
    for (const f of handlerModules(d)) {
      const src = decomment(readFileSync(join(here, d, f), 'utf8'));
      // (a) WRITE TARGETS — the column list of an INSERT, and the assignments of a SET clause.
      // Source-of-truth for "this dir can write this FK", independent of how the value is spelled.
      for (const m of src.matchAll(/INSERT\s+INTO\s+[\w."]+\s*\(([^)]*)\)/gis)) {
        for (const c of m[1].split(',').map((s) => s.trim())) if (isFkColumn(c)) out.add(`${d}::${c}`);
      }
      for (const m of src.matchAll(/\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|`)/gi)) {
        for (const mm of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) if (isFkColumn(mm[1])) out.add(`${d}::${mm[1]}`);
      }
      // (b) BODY REFERENCES — retains everything the original scan saw (a handful of pairs are
      // read from the body and written through a helper rather than a literal SET/INSERT here).
      for (const m of src.matchAll(/\bbody\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) if (isFkColumn(m[1])) out.add(`${d}::${m[1]}`);
    }
  }
  return [...out].sort();
};

// Pairs with NO ownership gate, each one a recorded decision rather than an oversight. Grouped by
// WHY. An entry here is not a safety claim about the handler; it is a claim that the pair was
// looked at and found not to need a household ownership gate for the stated reason.
// OPS-DASHSCRATCHMJS-001 removed two entries that were never about a handler at all.
// `dashboard::crop_type_slug` and `dashboard::owner_id` were contributed SOLELY by
// lambda/dashboard/_tagsub_cow_runner{,2}.mjs — dead V4-TAGSUB-001 scratch runners with zero
// importers, which the walker below could not tell apart from a handler because it scans every
// non-test module in the directory. So the sweep carried two phantom pairs, and this list carried
// two ownership decisions about a production write surface that does not exist. Moving the runners
// to scripts/ took the corpus from 114 pairs to 112; `dashboard::user_id` and `dashboard::project_id`
// remain and both come from handlers.js, which is real.
const NOT_IN_SITES = [
  // ── Shared/global vocabulary: gating these would break the catalogue every household reads. ──
  'preservation::crop_type_slug', 'varieties::crop_type_slug',
  'critter::species_id', 'events::species_id',
  'inventory-items::variety_id', 'plants::cultivar_id', 'plants::variety_id',
  'preservation::variety_id', 'tags::cultivar_id',
  // V5-SOURCEPICKER-001. public.source is a shared catalogue with RLS deliberately off —
  // v5-sourceentity-001/0a:151-161 names plant_varieties as the precedent — so there is no owner to
  // gate against, the same argument as inventory-items::variety_id two lines above. Liveness IS
  // checked: findDeadSourceRef requires a row with deleted_at IS NULL before either column is
  // written, which is the strictness varieties::variety_id records. These are here rather than in
  // SITES because a household gate would break the picker for the other household, not because the
  // write is unguarded.
  'inventory-items::source_id', 'inventory-items::acquired_from_source_id',
  'plants::source_id', 'plants::acquired_from_source_id',
  'evidence-ingest::source_tier', 'photos::source_tier',
  // ── No FK constraint exists on the column — there is no referenced row to own. ──
  'critter::target_id', 'events::target_id', 'events::source_id',
  'facebook-share::client_request_id', 'facebook-share::fb_media_id', 'facebook-share::fb_page_id',
  'facebook-share::fb_post_id', 'facebook-share::post_group_id',
  'evidence-ingest::source_record_id', 'projects::op_id', 'projects::source_op_id',
  'projects::subject_id', 'app-events::session_id', 'ux-events::flow_id', 'ux-events::session_id',
  'favorites::entity_id', 'tags::entity_id', 'tags::into_id',
  // ── Server-derived, never body-settable: the value is the JWT subject or a fixed workspace. ──
  // daily-plan::space_id — weather_daily's (space_id, date) upsert, added by V4-WATERMATH-001 F1.
  // daily-plan is an EventBridge cron Lambda: it parses no request body at all, and the value is
  // read off p.workspace_id of plantings the handler has ALREADY scoped (handler.js bySpace grouping),
  // never off caller input. There is no request through which a caller could name another
  // household's space, so there is no cross-household write to gate.
  'daily-plan::space_id',
  // daily-plan::plant_id — plant_anchor_derivation's FK, added by V4-ANCHORRESWEEP-001's
  // re-derivation INSERT. Same argument as space_id above and stronger: the value is never a
  // parameter of any kind. The statement is issued as pg.query(sql) with NO binds at all, and the
  // id comes from its own `target` CTE, which selects live, non-archived, still-anchorless rows out
  // of public.plants. A cron Lambda that reads no request body cannot be handed another household's
  // planting. Ownership on the written row is COALESCE(plant_projects.created_by, plants.created_by)
  // read back off the database — the same two-arm shape plants/anchorCreate.js records, and the same
  // class as harvests::user_id.
  'daily-plan::plant_id',
  // daily-plan-read::user_id — public.weather_cue_impression's FK, added by OPS-CUEINSTRUMENT-001
  // (the Today weather-cue impression log). NOT body-settable, and the INSERT is the proof: the
  // column is bound as ${userId}::text straight from the handler context, while the request body
  // goes only through normalizeCueImpression(), which emits cue/form/model_version/
  // plan_generated_at and nothing else. There is no path by which a body key named user_id reaches
  // the statement. ctx.userId is the JWT subject — index.js sets `userId = payload.sub` and returns
  // 401 before routing if it is falsy — so the value is the caller's own identity by construction.
  // shown_on is likewise stamped from the server's ET clock, never the body. Same class as
  // harvests::user_id and ready-impression's write, which is the route this one deliberately
  // mirrors. A caller can only ever log an impression AS THEMSELVES, so there is no
  // cross-household write to gate.
  'daily-plan-read::user_id',
  // daily-plan::location_id and ::project_id — the rain event_log INSERT added by
  // V4-RAINAUTOLOG-001 part 2 (handler.js logRainEvents). Same argument as plant_id above, and the
  // SQL makes it checkable at a glance: both values come from `left join container ct on ct.id =
  // gn.container_id` and are written as ct.location_id / ct.id — i.e. read off the planting's OWN
  // container, inside a statement whose only binds are a date, a numeric and a metadata blob. There
  // is no request body anywhere in this Lambda for a caller to put an FK into. Ownership on the
  // written row is gn.created_by, read back off the database, matching the batch writer in
  // lambda/events/index.js which derives the same two columns the same way.
  'daily-plan::location_id', 'daily-plan::project_id',
  // inventory-items::inventory_item_id — seed_lot_stage_log's FK, written by V4-SEEDSAVEFLOW-001's
  // POST /api/inventory-items/{id}/seed-stage. NOT BODY-SETTABLE, and structurally so rather than by
  // convention: the request body is read for `stage`, `entered_at` and `note` ONLY, and the FK value
  // is never taken from it. The INSERT selects `upd.id` out of its own CTE, where `upd` is an UPDATE
  // on public.inventory_items carrying `created_by = ANY(householdIds) AND deleted_at IS NULL AND
  // category = 'seeds'`.
  //
  // So the gate is the CTE itself and it fails CLOSED by construction: hand the route another
  // household's item id in the PATH and the UPDATE matches zero rows, `upd` is empty, the INSERT
  // selects from an empty relation and writes nothing, and the route 404s having changed nothing.
  // There is no arrangement of request body or path that lets a caller name a row they could not
  // already update — which is the property SITES entries buy with a loader call, obtained here from
  // the statement's own shape. Same class as the daily-plan entries above (value read off a
  // relation the handler has already scoped), with the difference that this one DOES parse a body;
  // it just never reads an FK out of it.
  //
  // V5-SEEDMULTIPARENT-001 adds a SECOND table behind this same pair: seed_lot_parent_planting's
  // inventory_item_id, written by seed-lot-parents.js insertSeedParentLinks. The argument is the
  // same one and holds for the same structural reason: the column is never bound from a request.
  // The INSERT selects `i.id` out of public.inventory_items under the full lot predicate
  // (`i.id = <lot> AND i.created_by = ANY(householdIds) AND i.deleted_at IS NULL AND i.category =
  // 'seeds'`), where <lot> is the ROUTE's path id on PUT /:id/source-plants and PATCH
  // /:id/source-plant, and on POST the id the handler minted for the lot the same transaction
  // inserts. A foreign lot id selects nothing and writes nothing. The OTHER FK of that INSERT,
  // plant_id, IS body-settable and has its own entry and its own executed assertions below.
  'inventory-items::inventory_item_id',
  // V5-SEEDLOTADDITION-001 — seed_lot_addition.parent_link_id, written by seed-lot-additions.js
  // applyAddition for POST /api/inventory-items/:id/seed-additions. NOT BODY-SETTABLE, and for the
  // structural reason the pair above gives: no request key of any name reaches it. The INSERT selects
  // `pre.link_id` out of its own CTE, and `pre` is the live seed_parent row joined to
  // public.inventory_items under the full lot predicate (`i.id = <the route's path id> AND
  // i.created_by = ANY(householdIds) AND i.deleted_at IS NULL AND i.category = 'seeds'`). A foreign
  // lot id selects nothing and writes nothing. What the body DOES choose is which planting's link row
  // that is (`plant_id`) — the pair inventory-items::plant_id below, gated at the route (the third
  // ownsEveryPlanting site, asserted below) and judged again under the lot lock.
  'inventory-items::parent_link_id',
  'daily-plan::assignee_user_id', 'daily-plan::user_id', 'dashboard::user_id',
  'events::user_id', 'events::workspace_id', 'favorites::user_id', 'inventory-items::user_id',
  'plants::assignee_user_id', 'preservation::user_id', 'projects::assignee_user_id',
  'projects::workspace_id', 'shared-state::workspace_id', 'storage-location::user_id',
  'tags::owner_id', 'varieties::owner_id',
  // plants::user_id — plant_anchor_derivation.user_id, written by the V4-ANCHORBASE-001 create-path
  // derive (plants/anchorCreate.js). Not body-settable and not settable at all: the statement takes
  // NOTHING from the request except the planting id, and that id is the row the POST it follows just
  // inserted with created_by = the JWT subject. The value is COALESCE(container.created_by,
  // garden_node.created_by) read back off the database — the project arm can only be a project the
  // POST already cleared through loadOwnedProject, and the fallback arm IS the JWT subject. Same
  // class as harvests::user_id, one step further removed: that one is the subject directly, this one
  // is a column the same request wrote from it.
  'plants::user_id',
  // varieties::scope_id — care_profile.scope_id, written by BUG-CULTIVARNOPROFILE-001's create-path
  // INSERT (varieties/index.js, the third statement of the POST transaction). NOT body-settable and
  // not settable at all: the value is `newVarietyId`, a randomUUID() minted three lines earlier in
  // the same block and bound to the cultivar INSERT's own `id` in the same transaction. No request
  // key of any name reaches it — validateBody never sees `scope_id`, and the only other binding of
  // newVarietyId is the row the request itself is creating. So a caller cannot name another
  // household's cultivar here any more than they can name their own: the id did not exist until the
  // handler generated it. Ownership on the referenced row is the created_by the same statement pair
  // wrote from the JWT subject. Same class as plants::user_id directly above — a column written from
  // a value the same request just produced — one step stronger, because that one reads an id back off
  // the database and this one never leaves the handler's own scope.
  'varieties::scope_id',
  // V5-VARIETYBLEND-001 — variety_blend_component, written by varieties/blend.js insertBlendComponents in the
  // transaction that creates a named mix. blend_variety_id is NOT body-settable: it is the id the handler minted
  // for the mix row the same transaction inserts (the varieties::scope_id argument, same statement group).
  // component_variety_id IS request-derived (body.component_variety_ids, an array the body arm cannot see, then
  // flattened to leaves) and is deliberately NOT household-gated: plant_varieties is the shared catalogue with no
  // owner to gate against — the inventory-items::variety_id argument above — and a household gate would refuse a
  // mix of two varieties another user created, which any planting may already carry. EXISTENCE is checked before
  // any write (every named id and every leaf must be a row, else 400 component_unknown), and the ids are
  // uuid-shape-checked before they reach Postgres. Pinned in lambda/varieties/blend-route.test.js
  // ('component_unknown', 'writes one component row per LEAF').
  'varieties::blend_variety_id', 'varieties::component_variety_id',
  // ── Gated inline by a predicate this file's SITES regex cannot express. Each is pinned by its
  //    own named assertion in the third describe block — NOT pre-absolved here. ──
  'projects::parent_id',        // POST create: inline container.created_by SELECT (asserted below)
  'projects::new_parent_id',    // reparentCore step 3: household-scoped plant_projects SELECT
  'evidence-ingest::entity_id', // planting-typed arm scoped via planting_ref_id (asserted below)
  // V4-SEEDLINK-001 — inventory_items.source_plant_id, written by PATCH /:id/source-plant. BODY-
  // SETTABLE AND GATED, but the gate is an inline garden_node SELECT rather than a loader call, so
  // the SITES regex (which anchors on `!await <loader>(sql, …<field>,`) cannot see it. Not a
  // loader because lambda/inventory-items has no authz-parents.js copy and adding one would drag
  // public.plants + public.plant_projects into that dir's L-081 Phase-4 relation set, pushing the
  // joined-relation ratchet past its 48 baseline and failing schema-audit.yml.
  //
  // The inline predicate is STRICTER than the two-arm canonical one, not looser: own-created_by
  // only, so it can refuse a planting created inside a container owned elsewhere and can never
  // admit a foreign one. It carries the same UUID short-circuit, the same warnRejectedFk, and the
  // same generic 400 as the two loader-backed gates in that handler.
  //
  // Pinned by its own running assertion below ('inventory-items gates source_plant_id inline
  // against garden_node'), NOT pre-absolved here — the locations::parent_id lesson.
  'inventory-items::source_plant_id',
  // V5-SEEDMULTIPARENT-001 — seed_lot_parent_planting.plant_id, written by seed-lot-parents.js
  // insertSeedParentLinks for POST /api/inventory-items, PUT /:id/source-plants and PATCH
  // /:id/source-plant. BODY-SETTABLE AND GATED. This is the pair source-kinds.js's header predicted
  // ("if inventory-items ever did start writing a plant_id from a request body, nothing would say
  // so") — it does now, and this entry plus the three assertions named below are what say so.
  //
  // Not a SITES row for two reasons the regex cannot get past: the value is an ARRAY
  // (`body.source_plant_ids`, which the body arm of the scan cannot even see — it does not end in
  // `_id`), and the gate is not `!await loader(sql, <field>,` on one id but a COUNTED query over all
  // of them. The count is the whole point: the single-id gates test `!owned.length`, and that test
  // generalised to `= ANY(ids)` admits an array in which ONE planting is the caller's and the rest
  // are another household's. ownsEveryPlanting requires the number of asked-for ids that came back
  // owned to equal the number asked for.
  //
  // Same predicate as inventory-items::source_plant_id above (garden_node, own-created_by arm, live
  // rows), same generic 400 with no existence oracle, same warnRejectedFk. The third write site, the
  // legacy PATCH, hands the set route ONE id that the single-id gate above has already cleared.
  //
  // Pinned by RUNNING assertions below, not pre-absolved here: 'ownsEveryPlanting refuses an id
  // array with ONE foreign planting', 'a source_plant_ids array with one foreign planting writes
  // ZERO rows' (the handler, executed, POST and PUT), and the static call-site count beside them.
  //
  // FOLLOW-UP 1 (T1 defect D-2) — TWO AMENDMENTS, both pinned below.
  //   • The gate has a second arm on the set route: an id that is ALREADY a live seed_parent of the
  //     route's own lot is acceptable (so a lot keeping a parent whose planting was later deleted can
  //     still be edited). It widens nothing across households: the arm reads link rows through the
  //     lot the caller owns, and a member was gated when it was added. POST has no such arm.
  //   • The gate is no longer the only check. It runs before the transaction, and a request that
  //     then waited for its lot behind a planting merge acted on a pre-merge answer — it linked the
  //     planting the merge had just deleted. The same two-arm rule is now a conjunct of every WRITE
  //     statement, evaluated under the lot lock with the plantings share-locked, and POST's link
  //     INSERT carries it with an assertion that rolls the lot back. A gate that is right when it is
  //     asked and stale when it is used is the same hole as no gate, one request later.
  'inventory-items::plant_id',
  // V4-PLANTMERGE-001 — mergeCore (plants/merge.js). NONE of these is body-settable. The four
  // id-shaped ones are all written as the WINNER id, which is the ROUTE's path segment, and
  // mergeCore's step 2 loads the ENTIRE group (winner + every loser) with
  // `created_by = ANY(householdIds)` and 404s unless all of them match — set-wise, so one foreign
  // id fails the whole merge before any statement is built. That is a stronger predicate than a
  // per-column loader, and it is pinned by its own assertion below rather than absolved here.
  'plants::winner_plant_id',    // merge_event.winner_plant_id = the path id (asserted below)
  'plants::garden_node_id',     // UPDATE evidence/findings SET garden_node_id = <winner>
  'plants::source_plant_id',    // UPDATE inventory_items SET source_plant_id = <winner> (Put-Up train §6a)
  'plants::entity_id',          // UPDATE favorites SET entity_id = <winner>  (cf. favorites::entity_id)
  'plants::target_id',          // UPDATE critter_state/treatment_association (cf. events::target_id)
  'plants::op_id',              // text idempotency key, no FK at all (cf. projects::op_id)
  'plants::workspace_id',       // copied off the winner's own row (cf. projects::workspace_id)
  // V4-OVERWINTERCARE-001 — care_profile.scope_id, written by setOverwinterCore (plants/
  // overwinterAttr.js) at scope='leaf'. Not body-settable: the value is the ROUTE's path segment,
  // and the body carries only a regime string and two MM-DD dates, all of which are validated
  // against an allowlist before any statement is built. The gate is the preflight immediately
  // above the write — the same canonical planting predicate /archive and the PUT use (container
  // arm with the F4 deleted-container conjunct, plus the project-less own-created_by arm) — and it
  // 404s before the upsert. Absolving it here rather than adding a SITES row because there is no
  // loader to name: the id being gated IS the path id, so a per-column loader would re-ask the
  // question the preflight just answered. It is pinned by a running assertion rather than a regex,
  // in plants/overwinter-writer.test.js ('404s when the ownership preflight matches nothing, and
  // writes nothing' + 'preflights with the canonical ownership predicate, aliased gn').
  'plants::scope_id',
  'inventory-items::featured_photo_id', // must be a photo LINKED to this item + created_by
  // POST /api/share/facebook: `SELECT ... FROM photos WHERE id = ANY(photoIds) AND created_by =
  // ANY(householdIds) AND deleted_at IS NULL`, and a short count is a 404 for the WHOLE request
  // before any share_log INSERT — set-wise, so a single foreign id in the array fails all of it.
  'facebook-share::photo_id',
  'locations::featured_photo_id', 'plants::featured_photo_id', 'projects::featured_photo_id',
  // W-DEL adds a SECOND way the photos handler writes these two, and it is not body-settable at
  // all: photoDelete.js NULLs every display pointer at the photo being soft-deleted, and replays
  // the hero set on restore. Neither takes an id from the request body — both key on the ROUTE's
  // photo id, whose household ownership is proven by a pre-read before any statement is built, and
  // the null statements are scoped to `<pointer column> = <that photo id>` and nothing else. There
  // is no id here for a caller to point somewhere it does not own.
  'photos::featured_photo_id',
  // featured_image_id — the deprecated V1-era twin (0 rows populated on all four parents). photos
  // only ever NULLs it, alongside its twin, so a delete cannot leave the forgotten column pointing
  // at a deleted photo. The body-settable half lives in inventory-items and IS gated (see SITES).
  'photos::featured_image_id',
  'critter::plant_id', 'critter::source_event_id',
  'preservation::harvest_log_id', 'preservation::photo_id', 'preservation::plant_id',
  'preservation::storage_location_id', // the four module-private preservation loaders, asserted below
  // ── V5-INFLIGHTBATCH-001, three columns written by lambda/preservation/kitchenRoutes.js. They are
  //    here rather than in SITES for a MECHANICAL reason, not a judgement one: the `known` set above
  //    keys a SITES row as `file.replace('/index.js','')`, so a row naming a non-index handler file
  //    would key as `preservation/kitchenRoutes.js::<field>` and never match the `preservation::`
  //    pair the walker produces. Same position the four module-private preservation loaders are in.
  //
  // cover_photo_id — BODY-SETTABLE AND GATED, on BOTH verbs, by the shared loadOwnedPhoto from
  // household.js (anchored on photos.created_by, never the stale uploaded_by). It is a read surface:
  // the column comes straight back on every v_kitchen_batch_current row, which is the
  // storage_location_id class, not merely a bad FK. Both call sites are asserted by executing them —
  // lambda/preservation/kitchenRoutes.test.js runs each route against a mock driver and asserts the
  // household array is BOUND, which a static call-site scan cannot distinguish from written-but-dead.
  'preservation::cover_photo_id',
  // start_anchor_id — BODY-SETTABLE, NO DATABASE FK AT ALL (a polymorphic uuid naming photos.id or
  // harvest_log.id; the DDL declares it bare), so nothing enforced even EXISTENCE. Gated on both
  // verbs by gateStartAnchor, which dispatches to loadOwnedPhoto or the harvest_log created_by
  // predicate; validation first narrows the anchor kind to harvest|photo, so those two arms are
  // exhaustive and no id can reach the column unchecked. Nothing dereferences it today — this is the
  // Finding-1 class pre-empted, exactly as preservation::harvest_log_id was.
  'preservation::start_anchor_id',
  // batch_id — NOT BODY-SETTABLE. The close-out route writes `SET batch_id = c.id` where `c` is the
  // statement's own closing CTE, i.e. the ROUTE's batch id, whose household ownership was proven by a
  // pre-read before the statement was built. There is no request shape that puts a caller-chosen
  // value in this column, and it is deliberately absent from PRESERVATION_EDITABLE_COLUMNS so the
  // full-replace preservation PUT cannot reach it either (lambda/preservation/kitchen-batch-id-guard
  // .test.js). Same class as photos::featured_photo_id above.
  'preservation::batch_id',
  // Put-Up release 1b (kitchenRoutes.js / putUp.js). Four pairs, none a body-chosen FK into another
  // household's row:
  //   put_up_stage_id — NOT BODY-SETTABLE. Put it up writes `st.id` from the statement's own `stage`
  //     CTE (itself gated on the route's household-owned batch) onto its jars and lines.
  //   output_id — NOT BODY-SETTABLE. A line's output_id is an id the SERVER minted for a jar of the
  //     same statement (putUp.js planPutUp, crypto.randomUUID); no request field reaches it.
  //   voids_id — BODY-SETTABLE and GATED IN THE STATEMENT: the stages route's void is an INSERT…SELECT
  //     of the target row `WHERE t.id = <body> AND t.batch_id = <the route's owned batch> AND t.stage_kind
  //     IN (tended, moved, noted)`, so a foreign or cross-batch id writes nothing; the composite FK
  //     (batch_id, voids_id) is the backstop. Asserted by executing it in putUp.test.js.
  //   recipe_id — Put-Up release 4: BODY-SETTABLE on POST /api/kitchen-batches and GATED by
  //     recipeRoutes.js loadOwnedRecipe (`id = <body> AND user_id = ANY(householdIds) AND deleted_at IS
  //     NULL`, a 400 otherwise) before the INSERT; "Save as recipe" writes it only as the id its own
  //     statement just inserted. Asserted by execution in lambda/preservation/recipeRoutes.test.js.
  // Release F amends two of those: the keyed line POST (lineRoutes.js) DOES take put_up_stage_id and
  // output_id from the body — a final-step addition to an existing bottling — and gates both in
  // prepareLines through loadSittings, whose predicate is `batch_id = <the route's owned batch> AND
  // stage_kind = 'put_up' AND not voided`, with output_id required to be one of THAT sitting's live
  // jars (400 otherwise). The composite FKs (batch_id, put_up_stage_id) → kitchen_stage_log are the
  // backstop. A put-up's own lines still take neither (putUp.js refuses them).
  // And two F pairs, both SERVER-DERIVED, never read from a body:
  //   kitchen_batch_input_id — every pantry_use row names the line its own statement just inserted (a
  //     draw), or the line whose soft-delete / restore that statement performed (a reversal /
  //     re-draw); pantry_use_line_same_jar_fkey pins it to that line's own jar.
  //   reverses_use_id — the id of the line's live forward use, read inside the same statement;
  //     uq_pantry_use_reverses_use_id and pantry_use_reverses_same_jar_fkey are the backstop.
  'preservation::put_up_stage_id', 'preservation::output_id', 'preservation::voids_id',
  'preservation::recipe_id', 'preservation::kitchen_batch_input_id', 'preservation::reverses_use_id',
  // recipe_type_id — Put-Up release 4 (recipeRoutes.js), BODY-SETTABLE on POST / PATCH /api/recipes and
  // POST /api/recipes/from-batch/:batchId, and GATED on all three by loadOwnedRecipeType (a live built-in
  // with user_id NULL, or a live type whose user_id = ANY(householdIds); a 400 otherwise) before the
  // write. Asserted by execution (STRANGER's type → 400) in lambda/preservation/recipeRoutes.test.js.
  'preservation::recipe_type_id',
  // preservation_log_id — Release F amends this: a DRAW line (lineRoutes.js prepareLines, and a
  // put-up's added lines) takes it from the body and gates it through loadJars, `id = ANY(<body ids>)
  // AND user_id = ANY(householdIds)` — a foreign id is a 400, never written; pantry_use's comes from
  // the line or the use route's household-scoped `pre` CTE. The sourceRoutes.js rule below stands:
  // preservation_log_id — NOT BODY-SETTABLE, V5-PUTUPMULTISOURCE-001. Every write of it is
  // `${putUp.id}` where `putUp` is the row returned by sourceRoutes.js's loadOwnedPutUp, whose
  // predicate is `id = <route param> AND user_id = ANY(householdIds) AND deleted_at IS NULL` and
  // which returns null — answered as a bare 404 — for absent, malformed, out-of-household and
  // soft-deleted alike. The route param is the ONLY origin for the value; the request body is read
  // exclusively for the `sources` array, and normalizeSourceRows' allowlist (PS_WRITABLE_COLUMNS in
  // putUpSources.js) does not contain this column, so a caller-supplied `preservation_log_id` inside
  // a source row is dropped before the INSERT is built rather than silently honoured. Same class as
  // preservation::batch_id and photos::featured_photo_id above: the id is the ROUTE's, and its
  // household ownership was proven by a pre-read before any statement was constructed.
  // Asserted by EXECUTION, not by a static call-site scan: lambda/preservation/sourceRoutes.test.js
  // runs both verbs against a mock driver and asserts the household array is BOUND on the ownership
  // read, that a STRANGER household 404s, and — the ownership case a single-owner fixture cannot
  // reach — that the INSERT copies user_id from the PARENT row rather than from the caller, so one
  // household member editing another's jar cannot re-own its sources.
  'preservation::preservation_log_id',
  // pantry_item_id — Put-Up release 2 (B′, v5-pantry-001). BODY-SETTABLE AND GATED: the keyed line POST
  // (lineRoutes.js prepareLines) takes it from a 'pantry' line and resolves it through loadPantryItems
  // (pantryItems.js), `id = ANY(<body ids>) AND user_id = ANY(householdIds)` — a foreign or malformed id
  // is a 400, never written; a removed item is 409 item_removed. Here for the same MECHANICAL reason as
  // the kitchenRoutes.js columns above (a non-index handler file keys as `preservation::`). Asserted by
  // EXECUTION in lambda/preservation/pantryRoutes.test.js (the household array bound on the loader, a
  // STRANGER item refused). pantry_item's own storage_location_id / plant_id (pantryRoutes.js) are the
  // `preservation::storage_location_id` / `preservation::plant_id` pairs already listed, gated by
  // loadPlace and lineRoutes.js loadPlantings, and asserted by execution in the same file.
  'preservation::pantry_item_id',
  // ── The id being READ, not written: a `WHERE id = ${...}` inside the SET-clause slice, or the
  //    handler's own row id / route param. Nothing crosses a household boundary. ──
  // photos::photo_id is NO LONGER read-only as of W-DEL: photoDelete.js NULLs plant_varieties.photo_id
  // (through public.cultivar) and preservation_log.photo_id when a photo is soft-deleted. Still no
  // ownership gate needed, and for a stronger reason than "it is only read" — the value is the
  // ROUTE's photo id, already proven household-owned, and the predicate is `photo_id = <that id>`.
  // R8 is why plant_varieties in particular may not carry a household predicate here: it is a SHARED
  // cultivar catalogue (424 rows, RLS disabled, created_by includes `system` and intake scripts), so
  // scoping by the photo is the ONLY form that is both correct and safe.
  'events::event_id', 'photos::photo_id', 'plants::plant_id', 'projects::plant_id',
  'projects::project_id', 'dashboard::project_id', 'harvests::gn_id', 'tags::tag_id',
  'plants::container_id', 'plants::leaf_id', 'projects::old_parent_id',
  'photos::entity_id', 'photos::garden_node_id', 'varieties::entity_id', 'varieties::tag_id',
  // ── Written by a side-effect writer from an ALREADY-GATED parent value, not from the body. ──
  'events::achievement_id', 'events::trigger_event_id', 'events::source_event_id',
  'events::location_id', 'events::plant_id', 'events::project_id',

  // ── V4-HARVSURFACE-001: the harvest_watch_dismissal INSERT (lambda/harvests/watch-route.js). ──
  //
  // Ownership decision, recorded per column rather than waved through as a group. The gate is
  // structural: handleDismissalPost NEVER writes a body value into any of these. It re-runs
  // queryWatchRows — which is itself scoped `pj.created_by = ANY(householdIds)` — builds the
  // candidate list from that result, and 404s unless the requested plant_id is IN it. Only then is
  // the row assembled, and every FK below is copied off the SERVER's own candidate object.
  //
  // So a foreign or soft-deleted planting cannot reach the INSERT at all: it is absent from the
  // household-scoped query, so `candidates.find(...)` misses and the request 404s before any write.
  // Same generic answer for absent / foreign / not-a-candidate — no existence oracle.
  //
  // Pinned by watch-route.test.js: "a planting that is not an active candidate answers 404 with no
  // detail" (asserts sql.calls never reaches the INSERT) and "IGNORES client-supplied model fields
  // entirely" (asserts an attacker-supplied anchor/model payload is not bound into the statement).
  'harvests::plant_id',       // body-supplied, but validated by membership in the scoped candidate list
  'harvests::project_id',     // copied off the server candidate, never read from the body
  'harvests::variety_id',     // ditto
  'harvests::crop_type_slug', // shared catalogue vocabulary, same class as preservation::crop_type_slug
  'harvests::user_id',        // server-derived: the JWT subject, same class as events::user_id

  // ── V5-VOICEALIAS-001: the voice_alias teach INSERT (lambda/varieties/index.js). ──────────────
  //
  // Ownership decision, recorded per column. Read this before assuming the entry is a silencing:
  // one of these columns is not body-settable at all, and the other IS gated — by an existence
  // check the static matcher cannot see, because the matcher pattern-matches an INSERT column list
  // and has no view of where a bound value came from or what ran before it.
  //
  // user_id — NOT BODY-SETTABLE. The INSERT binds ${userId}, which is payload.sub from
  // verifyToken; the handler additionally refuses a falsy subject before any query
  // (V4-AUTHZRESIDUE-001, index.js). There is no request shape that puts a caller-chosen value in
  // this column. Identical class to harvests::user_id and events::user_id above.
  //
  // variety_id — BODY-SUPPLIED AND GATED. The POST validates a uuid, then runs
  //   SELECT id FROM public.cultivar WHERE id = ${varietyId} AND deleted_at IS NULL
  // and returns 404 when absent — verified reached BEFORE the INSERT (the SELECT and its 404 sit
  // ~12 lines above the INSERT in the same block, not on a branch that can skip it).
  //
  // WHY THAT GATE IS THE RIGHT STRENGTH, and specifically why it does NOT carry the household /
  // managed-principal arm that PUT, DELETE and the recovery reads in that file use. Checked against
  // the code rather than the file header: GET /api/varieties/:id is `WHERE id = $1 AND deleted_at
  // IS NULL` with NO ownership predicate, so a cultivar is readable by ANY authenticated user. The
  // existence check above therefore admits exactly the set the caller can already GET — it is as
  // strict as the route's own read policy and no stricter.
  //
  // And the row it writes is a PERSONAL ANNOTATION, not a claim on the cultivar: voice_alias is
  // (user_id, heard_key) -> variety_id, stored against the caller's own subject, and every read of
  // it is scoped `WHERE user_id = ${userId}`. So referencing a cultivar here grants no access,
  // reveals nothing the caller could not already read, and is invisible to every other user. There
  // is no escalation for the household arm to prevent.
  //
  // Gating it on the WRITE predicate instead would be an active defect, not extra safety: the
  // chooser lists and selects globally-readable cultivars, so the picker would offer a variety and
  // the app would then refuse to remember what the user calls it, with no explanation that made
  // sense. authz-household.test.js independently pins that this route does not use that arm (its
  // count of exactly six scoped predicates is unchanged by V5-VOICEALIAS-001).
  //
  // NOTE ON WHY THE LIST GETTING SHORTER IS NOT THE ARGUMENT — the trap the project-state landmines
  // record for the earlier SITES row that went to 0: that was safe because a STRICTER pin replaced
  // it, not because the count fell. Same shape here (a real gate the matcher cannot observe), so
  // what makes THIS entry safe is the recorded rationale plus the existence check actually being
  // there and actually preceding the write — both verified above, neither inferred.
  //
  // Pinned by varieties/voice-alias-columns.test.js: 'reads are scoped to the calling user' asserts
  // every voice_alias SELECT carries `user_id =`, so the privacy half cannot regress silently.
  'varieties::user_id',       // server-derived: the JWT subject, never read from the body
  'varieties::variety_id',    // body-supplied, gated by an existence check as strict as the read policy
];

describe('BUG-AUTHZFKENUM-001: every FK-shaped column a handler writes is gated or explicitly known', () => {
  it('the sweep finds the handler fleet (guards against an empty walk)', () => {
    // Without this the two assertions below pass vacuously the moment the walk or the regex breaks.
    // 102 pairs at the time of writing; the floor is deliberately just under it.
    expect(pairsOnDisk().length).toBeGreaterThanOrEqual(95);
  });

  it('sees the handler that destructures its body — the blind spot that motivated the rewrite', () => {
    // lambda/evidence-ingest contributed ZERO pairs to the previous scan while carrying two ungated
    // FKs. If this ever goes back to empty, the rewrite has been reverted and the class is reopened.
    const pairs = pairsOnDisk();
    expect(pairs).toContain('evidence-ingest::garden_node_id');
    expect(pairs).toContain('evidence-ingest::entity_id');
    // …and the non-`_id` FK, and a dir reached only by walking a non-index module.
    expect(pairs).toContain('varieties::crop_type_slug');
    // dashboard/index.js contributes ZERO FK columns — every dashboard pair comes from
    // handlers.js — so this still proves the walk does not stop at index.js. It used to assert
    // `dashboard::crop_type_slug`, which OPS-DASHSCRATCHMJS-001 showed was contributed by a dead
    // _tagsub scratch runner rather than by any handler: the control was real but its exemplar was
    // a file that never shipped a write. This one is handlers.js, which does.
    expect(pairs).toContain('dashboard::user_id');
  });

  it('no FK-shaped written column exists that is neither in SITES nor explicitly listed', () => {
    const known = new Set([
      ...SITES.map(([file, field]) => `${file.replace('/index.js', '')}::${field}`),
      ...NOT_IN_SITES,
    ]);
    const unknown = pairsOnDisk().filter((p) => !known.has(p));
    expect(unknown,
      'a body-settable FK appeared with no ownership decision recorded. Either add it to SITES ' +
      'with its gate count, or add it to NOT_IN_SITES — and if you add it there, say why in the ' +
      'BUG-AUTHZFKENUM-001 audit rather than only here.').toEqual([]);
  });

  it('nothing in NOT_IN_SITES has since been gated and left stale', () => {
    // The mirror of the EXEMPT-staleness rule in clear-channel-coverage.test.js: an entry that has
    // since been added to SITES would sit here forever pre-authorising a pair that is now covered.
    const inSites = new Set(SITES.map(([file, field]) => `${file.replace('/index.js', '')}::${field}`));
    expect(NOT_IN_SITES.filter((p) => inSites.has(p))).toEqual([]);
  });
});

describe('V4-AUTHZSWEEP-001: every settable cross-entity FK write site invokes a loader', () => {
  for (const [file, field, loader, gates] of SITES) {
    it(`${file} gates body.${field} with ${loader} at ${gates} site(s)`, () => {
      const src = decomment(readFileSync(join(here, file), 'utf8'));
      // Anchored on the GATE ITSELF — `!await loader(sql, <expr ending in the field>,` — not on a
      // loose three-token sequence spanning the file. The negation matters: it is what makes the
      // call a gate rather than a lookup, and it sits immediately beside the field it protects.
      // The value expression is an optional dotted prefix rather than a hardcoded `body.`
      // (BUG-AUTHZFKENUM-001): a handler that destructures its body gates `v.value.garden_node_id`,
      // and requiring the `body.` spelling is exactly what made such a handler unrepresentable here
      // and therefore left in NOT_IN_SITES. The FIELD NAME is still the anchor, so this cannot
      // match a gate on some other column.
      const re = new RegExp(`!\\s*await\\s+${loader}\\s*\\(\\s*sql\\s*,\\s*(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\.)?${field}\\s*,`, 'g');
      const found = (src.match(re) || []).length;
      expect(found,
        `expected ${gates} ownership gate(s) on body.${field} in ${file}, found ${found}. ` +
        'A verb that can set this FK without a gate is a cross-household write AND a read leak ' +
        'through every surface that JOINs the referenced row. If a verb legitimately stopped ' +
        'accepting this field, lower the count in SITES deliberately.').toBe(gates);
    });
  }

  it('plants create still gates a CLIENT-SUPPLIED project_id (V4-AUTOPROJECT-001)', () => {
    // The replacement for the SITES row above, which reads 0 because the generic matcher anchors on
    // an expression ending in the field name and this gate now runs on `resolvedProjectId`.
    //
    // THREE THINGS ARE PINNED, because any one alone can go green while the column is open:
    //   1. body.project_id is still what seeds the value — a rewrite that stopped reading it would
    //      make 2 and 3 true of a variable no client can influence, i.e. vacuous;
    //   2. the ownership gate still runs on that value, negated, and still returns 400;
    //   3. the server-side fallback is the ELSE arm, so it can never REPLACE a supplied value.
    // (3) is the one worth stating: if the fallback ever ran unconditionally it would silently
    // discard a caller's chosen container, and the gate above it would still be present and green.
    const src = decomment(readFileSync(join(here, 'plants/index.js'), 'utf8')).replace(/\s+/g, ' ');
    expect(src).toMatch(/let resolvedProjectId = body\.project_id \?\? null;/);
    expect(src).toMatch(
      /if \(resolvedProjectId != null\) \{ if \(!await loadOwnedProject\(sql, resolvedProjectId, householdIds\)\)[^}]*?return resp\(400,/);
    expect(src).toMatch(/\} else \{ resolvedProjectId = await resolveContainerForCultivar\(/);
  });

  it('projects create gates parent_project_id against container.created_by', () => {
    // Not a shared loader (container is the projects handler's own row type), so assert the inline
    // predicate instead: the create path could otherwise birth a project inside another household's tree.
    const src = decomment(readFileSync(join(here, 'projects/index.js'), 'utf8')).replace(/\s+/g, ' ');
    expect(src).toMatch(/body\.parent_project_id != null.*?FROM public\.container.*?created_by = ANY\(\$\{householdIds\}\).*?deleted_at IS NULL/);
  });

  it('inventory-items gates source_plant_id inline against garden_node', () => {
    // V4-SEEDLINK-001. Four things are pinned, because any three of them can hold while the column
    // is open: (1) the value really is read from the body — a gate on a server-derived value would
    // be vacuous; (2) the ownership SELECT names garden_node and binds householdIds — the base
    // `plants` table would ALSO be a Phase-4 ratchet regression, so the relation is load-bearing
    // twice over; (3) the rejection is warnRejectedFk + a generic 400 with no existence oracle,
    // matching the two loader-backed gates in the same handler; and (4) the gate sits ABOVE the
    // UPDATE, which is the difference between a gate and a log line.
    const raw = readFileSync(join(here, 'inventory-items/index.js'), 'utf8');
    const src = decomment(raw).replace(/\s+/g, ' ');
    expect(src).toMatch(/const sourcePlantId = body\.source_plant_id \?\? null;/);
    expect(src).toMatch(
      /SELECT p\.id FROM public\.garden_node p WHERE p\.id = \$\{sourcePlantId\} AND p\.created_by = ANY\(\$\{householdIds\}\) AND p\.deleted_at IS NULL/);
    // The base table would satisfy an ownership check and regress the Phase-4 ratchet — assert the
    // view is what is joined, not merely that SOMETHING household-scoped was queried.
    expect(src).not.toMatch(/FROM public\.plants p WHERE p\.id = \$\{sourcePlantId\}/);
    expect(src).toMatch(
      /if \(!owned\.length\) \{ warnRejectedFk\(userId, 'inventory_items', 'source_plant_id', sourcePlantId\); return resp\(400,/);
    // A malformed id must not reach Postgres: 22P02 falls through the catch as an opaque 500, which
    // is the contract V4-AUTHZRESIDUE-001 closed everywhere else.
    expect(src).toMatch(/UUID_RE\.test\(String\(sourcePlantId\)\)/);
    expect(raw).toMatch(/const UUID_RE = /);
    // Ordering: the reject must precede the write, not merely coexist with it in the file.
    // V5-SEEDMULTIPARENT-001 moved the write: the route no longer runs its own
    // `UPDATE … SET source_plant_id = ${sourcePlantId}` but hands the gated id to the set-replace
    // transaction (seed-lot-parents.js), flagged legacy. So the marker is that hand-off, and it is
    // pinned to carry exactly the gated value and nothing else from the body.
    const gateIdx = src.indexOf("warnRejectedFk(userId, 'inventory_items', 'source_plant_id'");
    const write = 'ids: sourcePlantId != null ? [String(sourcePlantId).toLowerCase()] : [], householdIds, userId, legacy: true,';
    const writeIdx = src.indexOf(write);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(gateIdx, 'the ownership gate must precede the write').toBeLessThan(writeIdx);
    // …and it is the PATCH route's own write that follows its own gate: no other statement sits
    // between them that could have assigned the column first.
    expect(src.slice(gateIdx, writeIdx)).not.toMatch(/\bsql`/);
    expect(src.slice(writeIdx - 120, writeIdx)).toMatch(/replaceSourcePlants\(sql, \{ lotId: itemId, $/);
  });

  // ── V5-SEEDMULTIPARENT-001 — inventory-items::plant_id, the ARRAY gate ──────────────────────────
  // Three assertions, because no one of them is enough: the static one proves each write site calls
  // the gate (a perfect gate nobody invokes protects nothing); the unit one proves the gate COUNTS;
  // the executed one proves that when it refuses, the handler has written nothing.
  const OWNED_A = '00000000-0000-4000-8000-0000000000a1';
  const OWNED_B = '00000000-0000-4000-8000-0000000000a2';
  const FOREIGN = '00000000-0000-4000-8000-0000000000bb';

  it('inventory-items gates a source_plant_ids array at every site that can write a link row', () => {
    const src = decomment(readFileSync(join(here, 'inventory-items/index.js'), 'utf8')).replace(/\s+/g, ' ');
    // The gate, negated, followed at once by the reject — at exactly TWO sites (POST and PUT
    // /:id/source-plants), and there is no call to it that is not one of those two gates.
    // The optional last argument is the lot whose existing parents the second arm admits: the PUT
    // passes its own route id and nothing else can stand there; POST passes none, because a lot that
    // does not exist yet has no members (Follow-up 1).
    const gate = /if \(!await ownsEveryPlanting\(sql, (\w+)\.ids, householdIds(, itemId)?\)\) \{ warnRejectedFk\(userId, 'seed_lot_parent_planting', 'plant_id', \1\.ids\.join\(','\)\); return resp\(400, \{ error: SOURCE_PLANT_IDS_UNUSABLE \}\); \}/g;
    expect([...src.matchAll(gate)].map((m) => `${m[1]}${m[2] ?? ''}`).sort()).toEqual(['parentSet', 'set, itemId']);
    // 2 -> 3 with V5-SEEDLOTADDITION-001: POST /:id/seed-additions gates its ONE planting through the
    // same function. It is not an array site (the regex above does not match it); its own gate, order
    // and executed refusal are 'inventory-items gates the ONE plant_id of a seed addition' below.
    expect(src.match(/ownsEveryPlanting\(/g)).toHaveLength(3);
    expect(src).toMatch(/const SOURCE_PLANT_IDS_UNUSABLE = 'source_plant_ids does not match plantings you can use';/);

    // Every id that reaches a link INSERT is one a gate has cleared. Three producers, no others:
    //   PUT   — the gated array itself;
    //   PATCH — the single id the garden_node gate above cleared (asserted in the previous test);
    //   POST  — the gated array, or else the single id its own garden_node gate cleared.
    expect(src.match(/replaceSourcePlants\(/g)).toHaveLength(2);
    expect(src.match(/insertSeedParentLinks\(/g)).toHaveLength(1);
    expect(src).toMatch(/replaceSourcePlants\(sql, \{ lotId: itemId, ids: set\.ids, householdIds, userId, expected: expected\?\.ids \?\? null, cacheHint, rules: true, filing, \}\)/);
    expect(src).toMatch(
      /const parentIds = parentSet \? parentSet\.ids : \(sourcePlantId != null \? \[String\(sourcePlantId\)\.toLowerCase\(\)\] : \[\]\);/);
    expect(src).toMatch(/insertSeedParentLinks\(sql, \{ lotId, ids: parentIds, householdIds, userId \}\)/);
    // On POST the array REPLACES the single-id gate rather than running beside it, so the else-arm
    // is load-bearing: without it a body carrying only source_plant_id would reach the write ungated.
    expect(src).toMatch(/\} else if \(sourcePlantId != null\) \{ const owned = UUID_RE\.test\(String\(sourcePlantId\)\)/);

    // Ordering, per site: the reject precedes the write.
    const putGate = src.indexOf('if (!await ownsEveryPlanting(sql, set.ids, householdIds, itemId))');
    const putWrite = src.indexOf('replaceSourcePlants(sql, { lotId: itemId, ids: set.ids,');
    const postGate = src.indexOf('if (!await ownsEveryPlanting(sql, parentSet.ids, householdIds))');
    const postWrite = src.indexOf('insertSeedParentLinks(sql, { lotId, ids: parentIds,');
    for (const i of [putGate, putWrite, postGate, postWrite]) expect(i).toBeGreaterThan(-1);
    expect(putGate, 'PUT: the gate must precede the write').toBeLessThan(putWrite);
    expect(postGate, 'POST: the gate must precede the write').toBeLessThan(postWrite);

    // And the statement itself takes its plantings from that array and from nowhere else.
    const helper = decomment(readFileSync(join(here, 'inventory-items/seed-lot-parents.js'), 'utf8')).replace(/\s+/g, ' ');
    expect(helper).toMatch(
      /INSERT INTO public\.seed_lot_parent_planting \(inventory_item_id, plant_id, role, created_by\) SELECT i\.id, u\.plant_id, 'seed_parent', \$\{userId\}::text FROM public\.inventory_items i CROSS JOIN unnest\(\$\{ids\}::uuid\[\]\) AS u\(plant_id\) WHERE i\.id = \$\{lotId\} AND i\.created_by = ANY\(\$\{householdIds\}\) AND i\.deleted_at IS NULL AND i\.category = 'seeds'/);
    expect(helper.match(/INSERT INTO public\.seed_lot_parent_planting/g)).toHaveLength(1);
  });

  it('inventory-items re-tests the array gate INSIDE every statement that writes a link row or its cache', () => {
    // FOLLOW-UP 1 (T1 defect D-2). The gate above is read before the transaction; a request that
    // then waits for its lot acts on a stale answer. Observed on real Postgres: a PUT re-sending
    // {A, L} waited behind a merge of L into W, then retired W's row and linked the soft-deleted L,
    // on a 200. So the rule is ALSO a conjunct of each write — the same two arms, counted over the
    // whole array — and when it fails none of them does anything.
    const helper = decomment(readFileSync(join(here, 'inventory-items/seed-lot-parents.js'), 'utf8')).replace(/\s+/g, ' ');
    const USABLE = "(SELECT count(*) FROM unnest(${ids}::uuid[]) AS q(plant_id) WHERE EXISTS ( SELECT 1 FROM public.garden_node p WHERE p.id = q.plant_id AND p.created_by = ANY(${householdIds}) AND p.deleted_at IS NULL) OR EXISTS ( SELECT 1 FROM public.seed_lot_parent_planting k WHERE k.inventory_item_id = i.id AND k.plant_id = q.plant_id AND k.role = 'seed_parent' AND k.deleted_at IS NULL)) = cardinality(${ids}::uuid[])";
    const statements = [...helper.matchAll(/sql`([^`]*)`/g)].map((m) => m[1].trim());
    // Every statement in the module that writes: the soft-delete, the link INSERT, the cache UPDATE.
    const writes = statements.filter((s) => /^(UPDATE|INSERT)\b/.test(s));
    expect(writes).toHaveLength(3);
    for (const w of writes) {
      expect(w, 'a write statement without the in-transaction ownership re-test').toContain(`AND ${USABLE}`);
    }
    // The first arm is the gate's own predicate — the household's LIVE planting, through the view —
    // and the second is membership of THIS lot (correlated on the locked lot row), never a bound id
    // a request could choose.
    expect(USABLE).toContain('p.created_by = ANY(${householdIds}) AND p.deleted_at IS NULL');
    expect(USABLE).toContain('k.inventory_item_id = i.id');
    // The same count is reported by the read that follows the locks, so the route can say WHICH
    // guard refused; and it is nowhere else (a differently-scoped copy is how statements disagree).
    expect(helper).toContain(`(${USABLE}) AS ids_usable`);
    expect(helper.split(USABLE)).toHaveLength(5);

    // The plantings are held still for the transaction: a share lock, after the lot lock and before
    // the first statement that tests them — in the set-replace…
    const replace = helper.slice(helper.indexOf('export async function replaceSourcePlants'));
    const lotLock = replace.indexOf('FOR UPDATE `');
    const hold = replace.indexOf('lockPlantings(sql, ids),');
    const firstTest = replace.indexOf(USABLE);
    for (const i of [lotLock, hold, firstTest]) expect(i).toBeGreaterThan(-1);
    expect(lotLock, 'the lot is locked before the plantings').toBeLessThan(hold);
    expect(hold, 'the plantings are locked before anything tests them').toBeLessThan(firstTest);
    expect(helper).toMatch(/export function lockPlantings\(sql, ids\) \{ return sql` SELECT p\.id FROM public\.garden_node p WHERE p\.id = ANY\(\$\{ids\}::uuid\[\]\) ORDER BY p\.id FOR SHARE `; \}/);

    // …and in the create, where a refused INSERT must also take the lot back: a statement that
    // raises unless every planting was linked, placed after the INSERT and before the read-back.
    const src = decomment(readFileSync(join(here, 'inventory-items/index.js'), 'utf8')).replace(/\s+/g, ' ');
    expect(src).toMatch(
      /await sql\.transaction\(\[ insertLot, lockPlantings\(sql, parentIds\), judgeParentRules\(sql, \{ lotId, ids: parentIds, householdIds, alone: true \}\), insertSeedParentLinks\(sql, \{ lotId, ids: parentIds, householdIds, userId \}\), assertEveryParentLinked\(sql, \{ lotId, ids: parentIds, householdIds \}\), readSourcePlants\(sql, householdIds, lotId\), \]\)/);
    expect(helper).toMatch(/SELECT 1 \/ \(CASE WHEN \( SELECT count\(\*\) FROM public\.seed_lot_parent_planting l JOIN public\.inventory_items i ON i\.id = l\.inventory_item_id WHERE i\.id = \$\{lotId\} AND i\.created_by = ANY\(\$\{householdIds\}\) AND i\.deleted_at IS NULL AND l\.role = 'seed_parent' AND l\.deleted_at IS NULL\) = cardinality\(\$\{ids\}::uuid\[\]\) THEN 1 ELSE 0 END\)/);
  });

  it('ownsEveryPlanting refuses an id array with ONE foreign planting (a count, not a presence test)', async () => {
    // THE ARM THAT MATTERS. Two ids asked for, one row back: `!owned.length` is false here, so a
    // presence test lets the foreign planting through to the INSERT.
    const one = fakeSql([{ id: OWNED_A }]);
    expect(await ownsEveryPlanting(one, [OWNED_A, FOREIGN], HOUSE)).toBe(false);
    // The refusal came from the ownership query, not from a short-circuit that never asked.
    expect(one.calls).toHaveLength(1);
    const t = textOf(one);
    expect(t).toMatch(/SELECT p\.id FROM public\.garden_node p WHERE p\.id = ANY\(\?::uuid\[\]\) AND p\.created_by = ANY\(\?\) AND p\.deleted_at IS NULL/);
    // The id array and the household array are BOUND parameters, in that order, never interpolated.
    expect(one.calls[0].values).toEqual([[OWNED_A, FOREIGN], HOUSE]);

    // All owned -> through. None owned -> refused. An empty set asks nothing and is allowed.
    expect(await ownsEveryPlanting(fakeSql([{ id: OWNED_A }, { id: OWNED_B }]), [OWNED_A, OWNED_B], HOUSE)).toBe(true);
    expect(await ownsEveryPlanting(fakeSql([]), [OWNED_A, OWNED_B], HOUSE)).toBe(false);
    const empty = fakeSql([{ id: 'should-never-be-reached' }]);
    expect(await ownsEveryPlanting(empty, [], HOUSE)).toBe(true);
    expect(empty.calls).toHaveLength(0);

    // The count is of the ASKED-FOR ids that came back, so rows cannot be padded into a pass: the
    // right number of rows naming the wrong plantings is still a refusal, and so is one owned
    // planting returned twice.
    expect(await ownsEveryPlanting(fakeSql([{ id: OWNED_A }, { id: OWNED_B }]), [OWNED_A, FOREIGN], HOUSE)).toBe(false);
    expect(await ownsEveryPlanting(fakeSql([{ id: OWNED_A }, { id: OWNED_A }]), [OWNED_A, FOREIGN], HOUSE)).toBe(false);

    // A malformed id never reaches Postgres (22P02 -> an opaque 500, the V4-AUTHZRESIDUE-001 contract).
    const bad = fakeSql([{ id: 'should-never-be-reached' }]);
    expect(await ownsEveryPlanting(bad, [OWNED_A, 'not-a-uuid'], HOUSE)).toBe(false);
    expect(bad.calls, 'must short-circuit before issuing SQL').toHaveLength(0);
  });

  it('ownsEveryPlanting\'s second arm admits an id only as an EXISTING parent of the caller\'s own lot', async () => {
    // FOLLOW-UP 1. The arm that must not become a way round the first: it is asked only about the
    // ids the first arm did not admit, only for the lot the route named, and only through a lot the
    // household owns. A fake that answers each of the two statements separately.
    const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
    const GONE = '00000000-0000-4000-8000-0000000000dd';   // a planting since soft-deleted
    const twoArm = (ownedRows, memberRows) => {
      const calls = [];
      const fn = (strings, ...values) => {
        const text = strings.join('?');
        calls.push({ text, values });
        return Promise.resolve(/FROM public\.seed_lot_parent_planting k/.test(text) ? memberRows : ownedRows);
      };
      fn.calls = calls;
      return fn;
    };

    // Kept member: the first arm returns only A; the second finds GONE among the lot's live parents.
    const kept = twoArm([{ id: OWNED_A }], [{ id: GONE }]);
    expect(await ownsEveryPlanting(kept, [OWNED_A, GONE], HOUSE, LOT)).toBe(true);
    expect(kept.calls).toHaveLength(2);
    expect(kept.calls[1].text.replace(/\s+/g, ' ')).toMatch(
      /SELECT k\.plant_id AS id FROM public\.seed_lot_parent_planting k JOIN public\.inventory_items i ON i\.id = k\.inventory_item_id WHERE i\.id = \? AND i\.created_by = ANY\(\?\) AND i\.deleted_at IS NULL AND i\.category = 'seeds' AND k\.plant_id = ANY\(\?::uuid\[\]\) AND k\.role = 'seed_parent' AND k\.deleted_at IS NULL/);
    // The lot, the household, and ONLY the id the first arm left over — bound, in that order.
    expect(kept.calls[1].values).toEqual([LOT, HOUSE, [GONE]]);

    // A foreign planting that is NOT a member is still refused — and both arms were asked.
    const foreign = twoArm([{ id: OWNED_A }], []);
    expect(await ownsEveryPlanting(foreign, [OWNED_A, FOREIGN], HOUSE, LOT)).toBe(false);
    expect(foreign.calls).toHaveLength(2);

    // It COUNTS, like the first arm: two left over and one of them a member is a refusal; so is the
    // right number of rows naming something that was not asked about.
    expect(await ownsEveryPlanting(twoArm([{ id: OWNED_A }], [{ id: GONE }]), [OWNED_A, GONE, FOREIGN], HOUSE, LOT)).toBe(false);
    expect(await ownsEveryPlanting(twoArm([], [{ id: OWNED_B }]), [FOREIGN], HOUSE, LOT)).toBe(false);

    // Nothing left over -> the second statement is never issued: the ordinary edit is one read.
    const ordinary = twoArm([{ id: OWNED_A }, { id: OWNED_B }], [{ id: 'should-never-be-reached' }]);
    expect(await ownsEveryPlanting(ordinary, [OWNED_A, OWNED_B], HOUSE, LOT)).toBe(true);
    expect(ordinary.calls).toHaveLength(1);

    // No lot (a create) -> no second arm, whatever a second statement would have said.
    const create = twoArm([{ id: OWNED_A }], [{ id: GONE }]);
    expect(await ownsEveryPlanting(create, [OWNED_A, GONE], HOUSE)).toBe(false);
    expect(create.calls).toHaveLength(1);

    // A lot id that is not one is never sent to Postgres, and admits nothing.
    const badLot = twoArm([{ id: OWNED_A }], [{ id: GONE }]);
    expect(await ownsEveryPlanting(badLot, [OWNED_A, GONE], HOUSE, 'not-a-uuid')).toBe(false);
    expect(badLot.calls).toHaveLength(1);
  });

  it('a source_plant_ids array with one foreign planting writes ZERO rows — POST and PUT, executed', async () => {
    // Through the real handler, against the runtime stubs. The stub answers the ownership query
    // with ONE of the two plantings and would answer any write with a row, so a handler that went
    // on to write would both issue the statement and report success — the two things asserted absent.
    const { handler } = await import('./inventory-items/index.js');
    const USER = 'user_stub_owner';
    const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
    const event = (method, rawPath, body) => ({
      requestContext: { http: { method } }, rawPath,
      headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify(body),
    });
    const lot = { name: 'Mixed nasturtium', type: 'consumable', category: 'seeds', unit: 'packet',
      quantity_on_hand: 1, variety_id: 'd58b5155-0c23-4365-bfad-30549b8ca069' };
    const requests = [
      ['POST', event('POST', '/api/inventory-items', { ...lot, source_plant_ids: [OWNED_A, FOREIGN] })],
      ['PUT', event('PUT', `/api/inventory-items/${LOT}/source-plants`, { source_plant_ids: [OWNED_A, FOREIGN] })],
    ];
    // The gate's two statements, told apart from everything the write issues (which also names
    // garden_node, in its share lock and in each statement's own re-test of the rule).
    const isOwns = (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY\(\?::uuid\[\]\)\s+AND p\.created_by = ANY/.test(t);
    const isMembers = (t) => /SELECT k\.plant_id AS id/.test(t);
    const run = async (ev, ownedRows) => {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      // Release 2a: a set of two is also put to the parent rules, whose read asks each planting's
      // variety. Answered as two plantings of ONE variety, so the control below passes the rules for
      // a stated reason. (Unanswered, the rules read an id with no row as "being added, no variety"
      // and the control is a 400 — the rules failing closed, not the gate.)
      stubState.sqlHandler = (text, values) => {
        if (/AS lot_found/.test(text)) {
          return values[0].map((id) => ({
            id, cultivar_id: lot.variety_id, crop_slug: null, blend_key: null,
            member: false, lot_found: true, lot_variety_id: lot.variety_id,
          }));
        }
        if (isOwns(text)) return ownedRows;
        if (isMembers(text)) return [];           // the foreign planting is not a parent of this lot either
        return [{ id: LOT, source_plants: [], ids_usable: true }];
      };
      const warned = [];
      const orig = console.warn;
      console.warn = (m) => warned.push(m);
      let res;
      try { res = await handler(ev); } finally { console.warn = orig; }
      return { status: res.statusCode, body: JSON.parse(res.body || '{}'), warned, calls: stubState.sqlCalls };
    };

    for (const [verb, ev] of requests) {
      const refused = await run(ev, [{ id: OWNED_A }]);
      expect(refused.status, verb).toBe(400);
      expect(refused.body.error, verb).toBe('source_plant_ids does not match plantings you can use');
      // No existence oracle: the caller must not learn which id it was, or whether it exists.
      expect(refused.body.error).not.toMatch(/not found|exists/i);
      expect(JSON.stringify(refused.body)).not.toContain(FOREIGN);
      // Only the gate ran — the ownership query and, on the set route, its second arm asking whether
      // the leftover id is already a parent of this lot (a create has no such arm). No lot, no lock,
      // no link row, no cache update.
      expect(refused.calls.map((c) => (isOwns(c.text) ? 'owns' : isMembers(c.text) ? 'members' : 'OTHER')),
        `${verb}: a refused array reached the database again`).toEqual(verb === 'PUT' ? ['owns', 'members'] : ['owns']);
      expect(refused.calls[0].values).toEqual([[OWNED_A, FOREIGN], [USER]]);
      if (verb === 'PUT') expect(refused.calls[1].values).toEqual([LOT, [USER], [FOREIGN]]);
      expect(refused.calls.filter((c) => /\b(INSERT|UPDATE)\b|FOR (UPDATE|SHARE)/.test(c.text))).toHaveLength(0);
      // Server-side observability for the refusal.
      expect(refused.warned).toHaveLength(1);
      expect(JSON.parse(refused.warned[0])).toMatchObject({
        msg: 'authz-fk-reject', userId: USER, table: 'seed_lot_parent_planting', column: 'plant_id',
      });

      // The control: the SAME request, with both plantings owned, does reach the link INSERT. Without
      // this the block above would pass against a handler that refuses every array.
      const allowed = await run(ev, [{ id: OWNED_A }, { id: FOREIGN }]);
      expect(allowed.status, `${verb} control`).toBeLessThan(300);
      expect(allowed.calls.filter((c) => /INSERT INTO public\.seed_lot_parent_planting/.test(c.text)),
        `${verb} control`).toHaveLength(1);
      expect(allowed.warned).toHaveLength(0);
    }
  });

  // ── V5-SEEDLOTADDITION-001 — the third ownsEveryPlanting site: ONE planting, by `plant_id` ──────
  it('inventory-items gates the ONE plant_id of a seed addition, before the write, with no lot id handed over', () => {
    const src = decomment(readFileSync(join(here, 'inventory-items/index.js'), 'utf8')).replace(/\s+/g, ' ');
    // Negated, followed at once by the reject. The array is the one normalised id and nothing else,
    // and there is NO fourth argument: the gate's second arm ("already a parent of this lot") is not
    // offered here, so a planting that has been soft-deleted cannot receive a picking even on a lot
    // it is a parent of.
    const gate = "if (!await ownsEveryPlanting(sql, [addition.plantId], householdIds)) { warnRejectedFk(userId, 'seed_lot_parent_planting', 'plant_id', addition.plantId); return resp(400, { error: PLANT_ID_UNUSABLE }); }";
    expect(src.split(gate)).toHaveLength(2);
    expect(src).toMatch(/const PLANT_ID_UNUSABLE = 'plant_id does not match a planting you can use';/);
    // The id comes from the body through the module's own normaliser, never straight off `body`.
    expect(src).toMatch(/const addition = normalizeAddition\(JSON\.parse\(event\.body \?\? '\{\}'\)\);/);
    // Ordering: the reject precedes the write, and the write is handed that same normalised request.
    const gateIdx = src.indexOf(gate);
    const write = 'addSeedToLot(sql, { lotId: itemId, householdIds, userId, ...addition })';
    const writeIdx = src.indexOf(write);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(gateIdx, 'the ownership gate must precede the write').toBeLessThan(writeIdx);
    expect(src.match(/addSeedToLot\(/g)).toHaveLength(1);
    // The gate is skipped in exactly one case — the addition_key is already recorded — and that
    // request cannot write: the transaction answers it as a replay before any statement that inserts.
    expect(src).toMatch(/const recorded = await readAdditionKey\(sql, addition\.additionKey\); if \(!recorded\.length\) \{ if \(!await ownsEveryPlanting\(/);

    // The fourth producer of an id for the link INSERT, and it is that gated id alone.
    const add = decomment(readFileSync(join(here, 'inventory-items/seed-lot-additions.js'), 'utf8')).replace(/\s+/g, ' ');
    expect(add.match(/insertSeedParentLinks\(/g)).toHaveLength(1);
    expect(add).toContain('insertSeedParentLinks(sql, { lotId, ids: [plantId], householdIds, userId })');
    // Under the lock the plant is judged again, through the household and live — the gate's first arm.
    expect(add).toMatch(/LEFT JOIN public\.garden_node p ON p\.id = \$\{plantId\}::uuid AND p\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(add).toContain('(p.id IS NOT NULL AND p.deleted_at IS NULL) AS plant_live');
    expect(add).toContain("WHEN NOT g.plant_live THEN 'plants_changed'");
    // The picking's own FK is never a bound value: it is the lot's link row for that plant.
    expect(add).toMatch(/INSERT INTO public\.seed_lot_addition \(addition_key, parent_link_id, [^)]*\) SELECT \$\{additionKey\}::uuid, pre\.link_id,/);
  });

  it('a seed addition naming a foreign planting writes ZERO rows — executed', async () => {
    const handler = inventoryItemsHandler;
    const USER = 'user_stub_owner';
    const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
    const KEY = '7b0c7a52-5a0e-4c57-9a55-0d6c1b1b9f10';
    const ADDITION = '0c1d2e3f-0000-4000-8000-00000000ad01';
    const ev = {
      requestContext: { http: { method: 'POST' } }, rawPath: `/api/inventory-items/${LOT}/seed-additions`,
      headers: { authorization: 'Bearer stub-token' },
      body: JSON.stringify({ addition_key: KEY, plant_id: FOREIGN, expected_source_plant_ids: [], picked_on: '2026-09-01', add_seed_count: 12, add_estimated: false }),
    };
    const isKey = (t) => /FROM public\.seed_lot_addition a\s+WHERE a\.addition_key = \?::uuid\s*$/.test(t);
    const isOwns = (t) => /FROM public\.garden_node p\s+WHERE p\.id = ANY\(\?::uuid\[\]\)\s+AND p\.created_by = ANY/.test(t);
    const run = async (ownedRows) => {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = (text) => {
        if (isKey(text)) return [];               // not recorded yet: the gate is not skipped
        if (isOwns(text)) return ownedRows;
        if (/AS verdict/.test(text)) return [{ id: LOT, verdict: 'go', plant_member: false }];
        if (/WITH pre AS/.test(text)) return [{ id: LOT, addition_id: ADDITION, count_applied: false, weight_applied: false }];
        return [];
      };
      const warned = [];
      const orig = console.warn;
      console.warn = (m) => warned.push(m);
      let res;
      try { res = await handler(ev); } finally { console.warn = orig; }
      return { status: res.statusCode, body: JSON.parse(res.body || '{}'), warned, calls: stubState.sqlCalls };
    };

    const refused = await run([]);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'plant_id does not match a planting you can use' });
    expect(JSON.stringify(refused.body)).not.toContain(FOREIGN);
    expect(JSON.stringify(refused.body)).not.toContain(LOT);
    // Only the key read and the gate ran: no lot, no lock, no link row, no picking row.
    expect(refused.calls.map((c) => (isKey(c.text) ? 'key' : isOwns(c.text) ? 'owns' : 'OTHER'))).toEqual(['key', 'owns']);
    expect(refused.calls[1].values).toEqual([[FOREIGN], [USER]]);
    expect(refused.calls.filter((c) => /\b(INSERT|UPDATE)\b|FOR (UPDATE|SHARE)/.test(c.text))).toHaveLength(0);
    expect(refused.warned).toHaveLength(1);
    expect(JSON.parse(refused.warned[0])).toMatchObject({
      msg: 'authz-fk-reject', userId: USER, table: 'seed_lot_parent_planting', column: 'plant_id',
    });

    // The control: the SAME request with the planting owned reaches both INSERTs. Without it the block
    // above would pass against a handler that refuses every addition.
    const allowed = await run([{ id: FOREIGN }]);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.addition).toMatchObject({ id: ADDITION, replayed: false, plant_was_added: true });
    expect(allowed.calls.filter((c) => /INSERT INTO public\.seed_lot_parent_planting/.test(c.text))).toHaveLength(1);
    expect(allowed.calls.filter((c) => /INSERT INTO public\.seed_lot_addition/.test(c.text))).toHaveLength(1);
    expect(allowed.warned).toHaveLength(0);
  });

  it('evidence-ingest gates a planting-typed entity_id through its planting_ref_id', () => {
    // BUG-AUTHZFKENUM-001. `entity` is a MIXED registry with NO created_by column of its own
    // (verified live 2026-08-10: 408 cultivar + 168 critter_species rows are shared vocabulary,
    // 271 planting rows are household data reachable via planting_ref_id -> plants). So the gate is
    // conditional and runs through the canonical planting predicate — it cannot be a SITES row
    // because the loader is handed the RESOLVED planting id, not the body field. Asserted here
    // instead of pre-absolved in NOT_IN_SITES, which is what the locations::parent_id entry used to
    // do while the pair was in fact wide open.
    const src = decomment(readFileSync(join(here, 'evidence-ingest/index.js'), 'utf8')).replace(/\s+/g, ' ');
    expect(src).toMatch(/SELECT id, planting_ref_id FROM public\.entity/);
    expect(src).toMatch(/ent\[0\]\.planting_ref_id != null && !await loadOwnedPlantingRef\(sql, ent\[0\]\.planting_ref_id, householdIds\)/);
    // The rejection must reuse the SAME 404 an absent entity gets — a 400 here would BE the
    // existence oracle ("exists, not yours" vs "no such entity") the loader contract forbids.
    expect(src).toMatch(/planting_ref_id, householdIds\)\) \{ warnRejectedFk\([^)]*\); return resp\(404, \{ error: 'Unknown entity_id' \}\); \}/);
  });

  it('mergeCore scopes the WHOLE merge group by created_by and refuses on any miss', () => {
    // V4-PLANTMERGE-001. The merge writes the winner id into four FK-shaped columns across five
    // tables and soft-deletes the losers, so an ungated group load would let a caller fold ANOTHER
    // household's planting into their own — a destructive cross-household write, not just a bad FK.
    // Not a SITES row because there is no per-column loader: one set-wise predicate covers every
    // member at once, which is why it is asserted here instead of pre-absolved in NOT_IN_SITES.
    const src = decomment(readFileSync(join(here, 'plants/merge.js'), 'utf8')).replace(/\s+/g, ' ');
    // The group load carries the CANONICAL two-arm predicate plus the live filter — the same
    // predicate that gates GET/PUT/DELETE/archive in plants/index.js, not a merge-local dialect.
    expect(src).toMatch(/FROM plants p LEFT JOIN plant_projects pp ON pp\.id = p\.project_id WHERE p\.id = ANY\(\$\{groupIds\}\) AND p\.deleted_at IS NULL/);
    expect(src).toMatch(/\(pp\.created_by = ANY\(\$\{householdIds\}\) AND pp\.deleted_at IS NULL\)/);
    // The own-created_by arm is NEVER unguarded: without `project_id IS NULL` it reaches a planting
    // the caller created inside ANOTHER household's container — a row they cannot even read, but
    // could merge (and thereby soft-delete and absorb the events of). Mirrors the identical guard
    // asserted in plants/project-less-write.test.js:108.
    expect(src).toMatch(/\(p\.project_id IS NULL AND p\.created_by = ANY\(\$\{householdIds\}\)\)/);
    expect(src).not.toMatch(/AND created_by = ANY\(\$\{householdIds\}\) `/);
    // A short count fails the WHOLE request — set-wise, so one foreign or deleted id aborts the
    // merge before any statement is built. A per-row skip here would silently merge the rest.
    expect(src).toMatch(/if \(plants\.length !== groupIds\.length\)/);
    expect(src).toMatch(/status: 404/);
    // groupIds must include the winner, or the winner itself would never be ownership-checked.
    expect(src).toMatch(/const groupIds = \[winnerId, \.\.\.loserIds\]/);
    // The winner may never appear among the losers — that would soft-delete the survivor.
    expect(src).toMatch(/loserIds\.includes\(winnerId\)/);
  });

  it('the varieties source-project idempotency SELECT is household-scoped and deterministic', () => {
    // BUG-AUTHZFKENUM-001, second half of that hole. The FK gate stops an attacker POINTING at a
    // foreign project; this stops them SQUATTING the key. The lookup was
    // `WHERE source_proj_rescope_project_id = $1 AND deleted_at IS NULL LIMIT 1` with no owner
    // predicate, so an attacker could pre-create a cultivar on a key an admin would later use and
    // have /admin/classify's inline-create return the ATTACKER'S row with 200. Owner arms mirror
    // the PUT/DELETE editable set exactly; ORDER BY makes the LIMIT 1 deterministic.
    const src = decomment(readFileSync(join(here, 'varieties/index.js'), 'utf8')).replace(/\s+/g, ' ');
    expect(src).toMatch(/WHERE source_proj_rescope_project_id = \$\{sourceProjId\} AND deleted_at IS NULL AND \( created_by = ANY\(\$\{household\}\) OR created_by LIKE ANY\(\$\{managedPatterns\}::text\[\]\) \) ORDER BY created_at ASC, id ASC LIMIT 1/);
  });

  it('locations featured-photo check anchors on created_by, not the stale uploaded_by', () => {
    // photos carries both columns; every other featured-photo validator uses created_by. This was
    // the one divergent surface (V-C1).
    const src = readFileSync(join(here, 'locations/index.js'), 'utf8');
    expect(src).not.toMatch(/uploaded_by = ANY/);
  });

  it('each gated handler imports the loaders it uses, from the right module', () => {
    for (const file of [...new Set(SITES.map(s => s[0]))]) {
      const src = decomment(readFileSync(join(here, file), 'utf8'));
      const needed = [...new Set(SITES.filter(s => s[0] === file).map(s => s[2]))];
      const houseImport = src.match(/import \{[^}]*\} from '\.\/household\.js';/);
      expect(houseImport, `${file} must import from ./household.js`).toBeTruthy();
      // A per-dir Lambda zip cannot reach ../, so an import from anywhere but './' 502s at module
      // load — assert the module, not just the symbol.
      for (const n of needed) {
        const mod = LOADER_MODULE[n];
        expect(mod, `${n} has no LOADER_MODULE entry — add one`).toBeTruthy();
        const line = src.match(new RegExp(`import \\{[^}]*\\} from '${mod.replace('.', '\\.')}';`));
        expect(line, `${file} must import from ${mod}`).toBeTruthy();
        expect(line[0], `${file} imports ${n} from ${mod}`).toContain(n);
      }
      expect(houseImport[0], `${file} imports warnRejectedFk`).toContain('warnRejectedFk');
    }
  });

  // ── BUG-PARENTOWN-001 loader unit tests (layer 1 for the three new predicates) ──────────────────
  // The integration arms in tests/integration/authz-matrix.int.test.js only run in CI against an
  // ephemeral Neon branch. These run locally and pin the SQL shape, so a predicate regression is
  // caught before it costs a CI cycle.
  const UUID = '00000000-0000-4000-8000-000000000001';

  it('loadOwnedProject scopes plant_projects by created_by and excludes soft-deleted', async () => {
    const sql = fakeSql([{ id: UUID, name: 'Bed 1' }]);
    expect(await loadOwnedProject(sql, UUID, HOUSE)).toEqual({ id: UUID, name: 'Bed 1' });
    const t = textOf(sql);
    expect(t).toMatch(/FROM public\.plant_projects/i);   // base table, NOT the `container` view
    expect(t).toMatch(/deleted_at IS NULL/i);
    expect(t).toMatch(/created_by = ANY\(\?\)/);
    expect(sql.calls[0].values).toEqual([UUID, HOUSE]);
  });

  it('loadOwnedPlantingRef keeps the load-bearing `project_id IS NULL` conjunct', async () => {
    // Without it the own-created_by arm reaches a planting created INSIDE another household's
    // container — the exact row the plants by-id predicate exists to keep unreachable. This is the
    // one substantive difference from household.js loadOwnedPlanting, so assert it explicitly.
    const sql = fakeSql([{ id: UUID, name: 'Tomato' }]);
    expect(await loadOwnedPlantingRef(sql, UUID, HOUSE)).toEqual({ id: UUID, name: 'Tomato' });
    const t = textOf(sql);
    expect(t).toMatch(/FROM public\.plants/i);
    expect(t).toMatch(/gn\.project_id IS NULL AND gn\.created_by = ANY\(\?\)/);
    expect(sql.calls[0].values).toEqual([UUID, HOUSE, HOUSE]);
  });

  it('loadOwnedEvent guards the project-less arm with its own planting-ownership check', async () => {
    // event_log has a SECOND parent (plant_id) that the two ownership arms never inspect. Without
    // this the photos event_id gate is bypassable via a project-less event anchored to a foreign
    // planting. Scoped to the fallback arm only — see the loader comment for the measured reason.
    const sql = fakeSql([{ id: UUID }]);
    expect(await loadOwnedEvent(sql, UUID, HOUSE)).toEqual({ id: UUID });
    const t = textOf(sql);
    expect(t).toMatch(/FROM public\.event_log/i);
    expect(t).toMatch(/el\.plant_id IS NULL OR EXISTS/i);
    expect(sql.calls[0].values).toEqual([UUID, HOUSE, HOUSE, HOUSE, HOUSE]);
  });

  it('the new loaders reject a malformed id WITHOUT touching the database', async () => {
    // A 22P02 falling through to an opaque 500 is a worse contract and a weak side channel.
    for (const fn of [loadOwnedProject, loadOwnedPlantingRef, loadOwnedEvent]) {
      const sql = fakeSql([{ id: 'should-never-be-reached' }]);
      expect(await fn(sql, 'not-a-uuid', HOUSE)).toBeNull();
      expect(sql.calls, `${fn.name} must short-circuit before issuing SQL`).toHaveLength(0);
    }
  });

  it('the new loaders return null (no existence oracle) on a non-match', async () => {
    for (const fn of [loadOwnedProject, loadOwnedPlantingRef, loadOwnedEvent]) {
      expect(await fn(fakeSql([]), UUID, HOUSE)).toBeNull();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// V4-AUTHZRESIDUE-001 — the residue guards.
//
// The sweep above proves each ownership PREDICATE is right and each write SITE calls one. It could
// not see three whole-fleet invariants, which is how the residue survived it. Each block below is
// derived FROM DISK rather than from a hand-maintained list, so a newly added Lambda is covered the
// day it lands instead of the day someone remembers to add a row.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const lambdaDirs = () => readdirSync(here, { withFileTypes: true })
  .filter(e => e.isDirectory() && existsSync(join(here, e.name, 'index.js')))
  .map(e => e.name)
  .sort();

describe('V4-AUTHZRESIDUE-001: every household-scoped handler rejects an empty JWT subject', () => {
  // householdScope('') returns [''] and `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty sub is
  // a live ownership value that matches every row whose owner column is ''. verifyToken rejects such
  // a token first — this is the SECOND layer, and the whole point is that it stops being an
  // assumption about Clerk. Two of fifteen handlers carried it before this sweep.
  // Derived from the WHOLE dir, not index.js alone. lambda/dashboard is why: its index.js never
  // calls householdScope — it forwards userId to ./handlers.js, which scopes and interpolates
  // ${userId} into 19 query sites. An index.js-only scan reports dashboard as un-scoped and skips
  // it, which is precisely how it survived the first pass. A dir that ships a household.js copy is
  // household-scoped by construction, so that counts too.
  const scoped = lambdaDirs().filter(d =>
    existsSync(join(here, d, 'household.js')) ||
    readdirSync(join(here, d)).some(f => f.endsWith('.js') && !f.endsWith('.test.js') &&
      /householdScope\s*\(/.test(decomment(readFileSync(join(here, d, f), 'utf8')))));

  it('finds the household-scoped handler set (guards against an empty match)', () => {
    expect(scoped.length).toBeGreaterThanOrEqual(16);
    expect(scoped, 'dashboard scopes via handlers.js and must not be skipped').toContain('dashboard');
  });

  for (const d of scoped) {
    it(`${d}/index.js 401s an empty sub before deriving householdIds`, () => {
      const src = decomment(readFileSync(join(here, d, 'index.js'), 'utf8'));
      expect(src, `${d} must guard the empty sub`).toMatch(/if \(!userId\) return resp\(401/);
      // Ordering is the substance: a guard placed AFTER householdScope() has already let the empty
      // sub become an ownership array is decoration. Only assertable where the call is in this file
      // (dashboard's lives in handlers.js, reached strictly after this guard returns).
      const use = src.search(/householdScope\s*\(\s*userId\s*\)/);
      if (use !== -1) {
        expect(src.indexOf('if (!userId) return resp(401')).toBeLessThan(use);
      }
    });
  }
});

describe('V4-AUTHZRESIDUE-001: the malformed-id contract is 400 everywhere, never a leaked 500', () => {
  // A non-uuid reaching Postgres raises 22P02, which no handler maps, so it falls to the generic
  // `resp(500, 'Internal server error')`. That is both a worse client contract and a weak side
  // channel (500 = "not even a uuid", 400 = "valid uuid, but not yours"). Every ownership loader
  // must therefore short-circuit BEFORE issuing SQL.

  it('every exported household.js loader short-circuits a malformed id without touching the DB', async () => {
    for (const fn of [loadOwnedLocation, loadOwnedInventoryItem, loadOwnedSpace, loadOwnedPhoto]) {
      const sql = fakeSql([{ id: 'should-never-be-reached' }]);
      expect(await fn(sql, 'not-a-uuid', HOUSE), `${fn.name} must return null`).toBeNull();
      expect(sql.calls, `${fn.name} must short-circuit before issuing SQL`).toHaveLength(0);
    }
  });

  it('every module-private preservation loader carries the same pre-check', () => {
    // Not exported, so this arm is static. The regex pins the guard to the FIRST statement of each
    // loader — a guard placed after the await is no guard at all.
    // Floor lowered 4 -> 3 (consolidating sweep, 2026-08-10): preservation's module-private
    // loadOwnedPhoto was a byte-equivalent copy of the household.js export and now IMPORTS it
    // instead. That is a strictly stronger position — the shared one is covered by the real
    // behavioural test above rather than by this regex — but it means only three private loaders
    // (loadPlanting / loadStorageLocation / loadHarvestLog) remain to scan. The import itself is
    // asserted directly below so the swap cannot silently become "no gate at all".
    const src = decomment(readFileSync(join(here, 'preservation/index.js'), 'utf8'));
    const loaders = [...src.matchAll(/async function (load\w+)\(sql, (\w+), householdIds\) \{\s*([^\n]*)/g)];
    expect(loaders.length, 'preservation loader set should not be empty').toBeGreaterThanOrEqual(3);
    for (const [, name, arg, firstLine] of loaders) {
      expect(firstLine, `preservation ${name} must UUID-guard ${arg} first`)
        .toMatch(new RegExp(`if \\(!UUID_RE\\.test\\(String\\(${arg}\\)\\)\\) return null;`));
    }
  });

  it('preservation gets loadOwnedPhoto from the shared household.js export, not a private copy', () => {
    // BUG-AUTHZFKENUM-001 lifted this predicate into household.js once a second and third consumer
    // appeared, but preservation kept a private copy — "a third private copy is how dialects are
    // born". The copy is gone; assert the import that replaced it, and that no private redefinition
    // creeps back. A per-dir Lambda zip cannot reach ../, so the module must be './household.js'.
    const src = decomment(readFileSync(join(here, 'preservation/index.js'), 'utf8'));
    const line = src.match(/import \{[^}]*\} from '\.\/household\.js';/);
    expect(line, 'preservation must import from ./household.js').toBeTruthy();
    expect(line[0], 'preservation must import the SHARED loadOwnedPhoto').toContain('loadOwnedPhoto');
    expect(src, 'preservation must not redefine loadOwnedPhoto privately')
      .not.toMatch(/async function loadOwnedPhoto\s*\(/);
  });

  it('no ownership loader anywhere reaches SQL before a UUID guard', () => {
    // Whole-fleet sweep: any `load*(sql, x, householdIds)` in a canonical module must guard first.
    for (const file of ['household.js', 'authz-parents.js', 'preservation/index.js']) {
      const src = decomment(readFileSync(join(here, file), 'utf8'));
      for (const [, name, arg, firstLine] of src.matchAll(/async function (load\w+)\(sql, (\w+), householdIds\) \{\s*([^\n]*)/g)) {
        expect(firstLine, `${file}:${name} must UUID-guard ${arg} before any await`)
          .toMatch(/if \(!UUID_RE\.test\(String\(\w+\)\)\) return null;/);
      }
    }
  });
});

describe('V4-AUTHZRESIDUE-001: one planting predicate, not two dialects', () => {
  // household.js loadOwnedPlanting was the LOOSE outlier: `gn.created_by = ANY(h) OR pp.created_by
  // = ANY(h)`, whose bare own-created_by arm reaches a planting the caller created INSIDE another
  // household's container. It was reconciled to the strict form and then DELETED outright
  // (consolidating sweep, 2026-08-10) — it had zero callers and was byte-equivalent to
  // authz-parents.js loadOwnedPlantingRef, which is now the single planting predicate. The
  // "no loose two-arm planting predicate survives anywhere" test below is the standing guard.

  it('preservation gates EVERY body-settable FK, on BOTH verbs', () => {
    // photo_id was the miss: `preservation_log.photo_id REFERENCES photos(id)` (verified live) was
    // written verbatim from the body on PUT and POST while its three sibling FKs were all gated —
    // and projectRow() echoes photo_id back through all four GET routes, so it is a read surface,
    // not just a bad FK. Both verbs asserted, because gating one is the shape of the original bug.
    const src = decomment(readFileSync(join(here, 'preservation/index.js'), 'utf8'));
    for (const [field, loader] of [
      ['plant_id', 'loadPlanting'],
      ['storage_location_id', 'loadStorageLocation'],
      ['harvest_log_id', 'loadHarvestLog'],
      ['photo_id', 'loadOwnedPhoto'],
    ]) {
      const gates = [...src.matchAll(new RegExp(`${loader}\\(sql, body\\.${field}, householdIds\\)`, 'g'))];
      expect(gates.length, `preservation must gate body.${field} with ${loader} on BOTH verbs`)
        .toBeGreaterThanOrEqual(2);
    }
  });

  it('no loose two-arm planting predicate survives anywhere', () => {
    // The exact shape of the outlier. Matching it again means a dialect has been reintroduced.
    const LOOSE = /gn\.created_by = ANY\(\$\{householdIds\}\) OR pp\.created_by = ANY\(\$\{householdIds\}\)/;
    for (const file of ['household.js', 'authz-parents.js', 'preservation/index.js']) {
      expect(readFileSync(join(here, file), 'utf8'), `${file} reintroduced the loose planting predicate`)
        .not.toMatch(LOOSE);
    }
  });
});

describe('V4-AUTHZRESIDUE-001: no handler references an undeclared constant', () => {
  // THE GUARD THAT WAS MISSING. lambda/events/index.js shipped `AUTHZ_UUID_RE.test(...)` to prod
  // against a constant that exists nowhere in the repo — a ReferenceError that 500s the route. It
  // passed CI because eslint.config.js is a scoped design-token ruleset that never runs no-undef
  // over lambda/, and every events test is a static source-regex scan. A guard predicate that throws
  // is indistinguishable from no guard at all, so this belongs with the authz suite.
  const GLOBALS = new Set(['URL', 'URLSearchParams', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String',
    'Number', 'Boolean', 'Promise', 'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'RegExp', 'Buffer',
    'process', 'console', 'AbortController', 'TextEncoder', 'TextDecoder', 'Intl', 'NaN', 'Infinity',
    'AbortSignal', 'Blob', 'FormData', 'Headers', 'Request', 'Response', 'ReadableStream', 'Uint8Array',
    'BigInt', 'Symbol', 'WeakMap', 'WeakSet', 'Function', 'Reflect', 'Proxy', 'globalThis', 'structuredClone']);

  for (const d of lambdaDirs()) {
    it(`${d}/index.js declares every SCREAMING_CASE constant it uses`, () => {
      const src = readFileSync(join(here, d, 'index.js'), 'utf8');
      // Strip comments and string/template literals so prose and SQL text can't produce false hits.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
        .replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''")
        .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""');
      const declared = new Set();
      for (const re of [
        /(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})\b/g,   // local declaration
        /\b([A-Z][A-Z0-9_]{2,})\s*(?:,|\}|\sas\s|\sfrom\s)/g,           // named import / export list
        /\bas\s+([A-Z][A-Z0-9_]{2,})\b/g,                               // aliased import
      ]) for (const m of code.matchAll(re)) declared.add(m[1]);

      const used = new Set();
      // Only flag a bare SCREAMING_CASE identifier in VALUE position (property access, call, or
      // comparison) — never after a dot, and never a bare word inside an object literal key.
      for (const m of code.matchAll(/(^|[^.\w$'"])([A-Z][A-Z0-9_]{2,})\s*(?=[.(\[]|===|!==|\?\?)/g)) {
        used.add(m[2]);
      }
      const undeclared = [...used].filter(n => !declared.has(n) && !GLOBALS.has(n));
      expect(undeclared, `${d}/index.js uses undeclared constant(s): ${undeclared.join(', ')}`).toEqual([]);
    });
  }
});
