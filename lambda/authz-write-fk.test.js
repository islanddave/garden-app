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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOwnedLocation, loadOwnedInventoryItem, loadOwnedPlanting, loadOwnedSpace, warnRejectedFk } from './household.js';
import { loadOwnedProject, loadOwnedPlantingRef, loadOwnedEvent } from './authz-parents.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOUSE = ['user_a', 'user_b'];

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
      const row = await fn(sql, 'the-id', HOUSE);
      expect(row).toEqual({ id: 'x', name: 'n' });
      const t = textOf(sql);
      expect(t).toMatch(fromRe);
      expect(t).toMatch(ownerRe);
      // The id and the household array must both be BOUND parameters, never interpolated text.
      expect(sql.calls[0].values).toEqual(['the-id', HOUSE]);
    });

    it(`${name} returns null (no existence oracle) when nothing matches`, async () => {
      expect(await fn(fakeSql([]), 'the-id', HOUSE)).toBeNull();
    });

    it(`${name} ${expectsSoftDelete ? 'excludes' : 'does NOT reference'} soft-deleted rows`, async () => {
      const sql = fakeSql([]);
      await fn(sql, 'the-id', HOUSE);
      // spaces has NO deleted_at column (verified live, V-P2) — asserting one would 42703 in prod.
      if (expectsSoftDelete) expect(textOf(sql)).toMatch(/deleted_at IS NULL/i);
      else expect(textOf(sql)).not.toMatch(/deleted_at/i);
    });
  }

  it('loadOwnedPlanting accepts EITHER the node\'s owner or its container\'s', async () => {
    // Container-less plantings exist, and lambda/plants otherwise scopes through the container —
    // a container-only predicate would reject an owner's own projectless planting.
    const sql = fakeSql([{ id: 'p1', display_name: 'Tomato' }]);
    expect(await loadOwnedPlanting(sql, 'p1', HOUSE)).toEqual({ id: 'p1', display_name: 'Tomato' });
    const t = textOf(sql);
    expect(t).toMatch(/gn\.created_by = ANY\(\?\) OR pp\.created_by = ANY\(\?\)/);
    expect(t).toMatch(/gn\.deleted_at IS NULL/i);
    // Both branches still terminate in the household array — the OR widens WHICH column, not the scope.
    expect(sql.calls[0].values).toEqual(['p1', HOUSE, HOUSE]);
  });

  it('loadOwnedPlanting returns null for an out-of-household id', async () => {
    expect(await loadOwnedPlanting(fakeSql([]), 'p1', HOUSE)).toBeNull();
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
