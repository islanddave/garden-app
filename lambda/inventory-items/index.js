import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope, loadOwnedLocation, loadOwnedPhoto, warnRejectedFk } from './household.js';
import { resolvePhotoViewUrl } from './photo-access.js';
import { validateExtractRequest, buildAnthropicRequest, parseExtractResponse } from './extract.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.S3_PHOTOS_BUCKET;

async function getFeaturedPhotoViewUrl(storagePath) {
  if (!storagePath || !BUCKET) return null;
  try {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: storagePath });
    return await getSignedUrl(s3, cmd, { expiresIn: 900 });
  } catch (err) {
    console.error('getFeaturedPhotoViewUrl failed', err?.message ?? err);
    return null;
  }
}

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config owns CORS — handler must not duplicate (matches lambda/plants pattern)

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

const VALID_TYPES = ['consumable', 'durable'];
const VALID_CATEGORIES = ['seeds','growing_media','lighting','shelving','tools','pest_control','containers','climate_control','nutrients_and_amendments','fertilizer','amendment','other'];
const VALID_UNITS = ['each','packet','oz','fl oz','lb','gal','qt','bag','roll','sheet','other'];
const VALID_CONDITIONS = ['excellent','good','fair','poor'];
const VALID_STATUSES = ['active','depleted','retired','missing'];

// BUG-INVMETADROP-001. Mirrors chk_inventory_metadata_size on inventory_items
// (metadata IS NULL OR octet_length(metadata::text) < 8192) and packetToInventoryPayload's
// METADATA_MAX_BYTES, so an oversized payload 400s with a field name instead of surfacing as
// the generic 23514 "Constraint violation" string the catch block emits.
export const METADATA_MAX_BYTES = 8192;

// A plain JSON object, not an array and not a scalar. jsonb would happily store `"abc"` or `[1]`,
// and every reader here (AddSeeds' provenance, packetToInventoryPayload) does key lookups — a
// scalar would be stored without error and then read as undefined at every call site.
export function validateMetadata(metadata) {
  if (metadata == null) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 'metadata must be a JSON object or null';
  }
  let serialized;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    return 'metadata must be JSON-serializable';
  }
  // Byte length, not string length: the CHECK counts octets, so a notes field full of accented
  // characters or emoji passes a .length test and still violates the constraint.
  if (Buffer.byteLength(serialized, 'utf8') >= METADATA_MAX_BYTES) {
    return `metadata must serialize to fewer than ${METADATA_MAX_BYTES} bytes`;
  }
  return null;
}

export function validateCreate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  if (!body.type || !VALID_TYPES.includes(body.type)) return 'type must be consumable or durable';
  if (!body.category || !VALID_CATEGORIES.includes(body.category)) return `category must be one of: ${VALID_CATEGORIES.join(', ')}`;
  if (body.type === 'consumable') {
    if (body.quantity_on_hand == null) return 'quantity_on_hand is required for consumable';
    if (!body.unit || !VALID_UNITS.includes(body.unit)) return `unit is required for consumable; must be one of: ${VALID_UNITS.join(', ')}`;
  }
  if (body.type === 'durable') {
    if (body.quantity == null) return 'quantity is required for durable';
  }
  if (body.condition != null && !VALID_CONDITIONS.includes(body.condition)) return `condition must be one of: ${VALID_CONDITIONS.join(', ')}`;
  if (body.status != null && !VALID_STATUSES.includes(body.status)) return `status must be one of: ${VALID_STATUSES.join(', ')}`;
  if (body.unit != null && !VALID_UNITS.includes(body.unit)) return `unit must be one of: ${VALID_UNITS.join(', ')}`;
  if (body.variety_id != null && body.category !== 'seeds') return 'variety_id is only allowed when category is seeds';
  if (body.category === 'seeds' && body.variety_id == null) return 'variety_id is required for seeds';
  const merr = validateMetadata(body.metadata);
  if (merr) return merr;
  return null;
}

export function validateUpdate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  // PUT is "replace editable fields" pattern — frontend sends complete payload.
  // Same field validation as create EXCEPT we accept body even without all required
  // fields (DB CHECK constraints catch any inconsistency). But if type/category/unit/etc.
  // are present, they must be valid.
  if (body.type != null && !VALID_TYPES.includes(body.type)) return 'type must be consumable or durable';
  if (body.category != null && !VALID_CATEGORIES.includes(body.category)) return `category must be one of: ${VALID_CATEGORIES.join(', ')}`;
  if (body.unit != null && !VALID_UNITS.includes(body.unit)) return `unit must be one of: ${VALID_UNITS.join(', ')}`;
  if (body.condition != null && !VALID_CONDITIONS.includes(body.condition)) return `condition must be one of: ${VALID_CONDITIONS.join(', ')}`;
  if (body.status != null && !VALID_STATUSES.includes(body.status)) return `status must be one of: ${VALID_STATUSES.join(', ')}`;
  if (body.variety_id != null && body.category != null && body.category !== 'seeds') return 'variety_id is only allowed when category is seeds';
  if (body.category === 'seeds' && body.variety_id == null) return 'variety_id is required for seeds';
  return null;
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const secrets = await getSecrets();

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: [
        'https://garden.futureishere.net',
        'https://dg6mmjhepoyt9.cloudfront.net',
      ],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }
  // V4-AUTHZRESIDUE-001 (mirrors lambda/plants + lambda/photos): householdScope('') returns [''] and
  // `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty/absent JWT subject would be a live
  // ownership value rather than a no-match. verifyToken rejects such a token first, so this is
  // defence-in-depth; the point is that the invariant is ENFORCED here rather than relied upon.
  if (!userId) return resp(401, { error: 'Unauthorized' });

  const sql = neon(secrets.NEON_DATABASE_URL);
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/inventory-items';

  try {
    // SEEDINV: literal sub-routes, checked BEFORE /api/inventory-items/:id so
    // 'sow-candidates' is not mis-parsed as an item id (mirrors the
    // lambda/varieties/index.js crop-types precedent).
    if (rawPath === '/api/inventory-items/sow-candidates') {
      if (method !== 'GET') return resp(405, { error: 'Method not allowed' });
      // Raw v_sow_candidates rows only — all date math happens client-side (sowEngine).
      const rows = await sql`
        SELECT * FROM v_sow_candidates
        WHERE created_by = ANY(${householdIds})
      `;
      return resp(200, { items: rows });
    }

    // SEEDINV: seed-packet extractor. Also checked BEFORE /api/inventory-items/:id so
    // 'extract-seeds' is not mis-parsed as an item id (crop-types precedent).
    if (rawPath === '/api/inventory-items/extract-seeds') {
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');
      const v = validateExtractRequest(body);
      if (!v.ok) return resp(v.status, { error: v.error });
      // ~4.5MB binary image => ~6M base64 chars; anything bigger risks the Lambda
      // payload/memory ceiling — reject before touching the upstream API.
      if (body.mode === 'image' && body.image_base64.length > 6_000_000) {
        return resp(413, { error: 'image_too_large' });
      }
      let apiKey = secrets.ANTHROPIC_API_KEY;
      if (!apiKey) {
        // Key may have been added to the secret bundle after this container warmed —
        // re-fetch ONCE bypassing the module cache before declaring not-configured.
        _secrets = null;
        const fresh = await getSecrets();
        apiKey = fresh.ANTHROPIC_API_KEY;
      }
      if (!apiKey) return resp(501, { error: 'extractor_not_configured' });

      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildAnthropicRequest(body)),
      });
      if (!upstream.ok) {
        console.error('extract-seeds upstream error', upstream.status);
        return resp(502, { error: 'extractor_upstream', status: upstream.status });
      }
      const data = await upstream.json();
      const modelText = (data.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const parsed = parseExtractResponse(modelText);
      if (!parsed.ok) return resp(422, { error: parsed.error });
      return resp(200, { packets: parsed.packets });
    }

    // V4-SOWARCHIVE-001: archive a seed packet out of the ACTIVE Sow Now buckets for a season.
    // Checked before idMatch, mirroring the lambda/plants /archive precedent — idMatch's
    // /([^/]+)$/ cannot match the /sow-archive suffix, but the ordering is kept explicit so a
    // future loosening of that regex can't silently swallow this route.
    const sowArchiveMatch = rawPath.match(/^\/api\/inventory-items\/([^/]+)\/sow-archive$/);
    if (sowArchiveMatch) {
      const itemId = sowArchiveMatch[1];
      if (method !== 'PATCH') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');
      const archived = body.archived !== false; // default true; {archived:false} un-archives

      // The SEASON comes from the client, because sowEngine derives its year from a LOCAL calendar
      // date (sowEngine.js, getUTCFullYear of localTodayISO). Stamping EXTRACT(YEAR FROM now())
      // here would write the NEXT year for an archive made late on 31 Dec Eastern, hiding the
      // packet for all of it. Falling back to the server year only when the client sends none.
      let season = null;
      if (archived) {
        season = Number.isInteger(body.season) ? body.season : new Date().getUTCFullYear();
        // Range-check rather than trust: this is the user's own data, but an out-of-range stamp
        // would archive a packet into a season that never arrives, i.e. hide it forever.
        if (season < 2000 || season > 2100) return resp(400, { error: 'invalid_season' });
      }

      // Household-scoped like every other read of this table. category='seeds' is asserted so this
      // route cannot stamp a non-seed inventory row with a Sow-Now-only field. deleted_at filter
      // retained: a deleted packet can't be (un)archived.
      // Both columns move together — chk_sow_archive_pair rejects a half-write at the DB.
      const rows = await sql`
        UPDATE public.inventory_items
           SET sow_archived_season = ${season},
               sow_archived_at = CASE WHEN ${archived} THEN NOW() ELSE NULL END,
               updated_at = NOW()
         WHERE id = ${itemId}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NULL
           AND category = 'seeds'
        RETURNING id, sow_archived_season, sow_archived_at
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(200, rows[0]);
    }

    // ── V4-SEEDSAVEFLOW-001 — seed-lot stage history ────────────────────────────────────────────
    // GET  returns the lot's stage entries, newest first.
    // POST advances the lot to a stage AND records the entry, in ONE statement.
    const seedStageMatch = rawPath.match(/^\/api\/inventory-items\/([^/]+)\/seed-stage$/);
    if (seedStageMatch) {
      const itemId = seedStageMatch[1];
      const STAGES = ['fermenting', 'drying', 'stored'];

      if (method === 'GET') {
        // Household-scoped through the PARENT rather than on the log row: seed_lot_stage_log carries
        // created_by but joining the parent is what stops one household reading another's history
        // via a guessed id, and it is the same predicate the write path enforces.
        const rows = await sql`
          SELECT l.id, l.stage, l.entered_at, l.note, l.created_by, l.created_at
            FROM public.seed_lot_stage_log l
            JOIN public.inventory_items i ON i.id = l.inventory_item_id
           WHERE l.inventory_item_id = ${itemId}
             AND i.created_by = ANY(${householdIds})
             AND i.deleted_at IS NULL
           ORDER BY l.entered_at DESC, l.created_at DESC
        `;
        return resp(200, rows);
      }

      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });

      const body = JSON.parse(event.body ?? '{}');
      if (!STAGES.includes(body.stage)) {
        return resp(400, { error: `stage must be one of ${STAGES.join(', ')}` });
      }
      // BACKDATABLE ON PURPOSE. The founding use case is retroactive — the 1884 tomato lot went
      // through its ferment and out to dry before any of this existed, and a stage history that can
      // only be written in the present tense cannot record what actually happened. Absent -> now().
      const enteredAt = body.entered_at ?? null;
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

      // ONE STATEMENT, so the two writes cannot separate. A stage log entry without the matching
      // seed_stage on the lot would show history the list view contradicts; the reverse would move
      // the lot with no record of when or why. A CTE gives atomicity without reaching for the
      // driver's transaction API, and it inherits the guard for free: if the UPDATE matches nothing
      // — wrong household, deleted row, or a non-seed item — `upd` is empty, the INSERT selects from
      // it and writes nothing, and the route 404s having changed exactly zero rows.
      const rows = await sql`
        WITH upd AS (
          UPDATE public.inventory_items
             SET seed_stage = ${body.stage},
                 updated_at = NOW()
           WHERE id = ${itemId}
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NULL
             AND category = 'seeds'
          RETURNING id
        )
        INSERT INTO public.seed_lot_stage_log (inventory_item_id, stage, entered_at, note, created_by)
        SELECT upd.id, ${body.stage}, COALESCE(${enteredAt}::timestamptz, NOW()), ${note}, ${userId}
          FROM upd
        RETURNING id, inventory_item_id, stage, entered_at, note
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(201, rows[0]);
    }

    const idMatch = rawPath.match(/^\/api\/inventory-items\/([^/]+)$/);

    if (idMatch) {
      const itemId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          SELECT i.*,
                 COALESCE(fp.id, fb.id) AS effective_featured_photo_id,
                 (fp.id IS NOT NULL) AS featured_is_explicit,
                 COALESCE(fp.storage_path, fb.storage_path) AS featured_photo_storage_path,
                 pv.display_name AS variety_name
          FROM inventory_items i
          -- BUG-PHOTOHEROMOVE-001 / INV-HERO — the hero is DERIVED here, never trusted from the
          -- stored pointer. Same shape as fetchSpaceHero (lambda/photos/index.js:~314); read its
          -- long-form rationale before touching this. Two predicates: the photo must be ALIVE, and
          -- it must STILL be a member of this item's gallery.
          --
          -- The membership arm is the one that bites today. Reassign ships (PhotoLibrary's tag
          -- modal, full-replace PUT) and re-parents a photo without clearing the old parent's
          -- featured_photo_id. NOTHING IS DELETED, so no deleted_at filter can ever catch it —
          -- only re-checking membership can.
          --
          -- The predicate fp.inventory_item_id = i.id is exactly the linkage the set-featured WRITE validator
          -- already enforces (~:275 below). Read half and write half of ONE invariant: diverging
          -- them manufactures the silent-revert bug fetchSpaceHero documents (the user re-picks the
          -- photo, the write accepts, the read demotes it again). Change one, change both.
          --
          -- ALIASED to effective_featured_photo_id, NOT featured_photo_id, because the i.* wildcard above
          -- already emits the raw column: two same-named columns in one SELECT and the driver's
          -- last-one-wins is undefined behavior to depend on. The JS below does the override
          -- explicitly. featured_image_id is untouched here — it is the deprecated V1-era twin
          -- (0 rows populated) and is not a hero surface.
          LEFT JOIN photos fp
                 ON fp.id = i.featured_photo_id
                AND fp.deleted_at IS NULL
                AND fp.created_by = ANY(${householdIds})
                AND fp.inventory_item_id = i.id
          LEFT JOIN LATERAL (
                 SELECT ph.id, ph.storage_path
                   FROM photos ph
                  WHERE ph.inventory_item_id = i.id
                    AND ph.deleted_at IS NULL
                    AND ph.created_by = ANY(${householdIds})
                  ORDER BY ph.created_at DESC, ph.id DESC
                  LIMIT 1
               ) fb ON TRUE
          LEFT JOIN public.cultivar pv ON pv.id = i.variety_id
          WHERE i.id = ${itemId}
            AND i.created_by = ANY(${householdIds})
            AND i.deleted_at IS NULL
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        const row = rows[0];
        const featured_photo_view_url = await resolvePhotoViewUrl(row.featured_photo_storage_path, { presign: getFeaturedPhotoViewUrl, sm });
        // INV-HERO: `i.*` carried the RAW pointer; replace it with the derived effective hero so
        // the id and the url can never disagree (the incoherence DD3 names — a LEFT JOIN that nulls
        // the storage_path while the raw id stays non-null, which the client then feeds to PhotoImg
        // and to featuredInSet badge comparisons). Strip the join-only columns.
        const {
          featured_photo_storage_path: _ignore,
          effective_featured_photo_id: _effective,
          ...rest
        } = row;
        // ── V4-SEEDGERMRATE-001 (BD-057) — the packet's germination record ─────────────────────
        // Dave's Q2 answer was "combine them, keep the history", and this is the whole of what
        // that costs: each sowing from this packet is already its own planting row carrying
        // source_inventory_item_id, so the combined rate is a SUM over them and the history IS
        // those rows. No new table, no per-packet counters to keep in step with the plantings.
        //
        // Served from the PACKET's own endpoint rather than by filtering /api/plants, for two
        // reasons: the plants list has no source_inventory_item_id filter (adding one would widen
        // a payload V4-PICKERPAYLOAD-001 just spent a release narrowing), and the packet page
        // already fetches this item — so the summary arrives with it instead of costing a second
        // cold round trip on a page Dave opens to answer one question.
        //
        // Only rows that HAVE a sown count take part. A planting from this packet that Dave never
        // counted must not drag the rate toward zero — `seeds_sown IS NOT NULL` is the difference
        // between "70% of what I measured" and "70% if you assume the unmeasured ones all failed".
        // germinated COALESCEs to 0 only INSIDE a row that has a sown count, where a null means he
        // recorded the sowing and nothing came up yet.
        let germination = null;
        if (row.category === 'seeds') {
          const g = await sql`
            SELECT p.id, p.display_name AS name, p.sown_at, p.seeds_sown, p.seeds_germinated
              FROM public.garden_node p
             WHERE p.source_inventory_item_id = ${itemId}
               AND p.deleted_at IS NULL
               AND p.seeds_sown IS NOT NULL
             ORDER BY p.sown_at DESC NULLS LAST, p.id
          `;
          const sown = g.reduce((n, r) => n + Number(r.seeds_sown ?? 0), 0);
          const up = g.reduce((n, r) => n + Number(r.seeds_germinated ?? 0), 0);
          germination = {
            sowings: g,
            seeds_sown: sown,
            seeds_germinated: up,
            // null rather than 0 when nothing is measured yet: a packet with no counts has no rate,
            // and 0 would render as a total failure on every unused packet in the drawer.
            rate: sown > 0 ? Math.round((up / sown) * 1000) / 10 : null,
          };
        }
        return resp(200, { ...rest, featured_photo_id: row.effective_featured_photo_id, featured_photo_view_url, germination });
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        const verr = validateUpdate(body);
        if (verr) return resp(400, { error: verr });

        // V2-PHOTO-F1: strict validation for featured_photo_id (linkage = photos.inventory_item_id).
        const hasFeatured = Object.prototype.hasOwnProperty.call(body, 'featured_photo_id');
        // V4-SEEDSAVEFLOW-001 — presence, not truthiness. `seed_stage: null` is a MEANINGFUL value
        // (a lot deliberately cleared back to "no stage"), so the test has to be "did the client
        // mention this key" rather than "did it send something". hasOwnProperty answers that; a
        // `body.seed_stage != null` check would make clearing a stage impossible.
        const hasSeedProcess = Object.prototype.hasOwnProperty.call(body, 'seed_process');
        const hasSeedStage   = Object.prototype.hasOwnProperty.call(body, 'seed_stage');
        // Vocabulary is enforced by a DB CHECK, but a 400 here is a better answer than a 500 from a
        // constraint violation — and it names the legal values, which the constraint error does not.
        const SEED_PROCESSES = ['wet', 'dry'];
        const SEED_STAGES    = ['fermenting', 'drying', 'stored'];
        if (hasSeedProcess && body.seed_process != null && !SEED_PROCESSES.includes(body.seed_process)) {
          return resp(400, { error: `seed_process must be one of ${SEED_PROCESSES.join(', ')}` });
        }
        if (hasSeedStage && body.seed_stage != null && !SEED_STAGES.includes(body.seed_stage)) {
          return resp(400, { error: `seed_stage must be one of ${SEED_STAGES.join(', ')}` });
        }
        if (hasFeatured && body.featured_photo_id != null) {
          const linkRows = await sql`
            SELECT 1 FROM photos
             WHERE id = ${body.featured_photo_id}
               AND inventory_item_id = ${itemId}
               AND created_by = ANY(${householdIds})
               AND deleted_at IS NULL
          `;
          if (!linkRows.length) {
            return resp(400, { error: 'featured_photo_id must be a photo linked to this inventory item' });
          }
        }

        // AUTHZ (BUG-AUTHZFKENUM-001): featured_image_id -> photos(id) is the UNGATED TWIN of
        // featured_photo_id three lines above. Both are body-settable photo references on the same
        // row; only one was checked. featured_image_id has no per-item linkage requirement (it is
        // not constrained to photos.inventory_item_id = this item), so ownership is the whole of the
        // check — hence the shared loadOwnedPhoto rather than a second inline linkage query.
        // Measured on live prod: zero rows would lose a write.
        if (body.featured_image_id != null) {
          if (!await loadOwnedPhoto(sql, body.featured_image_id, householdIds)) {
            warnRejectedFk(userId, 'inventory_items', 'featured_image_id', body.featured_image_id);
            return resp(400, { error: 'featured_image_id does not match a photo you can use' });
          }
        }

        // AUTHZ (V4-AUTHZSWEEP-001): location_id is a cross-entity FK set straight from the body.
        // The DB FK proves existence, not ownership — gate it before the write. Generic 400, no
        // existence oracle. NOTE the PUT below assigns location_id unconditionally (not COALESCE),
        // so a null clears it; only a non-null value needs validating.
        if (body.location_id != null) {
          if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
            warnRejectedFk(userId, 'inventory_items', 'location_id', body.location_id);
            return resp(400, { error: 'location_id does not match a location you can use' });
          }
        }

        const isConsumable = body.type === 'consumable';
        const isDurable = body.type === 'durable';
        const tags = Array.isArray(body.tags) ? body.tags : [];

        // PUT replaces all editable fields. Frontend sends complete payload.
        // type-discrimination enforced by nullifying off-type fields server-side.
        //
        // `metadata` IS DELIBERATELY ABSENT FROM THIS SET LIST — do not "finish the job" by adding
        // it the way BUG-INVMETADROP-001 added it to the INSERT. The two verbs are not symmetric.
        // Every assignment below is unconditional (`= ${body.x ?? null}`, no COALESCE), so a field
        // the client omits is NULLED, not preserved. Adding `metadata = ${body.metadata ?? null}`
        // would therefore erase provenance on every edit made through a form that does not round-
        // trip it — and the richest metadata in the table belongs to the bulk-loaded seed rows,
        // which no UI renders and so no UI would send back. Omission is what protects them.
        // If metadata ever needs to be editable here, it needs the explicit-presence guard used by
        // featured_photo_id above (hasOwnProperty -> CASE WHEN ... ELSE metadata END), never a bare
        // assignment.
        // HOUSEHOLD-MODE TODO: concurrent quantity edits have a lost-update window — PUT writes an
        // absolute quantity (client read-modify-write; no optimistic updated_at/expected guard).
        // Backend-safe today; revisit as a fast-follow if both members adjust counts concurrently.
        const rows = await sql`
          UPDATE inventory_items SET
            name              = ${body.name ?? null},
            type              = ${body.type ?? null},
            category          = ${body.category ?? null},
            variety_id        = ${body.variety_id ?? null},
            location_id       = ${body.location_id ?? null},
            location_text     = ${body.location_text ?? null},
            source            = ${body.source ?? null},
            source_url        = ${body.source_url ?? null},
            purchase_date     = ${body.purchase_date ?? null},
            unit_cost         = ${body.unit_cost ?? null},
            unit              = ${isConsumable ? (body.unit ?? null) : null},
            quantity_purchased= ${body.quantity_purchased ?? null},
            notes             = ${body.notes ?? null},
            tags              = ${tags},
            status            = ${body.status ?? 'active'},
            quantity_on_hand  = ${isConsumable ? (body.quantity_on_hand ?? null) : null},
            reorder_threshold = ${isConsumable ? (body.reorder_threshold ?? null) : null},
            reorder_quantity  = ${isConsumable ? (body.reorder_quantity ?? null) : null},
            quantity          = ${isDurable ? (body.quantity ?? null) : null},
            condition         = ${isDurable ? (body.condition ?? null) : null},
            brand             = ${body.brand ?? null},
            model             = ${body.model ?? null},
            image_url         = ${body.image_url ?? null},
            featured_image_id = ${body.featured_image_id ?? null},
            featured_photo_id = CASE
              WHEN ${hasFeatured} THEN ${body.featured_photo_id ?? null}
              ELSE featured_photo_id
            END,
            -- V4-SEEDSAVEFLOW-001. EXPLICIT-PRESENCE GUARDS, NOT BARE ASSIGNMENTS, and this is the
            -- difference between working and destroying data. Every other column above is a bare
            -- assignment, which is safe only because the edit form renders and returns all of them
            -- (see the note at the top of this block). It does NOT render these two:
            -- InventoryDetail's buildChanges() sends name/category/status/notes/source/source_url/
            -- purchase_date/unit_cost/location_text/quantity_purchased plus the consumable-or-durable
            -- set, and nothing seed-related. A bare assignment here would therefore NULL the seed
            -- stage every time Dave edited an inventory item for any unrelated reason — silently,
            -- with a 200, losing the process history the whole feature exists to hold.
            seed_process = CASE
              WHEN ${hasSeedProcess} THEN ${body.seed_process ?? null}
              ELSE seed_process
            END,
            seed_stage = CASE
              WHEN ${hasSeedStage} THEN ${body.seed_stage ?? null}
              ELSE seed_stage
            END
          WHERE id = ${itemId}
            AND created_by = ANY(${householdIds})
            AND deleted_at IS NULL
          RETURNING *
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        const rows = await sql`
          UPDATE inventory_items
          SET deleted_at = NOW()
          WHERE id = ${itemId}
            AND created_by = ANY(${householdIds})
            AND deleted_at IS NULL
          RETURNING id
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      // V4-TREATLOG-001: optional ?category=a,b,c filter (comma-list). Absent → all items.
      const catParam = event.queryStringParameters?.category;
      const cats = catParam ? catParam.split(',').map(c => c.trim()).filter(Boolean) : null;
      const rows = cats && cats.length
        ? await sql`
            SELECT i.*, pv.display_name AS variety_name
            FROM inventory_items i
            LEFT JOIN public.cultivar pv ON pv.id = i.variety_id
            WHERE i.created_by = ANY(${householdIds})
              AND i.deleted_at IS NULL
              AND i.category = ANY(${cats})
            ORDER BY i.created_at DESC
          `
        : await sql`
            SELECT i.*, pv.display_name AS variety_name
            FROM inventory_items i
            LEFT JOIN public.cultivar pv ON pv.id = i.variety_id
            WHERE i.created_by = ANY(${householdIds})
              AND i.deleted_at IS NULL
            ORDER BY i.created_at DESC
          `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const verr = validateCreate(body);
      if (verr) return resp(400, { error: verr });

      // AUTHZ (BUG-AUTHZFKENUM-001): create half of the featured_image_id gate — see the PUT arm.
      if (body.featured_image_id != null) {
        if (!await loadOwnedPhoto(sql, body.featured_image_id, householdIds)) {
          warnRejectedFk(userId, 'inventory_items', 'featured_image_id', body.featured_image_id);
          return resp(400, { error: 'featured_image_id does not match a photo you can use' });
        }
      }

      // AUTHZ (V4-AUTHZSWEEP-001): same gate as the PUT path — the create path must not be the
      // hole the edit path closes.
      if (body.location_id != null) {
        if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
          warnRejectedFk(userId, 'inventory_items', 'location_id', body.location_id);
          return resp(400, { error: 'location_id does not match a location you can use' });
        }
      }

      const isConsumable = body.type === 'consumable';
      const isDurable = body.type === 'durable';
      const tags = Array.isArray(body.tags) ? body.tags : [];

      // INSERT writes BOTH user_id and created_by with the Clerk JWT.sub.
      // Both are NOT NULL TEXT in the deployed schema (twin-column reality —
      // legacy from the original DB migration, not yet collapsed). prevent_ownership_transfer
      // trigger enforces created_by immutability post-INSERT.
      //
      // BUG-INVMETADROP-001: `metadata` was absent from this column list while every caller was
      // already sending it — AddSeeds' buildRowPayload composes {sku, vendor, origin} for every
      // seed row and packetToInventoryPayload builds the same shape for the loader. Postgres does
      // not complain about a key the INSERT never mentions, so the write returned 201 and the
      // provenance vanished. It looked like it worked, which is why it survived: the existing seed
      // rows that DO carry metadata were bulk-loaded outside this route.
      // Stringify + explicit ::jsonb cast is the house pattern (lambda/events/index.js:485) — an
      // uncast bound object cannot be typed by the driver, and a bare null needs the cast too.
      const metadataJson = body.metadata != null ? JSON.stringify(body.metadata) : null;
      // V4-SEEDSAVEFLOW-001 — seed_process / seed_stage are NAMED in the INSERT below rather than
      // left to default, for exactly the reason the metadata note above records: Postgres does not
      // complain about a key the INSERT never mentions, so an omitted column returns 201 and
      // silently drops what the client sent. Both are nullable, so a non-seed item writes NULL.
      //
      // THIS COMMENT LIVES OUT HERE, NOT INSIDE THE COLUMN LIST, AND THAT IS NOT STYLE. The L-081
      // auditor's Phase 2 parses the parenthesised column list literally and does NOT strip `--`
      // comments inside it, so every English word of a comment placed there is read as a column
      // name and reported missing from prod. Writing it inside produced 53 bogus misses ("the",
      // "Postgres", "rather") on one run of scripts/dev-main-schema-audit.py.
      const rows = await sql`
        INSERT INTO inventory_items (
          user_id, created_by, type, name, category,
          location_id, location_text, source, source_url, purchase_date,
          unit_cost, unit, quantity_purchased, notes, tags, status,
          quantity_on_hand, reorder_threshold, reorder_quantity,
          quantity, condition, brand, model,
          image_url, featured_image_id, variety_id, metadata,
          seed_process, seed_stage
        ) VALUES (
          ${userId}, ${userId}, ${body.type}, ${body.name.trim()}, ${body.category},
          ${body.location_id ?? null}, ${body.location_text ?? null}, ${body.source ?? null}, ${body.source_url ?? null}, ${body.purchase_date ?? null},
          ${body.unit_cost ?? null},
          ${isConsumable ? body.unit : null},
          ${body.quantity_purchased ?? null}, ${body.notes ?? null}, ${tags}, ${body.status ?? 'active'},
          ${isConsumable ? body.quantity_on_hand : null},
          ${isConsumable ? (body.reorder_threshold ?? null) : null},
          ${isConsumable ? (body.reorder_quantity ?? null) : null},
          ${isDurable ? body.quantity : null},
          ${isDurable ? (body.condition ?? null) : null},
          ${body.brand ?? null}, ${body.model ?? null},
          ${body.image_url ?? null}, ${body.featured_image_id ?? null}, ${body.variety_id ?? null},
          ${metadataJson}::jsonb,
          ${body.seed_process ?? null}, ${body.seed_stage ?? null}
        ) RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('inventory-items lambda error', err);
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
