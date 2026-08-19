// OPS-DASHSCRATCHMJS-001 — no _-prefixed file under lambda/ may sit there with zero importers.
//
// deploy-lambda.yml zips each function directory with `zip -r ../<fn>.zip . -x '*.test.js'`. That
// exclude is the ONLY filter, so every other file in the directory ships to production. Three
// V4-TAGSUB-001 era backfill/COW scratch runners (_tagsub_backfill.mjs, _tagsub_cow_runner.mjs,
// _tagsub_cow_runner2.mjs, 16 KB together) rode into the garden-dashboard bundle on every deploy
// with zero importers anywhere in the repo — dead weight on a cold-start-sensitive path, plus their
// prod SQL and table shapes handed to production. Same class as OPS-LAMBDATESTZIP-001, which fixed
// *.test.js and only *.test.js.
//
// They were moved to scripts/, not deleted: zero CODE importers is not zero OPERATORS, and scripts/
// already holds ten sibling .mjs runners that import both @neondatabase/serverless and ../lambda/**
// the same way (scripts/reconcile-cultivar-facets.mjs imports the very same crop-derive.js), so the
// move changes nothing about how they resolve or run.
//
// WHY THE IMPORTER CLAUSE, rather than a flat ban on the `_` prefix: the repo uses that prefix for
// TWO different things. lambda/daily-plan/_coverFlags.js is a test-only helper with eleven live
// importers — a flat ban reds on it, and moving it would break eleven test files. The invariant that
// actually distinguishes the cases is reachability: a _-prefixed file nothing imports is scratch.
// (_coverFlags.js does still ship in the bundle, which is a real second instance of the
// OPS-LAMBDATESTZIP-001 class — but it is a live dependency of the test suite, so it is out of scope
// here and named rather than silently allowlisted.)
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname, basename } from 'path'

const ROOT = process.cwd().replace(/\/?$/, '/')
const LAMBDA = join(ROOT, 'lambda')
const CODE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.codegraph', '.vite', 'build'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

// A module specifier ending in this basename, with or without extension. Anchored on the closing
// quote so `_tagsub_cow_runner` does not spuriously match `'./_tagsub_cow_runner2.js'`.
function importerRe(base) {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`['"\`][^'"\`]*${esc}(?:\\.[cm]?[jt]sx?)?['"\`]`)
}

const SELF = 'noLambdaScratchRunners.test.js'

describe('OPS-DASHSCRATCHMJS-001 — deployed Lambda bundles carry no scratch runners', () => {
  // This file is the guard, never a consumer, and it quotes module names in its own prose and
  // assertions — leaving it in the corpus makes it vouch for the very files it is policing. The
  // negative control below is what caught that: the sentinel matched its own literal.
  const repoCode = walk(ROOT).filter((f) => CODE_EXTS.has(extname(f)) && basename(f) !== SELF)

  it('every _-prefixed file under lambda/ is imported by something', () => {
    const candidates = walk(LAMBDA)
      .filter((f) => CODE_EXTS.has(extname(f)) && basename(f).startsWith('_'))
    expect(candidates.length, 'no _-prefixed lambda files found at all — the walker is broken')
      .toBeGreaterThan(0)

    const orphans = []
    for (const file of candidates) {
      const re = importerRe(basename(file, extname(file)))
      const imported = repoCode.some((other) => {
        if (other === file) return false
        try { return re.test(readFileSync(other, 'utf8')) } catch { return false }
      })
      if (!imported) orphans.push(file.slice(ROOT.length))
    }
    // Non-vacuous by construction: this FAILED on the pre-move tree listing exactly the three
    // lambda/dashboard/_tagsub_*.mjs files, and passed _coverFlags.js in the same run. Put any one
    // of the three back and it reds again.
    expect(orphans, `one-off runners belong in scripts/, not in a deployed bundle:\n${orphans.join('\n')}`)
      .toEqual([])
  })

  it('the importer check can distinguish imported from orphaned', () => {
    // Positive control on the mechanism itself, not just on the corpus. Without this, a regex that
    // matched nothing would report every file as an orphan (loud), but a regex that matched
    // everything would report none (silent) — and the assertion above would pass vacuously forever.
    const cover = join(LAMBDA, 'daily-plan', '_coverFlags.js')
    const re = importerRe('_coverFlags')
    expect(repoCode.some((f) => f !== cover && re.test(readFileSync(f, 'utf8'))), '_coverFlags.js has live importers')
      .toBe(true)
    expect(repoCode.some((f) => importerRe('_no_such_module_anywhere').test(readFileSync(f, 'utf8'))))
      .toBe(false)
  })
})
