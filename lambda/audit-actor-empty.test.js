// BUG-VARIETYACTOREMPTY-001 — a plant_varieties write must never bind an EMPTY actor.
//
// DISTINCT FROM BUG-EVENTAUDITACTOR-001 (lambda/audit-actor-guc.test.js), which was "the GUC was
// never set". This one is "the GUC was set to nothing", and the two have opposite tells: an unset
// GUC records `system`, an empty one records ''.
//
// THE MECHANISM, measured on live prod 2026-08-21:
//     BEGIN; SELECT set_config('app.actor_clerk_sub', NULL::text, true);
//     SELECT current_setting('app.actor_clerk_sub', true) = ''            ->  t
//     SELECT COALESCE(current_setting('app.actor_clerk_sub', true), 'x')  ->  ''   (COALESCE no-ops)
// `set_config(name, NULL, true)` does NOT leave the setting unset — Postgres STORES the empty
// string. So a JS `undefined` interpolated into the bind does not degrade to the 'system' fallback
// the trigger is written to provide; it lands in audit_events as an actor that is present and
// nameless. prod carries 201 such plant_varieties rows (2026-06-26 … 2026-08-06).
//
// THE TRIGGER CANNOT BE RELIED ON TO CATCH IT. Read live 2026-08-21 with pg_get_functiondef:
// audit_plant_varieties_trigger resolves `COALESCE(current_setting('app.actor_clerk_sub', true),
// 'system')` — NO NULLIF, unlike audit_stmt_update/audit_stmt_delete on event_log/harvest_log,
// which do have it. That asymmetry is exactly why the empty actor is visible on plant_varieties and
// on no other table. Hardening the trigger is migrations/v4-varaudit-001 (on dev, NOT applied to
// prod). This guard is the source-side half and does not depend on that migration landing.
//
// WHY THIS IS NOT A STRING SCAN. `set_config('app.actor_clerk_sub'` appearing near a write passes on
// the buggy code — that was the sibling ticket's trap, and `userId ?? 'system'` is a second version
// of it: it LOOKS like a defence, catches null/undefined, and forwards a literal '' untouched. So
// the assertions below are on the VALUE THAT LANDS in the bind, taken off a recording fake `sql`
// driven through the real control flow, plus a decommented-source census that pins WHICH files are
// allowed to write the table at all.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { softDeletePhoto } from './photos/photoDelete.js';
import { auditActor } from './varieties/validate.js';

const LAMBDA = dirname(fileURLToPath(import.meta.url));
const HOUSE = ['user_a', 'user_b'];
const PHOTO = '11111111-1111-4111-8111-111111111111';
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Same recorder shape as photos/photoDelete.test.js: a statement is a thenable carrying its own
// call record, so sql.transaction() can report the bound values of every statement, in order.
function fakeSql(responder = () => []) {
  const calls = [];
  const transactions = [];
  const fn = (strings, ...values) => {
    const text = norm(strings.join('?'));
    const rows = responder(text, values) ?? [];
    const call = { text, values, rows };
    calls.push(call);
    return { call, rows, then: (res, rej) => Promise.resolve(rows).then(res, rej) };
  };
  fn.calls = calls;
  fn.transactions = transactions;
  fn.transaction = async (stmts) => {
    transactions.push(stmts.map((s) => s.call));
    return stmts.map((s) => s.rows);
  };
  return fn;
}

const LIVE_PHOTO = {
  id: PHOTO, deleted_at: null, project_id: null, location_id: null,
  inventory_item_id: null, space_id: null, intake_status: null, effective_plant_id: null,
};
const responder = (text) => {
  if (/^SELECT ph\.id/.test(text)) return [LIVE_PHOTO];
  if (/UPDATE photos SET deleted_at = now\(\)/.test(text)) return [{ id: PHOTO, deleted_at: '2026-08-21T00:00:00Z' }];
  return [];
};

const deletePhoto = (sql, userId) =>
  softDeletePhoto(sql, { photoId: PHOTO, householdIds: HOUSE, userId, spaceEnabled: true });

// Every value that must NOT reach the bind. '' is the measured defect; undefined/null are what
// produce '' through the driver; the falsy scalars are here because `userId || 'system'` and
// `userId ?? 'system'` disagree about them and neither is a Clerk sub.
const REJECTED = [
  ['empty string — the measured prod defect', ''],
  ['undefined — binds NULL, which set_config stores as \'\'', undefined],
  ['null — same', null],
  ['whitespace only', '   '],
  ['a number', 0],
  ['a boolean', false],
  ['an object', {}],
];

// Block comments go first (photoDelete.js documents the bind in JSDoc). The `//` arm is URL-safe via
// the `[^:]` guard; the `--` arm needs surrounding space so a JS decrement is never read as SQL.
const decomment = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (extname(entry) === '.js' && !/\.test\.js$/.test(entry)) out.push(p);
  }
  return out;
}

// The two files that may write the audited table, through the auto-updatable view public.cultivar.
const WRITERS = ['lambda/varieties/index.js', 'lambda/photos/photoDelete.js'];
// A bind is `${...}` immediately inside set_config('app.actor_clerk_sub', …). Run on decommented
// source: photoDelete.js documents the idiom in a JSDoc block, and a construct named in a comment
// is not that construct.
const BIND_RE = /set_config\(\s*'app\.actor_clerk_sub'\s*,\s*\$\{([^}]*)\}/g;
const CULTIVAR_DML = /\b(insert\s+into|update|delete\s+from)\s+(public\.)?(plant_varieties|cultivar)\b/is;

const ALL_JS = walkFiles(LAMBDA).map((f) => relative(resolve(LAMBDA, '..'), f));
const SRC = Object.fromEntries(
  WRITERS.map((rel) => [rel, decomment(readFileSync(resolve(LAMBDA, '..', rel), 'utf8'))]),
);

describe('BUG-VARIETYACTOREMPTY-001 — the actor that lands can never be the empty string', () => {
  // ── anti-vacuity ──────────────────────────────────────────────────────────────────────────────
  // Every assertion below is over a derived set. A refactor that renamed the writers or the bind
  // would empty those sets and turn this whole file green while proving nothing.
  it('found the Lambda sources, the writers and their binds', () => {
    expect(ALL_JS.length).toBeGreaterThan(60);
    for (const w of WRITERS) expect(ALL_JS).toContain(w);
    const binds = WRITERS.flatMap((w) => [...SRC[w].matchAll(BIND_RE)]);
    // 5 in varieties/index.js, 1 in photos/photoDelete.js. An anti-vacuity FLOOR, not a ceiling on
    // audited writes: it goes up whenever either writer gains a bind, and the census below is what
    // decides whether that bind is acceptable. 5 -> 6 on 2026-09-04 (V4-SOURCEREG-001) for the
    // restore arm of POST /api/varieties/sources — public.source carries trg_audit_source_upd, so
    // that write binds the actor too even though the table it audits is not cultivar.
    expect(binds).toHaveLength(6);
  });

  // ── the normalizer, driven directly (varieties copy) ──────────────────────────────────────────
  it('auditActor returns a real Clerk sub unchanged', () => {
    expect(auditActor('user_3D2gM0hIl03gjW3JM2DjtPzm0jI')).toBe('user_3D2gM0hIl03gjW3JM2DjtPzm0jI');
  });

  it.each(REJECTED)('auditActor refuses %s rather than binding it', (_label, value) => {
    expect(() => auditActor(value)).toThrow(/audit actor is absent/);
  });

  // ── the VALUE THAT LANDS, off the real control flow (photos copy) ─────────────────────────────
  it('binds the caller sub verbatim on the happy path', async () => {
    const sql = fakeSql(responder);
    await deletePhoto(sql, 'user_a');
    const [guc] = sql.transactions[0];
    expect(guc.text).toMatch(/SELECT set_config\('app\.actor_clerk_sub', \?, true\)/);
    expect(guc.values).toEqual(['user_a']);
  });

  it.each(REJECTED)('a photo delete by %s issues no statement at all', async (_label, value) => {
    const sql = fakeSql(responder);
    await expect(deletePhoto(sql, value)).rejects.toThrow(/audit actor is absent/);
    // The throw happens while the batch is being CONSTRUCTED, so nothing was submitted. Asserting
    // "no transaction" is stronger than asserting "no empty bind": a rejected write leaves the
    // photo undeleted, which is the loud failure this ticket prefers over a nameless audit row.
    expect(sql.transactions).toEqual([]);
    expect(sql.calls.flatMap((c) => c.values)).not.toContain('');
  });

  // The single assertion that would have caught the prod rows: whatever the two writers do, no
  // execution of either can put '' into the actor bind.
  it('no reachable input makes either writer bind an empty actor', async () => {
    const bound = [];
    for (const [, value] of [...REJECTED, ['a real sub', 'user_a']]) {
      const sql = fakeSql(responder);
      await deletePhoto(sql, value).catch(() => {});
      bound.push(...sql.transactions.flat().filter((c) => /set_config/.test(c.text)).flatMap((c) => c.values));
      try { bound.push(auditActor(value)); } catch { /* refused, nothing bound */ }
    }
    expect(bound.length).toBeGreaterThan(0);
    expect(bound).not.toContain('');
    expect(bound.every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
  });

  // ── the two copies must not drift ─────────────────────────────────────────────────────────────
  // Each Lambda zips its own dir, so varieties/validate.js and photoDelete.js cannot share a
  // module. This is what makes the duplication safe: the same input table is driven through both.
  it('the photos copy and the varieties copy accept and refuse the same values', async () => {
    for (const [label, value] of [...REJECTED, ['a real sub', 'user_a']]) {
      const varietiesRefused = (() => { try { auditActor(value); return false; } catch { return true; } })();
      const photosRefused = await deletePhoto(fakeSql(responder), value).then(() => false, () => true);
      expect(photosRefused, `copies disagree on ${label}`).toBe(varietiesRefused);
    }
  });

  // ── source census: WHICH files may write the table, and how they bind ─────────────────────────
  it('every actor bind in both writers goes through auditActor()', () => {
    const offenders = [];
    for (const w of WRITERS) {
      for (const m of SRC[w].matchAll(BIND_RE)) {
        if (!/^auditActor\(/.test(m[1].trim())) offenders.push(`${w}: \${${m[1].trim()}}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('WRITERS is the complete set of files that write plant_varieties/cultivar', () => {
    // Fails OPEN otherwise: a third writer added tomorrow would be covered by no assertion here and
    // its missing normalizer would be invisible in a green suite. No prod FUNCTION mutates the table
    // either (checked against pg_proc.prosrc on live prod 2026-08-21), so direct DML is the whole
    // surface.
    const onDisk = ALL_JS
      .filter((rel) => CULTIVAR_DML.test(decomment(readFileSync(resolve(LAMBDA, '..', rel), 'utf8'))))
      .sort();
    expect(onDisk).toEqual([...WRITERS].sort());
  });
});
