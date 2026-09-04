// BUG-SEEDYEARNOOP-001 — the inventory PUT must ASSIGN year_harvested, and must assign it with the
// explicit-presence guard rather than a bare assignment. Two requirements over one column that pull
// in opposite directions, which is why both are pinned here.
//
// THE BUG: V5-SEEDYEARHARVESTED-001 shipped a writer with no write. SavedSeeds.jsx:393-398 builds
// { year_harvested } and :746-756 spreads it into this PUT's body, but the UPDATE's SET list never
// named the column. Postgres does not object to a key a statement never mentions, so the route
// answered 200 and the year was silently discarded — the user set a harvest year, saw success, and
// stored nothing. Repo-wide grep at the time: year_harvested appeared only in SavedSeeds.jsx and
// three src/__tests__ files, with zero matches in lambda/ and zero across 133 migration dirs.
//
// THE INVERSE HAZARD, which is why the second guard exists and matters more: 23 of the columns in
// this SET list are BARE assignments (= body.x ?? null, no COALESCE), so a key the client omits is
// NULLED rather than preserved. Only 4 of 510 rows carry a year_harvested and every one of them is
// irreplaceable — Hopi Black Dye Sunflower 2025 (whose year exists structurally in that column
// ONLY; its metadata carries no year key at all), Jen's Edelweiss 1986 from Austria, Red Mustard
// 2026, Common Milkweed 2022. "Finishing the job" with a bare assignment would erase all four.
//
// It would also LOOK correct in manual testing. useInventory.js:121-122 merges the cached list row
// into the body, and that row came from SELECT i.*, so on ordinary navigation the value round-trips
// and survives. Only the deep-link path — list never loaded, body is buildChanges() alone, which
// does not send this key — nulls them. That is the same latent shape InventoryDetail.jsx:164
// documents for the type column, and it is why this is a source-text guard rather than a behavioural
// test: no existing test in this directory would catch it. select-columns.test.js is forward-only by
// construction and cannot flag a prod column the handler never mentions.
//
// Static source inspection rather than import: lambda/inventory-items/index.js loads
// @neondatabase/serverless and @clerk/backend at module scope, so it cannot be imported under
// `npm ci` in CI. Same constraint and same approach as metadata-write.test.js and
// select-columns.test.js in this directory.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct — and here that is load-bearing in both
// directions. The SET list carries a long comment that discusses year_harvested and lot_number in
// prose, so without stripping comments the positive assertions below would pass on the COMMENT
// while the column stayed unassigned, and the lot_number negative would fail against correct code.
// Identical helper to metadata-write.test.js:30.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// The POST's INSERT and the PUT's UPDATE ... SET ... WHERE, isolated so a match in one arm can
// never satisfy an assertion about the other.
const INSERT = (SRC.match(/INSERT INTO inventory_items \(([\s\S]*?)\) RETURNING/) ?? [])[0] ?? '';
const UPDATE_SET = (SRC.match(/UPDATE inventory_items SET([\s\S]*?)WHERE/) ?? [])[1] ?? '';

describe('BUG-SEEDYEARNOOP-001 — inventory PUT year_harvested write contract', () => {
  it('isolates both SQL arms, so neither assertion is vacuous', () => {
    // Without this, a rename upstream turns every test below into a pass-by-empty-string.
    expect(INSERT).toMatch(/INSERT INTO inventory_items/);
    expect(INSERT.length).toBeGreaterThan(200);
    expect(UPDATE_SET).toMatch(/name\s*=/);
    expect(UPDATE_SET.length).toBeGreaterThan(200);
  });

  it('strips comments before matching — the guard must read SQL, not prose about SQL', () => {
    // The anti-vacuity check for the PARSER, not for the handler. The SET list's own comment block
    // discusses both columns in prose, including the exact bare-assignment shape the test below
    // forbids, so if decomment ever stopped working every assertion here would go green — or red —
    // for the wrong reason.
    //
    // Self-locating rather than pinned to a literal phrase: take a real `--` comment out of the RAW
    // update arm and assert its text is gone from the decommented one. Rewording the comment cannot
    // break this, which a hardcoded sentinel string would.
    const RAW_SET = (readFileSync(resolve(__dirname, 'index.js'), 'utf8')
      .match(/UPDATE inventory_items SET([\s\S]*?)WHERE/) ?? [])[1] ?? '';
    const commentLines = RAW_SET.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-- ') && l.length > 40);
    // If the SET list ever carries no comments this test must fail loudly rather than pass empty.
    expect(commentLines.length).toBeGreaterThan(0);
    for (const line of commentLines) {
      expect(UPDATE_SET).not.toContain(line.slice(3));
    }
  });

  it('the PUT ASSIGNS year_harvested — the no-op this item exists to fix', () => {
    expect(UPDATE_SET).toMatch(/\byear_harvested\s*=/);
  });

  it('assigns it with the explicit-presence guard, NEVER a bare assignment', () => {
    // The guard that matters most; its failure mode is silent loss of four irreplaceable values,
    // not an error. The CASE form preserves the column when the client does not mention the key.
    expect(UPDATE_SET).toMatch(/year_harvested\s*=\s*CASE/);
    expect(UPDATE_SET).toMatch(/ELSE\s+year_harvested\s*\n?\s*END/);
    // The destroyer, stated as the exact shape it would take. This is the whole test.
    expect(UPDATE_SET).not.toMatch(/year_harvested\s*=\s*\$\{\s*body\./);
  });

  it('tests PRESENCE, not truthiness, so an explicit null can clear the year', () => {
    // hasOwnProperty rather than != null: a year entered by mistake must be removable. The same
    // reasoning as seed_stage (index.js:786-789) and source_id, which use this idiom already.
    expect(SRC).toMatch(
      /const hasYearHarvested\s*=\s*Object\.prototype\.hasOwnProperty\.call\(body,\s*'year_harvested'\)/,
    );
    expect(UPDATE_SET).toMatch(/WHEN\s+\$\{hasYearHarvested\}/);
  });

  it('does NOT assign lot_number — it is parked, and omission is what keeps it inert', () => {
    // lot_number is NULL on all 510 prod rows with no reader, writer, migration, index, constraint,
    // view or RLS reference. It is deliberately not wired: a lot-numbering scheme does not exist,
    // and inventing one inside a bug fix would be the "columns that look like they work" failure
    // this ledger row objects to. Pinned so a future session cannot half-wire it by reflex.
    expect(UPDATE_SET).not.toMatch(/\blot_number\s*=/);
  });

  it('does NOT create rows with a lot_number either', () => {
    const columns = (INSERT.match(/INSERT INTO inventory_items \(([\s\S]*?)\)\s*VALUES/) ?? [])[1] ?? '';
    expect(columns).not.toMatch(/\blot_number\b/);
  });
});
