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
import { withActor } from './audit-actor.js'

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

// Direct DML against the statement-level-audited tables … preservation_log joined in Put-Up release
// 1b (v5-putupmake-001 attaches trg_audit_preservation_log_upd; V4 "Audit": "preservation_log joins
// AUDITED_DML").
// Release F (v5-fermentpath-001) attaches statement-level audit triggers to kitchen_batch_input
// (audit_stmt_update) and kitchen_stage_log (audit_stmt_update_no_soft_delete); a pick line's hard
// DELETE is batched too (06 §3.7: "so audit-actor-guc.test.js stays green").
const AUDITED_DML = /\b(update|delete\s+from)\s+(only\s+)?(public\.)?(event_log|harvest_log|preservation_log|kitchen_batch_input|kitchen_stage_log)\b/is
// … plus the four prod functions whose bodies mutate them. archive_events_subset soft-deletes the
// merge drop set, which writes event_log.deleted_at — a watched column — so a call to it is an
// audited write even though no `UPDATE event_log` string appears at the call site.
const AUDITED_FN = /\b(archive_events_subset|archive_plant_events|archive_container_events|unarchive_events_apply)\s*\(/i
const isAuditedWrite = (n) => isSqlTemplate(n) && (AUDITED_DML.test(sqlText(n)) || AUDITED_FN.test(sqlText(n)))

// Binds the actor rather than hardcoding it, and is transaction-local (`true`) so it cannot leak
// onto a pooled connection and mis-attribute somebody else's write.
const SET_CONFIG = /set_config\(\s*'app\.actor_clerk_sub'\s*,\s*\?\s*,\s*true\s*\)/
const isSetConfig = (n) => isSqlTemplate(n) && SET_CONFIG.test(sqlText(n))

// withActor(sql, actor, () => [ … ] | () => <array variable>) runs its batch behind the set_config that the dir's
// ./audit-actor.js copy builds. A withActor group's element0 is THAT node, read from the copy the file imports, so a
// helper that drops, reorders or session-scopes the GUC reds every withActor row, and a file whose withActor is not
// the imported helper gets element0 null.
const isWithActorCall = (n) =>
  n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'withActor'
const parseFile = (rel) =>
  acorn.parse(readFileSync(join(ROOT, rel), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true })
function withActorFn(rel) {
  let fn = null
  walkAst(parseFile(rel), (n) => { if (n.type === 'FunctionDeclaration' && n.id?.name === 'withActor') fn = n })
  return fn
}
function helperGuc(rel) {
  let guc = null
  const fn = withActorFn(rel)
  if (fn) walkAst(fn.body, (n) => { if (isSqlTransaction(n) && n.arguments[0]?.type === 'ArrayExpression') guc = n.arguments[0].elements[0] ?? null })
  return guc
}
const importsWithActor = (ast) => ast.body.some((s) => s.type === 'ImportDeclaration' && s.source.value === './audit-actor.js' &&
  s.specifiers.some((sp) => sp.type === 'ImportSpecifier' && sp.imported.name === 'withActor' && sp.local.name === 'withActor'))
// Members of an array variable a builder returns: its initializer plus every push/unshift to it in the file.
function arrayMembers(ast, name) {
  const members = []
  walkAst(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name && n.init?.type === 'ArrayExpression') {
      members.push(...n.init.elements.filter(Boolean))
    }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' &&
        n.callee.object.name === name && ['push', 'unshift'].includes(n.callee.property.name)) members.push(...n.arguments)
  })
  return members
}

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

  // withActor form. A builder that is not `() => [ … ]` or `() => <array variable>` contributes no members, so an
  // audited write inside it counts as unbatched below (fail closed).
  const helper = join(dirname(rel), 'audit-actor.js')
  const guc = importsWithActor(ast) && FILES.includes(helper) ? helperGuc(helper) : null
  walkAst(ast, (n) => {
    if (!isWithActorCall(n)) return
    const [, actor = null, build] = n.arguments
    const body = build?.type === 'ArrowFunctionExpression' || build?.type === 'FunctionExpression' ? build.body : null
    const members = body?.type === 'ArrayExpression' ? body.elements.filter(Boolean)
      : body?.type === 'Identifier' ? arrayMembers(ast, body.name) : []
    groups.push({ file: rel, line: n.loc.start.line, kind: 'withActor', actor, element0: guc, members })
  })
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
// Put-Up release 1b adds the second: lambda/photos/photoDelete.js builds its pointer-null statements
// (one of them `UPDATE public.preservation_log SET photo_id = NULL`) in pointerNullStatement() and
// spreads them into softDeletePhoto's `statements`, whose element 0 is the GUC — the checker models a
// spread call as opaque. Closed by the named photoDelete test below.
const DEFERRED_TO_CALLER = new Set(['lambda/plants/plantMemoryRepoint.js', 'lambda/photos/photoDelete.js'])

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
    expect(isAuditedWrite(mk('UPDATE preservation_log p SET batch_id = NULL'))).toBe(true)
    expect(isAuditedWrite(mk('SELECT id FROM preservation_log WHERE id =  ? '))).toBe(false)
    expect(isAuditedWrite(mk('UPDATE kitchen_stage_log SET note =  ? '))).toBe(true)
    expect(isAuditedWrite(mk('DELETE FROM kitchen_batch_input WHERE id =  ? '))).toBe(true)
  })

  // ── the core property ───────────────────────────────────────────────────────────────────────
  it.each(AUDITING_GROUPS.map((g) => [`${g.file}:${g.line}${g.kind === 'withActor' ? ' (withActor)' : ''}`, g]))(
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

  // ── withActor (D2 R-W1-1): the helper, and every call to it ─────────────────────────────────────
  const WITH_ACTOR = GROUPS.filter((g) => g.kind === 'withActor')

  it('every withActor call is its dir\'s ./audit-actor.js copy, whose batch leads with the actor GUC', () => {
    expect(WITH_ACTOR.length).toBeGreaterThanOrEqual(8)
    expect(WITH_ACTOR.filter((g) => !isSetConfig(g.element0)).map((g) => `${g.file}:${g.line}`)).toEqual([])
  })

  it('withActor\'s actor argument is the caller (userId / ctx.userId), never a literal', () => {
    const caller = (a) => (a?.type === 'Identifier' && a.name === 'userId') ||
      (a?.type === 'MemberExpression' && a.object.type === 'Identifier' && a.object.name === 'ctx' && a.property.name === 'userId')
    expect(WITH_ACTOR.filter((g) => !caller(g.actor)).map((g) => `${g.file}:${g.line}`)).toEqual([])
  })

  it('the helper checks the actor, leads its batch with the transaction-local GUC, then runs the builder', () => {
    const fn = withActorFn('lambda/audit-actor.js')
    expect(fn, 'lambda/audit-actor.js defines no withActor').toBeTruthy()
    const [, actorParam, buildParam] = fn.params
    let batch = null
    walkAst(fn.body, (n) => { if (isSqlTransaction(n)) batch = n.arguments[0] })
    expect(batch?.type).toBe('ArrayExpression')
    const [guc, rest, ...extra] = batch.elements
    expect(isSetConfig(guc)).toBe(true)
    const bind = guc.quasi.expressions[0]
    expect(bind.type === 'CallExpression' && bind.callee.name === 'auditActor' && bind.arguments[0]?.name === actorParam.name).toBe(true)
    expect(rest?.type === 'SpreadElement' && rest.argument.type === 'CallExpression' && rest.argument.callee.name === buildParam.name).toBe(true)
    expect(extra).toEqual([])
  })

  // M4: one refusal rule. The helper's predicate is the same text as the two writers' copies.
  it('auditActor is byte-equal in audit-actor.js, varieties/validate.js and photos/photoDelete.js', () => {
    const rule = (rel) => {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      let fn = null
      walkAst(acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }), (n) => {
        if (n.type === 'FunctionDeclaration' && n.id?.name === 'auditActor') fn = n
      })
      return fn && src.slice(fn.params[0].start, fn.end)
    }
    const master = rule('lambda/audit-actor.js')
    expect(master).toMatch(/userId\.trim\(\) === ''/)
    expect(rule('lambda/varieties/validate.js')).toBe(master)
    expect(rule('lambda/photos/photoDelete.js')).toBe(master)
  })

  // Records each statement when it is BUILT, as the preservation unit mocks do, so construction order is visible.
  function recordingSql() {
    const sql = (strings, ...values) => { const s = { text: strings.join('?'), values }; sql.built.push(s); return s }
    sql.built = []
    sql.batches = []
    sql.transaction = async (stmts) => { sql.batches.push(stmts); return stmts.map(() => []) }
    return sql
  }
  const GUC_TEXT = "SELECT set_config('app.actor_clerk_sub', ?, true)"

  it('withActor builds the GUC before it calls the builder, and sends it as element 0', async () => {
    const sql = recordingSql()
    let builtFirst = null
    const out = await withActor(sql, 'user_a', () => {
      builtFirst = sql.built.map((s) => s.text)
      return [sql`UPDATE event_log SET note = ${'x'} WHERE id = ${1}`]
    })
    expect(builtFirst).toEqual([GUC_TEXT])
    expect(sql.batches.map((b) => b.map((s) => s.text))).toEqual([[GUC_TEXT, 'UPDATE event_log SET note = ? WHERE id = ?']])
    expect(sql.batches[0][0].values).toEqual(['user_a'])
    expect(out).toHaveLength(2) // the GUC's row is index 0, so `const [, rows] = await withActor(…)` keeps its index
  })

  it.each([['empty', ''], ['undefined', undefined], ['null', null], ['whitespace only', '   '], ['a number', 0], ['an object', {}]])(
    'withActor refuses an actor that is %s before it builds a statement or calls the builder',
    async (_label, actor) => {
      const sql = recordingSql()
      let called = false
      await expect((async () => withActor(sql, actor, () => { called = true; return [] }))()).rejects.toThrow(/audit actor is absent/)
      expect(sql.built).toEqual([])
      expect(sql.batches).toEqual([])
      expect(called).toBe(false)
    },
  )

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

  // Closes the photoDelete exemption above: the pointer nulls are spread into the batch whose element
  // 0 is the GUC, and pointerNullStatement is where the preservation_log write lives.
  it('the photo-delete pointer nulls ride softDeletePhoto\'s transaction, element 0 the GUC', () => {
    const src = readFileSync(join(ROOT, 'lambda/photos/photoDelete.js'), 'utf8')
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
    let found = false
    walkAst(ast, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.name === 'statements' && n.init?.type === 'ArrayExpression') {
        expect(isSetConfig(n.init.elements[0])).toBe(true)
        found = n.init.elements.some((e) => e?.type === 'SpreadElement' && /pointerNullStatement/.test(src.slice(e.start, e.end)))
      }
    })
    expect(found, 'pointerNullStatement is no longer spread into softDeletePhoto statements').toBe(true)
    expect(src).toMatch(/await sql\.transaction\(statements\)/)
    expect(src).toMatch(/UPDATE public\.preservation_log SET photo_id = NULL/)
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
