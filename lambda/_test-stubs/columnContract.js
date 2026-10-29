// Scanning machinery for the keyed column contracts (lambda/**/*columns.test.js declaring
// `const AUDIT_COLUMNS = {...};`). Trap: the AUDIT_COLUMNS literal, each *_COLUMNS array and every
// assertion stay in the contract file. Phase 4 credits a contract only to its own directory and only
// from that file's own text (parse_test_file reads the file, then regex), so a contract assembled here
// would be invisible to it. Guarded by ./columnContract.test.js, which pins this to the inline copy it replaced.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decommentSqlDashBare } from './handlerSource.js';

// Extraction mirrors parse_sql_relations in scripts/dev-main-schema-audit.py, so a contract sees the
// statements Phase 4 credits. Only SQL inside a tagged sql template literal counts.
export const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;
// `IS [NOT] DISTINCT FROM x.col` contains the token FROM. Scrub it before scanning, or the operator's
// right-hand alias is captured as a relation (the auditor's _DISTINCT_FROM).
export const DISTINCT_FROM = /\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi;

export const NOT_AN_ALIAS = new Set([
  'on', 'where', 'using', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'union', 'except', 'intersect', 'set', 'and',
  'or', 'not', 'as', 'select', 'from', 'with', 'values', 'for', 'window', 'returning', 'when',
]);

// Every non-test .js in a directory, sorted: the set Phase 4 groups together. Read from disk, so a
// handler added there is covered the day it lands rather than when someone extends a list.
export const handlersIn = (dir) => readdirSync(dir)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

const dirOf = (where) => (where.startsWith('file:') ? dirname(fileURLToPath(where)) : where);

// The statements in `where`'s handlers that bind `table`, and what they read from it. `where` is a
// contract's import.meta.url or a directory. A contract that carried a V1 decomment passes
// decommentSqlDashSpace so it keeps seeing the same text; `verbs` widens the binding keywords
// (e.g. 'FROM|JOIN|UPDATE').
export function tableReads(where, table, { decomment = decommentSqlDashBare, verbs = 'FROM|JOIN', handlers } = {}) {
  const dir = dirOf(where);
  const files = handlers ?? handlersIn(dir);
  const read = (f) => decomment(readFileSync(resolve(dir, f), 'utf8'));
  // A fresh RegExp per call, so no lastIndex leaks between calls. The alias group is optional: an
  // unaliased `FROM public.<table> WHERE ...` captures the next keyword, which NOT_AN_ALIAS rejects and
  // the contract's UNALIASED_ARMS then has to account for by hand.
  const binding = String.raw`\b(?:${verbs})\s+(?:public\.)?${table}\b(?!\s*\.)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)?`;
  const bindings = (s) => [...s.matchAll(new RegExp(binding, 'gi'))].map((m) => (m[1] ?? '').toLowerCase());
  const aliasesOf = (s) => [...new Set(bindings(s).filter((b) => b && !NOT_AN_ALIAS.has(b)))].sort();
  const unaliasedIn = (s) => bindings(s).filter((b) => !b || NOT_AN_ALIAS.has(b)).length;
  // Scoped to statements that bind the table, so an `x.col` from some other query in the same file is
  // never read as this table's.
  const columnsOf = (s) => [...new Set(aliasesOf(s).flatMap((a) => [...s.matchAll(
    new RegExp(String.raw`\b${a}\.([a-z_][a-z0-9_]*)\b`, 'gi'),
  )].map((m) => m[1].toLowerCase())))];
  const statements = files.flatMap((f) => [...read(f).matchAll(SQL_TEMPLATE)]
    .map((m) => m[1].replace(DISTINCT_FROM, ' '))
    .filter((s) => bindings(s).length > 0)
    .map((sql) => ({ file: f, sql })));
  return {
    handlers: files,
    statements,
    bindings,
    aliasesOf,
    unaliasedIn,
    columnsOf,
    aliases: [...new Set(statements.flatMap((s) => aliasesOf(s.sql)))].sort(),
    // Bindings with no alias. Nothing can attribute their bare identifiers, so the contract pins each one.
    unaliased: statements.reduce((n, s) => n + unaliasedIn(s.sql), 0),
    // An unaliased arm `{ file, pin, columns }` holds while its pin still matches the decommented file.
    pinHolds: (arm) => arm.pin.test(read(arm.file)),
    // Every column read through an alias, plus the hand-listed columns of the unaliased arms, sorted.
    referenced: (arms = []) => [...new Set([
      ...statements.flatMap((s) => columnsOf(s.sql)),
      ...arms.flatMap((a) => a.columns),
    ])].sort(),
    // One line per statement alias that reads `col`; empty when none does.
    refsTo: (col) => statements.flatMap(({ file, sql }) => aliasesOf(sql)
      .filter((a) => new RegExp(String.raw`\b${a}\.${col}\b`, 'i').test(sql))
      .map((a) => `${file}: ${a}.${col} is not a ${table} column`)),
  };
}

// The auditor's _AUDIT_COLUMNS_DECL and _AUDIT_COLUMNS_PAIR run on the contract's own text:
// [[key, [columns]], ...] in source order, or null when the declaration does not match. Without its
// terminating `};` the lazy match runs on to a later one; scripts/test_schema_audit_gate.py checks
// every real contract for that.
export function ownContract(url) {
  const decl = readFileSync(fileURLToPath(url), 'utf8').match(/const\s+AUDIT_COLUMNS\s*=\s*\{([\s\S]*?)\};/);
  if (!decl) return null;
  return [...decl[1].matchAll(/['"]?([a-zA-Z_]\w*)['"]?\s*:\s*\[([^\]]*)\]/g)]
    .map(([, key, body]) => [key, [...body.matchAll(/['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)].map((m) => m[1])]);
}
