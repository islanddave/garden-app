// BUG-PLANTSLISTARCHIVEDCONTAINER-001 — the Garden grid (?view=grid) and the planting chooser
// (?view=picker) do not return a planting whose CONTAINER is archived; and bringing a planting back
// (unarchive, restore) brings an archived container back with it, so the planting lands where it was.
//
// WHAT IS GUARDED, PART 1 — the lists. Both branches LEFT JOIN container and gated it on
// `pp.deleted_at` only, so a live planting in an archived container stayed on the Garden grid and in
// every chooser while the daily plan's plantings query (`pj.archived_at is null`) and the rain writer
// (`ct.id is null or (ct.deleted_at is null and ct.archived_at is null)`) hide it. Neither container
// state cascades to the plantings: lambda/projects' archive PATCH sets the container's own column and
// nothing else. The fix is `AND pp.archived_at IS NULL`, its own top-level clause in each WHERE — the
// container's OWN archived_at, as those two readers test it, with no ancestor walk.
//
// PART 2 — the way back. With part 1 alone, unarchiving a planting that sits in an archived container
// cleared the planting's own column and left it hidden anyway: off the Archived page (it is no longer
// archived), absent from Garden (its container still is), and no surface can unarchive a container.
// 3 of the 28 rows on the Archived page were in exactly that position on prod, 2026-09-23. So
// PATCH /api/plants/:id/archive {archived:false} and POST /api/plants/:id/restore now send a second
// UPDATE, in the SAME transaction and after the planting's own, that clears the container's
// archived_at when the planting is now live — never for a soft-deleted container, never for another
// household's, never for an ancestor or a neighbour, and never on an archive.
//
// WHY THE AXES ARE EVALUATED SEPARATELY (claude-ops/project-rules/gardening.md, Archive-Hiding Rule):
// archived and deleted are different axes on different columns and must stay separately observable —
// a row hidden by the wrong predicate is a latent bug even when today's visible outcome is identical.
// So an archived-only container and a deleted-only container are each required to be refused on
// their own, and swapping the new clause's column for deleted_at reds here.
//
// METHOD — the statements the handler actually SENDS, not source text. index.js is imported under the
// house stubs (vitest.config.ts aliases Clerk/AWS/Neon to lambda/_test-stubs) with a recording neon
// that builds the query text the way the real driver does ($1..$n placeholders), is LAZY the way the
// real driver is (nothing is sent until a query is awaited on its own or handed to sql.transaction),
// records which transaction each statement ran in, and ANSWERS it by evaluating that very text
// against a fixture table. A SELECT: the outer FROM is read (the planting's alias, the container's
// alias, its join kind and its ON), the outer WHERE is parsed to a boolean tree and every term is
// evaluated per row in SQL's three-valued logic with the statement's own bound parameters, and a LEFT
// JOIN whose ON fails NULL-extends the container, exactly as Postgres does. An UPDATE: its WHERE
// (EXISTS subqueries included) is evaluated against the rows as they were, then its SET is applied;
// statements in one transaction run in order and each sees what the one before it wrote. After a
// write the lists are read again through the same handler, so "it goes straight back" is asserted as
// what GET /api/plants?view=grid and GET /api/plants/archived return, not as a column value.
//
// CONSERVATIVE BY CONSTRUCTION. Any term the model cannot evaluate — a function call, a subquery other
// than EXISTS (SELECT 1 FROM one table WHERE ...), an alias it does not know, a join other than LEFT
// besides the container's, an UPDATE ... FROM — THROWS rather than being scored, so a rewrite into a
// shape this file cannot read reds instead of passing.
//
// NOT the parser in lambda/daily-plan/rain-live-filter.test.js. That one pins a state and leaves every
// other term FREE, which cannot evaluate `= ANY($n)`, a bound project scope or a write; this one runs
// concrete rows against concrete parameters. The two answer the same question for different
// statements, and the container table they require is the same one (CONTAINER_REFUSED there).
//
// LIMIT, stated plainly: this is a model of Postgres, not Postgres. The Lambda unit suite never runs
// SQL; nothing here proves the statements execute. The read-only prod evidence is in the lane findings
// (_mainsync6_20260923/lane-plantsarchived-20260923.md): the list WHERE returned the same 244 rows
// before and after; the container statement's WHERE, run verbatim as a SELECT, matched 0 rows, and
// with only its planting-live test dropped mapped each of the 3 trapped plantings to its own container.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';

// A recording neon, LAZY like the real driver: a tagged template builds `$1..$n` + a parameter array
// and sends nothing until it is awaited on its own (recorded with tx null) or handed to
// sql.transaction (recorded, in order, with that transaction's number). The laziness is what lets a
// handler build a statement and then decide whether it runs alone or inside a transaction, and the
// transaction number is what makes "the second UPDATE ran outside the transaction" visible here.
vi.mock('@neondatabase/serverless', async () => {
  const { stubState: st } = await import('../_test-stubs/state.js');
  let txSeq = 0;
  return {
    neon: () => {
      const send = (q, tx) => {
        st.sqlCalls.push({ text: q.text, values: q.values, tx });
        return st.sqlHandler(q.text, q.values);
      };
      const sql = (strings, ...values) => {
        const q = { text: strings.reduce((acc, s, i) => `${acc}$${i}${s}`), values };
        q.then = (ok, fail) => Promise.resolve().then(() => send(q, null)).then(ok, fail);
        return q;
      };
      sql.transaction = async (queries) => {
        const tx = ++txSeq;
        const out = [];
        for (const q of queries) out.push(await send(q, tx));
        return out;
      };
      return sql;
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

// Split a token run at its top-level commas.
function splitTop(tokens) {
  const out = [[]];
  for (let depth = 0, k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t === '(') depth += 1;
    else if (t === ')') depth -= 1;
    if (depth === 0 && t === ',') out.push([]);
    else out[out.length - 1].push(t);
  }
  return out;
}

// The two fixture tables, by the names the statements use.
function rowsOf(db, table) {
  const name = String(table).replace(/^public\./, '');
  if (name === 'garden_node') return db.plantings;
  if (name === 'container') return db.containers;
  throw new Error(`the model has no table ${table}`);
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

// Boolean tree over one predicate run. Grammar: or / and / not / ( group ) / EXISTS ( subquery ) /
// predicate, where a predicate is `x IS [NOT] NULL`, `x = y`, `x <> y`, `x = ANY(y)`, a bare
// TRUE/FALSE/NULL or a bare bound $n, an operand is alias.col, $n (with an ignored ::cast), NULL,
// TRUE, FALSE or a quoted literal, and the only subquery is `SELECT 1 FROM <table> <alias> WHERE ...`.
// Anything else throws, so a shape this model cannot read is never scored.
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
    if (left.kind === 'param') return { op: 'val', arg: left };
    throw new Error(`the model cannot evaluate a predicate at ${where()}`);
  };
  const unary = () => {
    if (tokens[i] === 'not') { i += 1; return { op: 'not', arg: unary() }; }
    if (tokens[i] === 'exists') {
      if (tokens[i + 1] !== '(') throw new Error(`EXISTS without ( at ${where()}`);
      const close = matching(tokens, i + 1);
      const s = tokens.slice(i + 2, close);
      if (s[0] !== 'select' || s[1] !== '1' || s[2] !== 'from' || s[5] !== 'where') {
        throw new Error(`the model cannot evaluate this subquery at ${where()}`);
      }
      i = close + 1;
      return { op: 'exists', table: s[3], alias: s[4], where: parseBool(s.slice(6)) };
    }
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
// cannot evaluate throws even when a sibling has already decided the answer. EXISTS is never NULL.
function truth(node, env, values, db) {
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
    case 'val': {
      const v = val(node.arg);
      if (v !== null && typeof v !== 'boolean') throw new Error(`$${node.arg.n} is used as a condition but bound to ${typeof v}`);
      return v;
    }
    case 'not': { const v = truth(node.arg, env, values, db); return v === null ? null : !v; }
    case 'and': case 'or': {
      const vs = node.args.map((a) => truth(a, env, values, db));
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
    case 'exists': {
      if (!db) throw new Error('EXISTS needs the fixture tables');
      return rowsOf(db, node.table)
        .map((r) => truth(node.where, { ...env, [node.alias]: r }, values, db))
        .includes(true);
    }
    default: throw new Error(`unknown node ${node.op}`);
  }
}

// One SELECT → the facts the assertions need: the planting's alias, the container's alias, join kind
// and ON, and the outer WHERE. Exactly one garden_node base and exactly one container binding; every
// other FROM item must be a LEFT join, which can neither drop nor (with these keys) duplicate a
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

// Run a modelled SELECT over a fixture table: the plantings it returns.
function evaluate(model, values, db) {
  const out = [];
  for (const g of db.plantings) {
    const env = (c) => ({ [model.alias]: g, [model.container.alias]: c });
    const hits = db.containers.filter((c) => truth(model.container.on, env(c), values, db) === true);
    const joined = hits.length ? hits : model.container.left ? [null] : [];
    for (const c of joined) if (truth(model.where, env(c), values, db) === true) out.push(g);
  }
  return out;
}

// A SET right-hand side: NULL, NOW(), a bound $n, or a one-arm CASE WHEN <condition> THEN x ELSE y END.
const NOW = '2026-09-23T12:00:00.000Z';
function parseExpr(t) {
  if (t.length === 1 && t[0] === 'null') return { kind: 'lit', value: null };
  if (t.join(' ') === 'now ( )') return { kind: 'now' };
  if (/^\$\d+$/.test(t[0]) && (t.length === 1 || (t.length === 3 && t[1] === '::'))) return { kind: 'param', n: Number(t[0].slice(1)) };
  if (t[0] === 'case' && t[1] === 'when' && t.at(-1) === 'end'
      && t.filter((x) => x === 'when').length === 1 && t.filter((x) => x === 'case').length === 1) {
    const th = t.indexOf('then');
    const el = t.indexOf('else');
    if (th > 2 && el > th) {
      return { kind: 'case', when: parseBool(t.slice(2, th)), then: parseExpr(t.slice(th + 1, el)), else: parseExpr(t.slice(el + 1, -1)) };
    }
  }
  throw new Error(`the model cannot evaluate a SET expression: ${t.join(' ')}`);
}
function evalExpr(e, env, values, db) {
  if (e.kind === 'lit') return e.value;
  if (e.kind === 'now') return NOW;
  if (e.kind === 'param') return values[e.n - 1] ?? null;
  return truth(e.when, env, values, db) === true ? evalExpr(e.then, env, values, db) : evalExpr(e.else, env, values, db);
}

// UPDATE <table> <alias> SET col = expr[, ...] WHERE <condition> [RETURNING alias.col [AS name], ...].
function updateOf(sql) {
  const t = tokensOf(sql);
  if (t[0] !== 'update' || t[3] !== 'set') throw new Error(`not an UPDATE <table> <alias> SET: ${t.slice(0, 6).join(' ')}`);
  const [, table, alias] = t;
  let where = -1;
  let ret = t.length;
  for (let depth = 0, k = 4; k < t.length; k += 1) {
    if (t[k] === '(') depth += 1;
    else if (t[k] === ')') depth -= 1;
    else if (depth === 0 && t[k] === 'from') throw new Error('the model cannot evaluate UPDATE ... FROM');
    else if (depth === 0 && t[k] === 'where' && where < 0) where = k;
    else if (depth === 0 && t[k] === 'returning') { ret = k; break; }
  }
  if (where < 0) throw new Error('an UPDATE with no WHERE');
  const set = splitTop(t.slice(4, where)).map((a) => {
    if (a[1] !== '=' || !/^[a-z_][a-z0-9_]*$/.test(a[0])) throw new Error(`unreadable SET item: ${a.join(' ')}`);
    return [a[0], parseExpr(a.slice(2))];
  });
  const returning = ret < t.length ? splitTop(t.slice(ret + 1)).map((r) => {
    const m = r.length === 1 ? [r[0], r[0].split('.')[1]] : r.length === 3 && r[1] === 'as' ? [r[0], r[2]] : null;
    if (!m || !m[0].startsWith(`${alias}.`)) throw new Error(`unreadable RETURNING item: ${r.join(' ')}`);
    return m;
  }) : [];
  return { table, alias, set, where: parseBool(t.slice(where + 1, ret)), returning };
}

// Postgres semantics for one UPDATE: every row's WHERE and SET are evaluated against the rows as they
// were, then the writes land together.
function execUpdate(u, values, db) {
  const rows = rowsOf(db, u.table);
  const hit = rows.filter((r) => truth(u.where, { [u.alias]: r }, values, db) === true);
  const patches = hit.map((r) => Object.fromEntries(u.set.map(([col, e]) => {
    if (!Object.hasOwn(r, col)) throw new Error(`fixture ${u.table} has no column ${col}`);
    return [col, evalExpr(e, { [u.alias]: r }, values, db)];
  })));
  hit.forEach((r, k) => Object.assign(r, patches[k]));
  return u.returning.length
    ? hit.map((r) => Object.fromEntries(u.returning.map(([ref, as]) => [as, r[ref.split('.')[1]] ?? null])))
    : [];
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────
// Two household members (GARDEN_HOUSEHOLD_IDS below), so ownership runs through a real two-element
// ANY(), and one stranger. Containers are owned by the OTHER member on purpose: an ownership test that
// only ever saw the caller's own id would pass a scalar comparison as readily as ANY().
const DAVE = 'user_arch_dave';
const JEN = 'user_arch_jen';
const STRANGER = 'user_arch_stranger';
const T = '2026-07-27T13:41:32.599Z';

const container = (id, { deleted = false, archived = false, owner = JEN, parent = null } = {}) => ({
  id, created_by: owner, deleted_at: deleted ? T : null, archived_at: archived ? T : null,
  display_name: `container ${id}`, parent_id: parent,
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

const LIST_DB = {
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
// Every statement the route sends is run by the model against `db`; one it cannot run fails the test
// rather than being answered with nothing.
let db = null;
let modelError = null;
function answerFromModel(text, values) {
  try {
    const kind = tokensOf(text)[0];
    if (kind === 'update') return execUpdate(updateOf(text), values, db);
    if (kind === 'select') return evaluate(modelOf(text), values, db).map((g) => ({ ...g, name: g.display_name }));
    throw new Error(`the model has no statement kind ${kind}`);
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
// Rows are flat, so a per-row copy is a full copy.
const cloneDb = (d) => ({ containers: d.containers.map((r) => ({ ...r })), plantings: d.plantings.map((r) => ({ ...r })) });

beforeEach(() => {
  resetStubs();
  modelError = null;
  db = cloneDb(LIST_DB);
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
      stubState.sqlCalls = [];
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
    const ids = new Set(evaluate(modelOf(sql), [H, null], LIST_DB).map((g) => g.id));
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
      `${OWN} AND ${LIVE} AND NOT EXISTS (SELECT 1 FROM public.container a`                  // an anti-join
        + ` WHERE a.id = pp.id AND a.archived_at IS NOT NULL) AND ${SCOPE}`,
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
      // an anti-join that forgot its correlation hides every container once any is archived
      [`${OWN} AND ${LIVE} AND NOT EXISTS (SELECT 1 FROM public.container a WHERE a.archived_at IS NOT NULL) AND ${SCOPE}`,
        { none: false, live: false, deleted: false, archived: false, deletedAndArchived: false }],
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
      `${OWN} AND ${LIVE} AND pp.id = (SELECT a.id FROM public.container a WHERE a.archived_at IS NULL)`,
      `${OWN} AND ${LIVE} AND EXISTS (SELECT a.id FROM public.container a WHERE a.id = pp.id)`,
      `${OWN} AND ${LIVE} AND CASE WHEN pp.id IS NULL THEN TRUE ELSE pp.archived_at IS NULL END`,
      `${OWN} AND ${LIVE} AND pv.archived_at IS NULL`,
    ]) {
      expect(() => table(stmt(w)), w).toThrow(/cannot evaluate|does not know alias/);
    }
    expect(() => modelOf(`SELECT gp.id FROM public.garden_node gp INNER JOIN public.cultivar pv ON pv.id = gp.cultivar_id`
      + ` LEFT JOIN public.container pp ON pp.id = gp.container_id WHERE ${OWN}`)).toThrow(/only knows LEFT joins/);
    expect(() => updateOf('UPDATE public.container pp SET archived_at = NULL FROM public.garden_node gn WHERE gn.container_id = pp.id'))
      .toThrow(/UPDATE \.\.\. FROM/);
  });
});

// ── part 2: the way back ───────────────────────────────────────────────────────────────────────────
const K = {
  trap: 'c1000000-0000-4000-8000-000000000001',            // archived — holds one archived planting (the prod shape)
  siblings: 'c1000000-0000-4000-8000-000000000002',        // archived — one archived planting, one LIVE one
  neighbour: 'c1000000-0000-4000-8000-000000000003',       // archived, empty, unrelated
  live: 'c1000000-0000-4000-8000-000000000004',            // live — holds an archived planting
  deletedArchived: 'c1000000-0000-4000-8000-000000000005', // archived AND soft-deleted
  stranger: 'c1000000-0000-4000-8000-000000000006',        // archived, another household's
  parent: 'c1000000-0000-4000-8000-000000000007',          // archived parent of `child`
  child: 'c1000000-0000-4000-8000-000000000008',           // live child container
  restoreHome: 'c1000000-0000-4000-8000-000000000009',     // archived — holds a soft-deleted planting
  restoreBoth: 'c1000000-0000-4000-8000-00000000000a',     // archived — holds a deleted AND archived planting
};
const Q = {
  trap: 'd1000000-0000-4000-8000-000000000001',
  sibArchived: 'd1000000-0000-4000-8000-000000000002',
  sibLive: 'd1000000-0000-4000-8000-000000000003',
  inLive: 'd1000000-0000-4000-8000-000000000004',
  inDeletedArchived: 'd1000000-0000-4000-8000-000000000005',
  strangerLive: 'd1000000-0000-4000-8000-000000000006',
  child: 'd1000000-0000-4000-8000-000000000007',
  projectless: 'd1000000-0000-4000-8000-000000000008',
  deletedInArchived: 'd1000000-0000-4000-8000-000000000009',
  deletedAndArchived: 'd1000000-0000-4000-8000-00000000000a',
};
const wayBackDb = () => ({
  containers: [
    container(K.trap, { archived: true }),
    container(K.siblings, { archived: true }),
    container(K.neighbour, { archived: true }),
    container(K.live),
    container(K.deletedArchived, { archived: true, deleted: true }),
    container(K.stranger, { archived: true, owner: STRANGER }),
    container(K.parent, { archived: true }),
    container(K.child, { parent: K.parent }),
    container(K.restoreHome, { archived: true }),
    container(K.restoreBoth, { archived: true }),
  ],
  plantings: [
    planting(Q.trap, K.trap, { archived: true }),
    planting(Q.sibArchived, K.siblings, { archived: true }),
    planting(Q.sibLive, K.siblings),
    planting(Q.inLive, K.live, { archived: true }),
    planting(Q.inDeletedArchived, K.deletedArchived),
    planting(Q.strangerLive, K.stranger, { owner: STRANGER }),
    planting(Q.child, K.child, { archived: true }),
    planting(Q.projectless, null, { archived: true }),
    planting(Q.deletedInArchived, K.restoreHome, { deleted: true }),
    planting(Q.deletedAndArchived, K.restoreBoth, { deleted: true, archived: true }),
  ],
});

const plantRow = (id) => db.plantings.find((r) => r.id === id);
const containerRow = (id) => db.containers.find((r) => r.id === id);
const archivedContainers = () => db.containers.filter((c) => c.archived_at !== null).map((c) => c.id).sort();
const kindOf = (c) => {
  const t = tokensOf(c.text);
  return t[0] === 'update' ? `update ${t[1].replace(/^public\./, '')}` : t[0];
};

async function send(method, rawPath, body) {
  stubState.sqlCalls = [];
  const res = await handler({
    requestContext: { http: { method } },
    rawPath,
    headers: { authorization: 'Bearer stub-token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(modelError, `the statement model could not run the emitted SQL: ${modelError?.message}`).toBeNull();
  return { status: res.statusCode, body: JSON.parse(res.body || 'null'), calls: [...stubState.sqlCalls] };
}
const unarchive = (id) => send('PATCH', `/api/plants/${id}/archive`, { archived: false });
const archive = (id) => send('PATCH', `/api/plants/${id}/archive`, { archived: true });
const restore = (id) => send('POST', `/api/plants/${id}/restore`);
async function onGarden() {
  stubState.sqlCalls = [];
  return [...(await list({ view: 'grid' })).ids];
}
async function onArchivedPage() {
  const { status, body } = await send('GET', '/api/plants/archived');
  expect(status).toBe(200);
  return body.plants.map((p) => p.id);
}

describe('BUG-PLANTSLISTARCHIVEDCONTAINER-001 — bringing a planting back brings its archived container back', () => {
  beforeEach(() => { db = wayBackDb(); });

  it('unarchive: one transaction, the planting first and then its container — and it is back on the Garden grid', async () => {
    expect(await onArchivedPage()).toContain(Q.trap);
    expect(await onGarden()).not.toContain(Q.trap);
    const before = archivedContainers();
    const { status, body, calls } = await unarchive(Q.trap);
    expect(status).toBe(200);
    expect(body).toEqual({ id: Q.trap, archived_at: null });
    // What the route SENT: exactly two UPDATEs — no set_config, the route never set one — in one
    // transaction, the planting's first so the container statement reads the row it just wrote.
    expect(calls.map(kindOf)).toEqual(['update garden_node', 'update container']);
    expect(calls[0].tx, 'the planting UPDATE ran outside a transaction').not.toBeNull();
    expect(calls[1].tx, 'the container UPDATE ran outside the planting UPDATE\'s transaction').toBe(calls[0].tx);
    // What it DID.
    expect(plantRow(Q.trap).archived_at).toBeNull();
    expect(containerRow(K.trap).archived_at, 'the container stayed archived, so the planting is still hidden').toBeNull();
    expect(archivedContainers(), 'a container other than the planting\'s own was touched')
      .toEqual(before.filter((id) => id !== K.trap));
    // And where it went: straight back.
    expect(await onGarden()).toContain(Q.trap);
    expect(await onArchivedPage()).not.toContain(Q.trap);
  });

  it('writes the container\'s archived_at and nothing else', async () => {
    const { calls } = await unarchive(Q.trap);
    expect(updateOf(calls[1].text).set).toEqual([['archived_at', { kind: 'lit', value: null }]]);
    expect(containerRow(K.trap)).toEqual({ ...container(K.trap), archived_at: null });
  });

  it('archive: the one UPDATE it always sent, on its own — no container statement, no transaction', async () => {
    // A LIVE planting in an ARCHIVED container: the one row the container statement would act on.
    const before = archivedContainers();
    const { status, calls } = await archive(Q.sibLive);
    expect(status).toBe(200);
    expect(calls.map(kindOf)).toEqual(['update garden_node']);
    expect(calls[0].tx).toBeNull();
    expect(plantRow(Q.sibLive).archived_at).not.toBeNull();
    expect(archivedContainers()).toEqual(before);
  });

  it('never touches a soft-deleted container, even for a live planting in one', async () => {
    const { status, calls } = await unarchive(Q.inDeletedArchived);
    expect(status).toBe(404);   // the F4 gate on the planting UPDATE, unchanged
    expect(calls.map(kindOf)).toEqual(['update garden_node', 'update container']);
    expect(containerRow(K.deletedArchived).archived_at, 'a soft-deleted container was unarchived').not.toBeNull();
    expect(containerRow(K.deletedArchived).deleted_at).not.toBeNull();
  });

  it('never touches another household\'s container', async () => {
    const { status } = await unarchive(Q.strangerLive);
    expect(status).toBe(404);
    expect(containerRow(K.stranger).archived_at).not.toBeNull();
  });

  it('an unarchive that 404s on a soft-deleted planting leaves its container alone', async () => {
    const { status } = await unarchive(Q.deletedInArchived);
    expect(status).toBe(404);
    expect(containerRow(K.restoreHome).archived_at).not.toBeNull();
  });

  it('never walks to an ancestor: a live child container under an archived parent', async () => {
    const before = archivedContainers();
    expect((await unarchive(Q.child)).status).toBe(200);
    expect(archivedContainers(), 'the archived parent was unarchived').toEqual(before);
    // The lists test the planting's own container only, so the child is enough to bring it back.
    expect(await onGarden()).toContain(Q.child);
  });

  it('a planting in a live container, or in none, has nothing to bring back', async () => {
    const before = archivedContainers();
    expect((await unarchive(Q.inLive)).status).toBe(200);
    expect((await unarchive(Q.projectless)).status).toBe(200);
    expect(archivedContainers()).toEqual(before);
  });

  it('a live sibling comes back with the container — it is back in use (0 such rows on prod, 2026-09-23)', async () => {
    expect(await onGarden()).not.toContain(Q.sibLive);
    expect((await unarchive(Q.sibArchived)).status).toBe(200);
    const garden = await onGarden();
    expect(garden).toContain(Q.sibArchived);
    expect(garden).toContain(Q.sibLive);
  });

  it('restore: one transaction after the preflight, and the planting is back on the Garden grid', async () => {
    const before = archivedContainers();
    const { status, body, calls } = await restore(Q.deletedInArchived);
    expect(status).toBe(200);
    expect(body).toEqual({ id: Q.deletedInArchived, name: `planting ${Q.deletedInArchived}`, deleted_at: null });
    expect(calls.map(kindOf)).toEqual(['select', 'update garden_node', 'update container']);
    expect(calls[0].tx).toBeNull();
    expect(calls[1].tx, 'the restore UPDATE ran outside a transaction').not.toBeNull();
    expect(calls[2].tx, 'the container UPDATE ran outside the restore UPDATE\'s transaction').toBe(calls[1].tx);
    expect(containerRow(K.restoreHome).archived_at).toBeNull();
    expect(archivedContainers()).toEqual(before.filter((id) => id !== K.restoreHome));
    expect(await onGarden()).toContain(Q.deletedInArchived);
  });

  it('restore of a planting that is ALSO archived: it goes to the Archived page and its container stays', async () => {
    const before = archivedContainers();
    expect((await restore(Q.deletedAndArchived)).status).toBe(200);
    expect(plantRow(Q.deletedAndArchived).deleted_at).toBeNull();
    expect(plantRow(Q.deletedAndArchived).archived_at).not.toBeNull();
    expect(archivedContainers(), 'the container came back for a planting that did not').toEqual(before);
    expect(await onArchivedPage()).toContain(Q.deletedAndArchived);
    expect(await onGarden()).not.toContain(Q.deletedAndArchived);
  });

  it('restore of a planting that was never deleted sends no write at all (already_restored)', async () => {
    const before = archivedContainers();
    const { status, body, calls } = await restore(Q.sibLive);
    expect(status).toBe(200);
    expect(body.already_restored).toBe(true);
    expect(calls.map(kindOf)).toEqual(['select']);
    expect(archivedContainers()).toEqual(before);
  });

  it('the model sees the container statement\'s shape, not just today\'s spelling (synthetic UPDATEs)', () => {
    // The planting is live, as the planting UPDATE leaves it; $1 is the household, $2 the planting.
    const base = wayBackDb();
    base.plantings.find((r) => r.id === Q.trap).archived_at = null;
    const H = [DAVE, JEN];
    const run = (where) => {
      db = cloneDb(base);
      const before = archivedContainers();
      execUpdate(updateOf(`UPDATE public.container pp SET archived_at = NULL WHERE ${where}`), [H, Q.trap], db);
      const after = archivedContainers();
      return before.filter((id) => !after.includes(id));
    };
    const LIVE_PLANTING = 'gn.deleted_at IS NULL AND gn.archived_at IS NULL';
    const OWNED = 'pp.archived_at IS NOT NULL AND pp.deleted_at IS NULL AND pp.created_by = ANY($1)';
    expect(run(`${OWNED} AND EXISTS (SELECT 1 FROM public.garden_node gn WHERE gn.id = $2 AND gn.container_id = pp.id AND ${LIVE_PLANTING})`))
      .toEqual([K.trap]);
    // The correlation dropped: every archived container this household owns comes back at once.
    expect(run(`${OWNED} AND EXISTS (SELECT 1 FROM public.garden_node gn WHERE gn.id = $2 AND ${LIVE_PLANTING})`))
      .toEqual([K.neighbour, K.parent, K.restoreBoth, K.restoreHome, K.siblings, K.trap].sort());
  });
});
