// anchor-supersede-parity.test.js — V4-ANCHORSUPERSEDE-001 cross-site drift guard.
// OPS-ANCHORPARITYGAP-001: the site set is now DERIVED from source, not hand-declared.
//
// THE RULE. When a planting gains an observed anchor (any of OBSERVED_ANCHOR_FIELDS), every live row
// in public.plant_anchor_derivation for it is RETIRED — superseded_at = now(),
// superseded_by = 'observed_anchor' — never deleted, and the statement is idempotent so a re-run
// cannot rewrite an earlier retirement's timestamp. It is written out in full at every site because
// each Lambda is zipped from its own directory: a shared module would not be packaged and the handler
// would 502 at module load. The copies are deliberate; this file is what stops them diverging.
//
// WHY THIS FILE WAS REWRITTEN. Its first version named FOUR sites in a hand-written literal and then
// asserted toHaveLength(4) on that same literal — a tautology, since the list and the count were only
// ever edited together. By 2026-08-16 there were SIX: V4-TRANSPLANTANCHOR-001 had added the batch and
// single halves of the transplant write in lambda/events/index.js, and this guard read as full
// coverage of the rule while being blind to a third of its call sites. The second half of the same
// defect is subtler and would have survived merely adding events/index.js to the list: the old slicer
// took ONE block per file (src.search finds the first match only), so a file holding two statements
// got its first checked and its second silently skipped.
//
// SO THE SET IS DISCOVERED, NOT DECLARED. Every UPDATE against the relation in the corpus below is
// found by statement shape, and the derived map is asserted equal to SITES — files AND per-file count
// AND per-occurrence classification. A site in a NEW file reds; a SECOND statement in an
// already-listed file reds; a deleted one reds. SITES stops being the search and becomes the answer
// key, which is the only arrangement in which forgetting to update it is loud.
//
// ON SCANNING SOURCE TEXT RATHER THAN KEEPING A LIST. The precedent is
// anchor-derivation-hard-dependency.test.js, which pins this same relation's dependent set the same
// way. Two choices keep the scan from being brittle in the direction that matters:
//   - Comments and string literals are NOT stripped. Stripping is the machinery that would introduce
//     false NEGATIVES, and a false negative here IS the defect being fixed — silent and indefinite.
//     A false positive (a comment quoting the statement verbatim) reds loudly and costs one line of
//     allowlist. Over-matching is the safe failure direction for this guard; under-matching is not.
//   - The discovery regex matches the STATEMENT — `UPDATE [public.]plant_anchor_derivation` — not the
//     relation name, so prose that merely mentions the table does not register. Nothing in the corpus
//     matches it today except the seven real statements.
//
// CORPUS. lambda/**.js (non-test), migrations/**.sql, scripts/**.{js,mjs} — every surface in the repo
// that can hold a database handle. src/ is excluded because the browser has none: it reaches this
// relation only through the Lambdas. Test files are excluded because they quote the statement by
// design, and counting them would make every new test OF the rule look like a new site.
//
// The set of OBSERVED columns is owned by lambda/harvests/anchorDerive.js (OBSERVED_ANCHOR_FIELDS,
// layer 2 of the marking rule). It is IMPORTED here rather than restated, so adding a fourth observed
// column to the derivation logic and forgetting the SQL fails this test instead of silently leaving
// derivations live beside a date the app already treats as real.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OBSERVED_ANCHOR_FIELDS } from './harvests/anchorDerive.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '..')

// Keyed by repo-relative path, in source order within each file. `rule` is the classification every
// discovered statement must be given: this table is what a maintainer edits, and the tests below are
// what forces the edit.
const SITES = {
  'lambda/daily-plan/handler.js': [
    { rule: 'observed_anchor',
      note: 'the nightly sweep — backstop for non-Lambda writers and the only healer for rows that '
        + 'went stale before the write paths shipped.' },
    { rule: 'rederive',
      note: 'V4-ANCHORRESWEEP-001, the nightly RE-derivation retire. A THIRD rule: it fires on the '
        + 'inverse predicate — precisely when none of the observed columns is set — so matching the '
        + 'observed-anchor guard would mean lying to it. Records superseded_by = REDERIVE_REASON '
        + 'rather than claiming an observation, and is aliased `stale` so the two rules in this file '
        + 'stay distinguishable by shape rather than by source order.' },
  ],
  'lambda/events/index.js': [
    { rule: 'observed_anchor',
      note: 'V4-TRANSPLANTANCHOR-001, BATCH half. `transplant` is in BATCH_EVENT_TYPES, so this path '
        + 'really can be the one that establishes an anchor.' },
    { rule: 'observed_anchor',
      note: 'V4-TRANSPLANTANCHOR-001, SINGLE-event half — the third route by which an observed date '
        + 'can arrive, reaching neither the PUT nor the merge.' },
  ],
  'lambda/plants/index.js': [
    { rule: 'observed_anchor',
      note: 'the PUT — the single place every client anchor write converges.' },
  ],
  'lambda/plants/merge.js': [
    { rule: 'merge_loser',
      note: 'the LOSERS\' live derivations, superseded rather than repointed because '
        + 'uq_plant_anchor_derivation_live admits one live row per plant. A different rule: it '
        + 'retires on merge, not on an observed anchor.' },
    { rule: 'observed_anchor',
      note: 'the merge cutover — phenology reconciliation can hand the WINNER a real date it did not '
        + 'have. Ordered after the winner UPDATE so the EXISTS reads the reconciled row.' },
  ],
  'migrations/v4-anchorbase-001/0b-backfill.sql': [
    { rule: 'observed_anchor', note: 'the canonical statement (second transaction).' },
  ],
}

// The rollback is the one place allowed to erase rows, because it un-ships the whole model version.
// Named rather than exempted so that a DELETE appearing anywhere else is a failure and not a silence.
const ROLLBACK = 'migrations/v4-anchorbase-001/0r-rollback.sql'

const ROOTS = {
  lambda: (n) => n.endsWith('.js') && !n.endsWith('.test.js'),
  migrations: (n) => n.endsWith('.sql'),
  scripts: (n) => (n.endsWith('.js') || n.endsWith('.mjs')) && !n.endsWith('.test.js'),
}

function walk(abs, rel, keep, out) {
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const child = join(abs, e.name)
    const childRel = `${rel}/${e.name}`
    if (e.isDirectory()) walk(child, childRel, keep, out)
    else if (keep(e.name)) out.push([childRel, readFileSync(child, 'utf8')])
  }
  return out
}

const CORPUS = Object.entries(ROOTS)
  .flatMap(([root, keep]) => walk(resolve(REPO, root), root, keep, []))
  .sort(([a], [b]) => a.localeCompare(b))

// merge.js writes the relation UNQUALIFIED while every other site schema-qualifies it, and a site is
// free to carry no alias at all, so both are optional here. A discovery regex that required `public.`
// or a `d` alias would understate the set by exactly the statements it is least likely to be looking
// for.
const RETIRE_RE_G = /update\s+(?:public\.)?plant_anchor_derivation\b/gi
const DELETE_RE = /delete\s+from\s+(?:public\.)?plant_anchor_derivation\b/i

// Each site writes the statement in its own dialect (schema-qualified or not, neon placeholders or
// none), so a block is bounded by the statement terminator that dialect actually uses: `;` in SQL,
// the closing backtick of the tagged template in JS.
const TERMINATOR = /(?:;|`\)|`,|`;)/

function retireBlocks(src) {
  const out = []
  for (const m of src.matchAll(RETIRE_RE_G)) {
    const rest = src.slice(m.index)
    const end = rest.search(TERMINATOR)
    out.push(end === -1 ? rest : rest.slice(0, end))
  }
  return out
}

const FOUND = new Map(
  CORPUS.map(([rel, src]) => [rel, retireBlocks(src)]).filter(([, blocks]) => blocks.length),
)

const OCCURRENCES = Object.entries(SITES).flatMap(([rel, specs]) =>
  specs.map((spec, i) => [`${rel} #${i + 1}`, rel, i, spec]))
const withRule = (rule) => OCCURRENCES.filter(([, , , spec]) => spec.rule === rule)

function blockAt(rel, i) {
  const block = (FOUND.get(rel) ?? [])[i]
  expect(block, `no statement #${i + 1} found in ${rel} — SITES claims one`).toBeTruthy()
  return block
}

describe('every site that retires a derivation is enumerated', () => {
  // The pin the hand-written list could not give: the corpus decides the set, SITES only answers it.
  it('the files carrying the statement are exactly the enumerated ones', () => {
    expect([...FOUND.keys()].sort()).toEqual(Object.keys(SITES).sort())
  })

  // And the count PER FILE, which is the half that events/index.js slipped through: it was reachable
  // from a list naming the file while a second statement inside it went unchecked.
  it.each(Object.entries(SITES))('%s carries exactly the recorded number of statements', (rel, specs) => {
    expect(FOUND.get(rel) ?? [],
      `${rel} has a statement count SITES does not account for — classify it, do not adjust the count`)
      .toHaveLength(specs.length)
  })

  // An empty or truncated slice would pass every content assertion below, so the slicer is pinned too.
  it.each(OCCURRENCES)('%s slices to a real statement', (_label, rel, i) => {
    expect(blockAt(rel, i)).toMatch(/plant_anchor_derivation/i)
  })

  // Stated as a number so that reclassifying a site — the one edit that could shrink coverage while
  // leaving both assertions above green — has to be deliberate.
  it('six of the eight statements are the observed-anchor retire', () => {
    expect(OCCURRENCES).toHaveLength(8)
    expect(withRule('observed_anchor')).toHaveLength(6)
    expect(withRule('merge_loser')).toHaveLength(1)
    expect(withRule('rederive')).toHaveLength(1)
  })
})

describe('the supersede rule is identical at every site that writes it', () => {
  it.each(withRule('observed_anchor'))('%s gates on every OBSERVED_ANCHOR_FIELD', (_label, rel, i) => {
    const block = blockAt(rel, i)
    expect(OBSERVED_ANCHOR_FIELDS.length).toBeGreaterThanOrEqual(3)
    for (const field of OBSERVED_ANCHOR_FIELDS) {
      expect(new RegExp(`\\.${field}\\s+is\\s+not\\s+null`, 'i').test(block),
        `${rel} #${i + 1} does not test ${field} — a derivation would stay live beside a real date`).toBe(true)
    }
  })

  it.each(withRule('observed_anchor'))('%s is idempotent and names the reason', (_label, rel, i) => {
    const block = blockAt(rel, i)
    expect(/superseded_at\s+is\s+null/i.test(block), `${rel} #${i + 1} lost its re-run guard`).toBe(true)
    expect(/superseded_by\s*=\s*'observed_anchor'/i.test(block),
      `${rel} #${i + 1} retires without recording why — the calibration extract cannot tell this ` +
      'apart from a merge retirement').toBe(true)
  })

  // The other side of that same sentence, and the reason the merge's loser statement is classified
  // apart rather than dropped from the scan: it retires for a structural reason (one live row per
  // plant), not because an anchor was observed. Recording it as 'observed_anchor' would file a merge
  // artefact as a (guess, later truth) pair and bias the only accuracy measurement tier 3 produces.
  // It must still record SOME reason (OPS-MERGERETIREPROV-001): retiring on superseded_at alone left
  // six of the eight retired rows on prod carrying superseded_by IS NULL, which is unattributable
  // after the fact. The token itself is unpinned — a later `superseded_by = 'merged'` is an
  // improvement and must not red — so only the two ends are asserted: a reason exists, and it does
  // not claim an observation.
  it.each(withRule('merge_loser'))('%s retires without claiming an observed anchor', (_label, rel, i) => {
    const block = blockAt(rel, i)
    expect(/superseded_at\s+is\s+null/i.test(block), `${rel} #${i + 1} lost its re-run guard`).toBe(true)
    expect(/superseded_by\s*=/i.test(block),
      `${rel} #${i + 1} retires without recording why — an unattributable retirement`).toBe(true)
    expect(/superseded_by\s*=\s*'observed_anchor'/i.test(block),
      `${rel} #${i + 1} files a merge retirement as an observed anchor`).toBe(false)
  })

  // The re-derivation retire is the inverse predicate, so it is exempt from the observed-column gate
  // above by classification rather than by an allowlist. What it is NOT exempt from: the re-run guard,
  // and recording SOME reason. The latter is not hypothetical — merge.js's loser statement retired with
  // superseded_at alone until OPS-MERGERETIREPROV-001, and the six rows it retired on prod still carry
  // superseded_by IS NULL, which is exactly the provenance hole that makes a retirement unattributable
  // after the fact. All three rules now demand a reason; only this one leaves the token unpinned.
  it.each(withRule('rederive'))('%s retires idempotently and records a reason that is not an observation',
    (_label, rel, i) => {
      const block = blockAt(rel, i)
      expect(/superseded_at\s+is\s+null/i.test(block), `${rel} #${i + 1} lost its re-run guard`).toBe(true)
      expect(/superseded_by\s*=/i.test(block),
        `${rel} #${i + 1} retires without recording why — an unattributable retirement`).toBe(true)
      expect(/superseded_by\s*=\s*'observed_anchor'/i.test(block),
        `${rel} #${i + 1} files a re-derivation as an observed anchor`).toBe(false)
    })
})

describe('retire, never erase', () => {
  // The (guess, later truth) pair is the ONLY ground truth the add-date baseline tier will ever get.
  // Deleting a contradicted row throws away the measurement the backfill exists to create.
  it.each([...FOUND.keys()])('%s never DELETEs a derivation', (rel) => {
    const [, src] = CORPUS.find(([r]) => r === rel)
    expect(DELETE_RE.test(src),
      `${rel} deletes from plant_anchor_derivation — retire, never erase`).toBe(false)
  })

  // Wider net than the site files: a DELETE in a file that carries no retire statement would be
  // invisible to the test above, which is the same shape of blindness this file was rewritten to fix.
  it('the rollback is the only file in the tree that erases rows', () => {
    const deleters = CORPUS.filter(([, src]) => DELETE_RE.test(src)).map(([rel]) => rel)
    expect(deleters).toEqual([ROLLBACK])
  })
})
