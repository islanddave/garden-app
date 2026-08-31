// OPS-SCHEMAAUDITJOIN-001 — the public.voice_alias columns lambda/varieties reads.
// V5-VOICEALIAS-001.
//
// WHY A SEPARATE FILE AND NOT A BLOCK IN AN EXISTING CONTRACT. parse_test_file returns on the keyed
// AUDIT_COLUMNS form FIRST and never reaches the AUDIT_TABLES collector
// (scripts/dev-main-schema-audit.py:128-137), so dropping a keyed block into select-columns.test.js
// or crop-types-columns.test.js would SILENTLY DESTROY that file's own coverage. Always a new file —
// the same reason crop-types-columns.test.js exists separately.
//
// WHY IT LIVES IN THIS DIRECTORY: Phase 4 credits a contract only to the handler's OWN directory (it
// groups by Path(handler).parent) and only when the AUDIT_COLUMNS literal is in this file's own
// source text, because parse_test_file does read_text() then regex. A shared module is invisible to
// it.
//
// WHAT THIS FILE IS ACTUALLY FOR, beyond satisfying the ratchet. The audit exists because
// BUG-SEEDDETAIL500-001 shipped `p.name` against a relation that had no such column — green audit,
// green unit suite, green integration run, 500 on every seed packet detail page in prod. A JOINed
// relation nobody declared columns for is audited by NOTHING. voice_alias is brand new, so it starts
// covered rather than joining that debt.
//
// Static source inspection rather than import: these handlers load @neondatabase/serverless and
// @clerk/backend at module scope and cannot be imported in the unit suite.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A column NAMED IN A COMMENT is not a column reference. The `--(\s.*)?$` arm matches a BARE `--`
// separator line as well as `-- text`; the `--\s.*$` form does not, and a surviving `--` hides the
// declaration that follows it (scripts/dev-main-schema-audit.py:261-273).
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--(\s.*)?$/, '$1'))
  .join('\n');

// Every handler in THIS directory — the same set Phase 4 groups together. Read from disk rather than
// hardcoded, so a handler added here that touches voice_alias is covered the day it lands instead of
// the day someone remembers to extend a list.
const HANDLERS = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
  .sort();

// L-081 KEYED contract. Every column below verified present on public.voice_alias in live prod Neon
// on 2026-08-31, read through the read-only role, immediately after applying
// migrations/v5-voicealias-001/0a-additive-ddl.sql (post gates 8/8).
//
// The keyed form binds these columns to ONE relation, so this file cannot assert its list onto
// whatever table select-columns.test.js in this directory declares — that cross-product is what made
// joined relations unauditable in the first place.
//
// `id` and `created_at` are DELIBERATELY ABSENT: they exist on the table but the handler never names
// them. The contract records what this Lambda reads, not what the table has.
const AUDIT_COLUMNS = {
  voice_alias: ['heard_key', 'heard_text', 'hit_count', 'last_used_at', 'user_id', 'variety_id'],
};

const VOICE_ALIAS_COLUMNS = AUDIT_COLUMNS.voice_alias;

const SQL_TEMPLATE = /sql`([\s\S]*?)`/g;

// Statements that touch voice_alias at all — FROM/INSERT INTO alike. Phase 4 itself credits only
// FROM/JOIN, but this file's own assertions cover the INSERT too: the write names four of these six
// columns and a drift there is exactly as fatal as one in the read.
const TOUCHES = /\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE)\s+(?:public\.)?voice_alias\b/i;

const STATEMENTS = HANDLERS.flatMap((f) => {
  const src = decomment(readFileSync(resolve(__dirname, f), 'utf8'));
  return [...src.matchAll(SQL_TEMPLATE)]
    .map((m) => m[1])
    .filter((s) => TOUCHES.test(s))
    .map((sql) => ({ file: f, sql }));
});

describe('lambda/varieties — public.voice_alias column contract', () => {
  it('at least one statement touches voice_alias', () => {
    // Guards the whole file against becoming vacuous. If the routes are ever removed this fails
    // loudly rather than passing with an empty set — a contract asserting nothing is worse than no
    // contract, because it reads as coverage. (gates-catch-wrongness-not-poverty.)
    expect(STATEMENTS.length).toBeGreaterThan(0);
  });

  it('every column the handler names on voice_alias is in the contract', () => {
    // The columns are referenced BARE (the SELECT is unaliased and the INSERT is a column list), so
    // scan the statement text for identifiers rather than for alias-qualified `x.col` forms.
    const declared = new Set(VOICE_ALIAS_COLUMNS);
    const unknown = new Set();
    for (const { sql } of STATEMENTS) {
      for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)) {
        const tok = m[1].toLowerCase();
        // Only flag tokens that look like OUR columns: anything already declared is fine, and SQL
        // keywords/table names are not columns. The check is deliberately asymmetric — it catches a
        // column added to a query without being declared, which is the drift that 500s prod.
        if (/^(heard_|hit_|last_used|user_id|variety_id|created_at|deleted_at)/.test(tok)
            && !declared.has(tok)) {
          unknown.add(tok);
        }
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it('every contracted column is actually used — the contract cannot rot', () => {
    // The other direction: a column declared here but named nowhere means the contract has drifted
    // ahead of the code, and a stale contract is how a dropped column stops being noticed.
    const all = STATEMENTS.map((s) => s.sql).join('\n');
    for (const col of VOICE_ALIAS_COLUMNS) {
      expect(all, `contract declares ${col} but no statement names it`).toMatch(
        new RegExp(String.raw`\b${col}\b`, 'i'),
      );
    }
  });

  it('the write names the dedupe constraint explicitly, not a column list', () => {
    // ON CONFLICT ON CONSTRAINT uq_voice_alias_user_phrase, never ON CONFLICT (user_id, heard_key).
    // A column-list target can be silently re-arbitrated by a second unique index covering the same
    // columns; a named constraint cannot. The migration's comment makes the same argument from the
    // schema side, and this is the half that lives with the query.
    const write = STATEMENTS.find((s) => /INSERT\s+INTO/i.test(s.sql));
    expect(write, 'no INSERT into voice_alias found').toBeTruthy();
    expect(write.sql).toMatch(/ON\s+CONFLICT\s+ON\s+CONSTRAINT\s+uq_voice_alias_user_phrase/i);
  });

  it('reads are scoped to the calling user', () => {
    // An alias records how ONE person's speech is misheard. A read that forgot user_id would serve
    // Jen's corrections to Dave and steer his chooser with evidence about her audio — and it would
    // look like the feature working, not like a bug.
    for (const { file, sql } of STATEMENTS) {
      if (!/^\s*SELECT/im.test(sql)) continue;
      expect(sql, `${file}: a voice_alias read is not scoped to user_id`).toMatch(/user_id\s*=/i);
    }
  });
});
