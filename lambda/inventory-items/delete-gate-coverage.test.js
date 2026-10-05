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
//
// THE CENSUS HAS TWO FEED GATES SINCE v5-seedmultiparent-001, and this file reads both. The allowlist
// (one NOT IN list, here) names every classified FK. The FEED half — "the constraints the allowlist
// names are still present" — cannot live in one gate any more: the fifth FK, from
// seed_lot_parent_planting, exists only where that migration has been applied, while the four-name gate
// is armed on a stamp every environment already carries. So the four stay in this bundle's gate with
// their `<> 4`, and the fifth is fed by a gate in the migration that creates its table, armed on that
// migration's own stamp. What is held here is unchanged in strength: every classified FK is fed by
// EXACTLY ONE of the two gates, each gate's count equals the names it lists, and which gate feeds an FK
// is decided by which migration's DDL creates it — not by where it was convenient to put the name.
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

// v5-seedmultiparent-001: the migration that creates the fifth FK, and the feed gate it carries for it.
const PARENT_DIR = resolve(__dirname, '../../migrations/v5-seedmultiparent-001');
const PARENT_STAMP = '5.0.0-seedmultiparent-001';
const PARENT_DDL = readFileSync(resolve(PARENT_DIR, '0a-additive-ddl.sql'), 'utf8');
const PARENT_FEED = yaml.load(readFileSync(resolve(PARENT_DIR, 'gates.yml'), 'utf8')).post
  .find((g) => g.name === 'post_inventory_fk_census_finds_the_parent_link');
// Every FK to inventory_items that migration's DDL creates, as written: its table, its name, its column
// and its delete action. Read from the statement, so the gate, the allowlist and the classification are
// each compared with the DDL rather than only with one another.
const CONFDELTYPE = { RESTRICT: 'r', CASCADE: 'c', 'SET NULL': 'n', 'SET DEFAULT': 'd', 'NO ACTION': 'a' };
const PARENT_FKS = [...PARENT_DDL.matchAll(
  /ALTER TABLE public\.(\w+)\s+ADD CONSTRAINT (\w+)\s+FOREIGN KEY \((\w+)\) REFERENCES public\.inventory_items\(id\) ON DELETE ([A-Z ]+?);/g,
)].map((m) => ({ table: m[1], constraint: m[2], column: m[3], confdeltype: CONFDELTYPE[m[4]] }));

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
  const censusPairs = [...CENSUS.sql.matchAll(/\('(\w+)',\s*'(\w)'\)/g)].map((m) => ({ constraint: m[1], confdeltype: m[2] }));
  const pairs = censusPairs.map((p) => p.constraint);
  const fedBy = (gate) => [...gate.sql.matchAll(/'(\w+_fkey)'/g)].map((m) => m[1]);
  const relations = [...BLOCKING_RELATIONS, ...FOLLOWING_RELATIONS];
  const classified = relations.map((r) => r.constraint);
  // Which feed gate owns a constraint is a fact about the DDL: the ones v5-seedmultiparent-001 creates
  // are fed by that migration's gate, every other one by this bundle's standing four-name gate.
  const createdLater = PARENT_FKS.map((fk) => fk.constraint);
  const standing = classified.filter((c) => !createdLater.includes(c));

  it('the census allowlist is exactly the blocking + following constraints, in both directions', () => {
    expect([...pairs].sort()).toEqual([...classified].sort());
  });

  it('the two feed gates between them assert the same set, each constraint in exactly one, and each count matches its own list', () => {
    expect(PARENT_FEED, 'feed gate missing from v5-seedmultiparent-001/gates.yml').toBeDefined();
    const fed = fedBy(FEED);
    const fedLater = fedBy(PARENT_FEED);
    // The whole feed, across both gates, is the classified list — and no name is fed twice.
    expect([...fed, ...fedLater].sort()).toEqual([...classified].sort());
    expect(fed.length + fedLater.length).toBe(classified.length);
    // Each gate feeds its own side of the split and nothing from the other.
    expect([...fed].sort()).toEqual([...standing].sort());
    expect([...fedLater].sort()).toEqual([...createdLater].sort());
    // A count that disagrees with its own list is a gate that can never be green, or never red.
    expect(FEED.sql).toMatch(new RegExp(`\\)\\) <> ${fed.length}\\b`));
    expect(PARENT_FEED.sql).toMatch(new RegExp(`\\)\\) <> ${fedLater.length}\\b`));
  });

  it('the standing feed gate still names four: raising it would red wherever the later table is not applied', () => {
    // The trap: the allowlist grows to five, so `<> 5` here looks like the matching edit. This gate is
    // armed on a stamp both environments carry, and the fifth FK exists only after v5-seedmultiparent-001.
    expect(fedBy(FEED)).toHaveLength(4);
    expect(FEED.sql).not.toContain(PARENT_STAMP);
    expect(FEED.sql).not.toMatch(/seed_lot_parent_planting/);
  });

  it('the later feed gate arms on its own migration\'s stamp and reads the catalog only', () => {
    expect(PARENT_FEED.continuous).not.toBe(false);
    expect(PARENT_FEED.expect).toBe('rowcount_eq');
    expect(PARENT_FEED.value).toBe(0);
    expect(PARENT_FEED.env).toBeUndefined();
    // Self-armed on the stamp 0a writes with the table — never on this bundle's, which is already live.
    expect(PARENT_FEED.sql).toContain(`WHERE version = '${PARENT_STAMP}'`);
    expect(PARENT_FEED.sql).not.toContain(STAMP);
    // Pushed before the table exists anywhere: naming it as a relation, or casting to regclass, errors
    // at parse time under any WHERE and reds the whole run.
    expect(PARENT_FEED.sql).not.toMatch(/::regclass/);
    expect(PARENT_FEED.sql).not.toMatch(/\b(FROM|JOIN)\s+(public\.)?seed_lot_parent_planting\b/i);
  });

  it('what the later migration\'s DDL creates is what is classified, allowlisted and fed', () => {
    expect(PARENT_FKS.length, 'no FK to inventory_items found in v5-seedmultiparent-001/0a').toBeGreaterThan(0);
    for (const fk of PARENT_FKS) {
      expect(fk.confdeltype, `${fk.constraint}: unreadable ON DELETE action`).toBeDefined();
      // Classified once, on the table and column the DDL gives it.
      const rel = relations.filter((r) => r.constraint === fk.constraint);
      expect(rel, `${fk.constraint} is not classified in delete-guard.js`).toHaveLength(1);
      expect({ table: rel[0].table, column: rel[0].column }).toEqual({ table: fk.table, column: fk.column });
      // Allowlisted with the delete action the DDL declares, not one typed from memory.
      expect(censusPairs.filter((p) => p.constraint === fk.constraint)).toEqual([{ constraint: fk.constraint, confdeltype: fk.confdeltype }]);
    }
    // The stamp the feed gate keys on is written by the same file that creates the constraint, and the
    // rollback removes it — so "applied" and "armed" cannot come apart in either direction.
    const rollback = readFileSync(resolve(PARENT_DIR, '0r-rollback.sql'), 'utf8');
    expect(PARENT_DDL).toMatch(new RegExp(`VALUES \\('${PARENT_STAMP.replace(/\./g, '\\.')}',`));
    expect(rollback).toMatch(new RegExp(`DELETE FROM public\\.schema_version WHERE version = '${PARENT_STAMP.replace(/\./g, '\\.')}';`));
  });

  it('the parent link follows the lot: it is never a blocking relation', () => {
    // A parent link describes the lot. Blocking on it would make every saved lot with a parent
    // undeletable, and an arm for it in the guard would red on every ordinary delete of one.
    for (const fk of PARENT_FKS) {
      expect(FOLLOWING_RELATIONS.map((r) => r.constraint)).toContain(fk.constraint);
      expect(BLOCKING_RELATIONS.map((r) => r.constraint)).not.toContain(fk.constraint);
    }
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
