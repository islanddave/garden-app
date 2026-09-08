// Mutation proof for the AmbientList extraction (2026-09-08).
//
// WHY THIS EXISTS AS A FILE AND NOT A SCRATCH SCRIPT. This refactor's entire claim is that it changed
// nothing — 158/158 green with zero test files touched. But a green suite after a refactor only shows
// the tests still pass; it does not show they would CATCH a broken one. The three ambient lists each
// depend on a property no ordinary assertion states: they render OUTSIDE the `total === 0` ternary in
// CareNeeded, so they survive a quiet day. That property is proved only by ASYMMETRY — move a render
// into the non-empty arm and the empty-state test reddens while the busy-day test stays green. A test
// that checked only the busy day would pass either way and prove nothing.
//
// Re-run after ANY edit to CareNeeded.jsx, careNeeded.js, or the CareNeeded* tests:
//   node scripts/mutate-ambient-list-check.mjs
// Exit 0 = every mutation killed. Non-zero = a guard has gone vacuous; read which.
//
// READ THE SEMANTICS ONCE, THEY INVERT EASILY: a mutation is KILLED when the tests FAIL. Killed is
// GOOD. A mutation that SURVIVES means the guard did not notice the defect, which is the bug.
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const JSX = 'src/components/today/CareNeeded.jsx'
const LIB = 'src/lib/careNeeded.js'

const DORMANT_RENDER = '      <DormantList plan={plan} />'
const DROUGHT_RENDER = '      <DroughtList plan={plan} />'
const FEED_RENDER = '      <FeedSuppressedList plan={plan} />'
// The non-empty arm's closing fragment. Inserting a render just before it puts that render INSIDE
// that arm — i.e. it now renders only on a day that already has care due.
const NONEMPTY_TAIL = '          <RainNote plan={plan} />\n        </>'

const DROUGHT_T = 'src/__tests__/CareNeededDrought.test.jsx'
const DORMANT_T = 'src/__tests__/CareNeededDormant.test.jsx'
const FEED_T = 'src/__tests__/CareNeededFeedSuppressed.test.jsx'
const DROUGHT_SEL_T = 'src/__tests__/careNeededDrought.test.js'

const AMBIENT_SIG = 'function AmbientList({ testId, title, blurb, header, children }) {\n  return ('
const TITLE_LINE = "      {title && <h3 style={{ fontSize: '0.82rem', fontWeight: 700, color: P.dark, margin: 0 }}>{title}</h3>}\n"
const BLURB_LINE = "      {blurb && <div style={{ fontSize: '0.78rem', color: P.light, lineHeight: 1.4 }}>{blurb}</div>}"
const DROUGHT_REASON_SPAN = "          <span style={{ flex: '0 0 auto', fontSize: '0.78rem', color: P.light }}>{row.reason}</span>"
const AMBIENT_LINK = "      <Link to={'/plantings/' + plantingId} style={{ fontSize: '0.85rem', color: P.dark,\n"
  + "        textDecoration: 'none', flex: '1 1 auto', minWidth: 0,\n"
  + "        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>\n        {name}\n      </Link>"

// Move a render out of its place outside the ternary and into the NON-EMPTY arm.
const misplace = (line) => [[JSX, line + '\n', ''], [JSX, NONEMPTY_TAIL, '          ' + line.trim() + '\n' + NONEMPTY_TAIL]]

// `kill` names the test that MUST go red. `survive` names one that MUST stay green under the same
// mutation — the pair is the placement proof; either half alone is also consistent with a deletion.
const CASES = [
  // Placement: outside the ternary, for all three. The asymmetry is the whole point.
  { id: 'A1-misplace-drought', desc: 'move <DroughtList/> into the non-empty arm', edits: misplace(DROUGHT_RENDER),
    kill: [DROUGHT_T, 'renders in the empty state'], survive: [DROUGHT_T, 'survives a day that does have care due'] },
  { id: 'A2-misplace-dormant', desc: 'move <DormantList/> into the non-empty arm', edits: misplace(DORMANT_RENDER),
    kill: [DORMANT_T, 'even when nothing needs care'], survive: [DORMANT_T, 'alongside a day that does have care due'] },
  { id: 'A3-misplace-feed', desc: 'move <FeedSuppressedList/> into the non-empty arm', edits: misplace(FEED_RENDER),
    kill: [FEED_T, 'even with nothing else due'], survive: [FEED_T, 'survives a day that does have care due'] },

  // The render is load-bearing at all.
  { id: 'B1-delete-drought', desc: 'delete the <DroughtList/> render', edits: [[JSX, DROUGHT_RENDER, '']], kill: [DROUGHT_T, null] },
  { id: 'B2-delete-dormant', desc: 'delete the <DormantList/> render', edits: [[JSX, DORMANT_RENDER, '']], kill: [DORMANT_T, null] },
  { id: 'B3-delete-feed', desc: 'delete the <FeedSuppressedList/> render', edits: [[JSX, FEED_RENDER, '']], kill: [FEED_T, null] },

  // The EXTRACTED shell is on the live path for each of the three — not decorative for any of them.
  { id: 'C1a-shell-null-drought', desc: 'AmbientList returns null — drought must red',
    edits: [[JSX, AMBIENT_SIG, AMBIENT_SIG.replace('return (', 'return null; return (')]], kill: [DROUGHT_T, null] },
  { id: 'C1b-shell-null-dormant', desc: 'AmbientList returns null — dormant must red',
    edits: [[JSX, AMBIENT_SIG, AMBIENT_SIG.replace('return (', 'return null; return (')]], kill: [DORMANT_T, null] },
  { id: 'C1c-shell-null-feed', desc: 'AmbientList returns null — feed-suppressed must red',
    edits: [[JSX, AMBIENT_SIG, AMBIENT_SIG.replace('return (', 'return null; return (')]], kill: [FEED_T, null] },
  { id: 'C2-drop-children', desc: 'AmbientList drops {children}', edits: [[JSX, BLURB_LINE + '\n      {children}', BLURB_LINE]], kill: [DROUGHT_T, null] },
  { id: 'C3-drop-header', desc: 'AmbientList drops {header} — proves feed routes through the shell',
    edits: [[JSX, '      {header}\n', '']], kill: [FEED_T, null] },
  { id: 'C4-drop-title', desc: 'AmbientList drops {title} — proves dormant/drought route through it',
    edits: [[JSX, TITLE_LINE, '']], kill: [DROUGHT_T, null] },
  { id: 'C5-row-span', desc: 'AmbientRow renders a <span> instead of a <Link>',
    edits: [[JSX, AMBIENT_LINK, '      <span>{name}</span>']], kill: [DROUGHT_T, 'links each name'] },

  // The named constraints that had to survive the extraction.
  { id: 'D1-soften-refusal', desc: 'droughtRows defaults dry_days instead of dropping the row',
    edits: [[LIB, '    if (!d || typeof d.dry_days !== \'number\' || !isFinite(d.dry_days) || d.dry_days <= 0) continue',
      '    if (!d) continue\n    if (typeof d.dry_days !== \'number\' || !isFinite(d.dry_days) || d.dry_days <= 0) d.dry_days = 1']],
    kill: [DROUGHT_SEL_T, null] },
  { id: 'D2-reword-rain', desc: 'reword the drought copy to "No rain in" (the category slip)',
    edits: [[JSX, 'title="Dry — no deep soak"', 'title="Dry — no rain"'],
      [LIB, "reason: 'No deep soak' + depth + ' in '", "reason: 'No rain in' + depth + ' in '"]],
    kill: [DROUGHT_T, 'deep soak, never plain rain'] },
  { id: 'D3-add-affordance', desc: 'give the drought row a Water button',
    edits: [[JSX, DROUGHT_REASON_SPAN, '          <button type="button">Water</button>']],
    kill: [DROUGHT_T, 'offers no action'] },
]

// A -t filter matching NOTHING skips every test and exits 0 ("Tests 9 skipped (9)"). Read naively that
// is a pass, i.e. a false SURVIVED — a reported guard gap that does not exist. Measured 2026-09-08; it
// produced two bogus rows before the filters were checked against the real `it(` names. So require
// positive evidence that tests RAN, and treat anything else as NOMATCH (a broken instrument), never
// as a result.
function runTests(path, filter) {
  const args = ['vitest', 'run', '--reporter=dot', path, ...(filter ? ['-t', filter] : [])]
  const r = spawnSync('npx', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = (r.stdout || '') + (r.stderr || '')
  const line = out.match(/^\s*Tests\s+(.+)$/m)
  if (!line) return 'NORESULT'
  const counts = [...line[1].matchAll(/(\d+)\s+(?:passed|failed)/g)].map(m => Number(m[1]))
  if (counts.length === 0 || counts.every(n => n === 0)) return 'NOMATCH'
  return r.status === 0 ? 'PASS' : 'FAIL'
}

function apply(edits) {
  for (const [file, from, to] of edits) {
    const s = readFileSync(file, 'utf8')
    if (!s.includes(from)) throw new Error(`ANCHOR MISS in ${file}: ${JSON.stringify(from.slice(0, 70))}`)
    writeFileSync(file, s.replace(from, to))
  }
}

let bad = 0
for (const f of [JSX, LIB]) copyFileSync(f, f + '.orig')
try {
  for (const c of CASES) {
    for (const f of [JSX, LIB]) copyFileSync(f + '.orig', f)
    apply(c.edits)
    const kStatus = runTests(...c.kill)
    const killed = kStatus === 'FAIL'
    let extra = ''
    if (c.survive) {
      const sStatus = runTests(...c.survive)
      const ok = killed && sStatus === 'PASS'
      extra = `  | busy-day: ${sStatus}  | asymmetry: ${ok ? 'OK' : '**BROKEN**'}`
      if (!ok) bad++
    }
    if (!killed) bad++
    const tag = killed ? 'KILLED' : (kStatus === 'PASS' ? '**SURVIVED**' : kStatus)
    console.log(`${c.id.padEnd(24)} ${c.desc.slice(0, 56).padEnd(56)} ${tag}${extra}`)
  }
} finally {
  for (const f of [JSX, LIB]) { copyFileSync(f + '.orig', f); unlinkSync(f + '.orig') }
}
console.log(`\n${CASES.length - bad}/${CASES.length} clean; ${bad} problem(s)`)
process.exit(bad ? 1 : 0)
