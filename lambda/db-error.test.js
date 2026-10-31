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
import { DB_ERROR_REPLIES, dbErrorReply, logCaughtError } from './db-error.js';
import { SEED_CONSTRAINT_MESSAGES } from './inventory-items/index.js';
import { CONSTRAINT_MESSAGES as VARIETY_MESSAGES } from './varieties/validate.js';

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
