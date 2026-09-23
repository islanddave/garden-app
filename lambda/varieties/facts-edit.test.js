// V5-VARIETYFACTSEDIT-001 — the varieties PUT edits origin, breeding and heat source.
//
// Dave's ledger words: "Variety editor: add origin country/region, breeding and heat source. Today
// none is editable, and an edited Scoville figure keeps its 'est.' mark until the source changes."
// The seed card prints "est." on a heat figure when scoville_source = 'inference' (varietySpec.js
// shuLabel), and until this change no PUT body could name that column — so correcting the numbers
// left the mark standing, and origin and breeding, shown on the same card, could not be corrected.
//
// WHY THESE RUN THE HANDLER, per source-routes.test.js: the pairing rule is a DECISION taken between
// a read and a write, and no regex over the source can see which branch a given body takes. The mock
// is that file's mock verbatim (the shared stub has no sql.transaction).
//
// WHAT THESE DO NOT PROVE: this is mock SQL. That Postgres accepts the five arms, that the live
// CHECKs agree with breedingPairingError, and that the values round-trip through public.cultivar is
// tests/integration/variety-facts-edit.int.test.js, which CI runs against a real branch.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import {
  normalizeOriginText, touchesBreeding, breedingPairingError, fillsCultivarRank, validateBody,
  VALID_BREEDING_SYSTEM, VALID_FACT_SOURCE, RANK_WORDS, CONSTRAINT_MESSAGES,
} from './validate.js';

vi.mock('@neondatabase/serverless', async () => {
  const { stubState: state } = await import('../_test-stubs/state.js');
  return {
    neon: () => {
      const tagged = async (strings, ...values) => {
        const text = Array.isArray(strings) ? strings.join('?') : String(strings);
        state.sqlCalls.push({ text, values });
        return state.sqlHandler(text, values);
      };
      // Each element is an already-running statement promise, so ordering in sqlCalls matches the
      // order the statements appear in the transaction array.
      tagged.transaction = (stmts) => Promise.all(stmts);
      return tagged;
    },
  };
});

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const VARIETY_ID = '5bbc762a-7d19-4a6a-8ddc-f191329d9c68';
const FIVE = ['origin_country', 'origin_region', 'breeding_system', 'breeding_source', 'scoville_source'];

const isRateLimit = (t) => t.includes('INSERT INTO public.rate_limit_buckets');
const isSetConfig = (t) => t.includes('set_config');
const isPreflight = (t) => /SELECT breeding_system, breeding_source, variety_rank\s+FROM public\.cultivar/.test(t);
const isUpdate = (t) => t.includes('UPDATE public.cultivar SET');

// `current` is what the preflight reads. null = no row the caller may edit (foreign, gone, deleted).
const EMPTY_ROW = { breeding_system: null, breeding_source: null, variety_rank: null };
function db({ current = EMPTY_ROW } = {}) {
  stubState.sqlHandler = (text) => {
    if (isRateLimit(text)) return [{ count: 1 }];
    if (isSetConfig(text)) return [{}];
    if (isPreflight(text)) return current ? [current] : [];
    if (isUpdate(text)) return [{ id: VARIETY_ID, name: 'Ghost' }];
    return [];
  };
}

const put = async (body) => {
  const res = await handler({
    requestContext: { http: { method: 'PUT' } },
    rawPath: `/api/varieties/${VARIETY_ID}`,
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};

const calls = (pred) => stubState.sqlCalls.filter((c) => pred(c.text));
const updateCall = () => {
  const [u] = calls(isUpdate);
  if (!u) throw new Error('the PUT issued no UPDATE');
  return u;
};
// Binds are positional, so a value is tied to its column by the SQL that FOLLOWS its placeholder:
// the keep branch reads `COALESCE(?, <col>)`, the clear arm `CASE WHEN ? @> ARRAY['<col>']`.
function bindAfter(prefix) {
  const call = updateCall();
  const parts = call.text.split('?');
  const i = parts.findIndex((p, idx) => idx > 0 && p.startsWith(prefix));
  if (i < 1) throw new Error(`no placeholder followed by ${JSON.stringify(prefix)}`);
  return call.values[i - 1];
}
const keepBind = (col) => bindAfter(`, ${col})`);
const clearBind = (col) => bindAfter(` @> ARRAY['${col}']`);
// The variety_rank arm's one bind: true only when this PUT records Open-pollinated on a NULL rank.
const fillBind = () => bindAfter('::boolean AND variety_rank IS NULL');
// Dave reads these verbatim in the editor's error banner (2026-09-21: plain English, no columns).
const COLUMN_WORDS = /breeding_system|breeding_source|variety_rank|open_pollinated|market_class|cultivar\b/;

beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  db();
});

// ── anti-vacuity: the helpers above really do address the five arms ────────────────────────────

describe('the UPDATE carries an arm for each of the five columns', () => {
  it('finds a keep bind and a clear arm for every one of them', async () => {
    expect((await put({ care_notes: 'x' })).status).toBe(200);
    for (const col of FIVE) {
      expect(keepBind(col), `${col} keep bind`).toBeNull();
      expect(clearBind(col), `${col} clear arm`).toEqual([]);
    }
  });

  it('carries the variety_rank fill arm, off for a PUT that is not about breeding', async () => {
    expect((await put({ care_notes: 'x' })).status).toBe(200);
    expect(updateCall().text).toMatch(/variety_rank\s+= CASE WHEN \?::boolean AND variety_rank IS NULL THEN 'cultivar' ELSE variety_rank END/);
    expect(fillBind()).toBe(false);
  });
});

// ── accept ──────────────────────────────────────────────────────────────────────────────────────

describe('PUT accepts each column', () => {
  it.each([
    ['origin_country', 'Italy'],
    ['origin_region', 'Liguria'],
    ['scoville_source', 'packet_label'],
    // A source-only edit: no breeding call on the row and none in the body, so nothing to pair.
    ['breeding_source', 'breeder'],
  ])('%s = %s is written through its COALESCE arm', async (col, value) => {
    const res = await put({ [col]: value });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(keepBind(col)).toBe(value);
    expect(clearBind(col)).not.toContain(col);
  });

  it('breeding_system is written when its source travels with it', async () => {
    const res = await put({ breeding_system: 'f1', breeding_source: 'packet_label' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(keepBind('breeding_system')).toBe('f1');
    expect(keepBind('breeding_source')).toBe('packet_label');
  });

  it('every value of both vocabularies is accepted by the validator', () => {
    for (const v of VALID_BREEDING_SYSTEM) {
      expect(validateBody({ breeding_system: v }, { requireName: false }), v).toBeNull();
    }
    for (const v of VALID_FACT_SOURCE) {
      expect(validateBody({ breeding_source: v, scoville_source: v }, { requireName: false }), v).toBeNull();
    }
  });

  it('origin text is trimmed before it is bound', async () => {
    expect((await put({ origin_country: '  Italy  ', origin_region: '\tLiguria\n' })).status).toBe(200);
    expect(keepBind('origin_country')).toBe('Italy');
    expect(keepBind('origin_region')).toBe('Liguria');
  });
});

// ── clear ───────────────────────────────────────────────────────────────────────────────────────

describe('PUT clears each column', () => {
  it.each(FIVE)('clear:[%s] reaches the CASE arm and binds no value', async (col) => {
    const res = await put({ clear: [col] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(clearBind(col)).toContain(col);
    expect(keepBind(col)).toBeNull();
  });

  it.each(['origin_country', 'origin_region'])('a blank %s is a clear, not an empty string stored', async (col) => {
    const res = await put({ [col]: '   ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(clearBind(col)).toContain(col);
    expect(keepBind(col)).toBeNull();
  });

  it('blank origin text AND the same key in clear is one request, not "both cleared and set"', async () => {
    const res = await put({ origin_country: '', clear: ['origin_country'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(clearBind('origin_country').filter((k) => k === 'origin_country')).toHaveLength(1);
  });

  it('a real origin value AND the same key in clear is still refused as ambiguous', async () => {
    const res = await put({ origin_country: 'Italy', clear: ['origin_country'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/origin_country cannot be both cleared and set/);
  });
});

// ── refuse: unknown values ─────────────────────────────────────────────────────────────────────

describe('an unknown value is a 400 that names the field', () => {
  it.each([
    ['breeding_system', 'hybrid'],
    ['breeding_system', 'f2_or_later'],
    ['breeding_source', 'seed_packet'],
    ['scoville_source', 'estimate'],
    ['scoville_source', 'vendor_blanket'],
  ])('%s = %s', async (col, value) => {
    const body = col === 'breeding_system' ? { [col]: value, breeding_source: 'breeder' } : { [col]: value };
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(`^${col} must be one of: `));
    expect(calls(isUpdate)).toHaveLength(0);
  });

  it.each(['origin_country', 'origin_region'])('a non-string %s', async (col) => {
    const res = await put({ [col]: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${col} must be a string or null`);
    expect(calls(isUpdate)).toHaveLength(0);
  });
});

// ── refuse: origin text longer than a place name ────────────────────────────────────────────────

// 120 characters, like genus, counted after the trim. The numbers are literal on purpose: a test built
// from the validator's own cap would move with a wrong cap and still pass.
describe('origin text is capped at 120 characters, counted after the trim', () => {
  const X120 = 'x'.repeat(120);

  it.each(['origin_country', 'origin_region'])('%s of exactly 120 characters is written', async (col) => {
    const res = await put({ [col]: X120 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(keepBind(col)).toBe(X120);
  });

  it.each(['origin_country', 'origin_region'])('%s of 121 characters is a 400 and nothing is written', async (col) => {
    const res = await put({ [col]: `${X120}y` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${col} must be <= 120 characters`);
    expect(calls(isUpdate)).toHaveLength(0);
  });

  it.each(['origin_country', 'origin_region'])('padding around 120 characters of %s does not count', async (col) => {
    const res = await put({ [col]: `  ${X120}\t\n` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(keepBind(col)).toBe(X120);
    // validateBody alone — the POST path, which does not trim first — counts the same way.
    expect(validateBody({ [col]: `   ${X120}   ` }, { requireName: false })).toBeNull();
    expect(validateBody({ [col]: `   ${X120}y   ` }, { requireName: false })).toBe(`${col} must be <= 120 characters`);
  });
});

// ── refuse: the pairings ────────────────────────────────────────────────────────────────────────

describe('breeding pairing is checked against the row as it will be, before the UPDATE', () => {
  it('breeding_system set with no source anywhere is a 400 in the editor\'s own words', async () => {
    const res = await put({ breeding_system: 'f1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('"Breeding info from" is required when Breeding is set.');
    expect(res.body.error).not.toMatch(COLUMN_WORDS);
    expect(calls(isPreflight)).toHaveLength(1);
    expect(calls(isUpdate)).toHaveLength(0);
  });

  it('breeding_system set on a row that already carries a source is allowed', async () => {
    db({ current: { breeding_system: null, breeding_source: 'vendor_catalog', variety_rank: null } });
    const res = await put({ breeding_system: 'unknown' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(keepBind('breeding_system')).toBe('unknown');
  });

  it('clearing the source out from under a breeding call is a 400', async () => {
    db({ current: { breeding_system: 'f1', breeding_source: 'breeder', variety_rank: 'cultivar' } });
    const res = await put({ clear: ['breeding_source'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^"Breeding info from" is required/);
    expect(calls(isUpdate)).toHaveLength(0);
  });

  it('clearing the breeding call alone is allowed (a source may stand without one)', async () => {
    db({ current: { breeding_system: 'f1', breeding_source: 'breeder', variety_rank: 'cultivar' } });
    const res = await put({ clear: ['breeding_system'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(clearBind('breeding_system')).toContain('breeding_system');
  });

  it('clearing both is allowed', async () => {
    db({ current: { breeding_system: 'f1', breeding_source: 'breeder', variety_rank: 'cultivar' } });
    expect((await put({ clear: ['breeding_system', 'breeding_source'] })).status).toBe(200);
  });

  // Dave, 2026-09-21: "Record it as named" — Open-pollinated on a variety whose rank was never
  // recorded records it as a single named cultivar; a recorded non-cultivar rank refuses plainly.
  // The sentences are literal on purpose: built from RANK_WORDS, a raw DB token put there would pass.
  it.each([
    ['market_class', 'a market class (a group of similar varieties)'],
    ['blend', 'a seed blend'],
    ['species', 'a whole species'],
    ['placeholder', 'a placeholder'],
  ])(
    'open_pollinated on a %s row is a plain-English 400 and nothing is written',
    async (rank, words) => {
      db({ current: { breeding_system: null, breeding_source: 'breeder', variety_rank: rank } });
      const res = await put({ breeding_system: 'open_pollinated' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        `Open-pollinated applies only to a single named variety, and this entry is recorded as ${words}.`,
      );
      expect(res.body.error).not.toMatch(COLUMN_WORDS);
      expect(calls(isUpdate)).toHaveLength(0);
    },
  );

  it('f1 on a market-class row is allowed — the CHECK only couples open_pollinated to the rank', async () => {
    db({ current: { breeding_system: null, breeding_source: null, variety_rank: 'market_class' } });
    const res = await put({ breeding_system: 'f1', breeding_source: 'breeder' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(keepBind('breeding_system')).toBe('f1');
    expect(fillBind()).toBe(false);
  });

  // ...and so is every other non-OP call on every recorded non-cultivar rank. A preflight stricter than
  // the CHECK refuses a legal edit (S38 in the 658c71e review). Both lists are literal, not read from
  // validate.js or RANK_WORDS, so a value dropped there cannot shrink the matrix.
  it.each(['f1', 'landrace', 'unknown'].flatMap((system) =>
    ['market_class', 'blend', 'species', 'placeholder'].map((rank) => [system, rank])))(
    '%s on a %s row saves as sent and leaves the rank alone',
    async (system, rank) => {
      db({ current: { breeding_system: null, breeding_source: null, variety_rank: rank } });
      const res = await put({ breeding_system: system, breeding_source: 'breeder' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(keepBind('breeding_system')).toBe(system);
      expect(keepBind('breeding_source')).toBe('breeder');
      expect(fillBind()).toBe(false);
    },
  );

  it('open_pollinated with no rank recorded saves and records the variety as a single named cultivar', async () => {
    const res = await put({ breeding_system: 'open_pollinated', breeding_source: 'packet_label' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(keepBind('breeding_system')).toBe('open_pollinated');
    expect(fillBind()).toBe(true);
  });

  it('open_pollinated on a cultivar-rank row is allowed and leaves the rank alone', async () => {
    db({ current: { breeding_system: 'unknown', breeding_source: 'inference', variety_rank: 'cultivar' } });
    const res = await put({ breeding_system: 'open_pollinated', breeding_source: 'packet_label' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(keepBind('breeding_system')).toBe('open_pollinated');
    expect(fillBind()).toBe(false);
  });

  it('any other breeding call on an unranked row never fills the rank', async () => {
    for (const system of VALID_BREEDING_SYSTEM.filter((s) => s !== 'open_pollinated')) {
      resetStubs(); stubState.verifyTokenResult = { sub: USER }; db();
      const res = await put({ breeding_system: system, breeding_source: 'packet_label' });
      expect(res.status, `${system}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(fillBind(), system).toBe(false);
    }
  });

  // The fill is triggered by THIS patch choosing Open-pollinated, not by the row already being OP. An
  // OP row with no rank cannot be written any more (the CHECK is NULL-safe since v5-oprankchecknull-001)
  // but existed as a possibility before it; a source-only edit must still not quietly re-rank one.
  it('a source-only edit on an open-pollinated row with no rank never fills the rank', async () => {
    db({ current: { breeding_system: 'open_pollinated', breeding_source: 'inference', variety_rank: null } });
    const res = await put({ breeding_source: 'breeder' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(fillBind()).toBe(false);
  });

  // Dave's rule (2026-09-21): the fill is permanent. Once Open-pollinated has recorded the variety as a
  // cultivar, switching Breeding to anything else, or clearing it, leaves the rank 'cultivar': no
  // statement a PUT issues writes variety_rank except the fill arm, and that arm only fills a NULL.
  // The real-Postgres half is the integration case that follows the fill.
  it.each([
    ['to f1', { breeding_system: 'f1' }],
    ['to landrace', { breeding_system: 'landrace' }],
    ['to unknown', { breeding_system: 'unknown' }],
    ['cleared', { clear: ['breeding_system'] }],
    ['cleared with its source', { clear: ['breeding_system', 'breeding_source'] }],
  ])('after the fill, Breeding %s leaves the rank as it is', async (_label, body) => {
    db({ current: { breeding_system: 'open_pollinated', breeding_source: 'packet_label', variety_rank: 'cultivar' } });
    const res = await put(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(fillBind()).toBe(false);
    const rankWrites = stubState.sqlCalls
      .flatMap((c) => c.text.match(/\bvariety_rank\s*=[^\n]*/g) ?? [])
      .map((s) => s.replace(/\s+/g, ' ').trim());
    expect(rankWrites).toEqual(["variety_rank = CASE WHEN ?::boolean AND variety_rank IS NULL THEN 'cultivar' ELSE variety_rank END"]);
  });

  it('the preflight reads the row by the UPDATE\'s own WHERE clause, byte for byte', async () => {
    await put({ breeding_system: 'f1', breeding_source: 'breeder' });
    const [pf] = calls(isPreflight);
    const where = (t) => t.slice(t.lastIndexOf('WHERE id = ?')).replace(/\s+RETURNING[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
    expect(where(pf.text)).toBe(where(updateCall().text));
    expect(where(pf.text)).toMatch(/^WHERE id = \? AND \( created_by = ANY\(\?\) OR created_by LIKE ANY\(\?::text\[\]\) \) AND deleted_at IS NULL$/);
    expect(pf.values[0]).toBe(VARIETY_ID);
  });

  it('a row the caller may not edit answers the generic 404, never a pairing 400', async () => {
    db({ current: null });
    const res = await put({ breeding_system: 'f1' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found or not owner');
    expect(calls(isUpdate)).toHaveLength(0);
  });

  it('the preflight runs after the rate limit and before the write', async () => {
    await put({ breeding_system: 'f1', breeding_source: 'breeder' });
    const order = stubState.sqlCalls.map((c) => c.text);
    const rl = order.findIndex(isRateLimit);
    const pf = order.findIndex(isPreflight);
    const up = order.findIndex(isUpdate);
    expect(rl).toBeGreaterThan(-1);
    expect(pf).toBeGreaterThan(rl);
    expect(up).toBeGreaterThan(pf);
  });

  it('a PUT that touches no breeding column issues no preflight at all', async () => {
    await put({ origin_country: 'Italy', scoville_source: 'inference', scoville_min: 100 });
    expect(calls(isPreflight)).toHaveLength(0);
    expect(calls(isUpdate)).toHaveLength(1);
  });
});

// ── the race path: the CHECK itself refuses the UPDATE ─────────────────────────────────────────────

// The preflight reads the row before the UPDATE writes it. A write landing in between (a second editor
// clearing the source, a script recording a rank) is refused by the CHECK, and the handler's catch sees
// a 23514 naming the constraint — thrown here in the neon driver's shape. Before this, the editor's
// banner printed "Constraint violation: chk_plant_varieties_op_requires_cultivar" (qa review of
// 658c71e, probe). The sentences are literal, as above.
function refusedAtUpdate(constraint, current = EMPTY_ROW) {
  db({ current });
  const read = stubState.sqlHandler;
  stubState.sqlHandler = (text, values) => {
    if (!isUpdate(text)) return read(text, values);
    const err = new Error(`new row for relation "plant_varieties" violates check constraint "${constraint}"`);
    err.code = '23514';
    err.constraint = constraint;
    throw err;
  };
}

describe('a CHECK refusal at the UPDATE (a concurrent write) answers in the preflight\'s own words', () => {
  it('chk_plant_varieties_breeding_sourced: the source was cleared after the preflight read it', async () => {
    refusedAtUpdate('chk_plant_varieties_breeding_sourced',
      { breeding_system: 'f1', breeding_source: 'breeder', variety_rank: 'cultivar' });
    const res = await put({ breeding_system: 'unknown' });
    expect(calls(isPreflight)).toHaveLength(1);
    expect(calls(isUpdate)).toHaveLength(1);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('"Breeding info from" is required when Breeding is set.');
  });

  it('chk_plant_varieties_op_requires_cultivar: a rank was recorded after the preflight read none', async () => {
    refusedAtUpdate('chk_plant_varieties_op_requires_cultivar');
    const res = await put({ breeding_system: 'open_pollinated', breeding_source: 'packet_label' });
    expect(fillBind()).toBe(true);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Open-pollinated applies only to a single named variety, and this entry is recorded as something other than a single named variety.',
    );
    expect(res.body.error).not.toMatch(COLUMN_WORDS);
  });

  it('any other constraint keeps the generic answer', async () => {
    refusedAtUpdate('chk_plant_varieties_lifecycle');
    const res = await put({ breeding_system: 'f1', breeding_source: 'breeder' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Constraint violation: chk_plant_varieties_lifecycle');
  });

  it('the race sentences are the preflight\'s own sentences, not a second copy', () => {
    expect(CONSTRAINT_MESSAGES.chk_plant_varieties_breeding_sourced)
      .toBe(breedingPairingError({ breeding_system: 'f1' }, [], {}));
    expect(CONSTRAINT_MESSAGES.chk_plant_varieties_op_requires_cultivar)
      .toBe(breedingPairingError({ breeding_system: 'open_pollinated', breeding_source: 'breeder' }, [], { variety_rank: 'cultivar_group' }));
    expect(Object.keys(CONSTRAINT_MESSAGES).sort())
      .toEqual(['chk_plant_varieties_breeding_sourced', 'chk_plant_varieties_op_requires_cultivar']);
  });
});

// ── the pure half ─────────────────────────────────────────────────────────────────────────────

describe('normalizeOriginText', () => {
  it('leaves a body with no origin keys byte-identical (no clear is invented)', () => {
    const body = { care_notes: 'x' };
    expect(normalizeOriginText(body)).toEqual({ care_notes: 'x' });
  });

  it('does not mutate the caller\'s object', () => {
    const body = { origin_country: '  ', clear: ['care_notes'] };
    normalizeOriginText(body);
    expect(body).toEqual({ origin_country: '  ', clear: ['care_notes'] });
  });

  it('appends to an existing clear and drops the blank key', () => {
    expect(normalizeOriginText({ origin_region: '', clear: ['care_notes'] }))
      .toEqual({ clear: ['care_notes', 'origin_region'] });
  });

  it('leaves a malformed clear for validateClear to refuse', () => {
    expect(normalizeOriginText({ origin_region: '', clear: 'care_notes' })).toEqual({ clear: 'care_notes' });
  });

  it('passes non-objects through for validateBody to refuse', () => {
    expect(normalizeOriginText(null)).toBeNull();
    expect(normalizeOriginText([1])).toEqual([1]);
  });

  // null and absent are one token on the wire and both mean KEEP (index.js "undefined/null in body =
  // keep existing"); only blank text or `clear` empties a column. An API or agent caller sending
  // null must not lose the stored origin.
  it('leaves an explicit null alone — null means keep, it is not a clear', () => {
    expect(normalizeOriginText({ origin_country: null, origin_region: null }))
      .toEqual({ origin_country: null, origin_region: null });
  });

  it('a PUT carrying null origins keeps them: no keep value, no clear', async () => {
    const res = await put({ origin_country: null, origin_region: null, care_notes: 'x' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const col of ['origin_country', 'origin_region']) {
      expect(keepBind(col), col).toBeNull();
      expect(clearBind(col), col).not.toContain(col);
    }
  });
});

describe('touchesBreeding / breedingPairingError', () => {
  it('only a patch that sets or clears a breeding column needs the row', () => {
    expect(touchesBreeding({ scoville_source: 'breeder' }, ['origin_region'])).toBe(false);
    expect(touchesBreeding({ breeding_source: 'breeder' }, [])).toBe(true);
    expect(touchesBreeding({}, ['breeding_system'])).toBe(true);
  });

  it('a sent value beats the current one and a clear beats both', () => {
    const current = { breeding_system: 'f1', breeding_source: 'breeder', variety_rank: 'market_class' };
    expect(breedingPairingError({ breeding_system: 'unknown' }, [], current)).toBeNull();
    expect(breedingPairingError({ breeding_source: 'packet_label' }, ['breeding_source'], current))
      .toMatch(/^"Breeding info from" is required/);
  });

  it('refuses open_pollinated only on a RECORDED rank that is not cultivar', () => {
    const src = { breeding_source: 'packet_label' };
    const op = { breeding_system: 'open_pollinated', ...src };
    expect(breedingPairingError(op, [], { variety_rank: null })).toBeNull();
    expect(breedingPairingError(op, [], { variety_rank: 'cultivar' })).toBeNull();
    for (const rank of Object.keys(RANK_WORDS)) {
      expect(breedingPairingError(op, [], { variety_rank: rank }), rank).toContain(RANK_WORDS[rank]);
    }
    // A rank value the CHECK would never admit still refuses rather than passing silently.
    expect(breedingPairingError(op, [], { variety_rank: 'cultivar_group' }))
      .toMatch(/something other than a single named variety\.$/);
  });

  it('RANK_WORDS covers every non-cultivar rank chk_plant_varieties_variety_rank admits', () => {
    expect(Object.keys(RANK_WORDS).sort()).toEqual(['blend', 'market_class', 'placeholder', 'species']);
  });
});

describe('fillsCultivarRank', () => {
  const op = { breeding_system: 'open_pollinated', breeding_source: 'packet_label' };
  it('is true only for open_pollinated sent onto a NULL rank', () => {
    expect(fillsCultivarRank(op, [], { variety_rank: null })).toBe(true);
    expect(fillsCultivarRank(op, [], {})).toBe(true);
    expect(fillsCultivarRank(op, [], { variety_rank: 'cultivar' })).toBe(false);
    expect(fillsCultivarRank(op, [], { variety_rank: 'market_class' })).toBe(false);
    expect(fillsCultivarRank({ breeding_system: 'f1' }, [], { variety_rank: null })).toBe(false);
    expect(fillsCultivarRank({ breeding_source: 'breeder' }, [], { variety_rank: null })).toBe(false);
    expect(fillsCultivarRank(op, ['breeding_system'], { variety_rank: null })).toBe(false);
  });
});
