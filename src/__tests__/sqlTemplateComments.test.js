// src/__tests__/sqlTemplateComments.test.js
//
// A JS line comment inside a SQL template literal becomes PART OF THE QUERY.
//
// Written after doing exactly that, 2026-08-28. A comment explaining a fixture was placed between
// the INSERT and VALUES lines of a `directSql` tagged template in cascade-sweep.int.test.js. A
// tagged template is a STRING, not code, so `//` went to Postgres, which has no such comment marker:
//   NeonDbError: syntax error at or near "//"
// The change that shipped was more broken than the bug it fixed, and nothing caught it locally —
// the unit suite does not execute integration SQL, so the first signal was a red CI run minutes
// later. This is the guard that turns a 20-minute round trip into an instant one.
//
// SQL's own line-comment marker is `--`, and that is what belongs inside a query if a comment must
// sit inline at all. Prose about WHY belongs above the statement, outside the backticks.
//
// Scope note: this scans for `//` only. A `/* */` block comment is legal SQL and is left alone.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOTS = ['lambda', 'src', 'tests', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '__snapshots__'])

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(js|jsx|mjs)$/.test(e)) out.push(p)
  }
  return out
}

// A tagged template whose body looks like SQL. Anchored on the tag (`sql`, `directSql`, `db.query`)
// followed by a backtick, so a plain string containing the word SELECT is not a candidate.
const TAGGED_SQL = /\b[\w.]*(?:sql|Sql|SQL|query|Query)`([^`]*)`/g
// The body must OPEN with a SQL verb, not merely contain one. Requiring only "contains" matched a
// tag-shaped token followed by any later backtick and swept up whole file-header comment blocks in
// between — 19 false positives on the first run, every one of them ordinary prose. A real query in
// this codebase starts with its verb after the newline.
const LOOKS_LIKE_SQL = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH|TRUNCATE)\b/i

describe('no JS line comment inside a SQL template literal', () => {
  it('every tagged SQL template is free of `//`', () => {
    const offenders = []
    for (const root of ROOTS) {
      for (const file of walk(resolve(process.cwd(), root))) {
        const src = readFileSync(file, 'utf8')
        for (const m of src.matchAll(TAGGED_SQL)) {
          const body = m[1]
          if (!LOOKS_LIKE_SQL.test(body)) continue
          // Only a line that STARTS with // — a `//` inside a string literal or a URL such as
          // https://… is not a comment and must not be flagged.
          const bad = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('//'))
          if (bad.length) {
            const line = src.slice(0, m.index).split('\n').length
            offenders.push(`${file.replace(process.cwd() + '/', '')}:${line} → ${bad[0].slice(0, 60)}`)
          }
        }
      }
    }
    expect(offenders, `JS comments inside SQL templates reach Postgres verbatim:\n${offenders.join('\n')}`)
      .toEqual([])
  })

  // Guards the guard. If the scan stops finding tagged SQL at all — a rename, a walk that silently
  // returns nothing, a regex that stops matching — the assertion above passes vacuously on zero
  // candidates and reports a clean bill of health for a check that ran on nothing.
  it('actually finds SQL templates to scan', () => {
    let candidates = 0
    for (const root of ROOTS) {
      for (const file of walk(resolve(process.cwd(), root))) {
        for (const m of readFileSync(file, 'utf8').matchAll(TAGGED_SQL)) {
          if (LOOKS_LIKE_SQL.test(m[1])) candidates++
        }
      }
    }
    expect(candidates, 'the scan found no SQL templates — it is checking nothing').toBeGreaterThan(50)
  })
})
