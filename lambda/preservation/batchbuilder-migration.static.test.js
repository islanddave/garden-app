// V5-BATCHBUILDER-001 — static guard over migrations/v5-batchbuilder-001 and the Lambda half of
// BUG-ARCHIVESOFTDELBATCH-001 (the README's option (c)).
//
// WHY FILE-READING. The unit lane has no database; the integration lane (batchbuilder-archive.int.test.js)
// proves the sweep and the archives on a real fork. This file pins what can be read: that 0a is the no-DDL
// file its README says it is, that its gates self-arm on its stamp the house way, and — the half that
// keeps the bug closed — that no Lambda statement soft-deletes a pick line or soft-deletes a batch without
// hard-deleting its pick lines in the same statement.
// Mutation arms: drop `AND harvest_log_id IS NULL` from takeOutLine's UPDATE, or the picks_gone CTE from
// deleteBatch → the Lambda describe reds; add an ALTER TABLE to 0a → "no DDL" reds; drop the stamp arm
// from post_no_dead_pick_link → the arming test reds.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, '../../migrations/v5-batchbuilder-001');
const read = (f) => readFileSync(resolve(DIR, f), 'utf8');
const STAMP = '5.0.0-batchbuilder-001';
const sqlOnly = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('v5-batchbuilder-001 — the files', () => {
  const zeroA = read('0a-additive-ddl.sql');
  const zeroR = read('0r-rollback.sql');
  const gates = read('gates.yml');

  it('line 2 names the stamp the file inserts (the train step reads it)', () => {
    expect(zeroA.split('\n')[1]).toBe(`-- schema_version: ${STAMP}`);
    expect(zeroA).toMatch(new RegExp(String.raw`INSERT INTO public\.schema_version[\s\S]*?VALUES \('${STAMP.replace(/\./g, '\\.')}'`));
    expect(zeroA).toContain('ON CONFLICT (version) DO NOTHING');
  });

  it('is one transaction and carries no DDL (release 3 has no column of its own)', () => {
    const body = sqlOnly(zeroA);
    expect(body.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(body.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(body).not.toMatch(/\b(ALTER|CREATE|DROP)\s+(TABLE|INDEX|TRIGGER|FUNCTION|VIEW|CONSTRAINT)\b/i);
    expect(body).not.toMatch(/::regclass/);
  });

  it('refuses without F, and re-creates no audit trigger (F already watches remaining_amount)', () => {
    expect(zeroA).toContain("version = '5.0.0-fermentpath-001'");
    expect(sqlOnly(zeroA)).not.toMatch(/trg_audit_preservation_log_upd/);
    const f = readFileSync(resolve(__dirname, '../../migrations/v5-fermentpath-001/0a-additive-ddl.sql'), 'utf8');
    const trg = f.slice(f.indexOf('CREATE TRIGGER trg_audit_preservation_log_upd'));
    expect(trg.slice(0, trg.indexOf(';'))).toContain("'remaining_amount'");
  });

  it('the sweep deletes exactly the dead pick links: a pick line, soft-deleted or under a removed batch', () => {
    const at = zeroA.indexOf('-- BEGIN dead-pick-sweep');
    const end = zeroA.indexOf('-- END dead-pick-sweep');
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const block = zeroA.slice(at, end).replace(/\s+/g, ' ');
    expect(block).toContain('DELETE FROM public.kitchen_batch_input i WHERE i.harvest_log_id IS NOT NULL');
    expect(block).toContain('AND ( i.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.kitchen_batch b WHERE b.id = i.batch_id AND b.deleted_at IS NOT NULL) )');
    // Only kitchen_batch_input is written, and only by a DELETE.
    expect(block.match(/\b(DELETE FROM|UPDATE|INSERT INTO)\s+public\.\w+/g)).toEqual(['DELETE FROM public.kitchen_batch_input']);
  });

  it('0r only removes the stamp, behind a guard', () => {
    const body = sqlOnly(zeroR);
    expect(body).toContain(`version = '${STAMP}'`);
    expect(body).toMatch(/RAISE EXCEPTION/);
    expect(body.match(/\b(DELETE FROM|UPDATE|INSERT INTO|ALTER|DROP)\s+\S+/g)).toEqual([`DELETE FROM public.schema_version`]);
  });

  it('every standing post gate is armed on this stamp; catalog joins only', () => {
    const post = gates.slice(gates.indexOf('\npost:'));
    const blocks = post.split(/\n  - name: /).slice(1);
    expect(blocks.map((b) => b.split('\n')[0])).toEqual([
      'post_schema_version_recorded', 'post_no_dead_pick_link', 'post_pick_line_fk_still_restrict',
      'post_audit_watches_remaining_amount',
    ]);
    for (const b of blocks) {
      if (/continuous: false/.test(b)) continue;
      expect(b, b.split('\n')[0]).toContain(`version = '${STAMP}'`);
      expect(b).toMatch(/expect: rowcount_eq/);
    }
    expect(gates.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')).not.toMatch(/::regclass/);
    // A 1b column read through to_jsonb, so the gate is vacuous (not 42703) on a database without 1b.
    expect(blocks[1]).toContain("to_jsonb(i) ->> 'deleted_at'");
  });
});

// ── the Lambda half: no writer leaves a dead pick link ──────────────────────────────────────────────
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');
const STATEMENTS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .flatMap((f) => [...decomment(readFileSync(resolve(__dirname, f), 'utf8')).matchAll(/sql`([\s\S]*?)`/g)]
    .map((m) => ({ file: f, s: m[1].replace(/\s+/g, ' ') })));

describe('BUG-ARCHIVESOFTDELBATCH-001 — the Lambda never makes a dead pick link', () => {
  it('every soft delete of a line excludes pick lines', () => {
    const soft = STATEMENTS.filter(({ s }) => /UPDATE kitchen_batch_input\b[^;]*?SET deleted_at = (now|NOW)\(\)/.test(s));
    expect(soft.length, 'found the take-out and the batch removal').toBeGreaterThanOrEqual(2);
    for (const { file, s } of soft) {
      const upd = s.slice(s.search(/UPDATE kitchen_batch_input\b/));
      expect(upd.slice(0, upd.indexOf('RETURNING')), file).toMatch(/harvest_log_id IS NULL/);
    }
  });

  it('Undo that put-up hard-deletes a pick added at that sitting (it soft-deletes only the rest)', () => {
    const undo = STATEMENTS.filter(({ s }) => s.includes('gone_lines AS ('));
    expect(undo).toHaveLength(1);
    const picks = undo[0].s.slice(undo[0].s.indexOf('gone_picks AS ('))
    expect(picks.slice(0, picks.indexOf('RETURNING'))).toMatch(/DELETE FROM kitchen_batch_input i WHERE .*i\.put_up_stage_id = .*AND i\.harvest_log_id IS NOT NULL/)
  });

  it('every soft delete of a batch hard-deletes its pick lines in the same statement', () => {
    const removals = STATEMENTS.filter(({ s }) => /UPDATE kitchen_batch SET deleted_at = (now|NOW)\(\)/.test(s));
    expect(removals.length).toBe(1);
    for (const { file, s } of removals) {
      expect(s, file).toMatch(/DELETE FROM kitchen_batch_input i USING gone g WHERE i\.batch_id = g\.id AND i\.harvest_log_id IS NOT NULL/);
    }
  });
});
