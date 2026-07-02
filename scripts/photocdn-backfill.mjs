// V4-PHOTOCDN-001 P3d — derivative backfill driver.
//
// Eagerly generates thumb+card WebP derivatives (+ a blurhash) for every photos row and PERSISTS the
// derivative keys + original ETag + blurhash into the photos row, so P4 issuance reads the row and
// never HEADs/hashes at request time. Generation is delegated to the internal-invoke generator Lambda
// `garden-photocdn-derivative` (arm64 sharp — the exact code + perms that run at cutover), not
// re-implemented here.
//
// SAFETY (this file is authored + tested but the RUN is gated to the cutover phase):
//  - DRY-RUN by default. Real writes require --execute.
//  - PREFLIGHT asserts the 4 photos columns exist in the target DB (hard-abort if the additive DDL
//    has not been applied — L-238: apply DDL to the env BEFORE backfilling it; staging first, then prod).
//  - IDEMPOTENT: a row is skipped iff its original_etag matches the current S3 ETag AND all three
//    derivative fields are already set. Re-runs and crash-resume are safe (the DB row IS the ledger;
//    each row is UPDATEd immediately after a successful generate, so a crash resumes via skip logic).
//  - Per-row failure is logged + audited, never fatal. Missing original (404) is logged + skipped.
//  - Concurrency capped; throttle-backoff on Lambda TooManyRequests.
//
// Usage: node scripts/photocdn-backfill.mjs --env staging            # dry-run plan
//        node scripts/photocdn-backfill.mjs --env staging --execute  # real run (after DDL on staging)
//        node scripts/photocdn-backfill.mjs --env prod --execute --limit 5   # prod canary
// Env: DATABASE_URL (or NEON_STAGING_URL/NEON_DATABASE_URL), AWS creds, GENERATOR_FN (default garden-photocdn-derivative).

import { stripQuotes, derivativeKey, invokeRawPath, isBackfilled, REQUIRED_COLUMNS } from './photocdn-backfill-lib.mjs';
export { stripQuotes, derivativeKey, invokeRawPath, isBackfilled, REQUIRED_COLUMNS };

// ---- I/O (lazy-imported so this module loads under vitest without the AWS/DB deps at repo root) ----
async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const execute = has('--execute');
  const env = val('--env', 'staging');
  const limit = parseInt(val('--limit', '0'), 10) || 0;
  const concurrency = parseInt(val('--concurrency', '8'), 10);
  const GENERATOR_FN = process.env.GENERATOR_FN ?? 'garden-photocdn-derivative';
  const ORIGINALS_BUCKET = process.env.ORIGINALS_BUCKET ?? 'garden-photos-prod';
  const dbUrl = process.env.DATABASE_URL
    ?? (env === 'prod' ? process.env.NEON_DATABASE_URL : process.env.NEON_STAGING_URL);
  if (!dbUrl) { console.error(`no DB url for env=${env} (set DATABASE_URL / NEON_${env === 'prod' ? '' : 'STAGING_'}URL)`); process.exit(2); }

  const { neon } = await import('@neondatabase/serverless');
  const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const sql = neon(dbUrl);
  const s3 = new S3Client({});
  const lambda = new LambdaClient({});

  console.log(`[backfill] env=${env} execute=${execute} limit=${limit || 'all'} generator=${GENERATOR_FN}`);

  // PREFLIGHT: the additive DDL must be applied to THIS env first (L-238).
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='photos'`;
  const present = new Set(cols.map(c => c.column_name));
  const missing = REQUIRED_COLUMNS.filter(c => !present.has(c));
  if (missing.length) { console.error(`PREFLIGHT FAIL: photos is missing ${missing.join(', ')} — apply migrations/v4-photocdn-p1/0a-additive-ddl.sql to ${env} first`); process.exit(3); }

  const rows = await sql`SELECT id, storage_path, original_etag, derivative_thumb_key, derivative_card_key, blurhash FROM photos WHERE deleted_at IS NULL ORDER BY created_at`;
  const work = limit ? rows.slice(0, limit) : rows;
  console.log(`[backfill] ${rows.length} live photos; processing ${work.length}`);

  const ledger = [];
  let skipped = 0, done = 0, failed = 0, planned = 0;

  async function headEtag(key) {
    const r = await s3.send(new HeadObjectCommand({ Bucket: ORIGINALS_BUCKET, Key: key }));
    return stripQuotes(r.ETag);
  }
  async function invokeVariant(variant, etag, storagePath) {
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await lambda.send(new InvokeCommand({ FunctionName: GENERATOR_FN, Payload: Buffer.from(JSON.stringify({ rawPath: invokeRawPath(variant, etag, storagePath) })) }));
        const payload = JSON.parse(Buffer.from(out.Payload).toString());
        if (payload.statusCode !== 200) throw new Error(`generator ${variant} -> ${payload.statusCode} ${payload.body}`);
        return payload.headers?.['x-blurhash'] ?? null;
      } catch (e) {
        if (/TooManyRequests|Throttl/.test(String(e?.name) + String(e?.message)) && attempt < 5) {
          await new Promise(r => setTimeout(r, (2 ** attempt) * 250 + Math.random() * 200)); continue;
        }
        throw e;
      }
    }
  }

  async function processRow(row) {
    try {
      const currentEtag = await headEtag(row.storage_path);
      if (isBackfilled(row, currentEtag)) { skipped++; ledger.push({ id: row.id, status: 'skip' }); return; }
      const thumbKey = derivativeKey('thumb', currentEtag, row.storage_path);
      const cardKey = derivativeKey('card', currentEtag, row.storage_path);
      if (!execute) { planned++; ledger.push({ id: row.id, status: 'plan', thumbKey, cardKey }); return; }
      const blurhash = await invokeVariant('thumb', currentEtag, row.storage_path); // generates+persists thumb, returns blurhash
      await invokeVariant('card', currentEtag, row.storage_path);                    // generates+persists card
      await sql`UPDATE photos SET original_etag=${currentEtag}, derivative_thumb_key=${thumbKey}, derivative_card_key=${cardKey}, blurhash=${blurhash} WHERE id=${row.id}`;
      done++; ledger.push({ id: row.id, status: 'done', thumbKey, cardKey, blurhash });
    } catch (e) {
      failed++; ledger.push({ id: row.id, status: 'error', error: e?.message ?? String(e) });
      console.error(`[row ${row.id}] ${e?.message ?? e}`);
    }
  }

  // bounded concurrency
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, async () => {
    while (idx < work.length) { const r = work[idx++]; await processRow(r); }
  }));

  const fs = await import('node:fs');
  const out = `photocdn-backfill-${env}-${Date.now()}.jsonl`;
  fs.writeFileSync(out, ledger.map(l => JSON.stringify(l)).join('\n') + '\n');
  console.log(`[backfill] ${execute ? 'DONE' : 'DRY-RUN'} — done=${done} skipped=${skipped} planned=${planned} failed=${failed}. ledger=${out}`);
  if (failed) process.exit(1);
}

// run only as a script, not on import (keeps the test-time import side-effect-free)
if (import.meta.url === `file://${process.argv[1]}`) { main().catch(e => { console.error(e); process.exit(1); }); }
