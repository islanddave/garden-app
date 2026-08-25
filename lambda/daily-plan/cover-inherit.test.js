// V4-COVEREDNOTMODELLED-001 phase 2 — coverage inherited from the nearest stated ancestor.
//
// Two things need proving and they need proving differently.
//
// (1) FLAG OFF IS A NO-OP. Not "looks unchanged" — byte-identical. The assertion is a sha256 of the
//     plantings SQL captured by running run() against a recording driver, compared to a hash taken
//     from the handler BEFORE this change (worktree lane-covered-20260825, parent e5a8ab9). The
//     hash is a fact about the old file, so it cannot be re-derived from the new one to make itself
//     pass. It is asserted against the statement the DRIVER RECEIVED, not against the file's text:
//     the flag is read at runtime and interpolated, so a source grep would prove nothing about what
//     actually executes.
//
// (2) FLAG ON RESOLVES THE RIGHT ANCESTOR. That is a claim about SQL semantics, which no unit test
//     in this suite can execute (there is no Postgres here; the integration job has one). So the
//     CASE arms are PARSED OUT OF THE EMITTED STATEMENT and interpreted against location fixtures,
//     the same technique covered-backfill-parity.test.js uses on 0b-data.sql — the interpreter reads
//     the shipped text rather than restating it, so it cannot drift from the thing it guards.
//
// MUTATION LOG — each mutation was applied to handler.js, this file run, the RED observed, and the
// file restored from a copy (never `git checkout --`, which reverts to HEAD and would have taken
// the fix with it). 2026-08-25, lane-covered-20260825:
//   * `cinhArm = COVER_INHERIT_ARM` (drop the flag test)  -> 4 RED, incl. the sha256.
//   * `cinhCte = COVER_INHERIT_CTE` (drop the flag test)  -> 3 RED, incl. the sha256.
//   * move the ancestor arm ABOVE `when l.covered is not null` -> 3 RED, incl. "own flag beats an
//     inherited one" and the prod-parity check.
//   * drop `c.depth < 4` from the recursive term          -> 1 RED (the cycle bound).
//   * drop `a.deleted_at is null` from the recursive join -> 1 RED (the cycle bound).
//
// WHAT THESE TESTS DO NOT PROVE, stated rather than left to be discovered: there is no Postgres in
// the unit run, so the CTE is never EXECUTED here. Its semantics are pinned by interpreting the
// emitted CASE and by `nearestStatedAncestor` below, which is a JS restatement of the walk — so the
// depth-0 exclusion and the soft-delete skip are asserted as INTENT, not as observed database
// behaviour. Executing those needs the integration job (a real Neon branch), and the flag must be
// exercised there before any env flip.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import handler from './handler.js';

const { run, COVER_INHERIT_CTE, COVER_INHERIT_JOIN, COVER_INHERIT_ARM, LEDGER_OVERRIDABLE_FLAGS } = handler;

// The plantings SELECT is the FIRST statement run() issues. Throwing on it stops the run there,
// which is the point: nothing downstream can influence the statement already captured.
async function plantingsSql(flagOverrides) {
  let sql = null;
  const pg = {
    query: async (q) => {
      if (sql === null) { sql = q; throw new Error('__captured__'); }
      return { rows: [] };
    },
  };
  try {
    await run({ pg, today: '2026-08-25', dryRun: true, flagOverrides });
  } catch (e) {
    if (e.message !== '__captured__') throw e;
  }
  if (sql === null) throw new Error('no statement captured — this guard has gone blind');
  return sql;
}

// sha256 of the plantings statement as emitted by handler.js at e5a8ab9, before this change.
// Captured by the same harness above, run against the unmodified file.
const PRE_CHANGE_SHA256 = '5cab788b199ae46914a6037045f45c8940a4c01df0641443247f6088ca55c586';
const PRE_CHANGE_LENGTH = 12059;

const sha = (s) => createHash('sha256').update(s).digest('hex');

// ── Arm parsing, over the EMITTED statement rather than the file ─────────────────────────────────
// Deliberately narrow: it understands only the four shapes the coverage CASE uses, and throws on
// anything else. A silently-skipped arm is a guard that passes while missing what it was written
// for (covered-backfill-parity.test.js:41).
const LITERAL = { true: true, false: false, null: null };
const decomment = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

function coverArms(sql) {
  const m = decomment(sql).match(/left join lateral \(select case\b([\s\S]*?)\bend as state\)/i);
  if (!m) throw new Error('cov lateral not found in the emitted SQL — this guard has gone blind');
  const body = m[1].replace(/\s+/g, ' ').trim();
  const re = /when\s+(\w+)\.(\w+)\s+(in\s*\(([^)]*)\)|is\s+null|is\s+not\s+null)\s+then\s+([\w.]+)|else\s+(\w+)/gi;
  const arms = [];
  let seen = 0;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    seen += mm[0].length;
    if (mm[6] !== undefined) { arms.push({ op: 'else', value: LITERAL[mm[6].toLowerCase()] }); continue; }
    const ref = `${mm[1]}.${mm[2]}`;
    // THEN is either a literal or a column reference (`then l.covered` passes the value through).
    const raw = mm[5].toLowerCase();
    const value = raw in LITERAL ? LITERAL[raw] : { passthrough: mm[5] };
    if (/^in/i.test(mm[3])) {
      arms.push({ op: 'in', ref, set: mm[4].split(',').map((s) => s.trim().replace(/^'|'$/g, '')), value });
    } else {
      arms.push({ op: /not/i.test(mm[3]) ? 'notnull' : 'isnull', ref, value });
    }
  }
  if (seen < body.length * 0.5) throw new Error(`CASE only ${seen}/${body.length} chars parsed — arms were dropped`);
  return arms;
}

// `row` is the joined row the CASE sees: l.* from the planting's location, cinh.covered from the
// nearest stated ancestor. Mirrors the SQL's own evaluation order exactly — first arm wins.
function evaluate(arms, row) {
  for (const a of arms) {
    if (a.op === 'else') return a.value;
    const v = row[a.ref];
    const hit = a.op === 'in' ? (v != null && a.set.includes(v))
      : a.op === 'isnull' ? v == null
        : v != null;
    if (!hit) continue;
    return a.value && a.value.passthrough ? row[a.value.passthrough] : a.value;
  }
  return undefined;
}

// Resolve `cinh.covered` for a location out of a tree, by the CTE's own rule: walk up, first
// ancestor with a stated flag wins, self excluded, soft-deleted skipped, bounded at 4 hops.
function nearestStatedAncestor(tree, id) {
  let cur = tree[id];
  for (let depth = 0; depth < 4 && cur; depth += 1) {
    const parent = cur.parent_id ? tree[cur.parent_id] : null;
    if (!parent || parent.deleted_at) return null;
    if (parent.covered != null) return parent.covered;
    cur = parent;
  }
  return null;
}

// Live prod shape, 2026-08-25: Stable (covered=true) > Indoor Rack > Shelf 1..5, and the exposed
// zones. Plus the two rows the arm exists for, which prod does not have yet.
const TREE = {
  stable: { id: 'stable', parent_id: null, type_label: 'zone', covered: true },
  pasture: { id: 'pasture', parent_id: null, type_label: 'zone', covered: false },
  rack: { id: 'rack', parent_id: 'stable', type_label: 'rack', covered: true },
  shelf1: { id: 'shelf1', parent_id: 'rack', type_label: 'shelf', covered: true },
  // The defect case: a low tunnel created under Stable today. type_label 'bed' is not in the
  // heuristic set and `covered` defaults to NULL, so without inheritance it resolves EXPOSED.
  tunnel: { id: 'tunnel', parent_id: 'stable', type_label: 'bed', covered: null },
  // Same shape outdoors — inheritance must carry FALSE just as faithfully as TRUE.
  openbed: { id: 'openbed', parent_id: 'pasture', type_label: 'bed', covered: null },
  // An override: Dave states `false` on a bed inside the Stable (a bench under a leaky roof).
  statedopen: { id: 'statedopen', parent_id: 'stable', type_label: 'bed', covered: false },
  // Nothing stated anywhere up the chain -> unknown must survive, never collapse to false.
  orphanzone: { id: 'orphanzone', parent_id: null, type_label: null, covered: null },
  orphanbed: { id: 'orphanbed', parent_id: 'orphanzone', type_label: null, covered: null },
  // A soft-deleted parent is not a source of truth: the CTE filters it, so the walk stops.
  goneparent: { id: 'goneparent', parent_id: null, type_label: 'zone', covered: true, deleted_at: '2026-01-01' },
  underGone: { id: 'underGone', parent_id: 'goneparent', type_label: 'bed', covered: null },
};

const joinedRow = (locId) => {
  const l = TREE[locId];
  return {
    'l.id': l.id,
    'l.covered': l.covered,
    'l.type_label': l.type_label,
    'cinh.covered': nearestStatedAncestor(TREE, locId),
  };
};

const UNLOCATED = { 'l.id': null, 'l.covered': null, 'l.type_label': null, 'cinh.covered': null };

describe('V4-COVEREDNOTMODELLED-001 phase 2 — flag OFF is a no-op', () => {
  it('emits SQL byte-identical to the pre-change handler', async () => {
    const sql = await plantingsSql(null);
    expect(sql.length, 'plantings SQL length drifted from the pre-change statement').toBe(PRE_CHANGE_LENGTH);
    expect(sha(sql), 'plantings SQL is NOT byte-identical with the flag off').toBe(PRE_CHANGE_SHA256);
  });

  it('issues zero references to the inheritance CTE with the flag off', async () => {
    // The hash above already covers this, but it fails as an opaque digest mismatch. This names the
    // thing that leaked, so a future red diagnoses itself.
    const sql = await plantingsSql(null);
    expect(sql).not.toMatch(/loc_cover_inherit/);
    expect(sql).not.toMatch(/loc_cover_chain/);
    expect(sql).not.toMatch(/cinh\./);
  });

  it('leaves the coverage CASE at exactly its pre-change arms with the flag off', () => {
    // Non-vacuity for the parser itself: if coverArms ever stopped finding arms, every semantic
    // assertion below would compare undefined to undefined and pass.
    return plantingsSql(null).then((sql) => {
      const arms = coverArms(sql);
      expect(arms.map((a) => a.ref ?? 'else')).toEqual(
        ['l.id', 'l.covered', 'l.type_label', 'l.type_label', 'else']);
    });
  });

  it('classifies every live prod location identically with the flag off and on', async () => {
    // The blast-radius claim, restated as a test. Measured against prod 2026-08-25: all 21 live
    // locations carry a stated `covered`, so arm 2 answers for every one of them and the new arm is
    // unreachable. 0 plantings move in either direction.
    const off = coverArms(await plantingsSql(null));
    const on = coverArms(await plantingsSql({ CARE_COVER_INHERIT_ENABLED: true }));
    const stated = ['stable', 'pasture', 'rack', 'shelf1', 'statedopen'];
    for (const id of stated) {
      const row = joinedRow(id);
      expect(evaluate(on, row), `location ${id} changed classification`).toBe(evaluate(off, row));
    }
    expect(evaluate(on, UNLOCATED)).toBe(evaluate(off, UNLOCATED));
  });
});

describe('V4-COVEREDNOTMODELLED-001 phase 2 — flag ON inherits from the nearest stated ancestor', () => {
  const armsOn = async () => coverArms(await plantingsSql({ CARE_COVER_INHERIT_ENABLED: true }));

  it('emits the CTE, the join and the arm together or not at all', async () => {
    const sql = await plantingsSql({ CARE_COVER_INHERIT_ENABLED: true });
    expect(sql).toContain(COVER_INHERIT_CTE);
    expect(sql).toContain(COVER_INHERIT_JOIN);
    expect(sql).toContain(COVER_INHERIT_ARM);
  });

  it('bounds the recursion so a parent_id cycle cannot hang the nightly run', async () => {
    const sql = await plantingsSql({ CARE_COVER_INHERIT_ENABLED: true });
    // Not cosmetic: locations has no cycle constraint, and an unbounded recursive CTE over a cycle
    // does not error, it never terminates — an empty daily plan for both users, every night.
    expect(sql).toMatch(/where c\.depth < 4/);
    expect(sql).toMatch(/a\.deleted_at is null/);
  });

  it('classifies an unstated bed under a covered zone as COVERED', async () => {
    // The defect, in one assertion. Without the arm this bed is `false` — open to the sky — and
    // takes rain credit for rain the tunnel sheds.
    const off = coverArms(await plantingsSql(null));
    expect(evaluate(off, joinedRow('tunnel'))).toBe(false);
    expect(evaluate(await armsOn(), joinedRow('tunnel'))).toBe(true);
  });

  it('carries an inherited FALSE as faithfully as an inherited TRUE', async () => {
    // Inheritance is not a "covered wins" rule. An unstated bed under an exposed zone must resolve
    // FALSE from the ancestor, not from the type_label heuristic that happens to agree today.
    expect(evaluate(await armsOn(), joinedRow('openbed'))).toBe(false);
  });

  it("lets the location's own flag beat an inherited one", async () => {
    // `statedopen` sits under Stable (covered) but says false. Dave's explicit answer on the row is
    // the most specific statement there is and must win.
    expect(evaluate(await armsOn(), joinedRow('statedopen'))).toBe(false);
  });

  it('a location that states its own flag inherits nothing', async () => {
    // Shelf 1 states true and sits under a true rack, so the value is right either way — the claim
    // is that arm 2 answers, which is what keeps the CTE's `depth > 0` honest.
    const arms = await armsOn();
    const row = { ...joinedRow('shelf1'), 'cinh.covered': false };
    expect(evaluate(arms, row), 'an inherited value overrode a stated one').toBe(true);
  });

  it('keeps unknown as unknown when nothing up the chain is stated', async () => {
    // BUG-NOLOCOUTDOOR-001's invariant, which this arm must not erode: null is a MEANING, and
    // collapsing it to false is what rain-credits a plant under a roof. toBe(null), not a falsy
    // check — `false` would pass truthiness and mean "open to the sky".
    const v = evaluate(await armsOn(), joinedRow('orphanbed'));
    expect(v).toBe(null);
    expect(v).not.toBe(false);
  });

  it('does not inherit through a soft-deleted ancestor', async () => {
    // The deleted zone says covered; it is deleted, so it is not a source of truth. type_label
    // 'bed' then answers, exactly as it does today.
    expect(evaluate(await armsOn(), joinedRow('underGone'))).toBe(false);
  });

  it('leaves an un-located planting unknown, flag or no flag', async () => {
    // Arm 1 short-circuits before anything coverage-related is consulted; the join is a LEFT JOIN
    // on l.id, so cinh is null too. Both halves of that must stay true.
    expect(evaluate(await armsOn(), UNLOCATED)).toBe(null);
  });

  it('is reachable through the dry-run shadow seam and only there', async () => {
    expect(LEDGER_OVERRIDABLE_FLAGS).toContain('CARE_COVER_INHERIT_ENABLED');
    // A LIVE run must ignore the override — run() re-checks dryRun before honoring flagOverrides,
    // so an override cannot arm the inheritance against the real 02:00 plan.
    let sql = null;
    const pg = {
      query: async (q) => { if (sql === null) { sql = q; throw new Error('__captured__'); } return { rows: [] }; },
    };
    try {
      await run({ pg, today: '2026-08-25', dryRun: false, flagOverrides: { CARE_COVER_INHERIT_ENABLED: true } });
    } catch (e) { if (e.message !== '__captured__') throw e; }
    expect(sql).not.toMatch(/loc_cover_inherit/);
  });
});
