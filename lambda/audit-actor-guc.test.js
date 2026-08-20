// BUG-EVENTAUDITACTOR-001 — every write to an audited table must carry the actor GUC IN ITS OWN
// TRANSACTION.
//
// WHAT THE TRIGGERS DO. trg_audit_event_log_upd / trg_audit_harvest_log_upd (and the _del pair)
// resolve the actor as `COALESCE(NULLIF(current_setting('app.actor_clerk_sub', true), ''), 'system')`
// and are SECURITY DEFINER with `EXCEPTION WHEN OTHERS THEN RAISE WARNING` — so a missing actor
// never fails the originating statement. The defect is silent by construction: the edit succeeds,
// the audit row lands, and it says `system`. In a two-person household that erases the only fact
// the audit trail exists to record.
//
// WHY THIS GUARD IS STRUCTURAL AND NOT A STRING SCAN. The obvious test — "does
// `set_config('app.actor_clerk_sub'` appear near the UPDATE" — passes on the exact code that has
// the bug. `@neondatabase/serverless` is the HTTP driver: its own type declarations describe a bare
// tagged template as a "SQL query (no session or transactions)" and `transaction()` as the way to
// submit "multiple queries ... as a single, non-interactive Postgres transaction". Each bare
// `await sql``` is therefore one implicit transaction of its own, and a transaction-local GUC set
// in one is discarded before the next opens. Measured against prod 2026-08-20: two bare calls
// issued back to back returned now() values 283 ms apart (two transactions) and the second saw ''
// for a GUC the first had set, while two statements inside one sql.transaction([...]) returned an
// identical now() across a 200 ms pg_sleep and the second saw the value the first set.
//
// So the property under test is GROUPING, not presence: the set_config and the audited write must
// be elements of the SAME sql.transaction([...]) batch, with the set_config at index 0. Asserted
// off a real acorn AST rather than by regex, matching lambda-source-parses.test.js and
// src/__tests__/clientRouteLambdaContract.test.js — a regex cannot tell "element 0 of the array
// passed to sql.transaction" from "a line that happens to sit above the UPDATE", which is precisely
// the distinction between the fix and the bug.

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
    else if (extname(entry) === '.js' && !/\.test\.js$/.test(entry)) out.push(p)
  }
  return out
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walkAst(n, visit); return }
  if (typeof node.type === 'string') visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range') continue
    walkAst(node[key], visit)
  }
}

// Interpolations collapse to ` ? ` so a bind can never fuse two SQL identifiers into one token.
const sqlText = (n) => n.quasi.quasis.map((q) => q.value.raw).join(' ? ')
const isSqlTemplate = (n) =>
  n.type === 'TaggedTemplateExpression' && n.tag.type === 'Identifier' && n.tag.name === 'sql'
const isSqlTransaction = (n) =>
  n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
  n.callee.object.type === 'Identifier' && n.callee.object.name === 'sql' &&
  n.callee.property.type === 'Identifier' && n.callee.property.name === 'transaction'

// Direct DML against the two statement-level-audited tables …
const AUDITED_DML = /\b(update|delete\s+from)\s+(only\s+)?(public\.)?(event_log|harvest_log)\b/is
// … plus the four prod functions whose bodies mutate them. archive_events_subset soft-deletes the
// merge drop set, which writes event_log.deleted_at — a watched column — so a call to it is an
// audited write even though no `UPDATE event_log` string appears at the call site.
const AUDITED_FN = /\b(archive_events_subset|archive_plant_events|archive_container_events|unarchive_events_apply)\s*\(/i
const isAuditedWrite = (n) => isSqlTemplate(n) && (AUDITED_DML.test(sqlText(n)) || AUDITED_FN.test(sqlText(n)))

// Binds the actor rather than hardcoding it, and is transaction-local (`true`) so it cannot leak
// onto a pooled connection and mis-attribute somebody else's write.
const SET_CONFIG = /set_config\(\s*'app\.actor_clerk_sub'\s*,\s*\?\s*,\s*true\s*\)/
const isSetConfig = (n) => isSqlTemplate(n) && SET_CONFIG.test(sqlText(n))

const FILES = walkFiles(LAMBDA).map((f) => relative(ROOT, f))

// ── Model every sql.transaction() call site in lambda/ ─────────────────────────────────────────
// A group is `{ file, line, element0, members }`. `members` is every statement the batch executes;
// `element0` is the statement that executes FIRST, which is the only position where a
// transaction-local GUC does any good.
function groupsIn(rel) {
  const code = readFileSync(join(ROOT, rel), 'utf8')
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const groups = []
  const txCalls = []
  walkAst(ast, (n) => { if (isSqlTransaction(n)) txCalls.push(n) })

  for (const call of txCalls) {
    const arg = call.arguments[0]
    if (!arg) continue
    if (arg.type === 'ArrayExpression') {
      groups.push({ file: rel, line: call.loc.start.line, kind: 'literal',
                    element0: arg.elements[0] ?? null, members: arg.elements.filter(Boolean) })
      continue
    }
    if (arg.type !== 'Identifier') { groups.push({ file: rel, line: call.loc.start.line, kind: 'opaque', element0: null, members: [] }); continue }

    // Array-variable form (`reanchor`, `stmts`, `_stmts`, `statements`): the batch is assembled by
    // an initializer plus push/unshift. Execution-time element 0 is the last unshift that runs
    // before the transaction, else the initializer's first element.
    const name = arg.name
    let init = null
    const unshifts = []
    const members = []
    walkAst(ast, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name &&
          n.init?.type === 'ArrayExpression') {
        init = n.init
        members.push(...n.init.elements.filter(Boolean))
      }
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
          n.callee.object.type === 'Identifier' && n.callee.object.name === name &&
          n.callee.property.type === 'Identifier' &&
          (n.callee.property.name === 'push' || n.callee.property.name === 'unshift')) {
        members.push(...n.arguments)
        if (n.callee.property.name === 'unshift' && n.start < call.start) unshifts.push(n)
      }
    })
    const lastUnshift = unshifts.sort((a, b) => a.start - b.start).at(-1)
    groups.push({ file: rel, line: call.loc.start.line, kind: 'variable',
                  element0: lastUnshift ? lastUnshift.arguments[0] : (init?.elements[0] ?? null),
                  members })
  }
  return groups
}

const GROUPS = FILES.flatMap(groupsIn)
const AUDITING_GROUPS = GROUPS.filter((g) => g.members.some(isAuditedWrite))

// Every audited-write template that some transaction batch is responsible for executing.
const COVERED = new Set()
for (const g of AUDITING_GROUPS) for (const m of g.members) if (isAuditedWrite(m)) COVERED.add(`${g.file}@${m.start}`)

// Every audited-write template that exists at all, wherever it is written.
const ALL_AUDITED = FILES.flatMap((rel) => {
  const ast = acorn.parse(readFileSync(join(ROOT, rel), 'utf8'),
                          { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const out = []
  walkAst(ast, (n) => { if (isAuditedWrite(n)) out.push({ file: rel, line: n.loc.start.line, start: n.start, text: sqlText(n) }) })
  return out
})

// The ONE audited write that is neither executed nor batched where it is written: merge.js's
// repoint is built in plantMemoryRepoint.js and handed back as an object property for the caller to
// put in ITS transaction. Exempt here, and the handoff is closed by the named merge.js test below
// — remove that test and this exemption becomes a hole.
const DEFERRED_TO_CALLER = new Set(['lambda/plants/plantMemoryRepoint.js'])

describe('BUG-EVENTAUDITACTOR-001 — actor GUC shares a transaction with every audited write', () => {
  // ── anti-vacuity ────────────────────────────────────────────────────────────────────────────
  // Each assertion below is over a derived set. If a refactor renamed `sql` or moved the Lambdas,
  // every set would be empty and every assertion would pass while proving nothing.
  it('found the Lambda sources, the transaction batches and the audited writes', () => {
    expect(FILES.length).toBeGreaterThan(60)
    expect(FILES).toContain('lambda/events/index.js')
    expect(FILES).toContain('lambda/plants/merge.js')
    expect(GROUPS.length).toBeGreaterThanOrEqual(14)
    expect(GROUPS.some((g) => g.kind === 'variable')).toBe(true)
    // 8 direct DML sites in events/index.js + the merge repoint + archive_events_subset.
    expect(ALL_AUDITED.length).toBeGreaterThanOrEqual(10)
    expect(AUDITING_GROUPS.length).toBeGreaterThanOrEqual(6)
  })

  it('the set_config matcher rejects the shapes that would defeat the trigger', () => {
    const mk = (raw) => ({ type: 'TaggedTemplateExpression', tag: { type: 'Identifier', name: 'sql' },
                           quasi: { quasis: [{ value: { raw } }] } })
    expect(isSetConfig(mk("SELECT set_config('app.actor_clerk_sub',  ? , true)"))).toBe(true)
    // session-scoped: survives the batch and can mis-attribute the next user of the connection
    expect(isSetConfig(mk("SELECT set_config('app.actor_clerk_sub',  ? , false)"))).toBe(false)
    // hardcoded actor: satisfies NOT NULL, useless forensically
    expect(isSetConfig(mk("SELECT set_config('app.actor_clerk_sub', 'system', true)"))).toBe(false)
    expect(isSetConfig(mk('UPDATE event_log el SET event_type =  ? '))).toBe(false)
    expect(isAuditedWrite(mk('UPDATE event_log el SET event_type =  ? '))).toBe(true)
    expect(isAuditedWrite(mk('SELECT archive_events_subset( ? ::uuid[],  ? ,  ? )'))).toBe(true)
    expect(isAuditedWrite(mk('SELECT id FROM event_log WHERE id =  ? '))).toBe(false)
  })

  // ── the core property ───────────────────────────────────────────────────────────────────────
  it.each(AUDITING_GROUPS.map((g) => [`${g.file}:${g.line}`, g]))(
    'sql.transaction at %s writes an audited table, so its first statement sets the actor GUC',
    (_label, g) => {
      expect(g.element0).not.toBeNull()
      expect(g.element0 && isSetConfig(g.element0) ? 'set_config' : sqlText(g.element0).trim().slice(0, 70))
        .toBe('set_config')
    },
  )

  it('no audited write is issued outside a transaction batch', () => {
    const stray = ALL_AUDITED
      .filter((w) => !COVERED.has(`${w.file}@${w.start}`) && !DEFERRED_TO_CALLER.has(w.file))
      .map((w) => `${w.file}:${w.line}  ${w.text.trim().replace(/\s+/g, ' ').slice(0, 80)}`)
    expect(stray).toEqual([])
  })

  // ── the five paths this ticket repaired, named so a failure says WHICH one regressed ────────
  const site = (file, needle) => {
    const g = AUDITING_GROUPS.find((x) => x.file === file && x.members.some((m) => isAuditedWrite(m) && sqlText(m).includes(needle)))
    return g
  }

  it.each([
    ['PUT /api/events/:id — event_log', 'lambda/events/index.js', 'UPDATE event_log el\n             SET event_type'],
    ['PUT /api/events/:id — harvest_log', 'lambda/events/index.js', 'UPDATE harvest_log h\n               SET quantity'],
    ['PUT /api/events/:id — harvest re-anchor', 'lambda/events/index.js', 'UPDATE harvest_log hl SET project_id'],
    ['PATCH /api/events/:id — resolve', 'lambda/events/index.js', 'SET resolved_at = COALESCE'],
    ['POST /api/plants/merge — drop-set archive', 'lambda/plants/merge.js', 'archive_events_subset'],
  ])('%s is batched with the actor GUC', (_name, file, needle) => {
    const g = site(file, needle)
    expect(g, 'no sql.transaction batch executes this statement').toBeTruthy()
    expect(isSetConfig(g.element0)).toBe(true)
  })

  // Closes the plantMemoryRepoint exemption above: the repoint template is only safe because
  // merge.js puts it in the batch whose element 0 is the GUC.
  it('the plant-merge repoint is a member of the merge transaction, not a loose statement', () => {
    const ast = acorn.parse(readFileSync(join(ROOT, 'lambda/plants/merge.js'), 'utf8'),
                            { ecmaVersion: 'latest', sourceType: 'module', locations: true })
    let found = false
    walkAst(ast, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.name === 'stmts' && n.init?.type === 'ArrayExpression') {
        found = n.init.elements.some((e) => e?.type === 'MemberExpression' &&
          e.object.type === 'Identifier' && e.object.name === 'memory' && e.property.name === 'repoint')
        expect(isSetConfig(n.init.elements[0])).toBe(true)
      }
    })
    expect(found, 'memory.repoint is no longer an element of merge.js stmts').toBe(true)
    // And the repoint really is the event_log write we think it is.
    const repoint = readFileSync(join(ROOT, 'lambda/plants/plantMemoryRepoint.js'), 'utf8')
    expect(repoint).toMatch(/repoint:\s*sql`UPDATE event_log SET plant_id/)
  })
})
