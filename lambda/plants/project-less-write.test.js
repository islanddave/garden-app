// BUG-PLANTLESSWRITE-001 — project-less plantings must be readable AND writable by id.
//
// Sibling of project-less.test.js, which pinned the LIST query only. Every by-id route in this
// Lambda (GET, PUT, DELETE, PATCH /archive, POST /seen) scoped ownership through an INNER JOIN on
// the parent container, so a planting with container_id NULL matched zero rows and 404'd before
// reaching any business logic — permanently uneditable once CaptureFlow starts creating them
// (Dave S1: project-less plantings are a SUPPORTED state; lambda/events/validators.js relaxed to
// project_id OR plant_id in the same change).
//
// This file is as much an AUTHZ regression guard as a functionality one. The widened predicate is
//     pp.created_by = ANY(householdIds)
//     OR (<node>.container_id IS NULL AND <node>.created_by = ANY(householdIds))
// and the `container_id IS NULL` conjunct is LOAD-BEARING: without it, own-created_by would reach a
// planting sitting inside ANOTHER household's container, which the unguarded POST path lets a
// foreign user create. §"own-created_by arm is never unguarded" below fails if anyone drops it.
//
// Static-source per the L-072 house style (index.js imports @neondatabase/serverless +
// @clerk/backend + @aws-sdk/* at module load, so there is no runtime handler seam without a
// handlers.js split).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A construct NAMED IN A COMMENT is not that construct: deleting live code and leaving
// `// was: <it>` or `TRUE -- dropped: <it>` behind made every raw-source guard below find its
// own epitaph and pass. Assertions run against decommented source. The `//` arm is URL-safe
// (the `[^:]` guard keeps `https://` intact); the `--` arm requires surrounding space so a JS
// decrement is never read as a SQL comment.
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Slice a route branch so an assertion cannot be satisfied by a match somewhere else in the file.
function branch(startNeedle, endNeedle) {
  const start = SRC.indexOf(startNeedle);
  expect(start, `branch start not found: ${startNeedle}`).toBeGreaterThan(-1);
  const end = SRC.indexOf(endNeedle, start + startNeedle.length);
  return SRC.slice(start, end > -1 ? end : SRC.length);
}

const SEEN = branch('if (seenMatch) {', 'if (archiveMatch) {');
const ARCHIVE = branch('if (archiveMatch) {', 'if (idMatch) {');
const GET_BY_ID = branch("if (method === 'GET') {", "if (method === 'PUT') {");
const PUT_PREFLIGHT = branch('const cur = await sql`', 'const _oldStatus');
const PUT_UPDATE = branch('UPDATE public.garden_node p\n          SET', 'if (_statusChanged)');
const DELETE = branch("if (method === 'DELETE') {", 'return resp(405');

// The project-less ownership arm, per alias. `p`/`gn`/`ln` are the three node aliases in use.
const arm = (a) =>
  new RegExp(`${a}\\.container_id IS NULL AND ${a}\\.created_by = ANY\\(\\$\\{householdIds\\}\\)`);

describe('plants Lambda — project-less plantings are writable by id (BUG-PLANTLESSWRITE-001)', () => {
  it('POST /:id/seen LEFT JOINs the container and admits project-less rows', () => {
    expect(SEEN).toMatch(/LEFT JOIN public\.container pp ON pp\.id = ln\.container_id/);
    expect(SEEN).not.toMatch(/(?<!LEFT )\bJOIN\s+public\.container\b/);
    expect(SEEN).toMatch(arm('ln'));
  });

  it('PATCH /:id/archive drops the inner UPDATE..FROM container and admits project-less rows', () => {
    expect(ARCHIVE).not.toMatch(/\n\s*FROM public\.container pp/);
    expect(ARCHIVE).toMatch(/EXISTS \(SELECT 1 FROM public\.container pp/);
    expect(ARCHIVE).toMatch(arm('p'));
  });

  it('GET /:id LEFT JOINs the container and admits project-less rows', () => {
    expect(GET_BY_ID).toMatch(/LEFT JOIN public\.container pp ON pp\.id = p\.container_id/);
    expect(GET_BY_ID).not.toMatch(/(?<!LEFT )\bJOIN\s+public\.container\b/);
    expect(GET_BY_ID).toMatch(arm('p'));
  });

  it('PUT /:id pre-flight SELECT admits project-less rows (the 404-before-business-logic blocker)', () => {
    expect(PUT_PREFLIGHT).toMatch(/LEFT JOIN public\.container pp ON pp\.id = gn\.container_id/);
    expect(PUT_PREFLIGHT).not.toMatch(/(?<!LEFT )\bJOIN\s+public\.container\b/);
    expect(PUT_PREFLIGHT).toMatch(arm('gn'));
  });

  it('PUT /:id UPDATE admits project-less rows (pre-flight alone is not enough)', () => {
    expect(PUT_UPDATE).not.toMatch(/\n\s*FROM public\.container pp/);
    expect(PUT_UPDATE).toMatch(/EXISTS \(SELECT 1 FROM public\.container pp/);
    expect(PUT_UPDATE).toMatch(arm('p'));
  });

  it('DELETE /:id admits project-less rows', () => {
    expect(DELETE).not.toMatch(/\n\s*FROM public\.container pp/);
    expect(DELETE).toMatch(/EXISTS \(SELECT 1 FROM public\.container pp/);
    expect(DELETE).toMatch(arm('p'));
  });

  it('the only surviving INNER JOIN on container is the project-filtered list read', () => {
    // That one is correct by construction: it also filters `p.container_id = ${projectId}`, so the
    // row cannot be project-less. Every other container join must be LEFT.
    // Alias-agnostic (adversarial review F3): the sibling events Lambda writes this join inline as
    // `FROM garden_node p JOIN public.container pp` and elsewhere aliases it `c`, both of which a
    // line-anchored `pp`-only check would miss if that style ever lands here.
    const inner = SRC.match(/(?<!LEFT )\bJOIN\s+public\.container\b/g) ?? [];
    expect(inner.length, 'unexpected INNER JOIN on container').toBe(1);
    const listWithPid = branch('const rows = projectId', ': await sql`');
    expect(listWithPid).toMatch(/JOIN public\.container pp/);
    expect(listWithPid).toMatch(/AND p\.container_id = \$\{projectId\}/);
  });
});

describe('plants Lambda — the widened predicate stays narrow (authz guard)', () => {
  it('own-created_by arm is NEVER unguarded by container_id IS NULL', () => {
    // Without the conjunct, a caller who created a planting inside ANOTHER household's container
    // (the plants POST does not verify body.project_id ownership) would regain write access to it.
    // Alias-AGNOSTIC on purpose (adversarial review F3): a hardcoded `p|gn|ln` allowlist would
    // silently skip a future route that picks a different alias — exactly how a guard like this
    // rots. Instead, DERIVE the node aliases from the source (every alias bound to garden_node),
    // so a new alias is covered the moment it appears. Non-node owner checks (e.g. the
    // featured-photo `ph.created_by` gate) are correctly out of scope: they are not this predicate.
    const nodeAliases = [...new Set(
      [...SRC.matchAll(/(?:FROM|JOIN|UPDATE)\s+public\.garden_node\s+(\w+)/g)].map((m) => m[1]),
    )];
    expect(nodeAliases.length, 'no garden_node aliases found — regex rotted').toBeGreaterThan(0);
    let total = 0;
    for (const a of nodeAliases) {
      const arms = SRC.match(new RegExp(`\\b${a}\\.created_by = ANY\\(\\$\\{householdIds\\}\\)`, 'g')) ?? [];
      const guarded = SRC.match(
        new RegExp(`\\b${a}\\.container_id IS NULL AND ${a}\\.created_by = ANY\\(\\$\\{householdIds\\}\\)`, 'g'),
      ) ?? [];
      expect(guarded.length, `alias "${a}": an own-created_by arm lost its container_id IS NULL guard`)
        .toBe(arms.length);
      total += arms.length;
    }
    // 7 -> 10: V4-RESTORESURFACE-001 added the /deleted list, the restore UPDATE. Every one of the three keeps the `container_id IS NULL AND` guard, which
    // is what the assertion above this line proves — this line only counts them.
    expect(total, 'expected 10 own-created_by ownership arms (list + 6 by-id + 3 restore-surface)').toBe(10);
  });

  it('container ownership is still asserted on every by-id route', () => {
    for (const [name, block] of Object.entries({ SEEN, ARCHIVE, GET_BY_ID, PUT_PREFLIGHT, PUT_UPDATE, DELETE })) {
      expect(block, `${name} lost its pp.created_by household predicate`)
        .toMatch(/pp\.created_by = ANY\(\$\{householdIds\}\)/);
    }
  });

  it('PUT cannot re-home a planting (no container_id in the SET list) — ownership is unlaunderable', () => {
    // The widening is only safe while a caller cannot move a row between the two ownership arms.
    // Scoped to the SET clause and NOT line-anchored (adversarial review F3): an inline
    // `SET x = 1, container_id = …` would slip past a `^\s*container_id` check.
    const setClause = PUT_UPDATE.slice(0, PUT_UPDATE.indexOf('WHERE p.id'));
    expect(setClause).not.toMatch(/\bcontainer_id\s*=/);
  });

  it('the INSERT still binds created_by to the JWT subject, never householdIds', () => {
    const ins = SRC.slice(SRC.indexOf('INSERT INTO public.garden_node'));
    expect(ins.slice(0, 1200)).toMatch(/\$\{userId\}/);
    expect(ins.slice(0, 1200)).not.toMatch(/householdIds/);
  });
});
