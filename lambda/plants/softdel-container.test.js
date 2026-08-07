// V4-SOFTDEL-001 F4 (read/authz side) — a planting whose CONTAINER is soft-deleted must be
// neither readable nor writable through the plants Lambda.
//
// DELETE /api/projects/:id soft-deletes the container row ONLY; nothing propagates to its child
// garden_node rows (that write-side propagation fix is NOT in this change — it lives in
// lambda/projects/index.js). Every by-id and list path in plants/index.js joined container for
// OWNERSHIP but never for LIVENESS, so a stranded child would have stayed on the Plants page and
// stayed editable. Live blast radius measured on prod 2026-08-06: 11 plantings sit under a
// soft-deleted container and all 11 are themselves already soft-deleted, so 0 rows change hands
// today (Dave 0, Jen 0) — this is a latent fix, and the point of it is that the latency ends the
// moment the projects DELETE ships propagation or a user deletes a non-empty container.
//
// Static-source (L-072), DB-free — plants/index.js cannot be imported under vitest (neon/Clerk/
// AWS SDK at module load), which is why every other guard in this directory is written this way.
//
// Every assertion is mutation-verified — mutation applied, RED observed, file restored
// byte-identically (shasum-checked).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

function sqlTemplates(src) {
  const out = [];
  const re = /(?<![\w`])sql`([^`]*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (/\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(m[1])) out.push(m[1]);
  }
  return out;
}
// A predicate living only inside a `--` comment is not a predicate. This fix added a lot of
// explanatory SQL comments naming pp.deleted_at; without stripping them every assertion below
// would pass vacuously.
const uncommented = (s) => s.replace(/--[^\n]*/g, '');
const squash = (s) => uncommented(s).replace(/\s+/g, ' ');

const CONTAINER_JOINED = (b) => /public\.container pp/.test(b);

describe('plants Lambda — F4 container soft-delete gate', () => {
  // MUTATION: delete `AND pp.deleted_at IS NULL` from the plants LIST query (the bare branch)
  // -> RED, listing that template as ungated.
  it('EVERY sql template that reaches container for ownership also requires it to be live', () => {
    const joined = sqlTemplates(SRC).filter(CONTAINER_JOINED);
    // 8 today: seen INSERT, archive UPDATE, by-id GET, PATCH pre-flight, PATCH UPDATE,
    // DELETE UPDATE, list-by-project, list-all. Floor guards a silently-empty match set.
    expect(joined.length).toBeGreaterThanOrEqual(8);
    const ungated = joined
      .filter(b => !/pp\.deleted_at IS NULL/.test(uncommented(b)))
      .map(b => squash(b).slice(0, 120));
    expect(ungated, 'container-joined plants query with no pp.deleted_at gate').toEqual([]);
  });

  // MUTATION: in the list-all query, hoist the gate to top level —
  //   `WHERE (pp.created_by = ANY(...) OR (p.container_id IS NULL AND ...)) AND pp.deleted_at IS NULL`
  // -> still passes the assertion above (the string is present) but RED here, because the
  // project-less arm no longer stands alone. This is the assertion that the previous one cannot
  // make, and the regression it guards is real: BUG-PLANTLESSWRITE-001 exists because a
  // container predicate was allowed to swallow the project-less arm.
  it('the gate rides INSIDE the container arm — project-less plantings keep working', () => {
    const projectLess = sqlTemplates(SRC)
      .filter(b => /container_id IS NULL AND [a-z]+\.created_by = ANY/.test(uncommented(b)));
    expect(projectLess.length, 'queries carrying the project-less ownership arm').toBeGreaterThanOrEqual(5);
    for (const b of projectLess) {
      const q = squash(b);
      // Either the EXISTS form (gate inside the subquery) or the LEFT JOIN form (gate ANDed to
      // the created_by conjunct). Both keep `container_id IS NULL OR`-arm reachable; a top-level
      // `AND pp.deleted_at IS NULL` outside the OR would match neither.
      const existsForm = /EXISTS \( ?SELECT 1 FROM public\.container pp WHERE pp\.id = [a-z]+\.container_id AND pp\.created_by = ANY\(\$\{householdIds\}\) AND pp\.deleted_at IS NULL\)/.test(q);
      const joinForm = /\( ?pp\.created_by = ANY\(\$\{householdIds\}\) AND pp\.deleted_at IS NULL ?\) OR \([a-z]+\.container_id IS NULL/.test(q);
      expect(existsForm || joinForm, `gate not scoped to the container arm in: ${q.slice(0, 140)}`).toBe(true);
    }
  });

  // MUTATION: remove the gate from the PATCH pre-flight `cur` SELECT only -> RED. Pre-flight and
  // UPDATE must agree or the handler 200s a write that matched 0 rows (a silent no-op save).
  it('the PATCH pre-flight and the PATCH UPDATE gate identically', () => {
    const pre = SRC.indexOf('SELECT gn.status AS old_status, gn.container_id AS proj_id');
    expect(pre, 'PATCH pre-flight anchor not found').toBeGreaterThan(-1);
    const preBlock = uncommented(SRC.slice(pre, SRC.indexOf('if (!cur.length)', pre)));
    expect(preBlock).toMatch(/pp\.deleted_at IS NULL/);

    const upd = SRC.indexOf('UPDATE public.garden_node p', pre);
    const updBlock = uncommented(SRC.slice(upd, SRC.indexOf('RETURNING p.id, p.container_id AS project_id', upd)));
    expect(updBlock).toMatch(/pp\.deleted_at IS NULL/);
  });

  // MUTATION: remove the gate from the list-by-project branch (the INNER JOIN one) -> RED. This
  // is the Plants-page / ProjectDetail read surface — the one a user would actually see a
  // stranded planting on.
  it('both GET /api/plants list branches gate the container', () => {
    const list = SRC.slice(SRC.indexOf('const projectId = event.queryStringParameters?.project_id'));
    const branches = list.split('FROM public.garden_node p').slice(1, 3).map(uncommented);
    expect(branches.length).toBe(2);
    for (const [i, b] of branches.entries()) {
      expect(b, `plants list branch ${i} missing the container gate`).toMatch(/pp\.deleted_at IS NULL/);
    }
  });

  // MUTATION: remove the gate from the seen_event INSERT -> RED. Write-authz paths matter as much
  // as reads here: a row invisible on every surface must not stay mutable through a direct id.
  it('the write-authz paths (seen / archive / delete) gate the container too', () => {
    const seen = uncommented(SRC.slice(SRC.indexOf('INSERT INTO seen_event')));
    expect(seen.slice(0, 700)).toMatch(/pp\.deleted_at IS NULL/);

    const arch = uncommented(SRC.slice(SRC.indexOf('SET archived_at = CASE WHEN')));
    expect(arch.slice(0, 700)).toMatch(/pp\.deleted_at IS NULL/);

    const del = uncommented(SRC.slice(SRC.indexOf('SET deleted_at = NOW()')));
    expect(del.slice(0, 900)).toMatch(/pp\.deleted_at IS NULL/);
  });
});
