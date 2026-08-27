// V4-ARCHIVEBROWSE-001 regression guard (plants). Static-source per L-072 house style (DB-free).
//
// Sibling of archive-route.test.js, which guards the WRITE half (the PATCH toggle) and the four
// active-list exclusions. This file guards the READ half: the browse surface that makes an archived
// planting findable again after Garden's 6-second Undo strip closes.
//
// The extractor discipline is inherited from archive-route.test.js deliberately, because that file
// documents two mutation-proven defects in earlier versions of ITSELF — a wrong anchor that made a
// negative assertion read the wrong branch, and a fixed-width window too small to contain the thing
// it forbade. Both failed SILENTLY and both are the reason every window here is bounded by the next
// branch rather than by a character count, and every negative assertion is paired with a floor that
// proves the window is non-degenerate.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct — same decommenter as its siblings, so
// deleting live code and leaving `// was: <it>` behind cannot satisfy a guard below.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

function branch(openAnchor, closeAnchor) {
  const start = SRC.indexOf(openAnchor);
  expect(start, `${openAnchor} not found`).toBeGreaterThan(-1);
  const end = SRC.indexOf(closeAnchor, start);
  expect(end, `${closeAnchor} (end anchor for ${openAnchor}) not found — the extractor would run ` +
    'past its branch and let a neighbour satisfy these assertions').toBeGreaterThan(start);
  return SRC.slice(start, end);
}

function archivedBranch() {
  const b = branch("if (rawPath === '/api/plants/archived'", 'if (restoreMatch');
  // FLOOR. Every negative assertion below is vacuously true over an empty or truncated window, which
  // is exactly how archive-route.test.js's predecessor passed while reading nothing. Pin that the
  // window really does contain this branch's own SELECT and its own ownership predicate.
  expect(b, 'archived branch window does not contain its own SELECT').toMatch(
    /SELECT[\s\S]*FROM\s+public\.garden_node\s+p\b/);
  expect(b, 'archived branch window does not contain its own ownership predicate').toMatch(
    /created_by = ANY\(\$\{householdIds\}\)/);
  return b;
}

describe('plants Lambda — V4-ARCHIVEBROWSE-001 archived browse route', () => {
  it('declares GET /api/plants/archived as a LITERAL route', () => {
    // A literal, not a pattern. clientRouteLambdaContract.test.js resolves the client's
    // '/api/plants/archived' through the real prefix table and requires it to land on a Lambda
    // LITERAL — being absorbed by a by-id pattern is the BUG-HARVWATCHROUTE-001 defect itself.
    expect(SRC).toMatch(/rawPath === '\/api\/plants\/archived' && method === 'GET'/);
  });

  it('excludes /api/plants/archived from the by-id matcher', () => {
    // THE TRAP THIS ROUTE WAS MOST LIKELY TO FALL INTO. `/api/plants/archived` is a single trailing
    // segment, so the by-id regex captures it as plantId = 'archived' and answers 404 — which on a
    // browse surface reads as "you have no archived plantings", not as a routing bug. Silent by
    // construction, so it is guarded rather than remembered.
    expect(SRC).toMatch(/COLLECTION_PATHS\s*=\s*\[[^\]]*'\/api\/plants\/archived'[^\]]*\]/);
    expect(SRC).toMatch(/const idMatch = !COLLECTION_PATHS\.includes\(rawPath\) &&/);
    // The sibling literal must survive the rewrite — /deleted was the original reason this exclusion
    // exists, and a list that grew a member while losing one would pass a naive contains-check.
    expect(SRC).toMatch(/COLLECTION_PATHS\s*=\s*\[[^\]]*'\/api\/plants\/deleted'[^\]]*\]/);
  });

  it('selects archived-and-live rows only', () => {
    const b = archivedBranch();
    expect(b).toMatch(/p\.archived_at IS NOT NULL/);
    expect(b).toMatch(/AND p\.deleted_at IS NULL/);
  });

  it('never inverts to archived_at IS NULL (that would make it a second active list)', () => {
    // The whole route is one negation away from being a duplicate of the main list, and every test
    // above would still pass: it would return rows, they would render, and the page would look
    // populated. Only this assertion distinguishes the two.
    expect(/p\.archived_at IS NULL/.test(archivedBranch())).toBe(false);
  });

  it('carries the F4 container-deleted gate rather than seeing through it', () => {
    // Every container-reaching read in this Lambda requires the container to be live. Measured on
    // live prod 2026-08-27 this hides none of the 30 archived-live plantings; it is here so this
    // read cannot quietly become the one exception.
    expect(archivedBranch()).toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\) AND pp\.deleted_at IS NULL/);
  });

  it('does not project a container name to the client', () => {
    // The /deleted list it is modelled on uses pp.display_name AS project_name as its row subtitle.
    // This surface must not: containers are not a user-facing noun in this app, and the cheapest way
    // to keep them out of the UI is to not send them.
    expect(/project_name/.test(archivedBranch())).toBe(false);
  });

  it('is read-only — no write verb in the branch', () => {
    const b = archivedBranch();
    for (const verb of [/\bUPDATE\s+public\./, /\bINSERT\s+INTO\b/, /\bDELETE\s+FROM\b/]) {
      expect(verb.test(b), `archived branch contains ${verb}`).toBe(false);
    }
  });

  it('clamps its LIMIT and reports truncation instead of silently stopping', () => {
    const b = archivedBranch();
    expect(b).toMatch(/Math\.min\(Math\.max\(Math\.trunc\(rawLimit\), 1\), 500\)/);
    expect(b).toMatch(/truncated: rows\.length === limit/);
  });

  it('leaves the unarchive PATCH as the only write path (no new write route)', () => {
    // Unarchive reuses PATCH /api/plants/:id/archive {archived:false}. If a future edit adds an
    // unarchive route of its own, that is a new authorization surface and it must be reviewed as
    // one rather than inherited from this feature.
    expect(SRC).toMatch(/archived_at = CASE WHEN \$\{archived\} THEN NOW\(\) ELSE NULL END/);
    expect(/rawPath === '\/api\/plants\/unarchive'/.test(SRC)).toBe(false);
    expect(/\/unarchive\$\//.test(SRC)).toBe(false);
  });

  it('does not disturb the four active-list archived_at IS NULL literals', () => {
    // archive-route.test.js owns this assertion; it is repeated here because the failure mode it
    // guards is one THIS feature could plausibly cause — the rejected `include_archived` design
    // would have made those predicates conditional, keeping the strings present while draining them
    // of meaning. If this ever goes red, the separate-branch decision has been undone.
    const m = SRC.match(/AND p\.archived_at IS NULL\n\s*ORDER BY p\.created_at DESC/g) ?? [];
    expect(m.length).toBe(2);
  });
});
