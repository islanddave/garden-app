// OPS-SCHEMAAUDITJOIN-001 — the public.variety_blend_component columns lambda/varieties names.
// V5-VARIETYBLEND-001.
//
// WHY A SEPARATE FILE: parse_test_file returns on the keyed AUDIT_COLUMNS form FIRST and never
// reaches the AUDIT_TABLES collector (scripts/dev-main-schema-audit.py), so a keyed block dropped
// into select-columns.test.js would silently destroy that file's own coverage of public.cultivar.
// That is the reason voice-alias-columns.test.js and crop-types-columns.test.js exist. It is not a
// reason for another file: the next relation this Lambda touches goes in as a new KEY of a keyed
// AUDIT_COLUMNS object this directory already has (this one will do). The files per directory are
// capped by scripts/test_count_ratchets.py, whose message says exactly how.
//
// WHY IT LIVES IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's own directory and
// only when the AUDIT_COLUMNS literal is in this file's own source text.
//
// The table is new in migrations/v5-varietyblend-001, so it starts covered. This Lambda only WRITES
// it (one row per leaf, in the transaction that creates the mix); the reply's components come from
// the key, never from a read of this table.
//
// Static source inspection rather than import: index.js loads its runtime deps at module scope.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a BARE `--`
// separator line as well as `-- text` (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler module in THIS directory, read from disk — the set Phase 4 groups together.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract, per migrations/v5-varietyblend-001 (R2A-CONTRACT section 1). The table also
// has id, created_at and deleted_at; they are DELIBERATELY ABSENT because no statement here names
// them (id and created_at take their defaults; no route sets deleted_at). The contract records what
// this Lambda names, not what the table has.
const AUDIT_COLUMNS = {
  variety_blend_component: ['blend_variety_id', 'component_variety_id', 'created_by'],
};

const COMPONENT_COLUMNS = AUDIT_COLUMNS.variety_blend_component;
// Every column the table has, so a statement naming one that is not contracted is seen.
const TABLE_COLUMNS = ['id', 'blend_variety_id', 'component_variety_id', 'created_by', 'created_at', 'deleted_at'];

const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
const TOUCHES = /\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE)\s+(?:public\.)?variety_blend_component\b/i;

const STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)]
    .map((m) => m[1])
    .filter((s) => TOUCHES.test(s))
    .map((sql) => ({ file: f, sql }));
});

describe('lambda/varieties — public.variety_blend_component column contract', () => {
  it('exactly one statement touches the table, and it is the INSERT in blend.js', () => {
    // Guards the file against becoming vacuous, and pins where the write lives: index.js is held to
    // one cultivar INSERT and one care_profile INSERT by its own tests, so the mix's statements
    // must stay in blend.js.
    expect(STATEMENTS).toHaveLength(1);
    expect(STATEMENTS[0].file).toBe('blend.js');
    expect(STATEMENTS[0].sql).toMatch(/^\s*INSERT\s+INTO\s+public\.variety_blend_component\b/i);
  });

  it('the INSERT column list is exactly the contract', () => {
    const list = STATEMENTS[0].sql.match(/INSERT\s+INTO\s+public\.variety_blend_component\s*\(([^)]*)\)/i);
    expect(list).not.toBeNull();
    expect(list[1].split(',').map((c) => c.trim()).sort()).toEqual([...COMPONENT_COLUMNS].sort());
  });

  it('names no column of the table outside the contract', () => {
    const declared = new Set(COMPONENT_COLUMNS);
    const unknown = new Set();
    for (const { sql } of STATEMENTS) {
      // Bare `id` is deliberately not scanned for: the INSERT binds ${id} as a VALUE.
      for (const col of TABLE_COLUMNS.filter((c) => c !== 'id')) {
        if (new RegExp(String.raw`\b${col}\b`).test(sql) && !declared.has(col)) unknown.add(col);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it('writes one row per leaf from the bound array, stamped with the caller', () => {
    // unnest of the leaf ids, never a VALUES list built per request: the row count is the array's.
    const { sql } = STATEMENTS[0];
    expect(sql).toMatch(/SELECT \$\{id\}::uuid, u, \$\{userId\}::text\s+FROM unnest\(\$\{leafIds\}::uuid\[\]\) AS u/);
  });

  it('never writes the mix as its own component (chk_vbc_not_self is the database half)', () => {
    // The leaf ids are the key's ids, and a key never holds the id minted for the row that carries
    // it: the id is minted after the key is built.
    const src = decomment(readFileSync(resolve(__dirname, 'blend.js'), 'utf8'));
    expect(src.indexOf('const key = blendKey(leafIds)')).toBeGreaterThan(-1);
    expect(src.indexOf('const key = blendKey(leafIds)')).toBeLessThan(src.indexOf('newId()'));
    expect(src).toMatch(/const sortedLeafIds = key\.split\(','\)/);
  });
});
