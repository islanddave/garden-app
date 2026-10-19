// The SQL census in CI (V5-SPACEISOLATION-001, multi-space plan V204 step 2.0a, §2.4 "The SQL census").
//
// WHY THIS EXISTS. Isolating Spaces means proving every SQL statement in the Lambdas is scoped, and the later
// rules that prove it (2.2's writer test, 5.1's scope test, 2.0e's keys test) are only as good as the list of
// statements they are handed. tests/lib/sqlCensus.mjs builds that list with the real PostgreSQL 17 parser; this
// file keeps the list honest. It fails when:
//   1. any SQL literal does not parse (unparseable > 0): a statement the rules cannot see;
//   2. a near-miss (an SQL verb with no SQL structure, e.g. the HTTP method 'DELETE') is not in
//      tests/sql-near-misses.json, or an entry there is stale: so nothing is dropped silently;
//   3. a splice (an untagged template whose `${}` was inlined from a const or repaired, so the parsed text is
//      only one variant of what runs) is not in tests/sql-splices.json, or an entry there is stale or changed;
//   4. the per-file count of sql`…` templates, counted in the raw text with no parser, differs from the census's
//      count of sql-tagged literals: the one signal that the extractor itself went blind.
// And it holds the workspace_id slot allowlist (tests/sql-workspace-slots.json): every value bound to
// workspace_id that the slot rule refuses is listed by statement id with a reason, and the list only shrinks.
//
// THE LISTS. Ids are scheme B (`<file>:<function path>:<AST md5>[#k]`, sqlCensus.mjs header), so whitespace,
// comments and unrelated statements never move them. To re-list after a change, print what the tree holds:
//   node tests/lib/sqlCensus.mjs --near-misses | --splices | --ws-slots
// and carry each `reason` / `why` over by hand: the printer cannot know one.
//
// THE RATCHET (§2.4 "Allowlists"). An id may be REPLACED in the same commit when the old id leaves the same
// file:function and that function's count does not rise; the failure message prints the replacement. A new
// refused slot (a count that rises) needs a reviewed reason; a new unstamped write before its 4.3 lane is allowed
// only with one.
//
// POSITIVE CONTROLS (the `slot map` and `extractor` blocks): critterAward's SENTINEL_WORKSPACE slot is refused
// and allowlisted until the events 4.3 lane; `${body.workspace_id}` is refused; `${scope.workspaceId}` is
// accepted; workspace_id only in a target list is flagged for the scope rule; a statement planted in
// findings/materialize.js's {text, values} shape is found; a whitespace-only rewrite of every template moves no id.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as acorn from 'acorn'
import {
  ROOT, loadParser, censusOf, lambdaFiles, splicesOf, workspaceSlotsOf, classifySlot, targetOnlyWorkspace, relationsOf,
} from '../tests/lib/sqlCensus.mjs'
import { parseSync } from 'libpg-query'

const listed = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', name), 'utf8'))
const read = (f) => readFileSync(join(ROOT, f), 'utf8')

let census
beforeAll(async () => {
  await loadParser()
  census = censusOf()
  const s = census.summary
  console.log(`[sql-census] ${s.files.nonTest} files, ${s.candidates} candidates, ${s.statementLiterals.parsedStatements} ` +
    `statements parsed, ${s.unparseable} unparseable, ${s.onConflict.statements} ON CONFLICT, ${s.nearMisses} near-misses, ` +
    `${s.statementLiterals.withSplices} spliced, ${s.ms.total} ms`)
})

// Exact-set comparison of current ids against a listed file; returns the failure lines.
function compareIds(current, entries, what, file) {
  const have = new Set(current)
  const want = new Set(entries.map((e) => e.id))
  return [
    ...[...have].filter((id) => !want.has(id)).map((id) => `${what} not in tests/${file}: ${id}`),
    ...[...want].filter((id) => !have.has(id)).map((id) => `stale entry in tests/${file} (the tree no longer has it): ${id}`),
  ]
}

describe('SQL census: the four CI conditions', () => {
  it('parses every JS file and every SQL literal in non-test lambda/**', () => {
    expect(census.jsErrors, 'acorn could not parse these files, so the census cannot see their SQL').toEqual([])
    const bad = census.records.filter((r) => r.status === 'unparseable' || r.status === 'fragment-unparsed')
      .map((r) => `${r.file}:${r.line} (${r.fn}) ${r.error ?? 'fragment fits no host statement'}${r.errAt ? ` near "${r.errAt}"` : ''}`)
    expect(bad, 'unparseable SQL: fix the literal, or teach sqlCensus.mjs the shape\n' + bad.join('\n')).toEqual([])
    expect(census.statements.length, 'the census found almost no SQL: the walk is broken').toBeGreaterThan(500)
  })

  it('lists every near-miss in tests/sql-near-misses.json, and nothing stale', () => {
    const problems = compareIds(census.nearMisses.map((m) => m.id), listed('sql-near-misses.json').nearMisses, 'near-miss', 'sql-near-misses.json')
    expect(problems, problems.join('\n') + '\n(node tests/lib/sqlCensus.mjs --near-misses prints the current list)').toEqual([])
  })

  it('lists every splice in tests/sql-splices.json with its reason, and nothing stale or changed', () => {
    const entries = listed('sql-splices.json').splices
    const now = splicesOf(census)
    const problems = compareIds(now.map((s) => s.id), entries, 'splice', 'sql-splices.json')
    for (const s of now) {
      const e = entries.find((x) => x.id === s.id)
      if (!e) continue
      if (!e.reason?.trim()) problems.push(`splice without a reason in tests/sql-splices.json: ${s.id}`)
      if (JSON.stringify([e.inlined, e.repaired]) !== JSON.stringify([s.inlined, s.repaired]))
        problems.push(`splice changed, re-review: ${s.id} now inlines ${JSON.stringify(s.inlined)} and repairs ${JSON.stringify(s.repaired)}`)
    }
    expect(problems, problems.join('\n') + '\n(node tests/lib/sqlCensus.mjs --splices prints the current list)').toEqual([])
  })

  it('counts as many sql-tagged literals per file as the raw text holds sql`…` templates', () => {
    const files = new Set([...Object.keys(census.tagTextCount).filter((f) => census.tagTextCount[f]), ...Object.keys(census.tagCensusCount)])
    const diff = [...files].sort().filter((f) => (census.tagTextCount[f] ?? 0) !== (census.tagCensusCount[f] ?? 0))
      .map((f) => `${f}: ${census.tagTextCount[f] ?? 0} sql\` in the text, ${census.tagCensusCount[f] ?? 0} in the census`)
    expect(diff, 'the census missed (or invented) sql-tagged literals: the extractor went blind here\n' + diff.join('\n')).toEqual([])
    expect(files.size).toBeGreaterThan(50)
  })
})

describe('SQL census: the workspace_id slot allowlist', () => {
  it('lists every refused workspace_id value by id with a reason; the list only shrinks', () => {
    const entries = listed('sql-workspace-slots.json').refused
    const refused = workspaceSlotsOf(census).filter((r) => r.verdict === 'refuse')
    const have = new Set(refused.map((r) => r.id))
    const want = new Set(entries.map((e) => e.id))
    const problems = []
    const fnOf = (id) => id.slice(0, id.lastIndexOf(':'))
    for (const r of refused.filter((x) => !want.has(x.id))) {
      const key = fnOf(r.id)
      const gone = [...want].filter((id) => fnOf(id) === key && !have.has(id))
      const countNow = [...have].filter((id) => fnOf(id) === key).length
      const countListed = [...want].filter((id) => fnOf(id) === key).length
      problems.push(gone.length && countNow <= countListed
        ? `REPLACEMENT in ${key} (count ${countNow} <= ${countListed}): replace ${gone[0]} with ${r.id} in tests/sql-workspace-slots.json`
        : `NEW refused workspace_id value (${r.reason}, ${r.ctx} ${r.src}) in ${r.id}: stamp it from the resolved scope or a reviewed parent row`)
    }
    for (const id of [...want].filter((x) => !have.has(x))) if (!problems.some((p) => p.includes(id))) problems.push(`stale entry in tests/sql-workspace-slots.json (now accepted or gone): ${id}`)
    for (const e of entries) if (!e.reason?.trim()) problems.push(`entry without a reason: ${e.id}`)
    expect(problems, problems.join('\n')).toEqual([])
  })
})

// Fixture statements run through the same census as the tree: `read` serves them under a lambda path.
const fixtureCensus = (file, code) => censusOf({ files: [file], read: () => code })
const wsOf = (c) => workspaceSlotsOf(c)

describe('SQL census: slot-map positive controls', () => {
  it('refuses critterAward\'s ${SENTINEL_WORKSPACE} slot, allowlisted by id until the events 4.3 lane', () => {
    const rows = wsOf(census).filter((r) => r.file === 'lambda/events/critterAward.js')
    expect(rows.map((r) => [r.src, r.ctx, r.verdict, r.reason])).toEqual([['SENTINEL_WORKSPACE', 'insert', 'refuse', 'string-const']])
    const entry = listed('sql-workspace-slots.json').refused.find((e) => e.id === rows[0].id)
    expect(entry, `${rows[0].id} must be allowlisted in tests/sql-workspace-slots.json`).toBeTruthy()
    expect(entry.reason).toMatch(/until the events 4\.3 lane/)
    const stmt = census.statements.find((s) => s.id === rows[0].id)
    const p = stmt.params.find((x) => x.src === 'SENTINEL_WORKSPACE')
    expect([p.n, p.origin, p.kind, p.constString, p.columns]).toEqual([1, 'tag', 'Identifier', true, [{ ctx: 'insert', column: 'workspace_id' }]])
  })

  const SLOTS = `
const SPACE = 'not-a-real-space'
export async function viaBody(sql, body) {
  await sql\`INSERT INTO photos (workspace_id, url) VALUES (\${body.workspace_id}, \${body.url})\`
}
export async function viaScope(sql, scope, url) {
  await sql\`INSERT INTO photos (workspace_id, url) VALUES (\${scope.workspaceId}, \${url})\`
}
export async function viaQuery(sql, event) {
  await sql\`SELECT id FROM plants WHERE workspace_id = \${event.queryStringParameters.space}\`
}
export async function viaConst(sql) {
  await sql\`UPDATE plants SET workspace_id = \${SPACE} WHERE id = 1\`
}
export function viaValues(body) {
  return { text: 'INSERT INTO photos (url, workspace_id) VALUES ($1, $2)', values: [body.url, body.workspace_id] }
}
export async function targetOnly(sql, id) {
  return sql\`SELECT id, workspace_id FROM plants WHERE id = \${id}\`
}
export async function scoped(sql, scope, id) {
  return sql\`SELECT id, workspace_id FROM plants WHERE id = \${id} AND workspace_id = \${scope.workspaceId}\`
}
`
  let fx
  const byFn = (fn) => wsOf(fx).filter((r) => r.fn === fn).map((r) => [r.src, r.verdict, r.reason])
  beforeAll(() => { fx = fixtureCensus('lambda/zz-fixture/slots.js', SLOTS) })

  it('refuses ${body.workspace_id}', () => {
    expect(byFn('viaBody')).toEqual([['body.workspace_id', 'refuse', 'request-root']])
  })
  it('refuses a {text, values} INSERT whose workspace_id value is body.workspace_id (N15 shape)', () => {
    expect(byFn('viaValues')).toEqual([['body.workspace_id', 'refuse', 'request-root']])
  })
  it('refuses event.queryStringParameters and a string const', () => {
    expect(byFn('viaQuery')).toEqual([['event.queryStringParameters.space', 'refuse', 'request-root']])
    expect(byFn('viaConst')).toEqual([['SPACE', 'refuse', 'string-const']])
  })
  it('accepts ${scope.workspaceId}, and a parent row only once it is on the reviewed list', () => {
    expect(byFn('viaScope')).toEqual([['scope.workspaceId', 'accept', 'scope']])
    const winner = { origin: 'tag', src: 'winner.workspace_id', kind: 'MemberExpression', root: 'winner', path: 'winner.workspace_id', constString: false }
    expect(classifySlot(winner).verdict).toBe('refuse')
    expect(classifySlot(winner, { reviewedParents: ['winner'] })).toEqual({ verdict: 'accept', reason: 'reviewed-parent' })
  })
  it('flags workspace_id only in a target list for the scope rule, and not once a predicate scopes it', () => {
    const flag = (fn) => fx.statements.filter((s) => s.fn === fn).map((s) => targetOnlyWorkspace(s.placement))
    expect(flag('targetOnly')).toEqual([true])
    expect(flag('scoped')).toEqual([false])
  })
  it('subtracts CTE names per statement, within the WITH scope only', () => {
    const rel = (q) => relationsOf(parseSync(q).stmts[0].stmt)
    expect(rel('WITH x AS (SELECT 1 FROM plants) SELECT * FROM x JOIN public.x ON true')).toEqual({ relations: ['plants', 'public.x'], ctes: ['x'] })
    expect(rel('SELECT * FROM (WITH x AS (SELECT 1) SELECT * FROM x) a, x').relations).toEqual(['x'])
    expect(rel('WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a, b').relations).toEqual(['b'])
  })
})

describe('SQL census: extractor positive controls', () => {
  it('finds a statement planted in findings/materialize.js\'s {text, values} shape', () => {
    const file = 'lambda/findings/materialize.js'
    const PROBE = `
export function buildPlantProbe(plantId) {
  return { text: \`
SELECT p.id, p.name, p.status
  FROM public.plants p
 WHERE p.id = $1 AND p.deleted_at IS NULL\`, values: [plantId] };
}
`
    const base = fixtureCensus(file, read(file))
    const planted = fixtureCensus(file, read(file) + PROBE)
    expect(base.statements.some((s) => s.relations.includes('public.plants'))).toBe(false)
    const baseIds = new Set(base.statements.map((s) => s.id))
    const added = planted.statements.filter((s) => !baseIds.has(s.id))
    expect(planted.statements.filter((s) => baseIds.has(s.id)).length).toBe(base.statements.length)
    expect(added.map((s) => [s.id.replace(/:[0-9a-f]{10}$/, ''), s.record.kind, s.type, s.relations])).toEqual([
      [`${file}:buildPlantProbe`, 'template', 'SelectStmt', ['public.plants']],
    ])
    expect(added[0].params.map((p) => [p.n, p.origin, p.src])).toEqual([[1, 'values', 'plantId']])
  })

  it('moves no id under a whitespace-only rewrite of every template (and 3 blank lines atop every file)', () => {
    let changed = 0
    const rewritten = censusOf({
      read: (f) => {
        const out = rewriteTemplateWhitespace(read(f))
        if (out.changed) changed++
        return '\n\n\n' + out.code
      },
    })
    expect(changed, 'the rewrite touched almost nothing: the control is vacuous').toBeGreaterThan(100)
    const before = census.statements.map((s) => s.id).sort()
    const after = rewritten.statements.map((s) => s.id).sort()
    expect(after.length).toBe(before.length)
    expect(after.filter((id, i) => id !== before[i])).toEqual([])
    expect(rewritten.nearMisses.map((m) => m.id).sort()).toEqual(census.nearMisses.map((m) => m.id).sort())
    // and the lines did move, so the ids really carry none
    expect(rewritten.statements.find((s) => s.id === census.statements[0].id).line).not.toBe(census.statements[0].line)
  })
})

// Whitespace-only rewrite of every template literal's text: outside SQL strings ('…', "…") and -- comments,
// each whitespace run becomes a different run (a newline kept as a newline). The SQL is the same SQL.
function rewriteTemplateWhitespace(code) {
  let ast
  try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }) } catch {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true })
  }
  const templates = []
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'TemplateLiteral') templates.push(n)
    for (const k in n) {
      const v = n[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(ast)
  const edits = []
  for (const t of templates) {
    let state = null // null | "'" | '"' | '--'
    for (const q of t.quasis) {
      const raw = code.slice(q.start, q.end)
      let out = ''
      for (let i = 0; i < raw.length;) {
        const ch = raw[i]
        if (state === '--') { out += ch; if (ch === '\n') state = null; i++; continue }
        if (state) { out += ch; if (ch === state) state = null; i++; continue }
        if (ch === "'" || ch === '"') { state = ch; out += ch; i++; continue }
        if (ch === '-' && raw[i + 1] === '-') { state = '--'; out += '--'; i += 2; continue }
        if (/\s/.test(ch)) {
          let j = i
          while (j < raw.length && /\s/.test(raw[j])) j++
          out += raw.slice(i, j).includes('\n') ? '\n\t \n   ' : '  \t'
          i = j
          continue
        }
        out += ch
        i++
      }
      if (out !== raw) edits.push([q.start, q.end, out])
    }
  }
  let next = code
  for (const [a, b, s] of edits.sort((x, y) => y[0] - x[0])) next = next.slice(0, a) + s + next.slice(b)
  return { code: next, changed: edits.length > 0 }
}

// Not a control: the file set is what the header says (180 files at 2f238983, none of them tests).
it('walks only non-test lambda files', () => {
  const files = lambdaFiles()
  expect(files.every((f) => f.startsWith('lambda/') && !/\.test\.|\/_test-stubs\/|\/__tests__\//.test(f))).toBe(true)
  expect(files.length).toBe(census.summary.files.nonTest)
})
