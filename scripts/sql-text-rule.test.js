// The scripts/** SQL text rule (V5-SPACEISOLATION-001, multi-space plan V204 step 2.0a, §2.4, QA-29).
//
// WHY THIS EXISTS. The SQL census (tests/lib/sqlCensus.mjs) parses the SQL of lambda/** only. scripts/** holds
// SQL too, written by one-off runners, backfills and seed generators, in JS templates, Python strings, shell and
// .sql files, and some of it writes to tables that become Space-owned. A script that inserts into such a table
// without naming workspace_id lands every row in whatever the column DEFAULT says, which is the wrong Space as
// soon as there are two. Those files are too varied to parse, so the rule here is textual, and named.
//
// THE RULE. In every tracked non-test text file under scripts/ (scripts/repo-constants-scan.mjs walk + isTestPath,
// plus this repo's hyphenated `test-*.py` test files), every `INSERT INTO <table>` must name `workspace_id` in its
// column list, unless the table is exempt by class (EXEMPT_TABLES, each with its reason) or the (file, table) pair
// is on ALLOWED (each with a reason; it only shrinks, and a stale pair fails). An INSERT with no column list
// (`INSERT INTO t SELECT …` / `VALUES …`) cannot show the column and fails the same way. Whole-line comments
// (`#`, `//`, `--`, `*`) never count; prose such as "INSERT into a column" does not match, since a table name must
// be followed by `(` or by SELECT / VALUES / DEFAULT / OVERRIDING / WITH / TABLE.
//
// WHAT IT COVERS at 2f238983: 164 non-test text files under scripts/, holding 4 INSERTs: into tag (two COW runner
// scripts, ALLOWED), public.schema_version (cal1/gen-refweight-seed.mjs, exempt) and weather_daily
// (backfill-weather-daily.mjs, exempt). UPDATE and DELETE are not covered:
// a scripts-side write that changes a row's Space is not a shape that exists today, and the scope of those
// statements is 5.1's question for lambda/**. Positive control below: a fixture script with `insert into photos (`
// and no workspace_id reds.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, walk, isTestPath } from './repo-constants-scan.mjs'

// Tables whose class means a script never stamps a Space on them.
const EXEMPT_TABLES = {
  schema_version: 'system: migration stamps, no tenant',
  weather_daily: 'already keyed by the Space itself (space_id); the plot tier re-keys it (V204 §2.2)',
}

// (file, table) pairs that insert into a Space-owned table without workspace_id today. Shrink only.
const ALLOWED = [
  { file: 'scripts/_tagsub_cow_runner.mjs', table: 'tag', reason: 'one-off COW-branch runner of the tag-subscription rehearsal, written before tag has a workspace_id (2.1)' },
  { file: 'scripts/_tagsub_cow_runner2.mjs', table: 'tag', reason: 'one-off COW-branch runner of the tag-subscription rehearsal, written before tag has a workspace_id (2.1)' },
]

const isScriptTest = (rel) => isTestPath(rel) || /(^|\/)test-[^/]*\.py$/.test(rel)
const INSERT = /\binsert\s+into\s+((?:"?[A-Za-z_][\w$]*"?\s*\.\s*)?"?[A-Za-z_][\w$]*"?)\s*/gi
const BODY_LEAD = /^(\(|select\b|values\b|default\b|overriding\b|with\b|table\b)/i
const COMMENT_LINE = /^\s*(#|\/\/|--|\*|\/\*)/

// Every INSERT INTO in one file: [{file, line, table, cols}], cols null when there is no column list.
export function insertsIn(file, text) {
  const out = []
  for (const m of text.matchAll(INSERT)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1
    if (COMMENT_LINE.test(text.slice(lineStart, m.index))) continue
    const after = text.slice(m.index + m[0].length)
    if (!BODY_LEAD.test(after)) continue
    let cols = null
    if (after[0] === '(') {
      let depth = 0
      let i = 0
      for (; i < after.length; i++) {
        if (after[i] === '(') depth++
        else if (after[i] === ')' && --depth === 0) break
      }
      cols = after.slice(1, i)
    }
    const table = m[1].replace(/"/g, '').replace(/\s+/g, '').toLowerCase().replace(/^public\./, '')
    out.push({ file, line: text.slice(0, m.index).split('\n').length, table, cols })
  }
  return out
}

// The rule over a set of {file, text}: returns the violations and the stale ALLOWED pairs.
export function textRule(files, allowed = ALLOWED) {
  const found = files.flatMap(({ file, text }) => insertsIn(file, text))
  const open = found.filter((x) => !EXEMPT_TABLES[x.table] && !(x.cols && /\bworkspace_id\b/i.test(x.cols)))
  const isAllowed = (x) => allowed.some((a) => a.file === x.file && a.table === x.table)
  return {
    found,
    violations: open.filter((x) => !isAllowed(x)),
    stale: allowed.filter((a) => !open.some((x) => x.file === a.file && x.table === a.table)),
  }
}

const scriptFiles = () => walk(['scripts']).filter((rel) => !isScriptTest(rel)).map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }))

describe('scripts/** SQL text rule: INSERT INTO names workspace_id', () => {
  it('holds over every non-test file under scripts/', () => {
    const { found, violations, stale } = textRule(scriptFiles())
    const lines = [
      ...violations.map((v) => `${v.file}:${v.line} INSERT INTO ${v.table} ${v.cols == null ? 'has no column list' : 'does not name workspace_id'}: stamp the Space, or list the pair with a reason`),
      ...stale.map((a) => `stale ALLOWED pair (that INSERT is gone or names workspace_id now): ${a.file} ${a.table}`),
    ]
    expect(lines, lines.join('\n')).toEqual([])
    expect(found.length, 'the rule found no INSERT under scripts/: the walk or the pattern is broken').toBeGreaterThan(2)
    for (const a of ALLOWED) expect(a.reason.trim()).not.toBe('')
  })

  it('reds a fixture script with `insert into photos (` and no workspace_id (positive control)', () => {
    const fixture = (text) => textRule([{ file: 'scripts/zz-fixture.mjs', text }], [])
    const bad = fixture('await sql`\n  insert into photos (url, created_by)\n  values (${url}, ${me})`\n')
    expect(bad.violations.map((v) => [v.file, v.line, v.table])).toEqual([['scripts/zz-fixture.mjs', 2, 'photos']])
    expect(fixture('INSERT INTO public."photos"\n  (workspace_id, url) VALUES ($1, $2)').violations).toEqual([])
    expect(fixture("cur.execute('INSERT INTO photos SELECT * FROM staging_photos')").violations.map((v) => v.cols)).toEqual([null])
    expect(fixture('# insert into photos (url) values (1)\n-- insert into photos (url)\n').violations).toEqual([])
    expect(fixture('every column named in an INSERT into a column list').violations).toEqual([])
    expect(fixture('INSERT INTO schema_version (version) VALUES (1)').violations).toEqual([])
  })
})
