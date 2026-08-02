// V4-SPACEPHOTO-001 — Space photos on the photos Lambda (static-source + executed-fragment guard).
//
// THE RISK THIS FILE EXISTS FOR (AC-5): when this code promoted, photos.space_id and
// spaces.featured_photo_id existed on the STAGING Neon branch only — prod did not have them. So the
// promote-safety invariant was not "the feature is off", it was the strictly stronger "with
// SPACE_PHOTOS_ENABLED unset, no statement this handler can emit NAMES either column" — a JS `if`
// inside a tagged template cannot satisfy that,
// because a neon template's SQL text is fixed at construction. The tests below prove the gating is
// done by SELECTING A DIFFERENT TEMPLATE, and prove it by EXECUTING the real functions against a
// recording fake `sql` rather than by reading the source and hoping.
//
// SCHEMA STATUS 2026-08-01: both columns are now APPLIED in prod (and staging), so the 42703 these
// tests originally guarded is no longer live. THE TESTS STILL EARN THEIR KEEP, and for a reason that
// outlives the migration: they are what makes SPACE_PHOTOS_ENABLED=false a genuine byte-identical
// rollback lever rather than a flag that merely returns early, and they are the executable statement
// of the pattern the next code-ahead-of-DDL column must follow. Do not delete them as "obsolete".
//
// index.js is not importable from repo root (its @aws-sdk/@clerk/@neondatabase deps are per-Lambda,
// not installed here), so the two functions under test are extracted verbatim from source and
// instantiated — the household-mode.test.js pattern, same executed code, zero deps. Route-level
// behaviour is covered by tests/integration/space-photos.int.test.js against real Postgres.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

function extractFunction(src, header) {
  const start = src.indexOf(header);
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function makeSql() {
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join('¶'), values });
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
}

// Real tagged templates only (mirrors lambda/sql-comment-hygiene.test.js extraction).
function sqlTemplates(src) {
  const out = [];
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

const buildSrc = extractFunction(SRC, 'function buildPhotoInsert');
const promoteSrc = extractFunction(SRC, 'async function autoPromoteFeatured');
const heroSrc = extractFunction(SRC, 'async function fetchSpaceHero');
const resolveSrc = extractFunction(SRC, 'async function resolveHouseholdSpace');
const instantiate = (fnSrc) => new Function(`return (${fnSrc});`)();

describe('V4-SPACEPHOTO-001 — flag-OFF inertness (AC-5)', () => {
  it('all four functions were extracted (guard for the extraction itself)', () => {
    expect(buildSrc).toBeTruthy();
    expect(promoteSrc).toBeTruthy();
    expect(heroSrc).toBeTruthy();
    expect(resolveSrc).toBeTruthy();
  });

  it('the INSERT emitted with the flag OFF names no space_id, even when the body carries one', async () => {
    const buildPhotoInsert = instantiate(buildSrc);
    const sql = makeSql();
    buildPhotoInsert(sql, { storage_path: 's3/x.jpg', space_id: 'space-1' }, 'user_dave', false);
    expect(sql.calls).toHaveLength(1);
    // The EMITTED text, not the source file — this is the assertion that prod cannot 42703.
    expect(sql.calls[0].text).not.toMatch(/space_id/);
    // ...and the caller's space_id is not even bound as a parameter.
    expect(sql.calls[0].values).not.toContain('space-1');
    // Still the pre-V4 statement in every other respect.
    expect(sql.calls[0].text).toMatch(/INSERT INTO photos/);
    expect(sql.calls[0].text).toMatch(/uploaded_by, created_by,/);
    expect(sql.calls[0].text).toMatch(/DO UPDATE SET updated_at = now\(\)\s*RETURNING/);
  });

  it('flag OFF binds exactly the pre-V4 parameter list, in the pre-V4 order', async () => {
    const buildPhotoInsert = instantiate(buildSrc);
    const off = makeSql();
    const on = makeSql();
    const body = {
      storage_path: 's3/x.jpg', caption: 'cap', project_id: 'proj-1', event_id: 'ev-1',
      location_id: 'loc-1', plant_id: 'pl-1', inventory_item_id: 'inv-1', space_id: 'space-1',
      taken_at: 't', content_hash: 'h', file_size_bytes: 1, mime_type: 'image/jpeg',
      original_filename: 'f.jpg', gps_lat: 1, gps_lon: 2, intake_status: null,
    };
    buildPhotoInsert(off, body, 'user_dave', false);
    buildPhotoInsert(on, body, 'user_dave', true);
    // The ONLY difference between the two variants is the space_id parameter. If a future edit
    // touches one template and not the other, this parity check reds.
    expect(on.calls[0].values.filter((v) => v !== 'space-1')).toEqual(off.calls[0].values);
    expect(off.calls[0].values).not.toContain('space-1');
  });

  it('the spaces auto-promote arm emits NOTHING when the flag is off', async () => {
    const autoPromoteFeatured = instantiate(promoteSrc);
    const sql = makeSql();
    await autoPromoteFeatured(sql, { id: 'photo-1', space_id: 'space-1' }, ['user_dave'], { spaceEnabled: false });
    expect(sql.calls).toHaveLength(0);
  });

  it('the spaces arm stays inert for a legacy 3-arg call (opts undefined)', async () => {
    // The PUT re-tag path still calls autoPromoteFeatured with three args; it cannot set space_id,
    // and an `opts?.` that threw or defaulted open would emit spaces SQL from that path.
    const autoPromoteFeatured = instantiate(promoteSrc);
    const sql = makeSql();
    await autoPromoteFeatured(sql, { id: 'photo-1', space_id: 'space-1' }, ['user_dave']);
    expect(sql.calls).toHaveLength(0);
  });

  it('the hero read constructs NO template when the flag is off', async () => {
    // fetchSpaceHero is shared by /space-hero and /space-hero/:spaceId. Its template names BOTH
    // prod-missing columns, so the guard lives inside the function (not only at the call sites) —
    // a future caller that forgets the outer `if` still cannot emit it.
    const fetchSpaceHero = instantiate(heroSrc);
    const sql = makeSql();
    expect(await fetchSpaceHero(sql, 'space-1', ['user_dave'], false)).toEqual([]);
    expect(sql.calls).toHaveLength(0);
  });

  it('the id-free space resolver emits nothing when the flag is off', async () => {
    const resolveHouseholdSpace = instantiate(resolveSrc);
    const sql = makeSql();
    expect(await resolveHouseholdSpace(sql, ['user_dave'], false)).toEqual([]);
    expect(sql.calls).toHaveLength(0);
  });

  it('the ?space_id gallery param is not even PARSED when the flag is off', () => {
    // Gating the BRANCH would leave the param live; gating the PARSE makes the branch unreachable
    // and keeps an unknown ?space_id ignored exactly as it is today.
    expect(SRC).toMatch(
      /const spaceId = spacePhotosEnabled \? \(event\.queryStringParameters\?\.space_id \?\? null\) : null;/,
    );
  });

  it('every space-touching surface is behind the flag (class-closing enumeration)', () => {
    const guards = [
      /const spacePhotosEnabled = process\.env\.SPACE_PHOTOS_ENABLED === 'true';/,
      /if \(spacePhotosEnabled && rawPath === '\/api\/photos\/space-hero' && method === 'GET'\)/,
      /if \(spacePhotosEnabled && spaceHeroMatch && method === 'GET'\)/,
      /if \(spacePhotosEnabled && spaceFeaturedMatch && method === 'PUT'\)/,
      /if \(spacePhotosEnabled && body\.space_id != null\)/,
      /buildPhotoInsert\(sql, body, userId, spacePhotosEnabled\)/,
      /autoPromoteFeatured\(sql, inserted, householdIds, \{ spaceEnabled: spacePhotosEnabled \}\)/,
      /opts\?\.spaceEnabled && photo\.space_id/,
      /resolveHouseholdSpace\(sql, householdIds, spacePhotosEnabled\)/,
      // PUT /api/photos/:id/space — the attach route (crucible 2026-08-02). Deliberately a separate
      // sub-resource rather than a widening of the general re-tag PUT: that route executes with the
      // gate CLOSED, so naming space_id in it would break flag-off byte-identity. This one cannot
      // execute flag-off at all.
      /if \(spacePhotosEnabled && photoSpaceMatch && method === 'PUT'\)/,
      // The list-decoration query. Same reasoning: the four list SELECTs stay byte-identical and the
      // single template that names space_id is constructed only when the gate is open.
      /if \(spacePhotosEnabled && rows\.length\)/,
      // V4-SPACECLIENTGAP-001 — the general PUT's setsParent pre-read. The general re-tag PUT has
      // full-replace semantics, so an all-null save is an "un-tag"; for a row whose surviving parent
      // is the SPACE that must still drain intake_status, or a space-attached photo re-tagged
      // through the modal falls back into the quick-tag carousel forever. The space_id lookup is a
      // SEPARATE gated SELECT rather than a widening of that route's UPDATE, precisely because that
      // UPDATE executes flag-off — naming space_id there would 42703 wherever the column is absent
      // and would break the byte-identical-rollback invariant. Costs one indexed PK lookup, flag-ON
      // only, on a route already performing a write.
      /if \(spacePhotosEnabled\) \{\s*const spaceRow = await sql`/,
    ];
    for (const g of guards) expect(SRC, `missing flag guard: ${g}`).toMatch(g);

    // Every fetchSpaceHero call site passes the flag through — the helper's own early return is the
    // backstop, but a call site that hardcoded `true` would defeat it.
    const heroCalls = SRC.match(/(?<!function )fetchSpaceHero\([^)]*\)/g) ?? [];
    expect(heroCalls.length, 'fetchSpaceHero call sites').toBe(2);
    for (const c of heroCalls) expect(c, `unflagged fetchSpaceHero call: ${c}`).toMatch(/, spacePhotosEnabled\)$/);

    // A NEW template naming space_id, or a new one touching the spaces table, raises these counts
    // and fails here — forcing whoever adds it to also add its guard above. Update the count only
    // together with a new entry in `guards`.
    const withSpaceId = sqlTemplates(SRC).filter((t) => /space_id/.test(t));
    // 6 -> 8 on 2026-08-02: the attach route's UPDATE and the list-decoration SELECT. Both are
    // constructed only inside a `spacePhotosEnabled &&` branch — see the two guards added above.
    // 8 -> 9 on 2026-08-02 (client flip): the general PUT's setsParent pre-read, likewise inside a
    // `spacePhotosEnabled` branch — see the guard added above.
    expect(withSpaceId, 'templates naming space_id').toHaveLength(9);
    const touchingSpaces = sqlTemplates(SRC).filter((t) => /\bspaces\b/.test(t));
    expect(touchingSpaces, 'templates touching the spaces table').toHaveLength(4);
  });
});

describe('V4-SPACEPHOTO-001 — flag-ON shapes', () => {
  it('the widened INSERT adds space_id and uses ADD-PARENT dedupe semantics (AC-4)', () => {
    const buildPhotoInsert = instantiate(buildSrc);
    const sql = makeSql();
    buildPhotoInsert(sql, { storage_path: 's3/x.jpg', space_id: 'space-1' }, 'user_dave', true);
    const { text, values } = sql.calls[0];
    expect(text).toMatch(/inventory_item_id, space_id,/);
    expect(values).toContain('space-1');
    // COALESCE, not a bare assignment: re-uploading bytes already attached to a space must not
    // silently re-point it, and a plain DO UPDATE SET updated_at would DROP the requested target.
    expect(text).toMatch(/DO UPDATE SET updated_at = now\(\),\s*space_id = COALESCE\(photos\.space_id, EXCLUDED\.space_id\)/);
  });

  it('the spaces promote arm mirrors its siblings but OMITS deleted_at (spaces has no such column)', async () => {
    const autoPromoteFeatured = instantiate(promoteSrc);
    const sql = makeSql();
    const householdIds = ['user_dave', 'user_jen'];
    await autoPromoteFeatured(sql, { id: 'photo-1', space_id: 'space-1' }, householdIds, { spaceEnabled: true });
    const spaceCalls = sql.calls.filter((c) => c.text.includes('UPDATE spaces'));
    expect(spaceCalls).toHaveLength(1);
    expect(spaceCalls[0].text).toMatch(/created_by = ANY\(/);
    expect(spaceCalls[0].text).toMatch(/featured_photo_id IS NULL/);
    // A deleted_at predicate here would 42703 into the swallowed catch and space photos would
    // SILENTLY never auto-feature — the failure mode this assertion exists to prevent.
    expect(spaceCalls[0].text).not.toMatch(/deleted_at/);
    expect(spaceCalls[0].values).toContainEqual(householdIds);
  });

  it('a space-only photo fires ONLY the spaces arm (no cross-arm writes)', async () => {
    const autoPromoteFeatured = instantiate(promoteSrc);
    const sql = makeSql();
    await autoPromoteFeatured(sql, { id: 'photo-2', space_id: 'space-9' }, ['user_dave'], { spaceEnabled: true });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain('UPDATE spaces');
  });

  it('the ?space_id gallery is an EXACT match — never the loc_subtree recursive walk', () => {
    const i = SRC.indexOf('} else if (spaceId) {');
    expect(i).toBeGreaterThan(-1);
    const block = SRC.slice(i, SRC.indexOf('} else {', i));
    expect(block).toMatch(/AND p\.space_id = \$\{spaceId\}/);
    // Reusing the ?location_id subtree walk here is the original bug: a Space gallery that also
    // shows every descendant LOCATION's photos.
    expect(block).not.toMatch(/loc_subtree/);
    expect(block).not.toMatch(/WITH RECURSIVE/);
    // Dropping this conjunct as "redundant" turns an unchecked attach into a cross-household read.
    expect(block).toMatch(/p\.created_by = ANY\(\$\{householdIds\}\)/);
    expect(block).toMatch(/p\.deleted_at IS NULL/);
  });

  it('set-featured validates linkage on created_by, never the stale uploaded_by', () => {
    const i = SRC.indexOf('const spaceFeaturedMatch');
    const block = SRC.slice(i, i + 1800);
    expect(block).toMatch(/loadOwnedSpace\(sql, spaceId, householdIds\)/);
    expect(block).toMatch(/AND space_id = \$\{spaceId\}/);
    expect(block).toMatch(/AND created_by = ANY\(\$\{householdIds\}\)/);
    expect(block).not.toMatch(/uploaded_by/);
    // No existence oracle: every rejection returns the same generic 400 body.
    expect(block).toMatch(/const REJECT = /);
    const rejects = block.match(/resp\(400, REJECT\)/g) ?? [];
    expect(rejects.length).toBeGreaterThanOrEqual(4);
  });

  it('the space-hero read filters deleted_at ON THE PHOTO and falls back (AC-6)', async () => {
    const fetchSpaceHero = instantiate(heroSrc);
    const sql = makeSql();
    const householdIds = ['user_dave', 'user_jen'];
    await fetchSpaceHero(sql, 'space-1', householdIds, true);
    expect(sql.calls).toHaveLength(1);
    const { text, values } = sql.calls[0];
    // ON DELETE SET NULL only fires on a HARD delete, so a soft-deleted hero leaves the FK intact
    // and pointing at a row the gallery no longer shows — presigning it yields a dead URL.
    expect(text).toMatch(/ON fp\.id = s\.featured_photo_id\s*¶?\s*AND fp\.deleted_at IS NULL/);
    expect(text).toMatch(/LEFT JOIN LATERAL/);
    expect(text).toMatch(/COALESCE\(fp\.id, fb\.id\) AS featured_photo_id/);
    expect(text).toMatch(/COALESCE\(fp\.storage_path, fb\.storage_path\)/);
    expect(text).toMatch(/s\.created_by = ANY\(/);
    expect(values).toContainEqual(householdIds);
    expect(values).toContain('space-1');
  });

  it('the hero reports explicit-vs-fallback so the client can tell a designation from a guess', async () => {
    // Without this the response is ambiguous, and the ambiguity had a real cost: the client's
    // set-featured control no-ops when the tapped id already equals featured_photo_id, so tapping
    // the photo that merely HAPPENS to be the fallback never persisted a designation and the hero
    // silently reverted on the next upload.
    const fetchSpaceHero = instantiate(heroSrc);
    const sql = makeSql();
    await fetchSpaceHero(sql, 'space-1', ['user_dave'], true);
    // Derived from the EXPLICIT join (fp), not from the COALESCEd effective id — a fallback hero
    // and a designated hero can be the same row, so only fp's presence distinguishes them.
    expect(sql.calls[0].text).toMatch(/\(fp\.id IS NOT NULL\) AS featured_is_explicit/);
  });

  it('the id-free resolver scopes on created_by and picks deterministically (discovery path)', async () => {
    const resolveHouseholdSpace = instantiate(resolveSrc);
    const sql = makeSql();
    const householdIds = ['user_dave', 'user_jen'];
    await resolveHouseholdSpace(sql, householdIds, true);
    expect(sql.calls).toHaveLength(1);
    const { text, values } = sql.calls[0];
    // Same ownership predicate as loadOwnedSpace and every other space route: resolving by any
    // wider rule (e.g. the de-facto garden_node.workspace_id link) could hand back a space that
    // PUT /space-featured then rejects as unowned.
    expect(text).toMatch(/FROM spaces/);
    expect(text).toMatch(/WHERE created_by = ANY\(/);
    expect(values).toContainEqual(householdIds);
    // Stable across calls: created_at never changes, id breaks a same-instant tie.
    expect(text).toMatch(/ORDER BY created_at ASC, id ASC/);
    expect(text).toMatch(/LIMIT 1/);
    // COUNT(*) OVER () is evaluated before LIMIT, so one round trip yields the pick AND the true
    // total — a household that grows a second space is visible instead of silently arbitrary.
    expect(text).toMatch(/COUNT\(\*\) OVER \(\) AS household_space_count/);
  });
});
