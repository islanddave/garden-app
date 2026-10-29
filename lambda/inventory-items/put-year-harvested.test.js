// BUG-SEEDYEARNOOP-001 — the inventory PUT and POST must NOT write lot_number: it is parked (no
// numbering scheme exists), and omission is what keeps it inert. The year_harvested write contract
// (assigned, presence-guarded, clearable by explicit null) is proven on real Postgres in
// tests/integration/inventory-items.int.test.js ("PUT year_harvested — presence guard ...").
//
// Static source inspection rather than import: lambda/inventory-items/index.js loads
// @neondatabase/serverless and @clerk/backend at module scope, so it cannot be imported under
// `npm ci` in CI. Same constraint and same approach as metadata-write.test.js and
// select-columns.test.js in this directory.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decommentSqlDashSpace, readHandlerSource } from '../_test-stubs/handlerSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct. The SET list carries a comment that
// discusses lot_number in prose, so without stripping comments the lot_number negative would fail
// against correct code. Identical helper to metadata-write.test.js:30.

const SRC = readHandlerSource('inventory-items', { decomment: decommentSqlDashSpace });

// The POST's INSERT and the PUT's UPDATE ... SET ... WHERE, isolated so a match in one arm can
// never satisfy an assertion about the other.
const INSERT = (SRC.match(/INSERT INTO inventory_items \(([\s\S]*?)\) RETURNING/) ?? [])[0] ?? '';
const UPDATE_SET = (SRC.match(/UPDATE inventory_items SET([\s\S]*?)WHERE/) ?? [])[1] ?? '';

describe('BUG-SEEDYEARNOOP-001 — inventory writes never name the parked lot_number', () => {
  it('isolates both SQL arms, so neither assertion is vacuous', () => {
    // Without this, a rename upstream turns every test below into a pass-by-empty-string.
    expect(INSERT).toMatch(/INSERT INTO inventory_items/);
    expect(INSERT.length).toBeGreaterThan(200);
    expect(UPDATE_SET).toMatch(/name\s*=/);
    expect(UPDATE_SET.length).toBeGreaterThan(200);
  });

  it('strips comments before matching — the guard must read SQL, not prose about SQL', () => {
    // The anti-vacuity check for the PARSER, not for the handler. The SET list's own comment block
    // names lot_number in prose, so if decomment ever stopped working the negatives below would go
    // red for the wrong reason.
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
