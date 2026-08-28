// Does every share_log status this handler writes actually EXIST in the CHECK constraint?
//
// THE HAZARD THIS EXISTS FOR. share_log.status carries a CHECK enumerating its legal values. A
// handler that emits a value the DEPLOYED constraint forbids does not fail early and safely — it
// fails at the audit INSERT/UPDATE, which happens AFTER the Graph call has already put a post on a
// public Facebook Page. The result is a live public post with no record of itself, on the one table
// whose entire job is to be that record. The ordering rule is therefore absolute: widen the CHECK
// first (a migration), emit the new value second (a deploy). This test is what makes a violation of
// that order visible at commit time instead of at 23514 time.
//
// It was written when 'orphan_cleanup_failed' was introduced — a status the code deliberately did
// NOT write for several hours, because the migration permitting it had not yet been applied.
// Nothing but discipline was enforcing that gap. Now this is.
//
// WHY IT READS SOURCE AS TEXT. lambda/facebook-share/index.js cannot be imported by the root vitest
// run: its AWS/Clerk/Neon deps live in this directory's own package.json. So the statuses it writes
// are extracted from the source, which is exactly how the other static guards in this repo work.
// The status vocabulary for the orphan path is additionally exported from orphans.js so the two
// halves can be cross-checked rather than both being scraped.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS_ORPHAN_CLEANED, STATUS_ORPHAN_STRANDED } from './orphans.js';

const here = dirname(fileURLToPath(import.meta.url));
const HANDLER = readFileSync(join(here, 'index.js'), 'utf-8');
// Single source for the constraint — the migration that owns share_log's status vocabulary.
const MIGRATION = readFileSync(
  join(here, '..', '..', 'migrations', 'v4-sharetargets-001', '0a-additive-ddl.sql'), 'utf-8');

// The status CHECK, as written in the migration. Captures the parenthesised IN (...) list.
function allowedStatuses(sql) {
  const m = sql.match(/ADD CONSTRAINT share_log_status_valid\s*\n?\s*CHECK \(status IN \(([\s\S]*?)\)\)/);
  if (!m) return null;
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

// Every `status = 'literal'` and `status IN ('a','b')` the handler writes or filters on.
function statusLiteralsIn(src) {
  const out = new Set();
  for (const m of src.matchAll(/status\s*=\s*'([a-z_]+)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/status\s+IN\s*\(([^)]*)\)/gi)) {
    for (const lit of m[1].matchAll(/'([a-z_]+)'/g)) out.add(lit[1]);
  }
  return [...out];
}

describe('share_log status contract: handler vs CHECK constraint', () => {
  const allowed = allowedStatuses(MIGRATION);

  // Vacuity floor. If the regex above stops matching — the migration is reformatted, renamed, or the
  // constraint moves to another file — `allowed` becomes null or empty and every subset assertion
  // below passes against nothing, reporting agreement between two things it never compared.
  it('parses a non-trivial status list out of the migration', () => {
    expect(allowed).not.toBeNull();
    expect(allowed.length).toBeGreaterThanOrEqual(9);
    expect(allowed).toEqual(expect.arrayContaining(['pending', 'uploading', 'posted', 'failed']));
  });

  it('finds the status literals the handler actually writes', () => {
    const found = statusLiteralsIn(HANDLER);
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found).toEqual(expect.arrayContaining(['pending', 'failed', 'uploading']));
  });

  // The assertion this file exists for.
  it('every status the handler writes is permitted by the CHECK', () => {
    const found = statusLiteralsIn(HANDLER);
    const illegal = found.filter((s) => !allowed.includes(s));
    expect(illegal,
      `these statuses appear in index.js but are NOT in share_log_status_valid: ${illegal.join(', ')}. ` +
      'A handler emitting a value the deployed CHECK forbids raises 23514 AFTER the post is already ' +
      'public, leaving a live post with no audit row. Widen the constraint and APPLY it to staging ' +
      'and prod before this value ships.').toEqual([]);
  });

  // The orphan vocabulary is exported rather than scraped, so assert it directly too — this is the
  // pair that changed most recently and the one a future edit is most likely to get wrong.
  it('the exported orphan statuses are permitted by the CHECK', () => {
    expect(allowed).toContain(STATUS_ORPHAN_CLEANED);
    expect(allowed).toContain(STATUS_ORPHAN_STRANDED);
  });

  // Both exported constants must be REACHED by the handler, or the export is decorative and the
  // check above is guarding a value nothing writes.
  it('the handler actually uses both exported orphan statuses', () => {
    expect(HANDLER).toContain('STATUS_ORPHAN_CLEANED');
    expect(HANDLER).toContain('STATUS_ORPHAN_STRANDED');
  });
});
