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

// ALIAS-AGNOSTIC. This was pinned to the literal alias `pp`, so a query that reached container for
// ownership under any other alias was silently outside the swept set — no test, no signal.
// MUTATION that this closes (verified in-memory against a copy of index.js, which is owned by
// another session and was not written to): add a third GET /api/plants list branch joining
// `public.container c ON c.id = p.container_id AND c.created_by = ANY(${householdIds})` with NO
// liveness gate. It was invisible to BOTH this predicate and the branch test below.
const CONTAINER_ALIAS = /public\.container\s+([a-z][a-z0-9_]*)/gi;
const containerAliases = (b) => [...uncommented(b).matchAll(CONTAINER_ALIAS)].map((m) => m[1]);
const CONTAINER_JOINED = (b) => containerAliases(b).length > 0;
// A container-reaching query is gated when EVERY alias it reaches container through is checked for
// liveness — not merely when the string `pp.deleted_at IS NULL` appears somewhere in it.
const containerGated = (b) => {
  const u = uncommented(b);
  const aliases = [...new Set(containerAliases(b))];
  return aliases.length > 0 && aliases.every((a) => new RegExp(`\\b${a}\\.deleted_at IS NULL`).test(u));
};

describe('plants Lambda — F4 container soft-delete gate', () => {
  // MUTATION: delete `AND pp.deleted_at IS NULL` from the plants LIST query (the bare branch)
  // -> RED, listing that template as ungated.
  it('EVERY sql template that reaches container for ownership also requires it to be live', () => {
    const joined = sqlTemplates(SRC).filter(CONTAINER_JOINED);
    // 8 today: seen INSERT, archive UPDATE, by-id GET, PATCH pre-flight, PATCH UPDATE,
    // DELETE UPDATE, list-by-project, list-all.
    // EXACT, not >=. A floor of 8 against a population of 8 let a NEW container-reaching query
    // appear with no audit at all; an ADD is a deliberate change, so bump this in the same commit.
    expect(joined.length,
      'plants container-reaching query count changed. An ADD needs this number bumped deliberately; ' +
      'a DROP means the sweep has gone blind rather than the query having been removed.').toBe(14);
    // 13 -> 14: V4-ARCHIVEBROWSE-001's GET /api/plants/archived. Container-reaching for ownership
    // and carrying the F4 `pp.deleted_at IS NULL` gate, copied from the /deleted list rather than
    // relaxed — measured on live prod 2026-08-27, all 30 archived-live plantings sit under a live
    // container, so the gate hides none of them and is here to keep it that way.
    // 12 -> 13: V4-PICKERPAYLOAD-001's ?view=picker projection. Also gp-aliased, also reaches
    // container for ownership (pp.display_name AS project_name), and carries the same
    // `pp.deleted_at IS NULL` gate — so it belongs in this alias-agnostic sweep, not outside it.
    // 11 -> 12: V4-PLANTSPAYLOAD-001's ?view=grid projection. It is aliased gp rather than p, so it
    // is deliberately outside the p-anchored branch census below — this alias-agnostic pass is the
    // one that keeps it swept, and it is the reason that pass was written alias-agnostic.
    // 8 -> 11: V4-RESTORESURFACE-001 added the GET /deleted list, the restore preflight and the
    // restore UPDATE. All three reach container for ownership and all three carry the F4 gate — an
    // earlier draft of the /deleted list deliberately OMITTED it so that plantings under a deleted
    // container could be surfaced as "blocked", and this guard is what caught it. That draft was
    // withdrawn rather than exempted: the recovery path for those rows is to restore the container
    // first, which keeps "invisible" and "immutable" the same set.
    // Gated = every alias this query reaches container through is liveness-checked, not merely
    // "the literal string pp.deleted_at IS NULL occurs somewhere in the template".
    const ungated = joined
      .filter(b => !containerGated(b))
      .map(b => squash(b).slice(0, 120));
    expect(ungated, 'container-reaching plants query with an unguarded container alias').toEqual([]);
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
    // `.slice(1)`, NOT `.slice(1, 3)`. The old bound took at most TWO branches and then asserted
    // `length === 2`, which a third branch could never fail: slice truncated it away and the count
    // still read 2. The bound was structurally incapable of seeing the thing it counted.
    // MUTATION that this closes (verified in-memory against a copy — index.js is owned by another
    // session and was not written to): append a third list branch after the existing two with no
    // container liveness gate -> the old form stayed GREEN; this form reds on the count, and if the
    // count is then bumped deliberately, on the per-branch gate assertion below.
    const branches = list.split('FROM public.garden_node p').slice(1).map(uncommented);
    expect(branches.length,
      'GET /api/plants list branch count changed — a new branch needs this number bumped in the ' +
      'same commit, which is what forces its container gate to be reviewed').toBe(2);
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
