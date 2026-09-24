// BUG-INVREFSTRAND-001 (option C) — the preventer and the detector must span the same surface.
//
// Two artifacts describe what blocks an inventory delete: delete-guard.js (BLOCKING_RELATIONS and the
// preflight SQL the DELETE arm refuses over) and migrations/v5-invrefstrand-001/gates.yml (the gate
// that reports what got past it). Nothing in the database connects them. A detector WIDER than its
// preventer reds on deletes the app makes on purpose — every photographed item, every saved lot; a
// NARROWER one reports green about a surface it no longer spans (the L-081 join-ratchet class). Both
// are invisible to a unit run and to a gate run taken alone, so this file holds them together in both
// directions: relations, and the live/archived scope of each.
//
// The gate file carries its own pg_constraint census, which catches a fifth FK appearing in the
// DATABASE. This catches the other direction and the one that happens first: a relation appearing in
// the CODE — and it makes every FK the census names be classified here, as blocking or following.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { BLOCKING_RELATIONS, FOLLOWING_RELATIONS } from './delete-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATES_PATH = resolve(__dirname, '../../migrations/v5-invrefstrand-001/gates.yml');
const GATES_RAW = readFileSync(GATES_PATH, 'utf8');
const doc = yaml.load(GATES_RAW);
const GUARD_SRC = readFileSync(resolve(__dirname, 'delete-guard.js'), 'utf8');
// The preflight template, as written: the text between `sql\`` and the closing backtick.
const PREFLIGHT = GUARD_SRC.match(/sql`([\s\S]*?)`/)[1];

const STAMP = '5.0.0-invrefstrand-20260924';
const byName = (phase, name) => doc[phase].find((g) => g.name === name);
const GUARD = byName('post', 'post_nothing_grown_or_applied_from_a_deleted_inventory_item');
const PRE = byName('pre', 'pre_nothing_to_resolve_before_arming');
const CENSUS = byName('post', 'post_inventory_fk_census_is_unchanged');
const FEED = byName('post', 'post_inventory_fk_census_still_finds_all_four');

// The self-arming clause, stripped so the two predicates can be compared as predicates.
const RECEIPT = /\s*AND EXISTS \(SELECT 1 FROM public\.schema_version\s*WHERE version = '5\.0\.0-invrefstrand-20260924'\)/g;
const norm = (s) => s.replace(RECEIPT, '').replace(/\s+/g, ' ').trim();

// The guard's arms, one per UNION ALL branch: its table, its alias, and its own WHERE.
const arms = (sql) => sql.split(/\bUNION ALL\b/).map((part) => {
  const m = part.match(/FROM public\.(\w+) (\w+)\s+JOIN public\.inventory_items i ON i\.id = (\w+)\.(\w+)\s+WHERE ([\s\S]*)$/);
  return m ? { table: m[1], alias: m[2], joinAlias: m[3], column: m[4], where: m[5] } : { unparsed: part };
});

describe('BUG-INVREFSTRAND-001 — the gate spans exactly what the DELETE arm refuses over', () => {
  it('every blocking relation has an arm in the guard, joined on its own column', () => {
    expect(GUARD, 'guard gate missing from gates.yml').toBeDefined();
    const got = arms(GUARD.sql);
    expect(got.filter((a) => a.unparsed), 'an arm the parser cannot read').toEqual([]);
    for (const rel of BLOCKING_RELATIONS) {
      const arm = got.find((a) => a.table === rel.table);
      expect(arm, `gate has no arm for ${rel.table}`).toBeDefined();
      expect(arm.joinAlias).toBe(arm.alias);
      expect(arm.column).toBe(rel.column);
    }
  });

  it('…and the guard has NO other arm — the item\'s own photos and stage rows are not strands', () => {
    // Count as well as membership: an arm for a relation that is not blocking (photos, stage rows)
    // reds gate-invariants on every ordinary delete the app now allows.
    expect(arms(GUARD.sql).map((a) => a.table).sort())
      .toEqual(BLOCKING_RELATIONS.map((r) => r.table).sort());
    for (const rel of FOLLOWING_RELATIONS) {
      expect(GUARD.sql, `${rel.table} is the item's own and must not be an arm`).not.toMatch(new RegExp(`\\b${rel.table}\\b`));
    }
  });

  it('the preflight reads exactly the blocking relations too — the same set from the preventer side', () => {
    const tables = [...PREFLIGHT.matchAll(/FROM public\.(\w+) \w+/g)].map((m) => m[1]).filter((t) => t !== 'inventory_items');
    expect([...new Set(tables)].sort()).toEqual(BLOCKING_RELATIONS.map((r) => r.table).sort());
    for (const rel of BLOCKING_RELATIONS) {
      expect(PREFLIGHT).toMatch(new RegExp(`WHERE \\w+\\.${rel.column} = i\\.id`));
    }
  });

  it('the live/archived scope matches on both sides: live referrers only, archived plantings INCLUDED', () => {
    for (const arm of arms(GUARD.sql)) {
      // Live referrer: its own deleted_at IS NULL. Both blocking tables carry the column.
      expect(arm.where, `${arm.table} arm must count live rows only`).toMatch(new RegExp(`\\b${arm.alias}\\.deleted_at IS NULL`));
      // Archived included: no archived_at predicate anywhere in the arm.
      expect(arm.where, `${arm.table} arm must not filter archive state`).not.toMatch(/archived_at/);
    }
    // The preventer's blocking counts: live only, and the plantings count carries no archived_at test
    // (plants_archived is a second count for the sentence, not a filter on the first).
    const plantsCount = PREFLIGHT.match(/\(SELECT count\(\*\) FROM public\.plants p[\s\S]*?\)::int AS plants\b/)[0];
    expect(plantsCount).toMatch(/p\.deleted_at IS NULL/);
    expect(plantsCount).not.toMatch(/archived_at/);
    const eventCount = PREFLIGHT.match(/\(SELECT count\(\*\) FROM public\.event_log e[\s\S]*?\)::int AS event_log\b/)[0];
    expect(eventCount).toMatch(/e\.deleted_at IS NULL/);
  });

  it('the guard is parent-side, NOT an anti-join — the shape that reads green as the owner', () => {
    // gate_runner connects as the RLS-exempt owner, for whom a soft-deleted parent IS visible and the
    // FK guarantees it exists: `LEFT JOIN ... WHERE i.id IS NULL` returns zero forever. Proven against
    // live prod 2026-09-08 — the anti-join spelling read GREEN over both strands live then.
    expect(GUARD.sql.match(/i\.deleted_at IS NOT NULL/g) ?? []).toHaveLength(BLOCKING_RELATIONS.length);
    expect(GUARD.sql).not.toMatch(/LEFT JOIN/i);
    expect(GUARD.sql).not.toMatch(/i\.id IS NULL/);
  });

  it('the pre gate and the standing guard are the same predicate, receipt aside', () => {
    expect(PRE, 'pre gate missing from gates.yml').toBeDefined();
    expect(norm(GUARD.sql)).toBe(norm(PRE.sql));
    // And the receipt really is on every arm of the standing one — norm() would happily equate two
    // predicates that were both unarmed.
    expect(GUARD.sql.match(RECEIPT) ?? []).toHaveLength(BLOCKING_RELATIONS.length);
  });
});

describe('BUG-INVREFSTRAND-001 — every FK the census names is classified in code', () => {
  const pairs = [...CENSUS.sql.matchAll(/\('(\w+)',\s*'(\w)'\)/g)].map((m) => m[1]);
  const fed = [...FEED.sql.matchAll(/'(\w+_fkey)'/g)].map((m) => m[1]);
  const classified = [...BLOCKING_RELATIONS, ...FOLLOWING_RELATIONS].map((r) => r.constraint);

  it('the census allowlist is exactly the blocking + following constraints, in both directions', () => {
    expect([...pairs].sort()).toEqual([...classified].sort());
  });

  it('the feed gate asserts the same set, and its count matches', () => {
    expect([...fed].sort()).toEqual([...classified].sort());
    expect(FEED.sql).toMatch(new RegExp(`\\)\\) <> ${classified.length}\\b`));
  });

  it('no relation is both blocking and following', () => {
    const blocking = new Set(BLOCKING_RELATIONS.map((r) => r.constraint));
    expect(FOLLOWING_RELATIONS.filter((r) => blocking.has(r.constraint))).toEqual([]);
  });
});

describe('BUG-INVREFSTRAND-001 — the bundle arms itself and runs on both envs', () => {
  it('every standing post gate self-arms on the bundle\'s own, fresh stamp', () => {
    for (const g of doc.post) {
      if (g.continuous === false) continue;
      expect(g.sql, `${g.name} is not self-armed`).toContain(`WHERE version = '${STAMP}'`);
    }
    // The 2026-09-08 stamp named the four-relation guard and was never applied; nothing may key on it.
    expect(GATES_RAW).not.toMatch(/invrefstrand-20260908/);
  });

  it('no ::regclass anywhere — a cast is evaluated even under a false WHERE and would error unarmed', () => {
    expect(GATES_RAW).not.toMatch(/::regclass/);
  });

  it('the standing gates carry no env: — they were verified against prod AND staging', () => {
    for (const g of [...doc.pre, ...doc.post]) {
      expect(g.env, `${g.name} declares env: ${g.env}`).toBeUndefined();
    }
  });

  it('0a writes the stamp the gates key on, and 0r removes exactly it', () => {
    const arm = readFileSync(resolve(dirname(GATES_PATH), '0a-arm-guard.sql'), 'utf8');
    const rollback = readFileSync(resolve(dirname(GATES_PATH), '0r-rollback.sql'), 'utf8');
    expect(arm).toMatch(new RegExp(`VALUES \\('${STAMP.replace(/\./g, '\\.')}'`));
    expect(rollback).toMatch(new RegExp(`DELETE FROM public\\.schema_version WHERE version = '${STAMP.replace(/\./g, '\\.')}'`));
  });
});
