// I24 (BUG-AUTHZLAMBDA-001) — GET /api/entity-tags?entity_type=&entity_id= must be gated on the
// caller's household before either read runs. Before the gate, `direct` filtered only tag visibility
// (a stranger got every `system` tag on a foreign entity) and `projected` had no household arm and
// no deleted_at. Static-source: index.js imports @aws-sdk/@clerk/@neondatabase at module load and is
// not importable from the repo root. The behaviour arm (foreign GET -> empty) is
// tests/integration/tags-authz.int.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

// Window: from the end of the bulk branch (its return) to the single-read `direct` SELECT.
const iBulkReturn = SRC.indexOf('return resp(200, { entities: assembleBulkEntities(directRows, projRows) });');
const iDirect = SRC.indexOf('const direct = await sql`');
const GATE = SRC.slice(iBulkReturn, iDirect);

describe('tags Lambda — single entity-tags read is household-gated (I24)', () => {
  it('the window is real', () => {
    expect(iBulkReturn).toBeGreaterThan(-1);
    expect(iDirect).toBeGreaterThan(iBulkReturn);
  });

  it('calls the household-scoped entityExists with the caller household BEFORE either read', () => {
    expect(GATE).toMatch(/await entityExists\(sql, et, eid, household\)/);
  });

  it('answers foreign / absent / malformed with the one 200-empty body (no oracle, no 22P02 500)', () => {
    expect(GATE).toMatch(/if \(!UUID_RE\.test\(String\(eid\)\) \|\| !\(await entityExists\(sql, et, eid, household\)\)\) \{\s*return resp\(200, \{ direct: \[\], projected: \[\] \}\);/);
  });

  it('400s an entity_type outside the POST list, without touching the bulk branch message', () => {
    expect(GATE).toMatch(/if \(!VALID_ENTITY_TYPES\.includes\(et\)\) return resp\(400/);
    expect(SRC).toMatch(/import \{[^}]*\bVALID_ENTITY_TYPES\b[^}]*\} from '\.\/validate\.js'/);
    expect(SRC).toContain("return resp(400, { error: 'bulk entity-tags is only supported for entity_type=plant' });");
  });

  it('entityExists scopes location / project / plant by household (the gate is only as good as this)', () => {
    const i = SRC.indexOf('async function entityExists');
    const fn = SRC.slice(i, SRC.indexOf('export const handler', i));
    expect((fn.match(/created_by = ANY\(\$\{household\}\)/g) || []).length).toBe(4);
    expect((fn.match(/deleted_at IS NULL/g) || []).length).toBe(4);
  });
});
