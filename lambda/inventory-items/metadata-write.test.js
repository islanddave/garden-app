// BUG-INVMETADROP-001 — the create path must PERSIST metadata, and the update path must NOT
// ASSIGN it. Two guards over one column, pulling in opposite directions on purpose.
//
// THE BUG: `metadata` was missing from the POST INSERT's column list while every caller already
// sent it (AddSeeds' buildRowPayload composes {sku, vendor, origin} per seed row;
// packetToInventoryPayload builds the same shape). Postgres does not object to a key an INSERT
// never names, so the endpoint returned 201 and the provenance was silently discarded — measured
// on prod 2026-08-28 by creating a row with metadata populated and reading metadata IS NULL back.
//
// THE INVERSE HAZARD, which is why the second guard exists: the PUT arm assigns every field
// unconditionally (`= ${body.x ?? null}`, no COALESCE), so a field the client omits is NULLED
// rather than preserved. `metadata` currently survives an edit ONLY because it is absent from that
// SET list. "Fixing" the PUT the same way the INSERT was fixed would erase provenance on every
// edit made through a form that does not round-trip it — and the richest metadata in the table
// belongs to the bulk-loaded seed rows, which no UI renders and therefore no UI would send back.
//
// Static source inspection rather than import: lambda/inventory-items/index.js loads
// @neondatabase/serverless and @clerk/backend at module scope, so it cannot be imported under
// `npm ci` in CI. Same constraint and same approach as select-columns.test.js in this directory.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A construct NAMED IN A COMMENT is not that construct. Load-bearing here beyond the usual reason:
// the PUT arm carries a long comment that quotes the very assignment the last test forbids, so
// without stripping comments that test would fail against correct code.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// The POST's INSERT ... VALUES ( ... ) and the PUT's UPDATE ... SET ... WHERE, isolated so a match
// in one arm can never satisfy an assertion about the other.
const INSERT = (SRC.match(/INSERT INTO inventory_items \(([\s\S]*?)\) RETURNING/) ?? [])[0] ?? '';
const UPDATE_SET = (SRC.match(/UPDATE inventory_items SET([\s\S]*?)WHERE/) ?? [])[1] ?? '';

describe('BUG-INVMETADROP-001 — inventory-items metadata write contract', () => {
  it('isolates both SQL arms, so neither assertion is vacuous', () => {
    // Without this, a rename upstream turns every test below into a pass-by-empty-string.
    expect(INSERT).toMatch(/INSERT INTO inventory_items/);
    expect(INSERT.length).toBeGreaterThan(200);
    expect(UPDATE_SET).toMatch(/name\s*=/);
    expect(UPDATE_SET.length).toBeGreaterThan(200);
  });

  it('the INSERT names metadata in its column list', () => {
    const columns = (INSERT.match(/INSERT INTO inventory_items \(([\s\S]*?)\)\s*VALUES/) ?? [])[1] ?? '';
    expect(columns).toMatch(/\bmetadata\b/);
  });

  it('binds metadata with an explicit ::jsonb cast', () => {
    // The driver cannot type a bound object, and a bare null needs the cast just as much —
    // the house pattern (lambda/events/index.js) is stringify + explicit cast at the call site.
    expect(INSERT).toMatch(/\$\{metadataJson\}::jsonb/);
    expect(SRC).toMatch(/const metadataJson\s*=\s*body\.metadata != null \? JSON\.stringify\(body\.metadata\) : null/);
  });

  it('validates metadata on create rather than leaving the DB CHECK to produce the error', () => {
    expect(SRC).toMatch(/export function validateMetadata\(/);
    expect(SRC).toMatch(/const merr = validateMetadata\(body\.metadata\)/);
    // Mirrors chk_inventory_metadata_size (octet_length < 8192), counted in BYTES not characters.
    expect(SRC).toMatch(/METADATA_MAX_BYTES\s*=\s*8192/);
    expect(SRC).toMatch(/Buffer\.byteLength\(/);
  });

  it('the PUT does NOT assign metadata — omission is what preserves it', () => {
    // The guard that matters most. Its failure mode is silent data loss, not an error, so it must
    // be pinned by a test rather than by the comment sitting above the SET list.
    expect(UPDATE_SET).not.toMatch(/\bmetadata\s*=/);
  });
});
