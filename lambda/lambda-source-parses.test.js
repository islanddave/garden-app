// Every deployable Lambda source file must be valid JavaScript.
//
// WHY THIS EXISTS. At integration-20260812 HEAD, three Lambda entrypoints — lambda/locations/index.js,
// lambda/projects/index.js and lambda/inventory-items/index.js — were NOT PARSEABLE JAVASCRIPT.
// W-HERO (06071ab) added a long SQL comment inside a sql`...` tagged template containing a
// backtick-quoted identifier (`fp.location_id = l.id`). The backtick closed the template literal 100+
// lines early and the remainder of each file became syntax garbage. `node --check` refused all three;
// origin/dev and origin/main parse clean, so the breakage was introduced on the integration branch.
//
// WHY 6978 TESTS DID NOT NOTICE. Nothing imports these three files. Their coverage
// (hero-read-derivation.test.js, set-featured-write-guards.test.js, authz-write-fk.test.js,
// household-isolation.test.js) is readFileSync + regex over the source TEXT — which is perfectly happy
// to match a string inside a file that no JavaScript engine will load. The Vite build compiles src/
// only; lambda/ is shipped by `zip -r` with nothing in between. So there was no step anywhere between
// the editor and the AWS runtime that would have parsed these files, and the first thing to try would
// have been Node at cold start: Runtime.UserCodeSyntaxError, 500 on every projects, locations and
// inventory-items request — the app's core CRUD.
//
// This test closes exactly that gap and nothing more: it parses, it does not typecheck or execute.
// A file that parses can still be wrong; a file that does not parse cannot possibly be right.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LAMBDA = join(ROOT, 'lambda')

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walkFiles(p, out)
    else if (extname(entry) === '.js') out.push(p)
  }
  return out
}

// Deployable = everything the `zip -r` in .github/workflows/deploy-lambda.yml puts in the bundle:
// the whole directory MINUS *.test.js, which that step now excludes (OPS-LAMBDATESTZIP-001). The
// filter below therefore mirrors the shipped bundle exactly; before the exclude it happened to
// match only because vitest parses the test files itself.
const FILES = walkFiles(LAMBDA).filter((f) => !/\.test\.js$/.test(f)).map((f) => relative(ROOT, f))

describe('lambda source is valid JavaScript', () => {
  // Anti-vacuity: an empty file list would make every assertion below vanish silently.
  it('found the Lambda sources', () => {
    expect(FILES.length).toBeGreaterThan(60)
    expect(FILES).toContain('lambda/locations/index.js')
    expect(FILES).toContain('lambda/projects/index.js')
    expect(FILES).toContain('lambda/inventory-items/index.js')
  })

  it.each(FILES)('%s parses', (rel) => {
    const code = readFileSync(join(ROOT, rel), 'utf8')
    let err = null
    try {
      acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true })
    } catch (e) {
      err = `${rel}:${e.loc?.line}:${e.loc?.column} ${e.message}`
    }
    expect(err).toBeNull()
  })

  // The specific hazard, pinned so a reviewer sees the shape rather than just a parse failure: a
  // backtick inside a tagged-template SQL body silently ends the template. Assert it directly, because
  // "the file parses" is a consequence that a future unrelated edit could accidentally restore.
  it('no backtick appears inside a SQL line comment', () => {
    const offenders = []
    for (const rel of FILES) {
      readFileSync(join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*--/.test(line) && line.includes('`')) offenders.push(`${rel}:${i + 1}  ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
