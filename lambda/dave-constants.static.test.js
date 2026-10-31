// The Dave-constant ratchet (V5-SITECONSTANTS-001, multi-space Phase 1 step 1.14, the static half; the
// `post_sentinel_callers` DB gate is in migrations/v5-tenantgates-001).
//
// WHY THIS EXISTS. Single-tenant code reaches the one household in four ways: the sentinel workspace UUID written
// as a string, the SENTINEL_WORKSPACE constant that holds it, and reads of the two env vars that name the household
// (GARDEN_HOUSEHOLD_IDS) or its owner (OWNER_FALLBACK_SUB). Every one of them has to go before a second Space is
// real. This list is where they are today, per non-test file and per kind, and it may only shrink:
//   * a file not listed, or a count above its entry — NEW Dave-specific code; read it from the DB / the Space;
//   * a count below its entry, or a listed file with none left — STALE; lower or delete the entry.
// No entry is permanent. An entry may carry a `reason` for why it is still here.
//
// HOUSEHOLD COPIES. lambda/household.js and every lambda/<dir>/household.js copy are ONE entry (HOUSEHOLD_CLASS),
// holding the highest count of each kind across the copies. Each Lambda zips alone, so a new household-scoped
// Lambda ships another copy; that is not new Dave-specific code, and lambda/household-copies-sync.test.js already
// holds every copy byte-identical to the canonical. So a new copy does not red here, a copy whose readers rise does,
// and a reader in any file that is not a household.js copy (householdScope.js, an index.js) is per file as above.
//
// What counts (scripts/repo-constants-scan.mjs, scanDaveConstants): JS is parsed (acorn + acorn-jsx), so a comment
// or a string that merely names an env var never counts; a READER is `process.env.X`, `process.env['X']`,
// `env.X` / `env['X']`, `<x>.Variables.X`, `const { X } = process.env`, or `'X' in process.env`. Shell, Python and
// other text files use the documented text rule (whole-line comments dropped; `$X`, `${X…}`, `os.environ…`,
// `getenv(…)`, `env.X`). Scope: non-test files under lambda/, src/, scripts/. scripts/space-harness/** (1.12) is
// exempt by name from the SENTINEL_WORKSPACE and reader kinds — it drives whole throwaway Spaces and must read the
// household env to do it — but not from the literal (sheet §3R: the harness reads the sentinel from the DB).
//
// KNOWN LIMITS (accepted, QA review of the code piece). The detector reads literal shapes, so these evade it:
//   * `process.env[K]` with K a const holding the env name (a computed member with a variable);
//   * `const e = process.env; e.OWNER_FALLBACK_SUB` (process.env held in another name; `env`/`ENV`/`environ` are
//     the only alias names recognised);
//   * the sentinel built at runtime, e.g. ['…-', '…1'].join('') or a template with an expression.
// The first two are shared by the C4 zero-reader test (scripts/test_check_lambda_config.py). Each takes a
// deliberate rewrite to reach, and review is the backstop.
//
// Regenerate (after a removal): `node scripts/repo-constants-scan.mjs dave`, paste, carry `reason` over by hand.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanDaveConstants, daveCounts, SENTINEL_UUID, KINDS } from '../scripts/repo-constants-scan.mjs'

// lambda/household.js and its per-Lambda copies, one entry (see HOUSEHOLD COPIES in the header).
const HOUSEHOLD_COPY = /^lambda\/(?:[^/]+\/)?household\.js$/
const HOUSEHOLD_CLASS = 'lambda/household.js + lambda/<dir>/household.js copies'

const DAVE_CONSTANTS = {
  [HOUSEHOLD_CLASS]: {
    GARDEN_HOUSEHOLD_IDS: 1,
    reason: 'householdList(): the one household read behind householdScope, householdActive and the SEC-13a householdGate, '
      + 'copied per Lambda dir because each zips alone; its byte-sameness is lambda/household-copies-sync.test.js. Goes '
      + 'when household scope reads the Space',
  },
  'lambda/daily-plan/householdScope.js': { GARDEN_HOUSEHOLD_IDS: 1 },
  'lambda/events/critterAward.js': { literal: 1, SENTINEL_WORKSPACE: 2 },
  'lambda/shared-state/index.js': { literal: 1, SENTINEL_WORKSPACE: 5 },
  'scripts/seed-recipes.mjs': { GARDEN_HOUSEHOLD_IDS: 1 },
  'scripts/weather-observability.sh': {
    literal: 1,
    reason: 'self-test fixture (:129) copying the frost dedup-read WARN log line, Space id included; it goes when '
      + 'the self-test uses a made-up Space id',
  },
}

// The household.js copies folded into one HOUSEHOLD_CLASS entry holding the highest count of each kind across them,
// so a new copy changes nothing and a copy whose readers rise still reds. Every other file stays per file.
function collapse(found) {
  const out = {}
  for (const [file, counts] of Object.entries(found)) {
    if (!HOUSEHOLD_COPY.test(file)) { out[file] = counts; continue }
    out[HOUSEHOLD_CLASS] ??= {}
    for (const [k, v] of Object.entries(counts)) out[HOUSEHOLD_CLASS][k] = Math.max(out[HOUSEHOLD_CLASS][k] || 0, v)
  }
  return out
}

// Every (file, kind) whose count differs from the list, with what to do about it.
function ratchet(found, list) {
  const out = []
  for (const file of new Set([...Object.keys(found), ...Object.keys(list)])) {
    for (const kind of KINDS) {
      const have = found[file]?.[kind] || 0
      const allowed = list[file]?.[kind] || 0
      if (have > allowed) {
        out.push(list[file]
          ? `${file} ${kind}: ${have} > ${allowed} — count ROSE; read it from the DB / the Space instead`
          : `${file} ${kind}: ${have} — NEW file holding a Dave constant; read it from the DB / the Space instead`)
      } else if (have < allowed) {
        out.push(`${file} ${kind}: ${have} < ${allowed} — STALE entry; ${have ? `lower it to ${have}` : 'remove the kind (or the file entry)'}`)
      }
    }
  }
  return out
}

describe('Dave-constant ratchet (1.14)', () => {
  const found = scanDaveConstants()

  it('found the known inventory (anti-vacuity)', () => {
    expect(found['lambda/household.js']).toEqual({ GARDEN_HOUSEHOLD_IDS: 1 })
    expect(Object.keys(found).filter((f) => HOUSEHOLD_COPY.test(f)).length).toBeGreaterThan(10)
  })

  it('the tree matches the list exactly (new file reds, rising count reds, stale entry reds)', () => {
    expect(ratchet(collapse(found), DAVE_CONSTANTS)).toEqual([])
  })

  it('entries hold only counted kinds and an optional reason; none is permanent', () => {
    for (const [file, entry] of Object.entries(DAVE_CONSTANTS)) {
      for (const [k, v] of Object.entries(entry)) {
        if (k === 'reason') expect(typeof v, file).toBe('string')
        else { expect(KINDS, `${file} ${k}`).toContain(k); expect(v, `${file} ${k}`).toBeGreaterThan(0) }
      }
    }
  })

  // The detector, so a green run above cannot be a blind one.
  it('JS: readers and literals count; comments and string mentions do not', () => {
    const js = [
      `const a = process.env.GARDEN_HOUSEHOLD_IDS`,
      `const b = process.env['OWNER_FALLBACK_SUB']`,
      `const c = env.GARDEN_HOUSEHOLD_IDS`,
      `const { GARDEN_HOUSEHOLD_IDS } = process.env`,
      `const w = '${SENTINEL_UUID}'`,
      `// householdScope(): process.env.GARDEN_HOUSEHOLD_IDS and '${SENTINEL_UUID}' in a comment`,
      `/* SENTINEL_WORKSPACE */ const msg = 'GARDEN_HOUSEHOLD_IDS missing'`,
    ].join('\n')
    expect(daveCounts('x.js', js)).toEqual({ literal: 1, SENTINEL_WORKSPACE: 0, GARDEN_HOUSEHOLD_IDS: 3, OWNER_FALLBACK_SUB: 1 })
  })

  it('text rule (sh/py): readers count; comment lines and bare names do not', () => {
    const sh = [`# uses $GARDEN_HOUSEHOLD_IDS`, `ids="\${GARDEN_HOUSEHOLD_IDS:-}"`, `KEYS=(GARDEN_HOUSEHOLD_IDS OWNER_FALLBACK_SUB)`].join('\n')
    expect(daveCounts('x.sh', sh)).toMatchObject({ GARDEN_HOUSEHOLD_IDS: 1, OWNER_FALLBACK_SUB: 0 })
    const py = [`# os.environ["OWNER_FALLBACK_SUB"]`, `s = os.environ.get("OWNER_FALLBACK_SUB")`].join('\n')
    expect(daveCounts('x.py', py)).toMatchObject({ OWNER_FALLBACK_SUB: 1 })
  })

  it('a new literal in an unlisted file reds; space-harness is exempt except for the literal', () => {
    const root = mkdtempSync(join(tmpdir(), 'daveconst-'))
    try {
      mkdirSync(join(root, 'lambda/newthing'), { recursive: true })
      mkdirSync(join(root, 'scripts/space-harness'), { recursive: true })
      writeFileSync(join(root, 'lambda/newthing/index.js'), `export const W = '${SENTINEL_UUID}'\n`)
      writeFileSync(join(root, 'lambda/newthing/index.test.js'), `export const W = '${SENTINEL_UUID}'\n`)
      writeFileSync(join(root, 'scripts/space-harness/run.mjs'),
        `const ids = process.env.GARDEN_HOUSEHOLD_IDS\nconst SENTINEL_WORKSPACE = await readIt()\nconst lit = '${SENTINEL_UUID}'\n`)
      const f = scanDaveConstants({ root })
      expect(f).toEqual({ 'lambda/newthing/index.js': { literal: 1 }, 'scripts/space-harness/run.mjs': { literal: 1 } })
      expect(ratchet(f, {})).toHaveLength(2)
      expect(ratchet({}, { 'lambda/gone.js': { literal: 1 } })[0]).toMatch(/STALE entry; remove/)
      expect(ratchet({ 'a.js': { literal: 1 } }, { 'a.js': { literal: 2 } })[0]).toMatch(/STALE entry; lower it to 1/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a new household.js copy is the same class (no red); a rising copy or a reader elsewhere still reds', () => {
    const root = mkdtempSync(join(tmpdir(), 'daveconst-'))
    const reader = 'export const ids = () => process.env.GARDEN_HOUSEHOLD_IDS || process.env.GARDEN_HOUSEHOLD_IDS\n'
    const list = { [HOUSEHOLD_CLASS]: { GARDEN_HOUSEHOLD_IDS: 2 } }
    try {
      for (const d of ['', 'plants/', 'brandnew/']) {
        mkdirSync(join(root, 'lambda', d), { recursive: true })
        writeFileSync(join(root, `lambda/${d}household.js`), reader)
      }
      expect(ratchet(collapse(scanDaveConstants({ root })), list)).toEqual([])
      // a reader in a file that is not a household.js copy is per file, so it is NEW
      writeFileSync(join(root, 'lambda/brandnew/index.js'), 'const ids = process.env.GARDEN_HOUSEHOLD_IDS\n')
      expect(ratchet(collapse(scanDaveConstants({ root })), list)).toEqual([
        'lambda/brandnew/index.js GARDEN_HOUSEHOLD_IDS: 1 — NEW file holding a Dave constant; read it from the DB / the Space instead',
      ])
      rmSync(join(root, 'lambda/brandnew/index.js'))
      // a copy that reads more than the class allows reds the class (the sync test reds it too)
      writeFileSync(join(root, 'lambda/brandnew/household.js'), `${reader}const more = process.env.GARDEN_HOUSEHOLD_IDS\n`)
      expect(ratchet(collapse(scanDaveConstants({ root })), list)).toEqual([
        `${HOUSEHOLD_CLASS} GARDEN_HOUSEHOLD_IDS: 3 > 2 — count ROSE; read it from the DB / the Space instead`,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
