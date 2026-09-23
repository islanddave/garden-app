// BUG-PLANTSLISTARCHIVEDCONTAINER-001 — the Garden grid (?view=grid) and the planting chooser
// (?view=picker) do not return a planting whose CONTAINER is archived.
//
// WHAT IS GUARDED. Both branches LEFT JOIN container and gated it on `pp.deleted_at` only, so a live
// planting in an archived container stayed on the Garden grid and in every chooser while the daily
// plan's plantings query (`pj.archived_at is null`) and the rain writer
// (`ct.id is null or (ct.deleted_at is null and ct.archived_at is null)`) hide it. Neither container
// state cascades to the plantings: lambda/projects' archive PATCH sets the container's own column and
// nothing else. The fix is `AND pp.archived_at IS NULL`, its own top-level clause in each WHERE — the
// container's OWN archived_at, as those two readers test it, with no ancestor walk.
//
// WHY THE AXES ARE EVALUATED SEPARATELY (claude-ops/project-rules/gardening.md, Archive-Hiding Rule):
// archived and deleted are different axes on different columns and must stay separately observable —
// a row hidden by the wrong predicate is a latent bug even when today's visible outcome is identical.
// So an archived-only container and a deleted-only container are each required to be refused on
// their own, and swapping the new clause's column for deleted_at reds here.
//
// METHOD — the statement the handler actually SENDS, not source text. index.js is imported under the
// house stubs (vitest.config.ts aliases Clerk/AWS/Neon to lambda/_test-stubs) with a recording neon
// that builds the query text the way the real driver does ($1..$n placeholders) and ANSWERS it by
// evaluating that very text against a fixture table: the outer FROM is read (the planting's alias,
// the container's alias, its join kind and its ON), the outer WHERE is parsed to a boolean tree, and
// every term is evaluated for each fixture row in SQL's three-valued logic with the statement's own
// bound parameters (the household id array, the NULL project scope). A LEFT JOIN whose ON fails
// NULL-extends the container, exactly as Postgres does. The HTTP response is then read back, so an
// assertion is about the plantings the route returns, not about where a string sits.
//
// CONSERVATIVE BY CONSTRUCTION. Any term the model cannot evaluate — a function call, a subquery, an
// alias it does not know, a join other than LEFT besides the container's — THROWS rather than being
// scored, so a rewrite into a shape this file cannot read reds instead of passing.
//
// NOT the parser in lambda/daily-plan/rain-live-filter.test.js. That one pins a state and leaves every
// other term FREE, which cannot evaluate `= ANY($n)` or a bound project scope; this one evaluates
// concrete rows against concrete parameters. The two answer the same question for different
// statements, and the container table they require is the same one (CONTAINER_REFUSED there).
//
// LIMIT, stated plainly: this is a model of Postgres, not Postgres. The Lambda unit suite never runs
// SQL; nothing here proves the statement executes. The read-only prod comparison that does is in the
// lane findings (_mainsync6_20260923/lane-plantsarchived-20260923.md): 244 rows before and after, 0
// dropped, because no live planting sat in an archived container on 2026-09-23.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

// A recording neon. The real driver turns a tagged template into `$1..$n` + a parameter array; this
// does the same, records it, and hands it to whatever sqlHandler the test installed.
vi.mock('@neondatabase/serverless', async () => {
  const { stubState: st } = await import('../_test-stubs/state.js');
  return {
    neon: () => async (strings, ...values) => {
      const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`);
      st.sqlCalls.push({ text, values });
      return st.sqlHandler(text, values);
    },
  };
});

const { handler } = await import('./index.js');

// ── the statement model ────────────────────────────────────────────────────────────────────────────
// Comments as POSTGRES reads them: quoted strings are matched first, so a `--` inside a literal stays a
// literal and an apostrophe inside a `--` comment is consumed with the comment.
const SQL_COMMENT = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g;
const flat = (sql) => sql
  .replace(SQL_COMMENT, (m) => (m.startsWith('--') || m.startsWith('/*') ? ' ' : m))
  .replace(/\s+/g, ' ')
  .replace(/'(?:[^']|'')*'|[^']+/g, (m) => (m.startsWith("'") ? m : m.toLowerCase()));
const TOKEN = /'(?:[^']|'')*'|\$\d+|::|[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*|\d+(?:\.\d+)?|<>|!=|<=|>=|\S/g;
const tokensOf = (sql) => flat(sql).match(TOKEN) ?? [];

function matching(tokens, open) {
  for (let depth = 0, k = open; k < tokens.length; k += 1) {
    if (tokens[k] === '(') depth += 1;
    else if (tokens[k] === ')' && --depth === 0) return k;
  }
  throw new Error(`unbalanced ( at token ${open}`);
}

// The outer statement's top-level clauses: the FROM list and the WHERE, each as its own token run.
const CLAUSE_END = new Set(['order', 'group', 'limit', 'having', 'offset', 'union', 'returning', 'window', 'for']);
function outerClauses(tokens) {
  const at = { from: [], where: [] };
  let end = tokens.length;
  for (let depth = 0, k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t === '(') depth += 1;
    else if (t === ')') depth -= 1;
    else if (depth === 0 && (t === 'from' || t === 'where')) at[t].push(k);
    else if (depth === 0 && at.where.length && end === tokens.length && CLAUSE_END.has(t)) end = k;
  }
  if (at.from.length !== 1) throw new Error(`expected exactly 1 top-level FROM, found ${at.from.length}`);
  if (at.where.length !== 1) throw new Error(`expected exactly 1 top-level WHERE, found ${at.where.length}`);
  return { from: tokens.slice(at.from[0] + 1, at.where[0]), where: tokens.slice(at.where[0] + 1, end) };
}

// The FROM list split at its top-level JOINs: [{ kind, table, alias, on }]. A LATERAL subquery is one
// item whose table is `(subquery)`; its own FROM/WHERE are inside parentheses and never read.
const JOIN_MODS = new Set(['left', 'inner', 'outer', 'right', 'full', 'cross']);
function fromItems(fromToks) {
  const segs = [];
  let cur = { kind: 'from', toks: [] };
  for (let depth = 0, k = 0; k < fromToks.length; k += 1) {
    const t = fromToks[k];
    if (t === '(') depth += 1;
    else if (t === ')') depth -= 1;
    if (depth === 0 && t === 'join') {
      const mods = [];
      while (cur.toks.length && JOIN_MODS.has(cur.toks[cur.toks.length - 1])) mods.unshift(cur.toks.pop());
      segs.push(cur);
      cur = { kind: [...mods.filter((m) => m !== 'outer'), 'join'].join(' '), toks: [] };
      continue;
    }
    cur.toks.push(t);
  }
  segs.push(cur);
  return segs.map(({ kind, toks }) => {
    let k = 0;
    if (toks[k] === 'lateral') k += 1;
    let table;
    if (toks[k] === '(') { const close = matching(toks, k); table = '(subquery)'; k = close + 1; } else { table = toks[k]; k += 1; }
    if (toks[k] === 'as') k += 1;
    const alias = toks[k];
    k += 1;
    let on = null;
    if (toks[k] === 'on') on = toks.slice(k + 1);
    else if (k < toks.length) throw new Error(`unreadable FROM item: ${toks.join(' ').slice(0, 120)}`);
    return { kind, table, alias, on };
  });
}

// Boolean tree over one predicate run. Grammar: or / and / not / ( group ) / predicate, where a
// predicate is `x IS [NOT] NULL`, `x = y`, `x <> y`, `x = ANY(y)` or a bare TRUE/FALSE/NULL, and an
// operand is alias.col, $n (with an ignored ::cast), NULL, TRUE, FALSE or a quoted literal. Anything
// else throws, so a shape this model cannot read is never scored.
function parseBool(tokens) {
  let i = 0;
  const where = () => `"${tokens.slice(Math.max(0, i - 3), i + 6).join(' ')}"`;
  const operand = () => {
    const t = tokens[i];
    let op;
    if (t === undefined) throw new Error('predicate ends early');
    if (/^\$\d+$/.test(t)) op = { kind: 'param', n: Number(t.slice(1)) };
    else if (t === 'null') op = { kind: 'lit', value: null };
    else if (t === 'true' || t === 'false') op = { kind: 'lit', value: t === 'true' };
    else if (t.startsWith("'")) op = { kind: 'lit', value: t.slice(1, -1).replaceAll("''", "'") };
    else if (/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(t)) op = { kind: 'col', ref: t };
    else throw new Error(`the model cannot evaluate an operand at ${where()}`);
    i += 1;
    if (tokens[i] === '::') i += 2;
    if (tokens[i] === '(') throw new Error(`the model cannot evaluate a function call at ${where()}`);
    return op;
  };
  const predicate = () => {
    const left = operand();
    const t = tokens[i];
    if (t === 'is') {
      i += 1;
      const neg = tokens[i] === 'not';
      if (neg) i += 1;
      if (tokens[i] !== 'null') throw new Error(`the model cannot evaluate IS at ${where()}`);
      i += 1;
      return { op: 'isnull', arg: left, neg };
    }
    if (t === '=' || t === '<>' || t === '!=') {
      i += 1;
      if (t === '=' && tokens[i] === 'any') {
        if (tokens[i + 1] !== '(') throw new Error(`ANY without ( at ${where()}`);
        i += 2;
        const arr = operand();
        if (tokens[i] !== ')') throw new Error(`the model cannot evaluate ANY(...) at ${where()}`);
        i += 1;
        return { op: 'any', left, arr };
      }
      return { op: t === '=' ? 'eq' : 'ne', left, right: operand() };
    }
    if (left.kind === 'lit' && (left.value === null || typeof left.value === 'boolean')) return { op: 'lit', value: left.value };
    throw new Error(`the model cannot evaluate a predicate at ${where()}`);
  };
  const unary = () => {
    if (tokens[i] === 'not') { i += 1; return { op: 'not', arg: unary() }; }
    if (tokens[i] === '(') {
      if (tokens[i + 1] === 'select' || tokens[i + 1] === 'with') throw new Error(`the model cannot evaluate a subquery at ${where()}`);
      const close = matching(tokens, i);
      const inner = parseBool(tokens.slice(i + 1, close));
      i = close + 1;
      return inner;
    }
    return predicate();
  };
  const chain = (op, next) => () => {
    const args = [next()];
    while (tokens[i] === op) { i += 1; args.push(next()); }
    return args.length === 1 ? args[0] : { op, args };
  };
  if (!tokens.length) throw new Error('empty predicate');
  const tree = chain('or', chain('and', unary))();
  if (i !== tokens.length) throw new Error(`the predicate did not parse to its end — stopped at ${where()}`);
  return tree;
}

const colsOf = (node) => (node.op === 'isnull' ? [node.arg] : node.op === 'any' ? [node.left, node.arr]
  : node.op === 'eq' || node.op === 'ne' ? [node.left, node.right] : [])
  .filter((o) => o.kind === 'col').map((o) => o.ref)
  .concat(node.arg && node.op === 'not' ? colsOf(node.arg) : [], (node.args ?? []).flatMap(colsOf));

// Postgres three-valued logic. EVERY argument is evaluated — no short circuit — so a term the model
// cannot evaluate throws even when a sibling has already decided the answer.
function truth(node, env, values) {
  const val = (o) => {
    if (o.kind === 'lit') return o.value;
    if (o.kind === 'param') {
      if (o.n < 1 || o.n > values.length) throw new Error(`$${o.n} is not bound (${values.length} params)`);
      return values[o.n - 1] ?? null;
    }
    const [alias, col] = o.ref.split('.');
    if (!Object.hasOwn(env, alias)) throw new Error(`the model does not know alias ${alias} (${o.ref})`);
    if (env[alias] === null) return null;
    if (!Object.hasOwn(env[alias], col)) throw new Error(`fixture row for ${alias} has no column ${col}`);
    return env[alias][col] ?? null;
  };
  switch (node.op) {
    case 'lit': return node.value;
    case 'not': { const v = truth(node.arg, env, values); return v === null ? null : !v; }
    case 'and': case 'or': {
      const vs = node.args.map((a) => truth(a, env, values));
      const [decides, otherwise] = node.op === 'and' ? [false, true] : [true, false];
      return vs.includes(decides) ? decides : vs.includes(null) ? null : otherwise;
    }
    case 'isnull': { const v = val(node.arg); return node.neg ? v !== null : v === null; }
    case 'eq': case 'ne': {
      const a = val(node.left);
      const b = val(node.right);
      if (a === null || b === null) return null;
      return node.op === 'eq' ? a === b : a !== b;
    }
    case 'any': {
      const a = val(node.left);
      const arr = val(node.arr);
      if (a === null || arr === null) return null;
      if (!Array.isArray(arr)) throw new Error('ANY() bound to a non-array');
      return arr.includes(a) ? true : arr.includes(null) ? null : false;
    }
    default: throw new Error(`unknown node ${node.op}`);
  }
}

// One statement → the facts the assertions need: the planting's alias, the container's alias, join
// kind and ON, and the outer WHERE. Exactly one garden_node base and at most one container binding;
// every other FROM item must be a LEFT join, which can neither drop nor (with these keys) duplicate a
// planting row — anything else throws.
function modelOf(sql) {
  const { from, where } = outerClauses(tokensOf(sql));
  const items = fromItems(from);
  const [base, ...joins] = items;
  if (!/^(public\.)?garden_node$/.test(base.table)) throw new Error(`FROM is ${base.table}, not garden_node`);
  const containers = joins.filter((j) => /^(public\.)?container$/.test(j.table));
  if (containers.length !== 1) throw new Error(`expected container bound exactly once, found ${containers.length}`);
  const [c] = containers;
  for (const j of joins) {
    if (j !== c && j.kind !== 'left join') throw new Error(`the model only knows LEFT joins besides the container's: ${j.kind} ${j.table}`);
  }
  if (!c.on) throw new Error('container join has no ON');
  return {
    alias: base.alias,
    container: { alias: c.alias, left: c.kind === 'left join', onTokens: c.on, on: parseBool(c.on) },
    where: parseBool(where),
  };
}

// Run the modelled statement over a fixture table: the rows it returns.
function evaluate(model, values, db) {
  const out = [];
  for (const g of db.plantings) {
    const env = (c) => ({ [model.alias]: g, [model.container.alias]: c });
    const hits = db.containers.filter((c) => truth(model.container.on, env(c), values) === true);
    const joined = hits.length ? hits : model.container.left ? [null] : [];
    for (const c of joined) if (truth(model.where, env(c), values) === true) out.push(g);
  }
  return out;
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────
// Two household members (GARDEN_HOUSEHOLD_IDS below), so ownership runs through a real two-element
// ANY(), and one stranger. Containers are owned by the OTHER member on purpose: an ownership test that
// only ever saw the caller's own id would pass a scalar comparison as readily as ANY().
const DAVE = 'user_arch_dave';
const JEN = 'user_arch_jen';
const STRANGER = 'user_arch_stranger';
const T = '2026-07-27T13:41:32.599Z';

const container = (id, { deleted = false, archived = false, owner = JEN } = {}) => ({
  id, created_by: owner, deleted_at: deleted ? T : null, archived_at: archived ? T : null,
  display_name: `container ${id}`,
});
const planting = (id, containerId, { deleted = false, archived = false, owner = DAVE } = {}) => ({
  id, display_name: `planting ${id}`, container_id: containerId, created_by: owner,
  deleted_at: deleted ? T : null, archived_at: archived ? T : null,
});

const C = {
  live: 'c0000000-0000-4000-8000-000000000001',
  deleted: 'c0000000-0000-4000-8000-000000000002',
  archived: 'c0000000-0000-4000-8000-000000000003',
  deletedAndArchived: 'c0000000-0000-4000-8000-000000000004',
  stranger: 'c0000000-0000-4000-8000-000000000005',
};
// One LIVE planting per container state, keyed by that state; `none` is the project-less planting
// the LEFT JOIN exists for (BUG-LOGMANYPROJECTLESS-001), which reaches the WHERE with pp all NULL.
const P = {
  none: 'a0000000-0000-4000-8000-000000000001',
  live: 'a0000000-0000-4000-8000-000000000002',
  deleted: 'a0000000-0000-4000-8000-000000000003',
  archived: 'a0000000-0000-4000-8000-000000000004',
  deletedAndArchived: 'a0000000-0000-4000-8000-000000000005',
};
// Controls: rows the route refused before this change and must still refuse.
const CONTROL = {
  strangersContainer: 'b0000000-0000-4000-8000-000000000001',
  strangersProjectless: 'b0000000-0000-4000-8000-000000000002',
  ownArchived: 'b0000000-0000-4000-8000-000000000003',
  ownDeleted: 'b0000000-0000-4000-8000-000000000004',
};

const DB = {
  containers: [
    container(C.live),
    container(C.deleted, { deleted: true }),
    container(C.archived, { archived: true }),
    container(C.deletedAndArchived, { deleted: true, archived: true }),
    container(C.stranger, { owner: STRANGER }),
  ],
  plantings: [
    planting(P.none, null),
    planting(P.live, C.live),
    planting(P.deleted, C.deleted),
    planting(P.archived, C.archived),
    planting(P.deletedAndArchived, C.deletedAndArchived),
    planting(CONTROL.strangersContainer, C.stranger, { owner: STRANGER }),
    planting(CONTROL.strangersProjectless, null, { owner: STRANGER }),
    planting(CONTROL.ownArchived, C.live, { archived: true }),
    planting(CONTROL.ownDeleted, C.live, { deleted: true }),
  ],
};

// For a LIVE planting: returned in a live container or in none, never in a retired one. The same table
// lambda/daily-plan/rain-live-filter.test.js requires of the plan and the rain writer (CONTAINER_REFUSED).
const CONTAINER_REFUSED = { none: true, live: true, deleted: false, archived: false, deletedAndArchived: false };
const STATES = Object.keys(P);

// ── driving the handler ────────────────────────────────────────────────────────────────────────────
// The list statement is answered by the model; any other statement the route sends would be answered
// with no rows and is counted, so an extra round trip cannot hide.
let modelError = null;
function answerFromModel(text, values) {
  if (!/\bfrom\s+public\.garden_node\s+gp\b/i.test(flat(text))) return [];
  try {
    return evaluate(modelOf(text), values, DB).map((g) => ({ id: g.id, name: g.display_name }));
  } catch (err) {
    modelError = err;
    throw err;
  }
}

async function list(query) {
  const res = await handler({
    requestContext: { http: { method: 'GET' } },
    rawPath: '/api/plants',
    queryStringParameters: query,
    headers: { authorization: 'Bearer stub-token' },
  });
  expect(modelError, `the statement model could not read the emitted SQL: ${modelError?.message}`).toBeNull();
  expect(res.statusCode).toBe(200);
  const ids = JSON.parse(res.body).map((r) => r.id);
  expect(stubState.sqlCalls, 'GET /api/plants sent more or fewer statements than the one list read').toHaveLength(1);
  const [{ text, values }] = stubState.sqlCalls;
  return { ids: new Set(ids), text, values, model: modelOf(text) };
}

const byState = (ids) => Object.fromEntries(STATES.map((s) => [s, ids.has(P[s])]));

beforeEach(() => {
  resetStubs();
  modelError = null;
  stubState.verifyTokenResult = { sub: DAVE };
  stubState.sqlHandler = answerFromModel;
  vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${DAVE},${JEN}`);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const BRANCHES = [
  // Each branch is identified by something only it selects, so the model is never scoring the wrong
  // template: the grid carries the hero storage path, the picker carries crop_types' default_unit and
  // no photo join at all.
  { view: 'grid', is: (sql) => /\bfeatured_photo_storage_path\b/.test(sql) && /\blateral\b/.test(sql) },
  { view: 'picker', is: (sql) => /'default_unit'/.test(sql) && !/\bphotos ph\b/.test(sql) },
];

for (const { view, is } of BRANCHES) {
  describe(`BUG-PLANTSLISTARCHIVEDCONTAINER-001 — GET /api/plants?view=${view} hides a planting in an archived container`, () => {
    it('is evaluating the real list statement and a container term per axis (vacuity floor)', async () => {
      const { text, model, ids } = await list({ view });
      expect(is(flat(text)), `the recorded statement is not the ?view=${view} branch`).toBe(true);
      expect(model.alias).toBe('gp');
      expect(model.container.alias).toBe('pp');
      expect(model.container.left, 'container is no longer LEFT JOINed — every project-less planting leaves the list').toBe(true);
      // One term per axis on the container, named, so a lost axis reports THAT rather than only the table.
      const cols = new Set(colsOf(model.where));
      for (const a of ['deleted_at', 'archived_at']) {
        expect(cols.has(`pp.${a}`), `the WHERE carries no container ${a} term`).toBe(true);
      }
      // And the model admits something: a WHERE (or a model) gone dead would otherwise pass every refusal.
      expect(ids.has(P.live) && ids.has(P.none), 'the route returns neither a live nor a project-less planting').toBe(true);
    });

    it('returns a live planting in a live container or in none, and none in a soft-deleted or archived one', async () => {
      const { ids } = await list({ view });
      expect(byState(ids)).toEqual(CONTAINER_REFUSED);
    });

    it('keeps every refusal it already made (ownership, the planting\'s own archive and delete)', async () => {
      const { ids } = await list({ view });
      for (const [name, id] of Object.entries(CONTROL)) expect(ids.has(id), `${name} is returned`).toBe(false);
      expect([...ids].sort()).toEqual([P.none, P.live].sort());
    });

    it('filters in the WHERE: the container join\'s ON carries no liveness term', async () => {
      // A liveness term in a LEFT JOIN's ON does not filter, it NULL-extends the container. In THIS
      // statement that happens to refuse the row anyway — the ownership arm needs a matched container —
      // which is exactly why only a structural check can see it: the refusal would then rest on the
      // ownership arm's spelling, not on the archive predicate (see the synthetic bench below).
      const { model } = await list({ view });
      expect(model.container.onTokens.join(' ')).not.toMatch(/\b(archived_at|deleted_at)\b/);
    });

    it('applies under an explicit project scope too — an archived container scopes to nothing', async () => {
      // The scope is a filter ON TOP of liveness, never a way around it: PlantingSelect scopes the
      // chooser with ?project_id, and a scoped request must not reopen what the unscoped one hides.
      expect((await list({ view, project_id: C.live })).ids).toEqual(new Set([P.live]));
      resetStubs();
      stubState.verifyTokenResult = { sub: DAVE };
      stubState.sqlHandler = answerFromModel;
      expect((await list({ view, project_id: C.archived })).ids).toEqual(new Set());
    });
  });
}

describe('BUG-PLANTSLISTARCHIVEDCONTAINER-001 — the model reads the predicate, not its spelling (synthetic statements)', () => {
  // The same model on statements no route contains, so it is proved to SEPARATE the shapes rather
  // than merely agree with today's handler. $1 is the household array, $2 the (NULL) project scope.
  const H = [DAVE, JEN];
  const OWN = '(( pp.created_by = ANY($1) AND pp.deleted_at IS NULL ) OR (gp.container_id IS NULL AND gp.created_by = ANY($1)))';
  const LIVE = 'gp.deleted_at IS NULL AND gp.archived_at IS NULL';
  const SCOPE = '($2::uuid IS NULL OR gp.container_id = $2::uuid)';
  const stmt = (where, on = 'pp.id = gp.container_id', join = 'LEFT JOIN') =>
    `SELECT gp.id FROM public.garden_node gp ${join} public.container pp ON ${on}\n WHERE ${where}\n ORDER BY gp.created_at DESC LIMIT 5000`;
  const table = (sql) => {
    const ids = new Set(evaluate(modelOf(sql), [H, null], DB).map((g) => g.id));
    return byState(ids);
  };
  const ALL = { none: true, live: true, deleted: true, archived: true, deletedAndArchived: true };

  it('refuses both retired states under every spelling that means the rule', () => {
    const SAME = [
      `${OWN} AND ${LIVE} AND pp.archived_at IS NULL AND ${SCOPE}`,                          // the shipped shape
      `${OWN} AND ${LIVE} AND (pp.id IS NULL OR pp.archived_at IS NULL) AND ${SCOPE}`,       // the rain writer's
      `(( pp.created_by = ANY($1) AND pp.deleted_at IS NULL AND pp.archived_at IS NULL )`
        + ` OR (gp.container_id IS NULL AND gp.created_by = ANY($1))) AND ${LIVE} AND ${SCOPE}`,  // inside the arm
      `${OWN} AND ${LIVE} AND NOT (pp.archived_at IS NOT NULL) AND ${SCOPE}`,                // a double negative
      `${OWN} AND ${LIVE} AND ${SCOPE} -- an unrelated comment\n AND pp.archived_at IS NULL`, // after a comment
    ];
    for (const w of SAME) expect(table(stmt(w)), w).toEqual(CONTAINER_REFUSED);
  });

  it('names the state each defective shape lets through', () => {
    const LEAKS = [
      // the defect this item fixes: no archived term at all
      [`${OWN} AND ${LIVE} AND ${SCOPE}`, { ...CONTAINER_REFUSED, archived: true }],
      // the wrong axis: a second deleted_at term in place of archived_at
      [`${OWN} AND ${LIVE} AND pp.deleted_at IS NULL AND ${SCOPE}`, { ...CONTAINER_REFUSED, archived: true }],
      // polarity inverted
      [`${OWN} AND ${LIVE} AND pp.archived_at IS NOT NULL AND ${SCOPE}`,
        { none: false, live: false, deleted: false, archived: true, deletedAndArchived: false }],
      // made optional
      [`${OWN} AND ${LIVE} AND (pp.archived_at IS NULL OR gp.created_by = ANY($1)) AND ${SCOPE}`,
        { ...CONTAINER_REFUSED, archived: true }],
      // commented out
      [`${OWN} AND ${LIVE} AND ${SCOPE}\n -- AND pp.archived_at IS NULL`, { ...CONTAINER_REFUSED, archived: true }],
      [`${OWN} AND ${LIVE} AND ${SCOPE} /* AND pp.archived_at IS NULL */`, { ...CONTAINER_REFUSED, archived: true }],
      // the deleted gate dropped as well: every container state comes back
      [`(pp.created_by = ANY($1) OR (gp.container_id IS NULL AND gp.created_by = ANY($1))) AND ${LIVE} AND ${SCOPE}`, ALL],
    ];
    for (const [w, admits] of LEAKS) expect(table(stmt(w)), w).toEqual(admits);
  });

  it('evaluates the ON the way Postgres does — which is why the ON check above is structural', () => {
    // With today's ownership arm, moving the archive term into the ON happens to refuse the row: the
    // container is NULL-extended and `pp.created_by = ANY($1)` goes NULL. Equivalent here, and only here.
    expect(table(stmt(`${OWN} AND ${LIVE} AND ${SCOPE}`, 'pp.id = gp.container_id AND pp.archived_at IS NULL')))
      .toEqual(CONTAINER_REFUSED);
    // Give the same statement an ownership test that does not need the container and the ON placement
    // stops filtering: the archived-container planting comes back with its container NULL-extended —
    // and so does the archived-AND-deleted one, because NULL-extension also blanks the deleted_at the
    // WHERE was relying on. Placement in the ON costs both axes at once.
    const OWN_BY_PLANTING = 'gp.created_by = ANY($1) AND (pp.deleted_at IS NULL)';
    expect(table(stmt(`${OWN_BY_PLANTING} AND ${LIVE}`, 'pp.id = gp.container_id AND pp.archived_at IS NULL')))
      .toEqual({ ...CONTAINER_REFUSED, archived: true, deletedAndArchived: true });
    expect(table(stmt(`${OWN_BY_PLANTING} AND ${LIVE} AND pp.archived_at IS NULL`)))
      .toEqual(CONTAINER_REFUSED);
    // And the join is READ: under an INNER join the project-less planting never reaches the WHERE.
    expect(table(stmt(`${OWN} AND ${LIVE} AND pp.archived_at IS NULL AND ${SCOPE}`, undefined, 'JOIN')))
      .toEqual({ ...CONTAINER_REFUSED, none: false });
  });

  it('throws rather than scores a shape it cannot evaluate', () => {
    for (const w of [
      `${OWN} AND ${LIVE} AND coalesce(pp.archived_at, pp.deleted_at) IS NULL`,
      `${OWN} AND ${LIVE} AND NOT EXISTS (SELECT 1 FROM public.container a WHERE a.id = pp.id AND a.archived_at IS NOT NULL)`,
      `${OWN} AND ${LIVE} AND CASE WHEN pp.id IS NULL THEN TRUE ELSE pp.archived_at IS NULL END`,
      `${OWN} AND ${LIVE} AND pv.archived_at IS NULL`,
    ]) {
      expect(() => table(stmt(w)), w).toThrow(/cannot evaluate|does not know alias/);
    }
    expect(() => modelOf(`SELECT gp.id FROM public.garden_node gp INNER JOIN public.cultivar pv ON pv.id = gp.cultivar_id`
      + ` LEFT JOIN public.container pp ON pp.id = gp.container_id WHERE ${OWN}`)).toThrow(/only knows LEFT joins/);
  });
});
