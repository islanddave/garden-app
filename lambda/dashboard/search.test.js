// V4-SEARCH-002 — server-side universal search unit tests (DB-free, mock sql
// recorder — same pattern as index.test.js). Imports ONLY handlers.js.
//
// Test inventory:
//   S1  classifyRoute: GET /api/search → search kind
//   S2  classifyRoute: POST /api/search → method-not-allowed
//   S3  classifyRoute: /api/searchx → not-found (no prefix shadowing)
//   S4  classifyRoute: existing routes unchanged (dashboard, inactive)
//   S5  normalizeSearchQuery: trim/collapse, min 2, max 64
//   S6  likeEscape: %, _, \ escaped (wildcard-injection guard)
//   S7  handleSearch: short/empty q → 400, no SQL fired
//   S8  table-driven builder invariants: household scope bind (except varieties),
//       deleted_at IS NULL, ESCAPE clause, LIMIT 20
//   S9  private_notes never referenced (predicate OR projection) in any builder
//   S10 handleSearch: all sections fulfilled → 200 with 7 keyed arrays
//   S11 handleSearch: one section rejects → 200, that section [], others intact
//   S12 handleSearch: wildcard query '%' binds escaped, not raw
//   S13 parent-liveness: plantings/events join container with deleted_at+archived_at filters

import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyRoute,
  normalizeSearchQuery,
  likeEscape,
  handleSearch,
  searchPlantings,
  searchProjects,
  searchLocations,
  searchVarieties,
  searchEvents,
  searchInventory,
  searchPhotos,
  SEARCH_SECTIONS,
} from './handlers.js';

const sqlCalls = [];
function makeSql({ rejectWhen = null } = {}) {
  return function sqlTag(strings, ...values) {
    let resolved = '';
    strings.forEach((s, i) => {
      resolved += s;
      if (i < values.length) resolved += `$${i + 1}`;
    });
    sqlCalls.push({ strings: Array.from(strings), values, resolved });
    if (rejectWhen && rejectWhen(resolved)) return Promise.reject(new Error('injected failure'));
    return Promise.resolve([]);
  };
}
beforeEach(() => { sqlCalls.length = 0; });

const USER = 'user_test_1';
const PAT = '%tomato%';
const PREFIX = 'tomato%';

describe('V4-SEARCH-002 routing (S1–S4)', () => {
  it('S1 GET /api/search → search', () => {
    expect(classifyRoute('GET', '/api/search')).toEqual({ kind: 'search' });
  });
  it('S2 POST /api/search → method-not-allowed', () => {
    expect(classifyRoute('POST', '/api/search').kind).toBe('method-not-allowed');
  });
  it('S3 /api/searchx → not-found', () => {
    expect(classifyRoute('GET', '/api/searchx').kind).toBe('not-found');
  });
  it('S4 existing routes unchanged', () => {
    expect(classifyRoute('GET', '/api/dashboard').kind).toBe('dashboard');
    expect(classifyRoute('GET', '/api/projects/inactive').kind).toBe('inactive-list');
    expect(classifyRoute('POST', '/api/dashboard').kind).toBe('method-not-allowed');
    expect(classifyRoute('GET', '/api/nope').kind).toBe('not-found');
  });
});

describe('query normalization + escaping (S5–S6)', () => {
  it('S5 normalizeSearchQuery', () => {
    expect(normalizeSearchQuery('  cherry   tomato  ')).toBe('cherry tomato');
    expect(normalizeSearchQuery('a')).toBe(null);
    expect(normalizeSearchQuery('')).toBe(null);
    expect(normalizeSearchQuery(null)).toBe(null);
    expect(normalizeSearchQuery('x'.repeat(65))).toBe(null);
    expect(normalizeSearchQuery('x'.repeat(64))).toBe('x'.repeat(64));
  });
  it('S6 likeEscape escapes LIKE metacharacters', () => {
    expect(likeEscape('100%')).toBe('100\\%');
    expect(likeEscape('a_b')).toBe('a\\_b');
    expect(likeEscape('a\\b')).toBe('a\\\\b');
    expect(likeEscape('plain')).toBe('plain');
  });
});

describe('handleSearch guards (S7, S12)', () => {
  it('S7 short q → 400, no SQL fired', async () => {
    const res = await handleSearch(makeSql(), USER, 'a');
    expect(res.statusCode).toBe(400);
    expect(sqlCalls.length).toBe(0);
    const res2 = await handleSearch(makeSql(), USER, undefined);
    expect(res2.statusCode).toBe(400);
  });
  it('S12 wildcard query binds escaped', async () => {
    await handleSearch(makeSql(), USER, '%%');
    const bound = sqlCalls.flatMap(c => c.values).filter(v => typeof v === 'string' && v.includes('%'));
    // every bound pattern must carry the escaped form \%\%, never raw %% between wildcards
    expect(bound.length).toBeGreaterThan(0);
    for (const v of bound) expect(v).toContain('\\%');
  });
});

// S8/S9/S13 — table-driven invariants over all 7 builders.
const BUILDERS = [
  { name: 'plantings', fn: sql => searchPlantings(sql, USER, PAT, PREFIX), scoped: true, parentJoin: true },
  { name: 'projects', fn: sql => searchProjects(sql, USER, PAT, PREFIX), scoped: true, parentJoin: false },
  { name: 'locations', fn: sql => searchLocations(sql, USER, PAT, PREFIX), scoped: true, parentJoin: false },
  { name: 'varieties', fn: sql => searchVarieties(sql, PAT, PREFIX), scoped: false, parentJoin: false },
  { name: 'events', fn: sql => searchEvents(sql, USER, PAT), scoped: true, parentJoin: true },
  { name: 'inventory', fn: sql => searchInventory(sql, USER, PAT, PREFIX), scoped: true, parentJoin: false },
  { name: 'photos', fn: sql => searchPhotos(sql, USER, PAT), scoped: false, parentJoin: false, ownScope: true },
];

describe('builder invariants (S8, S9, S13)', () => {
  for (const b of BUILDERS) {
    it(`S8 ${b.name}: scope, soft-delete, ESCAPE, LIMIT`, async () => {
      await b.fn(makeSql());
      const call = sqlCalls[sqlCalls.length - 1];
      const sql = call.resolved;
      if (b.scoped || b.ownScope) {
        expect(sql).toMatch(/created_by = ANY\(\$\d+\)/);
        expect(call.values.some(v => Array.isArray(v) && v.includes(USER))).toBe(true);
      } else {
        expect(sql).not.toMatch(/created_by = ANY/);
      }
      expect(sql).toMatch(/deleted_at IS NULL/);
      expect(sql).toMatch(/ESCAPE '\\'/);
      expect(sql).toMatch(/LIMIT 20/);
    });
    it(`S9 ${b.name}: private_notes never referenced`, async () => {
      await b.fn(makeSql());
      expect(sqlCalls[sqlCalls.length - 1].resolved).not.toMatch(/private_notes/);
    });
  }
  it('S13 plantings + events enforce parent container liveness', async () => {
    await searchPlantings(makeSql(), USER, PAT, PREFIX);
    let sql = sqlCalls[sqlCalls.length - 1].resolved;
    expect(sql).toMatch(/JOIN public\.container/);
    expect(sql).toMatch(/pp\.deleted_at IS NULL/);
    expect(sql).toMatch(/pp\.archived_at IS NULL/);
    await searchEvents(makeSql(), USER, PAT);
    sql = sqlCalls[sqlCalls.length - 1].resolved;
    expect(sql).toMatch(/JOIN public\.container/);
    expect(sql).toMatch(/pp\.deleted_at IS NULL/);
    expect(sql).toMatch(/pp\.archived_at IS NULL/);
  });
});

describe('handleSearch composition (S10–S11)', () => {
  it('S10 all sections fulfilled → 200 with 7 keyed arrays', async () => {
    const res = await handleSearch(makeSql(), USER, 'tomato');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.query).toBe('tomato');
    expect(Object.keys(body.results).sort()).toEqual([...SEARCH_SECTIONS].sort());
    for (const k of SEARCH_SECTIONS) expect(Array.isArray(body.results[k])).toBe(true);
  });
  it('S11 one section rejects → 200, that section [], others intact', async () => {
    const res = await handleSearch(makeSql({ rejectWhen: s => s.includes('FROM photos') }), USER, 'tomato');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results.photos).toEqual([]);
    expect(Object.keys(body.results).length).toBe(SEARCH_SECTIONS.length);
  });
});

// ── V4-SEARCHCROPTYPE-001 (BD-072) ────────────────────────────────────────────────────────────
// WHAT THESE CAN AND CANNOT PROVE. This suite is DB-free by design: `makeSql` records the resolved
// query text and returns []. So these assert the SHAPE of the query — that the joins exist and that
// crop type is bound into the predicate — and they cannot assert that a search for 'cucumber'
// returns Suyo Long. That was proved directly against prod Neon while building this, read-only:
//   • Suyo Long matched NONE of the five columns the variety search used before (display_name,
//     species, genus, care_notes, soil_notes) for q='cucumber', and appears with the new terms.
//   • q='scallion' now returns Tokyo Long White, which carries that word in no column of its own —
//     it is reachable ONLY through crop_types.display_name ("Onion (bunching / scallion)"), which
//     is why matching the slug alone would not have been enough.
//   • Live plantings matching 'cucumber' went 0 -> 1.
// Anyone tightening these should re-run those three against prod rather than trusting the shapes.
describe('V4-SEARCHCROPTYPE-001 — crop type is a match axis (BD-072)', () => {
  it('varieties match the crop-type slug AND the crop type display name', async () => {
    await searchVarieties(makeSql(), PAT, PREFIX);
    const sql = sqlCalls[sqlCalls.length - 1].resolved;
    expect(sql).toMatch(/LEFT JOIN public\.crop_types ct ON ct\.slug = c\.crop_type_slug/);
    expect(sql).toMatch(/c\.crop_type_slug ILIKE/);
    // The display-name term is the load-bearing half — slug-only misses "scallion" and "corn salad".
    expect(sql).toMatch(/ct\.display_name ILIKE/);
  });

  it('plantings reach crop type over two joins, and match the cultivar name too', async () => {
    await searchPlantings(makeSql(), USER, PAT, PREFIX);
    const sql = sqlCalls[sqlCalls.length - 1].resolved;
    expect(sql).toMatch(/LEFT JOIN public\.cultivar cv ON cv\.id = p\.cultivar_id/);
    expect(sql).toMatch(/LEFT JOIN public\.crop_types ct ON ct\.slug = cv\.crop_type_slug/);
    expect(sql).toMatch(/cv\.display_name ILIKE/);
    expect(sql).toMatch(/cv\.crop_type_slug ILIKE/);
    expect(sql).toMatch(/ct\.display_name ILIKE/);
  });

  // V4-CROPTYPEALIAS-001 — the alias axis, which is what finally answers the sentence this whole
  // feature was built from: "I know it is a cantaloupe." Charentais sits under crop type 'melon',
  // display 'Melon', and no crop type anywhere is named cantaloupe, so display-name matching could
  // never reach it. Measured per-column on prod 2026-08-28: q=cantaloupe matched 2 of the 4 melon
  // varieties — 'Cantaloupe' by its own name and 'Green Flesh' only through care/soil PROSE — and
  // missed Charentais and Minnesota Mini. Partial and prose-dependent, not empty.
  it('matches the crop-type alias column on BOTH search surfaces', async () => {
    for (const build of [() => searchVarieties(makeSql(), PAT, PREFIX),
                         () => searchPlantings(makeSql(), USER, PAT, PREFIX)]) {
      await build();
      const sql = sqlCalls[sqlCalls.length - 1].resolved;
      expect(sql).toMatch(/ct\.search_aliases ILIKE/);
      // ADDS, never replaces: the 13 crops carrying their alternate inside the display name
      // ('Onion (bunching / scallion)') have no alias row and resolve through display_name alone.
      expect(sql).toMatch(/ct\.display_name ILIKE/);
    }
  });

  // Alias text must never leave the database. display_name is SELECTed as crop_name by
  // lambda/facebook-share/index.js:319 and reaches the text of a public Facebook/Instagram post;
  // that is the entire reason this is a separate column rather than more parentheticals, and it
  // only holds while search_aliases stays out of every response shape.
  it('never selects the alias column into a response', async () => {
    for (const build of [() => searchVarieties(makeSql(), PAT, PREFIX),
                         () => searchPlantings(makeSql(), USER, PAT, PREFIX)]) {
      await build();
      const sql = sqlCalls[sqlCalls.length - 1].resolved;
      expect(sql).not.toMatch(/search_aliases\s+AS\s/i);
      expect(sql.slice(0, sql.search(/\bFROM\b/i))).not.toMatch(/search_aliases/i);
    }
  });

  // LEFT, not INNER. An inner join would silently DROP every planting with no cultivar_id and every
  // cultivar with a null or dangling crop_type_slug — turning a search improvement into a search
  // regression for rows that already matched on their own name.
  it('uses LEFT joins so rows without a cultivar or crop type do not vanish', async () => {
    for (const build of [() => searchVarieties(makeSql(), PAT, PREFIX),
                         () => searchPlantings(makeSql(), USER, PAT, PREFIX)]) {
      await build();
      const sql = sqlCalls[sqlCalls.length - 1].resolved;
      expect(sql).not.toMatch(/(?<!LEFT )JOIN public\.crop_types/);
      expect(sql).not.toMatch(/(?<!LEFT )JOIN public\.cultivar/);
    }
  });

  // Every new term must carry ESCAPE, or a query containing % or _ wildcards past the new columns
  // — exactly what likeEscape and S12 exist to prevent on the original terms.
  it('every new ILIKE term carries the ESCAPE clause', async () => {
    for (const build of [() => searchVarieties(makeSql(), PAT, PREFIX),
                         () => searchPlantings(makeSql(), USER, PAT, PREFIX)]) {
      await build();
      const sql = sqlCalls[sqlCalls.length - 1].resolved;
      // Backslash-agnostic on purpose: the resolved text carries ESCAPE '\' with a single
      // backslash, and hard-coding the count made this assert the wrong thing rather than the
      // right thing — it reported every term as unescaped.
      const ilikes = sql.match(/ILIKE \$\d+(?: ESCAPE '[^']*')?/g) ?? [];
      expect(ilikes.length).toBeGreaterThan(0);
      for (const t of ilikes) expect(t, `unescaped ILIKE in: ${sql}`).toMatch(/ESCAPE/);
    }
  });
});
