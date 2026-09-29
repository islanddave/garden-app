// V4-SOURCEREG-001 / V5-SOURCEKIND-001 — the provenance registry routes in lambda/varieties.
//
// WHY THESE RUN THE HANDLER rather than scanning its source, unlike most files in this directory:
// every assertion that matters here is about a DECISION the route makes between two DB reads —
// steer vs restore vs create — and no regex over the source can see which branch a given input
// takes. The four vitest.config.ts stub aliases make `./index.js` importable; the one gap is
// `sql.transaction`, which the shared stub does not implement and which the source restore needs
// (public.source carries trg_audit_source_upd, so that write has to bind the audit actor).
// The mock below is that stub plus a transaction, and nothing else — it records into the same
// stubState the rest of the directory drives, so `sqlCalls` reads the same way here.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import {
  foldSourceKey, blankToNull, slugifySourceKind, slugifyCropType,
  resolveSourceKindName, validateSourceBody, validateSourceKindBody,
  validateSourcePatch, URL_FIELDS,
} from './validate.js';
import { canEditSource } from './authz.js';

vi.mock('@neondatabase/serverless', async () => {
  const { stubState: state } = await import('../_test-stubs/state.js');
  return {
    neon: () => {
      const tagged = async (strings, ...values) => {
        const text = Array.isArray(strings) ? strings.join('?') : String(strings);
        state.sqlCalls.push({ text, values });
        return state.sqlHandler(text, values);
      };
      // Each element is an already-running statement promise, so ordering is preserved and the
      // set_config lands in sqlCalls ahead of the UPDATE — which is what the restore test asserts.
      // Opt-in failure for the race test: the whole transaction rejects as Postgres would.
      tagged.transaction = (stmts) => (state.transactionError
        ? Promise.all(stmts).then(() => { throw state.transactionError; })
        : Promise.all(stmts));
      return tagged;
    },
  };
});

const { handler } = await import('./index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');
const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

const USER = 'user_stub_owner';
const OTHER = 'user_someone_else';
const SOURCE_ID = 'b1f3c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const DELETED_ID = 'b1f3c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5e';

const call = (method, rawPath, body) => handler({
  requestContext: { http: { method } },
  rawPath,
  headers: { authorization: 'Bearer stub-token' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const parse = async (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });
const post = async (path, body) => parse(await call('POST', path, body));
const get = async (path) => parse(await call('GET', path));

// `public.source` is a PREFIX of `public.source_kind`, so every matcher below is anchored on a word
// boundary. Matching the prefix loosely routes the kind queries into the source arm and every
// assertion downstream would be answering about the wrong table.
const isRateLimit = (t) => t.includes('INSERT INTO public.rate_limit_buckets');
const isSetConfig = (t) => t.includes('set_config');
const bindsSource = (t) => /\bpublic\.source\b/.test(t);
const bindsSourceKind = (t) => /\bpublic\.source_kind\b/.test(t);

// The twelve seeded kinds, as read from live prod on 2026-09-04.
const SEEDED_KINDS = [
  ['seed_company', 'Seed company', 10], ['nursery', 'Nursery', 20],
  ['garden_center', 'Garden center', 30], ['farm_stand', 'Farm stand', 40],
  ['market', 'Market', 50], ['retail', 'Retail', 60],
  ['plant_swap', 'Plant swap', 70], ['person', 'Person', 80],
  ['organization', 'Organization', 90], ['brand', 'Brand', 100],
  ['own_garden', 'Own garden', 110], ['other', 'Other', 120],
].map(([slug, display_name, sort_order]) => ({ slug, display_name, sort_order, deleted_at: null }));

// A DB whose answers are declared per test rather than assembled from a default fixture, so a test
// that forgets to describe a table gets an empty answer instead of quietly inheriting another
// test's rows. `sources` is the match_key collision set; `kinds` is the whole source_kind table.
function db({ sources = [], kinds = SEEDED_KINDS, allowRate = true, restoreHits = true } = {}) {
  stubState.sqlHandler = (text, values) => {
    if (isRateLimit(text)) return allowRate ? [{ count: 1 }] : [];
    if (isSetConfig(text)) return [{ set_config: values[0] }];
    if (bindsSourceKind(text)) {
      if (text.includes('INSERT INTO public.source_kind')) {
        return [{ slug: values[0], display_name: values[1], sort_order: 130 }];
      }
      if (text.includes('UPDATE public.source_kind')) {
        if (!restoreHits) return [];
        const row = kinds.find((k) => k.slug === values[0]);
        return [{ slug: row.slug, display_name: row.display_name, sort_order: row.sort_order }];
      }
      if (text.includes('WHERE slug = ')) {
        return kinds.filter((k) => k.slug === values[0] && !k.deleted_at).map((k) => ({ slug: k.slug }));
      }
      return kinds;
    }
    if (bindsSource(text)) {
      if (text.includes('INSERT INTO public.source')) {
        const [name, kind, locality, address, website_url, instagram_url, facebook_url, notes, created_by] = values;
        return [{ id: SOURCE_ID, name, kind, locality, address, website_url, instagram_url, facebook_url, notes, created_by }];
      }
      // PATCH: sixteen (present?, value) pairs in PATCH_COLUMNS order, then the id.
      if (text.includes('UPDATE public.source') && text.includes('CASE WHEN')) {
        const row = sources.find((s) => s.id === values[16] && !s.deleted_at);
        if (!row || !restoreHits) return [];
        const next = { ...row };
        PATCH_COLUMNS.forEach((col, i) => { if (values[2 * i]) next[col] = values[2 * i + 1]; });
        const { created_by: _c, deleted_at: _d, ...out } = next;
        return [out];
      }
      if (text.includes('UPDATE public.source')) {
        if (!restoreHits) return [];
        const row = sources.find((s) => s.id === values[0]);
        return [{ ...row, deleted_at: undefined }];
      }
      if (text.includes('match_key = ') && text.includes('id <> ')) {
        return sources
          .filter((s) => !s.deleted_at && s.id !== values[1] && foldSourceKey(s.name) === values[0])
          .slice(0, 1);
      }
      if (text.includes('WHERE id = ')) {
        return sources.filter((s) => s.id === values[0] && !s.deleted_at);
      }
      if (text.includes('match_key = ')) {
        return sources
          .filter((s) => foldSourceKey(s.name) === values[0])
          .sort((a, b) => (a.deleted_at ? 1 : 0) - (b.deleted_at ? 1 : 0))
          .slice(0, 1);
      }
      return sources.filter((s) => !s.deleted_at);
    }
    return [];
  };
}

// The order the PATCH UPDATE binds its (present?, value) pairs in.
const PATCH_COLUMNS = ['name', 'kind', 'locality', 'address', 'website_url', 'instagram_url', 'facebook_url', 'notes'];

const lastSql = (pred) => [...stubState.sqlCalls].reverse().find((c) => pred(c.text));

beforeEach(() => {
  resetStubs();
  stubState.transactionError = null;
  stubState.verifyTokenResult = { sub: USER };
  db();
});

// ── the pure half ───────────────────────────────────────────────────────────────────────────

describe('foldSourceKey — the fold both unique indexes use', () => {
  // MEASURED against live prod Neon on 2026-09-04 by running
  // `SELECT regexp_replace(lower(x),'[^a-z0-9]','','g')` over exactly these seven strings. This is
  // the whole reason the function exists: a JS fold that merely looks equivalent lets a collision
  // reach the INSERT as a 23505, or steers away from a name the index would have accepted.
  const PROD = [
    ['Épinard', 'pinard'],
    ['Seed company', 'seedcompany'],
    ['Baker Creek Heirloom Seeds', 'bakercreekheirloomseeds'],
    ["O'Brien & Sons", 'obriensons'],
    ['  Spaced  Out  ', 'spacedout'],
    ['ÜBER Garten', 'bergarten'],
    ['123-456', '123456'],
  ];
  for (const [input, expected] of PROD) {
    it(`folds ${JSON.stringify(input)} exactly as Postgres does`, () => {
      expect(foldSourceKey(input)).toBe(expected);
    });
  }

  it('does NOT strip accents the way the slug fold does', () => {
    // The one case where the two folds must DISAGREE. Postgres lower() leaves the combining accent
    // and the strip then removes the whole letter, so an NFKD pass here would compute a key the
    // database never generates — and two rows that collide would look distinct, or vice versa.
    expect(foldSourceKey('Épinard')).toBe('pinard');
    expect(slugifySourceKind('Épinard')).toBe('epinard');
  });

  it('is total over non-strings', () => {
    expect(foldSourceKey(null)).toBe('');
    expect(foldSourceKey(42)).toBe('');
  });
});

describe('slugifySourceKind', () => {
  it('agrees with slugifyCropType on every shape either has to handle', () => {
    // Two functions on purpose (two independent primary keys), pinned to the same behaviour today
    // so a divergence is a decision someone made rather than a drift nobody noticed.
    for (const n of ['Seed company', 'Rose of Sharon', '  Mahogany  Splendor ', '--Kale--', 'Épinard', 'Co-op']) {
      expect(slugifySourceKind(n), n).toBe(slugifyCropType(n));
    }
  });
  it('caps at the 60 chars chk_source_kind_slug_shape allows', () => {
    expect(slugifySourceKind('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('blankToNull', () => {
  it('turns a blank or whitespace-only optional field into NULL, and trims the rest', () => {
    expect(blankToNull('')).toBeNull();
    expect(blankToNull('   ')).toBeNull();
    expect(blankToNull(undefined)).toBeNull();
    expect(blankToNull('  South Deerfield ')).toBe('South Deerfield');
  });
});

describe('validateSourceBody', () => {
  it('accepts a minimal and a full payload', () => {
    expect(validateSourceBody({ name: 'Baker Creek' })).toBeNull();
    expect(validateSourceBody({
      name: 'Baker Creek', kind: 'seed_company', locality: 'Mansfield, MO',
      address: '2278 Baker Creek Rd', website_url: 'https://rareseeds.com', notes: 'catalog',
    })).toBeNull();
  });
  it('mirrors chk_source_name_shape rather than leaving it to a 23514', () => {
    expect(validateSourceBody({})).toMatch(/name is required/);
    expect(validateSourceBody({ name: '   ' })).toMatch(/name is required/);
    expect(validateSourceBody({ name: 'A' })).toMatch(/2-200/);
    expect(validateSourceBody({ name: 'x'.repeat(201) })).toMatch(/2-200/);
    expect(validateSourceBody({ name: '!!!' })).toMatch(/letter or number/);
  });
  it('rejects a website_url that is not http(s), and accepts both schemes', () => {
    expect(validateSourceBody({ name: 'Baker Creek', website_url: 'rareseeds.com' })).toMatch(/website_url/);
    expect(validateSourceBody({ name: 'Baker Creek', website_url: 'ftp://rareseeds.com' })).toMatch(/website_url/);
    expect(validateSourceBody({ name: 'Baker Creek', website_url: 'http://rareseeds.com' })).toBeNull();
    expect(validateSourceBody({ name: 'Baker Creek', website_url: 'https://rareseeds.com' })).toBeNull();
  });
  it('treats a BLANK website_url as absent, not as a violation', () => {
    // Every optional text input in the app submits '' rather than omitting its key. A create that
    // 400s because an untouched field was empty is indistinguishable, to the person filling in the
    // form, from one that 400s because what they typed was wrong.
    expect(validateSourceBody({ name: 'Baker Creek', website_url: '' })).toBeNull();
    expect(validateSourceBody({ name: 'Baker Creek', website_url: '   ' })).toBeNull();
  });
  it('type-checks the optional text columns', () => {
    expect(validateSourceBody({ name: 'Baker Creek', kind: 7 })).toMatch(/kind/);
    expect(validateSourceBody({ name: 'Baker Creek', locality: 7 })).toMatch(/locality/);
    expect(validateSourceBody({ name: 'Baker Creek', notes: {} })).toMatch(/notes/);
  });
});

describe('validateSourceKindBody', () => {
  it('accepts a plain label and mirrors chk_source_kind_display_name_shape', () => {
    expect(validateSourceKindBody({ display_name: 'Co-op' })).toBeNull();
    expect(validateSourceKindBody({})).toMatch(/display_name is required/);
    expect(validateSourceKindBody({ display_name: 'A' })).toMatch(/2-80/);
    expect(validateSourceKindBody({ display_name: 'x'.repeat(81) })).toMatch(/2-80/);
    expect(validateSourceKindBody({ display_name: '!!' })).toMatch(/letter or number/);
  });
  it('REFUSES a caller-supplied slug rather than ignoring it', () => {
    // Silently overwriting the guess would leave the caller believing the key it chose is the one
    // every source row now points at. slug is this table's PK and source.kind's FK target.
    expect(validateSourceKindBody({ display_name: 'Co-op', slug: 'coop' })).toMatch(/slug is derived/);
  });
});

describe('resolveSourceKindName', () => {
  const SLUGS = SEEDED_KINDS.map((k) => k.slug);

  it('mints a genuinely new kind', () => {
    for (const n of ['Co-op', 'CSA', 'Botanical garden', 'Seed library']) {
      expect(resolveSourceKindName(n, SLUGS, SEEDED_KINDS), n).toMatchObject({ ok: true });
    }
  });
  it('steers an exact repeat, however it was capitalised or punctuated', () => {
    expect(resolveSourceKindName('Seed Company', SLUGS, SEEDED_KINDS))
      .toMatchObject({ ok: false, reason: 'exists', existingSlug: 'seed_company' });
    expect(resolveSourceKindName('seed-company!', SLUGS, SEEDED_KINDS))
      .toMatchObject({ ok: false, reason: 'exists', existingSlug: 'seed_company' });
  });
  it('steers a plural of an existing kind, and a singular of an existing plural', () => {
    expect(resolveSourceKindName('Nurseries', SLUGS, SEEDED_KINDS))
      .toMatchObject({ ok: false, reason: 'plural', existingSlug: 'nursery' });
    expect(resolveSourceKindName('Farm stand', ['farm_stands'], [{ slug: 'farm_stands', display_name: 'Farm stands' }]))
      .toMatchObject({ ok: false, reason: 'plural', existingSlug: 'farm_stands' });
  });
  it('steers a label that FOLDS onto a live row without colliding on slug', () => {
    // The load-bearing one. `seedcompany` is not `seed_company`, so every slug check above passes
    // and the INSERT then raises 23505 on uq_source_kind_display_live. Naming the reason is what
    // lets the client offer "Use Seed company" instead of rendering a 500.
    expect(resolveSourceKindName('Seedcompany', SLUGS, SEEDED_KINDS))
      .toMatchObject({ ok: false, reason: 'label', slug: 'seedcompany', existingSlug: 'seed_company' });
    expect(resolveSourceKindName('Garden Center', ['garden_center'], [{ slug: 'garden_center', display_name: 'Garden center' }]))
      .toMatchObject({ ok: false, existingSlug: 'garden_center' });
  });
  it('does NOT steer on a label that only a SOFT-DELETED row holds', () => {
    // uq_source_kind_display_live is PARTIAL. A retired label blocks nothing, so steering on one
    // would refuse a create the database would have accepted.
    const retired = [{ slug: 'co_op_old', display_name: 'Coop', sort_order: 130, deleted_at: '2026-01-01' }];
    expect(resolveSourceKindName('Co op', [...SLUGS, 'co_op_old'], retired.filter((k) => !k.deleted_at)))
      .toMatchObject({ ok: true, slug: 'co_op' });
  });
  it('DOES steer on a slug a soft-deleted row still occupies', () => {
    // slug is the PRIMARY KEY: a resurrect violates it rather than politely conflicting, so the
    // slug collision set has to include rows the label set excludes.
    expect(resolveSourceKindName('Co-op', [...SLUGS, 'co_op'], SEEDED_KINDS))
      .toMatchObject({ ok: false, reason: 'exists', existingSlug: 'co_op' });
  });
  it('reports invalid for a name that derives a slug chk_source_kind_slug_shape would reject', () => {
    expect(resolveSourceKindName('A!', SLUGS, SEEDED_KINDS)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(resolveSourceKindName('!!!', SLUGS, SEEDED_KINDS)).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

// ── the routed half ─────────────────────────────────────────────────────────────────────────

describe('route ordering', () => {
  it('checks both literal source paths BEFORE the :id route', () => {
    const idMatchIdx = SRC.indexOf('const idMatch = rawPath.match');
    expect(idMatchIdx).toBeGreaterThan(-1);
    for (const literal of ["rawPath === '/api/varieties/sources'", "rawPath === '/api/varieties/source-kinds'"]) {
      const i = SRC.indexOf(literal);
      expect(i, `${literal} not found`).toBeGreaterThan(-1);
      expect(i, `${literal} must precede the :id match`).toBeLessThan(idMatchIdx);
    }
  });
  it('resolves /api/varieties/sources as the list, not as a variety id', () => {
    // The behavioural half of the same assertion: move the block below idMatch and this 200
    // becomes a 404 for a cultivar named "sources".
    return get('/api/varieties/sources').then(({ status }) => expect(status).toBe(200));
  });
});

describe('GET /api/varieties/sources', () => {
  it('returns live rows in the contracted projection, ordered by name', async () => {
    db({ sources: [
      { id: SOURCE_ID, name: 'Baker Creek', kind: 'seed_company', locality: 'Mansfield, MO', address: null, website_url: 'https://rareseeds.com', notes: null, deleted_at: null },
      { id: DELETED_ID, name: 'Gone Nursery', kind: 'nursery', locality: null, address: null, website_url: null, notes: null, deleted_at: '2026-01-01' },
    ] });
    const { status, body } = await get('/api/varieties/sources');
    expect(status).toBe(200);
    expect(body).toEqual([{
      id: SOURCE_ID, name: 'Baker Creek', kind: 'seed_company', locality: 'Mansfield, MO',
      address: null, website_url: 'https://rareseeds.com', notes: null, deleted_at: null,
    }]);
    const q = lastSql(bindsSource).text;
    expect(q).toMatch(/deleted_at IS NULL/);
    expect(q).toMatch(/ORDER BY name ASC/);
  });
});

describe('GET /api/varieties/source-kinds', () => {
  it('returns live kinds ordered by sort_order then display_name', async () => {
    const { status, body } = await get('/api/varieties/source-kinds');
    expect(status).toBe(200);
    expect(body.map((k) => k.slug).slice(0, 3)).toEqual(['seed_company', 'nursery', 'garden_center']);
    const q = lastSql(bindsSourceKind).text;
    expect(q).toMatch(/deleted_at IS NULL/);
    expect(q).toMatch(/ORDER BY sort_order ASC, display_name ASC/);
  });
});

describe('POST /api/varieties/sources', () => {
  it('creates, stamping created_by from the JWT and never from the body', async () => {
    const { status, body } = await post('/api/varieties/sources', {
      name: '  Baker Creek  ', kind: 'seed_company', locality: '', website_url: '', created_by: OTHER,
    });
    expect(status).toBe(201);
    expect(body.name).toBe('Baker Creek');
    expect(body.created_by).toBe(USER);
    expect(body.created_by).not.toBe(OTHER);
    // Blank optional fields land as NULL, not as ''.
    expect(body.locality).toBeNull();
    expect(body.website_url).toBeNull();
  });

  it('400s an invalid website_url before it reaches the rate limiter', async () => {
    const { status, body } = await post('/api/varieties/sources', { name: 'Baker Creek', website_url: 'rareseeds.com' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/website_url/);
    expect(stubState.sqlCalls.filter((c) => isRateLimit(c.text))).toHaveLength(0);
  });

  it('400s a kind that is not a LIVE source_kind slug', async () => {
    const retired = [...SEEDED_KINDS, { slug: 'co_op', display_name: 'Co-op', sort_order: 130, deleted_at: '2026-01-01' }];
    const missing = await post('/api/varieties/sources', { name: 'Baker Creek', kind: 'not_a_kind' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/not_a_kind/);
    db({ kinds: retired });
    const softDeleted = await post('/api/varieties/sources', { name: 'Baker Creek', kind: 'co_op' });
    expect(softDeleted.status).toBe(400);
    // The FK alone would have ACCEPTED this: a soft-deleted row still satisfies it.
    expect(stubState.sqlCalls.some((c) => c.text.includes('INSERT INTO public.source '))).toBe(false);
  });

  it('429s past the 20/hour source.create limit', async () => {
    db({ allowRate: false });
    const { status, body } = await post('/api/varieties/sources', { name: 'Baker Creek' });
    expect(status).toBe(429);
    expect(body.error).toMatch(/source\.create/);
    expect(lastSql(isRateLimit).values).toEqual([USER, 'source.create', 20]);
  });

  it('409s a name that collides on the FOLDED match_key, not just on an exact string', async () => {
    db({ sources: [{ id: SOURCE_ID, name: 'Baker Creek', kind: 'seed_company', locality: 'Mansfield, MO', address: null, website_url: null, notes: null, deleted_at: null }] });
    const { status, body } = await post('/api/varieties/sources', { name: "  baker-creek!  " });
    expect(status).toBe(409);
    expect(body.reason).toBe('exists');
    expect(body.existing.id).toBe(SOURCE_ID);
    expect(body.existing.name).toBe('Baker Creek');
    expect(body.hint).toBeTruthy();
    // The steer must happen BEFORE the write, not as a caught 23505.
    expect(stubState.sqlCalls.some((c) => c.text.includes('INSERT INTO public.source '))).toBe(false);
    expect(lastSql((t) => t.includes('match_key = ')).values[0]).toBe('bakercreek');
  });

  it('RESTORES a soft-deleted row instead of refusing it, and binds the audit actor', async () => {
    db({ sources: [{ id: DELETED_ID, name: 'Gone Nursery', kind: 'nursery', locality: null, address: null, website_url: null, notes: null, deleted_at: '2026-01-01' }] });
    const { status, body } = await post('/api/varieties/sources', { name: 'gone nursery' });
    expect(status).toBe(200);
    expect(body.restored).toBe(true);
    expect(body.id).toBe(DELETED_ID);
    // public.source carries trg_audit_source_upd, which reads app.actor_clerk_sub. Without this
    // bind the audit snapshot of the restore names 'system' rather than the person who did it.
    const actor = lastSql(isSetConfig);
    expect(actor, 'restore must set app.actor_clerk_sub').toBeTruthy();
    expect(actor.values).toContain(USER);
    const upd = lastSql((t) => t.includes('UPDATE public.source\n'));
    expect(upd.text).toMatch(/deleted_at = NULL/);
    expect(upd.text).toMatch(/AND deleted_at IS NOT NULL/);
  });

  it('steers rather than answering {restored:true} alone when the restore UPDATE matches nothing', async () => {
    db({
      sources: [{ id: DELETED_ID, name: 'Gone Nursery', kind: 'nursery', locality: null, address: null, website_url: null, notes: null, deleted_at: '2026-01-01' }],
      restoreHits: false,
    });
    const { status, body } = await post('/api/varieties/sources', { name: 'Gone Nursery' });
    expect(status).toBe(409);
    expect(body.reason).toBe('exists');
    expect(body.existing.id).toBe(DELETED_ID);
  });

  it('405s a method the route does not implement', async () => {
    expect((await parse(await call('PUT', '/api/varieties/sources', { name: 'x' }))).status).toBe(405);
  });
});

describe('POST /api/varieties/source-kinds', () => {
  it('mints at max(sort_order) + 10, never at the column default of 0', async () => {
    const { status, body } = await post('/api/varieties/source-kinds', { display_name: 'Co-op' });
    expect(status).toBe(201);
    expect(body.slug).toBe('co_op');
    const ins = lastSql((t) => t.includes('INSERT INTO public.source_kind'));
    // Asserted on the STATEMENT, because the value is computed by Postgres and never bound: a
    // literal 0 here would sort every minted kind above all twelve seeded ones (10..120).
    expect(ins.text).toMatch(/coalesce\(max\(sort_order\), 0\) \+ 10/);
    expect(ins.values).not.toContain(0);
  });

  it('derives the slug server-side and binds THAT, not anything from the body', async () => {
    const { status, body } = await post('/api/varieties/source-kinds', { display_name: 'Botanical Garden' });
    expect(status).toBe(201);
    const ins = lastSql((t) => t.includes('INSERT INTO public.source_kind'));
    expect(ins.values[0]).toBe('botanical_garden');
    expect(body.display_name).toBe('Botanical Garden');
  });

  it('400s a caller-supplied slug', async () => {
    const { status, body } = await post('/api/varieties/source-kinds', { display_name: 'Co-op', slug: 'coop' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/slug is derived/);
  });

  it('400s a display_name that derives too short a slug', async () => {
    const { status, body } = await post('/api/varieties/source-kinds', { display_name: 'A#' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/two letters or numbers/);
  });

  it('409s an exact repeat with the row to adopt', async () => {
    const { status, body } = await post('/api/varieties/source-kinds', { display_name: 'Seed Company' });
    expect(status).toBe(409);
    expect(body.reason).toBe('exists');
    expect(body.existing).toEqual({ slug: 'seed_company', display_name: 'Seed company', sort_order: 10 });
  });

  it('409s a plural of an existing kind', async () => {
    const { status, body } = await post('/api/varieties/source-kinds', { display_name: 'Nurseries' });
    expect(status).toBe(409);
    expect(body.reason).toBe('plural');
    expect(body.existing.slug).toBe('nursery');
  });

  it('409s a LABEL-FOLD collision before it can raise 23505', async () => {
    const { status, body } = await post('/api/varieties/source-kinds', { display_name: 'Seedcompany' });
    expect(status).toBe(409);
    expect(body.reason).toBe('label');
    expect(body.existing.slug).toBe('seed_company');
    expect(stubState.sqlCalls.some((c) => c.text.includes('INSERT INTO public.source_kind'))).toBe(false);
  });

  it('RESTORES a soft-deleted kind', async () => {
    const kinds = [...SEEDED_KINDS, { slug: 'co_op', display_name: 'Co-op', sort_order: 130, deleted_at: '2026-01-01' }];
    db({ kinds });
    const { status, body } = await post('/api/varieties/source-kinds', { display_name: 'Co-op' });
    expect(status).toBe(200);
    expect(body).toEqual({ slug: 'co_op', display_name: 'Co-op', sort_order: 130, restored: true });
  });

  it('refuses to restore a kind whose label would collide with a LIVE row', async () => {
    // The restore is an INSERT as far as the partial unique index is concerned. Without this guard
    // the UPDATE raises 23505 and the caller gets a 500 for asking about a row it can see.
    const kinds = [...SEEDED_KINDS, { slug: 'nursery_old', display_name: 'Nursery', sort_order: 130, deleted_at: '2026-01-01' }];
    db({ kinds });
    const { status, body } = await post('/api/varieties/source-kinds', { display_name: 'Nursery old' });
    expect(status).toBe(409);
    expect(body.reason).toBe('label');
    expect(body.existing.slug).toBe('nursery');
    expect(stubState.sqlCalls.some((c) => c.text.includes('UPDATE public.source_kind'))).toBe(false);
  });

  it('429s past the 20/hour source_kind.create limit', async () => {
    db({ allowRate: false });
    const { status } = await post('/api/varieties/source-kinds', { display_name: 'Co-op' });
    expect(status).toBe(429);
    expect(lastSql(isRateLimit).values).toEqual([USER, 'source_kind.create', 20]);
  });

  it('405s a method the route does not implement', async () => {
    expect((await parse(await call('DELETE', '/api/varieties/source-kinds'))).status).toBe(405);
  });
});

// ── V5-SOURCECONTACT-001 — GET + PATCH /api/varieties/sources/:id ───────────────────────────

const OTHER_ID = 'b1f3c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5f';
const BY_ID = `/api/varieties/sources/${SOURCE_ID}`;
const patch = async (path, body) => parse(await call('PATCH', path, body));
const isPatchUpdate = (t) => t.includes('UPDATE public.source') && t.includes('CASE WHEN');
const row = (over = {}) => ({
  id: SOURCE_ID, name: 'Baker Creek', kind: 'seed_company', locality: 'Mansfield, MO',
  address: null, website_url: null, instagram_url: null, facebook_url: null, notes: null,
  created_by: USER, deleted_at: null, ...over,
});

describe('validateSourcePatch', () => {
  it('accepts any single editable field, and a blank optional field as a clear', () => {
    expect(validateSourcePatch({ notes: 'good tomatoes' })).toBeNull();
    expect(validateSourcePatch({ instagram_url: 'https://www.instagram.com/bakercreek' })).toBeNull();
    expect(validateSourcePatch({ facebook_url: '' })).toBeNull();
    expect(validateSourcePatch({ kind: null })).toBeNull();
  });
  it('400s a non-http(s) value in EACH link field', () => {
    expect(URL_FIELDS).toEqual(['website_url', 'instagram_url', 'facebook_url']);
    for (const f of URL_FIELDS) {
      expect(validateSourcePatch({ [f]: 'instagram.com/x' }), f).toMatch(new RegExp(`${f} must start with http`));
      expect(validateSourcePatch({ [f]: 'javascript:alert(1)' }), f).toMatch(new RegExp(f));
      expect(validateSourcePatch({ [f]: 7 }), f).toMatch(new RegExp(`${f} must be a string`));
    }
  });
  it('refuses the columns a caller may not set, naming each', () => {
    for (const k of ['id', 'match_key', 'created_by', 'deleted_at']) {
      expect(validateSourcePatch({ name: 'Baker Creek', [k]: 'x' }), k).toBe(`${k} cannot be changed`);
    }
  });
  it('refuses an unknown key rather than silently dropping it, and an empty patch', () => {
    expect(validateSourcePatch({ website: 'https://x.com' })).toMatch(/unknown field: website/);
    expect(validateSourcePatch({})).toMatch(/nothing to update/);
    expect(validateSourcePatch([])).toMatch(/body required/);
  });
  it('name may be changed but never cleared — it is the one NOT NULL column', () => {
    expect(validateSourcePatch({ name: 'Baker Creek Seeds' })).toBeNull();
    expect(validateSourcePatch({ name: '' })).toMatch(/name is required/);
    expect(validateSourcePatch({ name: null })).toMatch(/name is required/);
    expect(validateSourcePatch({ name: 'A' })).toMatch(/2-200/);
  });
  it('POST validates the two new link fields the same way', () => {
    expect(validateSourceBody({ name: 'Baker Creek', instagram_url: '@bakercreek' })).toMatch(/instagram_url/);
    expect(validateSourceBody({ name: 'Baker Creek', facebook_url: 'facebook.com/x' })).toMatch(/facebook_url/);
    expect(validateSourceBody({ name: 'Baker Creek', instagram_url: '', facebook_url: '  ' })).toBeNull();
  });
});

describe('canEditSource', () => {
  const HH = [USER, OTHER];
  it('a household member may edit ANY live source, including a script principal\'s', () => {
    expect(canEditSource(HH, USER, 'system')).toBe(true);
    expect(canEditSource(HH, USER, OTHER)).toBe(true);
    expect(canEditSource(HH, USER, 'user_stranger')).toBe(true);
  });
  it('a non-member may edit only rows they created', () => {
    expect(canEditSource([USER], USER, USER)).toBe(true);
    expect(canEditSource([USER], USER, 'system')).toBe(false);
    expect(canEditSource([USER], USER, OTHER)).toBe(false);
  });
  it('fails closed on a malformed scope or an empty caller', () => {
    expect(canEditSource(undefined, USER, 'system')).toBe(false);
    expect(canEditSource([''], '', '')).toBe(false);
    // A multi-id array the caller is not IN is not membership.
    expect(canEditSource([OTHER, 'user_x'], USER, 'system')).toBe(false);
  });
});

describe('GET /api/varieties/sources/:id', () => {
  it('returns the live row with both link columns and without created_by', async () => {
    db({ sources: [row({ instagram_url: 'https://www.instagram.com/bakercreek' })] });
    const { status, body } = await get(BY_ID);
    expect(status).toBe(200);
    expect(body.id).toBe(SOURCE_ID);
    expect(body.instagram_url).toBe('https://www.instagram.com/bakercreek');
    const q = lastSql(bindsSource).text;
    expect(q).toMatch(/instagram_url, facebook_url/);
    expect(q).not.toMatch(/created_by/);
    expect(q).toMatch(/AND deleted_at IS NULL/);
  });
  it('404s a soft-deleted id, a missing id and a non-uuid id', async () => {
    db({ sources: [row({ id: DELETED_ID, deleted_at: '2026-01-01' })] });
    expect((await get(`/api/varieties/sources/${DELETED_ID}`)).status).toBe(404);
    expect((await get(`/api/varieties/sources/${OTHER_ID}`)).status).toBe(404);
    stubState.sqlCalls.length = 0;
    expect((await get('/api/varieties/sources/not-a-uuid')).status).toBe(404);
    // Refused before Postgres could 22P02 it into a 500.
    expect(stubState.sqlCalls.some((c) => bindsSource(c.text))).toBe(false);
  });
  it('is matched before the cultivar :id route, which would otherwise answer about a variety', () => {
    const idMatchIdx = SRC.indexOf('const idMatch = rawPath.match');
    const srcIdx = SRC.indexOf('rawPath.match(SOURCE_ID_RE)');
    expect(srcIdx).toBeGreaterThan(-1);
    expect(srcIdx).toBeLessThan(idMatchIdx);
  });
});

describe('PATCH /api/varieties/sources/:id', () => {
  it('writes ONLY the keys present, and returns the updated row', async () => {
    db({ sources: [row({ website_url: 'https://rareseeds.com', notes: 'keep me' })] });
    const { status, body } = await patch(BY_ID, { instagram_url: 'https://www.instagram.com/bakercreek' });
    expect(status).toBe(200);
    expect(body.instagram_url).toBe('https://www.instagram.com/bakercreek');
    expect(body.website_url).toBe('https://rareseeds.com');
    expect(body.notes).toBe('keep me');
    expect(body.created_by).toBeUndefined();
    const upd = lastSql(isPatchUpdate);
    // (present?, value) pairs in PATCH_COLUMNS order: only instagram_url's flag is true.
    const flags = PATCH_COLUMNS.map((_, i) => upd.values[2 * i]);
    expect(flags).toEqual([false, false, false, false, false, true, false, false]);
    expect(upd.values[16]).toBe(SOURCE_ID);
    expect(upd.text).toMatch(/AND deleted_at IS NULL/);
  });

  it('stores a blank optional field as NULL (a clear), trimmed values trimmed', async () => {
    db({ sources: [row({ address: '2278 Baker Creek Rd', facebook_url: 'https://www.facebook.com/bc' })] });
    const { status, body } = await patch(BY_ID, { address: '   ', facebook_url: '', locality: '  Mansfield, MO ' });
    expect(status).toBe(200);
    expect(body.address).toBeNull();
    expect(body.facebook_url).toBeNull();
    expect(body.locality).toBe('Mansfield, MO');
  });

  it('binds the audit actor BEFORE the UPDATE, inside one transaction', async () => {
    db({ sources: [row()] });
    await patch(BY_ID, { notes: 'x' });
    const cfgIdx = stubState.sqlCalls.findIndex((c) => isSetConfig(c.text));
    const updIdx = stubState.sqlCalls.findIndex((c) => isPatchUpdate(c.text));
    expect(cfgIdx).toBeGreaterThan(-1);
    expect(updIdx).toBeGreaterThan(cfgIdx);
    expect(stubState.sqlCalls[cfgIdx].values).toEqual([USER]);
    expect(SRC).toMatch(/sql\.transaction\(\[\s*sql`SELECT set_config\('app\.actor_clerk_sub', \$\{auditActor\(userId\)\}, true\)`,\s*sql`\s*UPDATE public\.source\s+SET name\s+= CASE/);
  });

  for (const f of ['website_url', 'instagram_url', 'facebook_url']) {
    it(`400s a ${f} without an http(s) scheme, before any DB work`, async () => {
      db({ sources: [row()] });
      const { status, body } = await patch(BY_ID, { [f]: 'www.example.com/bakercreek' });
      expect(status).toBe(400);
      expect(body.error).toMatch(new RegExp(f));
      expect(stubState.sqlCalls).toHaveLength(0);
    });
  }

  it('400s an attempt to set created_by, match_key, id or deleted_at', async () => {
    for (const k of ['created_by', 'match_key', 'id', 'deleted_at']) {
      const { status, body } = await patch(BY_ID, { [k]: 'x' });
      expect(status, k).toBe(400);
      expect(body.error).toBe(`${k} cannot be changed`);
    }
  });

  it('400s a kind that is not a live source kind', async () => {
    db({ sources: [row()] });
    const { status, body } = await patch(BY_ID, { kind: 'not_a_kind' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not_a_kind/);
    expect(stubState.sqlCalls.some((c) => isPatchUpdate(c.text))).toBe(false);
  });

  it('accepts clearing kind without a vocabulary lookup', async () => {
    db({ sources: [row()] });
    const { status, body } = await patch(BY_ID, { kind: '' });
    expect(status).toBe(200);
    expect(body.kind).toBeNull();
    expect(stubState.sqlCalls.some((c) => bindsSourceKind(c.text))).toBe(false);
  });

  it('404s a soft-deleted id and a missing id, without writing', async () => {
    db({ sources: [row({ id: DELETED_ID, deleted_at: '2026-01-01' })] });
    expect((await patch(`/api/varieties/sources/${DELETED_ID}`, { notes: 'x' })).status).toBe(404);
    expect((await patch(`/api/varieties/sources/${OTHER_ID}`, { notes: 'x' })).status).toBe(404);
    expect(stubState.sqlCalls.some((c) => isPatchUpdate(c.text))).toBe(false);
  });

  it('404s when the row is soft-deleted between the read and the write', async () => {
    db({ sources: [row()], restoreHits: false });
    expect((await patch(BY_ID, { notes: 'x' })).status).toBe(404);
  });

  it('409s a rename that folds onto ANOTHER live source, in the POST\'s {reason, existing} shape', async () => {
    db({ sources: [row(), row({ id: OTHER_ID, name: 'Fedco Seeds', kind: 'seed_company', locality: 'Clinton, ME' })] });
    const { status, body } = await patch(BY_ID, { name: 'fedco-seeds' });
    expect(status).toBe(409);
    expect(body.reason).toBe('exists');
    expect(body.existing.id).toBe(OTHER_ID);
    expect(body.existing.name).toBe('Fedco Seeds');
    expect(body.existing.created_by).toBeUndefined();
    expect(stubState.sqlCalls.some((c) => isPatchUpdate(c.text))).toBe(false);
    const probe = lastSql((t) => t.includes('id <> '));
    expect(probe.values).toEqual(['fedcoseeds', SOURCE_ID]);
    expect(probe.text).toMatch(/deleted_at IS NULL/);
  });

  it('does NOT 409 on a soft-deleted namesake — the unique index is partial', async () => {
    db({ sources: [row(), row({ id: DELETED_ID, name: 'Fedco Seeds', deleted_at: '2026-01-01' })] });
    const { status, body } = await patch(BY_ID, { name: 'Fedco Seeds' });
    expect(status).toBe(200);
    expect(body.name).toBe('Fedco Seeds');
  });

  it('a re-case of its own name skips the probe (it folds to itself)', async () => {
    db({ sources: [row()] });
    const { status } = await patch(BY_ID, { name: 'BAKER CREEK' });
    expect(status).toBe(200);
    expect(stubState.sqlCalls.some((c) => c.text.includes('id <> '))).toBe(false);
  });

  it('turns a lost rename race (23505) into the same 409 steer', async () => {
    const other = row({ id: OTHER_ID, name: 'Fedco Seeds' });
    db({ sources: [row()] });
    const base = stubState.sqlHandler;
    // First probe sees nothing (the other rename has not committed); the retry probe sees it.
    let probes = 0;
    stubState.sqlHandler = (text, values) => {
      if (text.includes('id <> ')) return ++probes === 1 ? [] : [other];
      return base(text, values);
    };
    stubState.transactionError = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_source_match_key_live' });
    const { status, body } = await patch(BY_ID, { name: 'Fedco Seeds' });
    expect(status).toBe(409);
    expect(body.existing.id).toBe(OTHER_ID);
  });

  it('a household member may edit a row a script principal created', async () => {
    vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${USER},${OTHER}`);
    try {
      db({ sources: [row({ created_by: 'system' })] });
      expect((await patch(BY_ID, { notes: 'x' })).status).toBe(200);
      db({ sources: [row({ created_by: OTHER })] });
      expect((await patch(BY_ID, { notes: 'x' })).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('403s a NON-member editing a \'system\' row, without writing', async () => {
    vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${OTHER},user_jen`);
    try {
      db({ sources: [row({ created_by: 'system' })] });
      const { status, body } = await patch(BY_ID, { notes: 'x' });
      expect(status).toBe(403);
      expect(body.error).toMatch(/only edit sources you added/);
      expect(stubState.sqlCalls.some((c) => isPatchUpdate(c.text))).toBe(false);
      expect(stubState.sqlCalls.some((c) => isSetConfig(c.text))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a non-member may still edit a row they created themselves', async () => {
    db({ sources: [row({ created_by: USER })] });
    expect((await patch(BY_ID, { notes: 'x' })).status).toBe(200);
  });

  it('429s past the 60/hour source.update limit', async () => {
    db({ sources: [row()], allowRate: false });
    const { status } = await patch(BY_ID, { notes: 'x' });
    expect(status).toBe(429);
    expect(lastSql(isRateLimit).values).toEqual([USER, 'source.update', 60]);
  });

  it('400s a body that is not JSON', async () => {
    const res = await handler({
      requestContext: { http: { method: 'PATCH' } }, rawPath: BY_ID,
      headers: { authorization: 'Bearer stub-token' }, body: '{nope',
    });
    expect(res.statusCode).toBe(400);
  });

  it('405s DELETE (and PUT) — this route edits, it does not delete', async () => {
    db({ sources: [row()] });
    expect((await parse(await call('DELETE', BY_ID))).status).toBe(405);
    expect((await parse(await call('PUT', BY_ID, { notes: 'x' }))).status).toBe(405);
    expect(stubState.sqlCalls.some((c) => c.text.includes('UPDATE public.source'))).toBe(false);
  });
});

describe('POST /api/varieties/sources — the two link columns', () => {
  it('inserts instagram_url and facebook_url, blanks as NULL', async () => {
    const { status, body } = await post('/api/varieties/sources', {
      name: 'Bardwell Farm Stand', instagram_url: 'https://www.instagram.com/bardwell', facebook_url: '',
    });
    expect(status).toBe(201);
    expect(body.instagram_url).toBe('https://www.instagram.com/bardwell');
    expect(body.facebook_url).toBeNull();
  });
});

describe('auth', () => {
  it('401s before touching the database', async () => {
    stubState.verifyTokenResult = new Error('bad token');
    const { status } = await get('/api/varieties/sources');
    expect(status).toBe(401);
    expect(stubState.sqlCalls).toHaveLength(0);
  });
});
