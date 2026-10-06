// V5-SEEDMULTIPARENT-001 (release 2a) — "about how many plants did this seed come from?"
// inventory_items.seed_parent_plant_count, written by PUT /api/inventory-items/:id/seed-measure and
// by NOTHING else. Driven through the handler.
//
// THE RULE (R2A-CONTRACT section 3): a fourth presence-guarded key on /seed-measure. A whole number
// from 1 to 9999, or null to clear; anything else is a 400 with a sentence. Echoed in the reply.
// Both of its CHECKs have a sentence in the constraint map.
//
// WHY ONE WRITER. POST names its INSERT columns one by one, so a key it did not name would answer
// 201 with the value dropped; the wide PUT is the verb every caller round-trips a stale row into.
// /seed-measure reads its keys by presence and returns what it wrote — so a caller holding a 200
// WITHOUT the key knows it reached a Lambda that predates the column and nothing was saved
// (data-schema seat S8).
//
// THE STUB EXECUTES NO SQL. The range is answered in JavaScript (below), so every refusal here is
// real. What is NOT shown: that the column and its two CHECKs exist, that an untyped NULL binds
// against an integer column in the CASE, and that a lot carrying the number refuses to leave Seeds
// with the mapped sentence. Those are the integration lane's, and listed in the lane report.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { handler, validateUpdate, validateCreate, SEED_CONSTRAINT_MESSAGES } = await import('./index.js');

const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const USER = 'user_stub_owner';
const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';
const VARIETY = 'd58b5155-0c23-4365-bfad-30549b8ca069';

const req = (method, path, body) => ({
  requestContext: { http: { method } }, rawPath: path,
  headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify(body),
});
const measure = (body, id = ITEM) => req('PUT', `/api/inventory-items/${id}/seed-measure`, body);
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });

const boundAfter = (call, re) => {
  const m = call.text.match(re);
  expect(m, `SQL does not match ${re}`).toBeTruthy();
  const end = m.index + m[0].length;
  expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
  return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
};
const updateCall = () => {
  const c = stubState.sqlCalls.find((k) => /UPDATE public\.inventory_items/.test(k.text));
  expect(c, `no UPDATE was issued; statements: ${stubState.sqlCalls.length}`).toBeTruthy();
  return c;
};
const FLAG = /seed_parent_plant_count = CASE\s+WHEN /;
const VALUE = /seed_parent_plant_count = CASE\s+WHEN \?\s+THEN /;
const SENTENCE = 'seed_parent_plant_count must be a whole number of plants from 1 to 9999, or null';

// What the UPDATE's RETURNING hands back: the lot as stored after the write.
const stored = (seed_parent_plant_count) => {
  stubState.sqlHandler = () => [{
    id: ITEM, seed_count: 185, seed_weight_g: '0.500', seed_count_estimated: false, seed_parent_plant_count,
  }];
};

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  stored(null);
});

describe('PUT /:id/seed-measure — seed_parent_plant_count, the values', () => {
  it('writes a whole number of plants and ECHOES it', async () => {
    stored(6);
    const res = parse(await handler(measure({ seed_parent_plant_count: 6 })));
    expect(res.status).toBe(200);
    expect(res.body.seed_parent_plant_count).toBe(6);
    // The four measurements and the id — the echo is part of the contract, not a courtesy.
    expect(Object.keys(res.body).sort())
      .toEqual(['id', 'seed_count', 'seed_count_estimated', 'seed_parent_plant_count', 'seed_weight_g']);
    const update = updateCall();
    expect(boundAfter(update, FLAG)).toBe(true);
    expect(boundAfter(update, VALUE)).toBe(6);
    expect(update.text).toMatch(/RETURNING id, seed_count, seed_weight_g, seed_count_estimated, seed_parent_plant_count\s*$/);
  });

  it('accepts the bounds: 1 and 9999', async () => {
    for (const n of [1, 9999]) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stored(n);
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(measure({ seed_parent_plant_count: n })));
      expect(res.status, String(n)).toBe(200);
      expect(boundAfter(updateCall(), VALUE), String(n)).toBe(n);
    }
  });

  // One sentence for every value that is not a whole number from 1 to 9999. Each row is a cell the
  // QA seat named (M1); none of them reaches the database.
  const REFUSED = [
    [0, 'zero — "no plants" is not a seed lot, and not a measurement of one'],
    [-1, 'negative'],
    [-250, 'negative, far'],
    [2.5, 'a fraction of a plant'],
    [1.0000001, 'a fraction, barely'],
    ['3', 'a numeric STRING — "3" and 3 must not be two spellings of one write'],
    ['', 'an empty string'],
    ['six', 'a word'],
    [10000, 'past the sanity cap'],
    [1e9, 'far past it'],
    [true, 'a boolean'],
    [[3], 'an array'],
    [{ n: 3 }, 'an object'],
  ];
  for (const [value, why] of REFUSED) {
    it(`400s ${JSON.stringify(value)} with the sentence, before any SQL — ${why}`, async () => {
      const res = parse(await handler(measure({ seed_parent_plant_count: value })));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: SENTENCE });
      expect(stubState.sqlCalls, 'a refused value reached the database').toHaveLength(0);
    });
  }

  it('answers the range ITSELF, as a sentence — never the positive CHECK\'s 23514', async () => {
    // Unlike seed_count, whose `>= 0` is left to its CHECK on purpose (0 seeds is a measured fact).
    // Here 0 is not a value at all, so the route answers every out-of-range number the same way.
    for (const n of [0, -1, 10000]) {
      resetStubs();
      stubState.verifyTokenResult = { sub: USER };
      stubState.sqlHandler = () => { throw Object.assign(new Error('check'), { code: '23514', constraint: 'chk_inventory_seed_parent_plant_count_positive' }); };
      // eslint-disable-next-line no-await-in-loop
      const res = parse(await handler(measure({ seed_parent_plant_count: n })));
      expect(res.body.error, String(n)).toBe(SENTENCE);
      expect(stubState.sqlCalls).toHaveLength(0);
    }
  });

  it('NULL CLEARS: the flag is on and NULL is what is bound', async () => {
    stored(null);
    const res = parse(await handler(measure({ seed_parent_plant_count: null })));
    expect(res.status).toBe(200);
    expect(res.body.seed_parent_plant_count).toBeNull();
    const update = updateCall();
    expect(boundAfter(update, FLAG)).toBe(true);
    expect(boundAfter(update, VALUE)).toBeNull();
  });

  it('ABSENT leaves the stored number alone: the flag is off and the ELSE arm re-reads the column', async () => {
    stored(6);
    const res = parse(await handler(measure({ seed_weight_g: 0.5 })));
    expect(res.status).toBe(200);
    // Still echoed — whatever the lot holds.
    expect(res.body.seed_parent_plant_count).toBe(6);
    const update = updateCall();
    expect(update.text).toMatch(/seed_parent_plant_count = CASE\s+WHEN \? THEN \?\s+ELSE seed_parent_plant_count\s+END/);
    expect(boundAfter(update, FLAG)).toBe(false);
  });

  it('is independent of the count/basis pair: sent alone it costs ONE statement, and no pairing read', async () => {
    stored(4);
    const res = parse(await handler(measure({ seed_parent_plant_count: 4 })));
    expect(res.status).toBe(200);
    expect(stubState.sqlCalls).toHaveLength(1);
    const update = updateCall();
    // The other three flags are off: this body moved nothing else.
    expect(boundAfter(update, /SET seed_count = CASE\s+WHEN /)).toBe(false);
    expect(boundAfter(update, /seed_weight_g = CASE\s+WHEN /)).toBe(false);
    expect(boundAfter(update, /seed_count_estimated = CASE\s+WHEN /)).toBe(false);
  });

  it('rides beside the other three in one write', async () => {
    stored(12);
    const res = parse(await handler(measure({
      seed_count: 185, seed_count_estimated: false, seed_weight_g: 0.5, seed_parent_plant_count: 12,
    })));
    expect(res.status).toBe(200);
    const update = updateCall();
    expect(boundAfter(update, /SET seed_count = CASE\s+WHEN \?\s+THEN /)).toBe(185);
    expect(boundAfter(update, VALUE)).toBe(12);
  });

  it('a bad plant count is refused even beside a good measurement — nothing is half-written', async () => {
    const res = parse(await handler(measure({ seed_weight_g: 0.5, seed_parent_plant_count: 0 })));
    expect(res.status).toBe(400);
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('404s a lot that is absent, foreign, deleted or not seeds — the route\'s own predicate', async () => {
    stubState.sqlHandler = () => [];
    const res = parse(await handler(measure({ seed_parent_plant_count: 3 })));
    expect(res.status).toBe(404);
    const { text } = updateCall();
    expect(text).toMatch(/created_by = ANY\(\?\)/);
    expect(text).toContain('deleted_at IS NULL');
    expect(text).toContain("category = 'seeds'");
  });
});

describe('seed_parent_plant_count — its two CHECKs read as sentences', () => {
  const NAMES = [
    'chk_inventory_seed_parent_plant_count_seeds_only',
    'chk_inventory_seed_parent_plant_count_positive',
  ];

  it('both names are in the constraint map, and neither sentence names a column or a constraint', () => {
    for (const name of NAMES) {
      expect(SEED_CONSTRAINT_MESSAGES[name], name).toEqual(expect.any(String));
      expect(SEED_CONSTRAINT_MESSAGES[name], name).not.toMatch(/chk_|seed_parent_plant_count|_id\b/);
    }
    // The seeds-only sentence says what to do about it.
    expect(SEED_CONSTRAINT_MESSAGES[NAMES[0]]).toMatch(/stay in Seeds/);
    expect(SEED_CONSTRAINT_MESSAGES[NAMES[0]]).toMatch(/Clear that number first/);
  });

  it('are the names migrations/v5-seedplantcount-001 creates — a renamed constraint would leave the map dead', () => {
    // put-seed-provenance-guard.test.js sweeps EVERY key of the map against migrations/; these two
    // are also pinned to their own migration, so the map cannot be satisfied by a namesake elsewhere.
    const ddl = readFileSync(resolve(__dirname, '../../migrations/v5-seedplantcount-001/0a-additive-ddl.sql'), 'utf8');
    for (const name of NAMES) expect(ddl, name).toMatch(new RegExp(`ADD CONSTRAINT\\s+${name}\\b`));
    expect(ddl).toMatch(/seed_parent_plant_count\s+integer/i);
  });

  it('recategorising a lot that carries the number answers the seeds-only sentence, from the wide PUT', async () => {
    // The wide PUT never names the column, so its body cannot be what trips the CHECK — the STORED
    // value is. The catch block maps the constraint's name to the sentence.
    stubState.sqlHandler = () => {
      throw Object.assign(new Error('new row violates check constraint'), {
        code: '23514', constraint: 'chk_inventory_seed_parent_plant_count_seeds_only',
      });
    };
    const res = parse(await handler(req('PUT', `/api/inventory-items/${ITEM}`, {
      name: 'Nasturtium 2026', type: 'consumable', category: 'tools', status: 'active', unit: 'packet', quantity_on_hand: 1,
    })));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(SEED_CONSTRAINT_MESSAGES.chk_inventory_seed_parent_plant_count_seeds_only);
  });
});

describe('seed_parent_plant_count — /seed-measure is its ONLY writer', () => {
  const putBranch = (() => {
    const start = SRC.indexOf("if (method === 'PUT')");
    return SRC.slice(start, SRC.indexOf("if (method === 'DELETE')", start));
  })();

  it('the wide PUT never mentions it — not in its SET list, not anywhere in the arm', () => {
    expect(putBranch).toContain('UPDATE inventory_items SET');
    expect(putBranch).not.toMatch(/\bseed_parent_plant_count\b/);
  });

  it('…so a wide PUT body carrying it binds it nowhere, and answers 200', async () => {
    stubState.sqlHandler = (text) => (/UPDATE inventory_items SET/.test(text)
      ? [{ id: ITEM, name: 'Nasturtium 2026', category: 'seeds', seed_parent_plant_count: 6 }]
      : []);
    const res = parse(await handler(req('PUT', `/api/inventory-items/${ITEM}`, {
      name: 'Nasturtium 2026', type: 'consumable', category: 'seeds', status: 'active', unit: 'packet', quantity_on_hand: 1,
      seed_parent_plant_count: 4321,
    })));
    expect(res.status).toBe(200);
    for (const c of stubState.sqlCalls) expect(c.values).not.toContain(4321);
    // The stored number rides back in RETURNING *, so the client's cached row keeps it.
    expect(res.body.seed_parent_plant_count).toBe(6);
  });

  it('the POST INSERT column list never mentions it', () => {
    const start = SRC.indexOf('INSERT INTO inventory_items (');
    const insert = SRC.slice(start, SRC.indexOf(') RETURNING *', start));
    expect(insert).toContain('user_id, created_by');
    expect(insert).not.toMatch(/\bseed_parent_plant_count\b/);
  });

  it('…so a POST body carrying it binds it nowhere', async () => {
    stubState.sqlHandler = () => [{ id: 'new-item', category: 'seeds', seed_parent_plant_count: null }];
    const res = parse(await handler(req('POST', '/api/inventory-items', {
      name: 'Nasturtium 2026', type: 'consumable', category: 'seeds', unit: 'packet', quantity_on_hand: 1,
      variety_id: VARIETY, seed_parent_plant_count: 4321,
    })));
    expect(res.status).toBe(201);
    for (const c of stubState.sqlCalls) expect(c.values).not.toContain(4321);
    // The honest answer for a create: the column is NULL until /seed-measure writes it.
    expect(res.body.seed_parent_plant_count).toBeNull();
  });

  it('neither validator looks at it: an API caller is not told a field name the verb ignores', () => {
    expect(validateCreate({ name: 'x', type: 'durable', category: 'tools', quantity: 1, seed_parent_plant_count: 3 })).toBeNull();
    expect(validateUpdate({ category: 'tools', seed_parent_plant_count: 3 })).toBeNull();
  });

  it('is named by exactly ONE statement in this directory', () => {
    const naming = ['index.js', 'seed-lot-parents.js', 'seed-lot-rules.js', 'seed-lot-filing.js', 'delete-guard.js']
      .flatMap((f) => {
        const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
        return [...src.matchAll(/sql`[^`]*`/g)].map((m) => m[0]).filter((s) => /seed_parent_plant_count/.test(s)).map(() => f);
      });
    expect(naming).toEqual(['index.js']);
  });

  it('is read by PRESENCE in the route, which is what the Saved seeds strip list keys on', () => {
    // src/__tests__/SavedSeeds.storedCount.test.jsx finds this idiom and requires the key in that
    // page's strip list (QA seat I15c). Reading it any other way here would leave the list row free
    // to carry a stale number into a verb that — today — ignores it.
    expect(SRC).toMatch(/const hasPlantCount = Object\.prototype\.hasOwnProperty\.call\(body, 'seed_parent_plant_count'\);/);
  });
});
