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
  ['plants/index.js', 'parent_plant_id', 'loadOwnedPlanting'],
  ['plants/index.js', 'source_inventory_item_id', 'loadOwnedInventoryItem'],
  ['inventory-items/index.js', 'location_id', 'loadOwnedLocation'],
  ['projects/index.js', 'location_id', 'loadOwnedLocation'],
];

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

  it('each gated handler imports the loaders it uses', () => {
    for (const file of [...new Set(SITES.map(s => s[0]))]) {
      const src = readFileSync(join(here, file), 'utf8');
      const needed = SITES.filter(s => s[0] === file).map(s => s[2]);
      const importLine = src.match(/import \{[^}]*\} from '\.\/household\.js';/);
      expect(importLine, `${file} must import from ./household.js`).toBeTruthy();
      for (const n of needed) expect(importLine[0], `${file} imports ${n}`).toContain(n);
      expect(importLine[0], `${file} imports warnRejectedFk`).toContain('warnRejectedFk');
    }
  });
});
