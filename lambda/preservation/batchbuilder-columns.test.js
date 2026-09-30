// V5-BATCHBUILDER-001 (Put-Up B′ release 3) — the pantry_item columns lambda/preservation reads, and the
// one kitchen_batch_input column release 3's line routes write (pantry_item_id).
//
// WHY A SEPARATE FILE: the same reason every sibling contract gives — parse_test_file returns on the keyed
// AUDIT_COLUMNS form first, so a keyed block dropped into another contract file destroys its coverage, and
// Phase 4 credits a contract only to the handler's own directory. Two declarations of one relation in a
// directory are a set union (kitchen-columns.test.js), so the pantry-server lane's own pantry_item
// contract can sit beside this one.
//
// THE AUTHORITY. pantry_item and kitchen_batch_input.pantry_item_id are created by v5-pantry-001 (release
// 2, the pantry-server lane), built concurrently with this lane. The columns below are checked against the
// cross-lane contract pinned in the B′ brief, and — whenever that migration is on the branch — against its
// 0a text too, so the day the train carries both lanes this file binds to the real DDL.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const AUDIT_COLUMNS = {
  pantry_item: [
    'acquired_at', 'acquired_precision', 'created_at', 'crop_type_slug', 'deleted_at', 'id', 'name', 'notes',
    'plant_id', 'storage_location_id', 'used_up_at', 'user_id',
  ],
  kitchen_batch_input: ['pantry_item_id'],
};

// The pinned cross-lane contract (B′ brief, "pantry_item (L-pantry-server, v5-pantry-001; V4 §4.3)").
const PINNED = {
  pantry_item: [
    'id', 'user_id', 'name', 'storage_location_id', 'acquired_at', 'acquired_precision', 'use_by_target',
    'plant_id', 'crop_type_slug', 'used_up_at', 'notes', 'idempotency_key', 'created_at', 'updated_at',
    'deleted_at',
  ],
  kitchen_batch_input: ['pantry_item_id'],
};

const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');
const SQL = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .map((f) => decomment(readFileSync(resolve(__dirname, f), 'utf8')))
  .flatMap((src) => [...src.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1]))
  .join('\n');

// The aliases pantry_item is bound under, and the columns read through them.
const PANTRY_ALIASES = [...new Set([...SQL.matchAll(/\b(?:FROM|JOIN)\s+pantry_item\s+([a-z_]+)\b/g)].map((m) => m[1]))];

describe('V5-BATCHBUILDER-001 — pantry_item / pantry_item_id contract', () => {
  it('finds the statements, so the assertions below are not vacuous', () => {
    expect(PANTRY_ALIASES.sort()).toEqual(['it', 'kp', 'pit']);
    expect(SQL).toMatch(/INSERT INTO kitchen_batch_input \([^)]*\bpantry_item_id\b/);
  });

  it('declares only pinned columns', () => {
    for (const [table, cols] of Object.entries(AUDIT_COLUMNS)) {
      expect(cols.filter((c) => !PINNED[table].includes(c)), table).toEqual([]);
    }
  });

  it('reads through its aliases exactly the declared pantry_item columns', () => {
    const read = [...new Set(PANTRY_ALIASES.flatMap((a) => [...SQL.matchAll(new RegExp(String.raw`\b${a}\.([a-z_]+)\b`, 'g'))].map((m) => m[1])))].sort();
    expect(read).toEqual([...AUDIT_COLUMNS.pantry_item].sort());
  });

  it('matches v5-pantry-001 when it is on the branch', () => {
    const f = resolve(__dirname, '../../migrations/v5-pantry-001/0a-additive-ddl.sql');
    if (!existsSync(f)) return;
    const ddl = readFileSync(f, 'utf8');
    for (const c of AUDIT_COLUMNS.pantry_item) expect(ddl, `pantry_item.${c}`).toMatch(new RegExp(String.raw`\b${c}\b`));
    expect(ddl).toMatch(/\bpantry_item_id\b/);
  });

  it('exposes the contract in the shape scripts/dev-main-schema-audit.py can parse', () => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const decl = self.match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    expect(decl).not.toBeNull();
    expect(decl[1]).not.toMatch(/\bconst\b/);
    const pairs = [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)];
    expect(pairs.map((m) => m[1])).toEqual(Object.keys(AUDIT_COLUMNS));
  });
});
