// V5-SEEDMULTIPARENT-001 (release 2a) — seed-lot-rules.js, executed.
//
// THE THREE PARENT RULES (R2A-CONTRACT section 3), and the one thing that decides whether they are
// asked at all: only of a set of two or more plantings, and only when the request ADDS a planting
// that is not already a live parent of the lot.
//   parent_without_variety — a planting being added has no variety;
//   mixed_crop_parents     — the set's varieties are not all one crop (NULL is one value of its own);
//   blend_required         — the set spans two or more varieties and the lot is not filed under the
//                            household's mix of exactly those, FLATTENED to their leaves.
//
// judgeParentFacts is pure, so the table of cells below IS the rule: each row is a request and what
// the route must answer. checkParentRules is run against a fake driver for what it reads and when.
//
// WHAT THIS CANNOT PROVE, said once: judgeParentRules — the same rules, inside the transaction — is
// SQL, and the fake records text and bound values and runs nothing. What is pinned for it is the
// text: which facts it reads, through what scope, and that it can only take 'go' away. That the SQL
// reaches the same verdict as the JavaScript for each cell needs a real Postgres; the lane report
// lists every cell as a case for the integration lane, with the two that matter most (a NULL crop
// beside a NULL crop, and a parent that is itself a mix) named.
//
// The routes are driven through the handler in parent-rules-route.test.js.
import { describe, it, expect } from 'vitest';
import {
  PARENT_WITHOUT_VARIETY, MIXED_CROP_PARENTS, BLEND_REQUIRED,
  blendKeyOf, readParentFacts, judgeParentFacts, checkParentRules, judgeParentRules,
} from './seed-lot-rules.js';

const HOUSE = ['user_a', 'user_b'];
const LOT = '2d6df841-b507-4e65-8db0-97c8659df37c';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Plantings.
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);
// Varieties. Numbered so that uuid order is ALASKA < JEWEL < EMPRESS < MIX < CARMEN.
const ALASKA = uuid(101);
const JEWEL = uuid(102);
const EMPRESS = uuid(103);
const MIX = uuid(104);       // an app-made mix of ALASKA and JEWEL
const CARMEN = uuid(105);    // a pepper
const MIX_KEY = `${ALASKA},${JEWEL}`;

const fakeSql = (answer = () => []) => {
  const calls = [];
  const fn = (strings, ...values) => {
    const call = { text: strings.join('?'), values };
    calls.push(call);
    return Promise.resolve().then(() => answer(call.text, values, calls.length));
  };
  fn.calls = calls;
  return fn;
};
const flat = (t) => t.replace(/\s+/g, ' ').trim();
const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};

// One row of the rules' read: a planting, its variety, that variety's crop and (if it is a mix) key,
// and whether the planting is already a live parent of the lot.
const fact = (id, cultivar_id, crop_slug, extra = {}) => ({
  id, cultivar_id, crop_slug, blend_key: null, member: false, lot_found: true, lot_variety_id: ALASKA, ...extra,
});
const NASTURTIUM = 'nasturtium';

describe('blendKeyOf — the key of a mix: its LEAF variety ids, lower-case, in uuid order, comma-joined', () => {
  it('orders by uuid whatever order the varieties arrive in, and lower-cases them', () => {
    expect(blendKeyOf([{ id: JEWEL }, { id: ALASKA }])).toBe(`${ALASKA},${JEWEL}`);
    expect(blendKeyOf([{ id: ALASKA }, { id: JEWEL }])).toBe(`${ALASKA},${JEWEL}`);
    const upper = 'ABCDEF01-0000-4000-8000-000000000001';
    expect(blendKeyOf([{ id: upper }, { id: ALASKA }])).toBe(`${ALASKA},${upper.toLowerCase()}`);
  });

  it('FLATTENS: a variety that is itself a mix contributes its own leaves, not itself', () => {
    // {the mix of Alaska and Jewel, Empress} is the three-way mix — the mix's id is not a leaf.
    expect(blendKeyOf([{ id: MIX, blend_key: MIX_KEY }, { id: EMPRESS }])).toBe(`${ALASKA},${JEWEL},${EMPRESS}`);
    expect(blendKeyOf([{ id: MIX, blend_key: MIX_KEY }, { id: EMPRESS }])).not.toContain(MIX);
  });

  it('dedupes a leaf reached twice — through a mix and on its own', () => {
    // {the mix of Alaska and Jewel, Alaska} flattens to the mix's own key.
    expect(blendKeyOf([{ id: MIX, blend_key: MIX_KEY }, { id: ALASKA }])).toBe(MIX_KEY);
    // …and two mixes that share a leaf.
    const other = { id: uuid(106), blend_key: `${JEWEL},${EMPRESS}` };
    expect(blendKeyOf([{ id: MIX, blend_key: MIX_KEY }, other])).toBe(`${ALASKA},${JEWEL},${EMPRESS}`);
  });

  it('is the string Postgres builds with string_agg(u::text, \',\' ORDER BY u): uuid order is text order here', () => {
    // uuid compares bytewise; lower-case hex text in the fixed 8-4-4-4-12 layout sorts the same way,
    // because '0'-'9' sort below 'a'-'f' in both. A key built in JS must equal the one a CHECK and a
    // unique index see, or a mix would be found by one side and not the other.
    const ids = ['ffffffff-0000-4000-8000-000000000000', '0fffffff-0000-4000-8000-000000000000',
      'a0000000-0000-4000-8000-000000000000', '9fffffff-0000-4000-8000-000000000000'];
    expect(blendKeyOf(ids.map((id) => ({ id }))).split(',')).toEqual([ids[1], ids[3], ids[2], ids[0]]);
  });
});

describe('judgeParentFacts — WHEN the rules apply', () => {
  it('never to fewer than two plantings, whatever they are', () => {
    expect(judgeParentFacts([A], [fact(A, null, null)])).toEqual({ applies: false });
    expect(judgeParentFacts([], [])).toEqual({ applies: false });
  });

  it('never to a request that adds nothing — a REMOVAL-ONLY request is not refused, however drifted the set', () => {
    // The lot had {A, B, C}; C is being taken out. A lost its variety after the jar was saved and B
    // is now a pepper (its planting was merged). Every rule is broken by what is LEFT, and none of
    // them may refuse: this request is how a drifted jar gets repaired.
    const rows = [fact(A, null, null, { member: true }), fact(B, CARMEN, 'pepper', { member: true })];
    expect(judgeParentFacts([A, B], rows)).toEqual({ applies: false });
    // The same set sent back unchanged is the same case: nothing is being added.
    const mixed = [fact(A, ALASKA, NASTURTIUM, { member: true }), fact(B, CARMEN, 'pepper', { member: true })];
    expect(judgeParentFacts([A, B], mixed)).toEqual({ applies: false });
  });

  it('to a set of two or more that adds at least one — even one, among members', () => {
    const rows = [fact(A, ALASKA, NASTURTIUM, { member: true }), fact(B, ALASKA, NASTURTIUM)];
    expect(judgeParentFacts([A, B], rows)).toEqual({ applies: true, blend: null });
  });

  it('`member` must be exactly true: a row that does not say so is a planting being added', () => {
    const rows = [fact(A, ALASKA, NASTURTIUM, { member: undefined }), fact(B, ALASKA, NASTURTIUM, { member: null })];
    expect(judgeParentFacts([A, B], rows).applies).toBe(true);
  });
});

describe('judgeParentFacts — parent_without_variety', () => {
  it('refuses a planting being ADDED that has no variety, and names it', () => {
    const rows = [fact(A, ALASKA, NASTURTIUM), fact(B, null, null)];
    expect(judgeParentFacts([A, B], rows)).toEqual({
      applies: true,
      refusal: { error: PARENT_WITHOUT_VARIETY, code: 'parent_without_variety', plant_id: B },
    });
  });

  it('names the FIRST such planting in the order the request gave', () => {
    const rows = [fact(A, null, null), fact(B, ALASKA, NASTURTIUM), fact(C, null, null)];
    expect(judgeParentFacts([C, B, A], rows).refusal.plant_id).toBe(C);
    expect(judgeParentFacts([A, B, C], rows).refusal.plant_id).toBe(A);
  });

  it('does NOT refuse for a MEMBER whose variety was cleared later — only what is being added is judged', () => {
    // R2-13. A is already a parent and lost its variety after the jar was saved. Adding B (which has
    // one) must go through: the jar's owner cannot fix A from here, and should not have to.
    const rows = [fact(A, null, null, { member: true }), fact(B, ALASKA, NASTURTIUM)];
    expect(judgeParentFacts([A, B], rows)).toEqual({ applies: true, blend: null });
  });

  it('…and that member is no crop of its own and no part of any mix', () => {
    // Two added plantings of two varieties beside the cleared member: one crop, and the mix is of
    // the two varieties that exist.
    const rows = [fact(A, null, null, { member: true }), fact(B, ALASKA, NASTURTIUM), fact(C, JEWEL, NASTURTIUM)];
    expect(judgeParentFacts([A, B, C], rows)).toEqual({
      applies: true, blend: { component_variety_ids: [ALASKA, JEWEL], key: MIX_KEY },
    });
  });

  it('outranks the crop rule: a planting with no variety has no crop to compare', () => {
    const rows = [fact(A, ALASKA, NASTURTIUM), fact(B, CARMEN, 'pepper'), fact(C, null, null)];
    expect(judgeParentFacts([A, B, C], rows).refusal.code).toBe('parent_without_variety');
  });

  it('an id the read returned NO row for is a planting being added with no variety — refused, never passed', () => {
    // The statement returns one row per id, so this is only ever a read that did not answer (a
    // driver hiccup, or a test stub that never stated what the planting is). Passing it would make
    // every rule vacuous.
    expect(judgeParentFacts([A, B], []).refusal).toMatchObject({ code: 'parent_without_variety', plant_id: A });
    expect(judgeParentFacts([A, B], [fact(A, ALASKA, NASTURTIUM)]).refusal).toMatchObject({ plant_id: B });
    expect(judgeParentFacts([A, B], undefined).refusal.code).toBe('parent_without_variety');
  });

  it('matches rows to ids case-insensitively, and answers the id lower-cased', () => {
    const rows = [fact(A.toUpperCase(), ALASKA, NASTURTIUM), fact(B.toUpperCase(), null, null)];
    expect(judgeParentFacts([A, B], rows).refusal.plant_id).toBe(B);
  });
});

describe('judgeParentFacts — mixed_crop_parents (NULL crop is ONE value of its own)', () => {
  const judge = (...rows) => judgeParentFacts(rows.map((r) => r.id), rows);

  it('refuses two crops', () => {
    expect(judge(fact(A, ALASKA, NASTURTIUM), fact(B, CARMEN, 'pepper'))).toEqual({
      applies: true, refusal: { error: MIXED_CROP_PARENTS, code: 'mixed_crop_parents' },
    });
  });

  it('CELL crop-less + crop-less: two varieties with no crop recorded are ONE crop', () => {
    // B2. count(DISTINCT) would also read these as one — and so would a strict comparison read them
    // as different. The decision: NULL equals NULL here. They pass this rule and go on to the mix.
    const out = judge(fact(A, ALASKA, null), fact(B, JEWEL, null));
    expect(out.refusal).toBeUndefined();
    expect(out.blend).toEqual({ component_variety_ids: [ALASKA, JEWEL], key: MIX_KEY });
  });

  it('CELL crop-less + a crop: NULL is not the wildcard — it differs from every named crop', () => {
    expect(judge(fact(A, ALASKA, null), fact(B, JEWEL, NASTURTIUM)).refusal.code).toBe('mixed_crop_parents');
    expect(judge(fact(A, ALASKA, NASTURTIUM), fact(B, JEWEL, null)).refusal.code).toBe('mixed_crop_parents');
  });

  it('CELL one crop-less variety on every planting: one variety, one crop, nothing to refuse', () => {
    expect(judge(fact(A, ALASKA, null), fact(B, ALASKA, null))).toEqual({ applies: true, blend: null });
  });

  it('undefined is NULL: a row that does not carry the key is a crop-less variety, not a third value', () => {
    const noKey = { id: B, cultivar_id: JEWEL, member: false };
    expect(judgeParentFacts([A, B], [fact(A, ALASKA, null), noKey]).refusal).toBeUndefined();
  });

  it('judges the WHOLE resulting set, not only what is added — a drifted member blocks an ADD of another crop', () => {
    // A is a member and is now a pepper. Adding a nasturtium makes a two-crop jar; that is refused.
    // (Removing A instead is the removal-only request, which is never refused — above.)
    const rows = [fact(A, CARMEN, 'pepper', { member: true }), fact(B, ALASKA, NASTURTIUM)];
    expect(judgeParentFacts([A, B], rows).refusal.code).toBe('mixed_crop_parents');
  });

  it('outranks the mix: two crops are not asked for a mix that could never be made', () => {
    expect(judge(fact(A, ALASKA, NASTURTIUM), fact(B, CARMEN, 'pepper')).blend).toBeUndefined();
  });
});

describe('judgeParentFacts — the mix a multi-variety set must be filed under', () => {
  const judge = (...rows) => judgeParentFacts(rows.map((r) => r.id), rows);

  it('none for one variety, however many plantings', () => {
    expect(judge(fact(A, ALASKA, NASTURTIUM), fact(B, ALASKA, NASTURTIUM), fact(C, ALASKA, NASTURTIUM)))
      .toEqual({ applies: true, blend: null });
  });

  it('the DISTINCT variety ids, in uuid order, and their key', () => {
    const out = judge(fact(A, JEWEL, NASTURTIUM), fact(B, ALASKA, NASTURTIUM), fact(C, JEWEL, NASTURTIUM));
    expect(out).toEqual({ applies: true, blend: { component_variety_ids: [ALASKA, JEWEL], key: MIX_KEY } });
  });

  it('FLATTENS a parent whose variety is an app-made mix: the components are as stored, the key is of the leaves', () => {
    // A was grown from last year's mixed jar, so its variety IS the mix of Alaska and Jewel. B is
    // an Empress. The jar spans two varieties {MIX, EMPRESS} — those are what the client is told,
    // and what it sends to the blend route — and the mix it must be filed under is keyed on the
    // three leaves.
    const out = judge(fact(A, MIX, NASTURTIUM, { blend_key: MIX_KEY }), fact(B, EMPRESS, NASTURTIUM));
    expect(out.blend.component_variety_ids).toEqual([EMPRESS, MIX].sort());
    expect(out.blend.key).toBe(`${ALASKA},${JEWEL},${EMPRESS}`);
  });

  it('a mix beside one of its own leaves flattens to the mix\'s OWN key — the lot may stay filed under that mix', () => {
    const out = judge(fact(A, MIX, NASTURTIUM, { blend_key: MIX_KEY }), fact(B, ALASKA, NASTURTIUM));
    expect(out.blend).toEqual({ component_variety_ids: [ALASKA, MIX], key: MIX_KEY });
  });

  it('two plantings of the SAME mix are one variety: no new mix is asked for', () => {
    expect(judge(fact(A, MIX, NASTURTIUM, { blend_key: MIX_KEY }), fact(B, MIX, NASTURTIUM, { blend_key: MIX_KEY })))
      .toEqual({ applies: true, blend: null });
  });
});

describe('readParentFacts — the one read the rules make before the transaction', () => {
  it('is one statement: a row per id, the planting through the household, membership through the caller\'s live seed lot', () => {
    const sql = fakeSql();
    readParentFacts(sql, { ids: [A, B], householdIds: HOUSE, lotId: LOT });
    expect(sql.calls).toHaveLength(1);
    expect(flat(sql.calls[0].text)).toBe(
      "SELECT q.plant_id AS id, p.cultivar_id, pv.crop_type_slug AS crop_slug, pv.blend_key, (k.plant_id IS NOT NULL) AS member, (i.id IS NOT NULL) AS lot_found, i.variety_id AS lot_variety_id FROM unnest(?::uuid[]) AS q(plant_id) LEFT JOIN public.inventory_items i ON i.id = ?::uuid AND i.created_by = ANY(?) AND i.deleted_at IS NULL AND i.category = 'seeds' LEFT JOIN public.seed_lot_parent_planting k ON k.inventory_item_id = i.id AND k.plant_id = q.plant_id AND k.role = 'seed_parent' AND k.deleted_at IS NULL LEFT JOIN public.garden_node p ON p.id = q.plant_id AND p.created_by = ANY(?) LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id");
    expect(sql.calls[0].values).toEqual([[A, B], LOT, HOUSE, HOUSE]);
  });

  it('LEFT JOINs everything onto the id list, so no id can go missing and none can be doubled', () => {
    const sql = fakeSql();
    readParentFacts(sql, { ids: [A, B], householdIds: HOUSE, lotId: LOT });
    const t = flat(sql.calls[0].text);
    expect(t.match(/\bJOIN\b/g)).toHaveLength(4);
    expect(t.match(/\bLEFT JOIN\b/g)).toHaveLength(4);
    // No WHERE: a predicate after the joins is how a LEFT JOIN quietly becomes an inner one.
    expect(t).not.toMatch(/\bWHERE\b/);
  });

  it('a soft-deleted VARIETY still counts, and so does a soft-deleted PLANTING that is already a parent', () => {
    const sql = fakeSql();
    readParentFacts(sql, { ids: [A], householdIds: HOUSE, lotId: LOT });
    const t = flat(sql.calls[0].text);
    expect(t).not.toMatch(/\bpv\.deleted_at\b/);
    expect(t).not.toMatch(/\bp\.deleted_at\b/);
  });

  it('on a create there is no lot: NULL is bound, so nothing is found and nothing is a member', () => {
    const sql = fakeSql();
    readParentFacts(sql, { ids: [A, B], householdIds: HOUSE });
    expect(sql.calls[0].values).toEqual([[A, B], null, HOUSE, HOUSE]);
  });
});

describe('checkParentRules — the fast path: null to go on, or the body of the 400', () => {
  // The fake answers the first statement (the facts) with `rows`, and any second (the mix) with `mix`.
  const run = async (opts, rows, mix = []) => {
    const sql = fakeSql((text, values, n) => (n === 1 ? rows : mix));
    const out = await checkParentRules(sql, { householdIds: HOUSE, ...opts });
    return { out, sql };
  };

  it('reads NOTHING for a set of fewer than two — the one-parent request costs what it always did', async () => {
    for (const ids of [[], [A]]) {
      const { out, sql } = await run({ ids, lotId: LOT }, [fact(A, null, null)]);
      expect(out).toBeNull();
      expect(sql.calls).toHaveLength(0);
    }
  });

  it('one read, and no more, when one variety covers the set', async () => {
    const { out, sql } = await run({ ids: [A, B], lotId: LOT }, [fact(A, ALASKA, NASTURTIUM), fact(B, ALASKA, NASTURTIUM)]);
    expect(out).toBeNull();
    expect(sql.calls).toHaveLength(1);
  });

  it('answers each refusal as the 400 body, with nothing else read', async () => {
    const bare = await run({ ids: [A, B], lotId: LOT }, [fact(A, ALASKA, NASTURTIUM), fact(B, null, null)]);
    expect(bare.out).toEqual({ error: PARENT_WITHOUT_VARIETY, code: 'parent_without_variety', plant_id: B });
    expect(bare.sql.calls).toHaveLength(1);
    const crops = await run({ ids: [A, B], lotId: LOT }, [fact(A, ALASKA, NASTURTIUM), fact(B, CARMEN, 'pepper')]);
    expect(crops.out).toEqual({ error: MIXED_CROP_PARENTS, code: 'mixed_crop_parents' });
    expect(crops.sql.calls).toHaveLength(1);
  });

  it('a REMOVAL-ONLY request is passed without a second read, whatever the set looks like', async () => {
    const rows = [fact(A, null, null, { member: true }), fact(B, CARMEN, 'pepper', { member: true })];
    const { out, sql } = await run({ ids: [A, B], lotId: LOT }, rows);
    expect(out).toBeNull();
    expect(sql.calls).toHaveLength(1);
  });

  it('a lot that is not the caller\'s live seed lot is NOT JUDGED: the write answers it 404', async () => {
    // Absent, foreign, deleted and not seeds all come back lot_found: false. "Already a parent" has
    // no meaning there, so every planting would look added and a perfectly good request to a lot
    // that is simply gone would be told to go and make a mix.
    const rows = [fact(A, ALASKA, NASTURTIUM, { lot_found: false, lot_variety_id: null }), fact(B, null, null, { lot_found: false, lot_variety_id: null })];
    const { out, sql } = await run({ ids: [A, B], lotId: LOT }, rows);
    expect(out).toBeNull();
    expect(sql.calls).toHaveLength(1);
    // …but a CREATE has no lot by construction, and IS judged.
    const create = await run({ ids: [A, B] }, rows);
    expect(create.out.code).toBe('parent_without_variety');
  });

  describe('blend_required', () => {
    const TWO = [fact(A, ALASKA, NASTURTIUM), fact(B, JEWEL, NASTURTIUM)];

    it('asks whether the lot is filed under a LIVE mix of the HOUSEHOLD with exactly that key', async () => {
      const { sql } = await run({ ids: [A, B], lotId: LOT, varietyId: MIX }, TWO, [{ id: MIX }]);
      expect(sql.calls).toHaveLength(2);
      expect(flat(sql.calls[1].text)).toBe(
        'SELECT fv.id FROM public.cultivar fv WHERE fv.id = ?::uuid AND fv.deleted_at IS NULL AND fv.created_by = ANY(?) AND fv.blend_key = ?');
      expect(sql.calls[1].values).toEqual([MIX, HOUSE, MIX_KEY]);
    });

    it('passes when it is', async () => {
      expect((await run({ ids: [A, B], lotId: LOT, varietyId: MIX }, TWO, [{ id: MIX }])).out).toBeNull();
    });

    it('refuses when it is not, with the DISTINCT varieties to make the mix from — and nothing about why', async () => {
      // Not live, not the household's, a different mix, or not a mix at all: one answer. The client
      // needs the ids to send to the blend route, and nothing else here is its to act on.
      const { out } = await run({ ids: [A, B], lotId: LOT, varietyId: EMPRESS }, TWO, []);
      expect(out).toEqual({ error: BLEND_REQUIRED, code: 'blend_required', component_variety_ids: [ALASKA, JEWEL] });
    });

    it('judges the variety the request NAMES when it names one (POST, or a filing), else the lot\'s stored one', async () => {
      const named = await run({ ids: [A, B], lotId: LOT, varietyId: MIX }, TWO, [{ id: MIX }]);
      expect(named.sql.calls[1].values[0]).toBe(MIX);
      // No variety in the request: the lot's own, as the read returned it (ALASKA in these rows).
      const stored = await run({ ids: [A, B], lotId: LOT }, TWO, []);
      expect(stored.sql.calls[1].values[0]).toBe(ALASKA);
      expect(stored.out.code).toBe('blend_required');
    });

    it('a parent filed under an app-made mix: the key asked for is the FLATTENED one', async () => {
      const rows = [fact(A, MIX, NASTURTIUM, { blend_key: MIX_KEY }), fact(B, EMPRESS, NASTURTIUM)];
      const { out, sql } = await run({ ids: [A, B], lotId: LOT, varietyId: MIX }, rows, []);
      expect(sql.calls[1].values[2]).toBe(`${ALASKA},${JEWEL},${EMPRESS}`);
      // Filed under the two-way mix, which is not the three-way one: refused, with the two
      // varieties AS STORED (the blend route flattens them itself).
      expect(out).toEqual({ error: BLEND_REQUIRED, code: 'blend_required', component_variety_ids: [EMPRESS, MIX].sort() });
    });

    it('…and a mix beside one of its own leaves is satisfied by that mix', async () => {
      const rows = [fact(A, MIX, NASTURTIUM, { blend_key: MIX_KEY }), fact(B, ALASKA, NASTURTIUM)];
      const { out, sql } = await run({ ids: [A, B], lotId: LOT, varietyId: MIX }, rows, [{ id: MIX }]);
      expect(sql.calls[1].values).toEqual([MIX, HOUSE, MIX_KEY]);
      expect(out).toBeNull();
    });

    it('a variety id that is not a uuid, or none at all, is refused WITHOUT being sent to Postgres', async () => {
      for (const varietyId of ['not-a-uuid', 7, '']) {
        const { out, sql } = await run({ ids: [A, B], varietyId }, TWO.map((r) => ({ ...r, lot_found: false, lot_variety_id: null })), [{ id: MIX }]);
        expect(out.code, String(varietyId)).toBe('blend_required');
        expect(sql.calls, String(varietyId)).toHaveLength(1);
      }
      const none = await run({ ids: [A, B] }, TWO.map((r) => ({ ...r, lot_found: false, lot_variety_id: null })), [{ id: MIX }]);
      expect(none.out.code).toBe('blend_required');
      expect(none.sql.calls).toHaveLength(1);
    });
  });
});

describe('judgeParentRules — the same rules, as the statement the transaction places', () => {
  const build = (opts = {}) => {
    const sql = fakeSql();
    judgeParentRules(sql, { lotId: LOT, ids: [A, B], householdIds: HOUSE, ...opts });
    expect(sql.calls).toHaveLength(1);
    return sql.calls[0];
  };

  it('fewer than two plantings: it names NO table — it only passes the verdict on, or starts it', () => {
    for (const ids of [[], [A]]) {
      const call = build({ ids, alone: true });
      expect(flat(call.text)).toBe(
        "SELECT TRUE AS rules_hold, set_config('app.seed_lot_go', CASE WHEN ?::boolean OR current_setting('app.seed_lot_go', true) = 'go' THEN 'go' ELSE 'stop' END, true) AS go");
      expect(call.values).toEqual([true]);
    }
    expect(build({ ids: [A] }).values).toEqual([false]);
  });

  it('answers rules_hold and go, and writes nothing', () => {
    const call = build();
    const t = flat(call.text);
    expect(t).toMatch(/^SELECT r\.rules_hold, set_config\('app\.seed_lot_go', /);
    expect(call.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(call.text).not.toMatch(/FOR (UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)/);
  });

  it('can only take go AWAY: go needs the rules to hold AND everything judged before it to have said go', () => {
    const call = build();
    expect(flat(call.text)).toContain(
      "CASE WHEN r.rules_hold AND (?::boolean OR current_setting('app.seed_lot_go', true) = 'go') THEN 'go' ELSE 'stop' END, true) AS go");
    // On the set route nothing may start the verdict here: the facts read did.
    expect(boundAfter(call, /AND \(/)).toBe(false);
    // On a create it is the first judge, so it starts it.
    expect(boundAfter(build({ alone: true }), /AND \(/)).toBe(true);
    // Transaction-local: is_local = true, and the one setting this module ever names.
    expect(call.text.match(/set_config\('app\.seed_lot_go',[\s\S]*?, true\) AS go/g)).toHaveLength(1);
  });

  it('the rule itself: nothing added, or — no added planting without a variety, at most one crop, and one variety or the lot filed as their mix', () => {
    expect(flat(build().text)).toContain(
      'SELECT (cardinality(?::uuid[]) < 2 OR m.added = 0 OR (m.added_bare = 0 AND m.crops <= 1 AND (m.cultivars < 2 OR m.filed_as_mix))) AS rules_hold');
  });

  it('ADDED = a requested id that is not already a live seed_parent of THIS lot', () => {
    const t = flat(build().text);
    expect(t).toContain(
      "(SELECT count(*) FROM unnest(?::uuid[]) AS q(plant_id) WHERE NOT EXISTS ( SELECT 1 FROM public.seed_lot_parent_planting k WHERE k.inventory_item_id = i.id AND k.plant_id = q.plant_id AND k.role = 'seed_parent' AND k.deleted_at IS NULL)) AS added");
    // …and "added with no variety" is that same test with the planting's variety missing — a
    // planting the household cannot see reads as having none.
    expect(t).toContain(
      "(SELECT count(*) FROM unnest(?::uuid[]) AS q(plant_id) LEFT JOIN public.garden_node p ON p.id = q.plant_id AND p.created_by = ANY(?) WHERE p.cultivar_id IS NULL AND NOT EXISTS ( SELECT 1 FROM public.seed_lot_parent_planting k WHERE k.inventory_item_id = i.id AND k.plant_id = q.plant_id AND k.role = 'seed_parent' AND k.deleted_at IS NULL)) AS added_bare");
  });

  it('CROPS = the DISTINCT crop of the set\'s varieties, counted as rows — so NULL is one value of its own', () => {
    // count(DISTINCT x) would SKIP the NULLs (a crop-less variety beside a tomato would read as one
    // crop). SELECT DISTINCT keeps one NULL row, and count(*) over the rows counts it.
    const t = flat(build().text);
    expect(t).toContain(
      '(SELECT count(*) FROM (SELECT DISTINCT pv.crop_type_slug FROM public.garden_node p JOIN public.cultivar pv ON pv.id = p.cultivar_id WHERE p.id = ANY(?::uuid[]) AND p.created_by = ANY(?)) d) AS crops');
    expect(t).not.toMatch(/count\(DISTINCT pv\.crop_type_slug\)/);
    // An INNER join to the variety: a planting with none contributes no crop (the member whose
    // variety was cleared), exactly as in judgeParentFacts.
    expect(t).not.toMatch(/LEFT JOIN public\.cultivar/);
  });

  it('CULTIVARS = the distinct varieties of the set (a missing one is not counted)', () => {
    expect(flat(build().text)).toContain(
      '(SELECT count(DISTINCT p.cultivar_id) FROM public.garden_node p WHERE p.id = ANY(?::uuid[]) AND p.created_by = ANY(?)) AS cultivars');
  });

  it('FILED AS MIX = the lot\'s variety after this request is a live household variety keyed on the FLATTENED leaves', () => {
    const call = build({ varietyId: MIX });
    const t = flat(call.text);
    expect(t).toContain(
      'EXISTS ( SELECT 1 FROM public.cultivar fv WHERE fv.id = COALESCE(?::uuid, i.variety_id) AND fv.deleted_at IS NULL AND fv.created_by = ANY(?) AND fv.blend_key = (');
    // The key, built as blendKeyOf builds it: a variety with no key is its own leaf, one with a key
    // contributes that key's ids; distinct; uuid order; comma-joined.
    expect(t).toContain(
      "SELECT string_agg(f.leaf::text, ',' ORDER BY f.leaf) FROM (SELECT DISTINCT u.leaf FROM public.garden_node p JOIN public.cultivar pv ON pv.id = p.cultivar_id CROSS JOIN LATERAL unnest( CASE WHEN pv.blend_key IS NULL THEN ARRAY[pv.id] ELSE string_to_array(pv.blend_key, ',')::uuid[] END) AS u(leaf) WHERE p.id = ANY(?::uuid[]) AND p.created_by = ANY(?)) f)) AS filed_as_mix");
    // The request's variety when it names one; NULL reads the lot row's own.
    expect(boundAfter(call, /fv\.id = COALESCE\(/)).toBe(MIX);
    expect(boundAfter(build(), /fv\.id = COALESCE\(/)).toBeNull();
  });

  it('a soft-deleted variety still counts for a PLANTING; only the variety the lot is filed under must be live', () => {
    const t = flat(build().text);
    expect(t).not.toMatch(/\bpv\.deleted_at\b/);
    expect(t).not.toMatch(/\bp\.deleted_at\b/);
    expect(t.match(/\bfv\.deleted_at IS NULL\b/g)).toHaveLength(1);
  });

  it('reads the lot through the whole lot predicate — no row, and no verdict, for a lot that is not the caller\'s live seed lot', () => {
    const call = build();
    expect(flat(call.text)).toMatch(/FROM public\.inventory_items i WHERE i\.id = \? AND i\.created_by = ANY\(\?\) AND i\.deleted_at IS NULL AND i\.category = 'seeds' \) m \) r$/);
    expect(boundAfter(call, /WHERE i\.id = /)).toBe(LOT);
  });

  it('binds the set and the household everywhere it reads them, and nothing else', () => {
    const call = build({ varietyId: MIX, alone: true });
    // alone; the rule's own cardinality; added; added_bare (ids, household); crops (ids, household);
    // cultivars (ids, household); the filed variety and its household; the leaves (ids, household);
    // the lot and the household.
    expect(call.values).toEqual([
      true, [A, B], [A, B], [A, B], HOUSE, [A, B], HOUSE, [A, B], HOUSE, MIX, HOUSE, [A, B], HOUSE, LOT, HOUSE,
    ]);
  });
});
