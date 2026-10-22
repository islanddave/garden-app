// V5-SPACESENTINELDOC-001 / V5-SPACETENANCYKEY-001 (multi-space Phase 1, steps 1.9 and 1.8) — the
// consumer census of plant_projects.workspace_id, the CONTAINER's Space.
//
// WHY. migrations/v5-spacefk-001/0a-fold.sql moves ten containers from the nil workspace onto the one
// Space. Whatever reads a container's workspace_id sees that change. At 51a97146 two Lambda code paths
// do, and the fold's README states what each one does differently afterwards:
//   * lambda/projects/index.js reparentCore copies it into reparent_event (the tgt CTE selects it from
//     plant_projects, was :96; the ev CTE inserts t.workspace_id, was :112; :111 is reparent_event's own
//     column list, a write to the event table and not a container read);
//   * lambda/daily-plan/handler.js, the rain logger's once-a-day cap, reads c.workspace_id for a rain row
//     logged on a container (was :1149): after the fold such a row on one of the ten caps the Space's day.
// A third reader would change behaviour on the fold too, unreviewed. This file is what says there is none.
//
// AND THE KEYS (0b, 0c). "No code writes plants.workspace_id or plant_projects.workspace_id; inserts take
// the DEFAULT" is the deploy-safety argument for both foreign keys. It is asserted here, not assumed.
//
// METHOD. Every non-test Lambda source is parsed with @babel/parser. Every template or string literal
// that mentions workspace_id is read as SQL by a small resolver: it tokenises (comments and quoted
// strings out), builds the parenthesis scopes, records each scope's FROM / JOIN / UPDATE / INTO bindings
// and its CTEs, and resolves every workspace_id reference to the relation it names — `c.workspace_id`
// through the alias, a bare `workspace_id` through the only relation in scope, `t.workspace_id` through
// the CTE t to whatever that CTE read it from. A bare reference with two relations in scope is
// AMBIGUOUS and reds: qualify it. A star (`*`, `c.*`, RETURNING *) or a whole-row value (`to_jsonb(c)`)
// over a container is a reader too. Every other mention of workspace_id in the file must be a comment
// or a JS property, or the coverage test reds: SQL the resolver did not see cannot hide here.
// Line numbers are reported, never pinned (other lanes edit handler.js); each reader is pinned by its
// file, its reference, its relation and a fragment of its own statement.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from '@babel/parser';

const LAMBDA = resolve(process.cwd(), 'lambda');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === '__tests__') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(c|m)?js$/.test(entry) && !/\.test\.(c|m)?js$/.test(entry)) out.push(p);
  }
  return out;
}

// ── the SQL resolver ──────────────────────────────────────────────────────────────────────────────────

const CONTAINER = new Set(['container', 'plant_projects']);
const PLANTING = new Set(['garden_node', 'plants']);
const KEYED = new Set([...CONTAINER, ...PLANTING]);
const KEYWORDS = new Set(`all and any as asc between both by case cast collate conflict constraint create cross
  current_date current_timestamp default delete desc distinct do else end except exists false fetch filter
  first for from full group having ilike in inner insert intersect into is join last lateral left like
  limit materialized natural not nothing now null nulls of offset on only or order outer over recursive
  returning right select set similar some table then to true union update using values when where window
  with`.split(/\s+/));
const CLAUSE = new Set(['select', 'from', 'where', 'set', 'returning', 'values', 'group', 'order', 'having',
  'limit', 'on', 'join', 'using', 'conflict', 'do', 'into', 'update', 'delete', 'insert', 'with', 'union']);
const FROM_IN_FUNCTION = new Set(['extract', 'substring', 'trim', 'overlay', 'position']);
const WHOLE_ROW = new Set(['to_jsonb', 'to_json', 'row_to_json']);

const isIdent = (t) => t && t.t === 'id';
const isWord = (t, w) => t && t.t === 'id' && t.v === w;
const isOp = (t, o) => t && t.t === 'op' && t.v === o;
const isScope = (t) => t && t.t === 'scope';
const isName = (t) => isIdent(t) && !KEYWORDS.has(t.v);

function tokenize(text) {
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (c === "'") {
      const at = i;
      i += 1;
      while (i < text.length) { if (text[i] === "'" && text[i + 1] === "'") i += 2; else if (text[i] === "'") break; else i += 1; }
      i += 1;
      toks.push({ t: 'str', at });
      continue;
    }
    if (c === '"') { const e = text.indexOf('"', i + 1); toks.push({ t: 'id', v: text.slice(i + 1, e).toLowerCase(), at: i }); i = e + 1; continue; }
    if (c === '$') { const m = /^\$[A-Za-z0-9_]*/.exec(text.slice(i)); toks.push({ t: 'param', at: i }); i += m[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (id) { toks.push({ t: 'id', v: id[0].toLowerCase(), at: i }); i += id[0].length; continue; }
    const num = /^[0-9]+(\.[0-9]+)?/.exec(text.slice(i));
    if (num) { toks.push({ t: 'num', at: i }); i += num[0].length; continue; }
    if (c === ':' && text[i + 1] === ':') { toks.push({ t: 'op', v: '::', at: i }); i += 2; continue; }
    if (/\s/.test(c)) { i += 1; continue; }
    toks.push({ t: 'op', v: c, at: i });
    i += 1;
  }
  return toks;
}

// Parenthesis scopes. A scope's `own` list holds its tokens, with each child scope as one {t:'scope'}.
function scopesOf(toks) {
  const root = { own: [], parent: null, opener: -1 };
  const all = [root];
  let cur = root;
  for (const tok of toks) {
    if (isOp(tok, '(')) {
      const child = { own: [], parent: cur, opener: cur.own.length - 1 };
      cur.own.push({ t: 'scope', scope: child, at: tok.at });
      all.push(child);
      cur = child;
    } else if (isOp(tok, ')')) {
      if (cur.parent) cur = cur.parent;
    } else cur.own.push(tok);
  }
  for (const s of all) analyseBindings(s);
  return { root, all };
}

const openerWord = (s) => (s.parent && s.opener >= 0 ? s.parent.own[s.opener] : null);

function analyseBindings(s) {
  s.bindings = [];
  s.ctes = new Map();
  const o = s.own;
  const fnOpener = openerWord(s);
  let inWith = false;
  const item = (j, kw) => {
    while (isWord(o[j], 'only') || isWord(o[j], 'lateral')) j += 1;
    let rel = null;
    let name = null;
    if (isScope(o[j])) { rel = { sub: o[j].scope }; j += 1; }
    else if (isName(o[j]) || (isIdent(o[j]) && (kw === 'into' || kw === 'update'))) {
      name = o[j].v;
      j += 1;
      if (isOp(o[j], '.') && isIdent(o[j + 1])) { name = o[j + 1].v; j += 2; }
      if (isScope(o[j]) && kw !== 'into') { rel = { fn: name }; j += 1; } else rel = { name };
    } else return null;
    let alias = null;
    if (isWord(o[j], 'as')) j += 1;
    if (isName(o[j])) { alias = o[j].v; j += 1; }
    s.bindings.push({ kw, alias: alias ?? name, rel, after: j });
    return j;
  };
  for (let i = 0; i < o.length; i += 1) {
    const t = o[i];
    if (isWord(t, 'with')) { inWith = true; continue; }
    if (inWith && isName(t) && (isWord(o[i - 1], 'with') || isWord(o[i - 1], 'recursive') || isOp(o[i - 1], ','))) {
      let j = i + 1;
      if (isScope(o[j])) j += 1;
      if (isWord(o[j], 'as')) {
        j += 1;
        if (isWord(o[j], 'not')) j += 1;
        if (isWord(o[j], 'materialized')) j += 1;
        if (isScope(o[j])) { s.ctes.set(t.v, o[j].scope); i = j; continue; }
      }
    }
    if (isWord(t, 'select') || isWord(t, 'insert') || isWord(t, 'update') || isWord(t, 'delete') || isWord(t, 'values')) inWith = false;
    if (!isIdent(t) || !['from', 'join', 'update', 'into'].includes(t.v)) continue;
    if (t.v === 'from' && (isWord(o[i - 1], 'distinct') || (fnOpener && FROM_IN_FUNCTION.has(fnOpener.v)))) continue;
    let j = item(i + 1, t.v);
    while (t.v === 'from' && j != null && isOp(o[j], ',')) j = item(j + 1, 'from');
  }
}

function lookupCte(s, name) {
  for (let x = s; x; x = x.parent) if (x.ctes.has(name)) return x.ctes.get(name);
  return null;
}

function lookupAlias(s, alias) {
  for (let x = s; x; x = x.parent) {
    const b = x.bindings.find((y) => y.alias === alias && y.kw !== 'into');
    if (b) return { b, at: x };
  }
  for (let x = s; x; x = x.parent) {
    const b = x.bindings.find((y) => y.alias === alias);
    if (b) return { b, at: x };
  }
  return null;
}

// A relation as a set of base names, following CTEs and sub-selects to what their workspace_id is.
function relationClass(rel, s, seen = new Set()) {
  if (rel.name) {
    const cte = lookupCte(s, rel.name);
    if (cte && !seen.has(cte)) { seen.add(cte); return { via: `cte ${rel.name}`, bases: outputSource(cte, seen) }; }
    return { via: null, bases: new Set([rel.name]) };
  }
  if (rel.sub) { seen.add(rel.sub); return { via: 'subquery', bases: outputSource(rel.sub, seen) }; }
  return { via: `function ${rel.fn}`, bases: new Set() };
}

// What a CTE or sub-select's own workspace_id output column reads (its direct references, and stars).
function outputSource(scope, seen) {
  const out = new Set();
  for (const r of refsInScope(scope, seen)) if (r.kind === 'read' || r.kind === 'star') for (const b of r.bases) out.add(b);
  return out;
}

function nearestClause(o, i) {
  for (let k = i - 1; k >= 0; k -= 1) if (isIdent(o[k]) && CLAUSE.has(o[k].v)) return o[k].v;
  return null;
}

function bindingFor(s, kinds) {
  for (let x = s; x; x = x.parent) {
    const bs = x.bindings.filter((b) => kinds.includes(b.kw));
    if (bs.length) return bs;
  }
  return [];
}

function refsInScope(s, seen = new Set()) {
  const refs = [];
  const o = s.own;
  const opener = openerWord(s);
  const intoList = s.parent && opener && isIdent(opener)
    && (isWord(s.parent.own[s.opener - 1], 'into') || (isOp(s.parent.own[s.opener - 1], '.') && isWord(s.parent.own[s.opener - 3], 'into')));
  const push = (kind, ref, rel, at, via0 = null) => {
    const c = relationClass(rel, s, new Set(seen));
    refs.push({ kind, ref, rel: rel.name ?? rel.fn ?? 'subquery', via: via0 ?? c.via, bases: c.bases, at });
  };
  for (let i = 0; i < o.length; i += 1) {
    const t = o[i];
    // whole-row value: to_jsonb(c)
    if (isScope(t) && isIdent(o[i - 1]) && WHOLE_ROW.has(o[i - 1].v) && t.scope.own.length === 1 && isIdent(t.scope.own[0])) {
      const hit = lookupAlias(s, t.scope.own[0].v);
      if (hit) push('star', `${o[i - 1].v}(${t.scope.own[0].v})`, hit.b.rel, t.at);
      continue;
    }
    // star: select * / returning * / x.*
    if (isOp(t, '*')) {
      if (isOp(o[i - 1], '.') && isIdent(o[i - 2])) {
        const hit = lookupAlias(s, o[i - 2].v);
        if (hit) push('star', `${o[i - 2].v}.*`, hit.b.rel, t.at);
        continue;
      }
      const prev = o[i - 1];
      const clause = nearestClause(o, i);
      if ((isWord(prev, 'select') || isWord(prev, 'returning') || isWord(prev, 'distinct') || isOp(prev, ',')) && (clause === 'select' || clause === 'returning')) {
        const bs = clause === 'returning' ? s.bindings.filter((b) => b.kw !== 'join') : bindingFor(s, ['from', 'join']);
        for (const b of bs) push('star', '*', b.rel, t.at);
      }
      continue;
    }
    if (!isWord(t, 'workspace_id')) continue;
    if (isOp(o[i - 1], '.') && isIdent(o[i - 2])) {
      const hit = lookupAlias(s, o[i - 2].v);
      if (hit) push('read', `${o[i - 2].v}.workspace_id`, hit.b.rel, t.at);
      else refs.push({ kind: 'unresolved', ref: `${o[i - 2].v}.workspace_id`, rel: null, bases: new Set(), at: t.at });
      continue;
    }
    if (intoList) {
      const into = s.parent.bindings.find((b) => b.kw === 'into');
      if (into) push('write', 'workspace_id', into.rel, t.at, 'insert column list');
      continue;
    }
    if (opener && isWord(opener, 'conflict')) {
      const into = s.parent.bindings.find((b) => b.kw === 'into');
      if (into) push('arbiter', 'workspace_id', into.rel, t.at, 'on conflict');
      continue;
    }
    const clause = nearestClause(o, i);
    if (clause === 'set' && isOp(o[i + 1], '=')) {
      const target = s.bindings.find((b) => b.kw === 'update') ?? s.bindings.find((b) => b.kw === 'into');
      if (target) push('write', 'workspace_id', target.rel, t.at, 'set');
      continue;
    }
    if (clause === 'returning') {
      const target = s.bindings.find((b) => b.kw === 'update' || b.kw === 'into') ?? s.bindings.find((b) => b.kw === 'from');
      if (target) push('read', 'workspace_id', target.rel, t.at, 'returning');
      continue;
    }
    const bs = bindingFor(s, ['from', 'join', 'update']);
    if (bs.length === 1) push('read', 'workspace_id', bs[0].rel, t.at);
    else refs.push({ kind: bs.length ? 'ambiguous' : 'unresolved', ref: 'workspace_id', rel: bs.map((b) => b.alias).join(','), bases: new Set(), at: t.at });
  }
  // implicit all-column insert into a keyed table: INSERT INTO plants SELECT ... / VALUES (...)
  for (const b of s.bindings) {
    if (b.kw !== 'into' || !b.rel.name || isScope(o[b.after]) || isWord(o[b.after], 'default')) continue;
    if (KEYED.has(b.rel.name) || CONTAINER.has(b.rel.name)) push('write', '(all columns)', b.rel, null, 'insert without a column list');
  }
  return refs;
}

// Every reference in one SQL text: { kind, ref, rel, via, bases, offset }.
function sqlRefs(text) {
  const { all } = scopesOf(tokenize(text));
  return all.flatMap((s) => refsInScope(s));
}

const classOf = (r) => ([...r.bases].some((b) => CONTAINER.has(b)) ? 'container'
  : [...r.bases].some((b) => PLANTING.has(b)) ? 'planting' : 'other');

// ── the census over source files ─────────────────────────────────────────────────────────────────────

// One source file -> its SQL-bearing literals and every workspace_id occurrence's classification.
function censusOfSource(rel, src) {
  const ast = parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, ranges: false, errorRecovery: false });
  const literals = [];
  const covered = [];
  for (const c of ast.comments) covered.push([c.start, c.end]);
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'TemplateLiteral') {
      let text = '';
      n.quasis.forEach((q, k) => {
        covered.push([q.start, q.end]);
        text += q.value.raw;
        const e = n.expressions[k];
        if (e) text += `$P${'\n'.repeat((src.slice(e.start, e.end).match(/\n/g) || []).length)}`;
      });
      literals.push({ text, line: n.loc.start.line, startCol: n.loc.start.column });
    } else if (n.type === 'StringLiteral') {
      covered.push([n.start, n.end]);
      literals.push({ text: n.value, line: n.loc.start.line, string: true });
    } else if (n.type === 'Identifier' && n.name === 'workspace_id') covered.push([n.start, n.end]);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast.program);

  const unclassified = [];
  for (const m of src.matchAll(/\bworkspace_id\b/g)) {
    if (!covered.some(([a, b]) => m.index >= a && m.index < b)) {
      unclassified.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }

  const refs = [];
  const mentions = [];
  for (const lit of literals) {
    if (!/\bworkspace_id\b/i.test(lit.text) && !/\b(container|plant_projects|plants|garden_node)\b/i.test(lit.text)) continue;
    if (!/\b(select|insert|update|delete)\b/i.test(lit.text)) {
      if (/\bworkspace_id\b/i.test(lit.text)) mentions.push(`${rel}:${lit.line}`);
      continue;
    }
    const norm = lit.text.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    for (const r of sqlRefs(lit.text)) {
      const line = r.at == null ? lit.line : lit.line + (lit.text.slice(0, r.at).match(/\n/g) || []).length;
      refs.push({ file: rel, line, kind: r.kind, ref: r.ref, rel: r.rel, via: r.via, cls: classOf(r), stmt: norm });
    }
  }
  return { refs, mentions, unclassified };
}

const FILES = walk(LAMBDA).map((p) => relative(LAMBDA, p)).sort();
const SRC = new Map(FILES.map((rel) => [rel, readFileSync(join(LAMBDA, rel), 'utf-8')]));

function census(sources) {
  const out = { refs: [], mentions: [], unclassified: [] };
  for (const [rel, src] of sources) {
    const c = censusOfSource(rel, src);
    out.refs.push(...c.refs);
    out.mentions.push(...c.mentions);
    out.unclassified.push(...c.unclassified);
  }
  return out;
}

const key = (r) => `${r.file} :: ${r.kind} ${r.ref} -> ${r.rel}${r.via ? ` (${r.via})` : ''}`;
const containerReaders = (c) => c.refs.filter((r) => (r.kind === 'read' || r.kind === 'star') && r.cls === 'container');
const keyedWriters = (c) => c.refs.filter((r) => r.kind === 'write' && (r.cls === 'container' || r.cls === 'planting'
  || KEYED.has(r.rel)));

// THE CENSUS. Each reader: its key, and a fragment its own statement must contain (so a reader that moves
// into another statement is a change, not a pass).
const EXPECTED_CONTAINER_READERS = [
  { key: 'projects/index.js :: read workspace_id -> plant_projects', stmt: 'insert into reparent_event' },
  { key: 'projects/index.js :: read t.workspace_id -> tgt (cte tgt)', stmt: 'insert into reparent_event' },
  { key: 'daily-plan/handler.js :: read c.workspace_id -> container',
    stmt: 'from event_log e left join garden_node n on n.id = e.plant_id' },
  // V5-SPACETENANCYKEY-001 2.2 (parent-derived stamps): the admin-classify audit row takes its project's Space, read
  // in the pre CTE with the pre-image and copied into proj_rescope_events, as reparentCore copies it into
  // reparent_event. Reviewed: a copy of the row's own Space, never a request value.
  { key: 'projects/index.js :: read workspace_id -> container', stmt: 'insert into proj_rescope_events' },
  { key: 'projects/index.js :: read workspace_id -> pre (cte pre)', stmt: 'insert into proj_rescope_events' },
];

const REAL = census(SRC);

describe('the census is not vacuous', () => {
  it('walks the Lambda fleet and resolves its workspace_id SQL', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(150);
    expect(FILES).toContain('daily-plan/handler.js');
    expect(FILES).toContain('projects/index.js');
    const reads = REAL.refs.filter((r) => r.kind === 'read');
    expect(reads.length, 'resolved workspace_id reads across the fleet').toBeGreaterThanOrEqual(8);
    // The planting side is seen too, so a reader is not "missing" because nothing was resolved.
    expect(reads.some((r) => r.file === 'daily-plan/handler.js' && r.ref === 'gn.workspace_id' && r.cls === 'planting')).toBe(true);
    expect(reads.some((r) => r.file === 'plants/merge.js' && r.ref === 'p.workspace_id' && r.rel === 'plants')).toBe(true);
    expect(REAL.refs.some((r) => r.file === 'projects/index.js' && r.kind === 'write' && r.rel === 'reparent_event')).toBe(true);
  });
});

describe('V5-SPACESENTINELDOC-001 — who reads a container\'s workspace_id', () => {
  it('every workspace_id in a Lambda source is a comment, a JS property, or SQL this census resolved', () => {
    expect(REAL.unclassified, 'workspace_id outside any literal, comment or identifier').toEqual([]);
    expect(REAL.mentions, 'a string that names workspace_id but is not SQL: classify it here').toEqual([]);
  });

  it('no bare workspace_id is ambiguous or unresolved (qualify it with its alias)', () => {
    const bad = REAL.refs.filter((r) => r.kind === 'ambiguous' || r.kind === 'unresolved');
    expect(bad.map((r) => `${r.file}:${r.line} ${r.ref} [${r.rel}]`)).toEqual([]);
  });

  it('the readers of a container\'s workspace_id are exactly the reparent copy, the rescope audit copy and the rain cap', () => {
    const got = containerReaders(REAL);
    // Re-pinned here (and in the migration README): the lines this run found.
    const where = got.map((r) => `${key(r)} @ ${r.file}:${r.line}`);
    expect([...new Set(got.map(key))].sort(), where.join('\n')).toEqual(EXPECTED_CONTAINER_READERS.map((e) => e.key).sort());
    for (const e of EXPECTED_CONTAINER_READERS) {
      const hits = got.filter((r) => key(r) === e.key);
      expect(hits.length, `${e.key} should be read once`).toBe(1);
      expect(hits[0].stmt, `${e.key} moved out of its statement`).toContain(e.stmt);
    }
  });

  it('no Lambda writes plants.workspace_id or plant_projects.workspace_id (inserts take the DEFAULT)', () => {
    expect(keyedWriters(REAL).map((r) => `${r.file}:${r.line} ${r.ref} -> ${r.rel} (${r.via})`)).toEqual([]);
  });

  it('a new reader, in a new file or beside an old one, reds the census (positive control)', () => {
    const planted = new Map(SRC);
    planted.set('planted/reader.js', 'export const q = (sql, id) => sql`SELECT pp.workspace_id FROM public.plant_projects pp WHERE pp.id = ${id}`;\n');
    const c = census(planted);
    expect(containerReaders(c).map(key)).toContain('planted/reader.js :: read pp.workspace_id -> plant_projects');
    expect([...new Set(containerReaders(c).map(key))].sort()).not.toEqual(EXPECTED_CONTAINER_READERS.map((e) => e.key).sort());

    const writer = new Map(SRC);
    writer.set('planted/writer.js', 'export const w = (sql, id) => sql`UPDATE public.container SET workspace_id = ${id} WHERE id = ${id}`;\n');
    expect(keyedWriters(census(writer)).map((r) => r.file)).toEqual(['planted/writer.js']);

    const hidden = new Map(SRC);
    hidden.set('planted/hidden.js', 'const q = "select " + "workspace_id from container";\nexport default q;\nexport const k = { workspace_id: 1 };\n');
    const h = census(hidden);
    expect(h.mentions).toContain('planted/hidden.js:1');
  });
});

describe('the resolver (synthetic statements)', () => {
  const read = (sql) => sqlRefs(sql).map((r) => `${r.kind} ${r.ref} ${classOf(r)}`);
  it('resolves aliases, bare columns, CTEs, stars, whole rows, writes and ambiguity', () => {
    expect(read('select c.workspace_id from container c')).toEqual(['read c.workspace_id container']);
    expect(read('SELECT workspace_id FROM public.plant_projects WHERE id = $1')).toEqual(['read workspace_id container']);
    expect(read('select p.workspace_id from plants p left join plant_projects pp on pp.id = p.project_id'))
      .toEqual(['read p.workspace_id planting']);
    expect(read('select workspace_id from plants p join plant_projects pp on pp.id = p.project_id'))
      .toEqual(['ambiguous workspace_id other']);
    expect(read(`with t as (select id, workspace_id from plant_projects where id = $1),
                  ev as (insert into reparent_event (subject_id, workspace_id) select t.id, t.workspace_id from t returning subject_id)
                  select subject_id from ev`).sort())
      .toEqual(['read t.workspace_id container', 'read workspace_id container', 'write workspace_id other'].sort());
    // A star over a CTE is read as everything the CTE read: coarse on purpose, it can only over-report.
    expect(read('with t as (select workspace_id from container) select * from t')).toContain('star * container');
    expect(read('select pp.* from plant_projects pp')).toEqual(['star pp.* container']);
    expect(read('select * from container where id = $1')).toEqual(['star * container']);
    expect(read('insert into public.container (display_name) values ($1) returning *')).toEqual(['star * container']);
    expect(read('select to_jsonb(c) from container c')).toEqual(['star to_jsonb(c) container']);
    expect(read('select count(*), sum(a * b) from container')).toEqual([]);
    expect(read('update plant_projects set workspace_id = $1 where id = $2')).toEqual(['write workspace_id container']);
    expect(read('insert into plants (name, workspace_id) values ($1, $2)')).toEqual(['write workspace_id planting']);
    expect(read('insert into plants select * from ctas_x')).toEqual(['star * other', 'write (all columns) planting']);
    expect(read('select 1 from x where a is distinct from b.c and exists (select 1 from container k where k.workspace_id = $1)'))
      .toEqual(['read k.workspace_id container']);
    expect(read("select 1 -- c.workspace_id in a comment\n from container c where c.name = 'workspace_id'")).toEqual([]);
    expect(read('insert into garden_shared_state (workspace_id, kind) values ($1, $2) on conflict (workspace_id, kind) do nothing'))
      .toEqual(['write workspace_id other', 'arbiter workspace_id other']);
  });
});
