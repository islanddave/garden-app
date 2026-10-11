// BUG-VARIETYEDITHOUSEHOLDMIRROR-001 — GET /api/varieties/:id answers can_edit.
//
// The edit form (src/components/forms/VarietyEditor.jsx) grayed out every variety the OTHER household
// member had created — 472 of 497 live cultivars from her side, measured 2026-09-23 — although the
// PUT would have saved them: the form compared created_by to the caller's own id, the PUT compares it
// to the household. The form has no roster to compare against, so the server now says it: the read
// that seeds the form carries can_edit.
//
// A flag like that is worth sending only while it agrees with the write it predicts, and the costly
// way to be wrong is a TRUE the PUT then refuses (a form that takes the typing and loses it). So the
// center of this file is not "the key is present" but the GRID: for every caller class x household
// config x created_by shape, the handler's own GET, PUT (both paths) and DELETE are run against one
// row and must agree.
//
// WHY THESE RUN THE HANDLER, per source-routes.test.js: the agreement is between a JS decision and
// the binds of three SQL statements, and no regex over the source can see what a given caller binds.
// The mock is facts-edit.test.js's mock verbatim (the shared stub has no sql.transaction).
//
// WHAT THE FAKE DATABASE IS. It holds one row and answers the three write statements by evaluating
// their WHERE clause from THE STATEMENT'S OWN BINDS — the household array and the pattern array the
// handler actually passed — with a LIKE written here (refLike), a transliteration of Postgres'
// MatchText, deliberately not the production sqlLike. Two independent readings of LIKE have to
// agree for the grid to pass; the static pins in authz-household.test.js hold the statements to the
// shape this fake assumes.
//
// WHAT THESE DO NOT PROVE: this is mock SQL. That Postgres reads `=` and LIKE on created_by the way
// both readings here do rests on the manual and on the 2026-08-07 prod measurements recorded in
// authz.js, not on this file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import { MANAGED_PRINCIPAL_PATTERNS, sqlLike } from './authz.js';

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

const DAVE = 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI';
const JEN = 'user_3E2xA85kQhr1vSZhiv4W1GLudJV';
const STRANGER = 'user_MALLORY000000000000000000';
const VARIETY_ID = '5bbc762a-7d19-4a6a-8ddc-f191329d9c68';
const ENV_KEY = 'GARDEN_HOUSEHOLD_IDS';

const isRateLimit = (t) => t.includes('INSERT INTO public.rate_limit_buckets');
const isSetConfig = (t) => t.includes('set_config');
const isGetById = (t) => /^\s*SELECT id, display_name AS name,[\s\S]*FROM public\.cultivar\s+WHERE id = \?\s+AND deleted_at IS NULL\s*$/.test(t);
const isPreflight = (t) => /SELECT breeding_system, breeding_source, variety_rank\s+FROM public\.cultivar/.test(t);
const isUpdate = (t) => t.includes('UPDATE public.cultivar SET');
const isSoftDelete = (t) => /UPDATE public\.cultivar\s+SET deleted_at = NOW\(\)/.test(t);
const isList = (t) => /FROM public\.cultivar\s+WHERE deleted_at IS NULL/.test(t);

// Reference LIKE — the control flow of MatchText (src/backend/utils/adt/like_match.c), character by
// character: `\` makes the next pattern character literal, `%` tries every remaining text position,
// `_` takes one character, and once the text runs out only %'s may remain. Postgres RAISES on a
// pattern ending in a lone `\`; a raise fails the statement, so here it admits nothing.
function refLike(text, pattern) {
  const t = Array.from(text);
  const p = Array.from(pattern);
  const go = (ti, pi) => {
    while (ti < t.length && pi < p.length) {
      if (p[pi] === '\\') {
        pi += 1;
        if (pi >= p.length || p[pi] !== t[ti]) return false;
      } else if (p[pi] === '%') {
        for (let k = ti; k <= t.length; k += 1) if (go(k, pi + 1)) return true;
        return false;
      } else if (p[pi] !== '_' && p[pi] !== t[ti]) {
        return false;
      }
      ti += 1; pi += 1;
    }
    if (ti < t.length) return false;
    while (pi < p.length && p[pi] === '%') pi += 1;
    return pi >= p.length;
  };
  return go(0, 0);
}

// Binds are positional (the mock joins the template on `?`), so the value behind a placeholder is
// found by counting the placeholders before it. `marker` holds exactly one `?`.
function bindAt(call, marker) {
  const at = call.text.indexOf(marker);
  if (at < 0) throw new Error(`statement has no ${JSON.stringify(marker)}: ${call.text.slice(0, 80)}`);
  if (call.text.indexOf(marker, at + 1) >= 0) throw new Error(`${JSON.stringify(marker)} appears twice`);
  if (call.text.split('?').length - 1 !== call.values.length) throw new Error('a literal ? in the SQL broke the positional read');
  return call.values[call.text.slice(0, at + marker.indexOf('?')).split('?').length - 1];
}

// The write statements' WHERE, evaluated the way Postgres would on the fake row:
//   id = $id AND ( created_by = ANY($household) OR created_by LIKE ANY($patterns::text[]) ) AND deleted_at IS NULL
// A NULL created_by makes both arms NULL, and a NULL predicate admits no row.
let row;
const admitted = [];
function admits(call) {
  const id = bindAt(call, 'WHERE id = ?');
  const household = bindAt(call, 'created_by = ANY(?)');
  const patterns = bindAt(call, 'created_by LIKE ANY(?::text[])');
  if (!Array.isArray(household) || !Array.isArray(patterns)) throw new Error('a write arm was bound to a non-array');
  const ok = id === row.id && row.deleted_at == null && row.created_by != null
    && (household.some((h) => h === row.created_by) || patterns.some((p) => refLike(row.created_by, p)));
  admitted.push({ household, patterns, ok });
  return ok;
}

function db(over = {}) {
  row = {
    id: VARIETY_ID, name: 'Ghost', species: 'Capsicum chinense', created_by: DAVE, deleted_at: null,
    breeding_system: null, breeding_source: null, variety_rank: null, ...over,
  };
  stubState.sqlHandler = (text, values) => {
    if (isRateLimit(text)) return [{ count: 1 }];
    if (isSetConfig(text)) return [{}];
    if (isGetById(text)) {
      if (values[0] !== row.id || row.deleted_at != null) return [];
      const { deleted_at: _gone, ...read } = row;
      return [read];
    }
    if (isPreflight(text) || isUpdate(text) || isSoftDelete(text)) {
      return admits({ text, values }) ? [{ id: row.id, name: row.name, breeding_system: null, breeding_source: null, variety_rank: null }] : [];
    }
    if (isList(text)) return [{ id: row.id, name: row.name, created_by: row.created_by }];
    return [];
  };
}

const call = async (method, rawPath, body) => {
  const res = await handler({
    requestContext: { http: { method } },
    rawPath,
    headers: { authorization: 'Bearer stub-token' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};
const BY_ID = `/api/varieties/${VARIETY_ID}`;
const as = (sub) => { stubState.verifyTokenResult = { sub }; };
const household = (ids) => vi.stubEnv(ENV_KEY, ids.join(','));

beforeEach(() => {
  resetStubs();
  admitted.length = 0;
  as(DAVE);
  db();
});
afterEach(() => { vi.unstubAllEnvs(); });

// ── instrument checks: the fake database reads LIKE the way the manual says ────────────────────

describe('the reference LIKE the fake database uses', () => {
  it('agrees with the four examples in the Postgres manual', () => {
    expect(refLike('abc', 'abc')).toBe(true);
    expect(refLike('abc', 'a%')).toBe(true);
    expect(refLike('abc', '_b_')).toBe(true);
    expect(refLike('abc', 'c')).toBe(false);
  });

  // Two readings written apart, compared over patterns far outside today's four, so neither is
  // vouched for by the other's blind spot on the shapes MANAGED_PRINCIPAL_PATTERNS could grow into.
  it('agrees with the production sqlLike on every pattern x value below', () => {
    const patterns = [
      ...MANAGED_PRINCIPAL_PATTERNS, '', '%', '%%', '_', '__', '%_', '_%', 'a%b%c', '%-intake-%',
      'data_audit-%', 'data\\_audit-%', 'a\\%b', 'a\\\\b', 'a\\b', 'sys%m', 's_stem', '%stem', 'a.c', 'a\\',
      '%\\', 'user\\_%', 'user_%',
    ];
    const values = [
      '', 'a', 'ab', 'abc', 'a.c', 'a%b', 'a\\b', 'a\\', 'a-x-b-y-c', 'system', 'System', 'sys\nm', 'sXstem',
      'rescue-intake-x', 'rescue-intake-', 'my-intake-1', 'data_audit-1', 'data-audit-1', 'dataXaudit-1',
      'data\\_audit-1', 'user_abc', 'userXabc', 'a\u{1F331}b', '\u{1F331}', '%', '_', '\\',
    ];
    let trues = 0;
    for (const p of patterns) {
      for (const v of values) {
        const want = refLike(v, p);
        if (want) trues += 1;
        expect(sqlLike(v, p), `${JSON.stringify(v)} LIKE ${JSON.stringify(p)}`).toBe(want);
      }
    }
    // Anti-vacuity: the comparison saw both answers, many times over.
    expect(trues).toBeGreaterThan(40);
    expect(patterns.length * values.length - trues).toBeGreaterThan(200);
  });
});

// ── the response ────────────────────────────────────────────────────────────────────────────────

describe('GET /api/varieties/:id carries can_edit', () => {
  it('true for a row the caller created, with the row itself unchanged beside it', async () => {
    const { status, body } = await call('GET', BY_ID);
    expect(status).toBe(200);
    const { deleted_at: _gone, ...read } = row;
    expect(body).toEqual({ ...read, can_edit: true });
  });

  // THE BUG, from the side it was reported: the second member opens a variety the first created.
  it('true for a row the OTHER household member created', async () => {
    household([DAVE, JEN]);
    as(JEN);
    db({ created_by: DAVE });
    const { status, body } = await call('GET', BY_ID);
    expect(status).toBe(200);
    expect(body.created_by).toBe(DAVE);
    expect(body.can_edit).toBe(true);
  });

  it('true for a managed-principal row, for a household member only', async () => {
    household([DAVE, JEN]);
    db({ created_by: 'rescue-intake-longriver-20260712' });
    as(JEN);
    expect((await call('GET', BY_ID)).body.can_edit).toBe(true);
    as(STRANGER);
    expect((await call('GET', BY_ID)).body.can_edit).toBe(false);
  });

  // The read is global, so a signed-in non-member still gets the row — now with an honest false,
  // where the form used to open a managed row for them and collect the PUT's 404.
  it('false, on a 200 with the full row, for a caller outside the household', async () => {
    household([DAVE, JEN]);
    as(STRANGER);
    const { status, body } = await call('GET', BY_ID);
    expect(status).toBe(200);
    expect(body.name).toBe('Ghost');
    expect(body.can_edit).toBe(false);
  });

  it('false for the other member\'s row when no household is configured', async () => {
    as(JEN);
    const { body } = await call('GET', BY_ID);
    expect(body.can_edit).toBe(false);
  });

  it('is always a boolean — the form reads anything else as "the server did not say"', async () => {
    for (const createdBy of [DAVE, JEN, 'system', '', null]) {
      db({ created_by: createdBy });
      expect(typeof (await call('GET', BY_ID)).body.can_edit, String(createdBy)).toBe('boolean');
    }
  });

  it('a missing or soft-deleted row is still the bare 404, with no flag on it', async () => {
    db({ deleted_at: '2026-01-01' });
    const gone = await call('GET', BY_ID);
    expect(gone).toEqual({ status: 404, body: { error: 'Not found' } });
    db();
    const other = await call('GET', '/api/varieties/00000000-0000-4000-8000-000000000000');
    expect(other).toEqual({ status: 404, body: { error: 'Not found' } });
  });

  it('issues no extra statement for it — one read, the same one as before', async () => {
    await call('GET', BY_ID);
    expect(stubState.sqlCalls).toHaveLength(1);
    expect(isGetById(stubState.sqlCalls[0].text)).toBe(true);
    expect(stubState.sqlCalls[0].values).toEqual([VARIETY_ID]);
  });

  // The list feeds VarietyPicker and Search, neither of which opens the form on a list row.
  it('the list does not carry it', async () => {
    const { status, body } = await call('GET', '/api/varieties');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).not.toHaveProperty('can_edit');
  });
});

// ── the grid: can_edit is what the PUT and DELETE then do ───────────────────────────────────────

// Every created_by shape that could tell the two apart: both humans, a stranger, the four live
// managed principals, the edges of each pattern, lookalikes, wildcards as DATA, and no value.
const CREATED_BY = [
  DAVE, JEN, STRANGER,
  'system', 'rescue-intake-longriver-20260712', 'data-audit-20260706', 'data-correction-2026-07-07',
  'rescue-intake-eastfield-20271130', 'rescue-intake-', 'rescue-intake', 'x-rescue-intake-1',
  'systematic-scraper', 'System', 'system ', 'system%', 'syste_', 'rescue-intake-%', 'rescue-intake-_',
  'data_audit-20260706', 'data-audit', '%', '_', 'user_%', '\\', DAVE.toLowerCase(), `${DAVE} `,
  '', null,
];
const CONFIGS = [
  ['two-member household', [DAVE, JEN]],
  ['household of one', [DAVE]],
  ['no household configured', []],
];
const CALLERS = [['the first member', DAVE], ['the second member', JEN], ['a stranger', STRANGER]];

describe('can_edit agrees with what the PUT and the DELETE do to the same row', () => {
  const seen = { true: 0, false: 0 };

  describe.each(CONFIGS)('%s', (_label, ids) => {
    it.each(CALLERS)('%s', async (_who, sub) => {
      for (const createdBy of CREATED_BY) {
        const why = `caller ${sub}, household [${ids}], created_by ${JSON.stringify(createdBy)}`;
        resetStubs();
        admitted.length = 0;
        household(ids);
        as(sub);
        db({ created_by: createdBy });

        const read = await call('GET', BY_ID);
        expect(read.status, why).toBe(200);
        const flag = read.body.can_edit;
        expect(typeof flag, why).toBe('boolean');

        // The plain PUT: no preflight, the UPDATE's own predicate decides.
        const plain = await call('PUT', BY_ID, { care_notes: 'x' });
        // The breeding PUT: the pairing preflight decides first, under the same predicate.
        const paired = await call('PUT', BY_ID, { breeding_source: 'breeder' });
        const del = await call('DELETE', BY_ID);

        for (const [name, res] of [['PUT', plain], ['PUT (preflight)', paired], ['DELETE', del]]) {
          expect([200, 404], `${name}: ${why}`).toContain(res.status);
          expect(res.status === 200, `${name} vs can_edit: ${why}`).toBe(flag);
          if (res.status === 404) expect(res.body, `${name}: ${why}`).toEqual({ error: 'Not found or not owner' });
        }
        // Four predicate evaluations: UPDATE, preflight + UPDATE (or preflight alone), soft delete.
        expect(admitted.length, why).toBe(flag ? 4 : 3);
        expect(admitted.every((a) => a.ok === flag), why).toBe(true);
        seen[flag] += 1;
      }
    });
  });

  // Anti-vacuity, checked after the grid has run: a grid that only ever saw one answer proves
  // nothing about the other. 3 configs x 3 callers x 28 rows = 252 comparisons.
  it('saw both answers, and the reported case among the trues', async () => {
    expect(seen.true + seen.false).toBe(CONFIGS.length * CALLERS.length * CREATED_BY.length);
    expect(seen.true).toBeGreaterThan(20);
    expect(seen.false).toBeGreaterThan(150);

    household([DAVE, JEN]);
    as(JEN);
    db({ created_by: DAVE });
    expect((await call('GET', BY_ID)).body.can_edit).toBe(true);
    expect((await call('PUT', BY_ID, { care_notes: 'x' })).status).toBe(200);
    // …and what the handler bound for her: both ids, and the managed patterns.
    expect(admitted[0].household).toEqual([DAVE, JEN]);
    expect(admitted[0].patterns).toEqual(MANAGED_PRINCIPAL_PATTERNS);
  });

  it('a stranger\'s binds are their own id and an empty pattern list', async () => {
    household([DAVE, JEN]);
    as(STRANGER);
    db({ created_by: 'system' });
    expect((await call('GET', BY_ID)).body.can_edit).toBe(false);
    expect((await call('PUT', BY_ID, { care_notes: 'x' })).status).toBe(404);
    expect(admitted[0]).toEqual({ household: [STRANGER], patterns: [], ok: false });
  });
});
