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
  normalizeOriginText, touchesBreeding, breedingPairingError, validateBody,
  VALID_BREEDING_SYSTEM, VALID_FACT_SOURCE,
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

// ── refuse: the pairings ────────────────────────────────────────────────────────────────────────

describe('breeding pairing is checked against the row as it will be, before the UPDATE', () => {
  it('breeding_system set with no source anywhere is a 400 naming breeding_source', async () => {
    const res = await put({ breeding_system: 'f1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('breeding_source is required when breeding_system is set');
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
    expect(res.body.error).toMatch(/^breeding_source is required/);
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

  it('open_pollinated on a row not recorded as a single cultivar is a 400 naming breeding_system', async () => {
    db({ current: { breeding_system: null, breeding_source: 'breeder', variety_rank: 'market_class' } });
    const res = await put({ breeding_system: 'open_pollinated' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^breeding_system open_pollinated can only be recorded on a single named cultivar/);
    expect(calls(isUpdate)).toHaveLength(0);
  });

  it('open_pollinated with no rank recorded at all is refused the same way', async () => {
    const res = await put({ breeding_system: 'open_pollinated', breeding_source: 'packet_label' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^breeding_system open_pollinated/);
  });

  it('open_pollinated on a cultivar-rank row is allowed', async () => {
    db({ current: { breeding_system: 'unknown', breeding_source: 'inference', variety_rank: 'cultivar' } });
    const res = await put({ breeding_system: 'open_pollinated', breeding_source: 'packet_label' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(keepBind('breeding_system')).toBe('open_pollinated');
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
      .toMatch(/^breeding_source is required/);
  });
});
