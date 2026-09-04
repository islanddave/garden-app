// V5-INFLIGHTBATCH-001 — preservation_log.batch_id is DELIBERATELY absent from
// PRESERVATION_EDITABLE_COLUMNS, and this file exists so the next person cannot "fix" the omission.
//
// THE OMISSION LOOKS LIKE A BUG. provenance.js:33 calls that constant "the full set of columns a
// client may write" and "THE SINGLE SOURCE OF TRUTH for the four hand-maintained enumerations" — the
// INSERT column list, the full-replace UPDATE SET list, projectRow's whitelist, and buildFullPayload
// in src/pages/PutUp.jsx. A new nullable column on preservation_log that is NOT in it reads exactly
// like a column somebody forgot, and src/__tests__/preservationColumnParity.test.js is built to make
// forgetting one a red build. So the obvious, well-intentioned edit is to add it. That edit is the bug.
//
// WHAT ADDING IT WOULD DO. index.js:589-610 is a FULL-REPLACE PUT: every column in that SET list is
// assigned unconditionally from the request body. buildFullPayload lives in the FRONTEND, which means
// it ships inside the bundle — and this is a PWA, so after a promote a loaded tab keeps its old
// service-worker-cached bundle until reload. That bundle's buildFullPayload has never heard of
// batch_id. A one-tap "Mark used" decrement from it would therefore send a complete payload with
// batch_id absent, the full-replace PUT would write NULL over it, the request would return 200, and a
// batch's only link to the jars it produced would be gone with nothing to show for it. That is the
// exact failure the preserved_at_approx COALESCE at index.js:597-604 was written to prevent, and the
// same one the source_kind deviation documents at length.
//
// batch_id is set ONCE, by POST /api/kitchen-batches/:id/close, which is the only writer.
//
// LANE: the root `npm test` run (vitest run --coverage), which is blocking.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESERVATION_EDITABLE_COLUMNS } from './provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const INDEX = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));
const KITCHEN = decomment(readFileSync(resolve(__dirname, 'kitchenRoutes.js'), 'utf8'));
const PUTUP = decomment(readFileSync(resolve(root, 'src/pages/PutUp.jsx'), 'utf8'));
const DDL = readFileSync(
  resolve(root, 'migrations/v5-inflightbatch-001/0a-additive-ddl.sql'), 'utf8');

describe('preservation_log.batch_id is not client-writable, and that is deliberate', () => {
  it('the column really does exist on preservation_log — this guard is about a real column', () => {
    // Without this, deleting the migration would leave the assertions below passing over a phantom and
    // the whole file would become a fiction that still reads like coverage.
    expect(DDL).toContain('ALTER TABLE public.preservation_log\n  ADD COLUMN batch_id uuid');
  });

  it('is ABSENT from PRESERVATION_EDITABLE_COLUMNS', () => {
    // Mutation: add 'batch_id' to PRESERVATION_EDITABLE_COLUMNS in provenance.js. This reds — and so
    // does src/__tests__/preservationColumnParity.test.js, which would then demand batch_id in all
    // four hand-lists including buildFullPayload. Two independent guards, on purpose: the parity test
    // would push an editor TOWARDS adding it everywhere, and this one says stop.
    expect(PRESERVATION_EDITABLE_COLUMNS).not.toContain('batch_id');
  });

  it('is written by the batch close-out route and by nothing else in this Lambda', () => {
    // The other half of the claim. "Absent from the editable set" would be an argument for deleting
    // the column entirely if nothing wrote it; the point is that ONE server-side route does.
    // Mutation: delete the `SET batch_id = c.id` line in kitchenRoutes.js closeBatch.
    expect(KITCHEN).toContain('SET batch_id = c.id');
    expect((KITCHEN.match(/batch_id = c\.id/g) ?? [])).toHaveLength(1);
  });

  it('never appears in the full-replace PUT or the INSERT in index.js', () => {
    // The direct assertion. Mutation: add `batch_id = ${body.batch_id ?? null},` to the UPDATE SET
    // block — every other test in this repo stays green and this one reds.
    const insertBlock = INDEX.slice(
      INDEX.indexOf('INSERT INTO preservation_log ('),
      INDEX.indexOf(') VALUES (', INDEX.indexOf('INSERT INTO preservation_log (')));
    const updateBlock = INDEX.slice(
      INDEX.indexOf('UPDATE preservation_log SET'),
      INDEX.indexOf('updated_at          = NOW()'));
    expect(insertBlock.length).toBeGreaterThan(100);
    expect(updateBlock.length).toBeGreaterThan(100);
    expect(insertBlock).not.toMatch(/\bbatch_id\b/);
    expect(updateBlock).not.toMatch(/\bbatch_id\b/);
  });

  it('never appears in buildFullPayload, the copy of the list that ships to the browser', () => {
    // THIS is the surface that makes the omission load-bearing rather than tidy. A service-worker
    // cached bundle is a client the server cannot upgrade, and buildFullPayload is what it sends.
    const block = PUTUP.slice(
      PUTUP.indexOf('function buildFullPayload(rec, overrides = {}) {'),
      PUTUP.indexOf('...overrides,'));
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/\bbatch_id\b/);
  });

  it('the migration says so too, so the reason survives without this file', () => {
    // Belt and braces on the REASON, not just the fact. A guard whose rationale lives only in a test
    // file is a guard someone deletes along with the test.
    expect(DDL).toContain('batch_id IS DELIBERATELY NOT ADDED TO PRESERVATION_EDITABLE_COLUMNS');
  });
});
