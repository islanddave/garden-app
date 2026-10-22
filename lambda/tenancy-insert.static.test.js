// The writer test (V5-SPACETENANCYKEY-001, multi-space plan V204 step 2.2, §2.4 "Writers").
//
// WHY THIS EXISTS. 2.1 gave 22 tables a workspace_id whose DEFAULT is the original Space, so every Lambda INSERT
// that does not name the column files its row in Dave's Space whoever wrote it. That is right while there is one
// Space and wrong the day there are two. This test makes every INSERT into an S table say where its row lives:
// it names workspace_id, and the value passes the slot rule (tests/lib/tenancyInsert.mjs header): the resolver's
// `scope`, a reviewed parent-row variable, or a column copied in SQL from the parent row the statement reads.
// Statements that cannot yet (their value is the request's active Space, which only 4.3's resolver supplies; R1)
// are listed in tests/tenancy-insert-allowlist.json with the lane that clears each. The list only shrinks and must
// be empty for G5. The DB-function half of the allowlist is lambda/tenancy-prosrc.static.test.js's.
//
// THE RATCHET (§2.4 "Allowlists"): per (file, function) counts, ids as the listing. An id may be REPLACED in the
// same commit when the old one leaves the same file:function and the count does not rise; the failure prints the
// replacement. A listed INSERT whose rule changes (e.g. from `missing` to a body.workspace_id value) reds too.
//
// POSITIVE CONTROLS (§2.4 Writers; row 2.2): a fixture INSERT without the column reds; one with the original
// Space's literal reds; a {text, values} INSERT taking body.workspace_id reds (N15); a new unlisted INSERT reds the
// ratchet. Accepted: ${scope.workspaceId}, an INSERT … SELECT copying the parent's column, a reviewed parent row.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadParser, censusOf } from '../tests/lib/sqlCensus.mjs'
import { loadClasses } from '../tests/lib/tenancyClasses.mjs'
import { writerFindings, ratchetProblems, loadAllowlist, sTables, sTarget, LANE_RE } from '../tests/lib/tenancyInsert.mjs'

let census, classes, allow, rows
beforeAll(async () => {
  await loadParser()
  census = censusOf()
  classes = loadClasses()
  allow = loadAllowlist()
  rows = writerFindings(census, classes, { reviewed: allow.reviewedParents })
  const refused = rows.filter((r) => r.verdict === 'refuse').length
  console.log(`[tenancy-insert] ${rows.length} INSERTs into S tables: ${rows.length - refused} stamped, ${refused} allowlisted`)
})

const SPACE_LITERAL = '00000000-0000-0000-0000-000000000001'
const fixtureRows = (code, reviewed = []) =>
  writerFindings(censusOf({ files: ['lambda/zz-fixture/writers.js'], read: () => code }), classes, { reviewed })

describe('the writer rule over lambda/**', () => {
  it('every INSERT into an S table names workspace_id from a passing value, or is allowlisted with its lane', () => {
    const problems = ratchetProblems(rows, allow)
    expect(problems, problems.join('\n') + '\n(node tests/lib/tenancyInsert.mjs --refused prints the current list)').toEqual([])
  })

  it('sees the S-table INSERTs (not blind), and the four 2.2 copy writers are stamped from their parent row', () => {
    expect(rows.length).toBeGreaterThan(25)
    const stamped = rows.filter((r) => r.verdict === 'accept').map((r) => [r.file, r.target, r.reason, r.src]).sort()
    expect(stamped).toEqual([
      ['lambda/plants/index.js', 'public.seen_event', 'sql-column', 'ln.workspace_id'],
      ['lambda/preservation/kitchenRoutes.js', 'public.preservation_log', 'sql-column', 'g.workspace_id'],
      ['lambda/preservation/recipeRoutes.js', 'public.recipe', 'sql-column', 'b.workspace_id'],
      ['lambda/projects/index.js', 'public.proj_rescope_events', 'sql-column', 'workspace_id'],
    ])
  })

  it('every allowlist entry names an S table the tree still INSERTs into, and the lane that clears it', () => {
    const s = sTables(classes)
    for (const e of allow.unstamped) {
      expect(s.has(sTarget(classes, e.target)?.base), `${e.key}: ${e.target} is not an S table`).toBe(true)
      expect(e.lane, e.key).toMatch(LANE_RE)
    }
  })
})

describe('positive controls (§2.4 Writers)', () => {
  const FIXTURE = `
export async function noColumn(sql, path, userId) {
  await sql\`INSERT INTO photos (storage_path, created_by) VALUES (\${path}, \${userId})\`
}
export async function literal(sql, path) {
  await sql\`INSERT INTO photos (storage_path, workspace_id) VALUES (\${path}, '${SPACE_LITERAL}')\`
}
export function viaValues(body, userId) {
  return { text: 'INSERT INTO favorites (user_id, workspace_id) VALUES ($1, $2)', values: [userId, body.workspace_id] }
}
export async function viaFunction(sql, path) {
  await sql\`INSERT INTO photos (storage_path, workspace_id) VALUES (\${path}, gv.sentinel_workspace())\`
}
export async function viaScope(sql, scope, path) {
  await sql\`INSERT INTO photos (storage_path, workspace_id) VALUES (\${path}, \${scope.workspaceId})\`
}
export async function viaParentSelect(sql, id) {
  await sql\`INSERT INTO seen_event (leaf_id, workspace_id) SELECT g.id, g.workspace_id FROM plants g WHERE g.id = \${id}\`
}
export async function viaUnnest(sql, paths, spaces) {
  await sql\`INSERT INTO photos (storage_path, workspace_id) SELECT u.p, u.w FROM unnest(\${paths}::text[], \${spaces}::uuid[]) AS u(p, w)\`
}
export async function viaView(sql, name) {
  await sql\`INSERT INTO garden_node (display_name) VALUES (\${name})\`
}
export async function viaParentRow(sql, parent, title) {
  await sql\`INSERT INTO tasks (title, workspace_id) VALUES (\${title}, \${parent.workspace_id})\`
}
export async function notS(sql, id) {
  await sql\`INSERT INTO event_log (plant_id, event_type) VALUES (\${id}, 'note')\`
}
`
  let fx
  const byFn = (fn) => fx.filter((r) => r.fn === fn).map((r) => [r.target, r.verdict, r.reason, r.src])
  beforeAll(() => { fx = fixtureRows(FIXTURE) })

  it('reds an INSERT without the column (it would take the DEFAULT, the original Space)', () => {
    expect(byFn('noColumn')).toEqual([['public.photos', 'refuse', 'missing', null]])
  })
  it('reds an INSERT stamping the original Space as a literal, or through a function call', () => {
    expect(byFn('literal')).toEqual([['public.photos', 'refuse', 'sql-literal', SPACE_LITERAL]])
    expect(byFn('viaFunction')).toEqual([['public.photos', 'refuse', 'sql-function', 'gv.sentinel_workspace()']])
  })
  it('reds a {text, values} INSERT whose workspace_id is body.workspace_id (N15)', () => {
    expect(byFn('viaValues')).toEqual([['public.favorites', 'refuse', 'request-root', 'body.workspace_id']])
  })
  it('reds a value copied from a row built out of request arrays (unnest)', () => {
    expect(byFn('viaUnnest')).toEqual([['public.photos', 'refuse', 'function-row', 'u.w']])
  })
  it('accepts ${scope.workspaceId} and a column copied from the parent row the statement reads', () => {
    expect(byFn('viaScope')).toEqual([['public.photos', 'accept', 'scope', 'scope.workspaceId']])
    expect(byFn('viaParentSelect')).toEqual([['public.seen_event', 'accept', 'sql-column', 'g.workspace_id']])
  })
  it('accepts a parent-row variable only once it is on the reviewed list for that file and function', () => {
    expect(byFn('viaParentRow')).toEqual([['public.tasks', 'refuse', 'unreviewed-root', 'parent.workspace_id']])
    const reviewed = [{ file: 'lambda/zz-fixture/writers.js', fn: 'viaParentRow', root: 'parent', reason: 'fixture' }]
    expect(fixtureRows(FIXTURE, reviewed).filter((r) => r.fn === 'viaParentRow').map((r) => r.verdict)).toEqual(['accept'])
    const elsewhere = [{ file: 'lambda/zz-fixture/writers.js', fn: 'viaScope', root: 'parent', reason: 'fixture' }]
    expect(fixtureRows(FIXTURE, elsewhere).filter((r) => r.fn === 'viaParentRow').map((r) => r.verdict)).toEqual(['refuse'])
  })
  it('resolves a view to its base table, and leaves a non-S table alone', () => {
    expect(fx.filter((r) => r.fn === 'viaView').map((r) => [r.target, r.base, r.reason])).toEqual([['public.garden_node', 'public.plants', 'missing']])
    expect(byFn('notS')).toEqual([])
  })

  it('reds the ratchet on a new unlisted INSERT, and names a replacement as one', () => {
    const planted = fx.filter((r) => r.fn === 'noColumn')
    const problems = ratchetProblems([...rows, ...planted], allow)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^NEW unstamped INSERT into public\.photos \(missing\) at lambda\/zz-fixture\/writers\.js:\d+ lambda\/zz-fixture\/writers\.js:noColumn:[0-9a-f]{10}>public\.photos/)
    // The same function's statement edited (new AST hash), count unchanged: a replacement, not a new INSERT.
    const listed = rows.find((r) => r.key === allow.unstamped[0].key)
    const edited = { ...listed, key: listed.key.replace(/:[0-9a-f]{10}>/, ':ffffffffff>'), id: listed.id.replace(/[0-9a-f]{10}$/, 'ffffffffff') }
    const moved = ratchetProblems([...rows.filter((r) => r !== listed), edited], allow)
    expect(moved).toEqual([`REPLACEMENT in ${listed.id.slice(0, listed.id.lastIndexOf(':'))} (count 1 <= 1): replace ${listed.key} with ${edited.key} in tests/tenancy-insert-allowlist.json`])
  })
  it('reds a listed INSERT whose rule changes, a stale entry, and an entry without its lane', () => {
    const listed = rows.find((r) => r.key === allow.unstamped[0].key)
    const worse = { ...listed, reason: 'request-root', src: 'body.workspace_id' }
    expect(ratchetProblems([...rows.filter((r) => r !== listed), worse], allow)).toEqual([
      `changed: ${listed.key} was listed as missing, is now request-root (body.workspace_id): re-review`,
    ])
    expect(ratchetProblems(rows.filter((r) => r !== listed), allow)).toEqual([`stale entry in tests/tenancy-insert-allowlist.json (now stamped or gone): ${listed.key}`])
    const noLane = { ...allow, unstamped: allow.unstamped.map((e, i) => (i === 0 ? { ...e, lane: 'later' } : e)) }
    expect(ratchetProblems(rows, noLane)).toEqual([`entry without the lane that clears it (e.g. "4.3 photos lane"): ${listed.key}`])
  })
})
