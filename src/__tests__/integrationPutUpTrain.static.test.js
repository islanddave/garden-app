// Put-Up train (06-ferment-path §5 L1, QA-B2) — static guard on integration-test.yml's train list.
//
// WHY A FILE-READING TEST. The train's DDL stays off staging until its sitting, so the integration run
// applies it to its own ephemeral fork: `for dir in <list>` in integration-test.yml, each directory's 0a
// whose stamp the fork lacks, in list order. A directory missing from that list is SKIPPED WITHOUT A
// WORD, and every integration file then runs the train's code against a schema without it — green or
// red for the wrong reason. The list shipped omitting v5-fermentpath-001. So this pins:
//   1. the list is exactly the train, in train order;
//   2. every listed directory that exists has 0a files whose line 2 names the stamp the file inserts
//      (the step reads line 2 to decide "already applied");
//   3. stamp order: a listed 0a that names another train stamp (its applies-on-top-of guard) lists
//      after that stamp's directory;
//   4. no migrations/v5-* directory depends on a train stamp without being on the list.
// Mutation arms: drop v5-fermentpath-001 from the list -> 1 and 4 red; swap it before v5-putupmake-001 ->
// 1 and 3 red; change F's line-2 stamp -> 2 red.
//
// WHAT IT DOES NOT CATCH: whether the SQL applies (the integration run itself, and the local PG 17
// rehearsal in each README, prove that).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = process.cwd()
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')
const MIGRATIONS = resolve(ROOT, 'migrations')

const TRAIN = [
  'v5-putupmake-001', 'v5-fermentpath-001', 'v5-pantry-001', 'v5-batchbuilder-001', 'v5-recipes-001',
  // R2a: pantry_item gains an amount and where-from. Its 0a names v5-pantry-001's stamp, so it lists after it.
  'v5-pantryitemamount-001',
]
// Directories that must exist on this branch, named so the checks below cannot pass on an empty read. The four
// later train directories have landed too, and every check below reads each listed directory that exists.
const LANDED = ['v5-putupmake-001', 'v5-fermentpath-001']

const WORKFLOW = read('.github/workflows/integration-test.yml')

function listedTrain() {
  const loops = [...WORKFLOW.matchAll(/^\s*for dir in ([^;\n]+); do\s*$/gm)]
  expect(loops, 'exactly one `for dir in …; do` loop in integration-test.yml').toHaveLength(1)
  return loops[0][1].trim().split(/\s+/)
}

function zeroAFiles(dir) {
  const d = join(MIGRATIONS, dir)
  if (!existsSync(d)) return []
  return readdirSync(d).filter((f) => /^0a-.*\.sql$/.test(f)).sort().map((f) => join(d, f))
}

function stampOf(file) {
  const line2 = readFileSync(file, 'utf8').split('\n')[1] ?? ''
  const m = line2.match(/^-- schema_version: ([0-9A-Za-z._-]+)$/)
  return m ? m[1] : null
}

const trainStamps = () => {
  const out = new Map()
  for (const dir of TRAIN) for (const f of zeroAFiles(dir)) out.set(stampOf(f), dir)
  return out
}

describe('integration-test.yml applies the whole Put-Up train, in order', () => {
  it('lists exactly the train, in train order', () => {
    expect(listedTrain()).toEqual(TRAIN)
  })

  it('finds the landed train directories, so the checks below are not vacuous', () => {
    for (const dir of LANDED) {
      expect(zeroAFiles(dir).length, `${dir} has a 0a file`).toBeGreaterThan(0)
    }
  })

  it('every listed 0a names, on line 2, the stamp it inserts', () => {
    for (const dir of listedTrain()) {
      for (const f of zeroAFiles(dir)) {
        const stamp = stampOf(f)
        expect(stamp, `${f}: line 2 must be '-- schema_version: <stamp>'`).not.toBeNull()
        const src = readFileSync(f, 'utf8')
        expect(src, `${f} inserts ${stamp}`).toMatch(
          new RegExp(String.raw`INSERT INTO public\.schema_version[\s\S]*?VALUES\s*\('${stamp.replace(/\./g, '\\.')}'`))
      }
    }
  })

  it('lists each 0a after every train stamp it names (stamp order)', () => {
    const stamps = trainStamps()
    const listed = listedTrain()
    let checked = 0
    for (const dir of listed) {
      for (const f of zeroAFiles(dir)) {
        const own = stampOf(f)
        const src = readFileSync(f, 'utf8')
        for (const [stamp, owner] of stamps) {
          if (!stamp || stamp === own || owner === dir) continue
          if (!src.includes(`'${stamp}'`)) continue
          checked += 1
          expect(listed.indexOf(owner), `${dir} names ${stamp}, so ${owner} must be listed before it`)
            .toBeLessThan(listed.indexOf(dir))
        }
      }
    }
    // F's applies-on-top-of-1b guard is the one dependency that exists today.
    expect(checked).toBeGreaterThan(0)
  })

  it('leaves off no migrations/v5-* directory that depends on a train stamp', () => {
    const stamps = trainStamps()
    const listed = new Set(listedTrain())
    const dependents = readdirSync(MIGRATIONS)
      .filter((d) => d.startsWith('v5-'))
      .filter((d) => zeroAFiles(d).some((f) => {
        const src = readFileSync(f, 'utf8')
        const own = stampOf(f)
        return [...stamps.keys()].some((s) => s && s !== own && src.includes(`'${s}'`))
      }))
    expect(dependents).toContain('v5-fermentpath-001')
    for (const d of dependents) expect(listed.has(d), `${d} depends on a train stamp`).toBe(true)
  })
})
