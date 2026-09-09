#!/usr/bin/env node
// scripts/backfill-photo-taken-at.mjs
// V4-PHOTOEXIF-001 — recover photos.taken_at from EXIF still present in S3.
//
// This is the script migrations/v4-photobulk-p1/0a-additive-ddl.sql promised and nobody wrote:
// "The historical backfill of the existing 698 is a SEPARATE one-off script (V4-PHOTOEXIF-001)."
// It was referenced in three comments for seven weeks and existed nowhere.
//
//   node scripts/backfill-photo-taken-at.mjs              # DRY. Writes nothing. Reports everything.
//   node scripts/backfill-photo-taken-at.mjs --apply      # WRITES to prod
//   node scripts/backfill-photo-taken-at.mjs --limit 50   # sample a subset (dry or apply)
//   node scripts/backfill-photo-taken-at.mjs --out FILE   # where the full proposal CSV lands
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE DATA IS THERE TO RECOVER
//
// taken_at is NULL on 1,269 of 1,584 live rows, and the reason is NOT that the photographs arrived
// without metadata. Censused across all 1,269 S3 objects 2026-09-09: 926 (73%) still carry a
// readable EXIF DateTimeOriginal RIGHT NOW. Those rows are empty because the upload path did not
// start reading the tag until mid-August 2026 — the bytes were always there, nothing ever asked.
//
// The 343 that genuinely lost it were re-encoded through a canvas by the client-side downscale
// (ee2f6ec, dev 2026-07-27), which emits a bare JPEG with no EXIF at all. The split is almost
// perfectly clean on that date: 906/913 recoverable before it, 20/356 after. The privacy strip
// (V4-PHOTOEXIFSTRIP-001, 2026-08-20) is innocent — it shipped after the last affected upload and
// never touched this population. Those 343 are unrecoverable FROM S3; the only other source would
// be Dave's original camera roll.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY IT IS WORTH RUNNING RATHER THAN LEAVING THE FALLBACK IN PLACE
//
// Since V4-PHOTOTAKENAT-002 every gallery orders on COALESCE(taken_at, created_at), so a NULL row
// is not broken — it just answers with the day its file uploaded. That is a worse answer than it
// sounds: measured over the 926, upload time is off from capture time by more than a day on 27% of
// them and by up to 17.65 days at the extreme. Backfilling moves 313 of the 926 into a different
// day-section on the Photos wall. That reshuffle IS the fix arriving, not a side effect of it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// TIMEZONE — READ THE TAG, NEVER HARDCODE THE OFFSET
//
// EXIF DateTimeOriginal (0x9003) is zone-less: "2026:05:11 18:16:18" names no offset, so on its own
// it cannot be turned into a timestamptz without an assumption. This corpus resolves that itself —
// OffsetTimeOriginal (0x9011) is present and reads -04:00 on 926 of 926 — so this script reads the
// tag PER FILE and only falls back when it is absent.
//
// The fallback is `AT TIME ZONE 'America/New_York'`, a zone NAME, applied by Postgres to that
// photograph's own date. Hardcoding -04:00 would be correct for this batch and WRONG BY AN HOUR for
// any November-March photograph, and the batch being all-EDT is an accident of which months these
// happen to cover, not a property of the data. The same mistake is called out in gam-site's
// generate_candidates.py for the same reason. Do not "simplify" this into a constant.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SAFETY
//
//   - DRY BY DEFAULT. --apply is the only thing that writes.
//   - IDEMPOTENT. The UPDATE carries `AND taken_at IS NULL`, so re-running never overwrites a value
//     — neither one this script wrote nor one the upload path did. Re-run it freely.
//   - taken_at ONLY. photos has a prevent_ownership_transfer trigger, which raises solely on a
//     created_by change, so this passes. It DOES fire set_updated_at, bumping updated_at on every
//     row written — expected, and it may invalidate service-worker caches on next load.
//   - Implausible values are REPORTED AND SKIPPED, never written (see PLAUSIBILITY below).
//
import { neon } from '@neondatabase/serverless';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import exifr from 'exifr';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const limit = Number(argOf('--limit', '0')) || 0;
const outPath = argOf('--out', join(ROOT, 'taken-at-backfill-proposal.csv'));

// ── env ───────────────────────────────────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const dbUrl = env.NEON_DATABASE_URL;
const bucket = argOf('--bucket', env.S3_PHOTOS_BUCKET);
if (!dbUrl) { console.error('FATAL: NEON_DATABASE_URL missing from .env.local'); process.exit(1); }
if (!bucket) { console.error('FATAL: S3_PHOTOS_BUCKET missing from .env.local (or pass --bucket)'); process.exit(1); }

// The owner role, not garden_ro: photos has RLS on, and garden_ro raises "current_user_id not set"
// until app.user_id is set as a session var. A writer needs the owner connection regardless.
const sql = neon(dbUrl);
const s3 = new S3Client({ region: argOf('--region', env.AWS_REGION || 'us-east-1') });

// ── EXIF read ─────────────────────────────────────────────────────────────────────────────────────
// A RANGE READ, not a whole-object GET. EXIF sits in APP1 immediately after SOI, so the first 256KB
// carries it on every file in this corpus; pulling 1,269 full-size originals to read 20 bytes each
// would move gigabytes for nothing. HEAD_BYTES is generous rather than tight because a Samsung file
// can carry a large APP1 plus a JUMBF segment ahead of the tag, and a miss costs a second request.
const HEAD_BYTES = 256 * 1024;

async function readHead(key, bytes = HEAD_BYTES) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
  const chunks = [];
  for await (const c of res.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

// reviveValues:false is LOAD-BEARING. Left on, exifr parses DateTimeOriginal into a JS Date using
// the RUNTIME's local zone — so the value would depend on the machine the backfill ran from, and a
// laptop in a different zone would write different timestamps for the same photograph. We want the
// raw "YYYY:MM:DD HH:MM:SS" string and the offset tag, and we compose the instant ourselves.
async function captureOf(key) {
  let buf = await readHead(key);
  let tags = await exifr.parse(buf, {
    pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'CreateDate', 'OffsetTimeDigitized'],
    reviveValues: false,
  }).catch(() => null);

  // One retry at 1MB before giving up — cheaper than declaring a photograph unrecoverable because
  // its metadata sat further in than usual.
  if (!tags?.DateTimeOriginal) {
    buf = await readHead(key, 1024 * 1024);
    tags = await exifr.parse(buf, {
      pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'CreateDate', 'OffsetTimeDigitized'],
      reviveValues: false,
    }).catch(() => null);
  }
  if (!tags) return null;

  // DateTimeOriginal is when the shutter fired. CreateDate is when the file was written, which for a
  // camera original is the same instant and for an edited copy is later — so it is a FALLBACK, and
  // one the report labels, never a silent equivalent.
  const raw = tags.DateTimeOriginal || tags.CreateDate;
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  const naive = `${Y}-${Mo}-${D} ${H}:${Mi}:${S}`;
  const offset = (tags.OffsetTimeOriginal || tags.OffsetTimeDigitized || '').trim() || null;
  return {
    naive,
    offset: /^[+-]\d{2}:\d{2}$/.test(offset ?? '') ? offset : null,
    source: tags.DateTimeOriginal ? 'DateTimeOriginal' : 'CreateDate',
  };
}

// ── plausibility ──────────────────────────────────────────────────────────────────────────────────
// A recovered date is a claim by a camera's clock, and a camera's clock can be wrong. These three
// rules are the difference between a backfill and a data-corruption event, so a failure REPORTS and
// SKIPS rather than writing and hoping someone reads the log.
//
//   FUTURE      — a capture time after now is impossible and would sort to the head of every gallery.
//   PREHISTORIC — before 2000 means an unset clock reading its epoch default, not a real date.
//   AFTER-UPLOAD — you cannot upload a photograph before taking it. A small grace absorbs clock skew
//                  and the zone-less-tag edge; beyond a day it is a wrong clock, and writing it would
//                  file the photograph in a future the garden has not reached.
const AFTER_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;

function implausible(takenMs, createdMs) {
  if (!Number.isFinite(takenMs)) return 'unparseable';
  if (takenMs > Date.now()) return 'future';
  if (takenMs < Date.parse('2000-01-01T00:00:00Z')) return 'prehistoric';
  if (takenMs - createdMs > AFTER_UPLOAD_GRACE_MS) return 'after-upload';
  return null;
}

const ET = 'America/New_York';
const etDay = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

// ── main ──────────────────────────────────────────────────────────────────────────────────────────
const CONCURRENCY = 8;   // S3 range reads. Not the DB — writes go one at a time, in order.

async function mapPool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// TWO STATEMENTS, NOT ONE WITH AN INTERPOLATED LIMIT. @neondatabase/serverless does not support
// nesting a sql`` fragment inside another sql`` (that is a postgres.js feature) — the nested tag
// serialises into the parameter list and the statement fails at the server. Spelled out instead.
const rows = limit
  ? await sql`
      SELECT id, storage_path, created_at
        FROM photos
       WHERE deleted_at IS NULL AND taken_at IS NULL AND storage_path IS NOT NULL
       ORDER BY created_at ASC
       LIMIT ${limit}`
  : await sql`
      SELECT id, storage_path, created_at
        FROM photos
       WHERE deleted_at IS NULL AND taken_at IS NULL AND storage_path IS NOT NULL
       ORDER BY created_at ASC`;

console.log(`${apply ? 'APPLY' : 'DRY RUN'} — bucket ${bucket}, ${rows.length} rows with taken_at IS NULL`);
if (!apply) console.log('Nothing will be written. Re-run with --apply once the proposal below looks right.\n');

let done = 0;
const results = await mapPool(rows, async (r) => {
  const createdMs = Date.parse(r.created_at);
  let cap = null, error = null;
  try {
    cap = await captureOf(r.storage_path);
  } catch (e) {
    error = e?.name === 'NoSuchKey' ? 'missing-in-s3' : (e?.name || 'read-error');
  }
  if (++done % 100 === 0) process.stdout.write(`  …read ${done}/${rows.length}\n`);
  if (error) return { ...r, createdMs, status: error };
  if (!cap) return { ...r, createdMs, status: 'no-exif' };

  // Compose the instant. With an offset tag the string is already unambiguous; without one, hand
  // Postgres the naive value and let AT TIME ZONE resolve it against that date's real DST state.
  const iso = cap.offset ? `${cap.naive.replace(' ', 'T')}${cap.offset}` : null;
  const takenMs = iso ? Date.parse(iso) : Date.parse(`${cap.naive.replace(' ', 'T')}Z`);   // probe only
  const bad = implausible(cap.offset ? takenMs : takenMs - 0, createdMs);
  if (bad) return { ...r, createdMs, cap, status: `skipped-${bad}` };

  return { ...r, createdMs, cap, iso, takenMs, status: 'recoverable' };
});

const recoverable = results.filter((r) => r.status === 'recoverable');
const byStatus = results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
const movesDay = recoverable.filter((r) => etDay(r.takenMs) !== etDay(r.createdMs));
const lagDays = recoverable.map((r) => (r.createdMs - r.takenMs) / 86400000).sort((a, b) => a - b);
const pct = (n) => `${((n / Math.max(rows.length, 1)) * 100).toFixed(1)}%`;

console.log('\n─── PROPOSAL ───────────────────────────────────────────────');
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  ${pct(v)}`);
}
console.log(`\n  would write taken_at on ${recoverable.length} rows`);
console.log(`  of those, ${movesDay.length} move to a DIFFERENT DAY on the Photos wall`);
if (lagDays.length) {
  console.log(`  upload-minus-capture: median ${lagDays[Math.floor(lagDays.length / 2)].toFixed(2)}d, ` +
              `max ${lagDays.at(-1).toFixed(2)}d`);
}
const noOffset = recoverable.filter((r) => !r.cap.offset).length;
console.log(`  offset tag present on ${recoverable.length - noOffset}/${recoverable.length}` +
            `${noOffset ? ` — ${noOffset} fall back to ${ET}` : ''}`);
const fromCreateDate = recoverable.filter((r) => r.cap.source === 'CreateDate').length;
if (fromCreateDate) console.log(`  ⚠ ${fromCreateDate} used CreateDate, not DateTimeOriginal`);

const skipped = results.filter((r) => r.status.startsWith('skipped-'));
if (skipped.length) {
  console.log(`\n  ⚠ ${skipped.length} SKIPPED as implausible — these are NOT written:`);
  for (const r of skipped.slice(0, 10)) {
    console.log(`      ${r.id}  ${r.cap?.naive ?? '?'}  (${r.status.replace('skipped-', '')})`);
  }
}

// The full proposal, every row, so the dry run is reviewable as data rather than as a summary
// someone has to trust. Written on BOTH paths — after --apply it is the record of what changed.
const csv = ['id,storage_path,created_at_et,proposed_taken_at_et,offset_tag,tag_source,moves_day,status']
  .concat(results.map((r) => [
    r.id,
    JSON.stringify(r.storage_path),
    etDay(r.createdMs),
    r.status === 'recoverable' ? etDay(r.takenMs) : '',
    r.cap?.offset ?? '',
    r.cap?.source ?? '',
    r.status === 'recoverable' ? (etDay(r.takenMs) !== etDay(r.createdMs) ? 'YES' : 'no') : '',
    r.status,
  ].join(',')));
writeFileSync(outPath, csv.join('\n') + '\n');
console.log(`\n  full proposal written to ${outPath}`);

if (!apply) {
  console.log('\nDRY RUN COMPLETE — nothing written. Re-run with --apply to commit these values.');
  process.exit(0);
}

// ── write ─────────────────────────────────────────────────────────────────────────────────────────
// One row at a time rather than a bulk VALUES join: 926 statements against Neon is seconds, and a
// per-row failure then names its own row instead of rolling back a batch whose other members were
// fine. `AND taken_at IS NULL` makes every one of them idempotent.
console.log(`\nWRITING ${recoverable.length} rows…`);
let written = 0, raced = 0, failed = 0;
for (const r of recoverable) {
  try {
    const res = r.cap.offset
      ? await sql`UPDATE photos SET taken_at = ${r.iso}::timestamptz
                   WHERE id = ${r.id} AND taken_at IS NULL RETURNING id`
      : await sql`UPDATE photos SET taken_at = (${r.cap.naive}::timestamp AT TIME ZONE ${ET})
                   WHERE id = ${r.id} AND taken_at IS NULL RETURNING id`;
    if (res.length) written++; else raced++;
  } catch (e) {
    failed++;
    console.error(`  FAILED ${r.id}: ${e.message}`);
  }
}
console.log(`\nAPPLY COMPLETE — ${written} written, ${raced} already had a value (skipped), ${failed} failed.`);
if (failed) process.exit(1);
