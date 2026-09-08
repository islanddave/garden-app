// BUG-INVREFSTRAND-001 — the preventer and the detector must span the same surface.
//
// Two artifacts describe the same four relations: delete-guard.js REFERRING_RELATIONS (which the
// DELETE arm refuses over) and migrations/v5-invrefstrand-001/gates.yml (which reports the strands
// that got past it). Nothing in the database connects them — care to add a fifth foreign key to
// inventory_items and update only one is all it takes for the guard to keep reporting GREEN about a
// surface it no longer spans. That is the L-081 join-ratchet class, and it is invisible to both a
// unit run and a gate run taken alone.
//
// The gate file carries its OWN pg_constraint census (post_inventory_fk_census_is_unchanged) which
// catches a fifth FK appearing in the DATABASE. This catches the other direction and the one that
// happens first: a fifth FK appearing in the CODE. Neither subsumes the other, and only this one
// runs in the unit suite with no database at all.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { REFERRING_RELATIONS } from './delete-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATES = resolve(__dirname, '../../migrations/v5-invrefstrand-001/gates.yml');
const doc = yaml.load(readFileSync(GATES, 'utf8'));

const byName = (phase, name) => doc[phase].find((g) => g.name === name);
const GUARD = byName('post', 'post_no_live_row_references_a_deleted_inventory_item');
const PRE = byName('pre', 'pre_reference_strands_exist_before_the_decision');
const CENSUS = byName('post', 'post_inventory_fk_census_is_unchanged');
const FEED = byName('post', 'post_inventory_fk_census_still_finds_all_four');

// The self-arming clause, stripped so the two predicates can be compared as predicates.
const RECEIPT = /\s*AND EXISTS \(SELECT 1 FROM public\.schema_version\s*WHERE version = '5\.0\.0-invrefstrand-20260908'\)/g;
const norm = (s) => s.replace(RECEIPT, '').replace(/\s+/g, ' ').trim();

describe('BUG-INVREFSTRAND-001 — gate coverage tracks the handler guard', () => {
  it('every relation the DELETE arm refuses over is also detected by the standing gate', () => {
    expect(REFERRING_RELATIONS.length).toBeGreaterThan(0);
    for (const rel of REFERRING_RELATIONS) {
      expect(GUARD.sql, `gate does not cover ${rel.table}.${rel.column}`)
        .toMatch(new RegExp(`FROM public\\.${rel.table}\\b`));
      expect(GUARD.sql, `gate does not join on ${rel.column}`)
        .toMatch(new RegExp(`ON i\\.id = \\w+\\.${rel.column}\\b`));
    }
    // Count as well as membership: an arm can be present for a relation that was REMOVED from
    // REFERRING_RELATIONS, which is the same drift in the other direction.
    const arms = GUARD.sql.match(/JOIN public\.inventory_items i ON i\.id =/g) ?? [];
    expect(arms).toHaveLength(REFERRING_RELATIONS.length);
  });

  it('every constraint the handler names is asserted in BOTH halves of the census', () => {
    for (const rel of REFERRING_RELATIONS) {
      expect(CENSUS.sql, `census allowlist omits ${rel.constraint}`).toContain(rel.constraint);
      expect(FEED.sql, `feed gate omits ${rel.constraint}`).toContain(rel.constraint);
    }
  });

  it('the guard is parent-side, NOT an anti-join — the shape that reads green as the owner', () => {
    // gate_runner connects as the RLS-exempt owner, for whom a soft-deleted parent IS visible and
    // the FK guarantees it exists: `LEFT JOIN ... WHERE i.id IS NULL` returns zero forever. Proven
    // against live prod 2026-09-08 — the anti-join spelling read GREEN over both real findings.
    const armCount = REFERRING_RELATIONS.length;
    expect(GUARD.sql.match(/i\.deleted_at IS NOT NULL/g) ?? []).toHaveLength(armCount);
    expect(GUARD.sql).not.toMatch(/LEFT JOIN/i);
    expect(GUARD.sql).not.toMatch(/i\.id IS NULL/);
  });

  it('the pre gate and the standing guard are the same predicate, receipt aside', () => {
    // They are written out twice because a gates.yml has no include mechanism. If they drift, the
    // measurement that justified the migration stops describing what the gate enforces.
    expect(norm(GUARD.sql)).toBe(norm(PRE.sql));
    // And the receipt really is present on the standing one — norm() would happily equate two
    // predicates that were both unarmed.
    expect(GUARD.sql.match(RECEIPT) ?? []).toHaveLength(REFERRING_RELATIONS.length);
  });

  it('the standing gates carry no env: — they were verified against prod AND staging', () => {
    for (const g of doc.post) {
      if (g.continuous === false) continue;
      expect(g.env, `${g.name} declares env: ${g.env}`).toBeUndefined();
    }
    expect(PRE.env).toBe('prod');
    expect(PRE.continuous).toBe(false);
  });
});
