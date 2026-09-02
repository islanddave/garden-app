// V4-SEEDINV-001 static-source guard (inventory-items Lambda).
// Asserts the SEEDINV literal sub-routes (GET sow-candidates, POST extract-seeds)
// are checked BEFORE the /api/inventory-items/:id idMatch, that the sow-candidates
// SQL is household-scoped against v_sow_candidates, that the 501 not-configured
// branch exists, and that the Anthropic Messages endpoint appears exactly once.
//
// Why static (same rationale as lambda/plants/select-columns.test.js): index.js
// imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module load
// time, so it cannot be imported by unit tests. extract.js logic is unit-tested
// directly in extract.test.js; this file guards the index.js wiring.
//
// Failure mode guarded: a future edit reorders the routes below the idMatch —
// 'sow-candidates'/'extract-seeds' then match /:id and the routes silently 404
// (GET) or 405 (POST) in prod. This fails loudly in CI before merge.

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

const RAW = readFileSync(resolve(__dirname, 'index.js'), 'utf8');
const SRC = decomment(RAW);

describe('inventory-items Lambda — SEEDINV literal sub-routes (static-source guard)', () => {
  const idMatchIdx = SRC.indexOf('const idMatch = rawPath.match');
  const sowIdx = SRC.indexOf("rawPath === '/api/inventory-items/sow-candidates'");
  const extractIdx = SRC.indexOf("rawPath === '/api/inventory-items/extract-seeds'");

  it('declares the idMatch regex and both literal-route branches', () => {
    expect(idMatchIdx).toBeGreaterThan(-1);
    expect(sowIdx).toBeGreaterThan(-1);
    expect(extractIdx).toBeGreaterThan(-1);
  });

  it('both literal-route branches appear textually BEFORE the idMatch regex declaration', () => {
    expect(sowIdx, 'sow-candidates branch must precede idMatch').toBeLessThan(idMatchIdx);
    expect(extractIdx, 'extract-seeds branch must precede idMatch').toBeLessThan(idMatchIdx);
  });

  it('sow-candidates SQL reads v_sow_candidates with household scope', () => {
    // Scope the assertions to the sow-candidates branch (it precedes extract-seeds).
    const branch = SRC.slice(sowIdx, extractIdx);
    expect(branch).toContain('FROM v_sow_candidates');
    expect(branch).toContain('created_by = ANY');
    expect(branch).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
  });

  it("has the 501 'extractor_not_configured' branch (ANTHROPIC_API_KEY absent)", () => {
    expect(SRC).toMatch(/resp\(501,\s*\{\s*error:\s*'extractor_not_configured'\s*\}\)/);
  });

  it('references api.anthropic.com/v1/messages exactly once', () => {
    const matches = SRC.match(/api\.anthropic\.com\/v1\/messages/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// V4-SOWARCHIVE-001 static-source guard — PATCH /api/inventory-items/:id/sow-archive.
// Static for the same reason as the block above (index.js cannot be imported by unit tests).
//
// Failure modes guarded here, all of which are silent in prod rather than loud:
//   - the route drifts below idMatch and stops being reachable;
//   - the household scope is dropped, letting one household stamp another's packets;
//   - the category='seeds' guard is dropped, stamping a Sow-Now-only field onto a shovel;
//   - the season range check is removed, letting a packet be archived into a season that never
//     arrives — i.e. hidden forever with no UI to recover it.
describe('inventory-items Lambda — SOWARCHIVE route (static-source guard)', () => {
  const idMatchIdx = SRC.indexOf('const idMatch = rawPath.match');
  const archiveIdx = SRC.indexOf('const sowArchiveMatch = rawPath.match');
  const archiveBranch = SRC.slice(archiveIdx, idMatchIdx);

  it('declares the sow-archive branch BEFORE the idMatch regex', () => {
    expect(archiveIdx).toBeGreaterThan(-1);
    expect(archiveIdx, 'sow-archive branch must precede idMatch').toBeLessThan(idMatchIdx);
  });

  it('is PATCH-only', () => {
    expect(archiveBranch).toMatch(/method !== 'PATCH'/);
    expect(archiveBranch).toMatch(/resp\(405/);
  });

  it('writes both archive columns together and stamps updated_at', () => {
    // chk_sow_archive_pair rejects a half-write at the DB, but writing both here is what keeps
    // the constraint from ever being the thing that surfaces the bug.
    expect(archiveBranch).toContain('sow_archived_season =');
    expect(archiveBranch).toContain('sow_archived_at =');
    expect(archiveBranch).toContain('updated_at = NOW()');
  });

  it('un-archives symmetrically ({archived:false} clears both)', () => {
    expect(archiveBranch).toMatch(/body\.archived !== false/);
    expect(archiveBranch).toMatch(/CASE WHEN \$\{archived\} THEN NOW\(\) ELSE NULL END/);
  });

  it('scopes the UPDATE to the household, to live rows, and to seed packets only', () => {
    expect(archiveBranch).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(archiveBranch).toContain('deleted_at IS NULL');
    expect(archiveBranch).toContain("category = 'seeds'");
  });

  it('range-checks the season rather than trusting the client', () => {
    expect(archiveBranch).toMatch(/season < 2000 \|\| season > 2100/);
    expect(archiveBranch).toMatch(/invalid_season/);
  });

  it('404s when the UPDATE matches nothing (wrong household, or not a seed packet)', () => {
    expect(archiveBranch).toMatch(/if \(!rows\.length\) return resp\(404/);
  });
});

// V4-SEEDLINK-001 — PATCH /api/inventory-items/:id/source-plant.
//
// Two layers, because the static one alone cannot answer the question that matters. The regex
// assertions below prove the route is SHAPED right (reachable, PATCH-only, seeds-only, clearing is
// first-class, and source_plant_id stays OUT of the wide PUT). The block after them EXECUTES the
// handler's own ownership gate — lifted verbatim out of index.js, not retyped here — so "a foreign
// plant id is refused" is a behaviour this file observes rather than a shape it hopes implies one.
// A happy path that 200s proves nothing about a gate; a gate neutered to `if (false && …)`, moved
// below the write, or downgraded to a bare existence check fails the executed arms.
describe('inventory-items Lambda — SEEDLINK route shape (static-source guard)', () => {
  const idMatchIdx = SRC.indexOf('const idMatch = rawPath.match');
  const linkIdx = SRC.indexOf('const sourcePlantMatch = rawPath.match');
  const linkBranch = SRC.slice(linkIdx, idMatchIdx);

  it('declares the source-plant branch BEFORE the idMatch regex', () => {
    // idMatch's /([^/]+)$/ cannot match the /source-plant suffix today, but a future loosening of
    // that regex would swallow this route silently — it would 405 (PUT/DELETE only) rather than error.
    expect(linkIdx).toBeGreaterThan(-1);
    expect(linkIdx, 'source-plant branch must precede idMatch').toBeLessThan(idMatchIdx);
  });

  it('is PATCH-only', () => {
    expect(linkBranch).toMatch(/method !== 'PATCH'/);
    expect(linkBranch).toMatch(/resp\(405/);
  });

  it('reads the key by PRESENCE, so an explicit null CLEARS rather than being ignored', () => {
    // The whole point of the hasOwnProperty idiom: `null` is the honest value for a bought packet
    // and for a saved one whose parent Dave no longer remembers. A truthiness test would make
    // "not recorded" unreachable once a parent had ever been set.
    expect(linkBranch).toMatch(/Object\.prototype\.hasOwnProperty\.call\(body, 'source_plant_id'\)/);
    expect(linkBranch).toMatch(/const sourcePlantId = body\.source_plant_id \?\? null;/);
    // …and an omitted key is a 400, not a silent no-op that returns 200 having changed nothing.
    expect(linkBranch).toMatch(/return resp\(400, \{ error: 'source_plant_id is required/);
  });

  it('scopes the UPDATE to the household, to live rows, and to seed packets only', () => {
    expect(linkBranch).toMatch(/created_by = ANY\(\$\{householdIds\}\)/);
    expect(linkBranch).toContain('deleted_at IS NULL');
    expect(linkBranch).toContain("category = 'seeds'");
    expect(linkBranch).toContain('updated_at = NOW()');
    expect(linkBranch).toMatch(/RETURNING id, source_plant_id/);
  });

  it('404s when the UPDATE matches nothing (wrong household, or not a seed packet)', () => {
    expect(linkBranch).toMatch(/if \(!rows\.length\) return resp\(404/);
  });

  it('keeps source_plant_id OUT of the wide PUT — the headline data-loss risk', () => {
    // Every assignment in that SET list is unconditional (`= ${body.x ?? null}`) and
    // InventoryDetail's buildChanges() sends nothing seed-related, so a bare assignment there
    // would NULL the provenance on every unrelated inventory edit and return 200. The PUT's own
    // seed_process/seed_stage guards exist for exactly this reason; this column dodges it by not
    // being in that statement at all. Scoped to the PUT arm so the sub-route's own SET is not the
    // thing being matched.
    const putIdx = SRC.indexOf("if (method === 'PUT')");
    const putBranch = SRC.slice(putIdx, SRC.indexOf("if (method === 'DELETE')", putIdx));
    expect(putIdx).toBeGreaterThan(-1);
    expect(putBranch).toContain('UPDATE inventory_items SET');
    expect(putBranch).not.toMatch(/\bsource_plant_id\b/);
  });
});

// ── The gate, executed ────────────────────────────────────────────────────────────────────────
// index.js cannot be imported (module-scope @neondatabase/serverless + @clerk/backend + @aws-sdk/*),
// which is why every other guard in this directory is a source scan. The ownership gate is small,
// self-contained and the one piece where "does it actually refuse?" is the question — so it is cut
// out of the RAW source by brace matching and run with injected fakes. Nothing is retyped: a change
// to the gate in index.js changes what these tests execute.
describe('inventory-items Lambda — SEEDLINK ownership gate (executed against the real source)', () => {
  // Naive brace matching is sound here and only here: the extracted block contains no braces except
  // balanced `${…}` interpolations and object literals. Kept deliberately dumb rather than pulling a
  // parser in — if the block ever grows a brace inside a string, this returns garbage and the arms
  // below fail loudly rather than passing on a truncated gate.
  const blockFrom = (src, marker) => {
    const start = src.indexOf(marker);
    if (start === -1) return '';
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length && i !== -1; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return '';
  };

  const UUID_DECL = (RAW.match(/^const UUID_RE = .*$/m) ?? [''])[0];
  const GATE = blockFrom(RAW, 'if (sourcePlantId != null) {');

  // Fake neon tagged template, same shape as lambda/authz-write-fk.test.js: records the SQL text
  // and the BOUND values, returns a canned result.
  const fakeSql = (result = []) => {
    const calls = [];
    const fn = (strings, ...values) => { calls.push({ text: strings.join('?'), values }); return Promise.resolve(result); };
    fn.calls = calls;
    return fn;
  };

  // The gate followed by a sentinel standing in for everything after it. Reaching the sentinel IS
  // "the write would have run", so an arm that expects a refusal and gets the sentinel fails.
  const runGate = async ({ sourcePlantId, rows = [], householdIds = ['user_a', 'user_b'] }) => {
    const warned = [];
    const sql = fakeSql(rows);
    const body = `${UUID_DECL}\nreturn (async () => {\n${GATE}\nreturn resp(200, { reached: 'write' });\n})()`;
    // eslint-disable-next-line no-new-func
    const run = new Function('sql', 'sourcePlantId', 'householdIds', 'userId', 'warnRejectedFk', 'resp', body);
    const out = await run(
      sql, sourcePlantId, householdIds, 'user_a',
      (...a) => warned.push(a),
      (statusCode, payload) => ({ statusCode, payload }),
    );
    return { out, warned, sql };
  };

  const OWNED = '00000000-0000-4000-8000-0000000000aa';
  const FOREIGN = '00000000-0000-4000-8000-0000000000bb';

  it('extracted a real gate (guards every arm below against a vacuous empty block)', () => {
    expect(UUID_DECL, 'UUID_RE must be declared in index.js').toBeTruthy();
    expect(GATE.length).toBeGreaterThan(80);
    expect(GATE).toContain('public.garden_node');
    expect(GATE).toContain('warnRejectedFk');
  });

  it('REFUSES a plant id the household does not own — 400, and the write is never reached', async () => {
    // The arm that matters. An ungated route would return the sentinel here, which is a
    // cross-household FK write plus a read leak through every surface that later joins the parent.
    const { out, warned, sql } = await runGate({ sourcePlantId: FOREIGN, rows: [] });
    expect(out.statusCode).toBe(400);
    expect(out.payload.reached).toBeUndefined();
    // Server-side observability, caller sees only the generic message — no existence oracle.
    expect(warned).toHaveLength(1);
    expect(warned[0]).toEqual(['user_a', 'inventory_items', 'source_plant_id', FOREIGN]);
    expect(String(out.payload.error)).not.toMatch(/not found|exists/i);
    // The refusal came from the ownership query, not from a short-circuit that never asked.
    expect(sql.calls).toHaveLength(1);
  });

  it('binds the household array and the client id as PARAMETERS, against garden_node', async () => {
    const { sql } = await runGate({ sourcePlantId: OWNED, rows: [{ id: OWNED }] });
    const t = sql.calls[0].text.replace(/\s+/g, ' ');
    expect(t).toMatch(/FROM public\.garden_node/i);
    expect(t).toMatch(/created_by = ANY\(\?\)/);
    expect(t).toMatch(/deleted_at IS NULL/i);
    // Order matters as much as presence: id first, household second, both bound, never interpolated
    // into the text.
    expect(sql.calls[0].values).toEqual([OWNED, ['user_a', 'user_b']]);
  });

  it('lets an OWNED plant id through to the write', async () => {
    const { out, warned } = await runGate({ sourcePlantId: OWNED, rows: [{ id: OWNED }] });
    expect(out.payload.reached).toBe('write');
    expect(warned).toHaveLength(0);
  });

  it('refuses a malformed id WITHOUT touching the database', async () => {
    // 22P02 would fall through the handler catch as an opaque 500 — a worse contract than 400 and a
    // weak side channel (500 = "not even a uuid", 400 = "valid uuid, but not yours").
    const { out, sql } = await runGate({ sourcePlantId: 'not-a-uuid', rows: [{ id: 'unreachable' }] });
    expect(out.statusCode).toBe(400);
    expect(sql.calls, 'must short-circuit before issuing SQL').toHaveLength(0);
  });

  it('skips the gate entirely for an explicit null, so CLEARING needs no plant', async () => {
    // Clearing is a first-class action (the picker chip's ✕). If the gate ran on null it would
    // query for a row that cannot exist and refuse the one operation that has no FK to authorize.
    const { out, sql, warned } = await runGate({ sourcePlantId: null, rows: [] });
    expect(out.payload.reached).toBe('write');
    expect(sql.calls).toHaveLength(0);
    expect(warned).toHaveLength(0);
  });
});
