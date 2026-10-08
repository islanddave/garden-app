// BUG-SEEDSTAGEHEADSHIP-001 — inventory_items.seed_stage has ONE writer, and the count is asserted
// (DECISION-V100 section 8, M11: "The invariant is 'N writers', asserted, not narrated. A new writer
// must red the build.").
//
// THE DEFECT. The column is a cache of the newest entry in seed_lot_stage_log, and three statements
// used to assign it: the POST /:id/seed-stage CTE (which appends the entry in the same statement),
// the wide PUT /:id and the create INSERT (which appended nothing). A stage written by either of the
// last two had no entry to count from, so the list's stage_entered_at LATERAL returned NULL or an
// older entry's date: "N days in drying" went blank or wrong, and a fermenting lot got no overdue
// warning. Every caller of the wide PUT round-trips a list row, so a stale tab could do it with a 200.
//
// THE RULE NOW. POST /:id/seed-stage is the only statement in lambda/ that assigns the column, and
// it is the same statement that inserts the log entry. The wide PUT and the create IGNORE a
// `seed_stage` key (not a 400: installed bundles still send it) and answer with the lot's real stage.
//
// TWO HALVES, because either alone is satisfiable by a wrong build:
//   • STATIC, over every non-test module under lambda/ (the list is read from the directory, so a
//     new file is covered the day it lands): how many statements assign the column, and which one.
//   • DRIVEN through the handler: a body carrying the key produces SQL that neither names the column
//     nor binds the value, and the reply still reports the stored stage.
//
// THE STUB EXECUTES NO SQL. What is NOT shown here: that a real row's stage and log are unchanged
// after such a PUT, and that a created lot's stage is NULL. Those are
// tests/integration/seed-lifecycle.int.test.js, on the integration lane, which gates nothing
// (DECISION-V100: "An invariant living only on the integration lane gates nothing"). This file is on
// the unit lane and is the one that gates.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubState, resetStubs } from '../_test-stubs/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAMBDA = resolve(__dirname, '..');
const { handler } = await import('./index.js');

// A construct NAMED IN A COMMENT is not that construct: the notes in index.js that explain the two
// omissions name the column, and must neither satisfy nor break this.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(entry) && !/\.(test|spec)\.(js|mjs|cjs)$/.test(entry)) out.push(p);
  }
  return out;
}

const MODULES = walk(LAMBDA).sort().map((p) => ({
  file: relative(LAMBDA, p).split(sep).join('/'),
  src: decomment(readFileSync(p, 'utf8')).replace(/\s+/g, ' '),
}));

// THE THREE FORMS A WRITE CAN TAKE.
//   SET     `seed_stage = …` with the column BARE. Postgres refuses a table-qualified SET target, so
//           an assignment is always bare; every comparison in this tree is written on an alias
//           (`i.seed_stage = 'drying'`, `sl.stage = i.seed_stage`) and is not matched. A bare
//           comparison added later reds this file, which is the safe direction: qualify it.
//   TUPLE   `SET (a, seed_stage) = (…)`.
//   INSERT  the column named in an INSERT INTO inventory_items column list.
const SET_FORM = /(?<![.\w])seed_stage\s*=(?!=)/g;
const TUPLE_FORM = /\bSET\s*\([^)]*\bseed_stage\b[^)]*\)\s*=/gi;
const INSERT_FORM = /INSERT INTO (?:public\.)?inventory_items\b\s*(\([^)]*\))?/gi;

const writersIn = ({ file, src }) => [
  ...[...src.matchAll(SET_FORM)].map(() => `${file}: SET`),
  ...[...src.matchAll(TUPLE_FORM)].map(() => `${file}: TUPLE`),
  ...[...src.matchAll(INSERT_FORM)].filter((m) => /\bseed_stage\b/.test(m[1] ?? '')).map(() => `${file}: INSERT`),
];

const INDEX = MODULES.find((m) => m.file === 'inventory-items/index.js');
const statementsOf = (src) => src.match(/sql`[^`]*`/g) ?? [];

describe('seed_stage has one writer — static, every non-test module under lambda/', () => {
  it('reads the module list from the directory, and it is not empty', () => {
    // Vacuity floors: an enumeration that found nothing would pass every count below.
    expect(MODULES.length).toBeGreaterThan(100);
    for (const f of ['inventory-items/index.js', 'inventory-items/seed-lot-additions.js', 'plants/index.js']) {
      expect(MODULES.map((m) => m.file), f).toContain(f);
    }
    expect(MODULES.some((m) => /\.test\.js$/.test(m.file))).toBe(false);
  });

  it('exactly ONE statement assigns the column, in any of the three forms', () => {
    expect(MODULES.flatMap(writersIn)).toEqual(['inventory-items/index.js: SET']);
  });

  it('the matcher sees each form — a count of one is not a matcher that sees nothing', () => {
    const probe = (src) => writersIn({ file: 'probe.js', src });
    expect(probe('UPDATE inventory_items SET seed_stage = ${x} WHERE id = ${id}')).toEqual(['probe.js: SET']);
    expect(probe('UPDATE inventory_items SET name = ${n}, seed_stage=CASE WHEN ${h} THEN ${x} ELSE seed_stage END'))
      .toEqual(['probe.js: SET']);
    expect(probe('ON CONFLICT (id) DO UPDATE SET seed_stage = EXCLUDED.seed_stage')).toEqual(['probe.js: SET']);
    expect(probe('UPDATE inventory_items SET (seed_process, seed_stage) = (${p}, ${x})')).toEqual(['probe.js: TUPLE']);
    expect(probe('INSERT INTO public.inventory_items (id, name, seed_stage) VALUES (${a}, ${b}, ${c})'))
      .toEqual(['probe.js: INSERT']);
    // Reads are not writes: the three shapes this tree reads it in.
    expect(probe("SELECT i.id FROM inventory_items i WHERE i.seed_stage = 'drying' AND sl.stage = i.seed_stage")).toEqual([]);
    expect(probe("SELECT i.seed_stage, COALESCE(i.seed_stage, '') <> '' AS saved_lot FROM inventory_items i")).toEqual([]);
    expect(probe('INSERT INTO inventory_items (id, name, seed_process) VALUES (${a}, ${b}, ${c})')).toEqual([]);
  });

  it('every INSERT into inventory_items names its columns, so the INSERT form can be read at all', () => {
    // A positional INSERT (no column list) would write the column unseen by the count above.
    const inserts = MODULES.flatMap(({ file, src }) =>
      [...src.matchAll(INSERT_FORM)].map((m) => `${file}: ${m[1] ? 'named' : 'POSITIONAL'}`));
    expect(inserts).toEqual(['inventory-items/index.js: named']);
  });

  it('the files that name the column at all — a new one is a decision made here', () => {
    // The backstop for a write in a form the matcher cannot see (a column map, a built string): it
    // would have to be in one of these four, or it reds this list.
    expect(MODULES.filter((m) => /\bseed_stage\b/.test(m.src)).map((m) => m.file)).toEqual([
      'inventory-items/delete-guard.js',       // the delete guard's saved-lot fact (read)
      'inventory-items/index.js',              // the writer, and the two list LATERALs (read)
      'inventory-items/seed-lot-additions.js', // the open-lots read
      'plants/index.js',                       // a planting's seed lots (read)
    ]);
  });

  it('that one statement is the /seed-stage CTE, and it inserts the log entry for the SAME stage', () => {
    const writing = statementsOf(INDEX.src).filter((s) => writersIn({ file: 'x', src: s }).length > 0);
    expect(writing).toHaveLength(1);
    const [cte] = writing;
    expect(cte).toMatch(/^sql` WITH upd AS \( UPDATE public\.inventory_items SET seed_stage = \$\{body\.stage\}, /);
    // One bound expression feeds both, so the lot's stage and its newest entry cannot differ.
    expect(cte).toContain(
      'INSERT INTO public.seed_lot_stage_log (inventory_item_id, stage, entered_at, note, created_by) '
      + 'SELECT upd.id, ${body.stage}, COALESCE(${enteredAt}::timestamptz, NOW()), ${note}, ${userId} FROM upd',
    );
    // …and it is the ONLY statement under lambda/ that appends to the log: one cache writer, one log
    // writer, one statement.
    const logWrites = MODULES.flatMap(({ file, src }) =>
      (src.match(/INSERT INTO (?:public\.)?seed_lot_stage_log\b/gi) ?? []).map(() => file));
    expect(logWrites).toEqual(['inventory-items/index.js']);
    // It sits in the /seed-stage arm and nowhere else.
    const arm = INDEX.src.slice(
      INDEX.src.indexOf('const seedStageMatch = rawPath.match'),
      INDEX.src.indexOf('const sourcePlantsMatch = rawPath.match'),
    );
    expect(arm).toContain(cte);
    expect(INDEX.src.split(cte)).toHaveLength(2);
  });

  it('the wide PUT and the create do not read the key from the body', () => {
    // `body.stage` is the /seed-stage route's own key. `body.seed_stage` was the other two routes'.
    expect(INDEX.src).not.toMatch(/body\.seed_stage\b/);
    expect(INDEX.src).not.toMatch(/hasOwnProperty\.call\(body, 'seed_stage'\)/);
    expect(INDEX.src).toMatch(/hasOwnProperty\.call\(body, 'seed_process'\)/);
  });
});

describe('seed_stage has one writer — driven through the handler', () => {
  const USER = 'user_stub_owner';
  const ITEM = '2d6df841-b507-4e65-8db0-97c8659df37c';
  const VARIETY = 'd58b5155-0c23-4365-bfad-30549b8ca069';
  const req = (method, path, body) => ({
    requestContext: { http: { method } }, rawPath: path,
    headers: { authorization: 'Bearer stub-token' }, body: JSON.stringify(body),
  });
  const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body || '{}') });
  const sqlOf = (c) => c.text.split('\n').map((l) => l.replace(/(^|\s)--(\s.*)?$/, '$1')).join('\n').replace(/\s+/g, ' ');
  // The value bound to ONE named placeholder (the stub builds text as strings.join('?')).
  const boundAfter = (call, re) => {
    const m = call.text.match(re);
    expect(m, `SQL does not match ${re}`).toBeTruthy();
    const end = m.index + m[0].length;
    expect(call.text[end], `${re} must sit immediately before a binding`).toBe('?');
    return call.values[(call.text.slice(0, end).match(/\?/g) ?? []).length];
  };
  const LOT = { name: 'Cherokee Purple saved 2026', type: 'consumable', category: 'seeds', unit: 'packet', quantity_on_hand: 1, variety_id: VARIETY };
  // What the database holds: the stub answers every statement with the stored row.
  const STORED = { id: ITEM, ...LOT, seed_stage: 'stored', seed_process: 'wet' };
  const theUpdate = () => {
    const found = stubState.sqlCalls.filter((c) => /UPDATE inventory_items SET/.test(c.text));
    expect(found, 'the wide PUT issues exactly one UPDATE').toHaveLength(1);
    return found[0];
  };

  beforeEach(() => {
    resetStubs();
    stubState.verifyTokenResult = { sub: USER };
    stubState.sqlHandler = (text) => (/UPDATE inventory_items SET|INSERT INTO inventory_items/.test(text) ? [STORED] : []);
  });

  // The stale echo (a list row loaded before the lot moved on), the old clear, and a word that was
  // never a stage. All three are ignored the same way; none is refused.
  for (const [label, sent] of [['a stale stage', 'drying'], ['a null (the old clear)', null], ['a word that is no stage', 'sprouted']]) {
    it(`wide PUT carrying ${label}: 200, the UPDATE neither names the column nor binds the value, the reply is the stored stage`, async () => {
      const { status, body } = parse(await handler(req('PUT', `/api/inventory-items/${ITEM}`, { ...LOT, seed_stage: sent, seed_process: 'dry' })));
      expect(status, JSON.stringify(body)).toBe(200);
      const update = theUpdate();
      expect(sqlOf(update)).not.toMatch(/seed_stage/);
      for (const c of stubState.sqlCalls) {
        expect(c.text).not.toMatch(/seed_lot_stage_log/);
        if (sent != null) expect(c.values).not.toContain(sent);
      }
      // Paired positive: this IS the write, and the body WAS read. The sibling key beside it is bound.
      expect(boundAfter(update, /seed_process\s*=\s*CASE\s*WHEN /)).toBe(true);
      expect(boundAfter(update, /seed_process\s*=\s*CASE\s*WHEN \?\s*THEN /)).toBe('dry');
      expect(body.seed_stage).toBe('stored');
    });
  }

  it('wide PUT still refuses a process that is not one — the stage is ignored, the validator is not gone', async () => {
    const { status, body } = parse(await handler(req('PUT', `/api/inventory-items/${ITEM}`, { ...LOT, seed_stage: 'drying', seed_process: 'fermented' })));
    expect(status).toBe(400);
    expect(body.error).toBe('seed_process must be one of wet, dry, fresh');
    expect(stubState.sqlCalls).toHaveLength(0);
  });

  it('create carrying a stage: 201, one INSERT that neither names the column nor binds the value, and no log entry', async () => {
    stubState.sqlHandler = (text) => (/INSERT INTO inventory_items/.test(text) ? [{ ...STORED, seed_stage: null }] : []);
    const { status, body } = parse(await handler(req('POST', '/api/inventory-items', { ...LOT, seed_stage: 'fermenting', seed_process: 'wet' })));
    expect(status, JSON.stringify(body)).toBe(201);
    expect(stubState.sqlCalls).toHaveLength(1);
    const [insert] = stubState.sqlCalls;
    expect(sqlOf(insert)).toMatch(/^\s*INSERT INTO inventory_items \(/);
    expect(sqlOf(insert)).not.toMatch(/seed_stage/);
    expect(insert.text).not.toMatch(/seed_lot_stage_log/);
    expect(insert.values).not.toContain('fermenting');
    // Paired positive: the body was read, and the sibling key is written.
    expect(sqlOf(insert)).toMatch(/\bseed_process, source_plant_id, source_kind,/);
    expect(insert.values).toContain('wet');
    // The reply is the row as the database answered it: no stage.
    expect(body.seed_stage).toBeNull();
  });

  it('POST /:id/seed-stage is the statement the static half found: stage and log entry, one bound value each', async () => {
    stubState.sqlHandler = () => [{ id: 'log-1', inventory_item_id: ITEM, stage: 'stored' }];
    const { status } = parse(await handler(req('POST', `/api/inventory-items/${ITEM}/seed-stage`, { stage: 'stored' })));
    expect(status).toBe(201);
    expect(stubState.sqlCalls).toHaveLength(1);
    const [cte] = stubState.sqlCalls;
    expect(boundAfter(cte, /SET seed_stage = /)).toBe('stored');
    expect(boundAfter(cte, /INSERT INTO public\.seed_lot_stage_log \(inventory_item_id, stage, entered_at, note, created_by\)\s+SELECT upd\.id, /)).toBe('stored');
  });
});
