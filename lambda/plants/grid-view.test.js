// V4-PLANTSPAYLOAD-001 — GET /api/plants response SHAPE, both halves.
//
// The endpoint measured 1,241,902 B / 5.19 s on Dave's live prod session, so `?view=grid` projects
// it down to what the Garden grid actually reads. Two claims need guarding and they pull opposite
// ways: the grid shape must stay SMALL, and the default shape must not move AT ALL — ten other
// client call sites read the wide list and none of them opted in.
//
// Static-source, per the L-072 house style forced on this directory: index.js imports
// @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module load and NONE of those four are
// in node_modules (they are declared in lambda/plants/package.json and installed only by the deploy
// zip), so vite cannot even resolve the import graph — a runtime harness fails at collection, not
// at assertion time. Mocking does not help: vi.mock runs after vite's import analysis.
//
// What keeps it from being a regex that pins its own epitaph: the key sets asserted below are NOT
// written by hand against the source. Each branch's SELECT list is PARSED out of index.js and its
// output names computed (AS alias, else bare column), then the strip-and-substitute step the
// handler performs on every row (featured_photo_storage_path out, the two presigned URL keys in) is
// applied — and that step is itself asserted to still exist rather than assumed. The result is
// compared against a key set read off LIVE PROD, not invented: both were captured on 2026-08-17 by
// replaying the two branches verbatim against Neon (235 rows in scope). Edit a SELECT list and the
// derived set moves; the pinned set does not; the test reds.
//
// MUTATION-PROVEN (each applied to index.js, RED observed, reverted):
//   • delete `p.notes,` from the unscoped list SELECT -> "default response shape" RED (missing notes)
//   • add `gp.notes,` to the grid SELECT              -> "exactly the grid field set" RED (extra notes)
//   • drop `'crop_type_slug', pv.crop_type_slug` from the grid jsonb_build_object -> variety_ref RED
//   • delete the `const { featured_photo_storage_path: _ignore, ...rest }` strip -> RED on both

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct (the epitaph hazard this directory already
// documents). Same decommenter as its neighbours: the `//` arm is URL-safe, the `--` arm needs a
// following space so a JS decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// ── the parser ────────────────────────────────────────────────────────────────────────────────────
// Split a SELECT list on its TOP-LEVEL commas. Depth-aware because three projected columns are
// COALESCE / CASE / jsonb_build_object expressions whose own commas are not separators.
function splitTopLevel(list) {
  const out = [];
  let depth = 0, quoted = false, buf = '';
  for (const ch of list) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// The JSON keys a SELECT produces: its AS alias where there is one, else the bare column name.
function outputNames(sqlText) {
  const start = sqlText.search(/\bSELECT\b/);
  expect(start, 'no SELECT in the sliced template — the slice anchors have moved').toBeGreaterThan(-1);
  let depth = 0, quoted = false, end = -1;
  for (let i = start + 6; i < sqlText.length; i++) {
    const ch = sqlText[i];
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /\s/.test(ch) && /^FROM\s/i.test(sqlText.slice(i + 1, i + 6))) { end = i; break; }
  }
  expect(end, 'no top-level FROM found — the parser has rotted').toBeGreaterThan(-1);
  return splitTopLevel(sqlText.slice(start + 6, end)).map((expr) => {
    const e = expr.trim();
    const as = e.match(/\bAS\s+([a-z_][a-z0-9_]*)\s*$/i);
    if (as) return as[1];
    const bare = e.match(/([a-z_][a-z0-9_]*)\s*$/i);
    return bare ? bare[1] : e;
  });
}

// The literal keys declared inside a branch's variety_ref jsonb_build_object.
function varietyRefKeys(sqlText) {
  const at = sqlText.indexOf('jsonb_build_object');
  expect(at, 'branch has no variety_ref jsonb_build_object').toBeGreaterThan(-1);
  const body = sqlText.slice(at, sqlText.indexOf('END AS variety_ref', at));
  return [...body.matchAll(/'([a-z_][a-z0-9_]*)'\s*,/gi)].map((m) => m[1]);
}

// ── the three list branches, in source order ─────────────────────────────────────────────────────
// Bounded by the `view` binding and the shared enrichment below them, so nothing outside the GET
// list ternary can satisfy an assertion here.
const LIST = (() => {
  const a = SRC.indexOf('const view = event.queryStringParameters?.view');
  const b = SRC.indexOf('const enriched = await Promise.all', a);
  expect(a, 'list-branch start anchor not found').toBeGreaterThan(-1);
  expect(b, 'list-branch end anchor not found').toBeGreaterThan(a);
  return SRC.slice(a, b);
})();
const BRANCHES = [...LIST.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]);
const [GRID_SQL, SCOPED_SQL, UNSCOPED_SQL] = BRANCHES;

// The per-row transform every branch's rows pass through. Asserted, not assumed: if the strip or
// either substitution goes, the derived key sets below are wrong and this test would be lying.
function apiKeys(sqlText) {
  const names = outputNames(sqlText);
  expect(names, 'branch stopped selecting the hero storage path').toContain('featured_photo_storage_path');
  return [
    ...names.filter((n) => n !== 'featured_photo_storage_path'),
    'featured_photo_view_url',
    'featured_photo_thumb_url',
  ];
}

// Read off live prod 2026-08-17: json_object_keys of an unscoped-list row, minus the stripped
// storage path, plus the two substituted URL keys. 44 keys.
const DEFAULT_KEYS = [
  'id', 'name', 'quantity', 'status', 'notes', 'project_id', 'variety_id',
  'source_inventory_item_id', 'metadata', 'featured_photo_id', 'featured_is_explicit',
  'created_at', 'sown_at', 'sown_at_approx', 'germinated_at', 'germinated_at_approx',
  'transplanted_at', 'transplanted_at_approx', 'planted_out_at', 'planted_out_at_approx',
  'qty_initial', 'qty_current', 'qty_harvested', 'qty_lost', 'loss_cause',
  'source_type', 'source_ref', 'source_generation', 'parent_plant_id', 'divergence_type',
  'lineage_note', 'succession_group_id', 'succession_order', 'assignee_user_id',
  'container_type', 'container_size', 'location_id', 'acquired_mature', 'acquired_mature_source',
  'acquired_mature_set_at', 'project_name', 'variety_ref',
  'featured_photo_view_url', 'featured_photo_thumb_url',
];

// The Garden first-paint set, by property-access scan of src/pages/Garden.jsx +
// src/lib/projectTree.js + src/lib/caretakers.js + src/components/PlantingTile.jsx. Every entry has
// a named reader; nothing here is speculative:
//   id / name / quantity / status / project_id -> PlantingTile body + its stretched card Link
//   location_id            -> buildLocationGroupedList (the location facet)
//   assignee_user_id       -> effectiveAssignee (the caretaker lens and its badges)
//   featured_photo_id + _view_url + _thumb_url -> PlantingTile's PhotoView adapter: tier=THUMB,
//       degrading onto the original for the 6-of-230 heroes that have no thumb, so BOTH are read
//   variety_ref.name           -> the tile's variety line
//   variety_ref.crop_type_slug -> buildCropTypeGroupedList (the default facet)
// featured_is_explicit is the one entry with NO Garden reader. It is here because
// lambda/hero-read-derivation.test.js holds every hero-resolving read in the fleet to one contract
// and "this surface has no set-featured control" is not statically checkable, so the alternative was
// an exemption that rots. A boolean is the cheap side of that trade.
const GRID_KEYS = [
  'id', 'name', 'quantity', 'status', 'project_id', 'location_id', 'assignee_user_id',
  'featured_photo_id', 'featured_is_explicit', 'featured_photo_view_url', 'featured_photo_thumb_url',
  'variety_ref',
];

describe('GET /api/plants — the DEFAULT response shape is unchanged (V4-PLANTSPAYLOAD-001)', () => {
  // THE regression guard of this change. `?view=grid` is opt-in precisely so that Search,
  // PhotoLibrary, Favorites, ProjectDetail, Findings, CaptureFlow, EventNew, CatchUpBadge,
  // PlantingSelect, StorageDeadlineAlert and CareNeeded keep the shape they were written against.
  it('the unscoped list returns all 44 prod keys, and no others', () => {
    expect(apiKeys(UNSCOPED_SQL).sort()).toEqual([...DEFAULT_KEYS].sort());
  });

  it('the project-scoped list is untouched by the new param', () => {
    // The two default branches are key-for-key identical — the scoped one differs only in its
    // INNER JOIN and its container_id filter — and that equality is itself worth pinning.
    expect(apiKeys(SCOPED_SQL).sort()).toEqual([...DEFAULT_KEYS].sort());
  });

  it('both default branches still carry all 21 variety_ref subfields, prose included', () => {
    for (const [label, q] of [['unscoped', UNSCOPED_SQL], ['scoped', SCOPED_SQL]]) {
      const keys = varietyRefKeys(q);
      expect(keys, `${label} variety_ref subfield count changed`).toHaveLength(21);
      for (const k of ['care_notes', 'soil_notes', 'common_diseases', 'expected_yield_notes', 'growth_habit', 'source_url']) {
        expect(keys, `${label} variety_ref lost ${k} from the DEFAULT shape`).toContain(k);
      }
    }
  });

  it('the projection is opt-in: only the exact string "grid" selects it', () => {
    // Fail-open. A typo (?view=gird) must degrade to MORE data, never to a broken screen, and no
    // caller that omits the param can be routed into it.
    expect(LIST).toMatch(/const rows = view === 'grid'\n\s*\?/);
    expect(LIST).not.toMatch(/view\s*!==?\s*'grid'/);
    expect(LIST).not.toMatch(/view\s*\?\s*await sql/);
  });
});

describe('GET /api/plants?view=grid — exactly the grid field set (V4-PLANTSPAYLOAD-001)', () => {
  it('returns the 12 keys the Garden grid needs, and NOTHING else', () => {
    expect(apiKeys(GRID_SQL).sort()).toEqual([...GRID_KEYS].sort());
  });

  it('drops the wide-shape columns no tile can reach', () => {
    // Measured on prod: notes 14,121 B · created_at 10,792 B · variety_id 11,654 B ·
    // source_inventory_item_id 8,448 B (non-null on 29 of 235 rows). Named individually so the
    // assertion says what it protects instead of restating the set above.
    const keys = apiKeys(GRID_SQL);
    for (const k of ['notes', 'created_at', 'variety_id', 'source_inventory_item_id', 'project_name',
      'metadata', 'qty_initial', 'sown_at', 'container_type', 'notes']) {
      expect(keys, `grid projection leaked ${k}`).not.toContain(k);
    }
  });

  it('variety_ref carries exactly name + crop_type_slug — 2 of the 21 subfields', () => {
    // 43.4% of the DB body is variety_ref and 25.1% of it is the six prose fields, none of which is
    // reachable from a tile. This is the single largest term the projection removes.
    expect(varietyRefKeys(GRID_SQL).sort()).toEqual(['crop_type_slug', 'name']);
  });

  it('KEEPS both presigned photo URLs and strips the raw storage path', () => {
    // The URLs are the largest single term in the wire body and they STAY: the tile renders the
    // thumb and degrades onto the original when a thumb is missing, so dropping either is a blank
    // tile rather than a saving. The raw key must not ship — it is a bucket-internal path.
    const keys = apiKeys(GRID_SQL);
    expect(keys).toContain('featured_photo_view_url');
    expect(keys).toContain('featured_photo_thumb_url');
    expect(keys).not.toContain('featured_photo_storage_path');
    // The substitution the two keys above are derived from must still be the one the handler runs.
    const enrich = SRC.slice(SRC.indexOf('const enriched = await Promise.all'));
    expect(enrich.slice(0, 400)).toMatch(/featuredPhotoUrls\(row\.featured_photo_storage_path\)/);
    expect(enrich.slice(0, 400)).toMatch(/const \{ featured_photo_storage_path: _ignore, \.\.\.rest \} = row/);
    expect(enrich.slice(0, 400)).toMatch(/\{ \.\.\.rest, \.\.\.photoUrls \}/);
    const urls = SRC.slice(SRC.indexOf('async function featuredPhotoUrls'));
    expect(urls.slice(0, 900)).toMatch(/featured_photo_view_url, featured_photo_thumb_url/);
  });

  it('it is a real projection at the DB, not a JS key filter over the wide read', () => {
    // A JS filter would keep reading every column and save nothing the DB or the Lambda cares
    // about; only a narrower SELECT does.
    expect(GRID_SQL).toMatch(/FROM public\.garden_node gp/);
    expect(GRID_SQL).not.toMatch(/care_notes|expected_yield_notes|soil_notes/);
    expect(GRID_SQL).not.toMatch(/crop_types ct/);
  });

  it('keeps every ownership and soft-delete gate the wide list carries', () => {
    // A projection is still a read of other people's rows if it drops the predicates.
    expect(GRID_SQL).toMatch(/gp\.deleted_at IS NULL/);
    expect(GRID_SQL).toMatch(/gp\.archived_at IS NULL/);
    expect(GRID_SQL).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\) AND pp\.deleted_at IS NULL/);
    expect(GRID_SQL).toMatch(/gp\.container_id IS NULL AND gp\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(GRID_SQL).toMatch(/ph\.created_by = ANY\(\$\{householdIds\}\)/);
  });

  it('honours project_id under ?view=grid rather than silently ignoring it', () => {
    // Both casts are load-bearing, not decorative: an untyped NULL parameter is what Postgres
    // answers "could not determine data type of parameter" to.
    expect(GRID_SQL).toMatch(/\$\{projectId\}::uuid IS NULL OR gp\.container_id = \$\{projectId\}::uuid/);
  });

  it('preserves the list ORDER without shipping the column it sorts on', () => {
    expect(GRID_SQL).toMatch(/ORDER BY gp\.created_at DESC/);
    expect(apiKeys(GRID_SQL)).not.toContain('created_at');
  });
});
