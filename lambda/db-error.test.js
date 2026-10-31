// new-file: lambda/db-error.js is a new module (the SEC-20 DB-error reply table); no existing file tests it
// SEC-20 (OPS-CODEREVIEW-001 D2b): a reply names the KIND of database refusal, never the database's words, and a
// log line keeps object names and call frames but never row values. Executes every adopter's catch with canaries.
// Trap: an adopter is a URL dir whose index.js imports ./db-error.js; one with no request fixture fails loudly.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import * as acorn from 'acorn';
import { stubState, resetStubs } from './_test-stubs/state.js';
import { lambdaFiles } from '../tests/lib/sqlCensus.mjs';
import { DB_ERROR_REPLIES, dbErrorReply, logCaughtError, logCaughtWarning } from './db-error.js';
import { SEED_CONSTRAINT_MESSAGES } from './inventory-items/index.js';
import { CONSTRAINT_MESSAGES as VARIETY_MESSAGES } from './varieties/validate.js';
import { kitchenErrorMessage } from './preservation/kitchenBatch.js';
import { jarErrorMessage } from './preservation/jarRules.js';
import { sourceErrorMessage } from './preservation/sourceRoutes.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const parse = (src) => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowHashBang: true, locations: true });

const MANIFEST = JSON.parse(read('../scripts/lambda-config-expected.json'));
const URL_DIRS = Object.entries(MANIFEST)
  .filter(([fn, spec]) => fn.startsWith('garden-') && spec && spec.url !== null && typeof spec.url === 'object')
  .map(([fn]) => fn.slice('garden-'.length))
  .sort();
const importsDbError = (dir) => parse(read(`${dir}/index.js`)).body
  .some((n) => n.type === 'ImportDeclaration' && n.source.value === './db-error.js');
const ADOPTERS = URL_DIRS.filter(importsDbError);

// The 10 handler dirs whose catch answers a database error with a status of its own (design §2.2).
const COPY_DIRS = ['app-events', 'events', 'inventory-items', 'locations', 'plants', 'preservation', 'projects', 'storage-location', 'tags', 'varieties'];

// The table, restated: each code is the PostgreSQL condition name of its SQLSTATE and each text is the old prefix.
const TABLE = {
  '23514': { status: 400, error: 'Constraint violation', code: 'check_violation' },
  '23502': { status: 400, error: 'Required field missing', code: 'not_null_violation' },
  '23503': { status: 400, error: 'Foreign key violation', code: 'foreign_key_violation' },
  '23505': { status: 409, error: 'Unique violation', code: 'unique_violation' },
  '42P01': { status: 500, error: 'Schema out of date for this deploy — relation missing', code: 'schema_out_of_date' },
  '42703': { status: 500, error: 'Schema out of date for this deploy — column missing', code: 'schema_out_of_date' },
};
const GENERIC = { status: 500, body: { error: 'Internal server error' } };

// The SQLSTATEs each handler answered with its own status before SEC-20. D2b keeps exactly these, plus projects'
// 23505 (R-D2B-1 OQ2, the one named status change).
const ARMS = {
  'app-events': ['23514', '23502'],
  events: ['23514', '23502', '23503', '23505'],
  'inventory-items': ['23514', '23502', '23503'],
  locations: ['23503', '23514'],
  plants: ['23503', '23514'],
  preservation: ['42P01', '23514', '42703', '23502', '23503'],
  projects: ['23503', '23514', '23505'],
  'storage-location': ['23514', '23502', '23503'],
  tags: ['23514', '23502', '23503', '23505'],
  varieties: ['23514', '23502', '23503', '23505'],
};

// Replies a handler keys on (code, constraint) BEFORE the table, unchanged: one row per sentence family. A row with
// no constraint answers every constraint of its code.
const sentence = (constraint, error) => ({ code: '23514', constraint, status: 400, body: { error } });
const MAPPED = {
  'inventory-items': Object.entries(SEED_CONSTRAINT_MESSAGES).map(([c, e]) => sentence(c, e)),
  locations: [{ code: '23505', status: 409, body: { error: 'Slug already exists', code: 'location_slug_conflict' } }],
  plants: [sentence('chk_plants_source_distinct', 'The originator and the place you got it from have to be two different sources. Clear one of them, or pick a different one.')],
  preservation: [
    sentence('chk_ksl_ph_scale', kitchenErrorMessage({ code: '23514', constraint: 'chk_ksl_ph_scale' })),
    sentence('chk_preservation_log_label_nonblank', jarErrorMessage({ code: '23514', constraint: 'chk_preservation_log_label_nonblank' })),
    sentence('chk_ps_garden_only', sourceErrorMessage({ code: '23514', constraint: 'chk_ps_garden_only' })),
    sentence('chk_preservation_log_source_plant', 'This put-up is linked to a planting, so its source must be your own garden. Clear the planting first.'),
    { code: '23514', constraint: 'chk_preservation_log_source_kind', status: 400, body: { error: 'Source is not valid', code: 'check_violation' } },
  ],
  projects: [{ code: '23505', constraint: 'plant_projects_slug_key', status: 409, body: { error: 'Slug already exists', code: 'project_slug_conflict' } }],
  varieties: Object.entries(VARIETY_MESSAGES).map(([c, e]) => sentence(c, e)),
};

// One request per adopter whose first statement runs inside the handler's outer try.
const REQUESTS = {
  'app-events': ['POST', '/api/app-events', { event_name: 'db-error-canary' }],
  events: ['GET', '/api/events'],
  'inventory-items': ['GET', '/api/inventory-items/sow-candidates'],
  locations: ['GET', '/api/locations'],
  plants: ['GET', '/api/plants'],
  preservation: ['GET', '/api/preservation'],
  projects: ['GET', '/api/projects'],
  'storage-location': ['GET', '/api/storage-locations'],
  tags: ['GET', '/api/tags'],
  varieties: ['GET', '/api/varieties'],
};

const CANARY = {
  message: 'MSG_CANARY_d2b',
  constraint: 'CONSTRAINT_CANARY_d2b',
  column: 'COLUMN_CANARY_d2b',
  table: 'TABLE_CANARY_d2b',
  detail: 'DETAIL_CANARY_d2b',
  schema: 'SCHEMA_CANARY_d2b',
  hint: 'HINT_CANARY_d2b',
  where: 'WHERE_CANARY_d2b',
  routine: 'ROUTINE_CANARY_d2b',
  internalQuery: 'INTERNALQUERY_CANARY_d2b',
  dataType: 'DATATYPE_CANARY_d2b',
};
// Shaped like NeonDbError: every field is an own enumerable property, and the stack's first line holds the message.
const dbError = (code, over = {}) => Object.assign(new Error(CANARY.message), {
  name: 'NeonDbError', severity: 'ERROR', ...CANARY, message: CANARY.message, code, ...over,
});
const SHAPES = ['23514', '23502', '23503', '23505', '42P01', '42703', '22P02', '40001', 'P0001', 'XX000'];
const LOGS_MESSAGE = (code) => ['42', 'P0'].includes(code.slice(0, 2));
const ROW_TEXT_CANARIES = ['detail', 'hint', 'where', 'internalQuery', 'dataType', 'schema'];

const USER = 'user_db_error_canary';
const handlers = {};
const handlerOf = async (dir) => (handlers[dir] ??= await import(`./${dir}/index.js`));

function capture() {
  const lines = [];
  for (const k of ['error', 'warn', 'log', 'info', 'debug', 'trace']) {
    // CloudWatch receives util.format of the arguments, which inspects an Error with its own fields.
    vi.spyOn(console, k).mockImplementation((...args) => { lines.push(format(...args)); });
  }
  return lines;
}
afterEach(() => vi.restoreAllMocks());

async function drive(dir, err) {
  const { handler } = await handlerOf(dir);
  resetStubs();
  stubState.verifyTokenResult = { sub: USER };
  let thrown = 0;
  stubState.sqlHandler = () => { thrown += 1; throw err; };
  const [method, rawPath, body] = REQUESTS[dir];
  const lines = capture();
  const res = await handler({
    requestContext: { http: { method } }, rawPath, headers: { authorization: 'Bearer stub-token' },
    body: body ? JSON.stringify(body) : undefined, queryStringParameters: {},
  });
  vi.restoreAllMocks();
  return { res, thrown, lines };
}
const asJson = (line) => { try { return JSON.parse(line); } catch { return null; } };

function expectedReply(dir, err, mapped) {
  if (mapped) return { status: mapped.status, body: mapped.body };
  if (ARMS[dir].includes(err.code)) {
    const r = TABLE[err.code];
    return { status: r.status, body: { error: r.error, code: r.code } };
  }
  return GENERIC;
}

// Status and body exact; no canary anywhere on the wire; every console line free of row text.
async function expectCatch(dir, err, mapped) {
  const { res, thrown, lines } = await drive(dir, err);
  expect(thrown, 'the canary never reached SQL, so the catch was not exercised').toBeGreaterThan(0);
  expect({ status: res.statusCode, body: JSON.parse(res.body) }).toEqual(expectedReply(dir, err, mapped));
  const wire = JSON.stringify(res);
  for (const [k, v] of Object.entries(CANARY)) expect(wire, `the reply carries err.${k}`).not.toContain(v);
  const all = lines.join('\n');
  for (const k of ROW_TEXT_CANARIES) expect(all, `a log line carries err.${k}`).not.toContain(CANARY[k]);
  expect(all.includes(CANARY.message), `message logged for ${err.code}`).toBe(LOGS_MESSAGE(err.code));
  const logged = lines.map(asJson).filter((o) => o?.msg === `${dir} lambda error`);
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ code: err.code, constraint: err.constraint, table: CANARY.table, column: CANARY.column, routine: CANARY.routine });
  expect(logged[0].frames.length, 'the line has no locator').toBeGreaterThan(0);
  for (const f of logged[0].frames) {
    expect(f).toMatch(/^at /);
    expect(f).not.toContain(CANARY.message);
  }
}

describe('the reply table', () => {
  it('is the six SQLSTATEs, each with its old prefix as text and its condition name as code, frozen', () => {
    expect(DB_ERROR_REPLIES).toEqual(TABLE);
    expect(Object.isFrozen(DB_ERROR_REPLIES)).toBe(true);
    for (const row of Object.values(DB_ERROR_REPLIES)) expect(Object.isFrozen(row)).toBe(true);
  });

  it('dbErrorReply answers a fresh { status, body: { error, code } } for a code the handler maps', () => {
    for (const code of Object.keys(TABLE)) {
      const r = dbErrorReply(dbError(code), [code]);
      expect(r).toEqual({ status: TABLE[code].status, body: { error: TABLE[code].error, code: TABLE[code].code } });
      r.body.error = 'mutated';
      expect(dbErrorReply(dbError(code), [code]).body.error).toBe(TABLE[code].error);
    }
  });

  it('dbErrorReply is null for a code the handler does not list, an unknown code, a prototype key or no error', () => {
    expect(dbErrorReply(dbError('23505'), ['23514'])).toBeNull();
    expect(dbErrorReply(dbError('22P02'), ['22P02'])).toBeNull();
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(dbErrorReply({ code: key }, [key])).toBeNull();
    }
    for (const err of [null, undefined, 'boom', 42, {}]) expect(dbErrorReply(err, ['23514'])).toBeNull();
  });
});

describe('logCaughtError', () => {
  const lineFor = (err) => {
    const lines = capture();
    logCaughtError('x lambda error', err);
    vi.restoreAllMocks();
    return lines;
  };

  it('a SQLSTATE error is one JSON line: code, object names and call frames; message only for class 42 and P0', () => {
    for (const code of ['23514', '23505', '22P02', '22001', '40001', '40P01', '08006', 'XX000', '42P01', '42703', 'P0001']) {
      const lines = lineFor(dbError(code));
      expect(lines).toHaveLength(1);
      const o = JSON.parse(lines[0]);
      const keys = ['msg', 'code', 'constraint', 'table', 'column', 'routine', 'frames'];
      expect(Object.keys(o).sort()).toEqual((LOGS_MESSAGE(code) ? [...keys, 'message'] : keys).sort());
      expect(o).toMatchObject({ msg: 'x lambda error', code, constraint: CANARY.constraint, table: CANARY.table, column: CANARY.column, routine: CANARY.routine });
      if (LOGS_MESSAGE(code)) expect(o.message).toBe(CANARY.message);
      for (const k of ROW_TEXT_CANARIES) expect(lines[0], `${code} logged err.${k}`).not.toContain(CANARY[k]);
      expect(lines[0].includes(CANARY.message), `${code} message`).toBe(LOGS_MESSAGE(code));
      expect(o.frames.length).toBeGreaterThan(0);
    }
  });

  it('the frames never carry message text, even a message that spans lines like a frame', () => {
    const msg = 'invalid input syntax for type uuid: "x\n    at USER_VALUE_CANARY (evil:1:1)"';
    const lines = lineFor(Object.assign(new Error(msg), { code: '22P02' }));
    const o = JSON.parse(lines[0]);
    expect(lines[0]).not.toContain('USER_VALUE_CANARY');
    expect(o.frames.every((f) => /^at /.test(f))).toBe(true);
  });

  it('an error with no SQLSTATE is logged whole, as console.error(msg, err) always did', () => {
    for (const code of [undefined, 'EPIPE', 'ECONNRESET', 'ERR_INVALID_ARG_TYPE', 'NoSuchKey', '2351', '235144', 'abcde']) {
      const err = Object.assign(new TypeError('program error'), code === undefined ? {} : { code });
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      logCaughtError('x lambda error', err);
      expect(spy.mock.calls, String(code)).toEqual([['x lambda error', err]]);
      vi.restoreAllMocks();
    }
  });

  it('a thrown non-object is logged whole and never throws', () => {
    for (const err of [null, undefined, 'boom', 42]) {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => logCaughtError('x lambda error', err)).not.toThrow();
      expect(spy.mock.calls).toEqual([['x lambda error', err]]);
      vi.restoreAllMocks();
    }
  });

  // post-promote-check counts every ERROR line under `errors`; an expected refusal must not read as a fault.
  it('logCaughtWarning writes logCaughtError\'s exact line at WARN, and nothing at ERROR', () => {
    const callsOf = (fn, err) => {
      const calls = { error: [], warn: [] };
      for (const k of ['error', 'warn']) vi.spyOn(console, k).mockImplementation((...a) => { calls[k].push(a); });
      fn('x lambda error', err);
      vi.restoreAllMocks();
      return calls;
    };
    for (const err of [dbError('23505'), dbError('40P01'), dbError('P0001'), Object.assign(new TypeError('program error'), { code: 'EPIPE' }), null]) {
      const asError = callsOf(logCaughtError, err);
      const asWarn = callsOf(logCaughtWarning, err);
      expect(asError.warn, String(err?.code)).toEqual([]);
      expect(asWarn.error, String(err?.code)).toEqual([]);
      expect(asWarn.warn, String(err?.code)).toHaveLength(1);
      expect(asWarn.warn, String(err?.code)).toEqual(asError.error);
    }
  });
});

describe('the copies and the adopters', () => {
  const copies = JSON.parse(read('../scripts/lambda-copies.json')).copies['lambda/db-error.js'];

  it('the manifest copies db-error.js into exactly the 10 handler dirs that answer a database error', () => {
    expect(copies).toEqual(COPY_DIRS.map((d) => `lambda/${d}/db-error.js`));
  });

  it('every copy is byte-identical to the master', () => {
    const master = read('db-error.js');
    for (const c of copies) expect(readFileSync(join(here, '..', c), 'utf8'), c).toBe(master);
  });

  it('every mapped row carries real text, so a renamed constraint cannot turn a row vacuous', () => {
    for (const m of Object.values(MAPPED).flat()) {
      expect(typeof m.body.error === 'string' && m.body.error.length > 0, JSON.stringify(m)).toBe(true);
    }
  });

  it('every adopter ships a copy, has a request fixture and its arms, and there is at least one', () => {
    expect(ADOPTERS.length).toBeGreaterThan(0);
    for (const dir of ADOPTERS) {
      expect(COPY_DIRS, dir).toContain(dir);
      expect(REQUESTS[dir], `${dir} has no request fixture`).toBeDefined();
      expect(ARMS[dir], `${dir} has no arms`).toBeDefined();
    }
  });
});

describe.each(ADOPTERS)('%s: the catch, executed with canary errors', (dir) => {
  it.each(SHAPES)('SQLSTATE %s', async (code) => {
    await expectCatch(dir, dbError(code), (MAPPED[dir] ?? []).find((m) => m.code === code && m.constraint === undefined));
  });

  for (const m of (MAPPED[dir] ?? []).filter((r) => r.constraint !== undefined)) {
    it(`mapped ${m.code} ${m.constraint} keeps its sentence, consulted first`, async () => {
      await expectCatch(dir, dbError(m.code, { constraint: m.constraint }), m);
    });
  }

  it('an error with no SQLSTATE answers the generic 500 and is logged whole', async () => {
    const err = Object.assign(new TypeError(CANARY.message), { detail: CANARY.detail });
    const { res, thrown, lines } = await drive(dir, err);
    expect(thrown).toBeGreaterThan(0);
    expect({ status: res.statusCode, body: JSON.parse(res.body) }).toEqual(GENERIC);
    expect(JSON.stringify(res)).not.toContain(CANARY.message);
    expect(lines.some((l) => l.startsWith(`${dir} lambda error`) && l.includes(CANARY.message))).toBe(true);
  });
});

// ── The static row: no reply carries a caught error's text ─────────────────────────────────────────────────────
// Every catch in every URL dir's non-test files. A name is tainted when its VALUE carries the caught error: the error
// itself, a field other than code/name/status/statusCode, a template, concatenation, stringify or method call on
// one, a spread, a destructured field, or a name initialised or assigned from any of those. A tainted value in an
// object property, a spread or a resp() argument outside console.* is a hit. A field read only as a lookup key
// (MAP[err.constraint]) or in a comparison carries no text; a call that receives the error is held separately
// (CALL_BOUNDARY) because the scan cannot see what the callee returns.
const SAFE_FIELDS = new Set(['code', 'name', 'status', 'statusCode']);
const SINK_CALLS = new Set(['resp', 'respond', 'jsonResponse']);
const STRINGIFY_GLOBALS = new Set(['String', 'inspect', 'format', 'structuredClone']);
const STRINGIFY_OBJECTS = new Set(['JSON', 'Object', 'util', 'Array', 'Reflect']);
const isConsoleCall = (n) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
  && n.callee.object.type === 'Identifier' && n.callee.object.name === 'console';
const propName = (m) => (!m.computed && m.property.type === 'Identifier' ? m.property.name
  : m.property.type === 'Literal' ? String(m.property.value) : null);

function tainted(n, names, strict) {
  if (!n) return false;
  const t = (x) => tainted(x, names, strict);
  switch (n.type) {
    case 'Identifier': return names.has(n.name);
    case 'ChainExpression': return t(n.expression);
    case 'AwaitExpression': return t(n.argument);
    case 'MemberExpression': {
      const p = propName(n);
      return !(p !== null && SAFE_FIELDS.has(p)) && t(n.object);
    }
    case 'TemplateLiteral': return n.expressions.some(t);
    case 'BinaryExpression': return n.operator === '+' && (t(n.left) || t(n.right));
    case 'LogicalExpression': return t(n.left) || t(n.right);
    case 'ConditionalExpression': return t(n.consequent) || t(n.alternate);
    case 'AssignmentExpression': return t(n.right);
    case 'SequenceExpression': return t(n.expressions[n.expressions.length - 1]);
    case 'ObjectExpression': return n.properties.some((p) => t(p.type === 'SpreadElement' ? p.argument : p.value));
    case 'ArrayExpression': return n.elements.some((e) => e && t(e.type === 'SpreadElement' ? e.argument : e));
    case 'SpreadElement': return t(n.argument);
    case 'NewExpression': return n.arguments.some(t);
    case 'CallExpression': {
      const c = n.callee;
      if (c.type === 'MemberExpression' && t(c.object)) return true;
      const stringifier = (c.type === 'Identifier' && STRINGIFY_GLOBALS.has(c.name))
        || (c.type === 'MemberExpression' && c.object.type === 'Identifier' && STRINGIFY_OBJECTS.has(c.object.name));
      return (strict || stringifier) && n.arguments.some(t);
    }
    default: return false;
  }
}

function bindPattern(p, names) {
  let grew = false;
  const add = (id) => { if (!names.has(id)) { names.add(id); grew = true; } };
  if (!p) return false;
  if (p.type === 'Identifier') add(p.name);
  else if (p.type === 'ObjectPattern') {
    for (const prop of p.properties) {
      if (prop.type === 'RestElement') { grew = bindPattern(prop.argument, names) || grew; continue; }
      const key = !prop.computed && prop.key.type === 'Identifier' ? prop.key.name : null;
      if (key !== null && SAFE_FIELDS.has(key)) continue;
      grew = bindPattern(prop.value, names) || grew;
    }
  } else if (p.type === 'ArrayPattern') { for (const e of p.elements) grew = bindPattern(e, names) || grew; }
  else if (p.type === 'AssignmentPattern') grew = bindPattern(p.left, names) || grew;
  else if (p.type === 'RestElement') grew = bindPattern(p.argument, names) || grew;
  return grew;
}

const childrenOf = (n) => Object.entries(n)
  .filter(([k]) => k !== 'loc')
  .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
  .filter((c) => c && typeof c.type === 'string');

function fnName(stack) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const n = stack[i];
    if (n.type === 'FunctionDeclaration' && n.id) return n.id.name;
    if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      const parent = stack[i - 1];
      if (n.id) return n.id.name;
      if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
      if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && parent.key.type === 'Identifier') return parent.key.name;
      return '<anon>';
    }
  }
  return '<module>';
}

// [{ file, line, fn, expr, guard }]: guard is the innermost `if` test in the catch, else the try block's text.
function catchLeaks(file, src, { strict = false } = {}) {
  const hits = [];
  const seen = new Set();
  const text = (n) => src.slice(n.start, n.end);
  const visit = (n, stack) => {
    if (n.type === 'CatchClause' && n.param) {
      const names = new Set();
      bindPattern(n.param, names);
      for (let grew = true; grew;) {
        grew = false;
        const walk = (m) => {
          if (m.type === 'VariableDeclarator' && m.init && tainted(m.init, names, strict)) grew = bindPattern(m.id, names) || grew;
          if (m.type === 'AssignmentExpression' && m.left.type === 'Identifier' && !names.has(m.left.name) && tainted(m.right, names, strict)) {
            names.add(m.left.name);
            grew = true;
          }
          childrenOf(m).forEach(walk);
        };
        walk(n.body);
      }
      const tryNode = stack[stack.length - 1];
      const sinkWalk = (m, inner) => {
        if (isConsoleCall(m)) return;
        const record = (e) => {
          const key = `${e.start}:${e.end}`;
          if (seen.has(key)) return;
          seen.add(key);
          const ifs = inner.filter((a) => a.type === 'IfStatement');
          const guard = ifs.length ? text(ifs[ifs.length - 1].test) : `try ${text(tryNode.block).replace(/\s+/g, ' ')}`;
          hits.push({ file, line: e.loc.start.line, fn: fnName([...stack, ...inner]), expr: text(e), guard });
        };
        // A nested object is reported at its own leaf property, so one leak is one hit.
        const leaf = (e) => {
          if (!e || e.type === 'ObjectExpression' || !tainted(e, names, strict)) return;
          if (e.type === 'ArrayExpression') e.elements.forEach(leaf);
          else record(e);
        };
        if (m.type === 'ObjectExpression') for (const p of m.properties) leaf(p.type === 'SpreadElement' ? p : p.value);
        if (m.type === 'CallExpression' && m.callee.type === 'Identifier' && SINK_CALLS.has(m.callee.name)) m.arguments.forEach(leaf);
        for (const c of childrenOf(m)) sinkWalk(c, [...inner, m]);
      };
      sinkWalk(n.body, [n]);
    }
    for (const c of childrenOf(n)) visit(c, [...stack, n]);
  };
  visit(parse(src), []);
  return hits;
}

// Non-DB texts a reply may carry, each pinned by its guard and its exact count (C5): a second copy reds.
const ALLOWLIST = [
  // Graph API text, under the GraphError branch.
  { file: 'lambda/facebook-share/index.js', fn: 'handler', expr: 'err.graph.message', guard: 'err instanceof GraphError', count: 1 },
  // The handler's own sentence on an error it marked userFacing.
  { file: 'lambda/facebook-share/index.js', fn: 'handler', expr: 'err.message', guard: 'err?.userFacing', count: 1 },
  // parseSections' validation sentence; nothing else runs in that try.
  { file: 'lambda/harvests/season-stats.js', fn: 'handleSeasonStatsGet', expr: 'e.message', guard: 'try { sections = parseSections(query.sections); }', count: 1 },
];

// Calls whose arguments carry the caught error and whose result reaches a reply. The scan cannot see inside them,
// so each is listed with its count and why it returns no error text; a new one reds until it is read.
const CALL_BOUNDARY = [
  // The kit hands the handler's onSecretsError key names only; photos and projects answer fixed text.
  { files: /^lambda\/[a-z-]+\/request-context\.js$/, fn: 'requestContext', expr: 'onSecretsError(err, { missing: null, keys: null })', count: 23 },
  // dbErrorReply: the table above, executed per adopter.
  { files: /^lambda\/[a-z-]+\/index\.js$/, fn: 'handler', expr: 'db.body', count: 10 },
  // Constant lookups by constraint name; executed in the preservation mapped rows.
  { files: /^lambda\/preservation\/index\.js$/, fn: 'handler', expr: 'kitchenMsg', count: 1 },
  { files: /^lambda\/preservation\/index\.js$/, fn: 'handler', expr: 'jarMsg', count: 1 },
  { files: /^lambda\/preservation\/index\.js$/, fn: 'handler', expr: 'sourceMsg', count: 1 },
  // Fixed sentences keyed on the unique index (blend.js RESTORE_CONFLICT_MESSAGES; blend-route.test.js).
  { files: /^lambda\/varieties\/index\.js$/, fn: 'handler', expr: 'restoreConflictMessage(err)', count: 1 },
  // settle(err) re-reads the row a concurrent create landed; the reply is that row.
  { files: /^lambda\/varieties\/blend\.js$/, fn: 'blendRoute', expr: 'withRow(row, false)', count: 2 },
];

const URL_FILES = lambdaFiles(join(here, '..')).filter((f) => URL_DIRS.includes(f.split('/')[1]) && f.split('/').length > 2);
const scanned = URL_FILES.map((f) => ({ f, src: readFileSync(join(here, '..', f), 'utf8') }));
const tally = (hits, keyOf) => hits.reduce((m, h) => m.set(keyOf(h), (m.get(keyOf(h)) ?? 0) + 1), new Map());

describe('SEC-20 static row: no reply in a URL dir carries a caught error\'s text', () => {
  const hits = scanned.flatMap(({ f, src }) => catchLeaks(f, src));
  const strictOnly = scanned.flatMap(({ f, src }) => {
    const flow = new Set(catchLeaks(f, src).map((h) => `${h.line}:${h.expr}`));
    return catchLeaks(f, src, { strict: true }).filter((h) => !flow.has(`${h.line}:${h.expr}`));
  });

  it('walks every URL dir, and every adopter has a catch', () => {
    expect(new Set(URL_FILES.map((f) => f.split('/')[1])).size).toBe(URL_DIRS.length);
    expect(URL_DIRS.length).toBeGreaterThanOrEqual(23);
    const catches = (n) => (n.type === 'CatchClause' ? 1 : 0) + childrenOf(n).reduce((sum, c) => sum + catches(c), 0);
    for (const dir of ADOPTERS) expect(catches(parse(read(`${dir}/index.js`))), dir).toBeGreaterThan(0);
  });

  it('every hit is an allowlisted non-DB text, at its guard and its exact count, and no entry is stale', () => {
    const got = tally(hits, (h) => JSON.stringify([h.file, h.fn, h.expr, h.guard]));
    const want = new Map(ALLOWLIST.map((a) => [JSON.stringify([a.file, a.fn, a.expr, a.guard]), a.count]));
    const extra = hits.filter((h) => !want.has(JSON.stringify([h.file, h.fn, h.expr, h.guard])));
    expect(extra.map((h) => `${h.file}:${h.line} [${h.fn}] ${h.expr}`), 'a reply carries a caught error').toEqual([]);
    expect(Object.fromEntries(got)).toEqual(Object.fromEntries(want));
  });

  it('every call that hands the caught error to a reply is on the boundary list, at its exact count', () => {
    const counts = CALL_BOUNDARY.map((b) => strictOnly.filter((h) => b.files.test(h.file) && h.fn === b.fn && h.expr === b.expr).length);
    const unlisted = strictOnly.filter((h) => !CALL_BOUNDARY.some((b) => b.files.test(h.file) && h.fn === b.fn && h.expr === b.expr));
    expect(unlisted.map((h) => `${h.file}:${h.line} [${h.fn}] ${h.expr}`), 'a new call carries the error into a reply').toEqual([]);
    expect(counts).toEqual(CALL_BOUNDARY.map((b) => b.count));
  });

  it('every URL dir that answers a database error is an adopter', () => {
    expect(ADOPTERS).toEqual(COPY_DIRS);
  });
});

describe('the detector finds what it must, and nothing it must not', () => {
  const wrap = (body) => `function f() {\n  try { x(); } catch (err) {\n    ${body}\n  }\n}\n`;
  const found = (src) => catchLeaks('planted.js', src).length;
  const FOUND = {
    'a direct member': wrap('return resp(400, { error: err.message });'),
    'a member alias': wrap('const m = err?.message; return resp(400, { detail: m });'),
    'a push': wrap('failures.push({ id, error: err?.message });'),
    'a derived alias (merge.js)': wrap("const msg = err?.message ?? String(err); if (/x/.test(msg)) return { status: 422, body: { error: 'x', detail: msg } };"),
    'the bare error': wrap('return resp(500, { error: err });'),
    'a spread error': wrap('return resp(500, { ...err });'),
    'JSON.stringify': wrap('return resp(500, { error: JSON.stringify(err) });'),
    'toString': wrap('return resp(500, { error: err.toString() });'),
    'concatenation': wrap("return resp(500, { error: '' + err });"),
    'a template': wrap('return resp(400, { error: `Constraint violation: ${err.constraint}` });'),
    'a destructured field': wrap('const { message } = err; return resp(400, { error: message });'),
    'a destructured catch param': 'function f() { try { x(); } catch ({ detail }) { return resp(400, { error: detail }); } }',
    'stack': wrap('return resp(500, { trace: err.stack });'),
    'internalQuery, sourceError, cause and dataType': wrap('return resp(500, { a: err.internalQuery, b: err.sourceError, c: err.cause, d: err.dataType });'),
    'a resp argument': wrap('return resp(500, err.message);'),
    'a nested body': wrap("return { status: 409, body: { error: 'x', detail: err.detail } };"),
    'an array element': wrap('return resp(400, { errors: [err.message] });'),
    'an alias of an alias': wrap('const a = err; const b = a.detail; return resp(400, { error: b });'),
    'an assignment': `let m;\n${wrap('m = err.message; return resp(400, { error: m });')}`,
  };
  for (const [name, src] of Object.entries(FOUND)) {
    it(`finds ${name}`, () => expect(found(src)).toBeGreaterThan(0));
  }
  it('counts the four fields of one reply as four hits', () => {
    expect(found(FOUND['internalQuery, sourceError, cause and dataType'])).toBe(4);
  });

  const CLEAN = {
    'a console line': wrap("console.error(JSON.stringify({ error: err.message })); return resp(500, { error: 'Internal server error' });"),
    'a commented-out line': wrap("// return resp(400, { error: err.message });\n    return resp(500, { error: 'Internal server error' });"),
    'the code': wrap("return resp(409, { error: 'Unique violation', code: err.code });"),
    'a lookup keyed on the constraint': wrap('if (Object.hasOwn(MAP, err.constraint)) return resp(400, { error: MAP[err.constraint] });'),
    'a comparison': wrap("return resp(400, { error: 'x', retry: err.code === '40P01' });"),
  };
  for (const [name, src] of Object.entries(CLEAN)) {
    it(`passes ${name}`, () => expect(found(src)).toBe(0));
  }

  it('holds a helper that receives the error for the boundary list, not as a pass', () => {
    const src = wrap('return resp(400, { error: describe(err) });');
    expect(found(src)).toBe(0);
    expect(catchLeaks('planted.js', src, { strict: true }).map((h) => h.expr)).toEqual(['describe(err)']);
  });
});
