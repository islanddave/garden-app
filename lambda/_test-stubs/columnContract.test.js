// new-file: new subject, lambda/_test-stubs/columnContract.js
// Pins the shared contract scanner to the inline copy the keyed column contracts carried, on every
// directory and relation they declare, and pins ownContract to the auditor's two regexes.
// Trap: a fixture alone cannot show the helper sees what the old copies saw; the corpus case does.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decommentSqlDashBare, decommentSqlDashSpace } from './handlerSource.js';
import { handlersIn, ownContract, tableReads } from './columnContract.js';

const LAMBDA = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = mkdtempSync(join(tmpdir(), 'column-contract-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const write = (name, text) => {
  writeFileSync(join(DIR, name), text);
  return join(DIR, name);
};

write('a.js', [
  'export const list = (sql) => sql`SELECT c.id, c.name FROM public.container c WHERE c.deleted_at IS NULL`;',
  'export const one = (sql) => sql`SELECT * FROM container WHERE id = 1`;',
  'export const other = (sql) => sql`SELECT o.id FROM other o WHERE o.id IS DISTINCT FROM container`;',
  '// export const gone = (sql) => sql`SELECT z.title FROM container z`;',
  'export const sep = (sql) => sql`SELECT k.id FROM container AS k',
  '--',
  'WHERE k.archived_at IS NULL`;',
  'export const write = (sql) => sql`UPDATE container SET display_name = 1`;',
].join('\n'));
write('a.test.js', 'export const t = (sql) => sql`SELECT t.secret FROM container t`;');
write('b.mjs', 'export const m = (sql) => sql`SELECT m.secret FROM container m`;');

describe('tableReads', () => {
  const reads = tableReads(DIR, 'container');

  it('scans every non-test .js in the directory, sorted', () => {
    expect(handlersIn(DIR)).toEqual(['a.js']);
    expect(reads.handlers).toEqual(['a.js']);
  });

  it('keeps the sql statements that bind the table, decommented, with IS DISTINCT FROM scrubbed', () => {
    expect(reads.statements.map((s) => s.sql)).toEqual([
      'SELECT c.id, c.name FROM public.container c WHERE c.deleted_at IS NULL',
      'SELECT * FROM container WHERE id = 1',
      'SELECT k.id FROM container AS k\n\nWHERE k.archived_at IS NULL',
    ]);
    expect(reads.statements.every((s) => s.file === 'a.js')).toBe(true);
  });

  it('collects aliases, counts the unaliased bindings, and reads columns through aliases only', () => {
    expect(reads.aliases).toEqual(['c', 'k']);
    expect(reads.unaliased).toBe(1);
    expect(reads.referenced()).toEqual(['archived_at', 'deleted_at', 'id', 'name']);
    expect(reads.referenced([{ columns: ['zeta', 'id'] }])).toEqual(['archived_at', 'deleted_at', 'id', 'name', 'zeta']);
  });

  it('reports each alias that reads a column, and nothing for a column no statement reads', () => {
    expect(reads.refsTo('name')).toEqual(['a.js: c.name is not a container column']);
    expect(reads.refsTo('title')).toEqual([]);
  });

  it('reads a directory file decommented, as the statements were', () => {
    expect(reads.source('a.js')).toContain('SELECT * FROM container WHERE id = 1');
    expect(reads.source('a.js')).not.toContain('SELECT z.title');
    expect(reads.source('b.mjs')).toContain('SELECT m.secret');
  });

  it('holds a pin only while it matches the decommented file', () => {
    expect(reads.pinHolds({ file: 'a.js', pin: /SELECT \* FROM container WHERE id = 1/ })).toBe(true);
    expect(reads.pinHolds({ file: 'a.js', pin: /SELECT z\.title FROM container z/ })).toBe(false);
  });

  it('binds UPDATE only when the verbs say so, and then counts it unaliased', () => {
    const withUpdate = tableReads(DIR, 'container', { verbs: 'FROM|JOIN|UPDATE' });
    expect(withUpdate.statements).toHaveLength(4);
    expect(withUpdate.unaliased).toBe(2);
  });

  it('decomments with the variant passed in: V1 keeps the bare `--` line V2 strips', () => {
    const v1 = tableReads(DIR, 'container', { decomment: decommentSqlDashSpace });
    expect(v1.statements[2].sql).toBe('SELECT k.id FROM container AS k\n--\nWHERE k.archived_at IS NULL');
  });

  it('takes a contract URL for its directory, and an explicit handler list', () => {
    const url = pathToFileURL(join(DIR, 'x-columns.test.js')).href;
    expect(tableReads(url, 'container').statements).toEqual(reads.statements);
    expect(tableReads(DIR, 'container', { handlers: ['b.mjs'] }).aliases).toEqual(['m']);
  });
});

describe('ownContract', () => {
  it('returns each key and its columns in source order', () => {
    const file = write('two-columns.test.js', [
      'const AUDIT_COLUMNS = {',
      "  container: ['id', 'display_name'],",
      '  "garden_node": ["id"],',
      '};',
      'const LATER = { a: 1 };',
    ].join('\n'));
    expect(ownContract(pathToFileURL(file).href)).toEqual([['container', ['id', 'display_name']], ['garden_node', ['id']]]);
  });

  it('returns null when there is no keyed declaration', () => {
    const file = write('none-columns.test.js', "const OTHER = { container: ['id'] };\n");
    expect(ownContract(pathToFileURL(file).href)).toBeNull();
  });
});

// The inline copy every keyed contract carried, verbatim apart from the table name, as the oracle.
const inlineReads = (dir, table) => {
  const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
  const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;
  const bindings = (s) => [...s.matchAll(new RegExp(
    String.raw`\b(?:FROM|JOIN)\s+(?:public\.)?${table}\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?`, 'gi',
  ))].map((m) => (m[1] ?? '').toLowerCase());
  const NOT_AN_ALIAS = new Set([
    'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
    'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
    'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
  ]);
  const aliasesOf = (s) => [...new Set(bindings(s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
  const unaliasedIn = (s) => bindings(s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;
  const columnsOf = (s) => [...new Set(aliasesOf(s).flatMap((a) => [...s.matchAll(
    new RegExp(String.raw`\b${a}\.([a-z_][a-z0-9_]*)\b`, 'gi'),
  )].map((m) => m[1].toLowerCase())))];
  const HANDLERS = readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
    .sort();
  const STATEMENTS = HANDLERS.flatMap((f) => {
    const src = decommentSqlDashBare(readFileSync(resolve(dir, f), 'utf8'));
    return [...src.matchAll(SQL_TEMPLATE)]
      .map((m) => m[1].replace(DISTINCT_FROM, ' '))
      .filter((s) => bindings(s).length > 0)
      .map((sql) => ({ file: f, sql }));
  });
  return {
    STATEMENTS,
    aliases: [...new Set(STATEMENTS.flatMap((s) => aliasesOf(s.sql)))].sort(),
    bare: STATEMENTS.reduce((n, s) => n + unaliasedIn(s.sql), 0),
    columns: STATEMENTS.map((s) => columnsOf(s.sql)),
  };
};

// Every (directory, relation) a non-household keyed contract declares.
const CORPUS = readdirSync(LAMBDA, { recursive: true })
  .filter((f) => f.endsWith('columns.test.js') && !f.includes('node_modules') && !f.endsWith('household-columns.test.js'))
  .flatMap((f) => {
    const decl = readFileSync(join(LAMBDA, f), 'utf8').match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
    if (!decl) return [];
    return [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[/g)].map((m) => [dirname(join(LAMBDA, f)), m[1]]);
  });

describe('tableReads on the real contracts', () => {
  it('finds the declared relations, so the comparison below is not vacuous', () => {
    expect(CORPUS.length).toBeGreaterThan(100);
  });

  it('matches the inline copy on every directory and relation a keyed contract declares', () => {
    let statements = 0;
    for (const [dir, table] of CORPUS) {
      const want = inlineReads(dir, table);
      const got = tableReads(dir, table);
      const where = `${dir.slice(LAMBDA.length)} ${table}`;
      expect(got.statements, where).toEqual(want.STATEMENTS);
      expect(got.aliases, where).toEqual(want.aliases);
      expect(got.unaliased, where).toBe(want.bare);
      expect(got.statements.map((s) => got.columnsOf(s.sql)), where).toEqual(want.columns);
      statements += want.STATEMENTS.length;
    }
    expect(statements).toBeGreaterThan(500);
  });
});
