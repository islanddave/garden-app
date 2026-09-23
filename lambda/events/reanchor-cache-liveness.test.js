// BUG-CACHEORPHANREGRESS-001 — the PUT's plant-keyed care-cache upsert never writes a SOFT-DELETED
// planting.
//
// WHAT IS GUARDED. The `if (newPlantId)` upsert of the PUT /api/events/:id re-anchor block. The route
// reaches an event whose planting was soft-deleted (its container is live, so both ownership predicates
// pass), and the Deleted-Planting History Rule keeps that event live and editable: 56 such events on 7
// plantings on prod on 2026-09-23. When the edit does not move the event, the upsert's planting IS the
// soft-deleted one, and until this change a date/type/flag edit wrote its cache row — the row the plants
// DELETE removes with the soft-delete, counted by integrity-weekly-check.sh's entity_memory_orphans
// (migrations/v5-cacheorphan-001). The statement must now write a live or ARCHIVED planting and never a
// soft-deleted one (archived keeps its row: v4-cachemissingrow-001), and the edit itself must still
// succeed and answer exactly as before.
//
// METHOD. The handler is IMPORTED and driven through the Lambda runtime stubs (lambda/_test-stubs,
// aliased in vitest.config.ts). The neon mock below is per-file, as in lambda/plants/put-source-refs.test.js
// (the shared stub has no sql.transaction), with one difference that matters here: a statement is
// recorded only when it is SENT — awaited, or handed to sql.transaction — so a statement built in a
// branch that never runs, or built and then dropped, is never mistaken for the one the database gets.
// The upsert that was sent is parsed into its top-level SELECT's FROM list and WHERE and evaluated for
// the four states a planting can be in on deleted_at x archived_at: the planting's two columns are
// PINNED from the state, its key term (id = the bound planting) is TRUE, every other term is left free.
// The join type is READ: under a plain FROM or an INNER join the ON and the WHERE both filter; under a
// LEFT join the ON only decides whether the planting's columns are filled, and a row whose ON failed
// reaches the WHERE with all of them NULL.
//
// WHY NOT lambda/daily-plan/weatherdaily.test.js's MODEL. That one takes event_log as the base relation,
// because its statements aggregate events per parent. This statement writes ONE planting named by a bound
// value, so the planting must be keyed to that same bound value instead. The shape is kept narrow on
// purpose: the WHERE must be a conjunction, and a planting term the model cannot place (inside an OR, a
// NOT, a COALESCE, a CASE, a subquery, or another relation's ON) THROWS rather than being scored. An
// unusual but correct spelling therefore fails loudly and has to be written plainly.
//
// LIMIT: the stub records SQL and runs none of it. This proves the statement's shape, not the rows it
// matches; tests/integration/reanchor-carecache.int.test.js drives the same route on real Postgres for
// live and archived plantings, and tests/integration/reanchor-cache-liveness.int.test.js for a
// soft-deleted one.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const rec = vi.hoisted(() => ({ sent: [], tx: 0, respond: () => [] }));

vi.mock('@neondatabase/serverless', () => ({
  neon: () => {
    const text = (strings) => strings.reduce((acc, s, i) => acc + (i ? `$${i}` : '') + s, '');
    const sql = (strings, ...values) => {
      const q = { text: text(strings), values };
      // Lazy, like the real driver's query promise: nothing is recorded until the query is sent.
      Object.defineProperty(q, 'then', {
        enumerable: false,
        value: (ok, err) => {
          rec.sent.push({ text: q.text, values: q.values, tx: null });
          return Promise.resolve().then(() => rec.respond(q)).then(ok, err);
        },
      });
      return q;
    };
    sql.transaction = async (stmts) => {
      rec.tx += 1;
      const out = [];
      for (const q of stmts) {
        rec.sent.push({ text: q.text, values: q.values, tx: rec.tx });
        out.push(await rec.respond(q));
      }
      return out;
    };
    return sql;
  },
}));

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const EVENT = '5e0a7c1d-2b3f-4a6e-9c8d-1f2e3d4c5b6a';
const CONTAINER = 'c0c0c0c0-1111-4222-8333-444455556666';
const PLANTING = 'a1a1a1a1-2222-4333-8444-555566667777';
const OTHER_PLANTING = 'b2b2b2b2-3333-4444-8555-666677778888';

// The event under edit: a watering in a live container, on a planting whose own row the ownership
// SELECT's `pn` join (deleted_at IS NULL) did not find — which is what a soft-deleted planting looks
// like to this route. It is admitted through the container arm, exactly as on prod.
const OWNED = {
  id: EVENT, event_type: 'watering', plant_id: PLANTING, event_date: '2026-08-01T12:00:00.000Z',
  flagged_as_issue: false, severity: null, project_id: CONTAINER, location_id: null, harvest_log_id: null,
  project_owner_id: USER, plant_owner_id: null, plant_project_id: CONTAINER,
};
const UPDATED = {
  id: EVENT, project_id: CONTAINER, location_id: null, plant_id: PLANTING, event_type: 'watering',
  event_date: '2026-08-02T12:00:00.000Z', title: null, notes: null, private_notes: null, quantity: null,
  is_public: false, logged_by: USER, created_at: '2026-08-01T12:00:05.000Z',
  updated_at: '2026-09-23T12:00:00.000Z', flagged_as_issue: false, severity: null, resolved_at: null,
  resolved_by: null, treatment_product_id: null, treatment_product_text: null, treatment_category: null,
  treatment_amount: null, pest_target: null, metadata: null,
};

function respond({ text, values }) {
  if (/AS plant_project_id/.test(text)) return [OWNED];
  if (/FROM public\.plants gn\s+LEFT JOIN public\.plant_projects pp/.test(text)) {
    return [{ id: values[0], name: 'Other planting', project_id: CONTAINER }];
  }
  if (/set_config\('app\.actor_clerk_sub'/.test(text)) return [{ set_config: USER }];
  if (/UPDATE event_log el/.test(text)) return [UPDATED];
  return [];
}

async function put(body) {
  rec.sent = [];
  const res = await handler({
    requestContext: { http: { method: 'PUT' } },
    rawPath: `/api/events/${EVENT}`,
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}'), sent: rec.sent };
}
const plantUpserts = (sent) => sent.filter((s) => /INSERT INTO entity_memory/i.test(s.text)
  && /ON CONFLICT \(plant_id\)/i.test(s.text));

// ─── the model ─────────────────────────────────────────────────────────────────────────────────────

const STATES = {
  live: { deleted_at: false, archived_at: false },
  deleted: { deleted_at: true, archived_at: false },
  archived: { deleted_at: false, archived_at: true },
  deletedAndArchived: { deleted_at: true, archived_at: true },
};
// The ONLY acceptable answer: a soft-deleted planting gets no row, an archived one does.
const DELETED_REFUSED = { live: true, deleted: false, archived: true, deletedAndArchived: false };
const EVERY_STATE = { live: true, deleted: true, archived: true, deletedAndArchived: true };
const PARENTS = ['garden_node', 'plants'];

// SQL as Postgres reads it: comments out (a quoted `--` stays a literal), lower-cased outside string
// literals, tokenised, and every `::type` cast dropped.
const COMMENT = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g;
const TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\$\d+|[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)*|\d+(?:\.\d+)?|::|<>|<=|>=|!=|\S/g;
function tokens(sql) {
  const raw = sql
    .replace(COMMENT, (m) => (m.startsWith('--') || m.startsWith('/*') ? ' ' : m))
    .replace(/'(?:[^']|'')*'|[^']+/g, (m) => (m.startsWith("'") ? m : m.toLowerCase()))
    .match(TOKEN) ?? [];
  const out = [];
  for (let k = 0; k < raw.length; k += 1) {
    if (raw[k] === '::') { k += 1; if (raw[k + 1] === '[' && raw[k + 2] === ']') k += 2; continue; }
    out.push(raw[k]);
  }
  return out;
}

function closeOf(t, open) {
  for (let depth = 0, k = open; k < t.length; k += 1) {
    if (t[k] === '(') depth += 1;
    else if (t[k] === ')' && --depth === 0) return k;
  }
  throw new Error(`unbalanced ( at token ${open}`);
}

// Split at depth-0 `sep`. BETWEEN's own AND, and anything inside CASE ... END, stay in their term.
function splitTop(t, sep) {
  const out = [[]];
  for (let k = 0, depth = 0, cases = 0, between = false; k < t.length; k += 1) {
    const w = t[k];
    if (w === '(') depth += 1;
    else if (w === ')') depth -= 1;
    else if (w === 'case') cases += 1;
    else if (w === 'end') cases -= 1;
    else if (depth === 0 && cases === 0) {
      if (w === 'between') between = true;
      else if (w === 'and' && between) between = false;
      else if (w === sep) { out.push([]); continue; }
    }
    out.at(-1).push(w);
  }
  return out;
}

// A clause's conjuncts; a depth-0 OR keeps the clause as ONE term (the caller throws if it names the
// planting's columns).
function conjuncts(t) {
  if (!t.length) return [];
  if (splitTop(t, 'or').length > 1) return [t];
  return splitTop(t, 'and').flatMap((term) => {
    if (!term.length) throw new Error('an empty term in a conjunction');
    const wrapped = term[0] === '(' && closeOf(term, 0) === term.length - 1 && !/^(select|with|values)$/.test(term[1]);
    return wrapped ? conjuncts(term.slice(1, -1)) : [term];
  });
}

const JOIN_WORDS = new Set(['join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'outer', 'lateral']);
function fromItems(t) {
  const items = [];
  let k = 0;
  const relation = (how) => {
    let table;
    if (t[k] === 'lateral') throw new Error('LATERAL in the FROM list: this model reads plain relations only');
    if (t[k] === '(') { table = '(derived)'; k = closeOf(t, k) + 1; } else { table = String(t[k]).replace(/^public\./, ''); k += 1; }
    if (t[k] === 'as') k += 1;
    const alias = t[k] !== undefined && !JOIN_WORDS.has(t[k]) && !['on', 'using', ','].includes(t[k]) ? t[k++] : table;
    if (t[k] === '(') k = closeOf(t, k) + 1; // a derived table's column list
    if (t[k] === 'using') throw new Error('JOIN ... USING: this model reads ON only');
    const item = { table, alias, how, on: [] };
    if (t[k] === 'on') {
      const start = ++k;
      for (let depth = 0; k < t.length; k += 1) {
        if (t[k] === '(') depth += 1;
        else if (t[k] === ')') depth -= 1;
        else if (depth === 0 && (t[k] === ',' || JOIN_WORDS.has(t[k]))) break;
      }
      item.on = t.slice(start, k);
    }
    items.push(item);
  };
  relation('from');
  while (k < t.length) {
    if (t[k] === ',') { k += 1; relation('inner'); continue; }
    const words = [];
    while (t[k] !== 'join') {
      if (!JOIN_WORDS.has(t[k])) throw new Error(`unexpected "${t[k]}" in the FROM list`);
      words.push(t[k]);
      k += 1;
    }
    k += 1;
    const kind = words.join(' ');
    const how = kind === '' || kind === 'inner' ? 'inner' : kind === 'left' || kind === 'left outer' ? 'left' : null;
    if (!how) throw new Error(`${kind} join: this model reads JOIN, INNER JOIN and LEFT [OUTER] JOIN only`);
    relation(how);
  }
  return items;
}

// Which planting states the upsert writes, and which planting it writes. `values[n - 1]` is `$n`.
function plantUpsertModel(sql, values) {
  const t = tokens(sql);
  const depth = [];
  t.reduce((d, w) => { const here = w === ')' ? d - 1 : d; depth.push(here); return w === '(' ? d + 1 : here; }, 0);
  if (!(t[0] === 'insert' && t[1] === 'into' && /^(public\.)?entity_memory$/.test(t[2]) && t[3] === '(')) {
    throw new Error('not an INSERT INTO entity_memory (...) statement');
  }
  const colsEnd = closeOf(t, 3);
  if (t[4] !== 'plant_id') throw new Error('the first inserted column is not plant_id: this model reads the plant-keyed upsert only');
  const s = colsEnd + 1;
  if (t[s] !== 'select') throw new Error('no SELECT right after the column list');
  const at = (from, test) => t.findIndex((w, k) => k > from && depth[k] === 0 && test(w, k));
  const end = (() => { const e = at(s, (w, k) => (w === 'on' && t[k + 1] === 'conflict') || w === 'returning' || w === ';'); return e < 0 ? t.length : e; })();
  const stray = at(s, (w, k) => k < end && ['group', 'having', 'order', 'limit', 'offset', 'union', 'except', 'intersect', 'window'].includes(w));
  if (stray >= 0) throw new Error(`the SELECT carries ${t[stray].toUpperCase()}: this model reads SELECT ... [FROM ...] [WHERE ...] only`);
  const f = at(s, (w, k) => k < end && w === 'from');
  const wh = at(s, (w, k) => k < end && w === 'where');
  const list = t.slice(s + 1, f >= 0 ? f : wh >= 0 ? wh : end);
  const first = splitTop(list, ',')[0];
  if (first.length !== 1 || !/^\$\d+$/.test(first[0])) {
    throw new Error('the written plant_id is not a bare bound value: this model reads that shape only');
  }
  const writes = values[Number(first[0].slice(1)) - 1];
  const where = wh < 0 ? [] : t.slice(wh + 1, end);
  const items = f < 0 ? [] : fromItems(t.slice(f + 1, wh >= 0 ? wh : end));
  const hidden = where.find((w) => PARENTS.includes(w.replace(/^public\./, '')));
  if (hidden) throw new Error(`the WHERE reads ${hidden} itself (a subquery): a planting term this model cannot place`);
  const bound = items.filter((it) => PARENTS.includes(it.table));
  if (bound.length > 1) throw new Error(`the planting is bound ${bound.length} times: "the planting" is ambiguous`);
  if (!bound.length) return { writes, parent: null, pinned: [], admits: { ...EVERY_STATE } };
  const [p] = bound;
  const cols = new Map([[`${p.alias}.deleted_at`, 'deleted_at'], [`${p.alias}.archived_at`, 'archived_at']]);
  const names = (toks) => toks.some((w) => cols.has(w));
  for (const it of items) {
    if (it !== p && names(it.on)) throw new Error(`the planting's filter sits in the ON of ${it.table}, not its own`);
  }
  const keyOf = (text) => {
    const m = text.match(new RegExp(`^(?:${p.alias}\\.id = (\\$\\d+)|(\\$\\d+) = ${p.alias}\\.id)$`));
    return m ? values[Number((m[1] ?? m[2]).slice(1)) - 1] : undefined;
  };
  const classify = (terms, place) => terms.map((term) => {
    const text = term.join(' ');
    for (const [c, col] of cols) {
      if (text === `${c} is null`) return { text, col, isNull: true };
      if (text === `${c} is not null`) return { text, col, isNull: false };
    }
    if (names(term)) throw new Error(`the planting's filter is buried in ${place}, inside an expression this model cannot evaluate: ${text.slice(0, 90)}`);
    return { text, key: keyOf(text) };
  });
  const on = classify(conjuncts(p.on), 'its ON');
  const wt = classify(conjuncts(where), 'the WHERE');
  const keys = (p.how === 'left' ? on : [...on, ...wt]).filter((x) => x.key !== undefined);
  if (!keys.length) throw new Error(`${p.table} is not keyed to a bound planting${p.how === 'left' ? ' in its ON' : ''}`);
  if (keys.some((x) => x.key !== writes)) throw new Error(`the statement reads a different planting (${keys.map((x) => x.key).join(', ')}) from the one it writes (${writes})`);
  const holds = (terms, state) => terms.every((x) => !x.col || (x.isNull ? !state[x.col] : state[x.col]));
  const NULLS = { deleted_at: false, archived_at: false };
  const admits = Object.fromEntries(Object.entries(STATES).map(([name, state]) => [name,
    p.how === 'left' ? holds(wt, holds(on, state) ? state : NULLS) : holds(on, state) && holds(wt, state)]));
  return { writes, parent: { table: p.table, alias: p.alias, how: p.how }, pinned: [...on, ...wt].filter((x) => x.col).map((x) => x.text), admits };
}

// A synthetic upsert in the handler's shape, for the bench. $4 is the planting written; $5 is another.
const P = PLANTING;
const Q = OTHER_PLANTING;
const BENCH_VALUES = [P, P, P, P, Q];
const UPSERT = (tail) => `INSERT INTO entity_memory
    (plant_id, last_event_at, last_watered_at)
  SELECT $4::uuid,
    (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = $1 AND e.deleted_at IS NULL),
    (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = $2 AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL)
  ${tail}
  ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO UPDATE SET
    last_event_at = EXCLUDED.last_event_at,
    updated_at = NOW()`;
const benchModel = (tail) => plantUpsertModel(UPSERT(tail), BENCH_VALUES);

// ─── the tests ─────────────────────────────────────────────────────────────────────────────────────

describe('BUG-CACHEORPHANREGRESS-001 — the event PUT never writes the care cache of a soft-deleted planting', () => {
  beforeEach(() => {
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    rec.respond = respond;
  });

  // A date edit: the cache is dirty, the event is not moved, so the upsert's planting is the event's own.
  const EDIT = { event_type: 'watering', event_date: '2026-08-02T12:00:00.000Z' };

  it('the JS path: a date edit answers 200 with the row the event UPDATE returned, and sends that UPDATE once, in a transaction', async () => {
    // What this does NOT prove (preship-qa M6): respond() hands back the same owned and updated rows
    // whatever the planting's state, so no soft-deleted planting is involved and no SQL runs. The same
    // edit on a real soft-deleted planting (200, the event moved, no cache row created, an orphan row
    // left byte-identical) is tests/integration/reanchor-cache-liveness.int.test.js.
    const { status, body, sent } = await put(EDIT);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ ...UPDATED, harvest: null });
    const updates = sent.filter((s) => /UPDATE event_log el/.test(s.text));
    expect(updates, 'the event UPDATE is sent once, in its own transaction').toHaveLength(1);
    expect(updates[0].tx).not.toBeNull();
  });

  it('sends exactly one plant-keyed cache upsert, for the event\'s own planting, reading it (vacuity floor)', async () => {
    const { sent } = await put(EDIT);
    const ups = plantUpserts(sent);
    expect(ups, 'the date edit no longer sends the plant-keyed upsert').toHaveLength(1);
    expect(ups[0].tx, 'sent inside the re-anchor transaction').not.toBeNull();
    const m = plantUpsertModel(ups[0].text, ups[0].values);
    expect(m.writes).toBe(PLANTING);
    expect(m.parent, 'the upsert no longer reads its planting: a soft-deleted one gets a row').not.toBeNull();
    // Named here, so a lost filter reports THAT rather than only a state table below.
    expect(m.pinned.some((x) => x.startsWith(`${m.parent.alias}.deleted_at `)), 'no deleted_at term on the planting').toBe(true);
  });

  it('the upsert writes a live or archived planting and never a soft-deleted one', async () => {
    const [u] = plantUpserts((await put(EDIT)).sent);
    const m = plantUpsertModel(u.text, u.values);
    expect(m.admits.live, 'the upsert writes no live planting: the writer, or this model, has gone dead').toBe(true);
    expect(m.admits.archived, 'an archived planting loses its cache row (v4-cachemissingrow-001)').toBe(true);
    expect(m.admits, 'the upsert writes these planting states').toEqual(DELETED_REFUSED);
  });

  it('holds when the edit MOVES the event, and keys the planting it moves TO', async () => {
    const { status, sent } = await put({ ...EDIT, plant_id: OTHER_PLANTING });
    expect(status).toBe(200);
    const ups = plantUpserts(sent);
    expect(ups).toHaveLength(1);
    const m = plantUpsertModel(ups[0].text, ups[0].values);
    expect(m.writes).toBe(OTHER_PLANTING);
    expect(m.admits).toEqual(DELETED_REFUSED);
  });

  it('reads the filter from the statement, not its spelling (synthetic statements)', () => {
    // The same model on statements no writer contains, so it is shown to SEPARATE the shapes rather than
    // merely agree with today's handler.
    const REFUSED = [
      'FROM public.garden_node gn WHERE gn.id = $4::uuid AND gn.deleted_at IS NULL',              // the handler's shape
      'FROM public.plants p WHERE p.deleted_at IS NULL AND $4 = p.id',                              // the table, key flipped
      'FROM garden_node AS gn WHERE (gn.id = $4) AND (gn.deleted_at IS NULL)',                     // parenthesised terms
      'FROM (SELECT 1) one JOIN public.garden_node gn ON gn.id = $4::uuid AND gn.deleted_at IS NULL',  // an INNER join's ON
      'FROM (SELECT 1) one LEFT JOIN public.garden_node gn ON gn.id = $4::uuid WHERE gn.deleted_at IS NULL',  // LEFT, filter in the WHERE
      "FROM public.garden_node gn WHERE gn.id = $4 AND gn.deleted_at IS NULL AND gn.status IS DISTINCT FROM 'ended'",  // another term stays free
      "FROM public.garden_node gn WHERE 'x--' <> 'y' AND gn.id = $4 AND gn.deleted_at IS NULL",  // a quoted -- is not a comment
    ];
    for (const tail of REFUSED) expect(benchModel(tail).admits, tail).toEqual(DELETED_REFUSED);
    const T = true;
    const F = false;
    const LEAKS = [
      ['', EVERY_STATE],                                                                            // no FROM (the regression)
      ['WHERE $4::uuid IS NOT NULL', EVERY_STATE],                                                 // a self-guard, no planting
      ['FROM public.garden_node gn WHERE gn.id = $4', EVERY_STATE],                                // keyed, never filtered
      ['FROM public.garden_node gn WHERE gn.id = $4 AND gn.deleted_at IS NOT NULL', { live: F, deleted: T, archived: F, deletedAndArchived: T }],  // inverted
      ['FROM public.garden_node gn WHERE gn.id = $4 AND gn.archived_at IS NULL', { live: T, deleted: T, archived: F, deletedAndArchived: F }],   // archived instead
      ['FROM public.garden_node gn WHERE gn.id = $4 AND gn.deleted_at IS NULL AND gn.archived_at IS NULL', { ...DELETED_REFUSED, archived: F }],  // archived as well
      ['FROM (SELECT 1) one LEFT JOIN public.garden_node gn ON gn.id = $4 AND gn.deleted_at IS NULL', EVERY_STATE],  // LEFT, filter in the ON
      ['FROM (SELECT 1) one LEFT JOIN public.garden_node gn ON gn.id = $4 AND gn.deleted_at IS NULL WHERE gn.deleted_at IS NULL', EVERY_STATE],  // ...and repeated: the NULLs pass it
      ['FROM public.garden_node gn WHERE gn.id = $4\n  -- AND gn.deleted_at IS NULL\n', EVERY_STATE],  // a line comment
      ['FROM public.garden_node gn WHERE gn.id = $4 /* AND gn.deleted_at IS NULL */', EVERY_STATE],    // a block comment
      ['FROM public.garden_node gn JOIN public.container ct ON ct.id = gn.container_id WHERE gn.id = $4 AND ct.deleted_at IS NULL', EVERY_STATE],  // the container's, not the planting's
    ];
    for (const [tail, admits] of LEAKS) expect(benchModel(tail).admits, tail).toEqual(admits);
    const THROWS = [
      ['FROM public.garden_node gn WHERE gn.id = $4 AND (gn.deleted_at IS NULL OR $4::uuid IS NOT NULL)', /buried/],
      ['FROM public.garden_node gn WHERE gn.id = $4 AND COALESCE(gn.deleted_at, gn.archived_at) IS NULL', /buried/],
      ['FROM public.garden_node gn WHERE gn.id = $4 AND NOT gn.deleted_at IS NOT NULL', /buried/],
      ['WHERE EXISTS (SELECT 1 FROM public.garden_node g2 WHERE g2.id = $4 AND g2.deleted_at IS NULL)', /cannot place/],
      ['FROM public.garden_node gn WHERE gn.id = $5 AND gn.deleted_at IS NULL', /different planting/],
      ['FROM public.garden_node gn WHERE gn.deleted_at IS NULL', /not keyed/],
      ['FROM (SELECT 1) one LEFT JOIN public.garden_node gn ON gn.deleted_at IS NULL WHERE gn.id = $4', /not keyed/],
      ['FROM public.garden_node gn, public.plants p2 WHERE gn.id = $4 AND p2.id = $4 AND gn.deleted_at IS NULL', /ambiguous/],
      ['FROM (SELECT 1) one RIGHT JOIN public.garden_node gn ON gn.id = $4 WHERE gn.deleted_at IS NULL', /JOIN only/],
      ['FROM public.garden_node gn JOIN public.container ct USING (id) WHERE gn.id = $4 AND gn.deleted_at IS NULL', /USING/],
      ['FROM public.garden_node gn JOIN public.container ct ON ct.id = gn.container_id AND gn.deleted_at IS NULL WHERE gn.id = $4', /ON of container/],
      ['FROM public.garden_node gn WHERE gn.id = $4 AND gn.deleted_at IS NULL GROUP BY gn.id', /GROUP/],
    ];
    for (const [tail, re] of THROWS) expect(() => benchModel(tail), tail).toThrow(re);
    // The written planting has to be the bound value the key names.
    expect(() => plantUpsertModel(UPSERT('FROM public.garden_node gn WHERE gn.id = $4 AND gn.deleted_at IS NULL').replace('SELECT $4::uuid', 'SELECT gn.id'), BENCH_VALUES))
      .toThrow(/bare bound value/);
    expect(() => plantUpsertModel(UPSERT('').replace('(plant_id,', '(project_id,'), BENCH_VALUES)).toThrow(/plant-keyed upsert only/);
  });
});
