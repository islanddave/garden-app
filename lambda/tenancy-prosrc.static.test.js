// GUARD: security (OPS-SECREVIEW-001 do-not-remove list)
// The prosrc census test (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.2, §2.4 "Writers", DSA-21, MF1).
//
// WHY THIS EXISTS. Database functions and triggers INSERT rows too, and a function INSERT into an S table that does
// not name workspace_id files its row in the original Space (2.1's DEFAULT) whoever the parent belongs to. CI has
// no database, so scripts/tenancy-prosrc-census.py reads every public/gv function body read-only and commits what
// it found (tests/tenancy-prosrc.prod.json). This test holds that census, the class file and the decisions
// (tests/tenancy-prosrc-decisions.json) equal:
//   * the census is honest: each committed body hashes to its md5 and re-analyses to the committed INSERT rows,
//     nothing unparsed, no dynamic INSERT (EXECUTE) it cannot see;
//   * every S table in lambda/tenancy-classes.json (and entity) has a decision, so an S table added to the class
//     file without one reds; every function INSERT into one has a writer decision: stamped from its parent row,
//     rewritten by a named migration file (whose body is checked here), or allowlisted with the lane that clears it.
// The allowlisted decisions are the DB-function half of the writer allowlist (lambda/tenancy-insert.static.test.js
// holds the Lambda half). The DEFAULT-reliant count printed below is 5.7's G2 precondition: it must reach 0.
//
// RE-RUN the census after any migration that creates or replaces a public/gv function (sitting order: after prod):
//   NEON_DATABASE_URL=... python3 scripts/tenancy-prosrc-census.py
// then this test names every INSERT that lacks a decision, or a rewritten body that did not land as written.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../tests/lib/sqlCensus.mjs'
import { loadClasses } from '../tests/lib/tenancyClasses.mjs'
import {
  loadParser, md5, insertsOfBody, tenancyWriters, defaultReliant, decisionProblems, CENSUS_FILE, DECISIONS_FILE,
} from '../tests/lib/prosrcCensus.mjs'

const json = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'))
const read = (f) => readFileSync(join(ROOT, f), 'utf8')
let census, decisions, classes
beforeAll(async () => {
  await loadParser()
  census = json(CENSUS_FILE)
  decisions = json(DECISIONS_FILE)
  classes = loadClasses()
  const w = tenancyWriters(census, classes)
  console.log(`[tenancy-prosrc] ${census.env}: ${census.functions.length} functions, ${w.length} S-table/entity writers, ` +
    `${defaultReliant(w).length} DEFAULT-reliant INSERT(s): ${defaultReliant(w).join(', ')}`)
})

describe('the committed census is honest', () => {
  it('every committed body hashes to its md5 and re-analyses to the committed INSERT rows', () => {
    const bad = []
    for (const f of census.functions) {
      if (!/^[0-9a-f]{32}$/.test(f.md5)) bad.push(`${f.function}: md5 ${f.md5}`)
      if (f.src == null) continue
      if (md5(f.src) !== f.md5) bad.push(`${f.function}: body md5 ${md5(f.src)}, census says ${f.md5}`)
      const now = insertsOfBody(f.src)
      if (JSON.stringify([now.inserts, now.dynamic]) !== JSON.stringify([f.inserts, f.dynamic]))
        bad.push(`${f.function}: the analyser now reads ${JSON.stringify(now)}; re-run scripts/tenancy-prosrc-census.py`)
    }
    expect(bad, bad.join('\n')).toEqual([])
    expect(census.functions.length, 'the census holds almost no functions: it read the wrong schemas').toBeGreaterThan(40)
  })
  it('reads every INSERT (none unparsed) and holds no dynamic INSERT it cannot see', () => {
    const unparsed = census.functions.flatMap((f) => (f.inserts ?? []).filter((i) => i.unparsed).map((i) => `${f.function} -> ${i.target}`))
    const dynamic = census.functions.flatMap((f) => (f.dynamic ?? []).map((d) => `${f.function}: ${d}`))
    expect(unparsed, unparsed.join('\n')).toEqual([])
    expect(dynamic, dynamic.join('\n')).toEqual([])
  })
  it('lists the autocapture INSERT (v4-cal1-slicec-001/0f-autocapture.sql:94-98) into cultivar_weight_sample', () => {
    const f = census.functions.find((x) => x.function.startsWith('public.record_harvest_weight_sample('))
    expect(f.inserts.map((i) => [i.target, i.workspace.named])).toEqual([['public.cultivar_weight_sample', false]])
    const lines = read('migrations/v4-cal1-slicec-001/0f-autocapture.sql').split('\n').slice(93, 98).join('\n')
    expect(lines).toMatch(/^\s*INSERT INTO public\.cultivar_weight_sample/)
    const squash = (s) => s.replace(/\s+/g, ' ').trim()
    expect(squash(f.src)).toContain(squash(lines))
  })
})

describe('census, decisions and class file agree', () => {
  it('every S table has a decision, and every function INSERT into one (or into entity) has a writer decision', () => {
    const problems = decisionProblems(census, decisions, classes, read)
    expect(problems, problems.join('\n')).toEqual([])
  })
})

describe('positive controls', () => {
  const clone = (x) => JSON.parse(JSON.stringify(x))
  it('reds an S table added to the class file with no census decision', () => {
    const c = clone(classes)
    c.relations['public.zz_new_table'] = { kind: 'r', class: 'S has key', column: 'workspace_id', notnull: true }
    expect(decisionProblems(census, decisions, c, read)).toEqual([
      `S table public.zz_new_table has no census decision: add it to ${DECISIONS_FILE} (writers [] if no function writes it)`,
    ])
  })
  it('reds a function INSERT with no decision (the autocapture writer unlisted, or a table re-classed S)', () => {
    const d = clone(decisions)
    d.tables['public.cultivar_weight_sample'].writers = d.tables['public.cultivar_weight_sample'].writers.filter((w) => !w.function.startsWith('public.record_harvest_weight_sample('))
    expect(decisionProblems(census, d, classes, read)).toEqual([
      'function INSERT into public.cultivar_weight_sample with no decision: public.record_harvest_weight_sample(p_event_id uuid, p_plant_id uuid, p_unit text, p_qty numeric, p_grams numeric, p_user text) (stamp it from its parent row, or allowlist it with its lane)',
    ])
    const c = clone(classes)
    c.relations['public.event_log'] = { kind: 'r', class: 'S has key', column: 'workspace_id', notnull: true }
    const p = decisionProblems(census, decisions, c, read)
    expect(p).toContain(`S table public.event_log has no census decision: add it to ${DECISIONS_FILE} (writers [] if no function writes it)`)
    expect(p.some((x) => x.startsWith('function INSERT into public.event_log with no decision: public.unarchive_events_apply('))).toBe(true)
  })
  it('reds a rewrite whose file drops the stamp (the body would leave the child on the DEFAULT)', () => {
    const file = 'migrations/v5-tenancystamp-001/01-void-event-weight-samples.sql'
    const dropped = read(file).replace('created_by, workspace_id)', 'created_by)').replace('p_user, s.workspace_id', 'p_user')
    expect(dropped).not.toBe(read(file))
    const p = decisionProblems(census, decisions, classes, (f) => (f === file ? dropped : read(f)))
    expect(p.some((x) => x.includes(`${file}'s INSERT into public.cultivar_weight_void does not name workspace_id from s.workspace_id`))).toBe(true)
    expect(p.some((x) => x.includes(`${file}'s body md5 is`))).toBe(true)
  })
  it('reds a census that shows the rewritten body not stamping, an unknown body, and an allowlist entry with no lane', () => {
    const c = clone(census)
    const f = c.functions.find((x) => x.function.startsWith('public.void_event_weight_samples('))
    f.md5 = '886bb851e921341bc2d3af0f89f9c718'
    expect(decisionProblems(c, decisions, classes, read)).toEqual([
      'public.cultivar_weight_void public.void_event_weight_samples(p_event_id uuid, p_user text, p_reason text): the census shows the rewritten body (886bb851e921341bc2d3af0f89f9c718) not naming workspace_id from s.workspace_id',
    ])
    f.md5 = '0'.repeat(32)
    expect(decisionProblems(c, decisions, classes, read)[0]).toMatch(/census body md5 0{32} is neither cc33df74a8d622bebe772002210f836e/)
    const d = clone(decisions)
    d.tables['public.entity'].writers[0].lane = 'later'
    expect(decisionProblems(census, d, classes, read)).toEqual(['public.entity gv.entity_cultivar_ins(): an allowlisted writer names the lane that clears it (e.g. "2.6 lane")'])
  })
})
