import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope, loadOwnedSpace, loadOwnedLocation, loadOwnedInventoryItem, warnRejectedFk } from './household.js';
import { requestContext } from './request-context.js';
// Loaders for the body-supplied PARENT ids of the five photo parents household.js does not cover
// (contract: authz-parents.js).
import { loadOwnedProject, loadOwnedPlantingRef, loadOwnedEvent } from './authz-parents.js';
import { resolvePhotoViewUrl } from './photo-access.js';
import { isAllowedUploadKey } from './uploadKeyPolicy.js';
import { isAllowedStoragePath } from './uploadKeyPolicy.js';
import { SAFE_KEY_SEGMENT } from './uploadKeyPolicy.js';
import { normalizeViewTier, viewTierKey, PHOTO_VIEW_TIERS } from './viewTier.js';
// The soft-delete + restore core lives in photoDelete.js because this file is not importable from
// the repo root, so code written here could only be covered by SQL-text assertions.
import { softDeletePhoto, restorePhoto, listDeletedPhotos } from './photoDelete.js';
import { checkRateLimit, withRetryAfter } from './rate-limit.js';
import { withActor } from './audit-actor.js';

// photo-access.js reads the CloudFront signing key through this client; the kit holds its own for garden-app/secrets.
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
// SDK v3 3.679+ injects x-amz-checksum-mode=ENABLED into presigned GetObject URLs as a query param;
// S3 accepts that header only on real requests, so the URL 403s. WHEN_REQUIRED suppresses the injection.
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.S3_PHOTOS_BUCKET;
if (!BUCKET) throw new Error('S3_PHOTOS_BUCKET env var not set — check Lambda configuration');

// The kit refetches garden-app/secrets after this long, so a rotated secret doesn't strand a warm Lambda.
// Pinned by lambda/site-constants.static.test.js (C4).
const SECRETS_TTL_MS = 5 * 60 * 1000;

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

// Batch-presign limits/validators. These guard values that become an S3 KEY or a signed
// ContentType, so they are allowlists, not sanitizers: anything not matching is rejected.
const MAX_BATCH = 20;
// Mirrors the photos_intake_status_valid CHECK. Only these two are stored; every other state in
// the design (tagged / skipped) is DERIVED, so a third value here would be a bug, not a feature.
const INTAKE_STATUSES = ['pending_tag', 'upload_failed'];
// SAFE_KEY_SEGMENT (imported above, uploadKeyPolicy.js) — Clerk subs look like user_3D2gM0hIl03gjW3JM2DjtPzm0jI
// Relay caps. Lambda URLs cap request payloads at 6MB and base64 inflates 4/3; these keep base64
// plus the JSON envelope under it. A downscaled photo runs ~300-600KB decoded.
const RELAY_MAX_B64_CHARS = 5_200_000;      // ≈3.9MB decoded
const RELAY_THUMB_MAX_B64_CHARS = 700_000;  // ≈525KB decoded; thumbs run 80-260KB
const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const SAFE_CONTENT_TYPE = /^image\/[a-zA-Z0-9.+-]{1,32}$/;
// Space/photo ids reach uuid-typed columns. An unparseable value raises 22P02, which isUpstream()
// does not classify, so it would surface as an opaque 500. Shape-check first so every rejection is
// a 400 with the same generic body.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// The kit's onSecretsError: a secrets fetch failure is a retryable 503 here, not a thrown 502 the client cannot read.
function secretsUnavailable(err) {
  console.error('getSecrets failed', err?.message ?? err);
  return resp(503, { error: 'Service temporarily unavailable' });
}

// Classify transient upstream failures (DB / Secrets Manager / network unreachable) so the client
// gets a retryable 503 with a JSON+CORS envelope, not a generic 500 or a CORS-less 502 it cannot read.
function isUpstream(err) {
  const m = `${err?.code ?? ''} ${err?.name ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return /econn|etimedout|enotfound|getaddrinfo|fetch failed|socket hang up|timeout|throttl|serviceunavailable|connection terminated/.test(m);
}

// Pre-signed PUT URL — browser uploads directly to S3, Lambda never touches the bytes
async function getUploadUrl(photoId, ext, contentType) {
  const key = `uploads/${photoId}.${ext}`;
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType ?? 'image/jpeg',
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 300 }); // 5 minutes
  return { url, key };
}

// The S3 key grammar has no owner segment, so a caller holding another household's key could re-sign
// it (upload-url, thumb-upload-url), overwrite it (relay-upload) or register it as their own row
// (POST). True when a photos row OUTSIDE the caller's household already holds this key. Deliberately
// NO deleted_at: a soft-deleted row keeps its S3 bytes and can be restored (read-paths-deletedat.test.js
// names this exemption). No try/catch: a DB error must fail closed through the handler's outer catch.
// Unindexed scan of a small table.
async function foreignStorageKey(sql, key, householdIds) {
  const rows = await sql`SELECT 1 FROM photos WHERE storage_path = ${key} AND NOT (created_by = ANY(${householdIds})) LIMIT 1`;
  return rows.length > 0;
}

// Every upload URL issued and every object accepted counts one against the caller's hour (a batch one
// per file), spent after the request is validated and before anything is signed or PUT. POST /api/photos
// (register) is never limited: its bytes are already in S3, so a 429 there would strand them. Returns
// the 429 to send, or null. Tests: storage-key-guard.test.js; real Postgres: tests/integration/photos-intake.int.test.js.
const UPLOAD_LIMIT_PER_HOUR = 2500;
async function uploadLimitRefusal(sql, userId, objects) {
  if (await checkRateLimit(sql, userId, 'photos.upload', UPLOAD_LIMIT_PER_HOUR, objects)) return null;
  return withRetryAfter(resp(429, { error: `Rate limit exceeded — ${UPLOAD_LIMIT_PER_HOUR}/hour for photos.upload` }));
}

// Pre-signed GET URL — 15-minute expiry per architecture spec
async function getViewUrl(storagePath) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: storagePath });
  return getSignedUrl(s3, cmd, { expiresIn: 900 });
}

// Featured-photo auto-promote: parent by parent, only if the photo carries the linkage AND the
// parent's featured_photo_id IS NULL AND the caller owns the parent. Each UPDATE is its own atomic
// statement; the WHERE clauses settle races (the first to commit wins). Best-effort and NON-FATAL:
// the photo row is already persisted before this runs, so a promote failure must never fail the request.
//
// Called from TWO paths, which are not the same event:
//   POST            — first upload of a photo that already carries its parent.
//   PUT/PATCH       — ONLY when the row was previously intake_status='pending_tag'. A bulk-uploaded
//                     photo's POST had no parent, so the TAG is its first deposit; without this the
//                     plant silently stays photo-less. A re-tag of an already-tagged photo is a
//                     correction, not a deposit, and does NOT promote.
//
// The spaces arm is the fifth, gated on opts.spaceEnabled. The gate is a prod-safety control, not a
// feature toggle: where spaces.featured_photo_id is absent, an ungated arm would 42703 straight into
// the swallowed catch below and the space would silently never get a hero. `opts` is optional so a
// 3-arg call keeps the spaces arm inert.
//
// The garden_node and spaces arms go through withActor because their audit triggers read the actor GUC
// (lambda/audit-actor-guc.test.js); container, locations and inventory_items have no actor trigger and stay bare.
// The actor rides in opts ({ spaceEnabled, userId }) so the 4-arg flag calls keep their meaning; with no actor,
// withActor refuses before building anything and the refusal lands in the non-fatal catch below.
async function autoPromoteFeatured(sql, photo, householdIds, opts) {
  const userId = opts?.userId;
  try {
    if (photo.project_id) {
      await sql`
        UPDATE public.container
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.project_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
           AND deleted_at IS NULL
      `;
    }
    if (photo.plant_id) {
      await withActor(sql, userId, () => [sql`
        UPDATE public.garden_node p
           SET featured_photo_id = ${photo.id}
          FROM public.container pp
         WHERE p.id = ${photo.plant_id}
           AND p.container_id = pp.id
           AND pp.created_by = ANY(${householdIds})
           AND p.featured_photo_id IS NULL
           AND p.deleted_at IS NULL
      `]);
    }
    if (photo.location_id) {
      // Ownership predicate matches the three sibling arms; without it any authenticated user POSTing a
      // photo with another household's location_id could set that location's featured photo.
      await sql`
        UPDATE locations
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.location_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
           AND deleted_at IS NULL
      `;
    }
    if (photo.inventory_item_id) {
      await sql`
        UPDATE inventory_items
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.inventory_item_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
           AND deleted_at IS NULL
      `;
    }
    // Mirrors the inventory_items arm MINUS deleted_at: `spaces` has no deleted_at column, and asserting
    // one would 42703 into the catch below, so a space photo would silently never auto-feature.
    if (opts?.spaceEnabled && photo.space_id) {
      await withActor(sql, userId, () => [sql`
        UPDATE spaces
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.space_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
      `]);
    }
  } catch (promoteErr) {
    console.error('auto-promote non-fatal failure', promoteErr?.message ?? promoteErr);
  }
}

// The photos upsert exists in TWO literal variants, a deliberate prod-safety control. A neon tagged
// template's SQL text is STATIC: a JS `if` inside one template cannot keep `space_id` out of the
// emitted statement, so a single widened template would 42703 EVERY upload wherever photos.space_id
// is absent, regardless of the flag. The flag-OFF branch is byte-identical to the pre-space statement,
// which is what makes flag-OFF a true rollback lever, and it is the pattern any FUTURE additive space
// column must reuse (code may promote ahead of its DDL). Do not collapse the two templates into one.
//
// ADD-PARENT on conflict: the dedupe returns the EXISTING row, so a bare `DO UPDATE SET updated_at`
// would silently drop the parent the caller asked for and still answer 200. COALESCE keeps an existing
// parent (re-attaching elsewhere is a re-tag, not an upload) and fills a NULL one, in EVERY parent slot:
// photos carries six independent parent columns, so one row can attach to a planting AND an event AND
// an inventory item at once. Column references only, no new bound parameter, so flag-OFF/flag-ON
// parameter parity holds.
// NOT FIXED here (needs schema): a SECOND value for an ALREADY-OCCUPIED slot (bytes on planting A
// re-uploaded against planting B) cannot be stored, since one column holds one id. COALESCE keeps A,
// and unhonoredParents at the duplicate return makes that visible instead of silent. Do not widen
// this into a re-point: overwriting A would trade a silent drop for a silent MOVE.
function buildPhotoInsert(sql, body, userId, spaceEnabled) {
  if (spaceEnabled) {
    return sql`
      INSERT INTO photos
        (project_id, event_id, location_id, plant_id, inventory_item_id, space_id,
         storage_path, caption, is_public, uploaded_by, created_by,
         taken_at, content_hash, file_size_bytes, mime_type, original_filename,
         gps_lat, gps_lon, intake_status)
      VALUES (
        ${body.project_id ?? null},
        ${body.event_id ?? null},
        ${body.location_id ?? null},
        ${body.plant_id ?? null},
        ${body.inventory_item_id ?? null},
        ${body.space_id ?? null},
        ${body.storage_path},
        ${body.caption ?? null},
        ${body.is_public ?? true},
        ${userId},
        ${userId},
        ${body.taken_at ?? null},
        ${body.content_hash ?? null},
        ${body.file_size_bytes ?? null},
        ${body.mime_type ?? null},
        ${body.original_filename ?? null},
        ${body.gps_lat ?? null},
        ${body.gps_lon ?? null},
        ${body.intake_status ?? null}
      )
      ON CONFLICT (created_by, content_hash)
        WHERE content_hash IS NOT NULL AND deleted_at IS NULL
        DO UPDATE SET updated_at = now(),
                      project_id = COALESCE(photos.project_id, EXCLUDED.project_id),
                      event_id = COALESCE(photos.event_id, EXCLUDED.event_id),
                      location_id = COALESCE(photos.location_id, EXCLUDED.location_id),
                      plant_id = COALESCE(photos.plant_id, EXCLUDED.plant_id),
                      inventory_item_id = COALESCE(photos.inventory_item_id, EXCLUDED.inventory_item_id),
                      space_id = COALESCE(photos.space_id, EXCLUDED.space_id)
      RETURNING *, (xmax = 0) AS was_inserted
    `;
  }
  return sql`
    INSERT INTO photos
      (project_id, event_id, location_id, plant_id, inventory_item_id,
       storage_path, caption, is_public, uploaded_by, created_by,
       taken_at, content_hash, file_size_bytes, mime_type, original_filename,
       gps_lat, gps_lon, intake_status)
    VALUES (
      ${body.project_id ?? null},
      ${body.event_id ?? null},
      ${body.location_id ?? null},
      ${body.plant_id ?? null},
      ${body.inventory_item_id ?? null},
      ${body.storage_path},
      ${body.caption ?? null},
      ${body.is_public ?? true},
      ${userId},
      ${userId},
      ${body.taken_at ?? null},
      ${body.content_hash ?? null},
      ${body.file_size_bytes ?? null},
      ${body.mime_type ?? null},
      ${body.original_filename ?? null},
      ${body.gps_lat ?? null},
      ${body.gps_lon ?? null},
      ${body.intake_status ?? null}
    )
    ON CONFLICT (created_by, content_hash)
      WHERE content_hash IS NOT NULL AND deleted_at IS NULL
      DO UPDATE SET updated_at = now(),
                    project_id = COALESCE(photos.project_id, EXCLUDED.project_id),
                    event_id = COALESCE(photos.event_id, EXCLUDED.event_id),
                    location_id = COALESCE(photos.location_id, EXCLUDED.location_id),
                    plant_id = COALESCE(photos.plant_id, EXCLUDED.plant_id),
                    inventory_item_id = COALESCE(photos.inventory_item_id, EXCLUDED.inventory_item_id)
    RETURNING *, (xmax = 0) AS was_inserted
  `;
}

// The honest half of the dedupe fix: COALESCE above fills every EMPTY parent slot; this names the
// requests it could NOT honour, so an occupied slot stops being a 200 that quietly means "no". PURE
// (body + the row the upsert returned, no I/O) so it is unit-testable by extraction. Compares against
// the RETURNED row, never the pre-upsert state: that row is post-COALESCE, so a slot this very call
// filled reads as honoured. space_id is included only when the flag is on: otherwise the row has no
// such column and the body gate at the space_id pre-read rejects a flag-off caller's value.
const PHOTO_PARENT_COLUMNS = ['project_id', 'event_id', 'location_id', 'plant_id', 'inventory_item_id'];
function unhonoredParents(body, row, spaceEnabled) {
  const cols = spaceEnabled ? [...PHOTO_PARENT_COLUMNS, 'space_id'] : PHOTO_PARENT_COLUMNS;
  return cols
    .filter((c) => body[c] != null && row[c] !== body[c])
    .map((c) => ({ column: c, requested: body[c], kept: row[c] ?? null }));
}

// ── Return a tagged photo to the untagged inbox ───────────────────────────────────────────────────
//
// WHY: the re-tag PUT derived intake_status ENTIRELY from setsParent and never read body.intake_status,
// so it could drain the inbox but not refill it. CLEARING a row's parents made setsParent false, the
// CASE fell to `ELSE p.intake_status`, and the row kept NULL: parentless AND non-pending, which
// photos_must_have_parent forbids. Postgres answers 23514, isUpstream() does not classify it, and the
// client got an opaque 500.
//
// THE CHECKS (pg_get_constraintdef on prod and staging; migrations/ lags manual ALTERs):
//   photos_intake_status_valid — intake_status IS NULL OR intake_status IN ('pending_tag','upload_failed')
//   photos_must_have_parent    — event_id OR project_id OR location_id OR plant_id OR
//                                inventory_item_id OR space_id IS NOT NULL,
//                                OR COALESCE(intake_status = 'pending_tag', false)
// 'pending_tag' is therefore the ONLY status a parentless row may carry, which is why it is the only
// value this route accepts.
//
// 'upload_failed' IS REJECTED HERE THOUGH POST ACCEPTS IT, deliberately: do not "fix" this to reuse
// INTAKE_STATUSES. It is an upload-pipeline state that the second CHECK requires a parent for;
// asserting it from a RE-TAG has no meaning, and on an un-tag it is a guaranteed 23514. Same reasoning
// as the POST guard: reject the value we can name rather than let Postgres answer with a 500 the
// client cannot act on.
//
// null AND undefined both mean "not requested" — the POST guard's `!= null` idiom. An explicitly-null
// intake_status leaves the CASE on its existing arms, which can only preserve or clear, never violate
// a CHECK.
//
// PURE (body only, no I/O) so the mock-sql suite can EXECUTE it: index.js is not importable from the
// repo root, so a module-level function is the only shape these tests can drive for real.
function resolveIntakeRequest(body) {
  if (body.intake_status == null) return { restoresInbox: false };
  if (body.intake_status === 'pending_tag') return { restoresInbox: true };
  return { error: "intake_status must be 'pending_tag' or omitted" };
}

// The re-tag UPDATE, lifted out of the route (like buildPhotoInsert) so the mock-sql suite can assert
// on the statement and parameters this route actually emits, not on a string that resembles them.
//
// ARM ORDER IS THE CONTRACT, not formatting. setsParent is tested FIRST, so a body that sets a parent
// drains the inbox as it always did, even if it also asks for 'pending_tag'. That keeps the primary tag
// flow unchanged for a client that echoes the row's current intake_status back in a full-replace save.
// The parent assignment is the stronger signal, and the response carries the resulting status back.
//
// The third arm is unchanged: with restoresInbox false the CASE reduces to
// `WHEN setsParent THEN NULL ELSE p.intake_status`, so a body that omits intake_status behaves as
// before, including "an un-tagged pending_tag row STAYS pending_tag".
//
// space_id is deliberately absent (the route's flag-off byte-identity invariant; see the setsParent
// pre-read at the call site), and so are event_id / inventory_item_id: this route never set them, so a
// row parented by one keeps satisfying photos_must_have_parent on its own.
//
// POSITIONAL ARGUMENTS, NOT AN OPTIONS OBJECT, and that is load-bearing: the extractFunction helper
// every test in this dir copies brace-balances from the first `{` after the function header, so a
// destructured parameter list returns the SIGNATURE ALONE and the file fails to instantiate. Same
// shape as buildPhotoInsert for the same reason.
function buildRetagUpdate(sql, photoId, body, householdIds, setsParent, restoresInbox) {
  return sql`
    WITH prev AS (
      -- W-DEL ships the first route that can produce a soft-deleted photo, which turns "PATCH
      -- mutates an invisible row and returns 200" from unreachable into routine. The filter is
      -- the whole reason this CTE exists as a gate rather than a snapshot: a 0-row prev makes
      -- the UPDATE match nothing, so the route 404s a deleted photo instead of silently
      -- re-parenting it (and re-running autoPromoteFeatured against it).
      --
      -- IT IS ALSO THE UN-TAG PATH'S ONLY OWNERSHIP GATE. The UPDATE carries no created_by
      -- predicate of its own; the p.id = prev.id join inherits this one. A caller outside the
      -- owning household gets an empty prev, zero updated rows, and the 404 a missing photo gets —
      -- so V4-PHOTOUNTAG-001 cannot detach a photo the caller does not own, and adds no new
      -- surface here (it changes the SET list only). Do not "simplify" the join away.
      SELECT id, intake_status
        FROM photos
       WHERE id = ${photoId}
         AND created_by = ANY(${householdIds})
         AND deleted_at IS NULL
    )
    UPDATE photos p
       SET project_id    = ${body.project_id ?? null},
           location_id   = ${body.location_id ?? null},
           plant_id      = ${body.plant_id ?? null},
           caption       = ${body.caption ?? null},
           intake_status = CASE WHEN ${setsParent}::boolean THEN NULL
                                WHEN ${restoresInbox}::boolean THEN 'pending_tag'
                                ELSE p.intake_status END
      FROM prev
     WHERE p.id = prev.id
    RETURNING p.*, prev.intake_status AS prev_intake_status
  `;
}

// ── Space-hero reads ──────────────────────────────────────────────────────────────────────────────
// Both helpers below take `spaceEnabled` and return EARLY when it is false. That is the same prod-safety
// property as buildPhotoInsert's two-template split, obtained more cheaply: a neon tagged template's
// SQL text exists only when the tagged expression is EVALUATED, so a function that returns before its
// template never builds a statement. With the flag off nothing here can 42703 on a missing
// photos.space_id or spaces.featured_photo_id (both exist in prod now; the early return stays as the
// rollback lever and as the pattern for the next code-ahead-of-DDL column).
// The guard lives INSIDE the helpers (not only at the two call sites) so a future caller cannot
// reintroduce the hazard by forgetting the outer `if`.

// Resolve the caller's OWN household space with no id supplied (the discovery path). Without it every
// space route needs a :spaceId the client cannot obtain: there is no /api/spaces, and no shipped read
// shape leaks workspace_id.
//
// OWNERSHIP RULE = spaces.created_by, deliberately the SAME predicate loadOwnedSpace() and every other
// space route uses. The tempting alternative, walking the de-facto garden_node.workspace_id ->
// spaces.id link (no declared FK either way), describes ASSOCIATION, not ownership, and would hand the
// client a space that the very next PUT /space-featured then 400s as unowned. One resolution rule, one
// authz predicate, no route can disagree with another.
//
// MULTI-SPACE: deterministic oldest-first, never an error. created_at never changes, so the pick is
// stable across calls; id breaks a same-instant tie. Erroring on >1 would take a household's hero down
// the moment it gained a second space. COUNT(*) OVER () is evaluated before LIMIT, so one round trip
// yields both the pick and the true total, and the total is returned so the day the one-space
// assumption breaks is VISIBLE instead of silently arbitrary.
async function resolveHouseholdSpace(sql, householdIds, spaceEnabled) {
  if (!spaceEnabled) return [];
  return sql`
    SELECT id, COUNT(*) OVER () AS household_space_count
      FROM spaces
     WHERE created_by = ANY(${householdIds})
     ORDER BY created_at ASC, id ASC
     LIMIT 1
  `;
}

// The space-hero read, shared verbatim by the /:spaceId form and the no-id form so the two cannot drift.
//
// SOFT-DELETE FALLBACK: photos are soft-deleted, and spaces.featured_photo_id -> photos(id) is ON
// DELETE SET NULL, which fires only on a HARD delete. A soft-deleted hero leaves the FK pointing at a
// row whose S3 object the gallery no longer shows, so presigning it yields a dead URL. The stored hero
// is therefore joined WITH the deleted_at filter, and falls back to the space's newest surviving photo.
//
// featured_photo_id is the EFFECTIVE hero, not the raw column, so id and url cannot disagree. That
// alone makes the response ambiguous: the client's set-featured control has an identity no-op guard,
// so tapping "set as feature photo" on the photo that merely happens to be the fallback matched the
// returned id, no-oped, and never persisted the designation. featured_is_explicit closes that: TRUE
// iff the returned id came from spaces.featured_photo_id (alive + household-owned), FALSE whenever it
// came from the fallback or there is no hero at all.
async function fetchSpaceHero(sql, spaceId, householdIds, spaceEnabled) {
  if (!spaceEnabled) return [];
  return sql`
    SELECT s.id AS space_id,
           s.name,
           COALESCE(fp.id, fb.id) AS featured_photo_id,
           (fp.id IS NOT NULL) AS featured_is_explicit,
           COALESCE(fp.storage_path, fb.storage_path) AS hero_storage_path
      FROM spaces s
      LEFT JOIN photos fp
             ON fp.id = s.featured_photo_id
            AND fp.deleted_at IS NULL
            AND fp.created_by = ANY(${householdIds})
            -- MEMBERSHIP (added 2026-08-02 with PUT /api/photos/:id/space, crucible boss ruling).
            -- The hero must still BE a space photo. space-featured has always required this at
            -- WRITE time, but this read did not re-check it, on the reasonable ground that the
            -- write guaranteed it. The attach route breaks that guarantee: it can now clear
            -- space_id out from under an already-designated hero, leaving featured_photo_id
            -- pointing at a photo the ?space_id gallery will never return — a hero the user can
            -- see but cannot find, re-pick, or clear from the page it appears on.
            -- Re-checking here is self-healing: a de-membered hero drops to the fallback arm
            -- instead of rendering stale, and featured_is_explicit correctly reports FALSE.
            -- This is the READ half of one invariant; do not delete it as redundant with the
            -- write check, and do not add it without the write check.
            AND fp.space_id = s.id
      LEFT JOIN LATERAL (
             SELECT p.id, p.storage_path
               FROM photos p
              WHERE p.space_id = s.id
                AND p.deleted_at IS NULL
                AND p.created_by = ANY(${householdIds})
              ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.id DESC
              LIMIT 1
           ) fb ON true
     WHERE s.id = ${spaceId}
       AND s.created_by = ANY(${householdIds})
  `;
}

// The hero response when there is nothing to show. Used for the no-id form ONLY: the /:spaceId form
// still 404s an unknown/foreign space, because there the caller named an id. With no id there is
// nothing to probe FOR, so "your household has no space" is an empty state, not an error; a 404 would
// be indistinguishable from a broken scope and force the client to treat a normal condition as a failure.
const EMPTY_SPACE_HERO = {
  space_id: null,
  name: null,
  featured_photo_id: null,
  featured_is_explicit: false,
  featured_photo_view_url: null,
};

// The route line runs before the kit, so any caller writes its tail. CloudWatch reads a JSON metric filter's input from
// a Text line's first `{` to its end, so a raw path ending in {"msg":"authz-fk-reject"} would count as that line.
// Percent-encoding { } " and \ leaves no JSON fragment and keeps the path readable. Pinned by
// storage-key-guard.test.js; scripts/household-observability.sh test-patterns holds the server-side control.
export function logSafePath(text) {
  return String(text).replace(/[{}"\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export const handler = async (event) => {
  // Single method+path route log: per-route CloudWatch invocation evidence instead of per-function.
  // No payloads logged.
  console.log('route', logSafePath(event.requestContext?.http?.method ?? 'GET'), logSafePath(event.rawPath ?? ''));
  // The kit answers OPTIONS, a secrets failure (secretsUnavailable) and every sign-in refusal (401, the household
  // gate's 403) before any statement, and refetches secrets on SECRETS_TTL_MS.
  const ctx = await requestContext(event, { resp, neon, onSecretsError: secretsUnavailable, secretsTtlMs: SECRETS_TTL_MS });
  if (ctx.response) return ctx.response;
  const { userId, sql } = ctx;
  // Household scope keys on created_by. Its own line, after the kit's empty-sub 401: household-mode.test.js pins it here.
  const householdIds = householdScope(userId);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/photos';
  // Space-photos kill-flag, default OFF (absent env == disabled). Read per-invocation, matching the
  // CARE_RAIN_CREDIT_ENABLED house pattern in lambda/daily-plan.
  // Every flagged surface below is gated by SELECTING A DIFFERENT SQL TEMPLATE, never by a runtime `if`
  // inside one template, because a tagged template's text is fixed at construction. That is what makes
  // flag OFF byte-identical to the pre-space handler (the two space routes do not exist at all): a real
  // rollback lever, not a code path that merely returns early. Preserve it. (photos.space_id and
  // spaces.featured_photo_id now exist in both prod and staging.)
  const spacePhotosEnabled = process.env.SPACE_PHOTOS_ENABLED === 'true';

  try {
    // GET /api/photos/upload-url — returns pre-signed S3 PUT URL for browser upload
    // Query params: key (caller-generated via src/lib/photoKeys.js), content_type (MIME type)
    // SECURITY — the caller names the key, so it is confined to the closed buildPhotoKey grammar
    // (uploadKeyPolicy.js) and the signed ContentType to image/*. Anything else (inbox/*, which is
    // server-derived only; traversal; absolute keys; foreign prefixes; non-image types) 403s before any
    // presign happens.
    if (rawPath === '/api/photos/upload-url' && method === 'GET') {
      const key = event.queryStringParameters?.key;
      const contentType = event.queryStringParameters?.content_type ?? 'image/jpeg';
      if (!key) return resp(400, { error: 'key is required' });
      if (!isAllowedUploadKey(key) || !SAFE_CONTENT_TYPE.test(contentType)) {
        return resp(403, { error: 'Forbidden' });
      }
      // A key another household already registered is theirs — never re-sign it.
      if (await foreignStorageKey(sql, key, householdIds)) {
        warnRejectedFk(userId, 'photos', 'storage_path', key);
        return resp(403, { error: 'Forbidden' });
      }
      const refusal = await uploadLimitRefusal(sql, userId, 1);
      if (refusal) return refusal;
      const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
      const upload_url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      return resp(200, { upload_url, key });
    }

    // GET /api/photos/thumb-upload-url — presign the PUT for a new photo's 800px thumbnail.
    //
    // WHY: the read path derives thumb_url by CONVENTION (thumbs/<storage_path>) and nothing else
    // generates a thumb for a NEW upload, so new photos would fall back to their full-size original. The
    // client makes the thumb (it already has the decoded bitmap) and PUTs it here.
    //
    // SECURITY — this does NOT widen the closed upload-key grammar. The caller names the ORIGINAL key,
    // validated by the same isAllowedUploadKey it must already pass to upload the photo at all; the
    // `thumbs/` prefix is applied SERVER-SIDE and is not caller-nameable. So the only object this can ever
    // sign is the thumb OF a key the caller may already write. A caller-supplied `thumbs/...` key still
    // 403s on the route above. ContentType is pinned to image/jpeg because the thumb is always JPEG,
    // whatever the original's type.
    if (rawPath === '/api/photos/thumb-upload-url' && method === 'GET') {
      const key = event.queryStringParameters?.key;
      if (!key) return resp(400, { error: 'key is required' });
      if (!isAllowedUploadKey(key)) return resp(403, { error: 'Forbidden' });
      // The thumb of a foreign-registered original is theirs too.
      if (await foreignStorageKey(sql, key, householdIds)) {
        warnRejectedFk(userId, 'photos', 'storage_path', key);
        return resp(403, { error: 'Forbidden' });
      }
      const refusal = await uploadLimitRefusal(sql, userId, 1);
      if (refusal) return refusal;
      const cmd = new PutObjectCommand({
        Bucket: BUCKET,
        Key: `thumbs/${key}`,
        ContentType: 'image/jpeg',
      });
      const upload_url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      return resp(200, { upload_url, key: `thumbs/${key}` });
    }

    // POST /api/photos/batch — presign-ONLY, up to MAX_BATCH at a time.
    // There is deliberately no /confirm: POST /api/photos already IS the confirm, and per-photo confirms
    // give the progress granularity the bulk UX wants. getSignedUrl is a local HMAC (no S3 round trip), so
    // signing 20 in one call is nearly free.
    //
    // SECURITY — this route accepts NO caller-supplied key. The key is DERIVED from the authenticated
    // Clerk sub: inbox/{userId}/{uuid}.{ext}. The older GET /api/photos/upload-url takes a caller-named key
    // but confines it to the closed grammar (uploadKeyPolicy.js); inbox/* stays exclusively server-derived,
    // and that route 403s any inbox key. A presigned URL inherits the SIGNER's identity (this Lambda's
    // role), so an IAM policy scoped to inbox/* is not the control here and would break every other prefix
    // this same role signs; server-side derivation is.
    if (rawPath === '/api/photos/batch' && method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const files = Array.isArray(body.files) ? body.files : null;
      if (!files || files.length === 0) return resp(400, { error: 'files[] is required' });
      if (files.length > MAX_BATCH) {
        return resp(400, { error: `too many files (max ${MAX_BATCH}, got ${files.length})` });
      }
      // The Clerk sub becomes a path segment — validate rather than trust it.
      if (!SAFE_KEY_SEGMENT.test(userId)) return resp(400, { error: 'invalid user identifier' });

      // Every file is validated before the batch spends one unit per file, and only then is anything signed.
      const planned = [];
      for (const f of files) {
        const ext = String(f?.ext ?? 'jpg').toLowerCase();
        if (!SAFE_EXT.test(ext)) return resp(400, { error: `invalid ext: ${f?.ext}` });
        const contentType = typeof f?.content_type === 'string' && SAFE_CONTENT_TYPE.test(f.content_type)
          ? f.content_type
          : 'image/jpeg';
        planned.push({ ext, contentType });
      }
      const refusal = await uploadLimitRefusal(sql, userId, planned.length);
      if (refusal) return refusal;

      const uploads = [];
      for (const { ext, contentType } of planned) {
        const key = `inbox/${userId}/${randomUUID()}.${ext}`;
        const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
        uploads.push({
          key,
          upload_url: await getSignedUrl(s3, cmd, { expiresIn: 900 }),
          content_type: contentType,
        });
      }
      return resp(200, { uploads, expires_in: 900 });
    }

    // POST /api/photos/relay-upload — the photo bytes travel THROUGH the Lambda instead of direct-to-S3.
    // Exists because a client's route to S3 can be dead while its route to Lambda stays healthy (seen
    // live: TCP to s3.us-east-1 blackholed inside an ISP, device- and app-independent). The client calls
    // this ONLY after the direct presigned PUT failed its stall watchdog.
    //
    // SECURITY — the same closed grammar as upload-url, not a widening: the caller names the ORIGINAL key
    // only (isAllowedUploadKey; a caller-supplied thumbs/… key 403s), ContentType is allowlisted, and
    // decoded sizes are hard-capped (keeping base64+JSON under the 6MB Lambda URL payload cap). The thumb
    // key is derived SERVER-side, mirroring thumb-upload-url.
    if (rawPath === '/api/photos/relay-upload' && method === 'POST') {
      let relayBody;
      try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '{}');
        relayBody = JSON.parse(raw);
      } catch {
        return resp(400, { error: 'Invalid JSON body' });
      }
      const { key, content_type: relayType = 'image/jpeg', data_b64: dataB64, thumb_b64: thumbB64 = null } = relayBody ?? {};
      if (!key || !dataB64) return resp(400, { error: 'key and data_b64 are required' });
      if (!isAllowedUploadKey(key) || !SAFE_CONTENT_TYPE.test(relayType)) return resp(403, { error: 'Forbidden' });
      if (typeof dataB64 !== 'string' || dataB64.length > RELAY_MAX_B64_CHARS) return resp(413, { error: 'Photo too large to relay' });
      if (thumbB64 != null && (typeof thumbB64 !== 'string' || thumbB64.length > RELAY_THUMB_MAX_B64_CHARS)) return resp(413, { error: 'Thumb too large to relay' });
      // Never overwrite (or thumb) an object another household registered.
      if (await foreignStorageKey(sql, key, householdIds)) {
        warnRejectedFk(userId, 'photos', 'storage_path', key);
        return resp(403, { error: 'Forbidden' });
      }
      let bytes;
      let thumbBytes = null;
      try {
        bytes = Buffer.from(dataB64, 'base64');
        if (thumbB64) thumbBytes = Buffer.from(thumbB64, 'base64');
      } catch {
        return resp(400, { error: 'Invalid base64' });
      }
      if (!bytes.length) return resp(400, { error: 'Empty photo body' });
      const refusal = await uploadLimitRefusal(sql, userId, thumbBytes?.length ? 2 : 1);
      if (refusal) return refusal;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: relayType }));
      // Thumb is best-effort: the read path falls back to view_url when thumbs/<key> is absent, so a thumb
      // failure must never fail the relay.
      let thumbStored = false;
      if (thumbBytes && thumbBytes.length) {
        try {
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `thumbs/${key}`, Body: thumbBytes, ContentType: 'image/jpeg' }));
          thumbStored = true;
        } catch (thumbErr) {
          console.error('relay thumb PUT non-fatal failure', thumbErr?.message ?? thumbErr);
        }
      }
      return resp(200, { ok: true, key, thumb: thumbStored });
    }

    // GET /api/photos/view-url/:id — returns pre-signed GET URL for a photo record.
    //
    // `?tier=thumb` re-mints the THUMB derivative instead of the original, and the 200 body NAMES the tier
    // it minted. Absent tier => 'full', the previous response plus one additive field, so every deployed
    // client is unaffected. See viewTier.js for why the tier is an enum rather than a caller-supplied key
    // fragment.
    const viewMatch = rawPath.match(/^\/api\/photos\/view-url\/([^/]+)$/);
    if (viewMatch && method === 'GET') {
      const photoId = viewMatch[1];
      // Validated BEFORE the SELECT: a purely syntactic check on the caller's own input, so
      // rejecting here leaks nothing about whether the photo exists and skips a pointless query.
      const tier = normalizeViewTier(event.queryStringParameters?.tier);
      if (!tier) return resp(400, { error: `tier must be one of: ${PHOTO_VIEW_TIERS.join(', ')}` });
      const rows = await sql`
        SELECT storage_path FROM photos
        WHERE id = ${photoId}
          AND created_by = ANY(${householdIds})
          AND deleted_at IS NULL
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      // A missing thumb object presigns fine and fails on GET: the same hint contract both list paths
      // publish (thumb_url is a non-empty string on every row, though not every row has an object), and the
      // client's degrade chain answers it by falling back to the full source. Deliberately no HEAD probe: it
      // would spend an S3 round trip on every heal to learn what the next <img> error reports for free.
      // Keyed on its own line, not inlined into the call: lambda/photo-access.test.js census
      // requires every resolvePhotoViewUrl call to read `(<arg>, { presign, sm })` with no nested
      // parens, so that one well-formed call cannot vouch for a malformed sibling.
      const tierKey = viewTierKey(rows[0].storage_path, tier);
      const viewUrl = await resolvePhotoViewUrl(tierKey, { presign: getViewUrl, sm });
      return resp(200, { view_url: viewUrl, expires_in: 900, tier });
    }

    // ── Space routes (all inert unless SPACE_PHOTOS_ENABLED=true) ──────────────────────────────────────
    // There is deliberately NO /api/spaces Lambda. A new function would need a Function URL, CORS, a repo
    // variable, entries in three deploy matrices and an Infrastructure-Sync doc update: disproportionate
    // for a ONE-ROW table. The cost is the smell noted on space-hero/:spaceId below. The id-free space-hero
    // form is what makes that affordable: it is the DISCOVERY path, so the client never needs a spaces
    // list just to learn its own space id.

    // Turns hero rows into the response body: strips the internal storage path and presigns.
    // A presign failure leaves the url null rather than 500ing the hero read.
    const heroBody = async (rows) => {
      if (!rows.length) return null;
      const { hero_storage_path: heroPath, ...hero } = rows[0];
      let featured_photo_view_url = null;
      try {
        featured_photo_view_url = heroPath
          ? await resolvePhotoViewUrl(heroPath, { presign: getViewUrl, sm })
          : null;
      } catch { /* stays null — a presign failure must not 500 the hero read */ }
      return { ...hero, featured_photo_view_url };
    };

    // GET /api/photos/space-hero — the id-free form, the DISCOVERY path: every other space route needs a
    // :spaceId and no other surface hands a client one (no /api/spaces; the plants list SELECT omits
    // workspace_id; the daily-plan read model drops it).
    //
    // Resolution rule, zero-space and multi-space behaviour: see resolveHouseholdSpace above.
    // The response carries space_id, which the client then feeds to ?space_id / space-featured /
    // space-hero/:spaceId, so one round trip bootstraps all of them.
    if (spacePhotosEnabled && rawPath === '/api/photos/space-hero' && method === 'GET') {
      const owned = await resolveHouseholdSpace(sql, householdIds, spacePhotosEnabled);
      const household_space_count = owned.length ? Number(owned[0].household_space_count) : 0;
      if (household_space_count > 1) {
        // Not an error, but the one-space assumption this app was built on has just stopped
        // holding — the pick is deterministic, yet arbitrary from the user's point of view.
        console.warn(JSON.stringify({ msg: 'space-hero-multi-space', userId, household_space_count }));
      }
      if (!owned.length) return resp(200, { ...EMPTY_SPACE_HERO, household_space_count });
      const body = await heroBody(await fetchSpaceHero(sql, owned[0].id, householdIds, spacePhotosEnabled));
      return resp(200, { ...(body ?? EMPTY_SPACE_HERO), household_space_count });
    }

    // GET /api/photos/space-hero/:spaceId — the explicit form; still 404s an unknown or out-of-household space.
    // SMELL, acknowledged and priced in: this returns spaces.name, which is not photos-domain data. It is
    // here only because standing up a spaces Lambda costs more than the smell. If `spaces` ever grows real
    // CRUD, this route moves.
    const spaceHeroMatch = rawPath.match(/^\/api\/photos\/space-hero\/([^/]+)$/);
    if (spacePhotosEnabled && spaceHeroMatch && method === 'GET') {
      const spaceId = spaceHeroMatch[1];
      if (!UUID_RE.test(spaceId)) return resp(404, { error: 'Not found' });
      const body = await heroBody(await fetchSpaceHero(sql, spaceId, householdIds, spacePhotosEnabled));
      if (!body) return resp(404, { error: 'Not found' });
      return resp(200, body);
    }

    // PUT /api/photos/space-featured/:spaceId — body { photo_id } designates the Space hero;
    // { photo_id: null } clears it. RE-DESIGNATION is the point: unlike autoPromoteFeatured (which only
    // fills a NULL), this is an explicit choice and overwrites whatever is there, so the first-uploaded
    // photo is never permanently locked in.
    //
    // AUTHZ: two independent gates, both anchored on created_by — the space must be household-owned
    // (loadOwnedSpace) AND the photo must already carry space_id = :spaceId and be household-owned.
    // NOT uploaded_by: that is the stale pattern; every other featured-photo validator in the repo uses
    // created_by. Every rejection returns the SAME generic 400 — a distinct "not found" would itself be an
    // existence oracle for another household's ids.
    const spaceFeaturedMatch = rawPath.match(/^\/api\/photos\/space-featured\/([^/]+)$/);
    if (spacePhotosEnabled && spaceFeaturedMatch && method === 'PUT') {
      const spaceId = spaceFeaturedMatch[1];
      const body = JSON.parse(event.body ?? '{}');
      const photoId = body.photo_id ?? null;
      const REJECT = { error: 'photo_id must be a photo attached to a space you can use' };

      if (!UUID_RE.test(spaceId)) return resp(400, REJECT);
      if (!await loadOwnedSpace(sql, spaceId, householdIds)) {
        warnRejectedFk(userId, 'spaces', 'id', spaceId);
        return resp(400, REJECT);
      }
      if (photoId != null) {
        if (!UUID_RE.test(String(photoId))) return resp(400, REJECT);
        const linkRows = await sql`
          SELECT 1 FROM photos
           WHERE id = ${photoId}
             AND space_id = ${spaceId}
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NULL
        `;
        if (!linkRows.length) {
          warnRejectedFk(userId, 'spaces', 'featured_photo_id', photoId);
          return resp(400, REJECT);
        }
      }
      const [, updated] = await withActor(sql, userId, () => [sql`
        UPDATE spaces
           SET featured_photo_id = ${photoId}, updated_at = now()
         WHERE id = ${spaceId}
           AND created_by = ANY(${householdIds})
        RETURNING id AS space_id, featured_photo_id
      `]);
      if (!updated.length) return resp(400, REJECT);
      return resp(200, updated[0]);
    }

    // PUT /api/photos/:id/space — body { space_id: uuid|null } attaches an existing photo to the Space,
    // or detaches it. This is the ATTACH path; designating a hero is space-featured above.
    //
    // WHY A DEDICATED SUB-RESOURCE rather than adding space_id to the general re-tag PUT, in order of weight:
    //   1. The general PUT's template EXECUTES WITH THE FLAG OFF. Naming space_id in it would break the
    //      byte-identical-rollback invariant this whole feature is architected around (see buildPhotoInsert's
    //      two-template split) and would 42703 in any environment lacking the column. A flag-gated route
    //      cannot execute flag-off, so the hazard cannot arise here.
    //   2. The general PUT replaces a fixed field set: an omitted key means "cleared". space_id cannot join
    //      that rule without silently detaching on every ordinary re-tag from the shipped client (which
    //      never sends it), and there would then be no way to express "clear" distinguishably from "didn't
    //      mention it". On a single-field route PUT genuinely IS replace, so the key is REQUIRED: absent is
    //      a 400, explicit null is the clear.
    //
    // Deliberately does NOT call autoPromoteFeatured. Attaching a batch of photos to the property must not
    // silently make the first one the hero — attach and designate are separate acts, which is the entire
    // reason there are two routes. The upload path still auto-promotes (POST, 4-arg, guarded on
    // featured_photo_id IS NULL).
    //
    // It DOES drain the quick-tag inbox. Attaching the Space IS filing the photo, so leaving the row at
    // 'pending_tag' would keep idx_photos_intake_pending matching and the carousel would re-serve a photo
    // the user already filed. Narrowly guarded — see `drainsInbox` below: attach only (never detach), and
    // only out of 'pending_tag' (never 'upload_failed').
    //
    // Every rejection returns the SAME generic 400, matching space-featured: a distinct 404 would be an
    // existence oracle for another household's photo ids.
    const photoSpaceMatch = rawPath.match(/^\/api\/photos\/([^/]+)\/space$/);
    if (spacePhotosEnabled && photoSpaceMatch && method === 'PUT') {
      const photoId = photoSpaceMatch[1];
      const body = JSON.parse(event.body ?? '{}');
      const REJECT = { error: 'space_id must be a space you can use, or null' };

      if (!UUID_RE.test(photoId)) return resp(400, REJECT);
      // Key presence, not truthiness: `{space_id: null}` is a meaningful request (detach) and must
      // be distinguishable from an omitted key, which is a malformed one.
      if (!Object.prototype.hasOwnProperty.call(body, 'space_id')) {
        return resp(400, { error: 'space_id is required (send null to detach)' });
      }
      const nextSpaceId = body.space_id ?? null;
      if (nextSpaceId !== null) {
        if (!UUID_RE.test(String(nextSpaceId)) || !await loadOwnedSpace(sql, nextSpaceId, householdIds)) {
          warnRejectedFk(userId, 'photos', 'space_id', nextSpaceId);
          return resp(400, REJECT);
        }
      }

      // Load first rather than UPDATE-and-catch. photos_must_have_parent is 7-clause and counts
      // space_id, so detaching a SPACE-ONLY photo leaves it parentless — a 23514 that isUpstream()
      // does not classify, i.e. an opaque 500 on a legitimate request. Pre-checking turns that into
      // an honest 400. deleted_at IS NULL here is load-bearing: without it a soft-deleted row could
      // be attached and then designated hero.
      const owned = await sql`
        SELECT id, project_id, event_id, location_id, plant_id, inventory_item_id, intake_status
          FROM photos
         WHERE id = ${photoId}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NULL
      `;
      if (!owned.length) {
        warnRejectedFk(userId, 'photos', 'id', photoId);
        return resp(400, REJECT);
      }
      const p = owned[0];
      const hasOtherParent = Boolean(p.project_id || p.event_id || p.location_id || p.plant_id || p.inventory_item_id);
      if (nextSpaceId === null && !hasOtherParent) {
        return resp(400, { error: 'cannot detach the only parent — attach it elsewhere first' });
      }

      // DRAIN THE INBOX on attach. Same rule the general PUT applies (clear intake_status only when a parent
      // is actually being SET), extended to the parent this route owns. Without it a bulk-uploaded photo
      // whose only tag is the Space keeps intake_status='pending_tag' forever: idx_photos_intake_pending keeps
      // matching, so the quick-tag carousel re-serves a photo the user already filed and the inbox cannot drain.
      //
      // Guarded three ways, deliberately:
      //   - ONLY on attach (nextSpaceId !== null). Detach is the "un-tag" case, and the general PUT already
      //     establishes that an un-tagged pending row must STAY pending — clearing there would mark a row
      //     filed that nobody has filed.
      //   - ONLY from 'pending_tag'. 'upload_failed' is a different state with its own recovery path (and its
      //     own CHECK clause at the POST validator); attaching a space does not mean the failed upload succeeded.
      //   - Computed in JS from the row we ALREADY read, so no extra round trip and no widening of any shared
      //     template.
      const drainsInbox = nextSpaceId !== null && p.intake_status === 'pending_tag';

      // No cast on the bound value: in an UPDATE assignment the column supplies the type, so a bare
      // null binds cleanly. (A `::uuid` cast inside a CASE expression does NOT — the neon serverless
      // driver cannot type a null parameter there. Same trap, different context.)
      const attached = await sql`
        UPDATE photos
           SET space_id = ${nextSpaceId},
               intake_status = CASE WHEN ${drainsInbox}::boolean THEN NULL ELSE intake_status END
         WHERE id = ${photoId}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NULL
        RETURNING id, space_id, intake_status
      `;
      if (!attached.length) return resp(400, REJECT);
      return resp(200, attached[0]);
    }

    // GET /api/photos/deleted — the "Recently deleted" surface.
    //
    // THIS ROUTE IS WHY THE DELETE CONFIRM MAY SAY "recoverable from Recently deleted"
    // (EventDeleteConfirm.jsx). A destructive control must not ship ahead of the recovery path it advertises.
    //
    // The SELECT lives in photoDelete.js, not here: it is the one read that MUST return
    // `deleted_at IS NOT NULL`, and index.js is where the enumeration guard (read-paths-deletedat.test.js)
    // asserts the opposite of every template. See the header comment on listDeletedPhotos.
    //
    // Declared ABOVE the exact-match `/api/photos` GET for reading order only; the two cannot collide (that
    // one is `===`, not a prefix). A DELETE to this path falls to the bare-:id arm and 404s on UUID_RE,
    // which is the correct answer — there is no permanent-delete verb here and Soft-Delete-Only means
    // there never will be.
    if (rawPath === '/api/photos/deleted' && method === 'GET') {
      const rows = await listDeletedPhotos(sql, {
        householdIds,
        limit: event.queryStringParameters?.limit,
      });
      // Same presign pair as the live list: the S3 object SURVIVES a soft delete, so a recently-deleted photo
      // still renders its own thumbnail — a user cannot decide what to put back from a grid of grey boxes.
      // thumb_url stays a HINT (the client falls back to view_url) exactly as on the live list.
      const withUrls = await Promise.all(
        rows.map(async (photo) => {
          let view_url = null, thumb_url = null;
          try {
            view_url = await resolvePhotoViewUrl(photo.storage_path, { presign: getViewUrl, sm });
          } catch { /* view_url stays null — the client renders a placeholder tile, not a broken page */ }
          try {
            thumb_url = photo.storage_path
              ? await resolvePhotoViewUrl(`thumbs/${photo.storage_path}`, { presign: getViewUrl, sm })
              : null;
          } catch { /* non-fatal: the client falls back to view_url */ }
          return { ...photo, view_url, thumb_url };
        })
      );
      return resp(200, withUrls);
    }

    // GET /api/photos — list user's photos with optional filters
    if (rawPath === '/api/photos' && method === 'GET') {
      const projectId = event.queryStringParameters?.project_id ?? null;
      // Attachment-scoped gallery. ?attachedTo=<plantingId> returns every photo ATTACHED to that planting by
      // ANY source — directly via photos.plant_id, OR through one of its events (photos.event_id ->
      // event_log.plant_id). This is the canonical gallery membership rule: project_id/location_id are NOT
      // attachment sources, so the union is scoped to the PLANTING, not its container (a plant_id-attached
      // photo living in a parent/sibling container still appears). Distinct from ?project_id (container
      // gallery); this does NOT overload it.
      const attachedTo = event.queryStringParameters?.attachedTo ?? null;
      // Space gallery. ?location_id=<spaceId> returns photos attached to that space OR any descendant space
      // (same recursive parent_id walk as the events By-Space filter; a leaf resolves to just itself). A
      // CONTAINER-style filter like ?project_id, NOT an attachment source for planting galleries: the
      // ?attachedTo rule is unchanged.
      const locationId = event.queryStringParameters?.location_id ?? null;
      // The SPACE gallery (photos.space_id), which is NOT ?location_id above: that walks a WITH RECURSIVE
      // loc_subtree, and reusing the walk here would also show every descendant LOCATION's photos. This is an
      // EXACT match on the space. Parsed only when the flag is on, so with the flag off spaceId is
      // unconditionally null, its branch is unreachable, and an unknown ?space_id param is ignored as before.
      const spaceId = spacePhotosEnabled ? (event.queryStringParameters?.space_id ?? null) : null;
      if (spaceId !== null && !UUID_RE.test(spaceId)) return resp(400, { error: 'space_id must be a uuid' });
      // 120 thumbs (~200KB each) are ~24MB where 120 originals were ~369MB, so the grid can take 120 per
      // page without pagination.
      const limit = Math.min(parseInt(event.queryStringParameters?.limit ?? '120', 10), 200);

      // Archived plantings must not be LOADED by an aggregate gallery, so the predicate is a WHERE-clause
      // anti-join, not a client filter — a row filtered in the browser was still queried, serialised and
      // shipped. There are TWO anti-joins, not one, because a photo reaches a planting two ways
      // (photos.plant_id, and photos.event_id -> event_log.plant_id); a single predicate on p.plant_id closes
      // only part of the leak and reads as if it closed all of it.
      //
      // AXIS: archived_at, NOT deleted_at. The two are orthogonal (lambda/plants/index.js archives with
      // `AND p.deleted_at IS NULL` still in the WHERE) and every template below keeps its existing deleted_at
      // predicate untouched.
      //
      // NOT APPLIED to the ?attachedTo branch, deliberately. That branch is the planting's OWN gallery on
      // PlantingDetail and its every row is by construction that one planting's. Filtering there does nothing
      // when the planting is live and blanks the page when it is archived, which would delete the ONLY route
      // an archived planting still has (lambda/events/index.js: "Deletion hides; archiving does not"). The
      // four branches below are aggregates over MANY plantings; those are the default views.
      //
      // PLANT AXIS ONLY. plant_projects also carries archived_at, but whether archiving a container hides its
      // contents is an open Dave ruling (R3 recon §2 DAVE-DECISION 3), and this code does not guess it.
      //
      // The event anti-join carries `ea.deleted_at IS NULL` because it makes TWO hops and the intermediate
      // row has a lifecycle of its own: without the scope it traverses a DEAD edge, and a photo stranded on a
      // soft-deleted event would be hidden by an ARCHIVE predicate, on the strength of a planting it reaches
      // only through a row the user already deleted. The ?attachedTo branch scopes the identical traversal
      // (`e.deleted_at IS NULL`). It is inert as shipped: DELETE /api/events/:id DETACHES photos rather than
      // deleting them (lambda/events/index.js: "photos -> DETACH, never delete"), so no live photo points at a
      // soft-deleted event. There is deliberately no hiding predicate for that state: an orphaned photo should
      // surface in the gallery, not vanish behind an unrelated planting's archive flag.
      //
      // All five templates below project p.inventory_item_id and p.intake_status. Both were READ by the
      // client and never SENT by the server, the one defect shape a green client-side test cannot see
      // (photoModel's own unit tests supply the field the wire omitted).
      //
      // THE PARENT SET IS SEVEN CLAUSES. photos_must_have_parent counts six FKs (event, project, location,
      // plant, inventory_item, space) plus the escape hatch intake_status='pending_tag' that makes a parentless
      // row legal. photoModel.js enumerates all six in PARENT_KINDS/PARENT_FIELDS and counts them off the raw
      // row, so a column the query never selected is a parent the model cannot see:
      //   inventory_item_id — a photo can hang off an inventory item and nothing else. Undelivered, it reads
      //     parentCount=0 -> isAttached=false, so PhotoLibrary's Untagged chip flags it as unfinished work on
      //     every visit.
      //   intake_status — a legal 'pending_tag' row has all six FKs null. Undelivered, photoModel's
      //     `pendingTag` is permanently false and the row classifies PARENTAGE.ORPHAN, the state the CHECK
      //     forbids: a legal photo reported as impossible.
      // This is the third recurrence of one defect (select-columns.test.js records BUG-PHOTOPARENT-001
      // recurring because a parent column was missed). gallery-intake-status.test.js closes the class by
      // enumeration: every PARENT_FIELDS entry must be reachable on every gallery template, so a seventh
      // parent kind added to photoModel cannot silently reopen it.
      //
      // WHY COLUMNS AND NOT A DECORATING QUERY like the space_id block below. That block spends an extra round
      // trip to buy a property these two do not need: byte-identical flag-off rollback. space_id is
      // code-ahead-of-DDL behind SPACE_PHOTOS_ENABLED; these two have no flag, are already named by the INSERT
      // templates, and are pinned in select-columns.test.js's evidence-derived list (verified against prod
      // information_schema by scripts/dev-main-schema-audit.py). With no rollback invariant to protect, a
      // second query is pure cost and a second source of truth.
      //
      // ALL FIVE templates, including ?attachedTo (whose rows carry a parent by construction and can never be
      // pending): uniformity is the point, so the next branch added by copy-paste inherits both columns.
      //
      // p.space_id is NOT projected here: the decorating query below supplies it only when SPACE_PHOTOS_ENABLED
      // is on, and projecting it here would break the flag-off rollback invariant space-photos.test.js pins.
      //
      // p.taken_at IS DELIVERED, ordered as COALESCE(p.taken_at, p.created_at). taken_at is EXIF
      // DateTimeOriginal, read off the original file before the downscale and before the privacy strip
      // (useUploadPhoto.js; the order is load-bearing there). It had no reader only because this route
      // withheld it, so the app kept sorting a photograph by when the file arrived instead of when it was
      // shot, while the public site already publishes on coalesce(e.event_date, p.taken_at, p.created_at)
      // (gam-site/tools/generate_candidates.py). The COALESCE is the whole feature for rows where taken_at is
      // NULL (most of them: the upload path did not always read the tag), not a defensive nicety: sorting on
      // the bare column would sink those rows to the end of every gallery.
      //
      // NOT INDEX-BACKED, a measured choice: the expression defeats the (created_by, taken_at) index, so these
      // queries sort in memory. At this table size against a LIMIT of 120 that is noise; if it stops being
      // noise, add an expression index on COALESCE(taken_at, created_at) rather than retreating to created_at.
      // Field-by-field census of what photoModel reads vs what these templates send: gallery-parent-projection.test.js.

      let rows;
      if (attachedTo) {
        rows = await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.inventory_item_id, p.intake_status,
              p.storage_path, p.caption, p.is_public, p.created_at, p.taken_at,
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
              AND p.deleted_at IS NULL
              AND (
                p.plant_id = ${attachedTo}
                OR p.event_id IN (
                  SELECT e.id FROM public.event_log e
                  WHERE e.plant_id = ${attachedTo} AND e.deleted_at IS NULL
                )
              )
            ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.id DESC
            LIMIT ${limit}
          `;
      } else if (locationId) {
        // The location, space and unscoped branches also hide a photo whose CONTAINER (photos.project_id) is
        // archived — `pp.archived_at IS NULL` on the existing LEFT JOIN, so a photo with no container passes.
        // NOT on ?project_id= (the container's own page) or ?attachedTo (the planting's own gallery): an
        // archived thing keeps its own page.
        rows = await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.inventory_item_id, p.intake_status,
              p.storage_path, p.caption, p.is_public, p.created_at, p.taken_at,
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
              AND p.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.garden_node gna
                WHERE gna.id = p.plant_id AND gna.archived_at IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.event_log ea
                JOIN public.garden_node gne ON gne.id = ea.plant_id
                WHERE ea.id = p.event_id AND ea.deleted_at IS NULL
                  AND gne.archived_at IS NOT NULL
              )
              AND pp.archived_at IS NULL
              AND p.location_id IN (
                WITH RECURSIVE loc_subtree AS (
                  SELECT id FROM locations WHERE id = ${locationId} AND deleted_at IS NULL
                  UNION ALL
                  SELECT l.id FROM locations l
                    JOIN loc_subtree st ON l.parent_id = st.id
                    WHERE l.deleted_at IS NULL
                )
                SELECT id FROM loc_subtree
              )
            ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.id DESC
            LIMIT ${limit}
          `;
      } else if (projectId) {
        rows = await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.inventory_item_id, p.intake_status,
              p.storage_path, p.caption, p.is_public, p.created_at, p.taken_at,
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
              AND p.project_id = ${projectId}
              AND p.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.garden_node gna
                WHERE gna.id = p.plant_id AND gna.archived_at IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.event_log ea
                JOIN public.garden_node gne ON gne.id = ea.plant_id
                WHERE ea.id = p.event_id AND ea.deleted_at IS NULL
                  AND gne.archived_at IS NOT NULL
              )
            ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.id DESC
            LIMIT ${limit}
          `;
      } else if (spaceId) {
        // EXACT match. The created_by conjunct is load-bearing and must never be dropped as
        // "redundant with the space check": space_id is attachable, so without it an attach to a
        // space the caller can see would expose every OTHER household's photos on that space.
        rows = await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.inventory_item_id, p.space_id, p.intake_status,
              p.storage_path, p.caption, p.is_public, p.created_at, p.taken_at,
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
              AND p.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.garden_node gna
                WHERE gna.id = p.plant_id AND gna.archived_at IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.event_log ea
                JOIN public.garden_node gne ON gne.id = ea.plant_id
                WHERE ea.id = p.event_id AND ea.deleted_at IS NULL
                  AND gne.archived_at IS NOT NULL
              )
              AND pp.archived_at IS NULL
              AND p.space_id = ${spaceId}
            ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.id DESC
            LIMIT ${limit}
          `;
      } else {
        // The UNSCOPED gallery (the Photo Library's default page and its quick-tag source, the Space attach
        // picker) leaves out SUPPLIER PACKET IMAGES: the vendor's catalog picture attached to a seed lot so My
        // seeds has a thumbnail. They are the supplier's photographs, not ours, and a bulk import of them filled
        // the whole first page. They stay on the seed pages, which read them through the lot.
        // The four scoped branches above need no filter: a supplier image's only parent is its inventory item,
        // which none of them reads. Marker: our own ingest names the file vendor-image--* (there is no
        // provenance column); COALESCE because original_filename is NULL on most rows, and a bare NOT LIKE on
        // NULL would drop them all. Header search (lambda/dashboard/handlers.js searchPhotos) carries the same
        // predicate; supplier-image-marker-sync.test.js holds the two equal.
        rows = await sql`
            SELECT
              p.id, p.project_id, p.event_id, p.location_id, p.plant_id,
              p.inventory_item_id, p.intake_status,
              p.storage_path, p.caption, p.is_public, p.created_at, p.taken_at,
              pp.display_name AS project_name
            FROM photos p
            LEFT JOIN public.container pp ON pp.id = p.project_id
            WHERE p.created_by = ANY(${householdIds})
              AND p.deleted_at IS NULL
              AND COALESCE(p.original_filename, '') NOT LIKE 'vendor-image--%'
              AND NOT EXISTS (
                SELECT 1 FROM public.garden_node gna
                WHERE gna.id = p.plant_id AND gna.archived_at IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.event_log ea
                JOIN public.garden_node gne ON gne.id = ea.plant_id
                WHERE ea.id = p.event_id AND ea.deleted_at IS NULL
                  AND gne.archived_at IS NOT NULL
              )
              AND pp.archived_at IS NULL
            ORDER BY COALESCE(p.taken_at, p.created_at) DESC, p.id DESC
            LIMIT ${limit}
          `;
      }

      // Decorate the list with space_id when the gate is open.
      //
      // WHY A SEPARATE QUERY rather than adding `p.space_id` to the four SELECTs above. The client's
      // "untagged" filter treats a photo with no parent as unfinished work, and space_id is one of the seven
      // parents the CHECK recognises, but only the ?space_id branch selected the column. The field was then
      // `undefined` on every row the Photos page saw and its space conjunct could never fire, so once photos
      // carry a space_id every one of them would render as "untagged".
      //
      // The obvious fix, naming the column in all four templates, costs the byte-identical-rollback invariant:
      // those templates EXECUTE WITH THE GATE CLOSED, so flag-off would no longer match the pre-space handler,
      // the template-count tripwire in space-photos.test.js would go red, and an existing flag-off assertion
      // (the property must be ABSENT) would invert. Splitting each into a pair fixes that at the price of
      // eight near-identical SELECTs, the drift cost buildPhotoInsert's own header calls out.
      //
      // This keeps all three properties: the four templates are untouched, the ONE template that names
      // space_id is constructed only when the gate is open, and the field appears exactly when the feature is
      // live. Cost is one indexed PK lookup over at most `limit` ids, against a list call that already awaits
      // N presign round trips.
      if (spacePhotosEnabled && rows.length) {
        // deleted_at IS NULL is redundant here (every id came from a query that already filtered it) and is
        // present anyway: the enumeration guard closes the CLASS, so a serving SELECT on photos carries the
        // filter whether or not this caller needs it, and the guard never needs per-site reasoning.
        const spaceRows = await sql`
          SELECT id, space_id FROM photos
           WHERE id = ANY(${rows.map((r) => r.id)})
             AND deleted_at IS NULL
        `;
        const spaceById = new Map(spaceRows.map((r) => [r.id, r.space_id]));
        rows = rows.map((r) => ({ ...r, space_id: spaceById.get(r.id) ?? null }));
      }

      // Attach pre-signed view URLs to each photo record.
      //
      // thumb_url: the grid used to serve full-size ORIGINALS (~3MB each), so nothing rendered for a long
      // time and then everything appeared at once; thumbnails are ~200KB (11-23x smaller). The thumb key is
      // SERVER-DERIVED (thumbs/<storage_path>), never caller-supplied, which avoids widening the closed
      // upload-key grammar above. A photo uploaded before its thumb exists presigns to a missing object, so
      // the client treats thumb_url as a HINT and falls back to view_url on error.
      const withUrls = await Promise.all(
        rows.map(async (photo) => {
          let view_url = null, thumb_url = null;
          try {
            view_url = await resolvePhotoViewUrl(photo.storage_path, { presign: getViewUrl, sm });
          } catch { /* view_url stays null — same as pre-existing behavior */ }
          try {
            thumb_url = photo.storage_path
              ? await resolvePhotoViewUrl(`thumbs/${photo.storage_path}`, { presign: getViewUrl, sm })
              : null;
          } catch { /* non-fatal: the client falls back to view_url */ }
          return { ...photo, view_url, thumb_url };
        })
      );

      return resp(200, withUrls);
    }

    // POST /api/photos — register a photo record after browser has uploaded to S3
    // Browser: PUT to upload_url (from upload-url endpoint), then POST here with storage_path.
    //
    // AUTO-PROMOTE: after the insert, if the new photo links to a featurable parent (project / plant /
    // location / inventory_item) AND that parent's featured_photo_id IS NULL, set it to this photo's id
    // (autoPromoteFeatured). The UPDATE's `WHERE featured_photo_id IS NULL` predicate is race-safe: with
    // concurrent uploads only the first to commit wins; later inserts no-op on the auto-promote.
    if (rawPath === '/api/photos' && method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.storage_path) return resp(400, { error: 'storage_path is required' });
      // storage_path was bound straight into the INSERT, so a caller could register thumbs/…, another sub's
      // inbox, or another household's key and then view-url it. One body for both rejects (grammar, foreign
      // row): the only signal left is "this exact key is registered elsewhere", to a caller who already holds
      // the full uuid key (accepted residual).
      if (!isAllowedStoragePath(body.storage_path, userId)) {
        warnRejectedFk(userId, 'photos', 'storage_path', body.storage_path);
        return resp(400, { error: 'storage_path is not a valid upload key' });
      }
      if (await foreignStorageKey(sql, body.storage_path, householdIds)) {
        warnRejectedFk(userId, 'photos', 'storage_path', body.storage_path);
        return resp(400, { error: 'storage_path is not a valid upload key' });
      }

      // intake_status reaches a CHECK-constrained column, so validate it here rather than letting
      // Postgres reject it — a 23514 falls through isUpstream() to an opaque 500 the client cannot
      // act on. Mirrors photos_intake_status_valid.
      if (body.intake_status != null && !INTAKE_STATUSES.includes(body.intake_status)) {
        return resp(400, { error: `intake_status must be one of: ${INTAKE_STATUSES.join(', ')}` });
      }
      // photos_must_have_parent admits a parentless row ONLY for 'pending_tag'. An 'upload_failed'
      // row with no parent is therefore a guaranteed constraint violation; 400 it explicitly.
      // The CHECK counts space_id as a parent, but this guard counts it only when the flag is on, so that
      // flag-off stays byte-identical to the pre-space expression — the client cannot send a space_id the
      // server would honour while the gate is closed.
      const spaceParent = spacePhotosEnabled ? (body.space_id ?? null) : null;
      if (body.intake_status === 'upload_failed'
          && !(body.project_id || body.event_id || body.location_id || body.plant_id || body.inventory_item_id || spaceParent)) {
        return resp(400, { error: "intake_status 'upload_failed' requires a parent" });
      }

      // AUTHZ: space_id is a cross-entity FK set straight from the body. The DB FK proves the space EXISTS,
      // not that the caller owns it: an ungated attach both writes a cross-household FK and, via the
      // ?space_id gallery above, turns into a live cross-household READ. Generic 400, no existence oracle.
      if (spacePhotosEnabled && body.space_id != null) {
        if (!UUID_RE.test(String(body.space_id)) || !await loadOwnedSpace(sql, body.space_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'space_id', body.space_id);
          return resp(400, { error: 'space_id does not match a space you can use' });
        }
      }

      // ── AUTHZ: the OTHER FIVE parents ───────────────────────────────────────────────────────────────
      // space_id (above) is the only flag-gated parent on this verb. photos carries SIX body-settable parent
      // FKs (project_id, event_id, location_id, plant_id, inventory_item_id, space_id; enumerated from
      // pg_constraint) and the five below were stored exactly as sent. A foreign key proves the referenced
      // row EXISTS, never that the caller OWNS it, so an authenticated non-member could write a cross-household
      // FK — and that FK is READABLE:
      //   • every gallery branch LEFT JOINs the container UNSCOPED and returns `pp.display_name AS
      //     project_name`. So the attacker POSTs a photo carrying the victim's project_id, GETs /api/photos,
      //     and reads back the VICTIM'S CONTAINER NAME.
      //   • event_id is the widest column: most photos are event-attached and the planting gallery unions
      //     `photos.event_id -> event_log.plant_id`, so a foreign event_id reaches a planting relationship
      //     without ever naming the planting.
      //
      // What it is NOT: the row does NOT appear in the victim's gallery (every branch carries
      // `p.created_by = ANY(householdIds)`), and it does NOT become the victim's hero (each autoPromoteFeatured
      // arm is household-scoped on the parent). The defect is the cross-household FK write plus the read-back
      // leak, which is enough.
      //
      // Same loaders, same generic 400s, no existence oracle: identical to the space_id gate directly above.
      // Runs BEFORE buildPhotoInsert so a rejected write leaves no row and no evidence/auto-promote side
      // effects. Rejecting a new attachment to a soft-deleted container is intended.
      if (body.project_id != null) {
        if (!await loadOwnedProject(sql, body.project_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'project_id', body.project_id);
          return resp(400, { error: 'project_id does not match a project you can use' });
        }
      }
      if (body.plant_id != null) {
        if (!await loadOwnedPlantingRef(sql, body.plant_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'plant_id', body.plant_id);
          return resp(400, { error: 'plant_id does not match a planting you can use' });
        }
      }
      if (body.event_id != null) {
        if (!await loadOwnedEvent(sql, body.event_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'event_id', body.event_id);
          return resp(400, { error: 'event_id does not match an event you can use' });
        }
      }
      if (body.location_id != null) {
        if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'location_id', body.location_id);
          return resp(400, { error: 'location_id does not match a location you can use' });
        }
      }
      if (body.inventory_item_id != null) {
        if (!await loadOwnedInventoryItem(sql, body.inventory_item_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'inventory_item_id', body.inventory_item_id);
          return resp(400, { error: 'inventory_item_id does not match an inventory item you can use' });
        }
      }

      // neon serverless driver: tagged-template calls are auto-committed individually.
      // For atomicity, wrap in sql.transaction([...]) — multiple tagged templates
      // run in one BEGIN/COMMIT and roll back together on failure.
      // The capture-metadata columns are additive: every existing caller sends none of them, so they all
      // bind NULL and behavior is byte-identical to before.
      //
      // ON CONFLICT targets idx_photos_content_hash_uniq, the PARTIAL unique index (created_by, content_hash)
      // WHERE content_hash IS NOT NULL AND deleted_at IS NULL, so the predicate must be restated here for
      // Postgres to match that index. Re-uploading the same bytes is expected in bulk intake (re-picking a
      // photo, a retried batch); without the upsert that raises a 23505 which falls through isUpstream() to
      // an opaque 500.
      // DO UPDATE, never DO NOTHING: DO NOTHING returns ZERO rows, so insertedRows[0] is undefined
      // and the very next line TypeErrors into the same 500 it was meant to fix.
      // (xmax = 0) distinguishes a real insert from a conflict-update in the same round trip.
      //
      // NOT wrapped in sql.transaction with the auto-promote below, deliberately — see buildPhotoInsert.
      // neon's HTTP transaction is NON-INTERACTIVE: every statement must be built before any of them runs,
      // so the promote arms (which need the RETURNING id) could only join with a client-generated id, and on
      // the ON CONFLICT dedupe path that id is never inserted, so `SET featured_photo_id = <that id>`
      // FK-violates and rolls back the whole upsert, turning a 200-duplicate into a 500 on exactly the
      // grand-photo flow add-parent exists to serve. It would also invert the NON-FATAL promote contract above.
      const insertQuery = buildPhotoInsert(sql, body, userId, spacePhotosEnabled);

      const insertedRows = await insertQuery;
      const { was_inserted: wasInserted, ...inserted } = insertedRows[0];

      // A duplicate is NOT a new deposit. Return the existing row and stop here — BEFORE
      // auto-promote and BEFORE the evidence-capture block below, or a re-upload appends a second
      // first-party evidence row for the same photo and inflates DrG's confidence off one observation.
      if (wasInserted === false) {
        // buildPhotoInsert's COALESCE has already added every parent the existing row left empty, so
        // `inserted` is the post-merge truth and the response is no longer a 200 that lost the caller's target.
        // Anything left over is an ALREADY-OCCUPIED slot, which one column cannot hold twice: disclose it
        // rather than imply success. warn-to-CloudWatch mirrors warnRejectedFk. Additive response key.
        const unhonored = unhonoredParents(body, inserted, spacePhotosEnabled);
        if (unhonored.length) {
          console.warn(JSON.stringify({
            msg: 'photo-dedupe-parent-unhonored', userId, photoId: inserted.id, unhonored,
          }));
        }
        return resp(200, { ...inserted, duplicate: true, unhonored_parents: unhonored });
      }

      await autoPromoteFeatured(sql, inserted, householdIds, { spaceEnabled: spacePhotosEnabled, userId });

      // DRG auto-capture on photo log: a photo logged against a planting is first-party observational evidence.
      // Resolve the canonical entity_id (entity registry) and append ONE evidence row mirroring the
      // evidence-ingest contract. Canonical source = lambda/evidence-ingest/{index,validate}.js (per-dir
      // Lambda zips cannot import it, so the enum literals are duplicated here — keep in sync). Best-effort +
      // non-fatal (same posture as the auto-promote block above): the photo is already persisted; an
      // evidence-write failure must never 500 the upload. Household-scoped (entity's container.created_by)
      // + append-only (Soft-Delete-Only).
      if (inserted.plant_id) {
        try {
          const entRows = await sql`
            SELECT ent.id AS entity_id
              FROM public.entity ent
              JOIN public.garden_node p ON p.id = ent.planting_ref_id AND p.deleted_at IS NULL
              JOIN public.container pp  ON pp.id = p.container_id AND pp.deleted_at IS NULL
             WHERE ent.entity_type = 'planting'
               AND ent.planting_ref_id = ${inserted.plant_id}
               AND ent.deleted_at IS NULL
               AND pp.created_by = ANY(${householdIds})
             LIMIT 1
          `;
          if (entRows.length > 0) {
            // The evidence schema requires the generalized NOT-NULL columns (evidence_class, entity_type,
            // claim_scope, evidence_kind, claim, source_tier, trust_rank, strength_weight, captured_at,
            // provenance); omitting them makes this "non-fatal" capture fail silently on EVERY plant photo.
            // Mirror lambda/evidence-ingest/validate.js: first_party_log -> source_tier 'first_party_obs',
            // trust_rank 4, strength_weight 0.700.
            await sql`
              INSERT INTO public.evidence
                (entity_id, schema_version, tier, axis, polarity, finding_type, observed_at, note, photo_ref, source, created_by,
                 evidence_class, entity_type, garden_node_id, claim_scope, evidence_kind, claim,
                 source_tier, trust_rank, strength_weight, captured_at, provenance)
              VALUES
                (${entRows[0].entity_id}::uuid, 2, 'first_party_log', 'local', 'supporting',
                 NULL, NOW(), ${inserted.caption ?? null}, ${inserted.id}, 'photo_log', ${userId},
                 'observation', 'organism', ${inserted.plant_id}::uuid, 'planting', 'photo',
                 ${inserted.caption ?? 'Photo observation'}, 'first_party_obs', 4, 0.700, NOW(), 'user')
            `;
          }
        } catch (evErr) {
          console.error('evidence auto-capture non-fatal failure', evErr?.message ?? evErr);
        }
      }

      return resp(201, inserted);
    }

    // PUT|PATCH /api/photos/:id — re-tag an existing photo: update project / location / plant linkage +
    // caption. Household-scoped (`created_by = ANY(householdIds)`). Backs the Photo Library tag modal.
    // Full-replace semantics (not partial-merge): the tag modal submits the full
    // {project_id, location_id, plant_id, caption} set every save, so a missing field means "cleared",
    // not "unchanged".
    //
    // This route is ALSO the bulk-intake tag path (the quick-tag carousel). Two behaviors are conditional
    // on the row's PRIOR intake_status, captured via a CTE snapshot (the CTE sees the pre-UPDATE row;
    // RETURNING sees the post-UPDATE row):
    //
    //   1. DRAIN THE INBOX. Tagging clears intake_status, returning the row to the strict
    //      "must have a parent" invariant. Without this, idx_photos_intake_pending keeps matching
    //      and the carousel re-serves photos you already tagged — the inbox can never drain.
    //      CRITICAL: clear it ONLY when a parent is actually being set. This route has full-replace
    //      semantics, so a PUT with all-null parents means "cleared" — and blindly nulling
    //      intake_status on such a row makes it parentless AND non-pending, which the
    //      photos_must_have_parent CHECK rejects (a 500 on a legitimate un-tag). A pending_tag row
    //      that is un-tagged must STAY pending_tag.
    //   2. AUTO-PROMOTE, but only if the row WAS 'pending_tag' — see autoPromoteFeatured. A re-tag
    //      of an already-tagged photo remains a correction and still does not promote.
    //
    // V4-PHOTOUNTAG-001 adds the INVERSE of (1): `intake_status: 'pending_tag'` in the body puts an
    // ALREADY-TAGGED photo back in the inbox. Drain-only was a one-way door — a row tagged by mistake could have its parents
    // cleared but never its status restored, so it left the carousel forever. See resolveIntakeRequest /
    // buildRetagUpdate for the validated contract and the live CHECKs.
    const idMatch = rawPath.match(/^\/api\/photos\/([^/]+)$/);
    if (idMatch && (method === 'PUT' || method === 'PATCH')) {
      const photoId = idMatch[1];
      const body = JSON.parse(event.body ?? '{}');
      // First, and I/O-free: an invalid status is rejected before any loader runs, so a rejected request
      // costs nothing and mutates nothing.
      const intake = resolveIntakeRequest(body);
      if (intake.error) return resp(400, { error: intake.error });
      // Only the parents this route can actually set. event_id / inventory_item_id are untouched
      // here, so a legacy row parented by one of those keeps satisfying the CHECK on its own.
      // `||` not `??`: an empty-string id must read as "no parent", not as a present value.
      //
      // The space tier comes via a SEPARATE gated pre-read, NOT by naming space_id in the UPDATE below.
      // That template is NOT flag-gated: it executes flag-off, so a space_id reference in it would 42703 in
      // any environment lacking the column and would break the byte-identical-rollback invariant (the same
      // reasoning as buildPhotoInsert's two-template split and the dedicated attach route). The pre-read
      // costs one indexed PK lookup, flag-ON only, on a route that is already doing a write.
      //
      // Why it belongs in setsParent at all: this route has full-replace semantics, so a save from the tag
      // modal with every field cleared is an "un-tag". For a row whose surviving parent is the SPACE, that
      // still leaves a properly parented photo, so it must drain the inbox like any other parented row;
      // otherwise a space-attached photo re-tagged through the modal silently falls back into the quick-tag
      // carousel. space_id is read from the ROW, not the body: this route neither accepts nor SETs space_id,
      // so the persisted value is what the photos_must_have_parent CHECK will see after the UPDATE.
      // ── AUTHZ: the re-tag verb re-parents from the body too ──────────────────────────────────────
      // The photo itself is household-scoped (`created_by = ANY(householdIds)` in prev/UPDATE), but the three
      // parents it MOVES the photo to were not — so a member could re-tag their own photo INTO another
      // household's container/planting/location gallery, which is the POST gap reached by a second request.
      // Same loaders, same generic 400s; null still means "clear the parent" (full-replace semantics) and is
      // deliberately not gated. Runs before the UPDATE so a rejected re-tag mutates nothing.
      if (body.project_id != null) {
        if (!await loadOwnedProject(sql, body.project_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'project_id', body.project_id);
          return resp(400, { error: 'project_id does not match a project you can use' });
        }
      }
      if (body.plant_id != null) {
        if (!await loadOwnedPlantingRef(sql, body.plant_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'plant_id', body.plant_id);
          return resp(400, { error: 'plant_id does not match a planting you can use' });
        }
      }
      if (body.location_id != null) {
        if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
          warnRejectedFk(userId, 'photos', 'location_id', body.location_id);
          return resp(400, { error: 'location_id does not match a location you can use' });
        }
      }

      let spaceParented = false;
      if (spacePhotosEnabled) {
        const spaceRow = await sql`
          SELECT space_id FROM photos
           WHERE id = ${photoId}
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NULL
        `;
        spaceParented = Boolean(spaceRow[0]?.space_id);
      }
      const setsParent = Boolean(body.project_id || body.location_id || body.plant_id) || spaceParented;
      const updatedRows = await buildRetagUpdate(
        sql, photoId, body, householdIds, setsParent, intake.restoresInbox,
      );
      if (!updatedRows.length) return resp(404, { error: 'Photo not found' });
      const { prev_intake_status: prevIntakeStatus, ...updated } = updatedRows[0];
      // V4-PHOTOCAPTION-001 evidence caption sync: the upload-time auto-capture snapshots the caption into an evidence row
      // (note + claim, source='photo_log'). Caption is editable via this PUT, so the snapshot must follow
      // or DrG reads stale evidence forever. Household-scoped like the photo UPDATE above; best-effort
      // non-fatal like the capture itself; a 0-row match (photo never linked to a planting) is a clean no-op.
      try {
        await sql`
          UPDATE public.evidence
             SET note = ${body.caption ?? null},
                 claim = ${body.caption ?? 'Photo observation'}
           WHERE photo_ref = ${photoId}
             AND source = 'photo_log'
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NULL
        `;
      } catch (evErr) {
        console.error('evidence caption sync non-fatal failure', evErr?.message ?? evErr);
      }
      if (prevIntakeStatus === 'pending_tag') {
        await autoPromoteFeatured(sql, updated, householdIds, { userId });
      }
      return resp(200, updated);
    }

    // POST /api/photos/:id/restore. Declared BEFORE the bare-:id DELETE so the more specific path wins;
    // `[^/]+` in the id match would otherwise never see it, but relying on that is exactly the kind of
    // ordering assumption that breaks when someone loosens a regex.
    //
    // Durable recovery, not a 5-second window. The soft delete is recoverable forever, so a toast that
    // asserts "gone" after 5s would leave the user's belief WORSE than the system's state; the accepted
    // fix is a durable Unarchive-style affordance, not a longer toast. It also removes the WCAG 2.2.1
    // (Timing Adjustable) exposure a sole-recovery timer would carry.
    const restoreMatch = rawPath.match(/^\/api\/photos\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      const { status, body } = await restorePhoto(sql, {
        photoId: restoreMatch[1],
        householdIds,
        userId,
        spaceEnabled: spacePhotosEnabled,
      });
      return resp(status, body);
    }

    // DELETE /api/photos/:id. Before this route no user-facing photo delete existed anywhere, which is
    // the only reason the original incident was unrecoverable.
    //
    // SOFT DELETE ONLY. `deleted_at = now()`; the row survives, the S3 object survives, every
    // relation survives, and restore above brings it back. See photoDelete.js.
    //
    // HOUSEHOLD-SCOPED, and that is a DECISION, not an inheritance: `created_by = ANY(householdIds)`
    // means either household member can delete the other's photos. Finer-grained permission levels
    // (V5-PERMSHARD-001) are deliberately NOT built here.
    //
    // KNOWN AND INTENDED SIDE EFFECT: nulling a hero returns the parent to `featured_photo_id IS NULL`,
    // which is exactly autoPromoteFeatured's precondition — so the NEXT photo POSTed to that parent silently
    // becomes its hero. With the read-side effective-hero derivation, the parent never even APPEARS
    // hero-less in between: the fallback arm substitutes the newest surviving photo immediately, with
    // featured_is_explicit false. The delete feedback copy must account for a hero that visibly replaces
    // itself rather than disappearing.
    if (idMatch && method === 'DELETE') {
      const { status, body } = await softDeletePhoto(sql, {
        photoId: idMatch[1],
        householdIds,
        userId,
        spaceEnabled: spacePhotosEnabled,
      });
      return resp(status, body);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('photos lambda error', err);
    return isUpstream(err)
      ? resp(503, { error: 'Service temporarily unavailable' })
      : resp(500, { error: 'Internal server error' });
  }
};
