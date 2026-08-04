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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOwnedLocation, loadOwnedInventoryItem, loadOwnedPlanting, loadOwnedSpace, warnRejectedFk } from './household.js';
import { loadOwnedProject, loadOwnedPlantingRef, loadOwnedEvent } from './authz-parents.js';

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
const textOf = (sql) => sql.calls[0].text.replace(/\s+/g, ' ');

describe('V4-AUTHZSWEEP-001: ownership loaders bind the correct owner column', () => {
  const CASES = [
    ['loadOwnedLocation', loadOwnedLocation, 'locations', /FROM locations/i, /created_by = ANY\(\?\)/, true],
    ['loadOwnedInventoryItem', loadOwnedInventoryItem, 'inventory_items', /FROM inventory_items/i, /created_by = ANY\(\?\)/, true],
    ['loadOwnedSpace', loadOwnedSpace, 'spaces', /FROM spaces/i, /created_by = ANY\(\?\)/, false],
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

  it('loadOwnedPlanting scopes through the container, or the node itself when it has none', async () => {
    // V4-AUTHZRESIDUE-001: was `gn.created_by = ANY(h) OR pp.created_by = ANY(h)` — the bare
    // own-created_by arm reached a planting the caller created INSIDE another household's container.
    // Container-less plantings still resolve, via the `project_id IS NULL` arm: narrowed, not removed.
    const PID = '00000000-0000-4000-8000-000000000001';
    const sql = fakeSql([{ id: PID, name: 'Tomato' }]);
    expect(await loadOwnedPlanting(sql, PID, HOUSE)).toEqual({ id: PID, name: 'Tomato' });
    const t = textOf(sql);
    expect(t).toMatch(/pp\.created_by = ANY\(\?\)/);
    expect(t).toMatch(/gn\.project_id IS NULL AND gn\.created_by = ANY\(\?\)/);
    expect(t).toMatch(/gn\.deleted_at IS NULL/i);
    // Both branches still terminate in the household array.
    expect(sql.calls[0].values).toEqual([PID, HOUSE, HOUSE]);
  });

  it('loadOwnedPlanting returns null for an out-of-household id', async () => {
    // A well-formed uuid, so this exercises the PREDICATE rather than the UUID short-circuit.
    expect(await loadOwnedPlanting(fakeSql([]), '00000000-0000-4000-8000-000000000001', HOUSE)).toBeNull();
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
const SITES = [
  ['plants/index.js', 'location_id', 'loadOwnedLocation'],
  ['plants/index.js', 'parent_plant_id', 'loadOwnedPlantingRef'],
  ['plants/index.js', 'source_inventory_item_id', 'loadOwnedInventoryItem'],
  ['inventory-items/index.js', 'location_id', 'loadOwnedLocation'],
  ['projects/index.js', 'location_id', 'loadOwnedLocation'],
  // V4-SPACEPHOTO-001: photos.space_id is attachable from the POST body, and the ?space_id gallery
  // reads back by it — an ungated attach is a live cross-household READ, not just a bad FK.
  ['photos/index.js', 'space_id', 'loadOwnedSpace'],
  // BUG-PARENTOWN-001 — the PARENT-id half of the same class, and the reason this table is the
  // enforcement mechanism rather than documentation: the V4-AUTHZSWEEP-001 pass gated the three
  // plants PUT columns above and left every POST column, the whole photos parent set, and
  // succession_group_id (settable on BOTH verbs) out of the table entirely, so nothing failed when
  // they stayed open. Adding a row here is now part of adding a body-settable FK.
  ['plants/index.js', 'project_id', 'loadOwnedProject'],
  ['plants/index.js', 'succession_group_id', 'loadOwnedPlantingRef'],
  ['photos/index.js', 'project_id', 'loadOwnedProject'],
  ['photos/index.js', 'plant_id', 'loadOwnedPlantingRef'],
  ['photos/index.js', 'event_id', 'loadOwnedEvent'],
  ['photos/index.js', 'location_id', 'loadOwnedLocation'],
  ['photos/index.js', 'inventory_item_id', 'loadOwnedInventoryItem'],
];
// Which module each loader is imported from. Two homes today; authz-parents.js is a temporary one
// (see its header) and collapses into household.js in the consolidating sweep — at which point this
// map goes away rather than growing a third entry.
const LOADER_MODULE = {
  loadOwnedLocation: './household.js',
  loadOwnedInventoryItem: './household.js',
  loadOwnedPlanting: './household.js',
  loadOwnedSpace: './household.js',
  loadOwnedProject: './authz-parents.js',
  loadOwnedPlantingRef: './authz-parents.js',
  loadOwnedEvent: './authz-parents.js',
};

describe('V4-AUTHZSWEEP-001: every settable cross-entity FK write site invokes a loader', () => {
  for (const [file, field, loader] of SITES) {
    it(`${file} gates body.${field} with ${loader}`, () => {
      const src = readFileSync(join(here, file), 'utf8').replace(/\s+/g, ' ');
      expect(src).toMatch(new RegExp(`if \\(.*body\\.${field} != null\\).*?${loader}\\(sql, body\\.${field},`));
    });
  }

  it('projects create gates parent_project_id against container.created_by', () => {
    // Not a shared loader (container is the projects handler's own row type), so assert the inline
    // predicate instead: the create path could otherwise birth a project inside another household's tree.
    const src = readFileSync(join(here, 'projects/index.js'), 'utf8').replace(/\s+/g, ' ');
    expect(src).toMatch(/body\.parent_project_id != null.*?FROM public\.container.*?created_by = ANY\(\$\{householdIds\}\).*?deleted_at IS NULL/);
  });

  it('locations featured-photo check anchors on created_by, not the stale uploaded_by', () => {
    // photos carries both columns; every other featured-photo validator uses created_by. This was
    // the one divergent surface (V-C1).
    const src = readFileSync(join(here, 'locations/index.js'), 'utf8');
    expect(src).not.toMatch(/uploaded_by = ANY/);
  });

  it('each gated handler imports the loaders it uses, from the right module', () => {
    for (const file of [...new Set(SITES.map(s => s[0]))]) {
      const src = readFileSync(join(here, file), 'utf8');
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
      /householdScope\s*\(/.test(readFileSync(join(here, d, f), 'utf8'))));

  it('finds the household-scoped handler set (guards against an empty match)', () => {
    expect(scoped.length).toBeGreaterThanOrEqual(16);
    expect(scoped, 'dashboard scopes via handlers.js and must not be skipped').toContain('dashboard');
  });

  for (const d of scoped) {
    it(`${d}/index.js 401s an empty sub before deriving householdIds`, () => {
      const src = readFileSync(join(here, d, 'index.js'), 'utf8');
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
    for (const fn of [loadOwnedLocation, loadOwnedInventoryItem, loadOwnedPlanting, loadOwnedSpace]) {
      const sql = fakeSql([{ id: 'should-never-be-reached' }]);
      expect(await fn(sql, 'not-a-uuid', HOUSE), `${fn.name} must return null`).toBeNull();
      expect(sql.calls, `${fn.name} must short-circuit before issuing SQL`).toHaveLength(0);
    }
  });

  it('every module-private preservation loader carries the same pre-check', () => {
    // Not exported, so this arm is static. The regex pins the guard to the FIRST statement of each
    // loader — a guard placed after the await is no guard at all.
    const src = readFileSync(join(here, 'preservation/index.js'), 'utf8');
    const loaders = [...src.matchAll(/async function (load\w+)\(sql, (\w+), householdIds\) \{\s*([^\n]*)/g)];
    expect(loaders.length, 'preservation loader set should not be empty').toBeGreaterThanOrEqual(4);
    for (const [, name, arg, firstLine] of loaders) {
      expect(firstLine, `preservation ${name} must UUID-guard ${arg} first`)
        .toMatch(new RegExp(`if \\(!UUID_RE\\.test\\(String\\(${arg}\\)\\)\\) return null;`));
    }
  });

  it('no ownership loader anywhere reaches SQL before a UUID guard', () => {
    // Whole-fleet sweep: any `load*(sql, x, householdIds)` in a canonical module must guard first.
    for (const file of ['household.js', 'authz-parents.js', 'preservation/index.js']) {
      const src = readFileSync(join(here, file), 'utf8');
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
  // household's container. It is now the strict form. It also has ZERO callers — see its comment;
  // the consolidating sweep should delete it rather than keep two identical predicates.
  it('household.js loadOwnedPlanting carries the load-bearing project_id IS NULL conjunct', async () => {
    const sql = fakeSql([{ id: ID, name: 'Tomato' }]);
    await loadOwnedPlanting(sql, ID, HOUSE);
    expect(textOf(sql)).toMatch(/gn\.project_id IS NULL AND gn\.created_by = ANY\(\?\)/);
  });

  it('preservation gates EVERY body-settable FK, on BOTH verbs', () => {
    // photo_id was the miss: `preservation_log.photo_id REFERENCES photos(id)` (verified live) was
    // written verbatim from the body on PUT and POST while its three sibling FKs were all gated —
    // and projectRow() echoes photo_id back through all four GET routes, so it is a read surface,
    // not just a bad FK. Both verbs asserted, because gating one is the shape of the original bug.
    const src = readFileSync(join(here, 'preservation/index.js'), 'utf8');
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
