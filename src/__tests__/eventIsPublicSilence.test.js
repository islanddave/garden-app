// BUG-EVENTPUBFALSE-001 — THE CLASS GUARD: which /api/events producers hardcode `is_public`.
//
// THE DEFECT THIS EXISTS FOR. V4-PUBHIDE-001 is "default everything to true on all create paths",
// and lambda/events/index.js:3118 implements exactly that — `${body.is_public ?? true}`. A `??`
// default only holds while the client stays SILENT: `false ?? true` is `false`, so a client that
// sends an explicit false beats the default all the way to the row, and lambda/projects/index.js:194
// then excludes that event from the public garden page with `AND is_public IS TRUE`. V4-PUBHIDE-001
// removed every is_public toggle from the UI, so nothing surfaces it and nothing can undo it.
// VoiceHarvest.jsx sent `is_public: false` on every voice harvest; 16 rows were repaired by a system
// sweep on 2026-08-30 and the PRODUCER was left alone. This guard exists so a third producer cannot
// do it again quietly.
//
// WHY A SOURCE CENSUS AND NOT A BEHAVIOURAL TEST. The behavioural pin lives beside the flow it
// belongs to (VoiceHarvest.survival.test.jsx asserts the voice create body carries no such key), and
// it can only ever speak for the one path it drives. The failure mode being guarded is a NEW create
// path written months from now by someone who never read V4-PUBHIDE-001 — no behavioural test of
// today's paths can see that. The idiom is the house one: lambda/plants/grid-view.test.js censuses
// its own consumers the same way, decommenter included.
//
// THE BOUND, STATED RATHER THAN IMPLIED — this is a static scan and it can be evaded:
//   * it only reads files containing the literal '/api/events', so a producer that builds that path
//     by concatenation is invisible to it;
//   * it only sees a BOOLEAN LITERAL after the key. `is_public: eventForm.is_public`
//     (ProjectDetail.jsx:486) is deliberately NOT flagged — that is a value a human chose on a form,
//     which is a different thing from a hardcoded constant beating a server default;
//   * a value spread in from a variable (`...flags`) would not be seen at all;
//   * and it is FILE-level, not expression-level — it cannot tell a create body from a form's
//     initial value, so the pinned list below is slightly wider than the defect class and says per
//     entry which each one is.
// It catches the shape that has actually happened twice. It is not a proof of absence.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// A KEY NAMED IN A COMMENT IS NOT THAT KEY. VoiceHarvest.jsx now carries a twelve-line comment where
// the deleted line used to be — explaining why the key is absent — and a scanner that could not tell
// prose from code would read that comment as the very defect it documents. This is the exact hazard
// grid-view.test.js names, and the sibling lane tripped it for real this session: a comment in
// Search.jsx spelling out a query param made that file read as a call site to a census.
const decomment = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__') continue      // fixtures legitimately carry the key
      out.push(...sourceFiles(p))
    } else if (/\.(js|jsx)$/.test(p)) out.push(p)
  }
  return out
}

// `is_public:` followed by a boolean literal. The leading class stops `some_is_public:` matching.
const HARDCODED = /(?:^|[{,(\s])is_public\s*:\s*(?:true|false)\b/

function producersThatHardcodeIsPublic() {
  return sourceFiles(SRC_ROOT)
    .filter((f) => {
      const src = decomment(readFileSync(f, 'utf8'))
      return src.includes("'/api/events'") && HARDCODED.test(src)
    })
    .map((f) => relative(SRC_ROOT, f))
    .sort()
}

describe('BUG-EVENTPUBFALSE-001 — no create path may hardcode is_public', () => {
  it('VoiceHarvest sends no is_public key at all, in any form', () => {
    // The instance. Asserted against the decommented source so the explanatory comment that replaced
    // the line cannot satisfy — or falsify — this test.
    const src = decomment(readFileSync(resolve(SRC_ROOT, 'pages/VoiceHarvest.jsx'), 'utf8'))
    expect(src).not.toMatch(/(?:^|[{,(\s])is_public\s*:/)
    // Non-vacuity: the decommenter has not eaten the create body along with the comment.
    expect(src).toContain("event_type: 'harvest'")
    expect(src).toContain("'/api/events'")
  })

  it('the set of /api/events files carrying a hardcoded is_public is EXACTLY the three known ones', () => {
    // Every one of these is `true`, which MATCHES the Lambda default, so none is a live defect. They
    // are pinned rather than fixed because all three are other lanes' files.
    //
    // THE SCAN CANNOT TELL A CREATE BODY FROM A FORM DEFAULT, and rather than pretend otherwise the
    // list says which each one is. Two are create bodies drifting from the silent-client pattern;
    // the third is a form's initial value, which is a legitimate hardcoded default for a field a
    // human then edits. Narrowing the regex to exclude it is not possible statically — ProjectDetail's
    // factory carries `event_type` and `plant_id` beside it, exactly like a create body does.
    //
    // THIS LIST MUST ONLY EVER SHRINK. A new entry means a new create path is beating the server
    // default; if that entry sends `false` it is BUG-EVENTPUBFALSE-001 happening a third time, and
    // the fix is to DELETE the key, never to flip it to `true` (which works today and drifts again
    // the moment the default changes).
    expect(producersThatHardcodeIsPublic()).toEqual([
      'components/today/CareNeeded.jsx',   // :68  CREATE BODY — eventBody(), is_public: true
      'pages/CaptureFlow.jsx',             // :438 CREATE BODY — the 'event' branch, is_public: true
      'pages/ProjectDetail.jsx',           // :127 FORM DEFAULT — the POST at :486 sends the variable
    ])
  })

  it('the census can actually SEE a hardcoded key — the instrument is checked', () => {
    // A census that silently matched nothing would pass this file's main assertion by being blind,
    // which is the failure mode a "list is exactly X" test is most prone to. Both halves of the
    // predicate are exercised on real strings rather than trusted.
    expect(HARDCODED.test("  plant_id: x, is_public: false,")).toBe(true)
    expect(HARDCODED.test("  plant_id: x, is_public: true,")).toBe(true)
    expect(HARDCODED.test("  is_public:     eventForm.is_public,")).toBe(false)
    expect(HARDCODED.test("  some_is_public: false,")).toBe(false)
    expect(decomment("  // is_public: false, in prose")).not.toMatch(HARDCODED)
    // And the walker reaches a real depth of the tree, so an empty file list cannot pass as "clean".
    expect(sourceFiles(SRC_ROOT).length).toBeGreaterThan(100)
  })
})
