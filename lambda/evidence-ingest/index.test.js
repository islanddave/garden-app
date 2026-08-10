// Static-source regression guard for the evidence-ingest handler (slice 7). Static (not import):
// index.js imports @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module load, which the
// jsdom unit run cannot resolve (same constraint as findings/index.test.js). Guards the load-bearing
// write-path invariants: POST-only, Clerk-authed, payload-validated, registry-checked, append-only.
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
const stmts = SRC.match(/sql`[\s\S]*?`/g) || [];

describe('evidence-ingest Lambda — static write-path invariants', () => {
  it('authenticates with Clerk verifyToken', () => {
    expect(SRC).toMatch(/verifyToken\(/);
    expect(SRC).toMatch(/secretKey:\s*secrets\.CLERK_SECRET_KEY/);
  });
  it('is POST-only on /api/evidence, else 405', () => {
    expect(SRC).toMatch(/method !== 'POST'/);
    expect(SRC).toMatch(/rawPath !== '\/api\/evidence'/);
    expect(SRC).toMatch(/405/);
  });
  it('validates the payload via the pure validator before any DB work', () => {
    expect(SRC).toMatch(/validateEvidenceInput/);
    const vIdx = SRC.indexOf('validateEvidenceInput(body)');
    const sqlIdx = SRC.indexOf('neon(secrets.NEON_DATABASE_URL)');
    expect(vIdx).toBeGreaterThan(-1); expect(sqlIdx).toBeGreaterThan(vIdx);
  });
  it('validates entity_id against the live registry and 404s unknown entities', () => {
    expect(SRC).toMatch(/FROM public\.entity WHERE id =/);
    expect(SRC).toMatch(/404/);
    expect(SRC).toMatch(/Unknown entity_id/);
  });
  it('is append-only — exactly one write, an INSERT into evidence, no UPDATE/DELETE/UPSERT', () => {
    const writes = stmts.filter((s) => /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i.test(s));
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatch(/INSERT INTO\s+public\.evidence/);
    for (const s of stmts) expect(s).not.toMatch(/\b(UPDATE|DELETE|UPSERT|MERGE)\b/i);
  });
});
