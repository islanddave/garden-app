// V4-CROPTYPEALIAS-001 — the crop_types columns this handler's search predicates reference.
//
// WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE FROM select-columns.test.js: crop_types is a JOINED
// relation here, not the handler's own table. select-columns.test.js declares exactly one table by
// design, because the auditor's AUDIT_TABLES form cross-products every collected *COLUMNS array
// against every declared table — so adding crop_types there would assert the dashboard's own column
// list onto crop_types and invent failures. That cross-product is precisely why every JOINed
// relation in this repo was audited by NOTHING, which is how `p.name` on garden_node shipped a green
// audit and 500-ed every seed packet page (BUG-SEEDDETAIL500-001).
//
// This file uses the KEYED contract added 2026-08-28 (OPS-SCHEMAAUDITJOIN-001): AUDIT_COLUMNS binds
// each column array to ONE relation and does not cross-product, so a joined table can finally carry
// its own contract. scripts/dev-main-schema-audit.py discovers this file via the widened
// `*columns.test.js` glob and verifies every column below against prod's information_schema.
//
// The live risk it closes: search_aliases was added by migration v4-croptypealias-001 and is
// referenced by BOTH search predicates. A handler that SELECTs a column prod lacks 500s every
// request — and the search path has no other coverage that would notice.
//
// Static source inspection rather than import: index.js loads @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported under `npm ci` in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference — without this, the long explanatory
// comments above each predicate would satisfy the assertions on their own.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'handlers.js'), 'utf8'));

// L-081 KEYED contract. Verified present on public.crop_types in prod AND staging 2026-08-28,
// after migration v4-croptypealias-001 applied to both.
const AUDIT_COLUMNS = {
  crop_types: ['slug', 'display_name', 'search_aliases'],
};

const CROP_TYPE_COLUMNS = AUDIT_COLUMNS.crop_types;

describe('V4-CROPTYPEALIAS-001 — crop_types column contract for dashboard search', () => {
  it('still joins crop_types, so the assertions below are not vacuous', () => {
    expect(SRC).toMatch(/LEFT JOIN public\.crop_types ct ON ct\.slug =/);
    // Both search surfaces join it: plantings and varieties.
    expect(SRC.match(/LEFT JOIN public\.crop_types ct/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('references no crop_types column that is absent from the declared contract', () => {
    const referenced = [...SRC.matchAll(/\bct\.([a-z_][a-z0-9_]*)\b/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    const unknown = [...new Set(referenced)].filter((c) => !CROP_TYPE_COLUMNS.includes(c));
    expect(unknown).toEqual([]);
  });

  it('matches search_aliases on BOTH search surfaces, not just one', () => {
    // The bug this guards: adding the alias match to searchVarieties only would make q=cantaloupe
    // find the VARIETY but not the PLANTING, which reads as "search is flaky" rather than as a gap.
    const aliasMatches = SRC.match(/ct\.search_aliases ILIKE/g) ?? [];
    expect(aliasMatches.length).toBe(2);
  });

  it('keeps matching display_name — the alias column ADDS, it does not replace', () => {
    // 'Onion (bunching / scallion)' resolves q=scallion through display_name alone and has no
    // alias row; dropping the display_name predicate would silently break the 13 crops that
    // carry their alternate inside the displayed name.
    expect((SRC.match(/ct\.display_name ILIKE/g) ?? []).length).toBe(2);
  });

  it('never renders search_aliases — it is a search column only', () => {
    // display_name reaches the text of a public Facebook/Instagram post
    // (lambda/facebook-share/index.js:319). search_aliases must never be SELECTed into a response
    // shape, or the alias list becomes user-visible and eventually post-visible.
    expect(SRC).not.toMatch(/search_aliases\s+AS\s/i);
    expect(SRC).not.toMatch(/SELECT[^;]*?ct\.search_aliases[^;]*?FROM/is);
  });
});
