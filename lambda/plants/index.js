// /api/plants — VARIETY-REF Session 2 dual-read update
// Adds variety_id + source_inventory_item_id + metadata write paths.
// Adds nested variety_ref object via LEFT JOIN to plant_varieties (deleted_at-aware).
// Legacy flat fields (genus, species, variety as text) RETAINED for backward compat
// during Session 2/3 cutover window. Lambda 2.0.5 (Session 3 cleanup) will remove them.

import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope, loadOwnedLocation, loadOwnedInventoryItem, warnRejectedFk } from './household.js';
import { mergeCore } from './merge.js';
// BUG-PARENTOWN-001: body-supplied PARENT-id loaders. loadOwnedPlantingRef REPLACES household.js's
// loadOwnedPlanting on this path — same query plus the load-bearing `project_id IS NULL` conjunct on
// the own-created_by arm, matching this file's canonical by-id predicate and tags/index.js
// entityExists. See lambda/authz-parents.js for why they live in a separate file.
import { loadOwnedProject, loadOwnedPlantingRef } from './authz-parents.js';
import { resolvePhotoViewUrl } from './photo-access.js';
import { jsonResponder } from './http-response.js';
import { isStatusChange, formatStatusChangeNote, buildStatusChangeMetadata, STATUS_CHANGE_EVENT_TYPE } from './statusEvents.js';
import { validateClear, approxOrNull, validateAcquiredMature, validateQtyLost } from './validate.js';
import { reconcileNextWaterAt } from './waterVerdict.js';
import { deriveAnchorOnCreate } from './anchorCreate.js';
import { setOverwinterCore } from './overwinterAttr.js';


// V4-EVENTSOURCE-001 — event_log.source value written by THIS Lambda. lambda/events/index.js
// declares 'app'/'app_batch' and explicitly delegates 'app_status' here; the full value set and
// why 'direct' is reserved-but-never-inferred live in
// migrations/v4-eventsource-001/0a-additive-ddl.sql. The column carries a NOT VALID CHECK, so an
// unlisted value 23514s on write. 0a is applied to prod AND staging, so including the column in
// the INSERT below cannot 42703.
const EVENT_SOURCE_STATUS = 'app_status';

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

// V4-PERFTHEMEA-001 — BUG-PHOTOBLANK-001 thumb parity for the plants surfaces.
//
// /api/photos has derived a `thumbs/<storage_path>` companion since 4f15890 ("serve thumbnails to
// the grid"); /api/plants never did, so the Garden grid rendered full-resolution ORIGINALS into
// ~180 CSS-px 4:3 boxes. Measured on the 230 live featured heroes (S3 + Neon, 2026-08-16):
// originals avg 2.97 MB vs thumbs avg 163 KB — 18.7x — so one windowSize=24 group was ~71 MB.
//
// ADDITIVE, never a substitution. featured_photo_view_url keeps pointing at the original: the
// planting-detail hero and the lightbox need the full source, PhotoView degrades a missing thumb
// onto it with zero network, and src/lib/dataCache.js's _sameExceptUrls list carries BOTH names so
// a revalidate's presign churn still reads as "no data change".
//
// The thumb key is SERVER-DERIVED from the already-validated storage_path (same closed grammar the
// photos Lambda uses — never caller-supplied), and presigning is pure signature math that never
// touches S3. So this adds ZERO round-trips to a 243-row list, and the flip side is that a returned
// thumb URL is a HINT, not proof the object exists: 6 of the 230 live heroes have no thumb, and
// those degrade client-side through photoModel's source chain onto featured_photo_view_url. A
// per-row HEAD to make the hint authoritative would cost 225 S3 calls per request — a far worse
// regression than the bug.
async function featuredPhotoUrls(storagePath) {
  if (!storagePath) return { featured_photo_view_url: null, featured_photo_thumb_url: null };
  const [featured_photo_view_url, featured_photo_thumb_url] = await Promise.all([
    resolvePhotoViewUrl(storagePath, { presign: getFeaturedPhotoViewUrl, sm }),
    // Non-fatal by construction: a thumb that cannot be signed comes back null and the client
    // renders the original, exactly as it does for a thumb that signs but 404s.
    resolvePhotoViewUrl(`thumbs/${storagePath}`, { presign: getFeaturedPhotoViewUrl, sm })
      .catch(() => null),
  ]);
  return { featured_photo_view_url, featured_photo_thumb_url };
}

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

export const handler = async (event) => {
  // V4-APIGZIP-001 — resp is now bound PER INVOCATION because the response encoding is negotiated
  // from this request's Accept-Encoding. This list is the largest body the app fetches: 591,905 B of
  // real prod rows, 113,259 B gzipped (5.23x). Every call site below is unchanged — jsonResponder
  // returns the same resp(statusCode, body) it always had, and sub-1 KB bodies (i.e. every error
  // path here) still take the byte-identical identity branch. See lambda/http-response.js.
  const resp = jsonResponder(event, CORS);

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
  // Adversarial-review hardening: householdScope('') returns [''] and `'' = ANY(ARRAY[''])` is TRUE
  // in Postgres, so an empty/absent JWT subject would be a live ownership value rather than a
  // no-match. Clerk never issues one; this makes that assumption enforced instead of relied upon.
  if (!userId) return resp(401, { error: 'Unauthorized' });

  const sql = neon(secrets.NEON_DATABASE_URL);
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/plants';

  // `/api/plants/deleted` is a single trailing segment, so this matcher would otherwise capture it
  // as a planting id and 404 from the by-id GET. Excluded here; the route is handled inside the try
  // below, mirroring lambda/locations and lambda/photos.
  const idMatch = rawPath !== '/api/plants/deleted' && rawPath.match(/^\/api\/plants\/([^/]+)$/);
  // V3-SEEN-001 (Lane A Foundation): seen-contract write path. New-endpoint-only,
  // additive — does NOT touch any existing GET/PUT/POST/DELETE handler. idMatch's
  // /^\/api\/plants\/([^/]+)$/ does NOT match the /seen suffix, so no route collision.
  // seen_event + plants.last_seen_at + the AFTER-INSERT trigger are LIVE on prod
  // (shipped via Foundation V100, promote f5130254; ground-truthed on prod Neon
  // 2026-06-07). New-endpoint-only, so existing routes stay byte-identical.
  const seenMatch = rawPath.match(/^\/api\/plants\/([^/]+)\/seen$/);
  // V3-ARCHIVE-001: soft-archive toggle (distinct from deleted_at). Checked before idMatch
  // (idMatch's /([^/]+)$/ won't match the /archive suffix). PATCH-only, symmetric set/unset.
  const archiveMatch = rawPath.match(/^\/api\/plants\/([^/]+)\/archive$/);
  const restoreMatch = rawPath.match(/^\/api\/plants\/([^/]+)\/restore$/);
  // V4-PLANTMERGE-001: fold N sibling plantings into one surviving row. New-endpoint-only and
  // additive — idMatch's /([^/]+)$/ does not match the /merge suffix, so no existing route changes
  // shape. POST-only; the destructive half (soft-deleting the losers) is gated behind an explicit
  // loser_ids list, and `dry_run: true` returns the full plan without writing anything.
  const mergeMatch = rawPath.match(/^\/api\/plants\/([^/]+)\/merge$/);
  // V4-OVERWINTERCARE-001: the writer for the overwintering care attribute. New-endpoint-only and
  // additive — idMatch's /([^/]+)$/ does not match the /overwinter suffix, so no existing route
  // changes shape. PATCH-only, symmetric set/clear like /archive. The row it writes lives in
  // care_profile, NOT on the planting; see overwinterAttr.js for why it is not a PUT column.
  const overwinterMatch = rawPath.match(/^\/api\/plants\/([^/]+)\/overwinter$/);

  try {
    // ── V4-RESTORESURFACE-001 — the recovery path for plantings (audit I9) ───────────────────────
    //
    // 33 plantings are soft-deleted in prod with no affordance to bring any of them back. The
    // governing principle is lambda/photos': "A destructive control must not ship ahead of the
    // recovery path it advertises" — the DELETE arm below shipped long ago, so this closes a gap.
    //
    // THE CONTAINER PRECONDITION, and why this route is not a copy of the locations one. Every
    // container-reaching query in this Lambda requires the container to be LIVE — the F4
    // container-deleted gate, asserted by softdel-container.test.js so that "invisible" and
    // "immutable" stay the same set. This surface OBEYS that rather than carving an exception:
    // MEASURED on live prod 2026-08-13, 11 of the 33 soft-deleted plantings sit under a container
    // that is also deleted, and those 11 stay out of this list exactly as they stay out of every
    // other read.
    //
    // The recovery path for them is therefore TWO STEPS, and that is a feature rather than a gap:
    // restore the container, and its plantings reappear here to be restored individually. A first
    // draft of this route surfaced them with a `restore_blocked_by_container` flag and answered
    // restore with a typed 409; it was withdrawn because it made this the ONE read in the file that
    // could see through a deleted container, which is the invariant F4 exists to hold.
    if (rawPath === '/api/plants/deleted' && method === 'GET') {
      const rawLimit = Number(event?.queryStringParameters?.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
      // Ownership WITHOUT the liveness requirement: a soft-deleted planting's container may itself
      // be deleted, and the row is still the household's to see. Liveness is a RESTORE precondition,
      // not an ownership test — conflating the two is what would hide the 11.
      // Carries the full proj-rescope column set like every other GET SELECT in this file
      // (select-columns.test.js): a plant row returned to a client is a plant row, and the S1.A
      // hotfix that guard encodes was caused by exactly this kind of trimmed-down read.
      const rows = await sql`
        SELECT p.id, p.display_name AS name, p.container_id AS project_id, p.status,
               p.deleted_at, p.created_at, pp.display_name AS project_name,
               p.sown_at, p.sown_at_approx, p.germinated_at, p.germinated_at_approx,
               p.transplanted_at, p.transplanted_at_approx, p.planted_out_at, p.planted_out_at_approx,
               p.qty_initial, p.qty_current, p.qty_harvested, p.qty_lost, p.loss_cause,
               p.seeds_sown, p.seeds_germinated,
               p.source_type, p.source_ref, p.source_generation,
               p.parent_plant_id, p.divergence_type, p.lineage_note,
               p.succession_group_id, p.succession_order,
               p.container_type, p.container_size, p.location_id,
               p.acquired_mature, p.acquired_mature_source, p.acquired_mature_set_at,
               p.cultivar_id AS variety_id
          FROM public.garden_node p
          LEFT JOIN public.container pp ON pp.id = p.container_id
         WHERE p.deleted_at IS NOT NULL
           AND ( (pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL)
                 OR (p.container_id IS NULL AND p.created_by = ANY(${householdIds})) )
         ORDER BY p.deleted_at DESC, p.id DESC
         LIMIT ${limit}
      `;
      return resp(200, { plants: rows });
    }

    if (restoreMatch && method === 'POST') {
      const plantId = restoreMatch[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(plantId))) {
        return resp(404, { error: 'Not found' });
      }
      // Same F4 gate as every other container-reaching read here: a planting under a deleted
      // container is not visible to this route either, so it 404s rather than being answered
      // specially. Restore the container first and it becomes reachable — see the list above.
      // Aliased `gn`, not `p`, following the PUT preflight immediately below: an ownership/state
      // check is not a client-facing plant read, and select-columns.test.js scopes its
      // every-column guard to `p`-aliased SELECTs for exactly that reason. Padding this with 20
      // display columns to satisfy a guard it is not the subject of would be the wrong fix.
      const [existing] = await sql`
        SELECT gn.id, gn.deleted_at, gn.container_id
          FROM public.garden_node gn
          LEFT JOIN public.container pp ON pp.id = gn.container_id
         WHERE gn.id = ${plantId}
           AND ( (pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL)
                 OR (gn.container_id IS NULL AND gn.created_by = ANY(${householdIds})) )
      `;
      if (!existing) return resp(404, { error: 'Not found' });
      // Idempotent, matching restorePhoto and lambda/locations.
      if (!existing.deleted_at) {
        return resp(200, { id: existing.id, deleted_at: null, already_restored: true });
      }

      const rows = await sql`
        UPDATE public.garden_node p
           SET deleted_at = NULL
         WHERE p.id = ${plantId}
           AND p.deleted_at IS NOT NULL
           AND (
             EXISTS (SELECT 1 FROM public.container pp
                      WHERE pp.id = p.container_id AND pp.created_by = ANY(${householdIds})
                        AND pp.deleted_at IS NULL)
             OR (p.container_id IS NULL AND p.created_by = ANY(${householdIds}))
           )
        RETURNING p.id, p.display_name AS name, p.deleted_at
      `;
      // The `plants_entity_softdel` trigger mirrors deleted_at onto the entity registry row in BOTH
      // directions (it assigns NEW.deleted_at rather than a literal), so the planting comes back
      // visible to search and the registry with no extra statement here. Verified on the live
      // trigger body, not assumed.
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(200, rows[0]);
    }

    if (seenMatch) {
      const plantId = seenMatch[1];
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');
      const seenAt = body.seen_at ?? null;
      const source = body.source ?? 'app';
      // Household-scoped, ownership-checked INSERT…SELECT. The plants table is aliased
      // `ln` (NOT `p`) so this adds NO 4th `FROM ... p` read block → select-columns.test.js
      // (exactly-3-blocks) stays green. Explicit ::timestamptz cast resolves the
      // 42P18 "could not determine data type" parse failure (L-086). workspace_id is
      // left to the column DEFAULT sentinel (do NOT set it here).
      // BUG-PLANTLESSWRITE-001: LEFT JOIN + project-less ownership arm (see the canonical
      // predicate note above the PUT pre-flight). An INNER JOIN here 404s every project-less
      // planting; the `ln.container_id IS NULL` conjunct keeps own-created_by from ever
      // reaching a planting that sits inside someone else's container.
      const ins = await sql`
        INSERT INTO seen_event (leaf_id, seen_at, source)
        SELECT ln.id, COALESCE(${seenAt}::timestamptz, now()), ${source}
        FROM public.garden_node ln
        LEFT JOIN public.container pp ON pp.id = ln.container_id
        WHERE ln.id = ${plantId} AND ln.deleted_at IS NULL AND ln.archived_at IS NULL
          -- V4-SOFTDEL-001 F4: a planting whose CONTAINER is soft-deleted is not reachable and
          -- not writable. DELETE /api/projects/:id soft-deletes the container only and does NOT
          -- propagate to its child garden_node rows, so without this the child stayed live on
          -- the Plants page and stayed editable through every by-id path in this file. The
          -- predicate rides INSIDE the container arm on purpose — a project-less planting
          -- (container_id IS NULL) has no container to be deleted and must keep working.
          AND (( pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL )
               OR (ln.container_id IS NULL AND ln.created_by = ANY(${householdIds})))
        RETURNING leaf_id
      `;
      if (!ins.length) return resp(404, { error: 'Not found' });
      // Read back the trigger-maintained last_seen_at (no `p` alias → regex-safe).
      const back = await sql`SELECT last_seen_at FROM public.garden_node WHERE id = ${plantId}`;
      return resp(201, { leaf_id: ins[0].leaf_id, last_seen_at: back[0]?.last_seen_at ?? null });
    }

    // ── V4-PLANTMERGE-001 — merge N sibling plantings into this one ─────────────────────────────
    //
    // The winner is the path id; `loser_ids` are folded in and soft-deleted. Every child surface is
    // repointed, batch fan-out duplicates are collapsed group-scoped, and the winner's own scalars
    // are reconciled by rule (phenology -> latest cohort, status -> most advanced) rather than
    // winner-takes-all. mergeCore owns all of it and returns {status, body} directly.
    //
    // `op_id` is required and is the idempotency key: a replay returns the first run's outcome
    // instead of merging twice. `fingerprint` is the caller's pre-read of the group and is
    // re-asserted inside the operation — a concurrent write to a loser between read and cutover
    // 409s rather than being swept into the winner invisibly.
    if (mergeMatch) {
      const winnerId = mergeMatch[1];
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      let body;
      try { body = JSON.parse(event.body ?? '{}'); }
      catch { return resp(400, { error: 'Invalid JSON body' }); }

      const r = await mergeCore(sql, {
        winnerId,
        loserIds: body.loser_ids,
        opId: body.op_id,
        fingerprint: body.fingerprint ?? null,
        overrides: body.overrides ?? {},
        groupLabel: body.group_label ?? null,
        dryRun: body.dry_run === true,
        userId,
        householdIds,
      });
      return resp(r.status, r.body);
    }

    // ── V4-OVERWINTERCARE-001 — set / clear the overwintering care attribute ─────────────────────
    //
    // All of the work is in overwinterAttr.js, which is import-able by a test (index.js is not —
    // it pulls @neondatabase/serverless + @clerk/backend + @aws-sdk/* at module load, which is why
    // every other guard in this directory is source-text only). This branch stays a thin adapter
    // deliberately: everything worth asserting about the write is then asserted against a running
    // function rather than a regex over its source.
    if (overwinterMatch) {
      const plantId = overwinterMatch[1];
      if (method !== 'PATCH') return resp(405, { error: 'Method not allowed' });
      let body;
      try { body = JSON.parse(event.body ?? '{}'); }
      catch { return resp(400, { error: 'Invalid JSON body' }); }
      const r = await setOverwinterCore(sql, { plantId, householdIds, body });
      return resp(r.status, r.body);
    }

    if (archiveMatch) {
      const plantId = archiveMatch[1];
      if (method !== 'PATCH') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');
      const archived = body.archived !== false; // default true; {archived:false} un-archives
      // Mirrors the DELETE handler shape (UPDATE ... FROM public.container pp). archived_at lives
      // on base plants, exposed through the updatable garden_node view (V3-ARCHIVE-001 0b-views).
      // deleted_at filter retained: a deleted planting can't be (un)archived. NOT a SELECT...FROM
      // garden_node p block, so select-columns.test.js exactly-3 invariant holds.
      // BUG-PLANTLESSWRITE-001: the container moved from the UPDATE's FROM list into an EXISTS
      // arm. `UPDATE ... FROM container pp` is an inner join by construction, so a project-less
      // planting matched zero rows and 404'd; EXISTS expresses the same container-ownership test
      // without forcing the row to have a container. Same predicate as the other five sites.
      const rows = await sql`
        UPDATE public.garden_node p
        SET archived_at = CASE WHEN ${archived} THEN NOW() ELSE NULL END
        WHERE p.id = ${plantId}
          AND (
            -- V4-SOFTDEL-001 F4 container-deleted gate (rationale at the seen_event INSERT above).
            EXISTS (SELECT 1 FROM public.container pp
                     WHERE pp.id = p.container_id AND pp.created_by = ANY(${householdIds})
                       AND pp.deleted_at IS NULL)
            OR (p.container_id IS NULL AND p.created_by = ANY(${householdIds}))
          )
          AND p.deleted_at IS NULL
        RETURNING p.id, p.archived_at
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(200, rows[0]);
    }

    if (idMatch) {
      const plantId = idMatch[1];

      if (method === 'GET') {
        // V1.2a-4 S1.A-hotfix: extend SELECT to include the 21 PROJ-RESCOPE
        // columns landed by proj-rescope-s1-0a-additive.sql (V102 §4.1).
        // Pairs with the POST/PATCH write paths shipped in S1; this restores
        // write→read symmetry the original S1 ship missed (Anomaly #A,
        // v12a4-s1-chrome-smoke-verdict-20260518.md).
        const rows = await sql`
          SELECT p.id, p.display_name AS name, p.quantity,
                 p.status, p.notes, p.container_id AS project_id,
                 p.cultivar_id AS variety_id, p.source_inventory_item_id, p.metadata,
                 COALESCE(fp.id, fb.id) AS featured_photo_id,
                 (fp.id IS NOT NULL) AS featured_is_explicit,
                 COALESCE(fp.storage_path, fb.storage_path) AS featured_photo_storage_path,
                 p.created_at, p.updated_at,
                 p.sown_at, p.sown_at_approx,
                 p.germinated_at, p.germinated_at_approx,
                 p.transplanted_at, p.transplanted_at_approx,
                 p.planted_out_at, p.planted_out_at_approx,
                 p.qty_initial, p.qty_current, p.qty_harvested, p.qty_lost, p.loss_cause,
                 p.seeds_sown, p.seeds_germinated,
                 p.source_type, p.source_ref, p.source_generation,
                 p.parent_plant_id, p.divergence_type, p.lineage_note,
                 p.succession_group_id, p.succession_order, p.assignee_user_id,
                 p.container_type, p.container_size, p.location_id,
                 p.acquired_mature, p.acquired_mature_source, p.acquired_mature_set_at,
                 pp.display_name AS project_name,
                 CASE WHEN pv.id IS NOT NULL THEN
                   jsonb_build_object(
                     'id', pv.id, 'name', pv.display_name, 'species', pv.species, 'genus', pv.genus,
                     'days_to_maturity_min', pv.days_to_maturity_min,
                     'days_to_maturity_max', pv.days_to_maturity_max,
                     'care_notes', pv.care_notes, 'soil_notes', pv.soil_notes,
                     'sun_requirements', pv.sun_requirements,
                     'common_diseases', pv.common_diseases,
                     'expected_yield_notes', pv.expected_yield_notes,
                     'photo_id', pv.photo_id, 'source_url', pv.source_url, 'scoville_min', pv.scoville_min, 'scoville_max', pv.scoville_max, 'growth_habit', pv.growth_habit, 'lifecycle', pv.lifecycle, 'crop_type_slug', pv.crop_type_slug, 'dtm_basis', COALESCE(pv.dtm_basis, ct.dtm_basis), 'default_unit', ct.default_unit, 'harvest_habit', ct.harvest_habit
                   )
                 ELSE NULL END AS variety_ref,
                 parent.display_name AS parent_plant_name, parent.container_id AS parent_project_id,
                 -- Care re-key Step D (care-rekey-001 / V4-CAREKEY-001): the care band is keyed on
                 -- THIS PLANTING, not on its container. This join was em.project_id = pp.id, so a
                 -- planting inherited whatever its most-recently-tended SIBLING did: measured on live
                 -- prod at cutover, 51 of 252 plantings (42 Dave, 9 rescue-intake) were shown a
                 -- last_watered_at that is not their own. Two plantings in the same container now
                 -- carry independent cadences, which is the grain the daily-plan engine has always
                 -- used (engine.js derives last_water from event_log WHERE plant_id = p.id).
                 -- next_water_at is NULL on every plant-keyed row by construction (0b-backfill.sql
                 -- and the Step-B upsert both omit it deliberately — design §8.1: the engine owns
                 -- "due", the cache owns "when did this last happen"). The COALESCE below is the
                 -- read-time fallback that keeps the band from blanking in an engine-skip window:
                 -- the SAME interval ladder the legacy project row baked in, but anchored on this
                 -- planting's own last_watered_at instead of the container's. Strictly less wrong
                 -- than what shipped before, and not baked into the cache.
                 COALESCE(
                   em.next_water_at,
                   em.last_watered_at + (COALESCE(em.watering_interval_days, 4)::int * INTERVAL '1 day')
                 ) AS next_water_at,
                 em.location_type, em.watering_interval_days, em.last_watered_at,
                 -- V4-OVERWINTERCARE-001 read-back. The PATCH writer below has no surface to read
                 -- itself from without this: the attribute lives in care_profile, not on the
                 -- planting, so the detail page would have shown "not set" the moment it reloaded
                 -- and the user would have re-set it forever. Exactly the write→read asymmetry
                 -- class BUG-PLANTREAD-001 and V4-ACQMATURE-001 already cost this file twice.
                 -- LEAF SCOPE ONLY, on purpose. v_resolved_care merges system||cultivar||leaf, so
                 -- reading the resolved profile here would show an inherited cultivar-level value
                 -- as though it were this planting's setting — and the Clear button would then
                 -- appear to do nothing, because clearing the leaf row cannot remove a cultivar
                 -- key. This column answers "what is set ON THIS PLANTING", which is the only
                 -- question the control can act on.
                 ow.profile -> 'overwintering' AS overwintering
          FROM public.garden_node p
          LEFT JOIN public.container pp ON pp.id = p.container_id
          LEFT JOIN care_profile ow ON ow.scope = 'leaf'::care_scope AND ow.scope_id = p.id
          LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id AND pv.deleted_at IS NULL
          LEFT JOIN public.crop_types ct ON ct.slug = pv.crop_type_slug AND ct.deleted_at IS NULL
          -- BUG-PHOTOHEROMOVE-001 / INV-HERO — the hero is DERIVED here, never trusted from the
          -- stored pointer. Same shape as fetchSpaceHero (lambda/photos/index.js:~314); read its
          -- long-form rationale before touching this. Two predicates: the photo must be ALIVE, and
          -- it must STILL be a member of this planting's gallery.
          --
          -- The membership arm is the one that matters here. Reassign ships today (PhotoLibrary's
          -- tag modal, full-replace PUT): moving photo P from planting A to B re-parents the row
          -- and leaves A.featured_photo_id = P. NOTHING IS DELETED, so no deleted_at filter can
          -- ever catch it — a hero that is no longer in its own gallery is only detectable by
          -- re-checking membership.
          --
          -- MEMBERSHIP IS EVENT-INCLUSIVE, and that is load-bearing, not defensive. EventNew logs
          -- event photos with {project_id, event_id} and NO plant_id, so a plant_id-only re-check
          -- would demote 123 of the 250 explicit plant heroes live on prod (measured 2026-08-12)
          -- to the fallback arm — a mass product regression wearing the costume of a bug fix.
          -- The predicate below is the SAME ONE the set-featured WRITE validator already enforces
          -- (~:340 below, V4-PHOTOFEATURE-002). That is deliberate: these are the read half and
          -- the write half of ONE invariant. Diverging them manufactures the silent-revert bug
          -- fetchSpaceHero's comment documents — the user re-picks the photo, the write accepts
          -- it, the read demotes it again, forever. If you change one, change both.
          --
          -- LATERAL for the explicit arm (not a plain LEFT JOIN with extra ON clauses) only
          -- because the predicate needs event_log, which a join in this position cannot reference.
          LEFT JOIN LATERAL (
                 SELECT ph.id, ph.storage_path
                   FROM photos ph
                   LEFT JOIN public.event_log e ON e.id = ph.event_id
                  WHERE ph.id = p.featured_photo_id
                    AND ph.deleted_at IS NULL
                    AND ph.created_by = ANY(${householdIds})
                    AND (ph.plant_id = p.id OR e.plant_id = p.id)
                  LIMIT 1
               ) fp ON TRUE
          LEFT JOIN LATERAL (
                 SELECT ph.id, ph.storage_path
                   FROM photos ph
                   LEFT JOIN public.event_log e ON e.id = ph.event_id
                  WHERE ph.deleted_at IS NULL
                    AND ph.created_by = ANY(${householdIds})
                    AND (ph.plant_id = p.id OR e.plant_id = p.id)
                  ORDER BY ph.created_at DESC, ph.id DESC
                  LIMIT 1
               ) fb ON TRUE
          LEFT JOIN public.garden_node parent ON parent.id = p.parent_plant_id AND parent.deleted_at IS NULL
          LEFT JOIN entity_memory em ON em.plant_id = p.id
          WHERE p.id = ${plantId}
            AND p.deleted_at IS NULL
            -- V4-SOFTDEL-001 F4 container-deleted gate (rationale at the seen_event INSERT above).
            AND (( pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL )
                 OR (p.container_id IS NULL AND p.created_by = ANY(${householdIds})))
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        const row = rows[0];

        // DRG-WXWATER-002: reconcile the care-band schedule to the AUTHORITATIVE daily-plan verdict
        // (same source Today/alert bar read), so a rain-satisfied / dormant planting stops lighting a
        // false "Overdue" band. Caretaker-agnostic: search ALL household plans for today by plant_id
        // (plan is per-caretaker; by-id GET is household-scoped). Trust guard + legacy fallback mirror
        // dashboard/handlers.js queryWaterDueFromPlan exactly. Separate query -> the guarded by-id
        // SELECT (select-columns.test.js exactly-3 invariant) is untouched.
        const verdictRows = await sql`
          WITH params AS (SELECT (now() AT TIME ZONE 'America/New_York')::date AS et_today)
          SELECT
            (SELECT json_agg(json_build_object(
                'sv', (dp.items->>'schema_version')::int,
                'water_due', CASE WHEN jsonb_typeof(dp.items->'water_due') = 'array'
                                  THEN dp.items->'water_due' ELSE '[]'::jsonb END))
             FROM daily_plan dp, params
             WHERE dp.user_id = ANY(${householdIds}) AND dp.plan_date = params.et_today) AS plan_rows,
            EXISTS(SELECT 1 FROM event_log ev, params
                   WHERE ev.plant_id::text = ${plantId}
                     AND ev.deleted_at IS NULL
                     AND ev.event_type IN ('watering','rain')
                     AND (ev.event_date AT TIME ZONE 'America/New_York')::date = params.et_today) AS satisfied_today
        `;
        const verdict = reconcileNextWaterAt({
          nextWaterAt: row.next_water_at,
          planRows: verdictRows[0]?.plan_rows ?? null,
          satisfiedToday: verdictRows[0]?.satisfied_today === true,
          plantId,
        });
        if (verdict.water_due_source !== 'plan') {
          // Observable divergence (mirrors the bar's loud log): the detail band fell back to the naive
          // entity_memory schedule because no trusted daily_plan row exists for today.
          console.warn('[water_verdict] plants by-id fell back to naive schedule', { plantId, source: verdict.water_due_source });
        }
        row.next_water_at = verdict.next_water_at;
        row.water_due_source = verdict.water_due_source;

        const photoUrls = await featuredPhotoUrls(row.featured_photo_storage_path);
        const { featured_photo_storage_path: _ignore, ...rest } = row;
        return resp(200, { ...rest, ...photoUrls });
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');

        // V1.2a-4 S1 (PROJ-RESCOPE): server-side enum validation for the new
        // lifecycle/source/lineage fields. Mirrors DB CHECK constraints; NULL allowed.
        //
        // V4-LOSSEVENT-001 WIDENED THIS (2026-08-18, Dave): + animal_damage, + culled. DEPLOY-
        // ORDERED, AND IN THE OPPOSITE DIRECTION FROM validateQtyLost IN THE SAME BUNDLE —
        // SCHEMA FIRST. A widened validator against a narrow DB turns 'culled' into a 23514 on
        // plants_loss_cause_check; a narrow validator against a widened DB is just a 400 with a
        // clear message. So migrations/v4-losscapture-001/0b must be applied to BOTH environments
        // before this Lambda ships. It is safe to be out of order TODAY only because nothing in
        // src/ has ever sent loss_cause — lambda/plants/loss-cause-vocab.test.js asserts that
        // absence, so this stops being a free pass the moment a caller appears.
        //
        // Canonical vocabulary: src/lib/eventTypes.js LOSS_REASONS, pinned to the migration ARRAY
        // and to gates.yml by that same test. Do not edit one copy.
        const ALLOWED_LOSS = ['pest', 'disease', 'weather', 'transplant_shock', 'unknown', 'animal_damage', 'culled'];
        // V4-SOURCEFREE-001: source_type is free-text (like event_type). No server allowlist; DB CHECK dropped. UI dropdownRegistry is the single source of truth.
        // BUG-DIVERGENCEVOCAB-001: this list had ZERO overlap with plants_divergence_type_check
        // ('division','cutting','saved_seed_from'), so every value this allowlist admitted the DB
        // rejected 23514 -> 400 and the field was unwritable in both directions from V1.2a-4 S1
        // (commit a265aa6, whose comment claimed to mirror the CHECK) until 2026-08-06. The DB set
        // is canonical: divergence_type TYPES THE PARENT EDGE — given parent_plant_id, how this
        // planting was propagated OFF that parent (proj-rescope-plan V102 §4.1 "parent_plant_id
        // (narrow semantics: divergence only)", schema map "narrow: division/cutting/saved-seed").
        // The old mutation/cross/selection set is breeding-genetics vocabulary, which V102 defers to
        // V4 BREEDING-LINES; lineage_note is the interim free-text hatch. No 'unknown' member —
        // NULL already means "not recorded". Canonical source: migrations/v4-divergencevocab-001/
        // 0a-additive-ddl.sql; lambda/plants/divergence-enum.test.js parses it and fails on drift.
        const ALLOWED_DIVERGENCE = ['division', 'cutting', 'saved_seed_from'];
        const ALLOWED_CONTAINER = ['fabric_bag','plastic_pot','terracotta','ceramic','raised_bed','in_ground','tray_cell','hanging_basket','window_box','trough','whiskey_barrel','soil_block','solo_cup','other'];
        if (body.loss_cause != null && !ALLOWED_LOSS.includes(body.loss_cause)) {
          return resp(400, { error: `loss_cause must be one of ${ALLOWED_LOSS.join(', ')} or null` });
        }
        if (body.divergence_type != null && !ALLOWED_DIVERGENCE.includes(body.divergence_type)) {
          return resp(400, { error: `divergence_type must be one of ${ALLOWED_DIVERGENCE.join(', ')} or null` });
        }
        if (body.container_type != null && !ALLOWED_CONTAINER.includes(body.container_type)) {
          return resp(400, { error: `container_type must be one of ${ALLOWED_CONTAINER.join(', ')} or null` });
        }

        // V2-PHOTO-F1: strict validation for featured_photo_id (linkage = photos.plant_id).
        const hasFeatured = Object.prototype.hasOwnProperty.call(body, 'featured_photo_id');
        // Presence-sentinel for variety_id: lets a caller CLEAR a variety (send variety_id:null).
        // COALESCE can SET but not unset (NULL collapses to the existing value); mirror the
        // featured_photo_id CASE pattern below. No explicit casts — same proven-in-prod shape.
        const hasVariety = Object.prototype.hasOwnProperty.call(body, 'variety_id');
        const hasAssignee = Object.prototype.hasOwnProperty.call(body, 'assignee_user_id');
        const hasLocation = Object.prototype.hasOwnProperty.call(body, 'location_id');
        // V4-ACQMATURE-001: same presence-sentinel, and here it is doing MORE work than for the
        // FKs above. acquired_mature is a tri-state whose NULL is a meaningful third answer ("never
        // asked"), so a COALESCE merge would make that answer unreachable the moment anything is
        // written — the sentinel is the only shape that can express all three. Deliberately NOT on
        // the `clear` allowlist; validate.js's tier-3 block says why.
        const hasAcquiredMature = Object.prototype.hasOwnProperty.call(body, 'acquired_mature');
        const _amErr = validateAcquiredMature(body);
        if (_amErr) return resp(400, { error: _amErr });
        // V4-LOSSEVENT-001 — non-negative floor on qty_lost, shared with the POST path. MUST BE
        // DEPLOYED BEFORE migrations/v4-losscapture-001/0b-arm-checks.sql arms
        // chk_plants_qty_lost_nonneg: the COALESCE below writes body.qty_lost straight through, so
        // without this the arming step converts a client-supplied negative from a stored (bad) row
        // into a 23514 -> 500 on a live route. validate.js carries the full ordering note.
        const _qlErr = validateQtyLost(body);
        if (_qlErr) return resp(400, { error: _qlErr });
        if (hasFeatured && body.featured_photo_id != null) {
          // V4-PHOTOFEATURE-002 (Dave bug: "Couldn't set featured photo"): accept a photo linked
          // to this plant EITHER directly (photos.plant_id) OR via an event logged on this plant
          // (photos.event_id -> event_log.plant_id). EventNew logs event photos with
          // {project_id,event_id} and NO plant_id, so ~half of a plant's gallery photos are
          // event-linked; the old plant_id-only check rejected them. Household-scoped as before.
          const linkRows = await sql`
            SELECT 1 FROM photos ph
              LEFT JOIN event_log e ON e.id = ph.event_id
             WHERE ph.id = ${body.featured_photo_id}
               AND ph.created_by = ANY(${householdIds})
               AND ph.deleted_at IS NULL
               AND (ph.plant_id = ${plantId} OR e.plant_id = ${plantId})
          `;
          if (!linkRows.length) {
            return resp(400, { error: 'featured_photo_id must be a photo linked to this plant' });
          }
        }

        // AUTHZ (V4-AUTHZSWEEP-001): location_id / parent_plant_id / source_inventory_item_id are
        // cross-entity FKs settable straight from the body. The DB FK proves the row EXISTS, not that
        // the caller owns it — without these gates an authenticated user could pin their planting to
        // another household's location or lineage parent, writing a cross-household FK and leaking the
        // referenced row's fields through every read surface that JOINs it. Generic 400s only (no
        // existence oracle), matching the featured_photo_id check above and preservation's loaders.
        if (hasLocation && body.location_id != null) {
          if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
            warnRejectedFk(userId, 'plants', 'location_id', body.location_id);
            return resp(400, { error: 'location_id does not match a location you can use' });
          }
        }
        if (body.parent_plant_id != null) {
          if (!await loadOwnedPlantingRef(sql, body.parent_plant_id, householdIds)) {
            warnRejectedFk(userId, 'plants', 'parent_plant_id', body.parent_plant_id);
            return resp(400, { error: 'parent_plant_id does not match a planting you can use' });
          }
        }
        if (body.source_inventory_item_id != null) {
          if (!await loadOwnedInventoryItem(sql, body.source_inventory_item_id, householdIds)) {
            warnRejectedFk(userId, 'plants', 'source_inventory_item_id', body.source_inventory_item_id);
            return resp(400, { error: 'source_inventory_item_id does not match an inventory item you can use' });
          }
        }
        // BUG-PARENTOWN-001: succession_group_id is the FOURTH body-settable cross-entity FK on this
        // verb (plants_succession_group_id_fkey -> plants.id) and the V4-AUTHZSWEEP-001 pass missed
        // it — the same class as the three above, ungated on BOTH verbs until now.
        if (body.succession_group_id != null) {
          if (!await loadOwnedPlantingRef(sql, body.succession_group_id, householdIds)) {
            warnRejectedFk(userId, 'plants', 'succession_group_id', body.succession_group_id);
            return resp(400, { error: 'succession_group_id does not match a planting you can use' });
          }
        }

        // ── CANONICAL OWNERSHIP PREDICATE (BUG-PLANTLESSWRITE-001) ────────────────────────────
        // Every by-id read/write in this Lambda scoped ownership through an INNER JOIN on the
        // parent container. garden_node.container_id has been NULLABLE since V3-CAPTURE-001, and
        // Dave's S1 decision makes project-less plantings a SUPPORTED state, so that join silently
        // 404'd every project-less planting on GET/PUT/DELETE/PATCH-archive/POST-seen — permanently
        // uneditable rows the moment CaptureFlow starts creating them.
        //
        // The predicate mirrors the LIST query proven by project-less.test.js:
        //     pp.created_by = ANY(householdIds)
        //     OR (container_id IS NULL AND own created_by = ANY(householdIds))
        //
        // Why it is safe for a WRITE path, not just the read path it was proven on:
        //  1. householdScope() is membership-gated and fail-closed: a caller who is NOT in
        //     GARDEN_HOUSEHOLD_IDS gets [their own sub], so the new arm resolves to "rows I
        //     created myself" — strictly narrower than what they can already read.
        //  2. The `container_id IS NULL` conjunct is LOAD-BEARING, not decoration. Without it,
        //     own-created_by would reach a planting sitting INSIDE a container it does not own.
        //     With the conjunct, the instant a planting has a container the caller must own that
        //     container. Do not "simplify" it away.
        //     CORRECTED 2026-08-13 (BUG-PLANTREHOMEFK-001 recon): this bullet used to justify
        //     itself with "the POST path does not verify that body.project_id is a container you
        //     own, so a foreign user can create such a row today." That is FALSE — POST gates
        //     project_id through loadOwnedProject(householdIds) and 400s (see :999 below). The
        //     conjunct is still load-bearing, for a different and better reason: NON-APP writers
        //     create container-ful rows whose created_by is not the container's. 24 exist in prod
        //     right now from rescue-intake (see claim 5). The guard must hold for rows the API
        //     never minted, so it cannot rest on an API-side check.
        //  3. No APPLICATION path re-homes a planting: container_id is absent from the PUT SET-list
        //     and nothing in the repo writes plants.project_id after INSERT, so a caller cannot move
        //     a row between the two arms. created_by is equally immutable — the BEFORE UPDATE
        //     trigger `prevent_ownership_transfer` RAISEs on any change to it.
        //     AND THE DB NOW GUARANTEES IT TOO, as of v4-plantrehomefk-001 (2026-08-13):
        //     `plants_project_id_fkey` is ON DELETE RESTRICT, so hard-deleting a container is
        //     REFUSED (23503) rather than silently re-homing every child planting into the
        //     project-less arm and handing each one to its own created_by. The old caveat here
        //     said this was "tracked as a separate FK ticket" — it was not; no such row existed
        //     when that was written. It does now, and it is closed. Claim 3 IS a DB-level
        //     guarantee; the escape hatch is an explicit `UPDATE plants SET project_id = NULL`.
        //  4. Nothing here loosens the household boundary: members already read each other's
        //     project-less plantings via the list query and already write each other's projected
        //     plantings via pp.created_by. This closes a read/write asymmetry rather than opening
        //     a new surface.
        //  5. Fail-closed on bad data: a project-less row whose created_by is NULL or a non-Clerk
        //     sentinel (24 such container-ful rows exist from rescue-intake) matches nobody — it
        //     becomes unreachable rather than public.
        const cur = await sql`
          SELECT gn.status AS old_status, gn.container_id AS proj_id
          FROM public.garden_node gn
          LEFT JOIN public.container pp ON pp.id = gn.container_id
          WHERE gn.id = ${plantId}
            -- V4-SOFTDEL-001 F4 container-deleted gate (rationale at the seen_event INSERT above).
            -- Kept in lockstep with the UPDATE below: this pre-flight decides the 404, so a
            -- looser predicate here would 200 a write the UPDATE then silently matched 0 rows on.
            AND (( pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL )
                 OR (gn.container_id IS NULL AND gn.created_by = ANY(${householdIds})))
            AND gn.deleted_at IS NULL
        `;
        if (!cur.length) return resp(404, { error: 'Not found' });

        // BUG-COALESCECLEAR-001. `clear` is an explicit array of column keys to set to NULL.
        // Absent/[] is byte-identical to the prior behaviour, so every existing caller is
        // unaffected and this ships inert until a client opts in. Validated BEFORE the UPDATE so an
        // un-clearable key is a 400 with a message, never a constraint violation the generic catch
        // turns into an opaque 500.
        const _cerr = validateClear(body.clear, body);
        if (_cerr) return resp(400, { error: _cerr });
        const clear = Array.isArray(body.clear) ? body.clear : [];

        // BUG-BLANKNAME-001 (2026-08-07). The COALESCE guards NULL, not ''. The client sends a
        // trimmed string, so an emptied name box sends '' and blanks the planting's display name.
        // garden_node.display_name is NULLABLE, so unlike the locations/projects twins there is not
        // even a NOT NULL constraint standing behind it — this is the least protected of the four
        // and the one where a blank silently becomes the planting's identity in every list.
        //
        // Narrow on purpose, matching the sibling handlers: `name: null` and an absent key are this
        // PUT's existing no-op grammar. Only a present, non-null, whitespace-only string is refused.
        if (body.name != null && (typeof body.name !== 'string' || !body.name.trim())) {
          return resp(400, { error: 'name cannot be blank' });
        }

        const _oldStatus = cur[0].old_status ?? null;
        const _projectId = cur[0].proj_id;
        const _newStatus = body.status != null ? body.status : _oldStatus;
        const _statusChanged = isStatusChange(_oldStatus, _newStatus);

        // V3-EVENT-003: emit a status_change audit event IN THE SAME TRANSACTION as the status
        // UPDATE (atomic — a missed audit row is data loss, so unlike the best-effort critter
        // hook this is in-txn). event_log + entity_memory have RLS -> set_config the actor;
        // garden_node has none (explicit household scope, verified 2026-06-18).
        const _stmts = [
          sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
          sql`
          UPDATE public.garden_node p
          SET
            display_name             = COALESCE(${body.name ?? null}, p.display_name),
            quantity                 = COALESCE(${body.quantity ?? null}, p.quantity),
            status                   = COALESCE(${body.status ?? null}, p.status),
            notes                    = CASE WHEN ${clear} @> ARRAY['notes'] THEN NULL ELSE COALESCE(${body.notes ?? null}, p.notes) END,
            cultivar_id              = CASE
              WHEN ${hasVariety} THEN ${body.variety_id ?? null}
              ELSE p.cultivar_id
            END,
            source_inventory_item_id = CASE WHEN ${clear} @> ARRAY['source_inventory_item_id'] THEN NULL ELSE COALESCE(${body.source_inventory_item_id ?? null}, p.source_inventory_item_id) END,
            metadata                 = CASE WHEN ${clear} @> ARRAY['metadata'] THEN NULL ELSE COALESCE(${body.metadata ?? null}, p.metadata) END,
            featured_photo_id        = CASE
              WHEN ${hasFeatured} THEN ${body.featured_photo_id ?? null}
              ELSE p.featured_photo_id
            END,
            -- V1.2a-4 S1 (PROJ-RESCOPE / V102 §4.1): lifecycle / attrition / source / lineage / succession columns.
            sown_at                  = CASE WHEN ${clear} @> ARRAY['sown_at'] THEN NULL ELSE COALESCE(${body.sown_at ?? null}, p.sown_at) END,
            -- BUG-SOWNAPPROXORPHAN-001. X_approx says "the date in X is approximate" — it is a
            -- QUALIFIER, and a qualifier with nothing to qualify has no meaning. Every one of these
            -- four is settable independently of its date, so the orphan is reachable two ways:
            -- clear the date without clearing the flag (the clear channel treats keys one at a
            -- time, and isBlank(false) is deliberately false, so a boolean can never enter
            -- clear on its own), or POST/PUT a truthy flag with no date at all — which is exactly
            -- what PlantingEditor does today, sending !!form.sown_at_approx unconditionally
            -- beside form.sown_at || null.
            --
            -- The invariant is enforced HERE rather than in the three forms that can violate it,
            -- and rather than as a CHECK. Here, because this is the single place every client's
            -- write converges. Not a CHECK, because a CHECK would 400 the orphan combination and
            -- the currently-deployed client sends it — arming a constraint over a still-deployed
            -- writer is a break, not a repair. Nulling a flag that qualifies nothing cannot lose
            -- information: there is no date whose precision it could have been describing.
            --
            -- The date expression is repeated inside the flag's CASE on purpose. Postgres evaluates
            -- every SET expression against the PRE-update row, so the two reads agree by
            -- construction; referencing the new value of a sibling column is not available here.
            -- Live prod at authoring: 0 orphans across all four pairs, so this is prophylactic —
            -- the population it prevents is future writes, not existing rows, and no backfill is
            -- owed.
            sown_at_approx           = CASE
              WHEN (CASE WHEN ${clear} @> ARRAY['sown_at'] THEN NULL ELSE COALESCE(${body.sown_at ?? null}, p.sown_at) END) IS NULL THEN NULL
              WHEN ${clear} @> ARRAY['sown_at_approx'] THEN NULL
              ELSE COALESCE(${body.sown_at_approx ?? null}, p.sown_at_approx) END,
            germinated_at            = CASE WHEN ${clear} @> ARRAY['germinated_at'] THEN NULL ELSE COALESCE(${body.germinated_at ?? null}, p.germinated_at) END,
            germinated_at_approx     = CASE
              WHEN (CASE WHEN ${clear} @> ARRAY['germinated_at'] THEN NULL ELSE COALESCE(${body.germinated_at ?? null}, p.germinated_at) END) IS NULL THEN NULL
              WHEN ${clear} @> ARRAY['germinated_at_approx'] THEN NULL
              ELSE COALESCE(${body.germinated_at_approx ?? null}, p.germinated_at_approx) END,
            transplanted_at          = COALESCE(${body.transplanted_at ?? null}, p.transplanted_at),
            -- transplanted_at and planted_out_at are NOT on the server clear allowlist (only their
            -- _approx companions are), so their dates cannot currently be cleared. The guard still
            -- applies: the never-set-date-with-a-checked-box path reaches these two as well.
            transplanted_at_approx   = CASE
              WHEN COALESCE(${body.transplanted_at ?? null}, p.transplanted_at) IS NULL THEN NULL
              WHEN ${clear} @> ARRAY['transplanted_at_approx'] THEN NULL
              ELSE COALESCE(${body.transplanted_at_approx ?? null}, p.transplanted_at_approx) END,
            planted_out_at           = COALESCE(${body.planted_out_at ?? null}, p.planted_out_at),
            planted_out_at_approx    = CASE
              WHEN COALESCE(${body.planted_out_at ?? null}, p.planted_out_at) IS NULL THEN NULL
              WHEN ${clear} @> ARRAY['planted_out_at_approx'] THEN NULL
              ELSE COALESCE(${body.planted_out_at_approx ?? null}, p.planted_out_at_approx) END,
            qty_initial              = CASE WHEN ${clear} @> ARRAY['qty_initial'] THEN NULL ELSE COALESCE(${body.qty_initial ?? null}, p.qty_initial) END,
            qty_current              = CASE WHEN ${clear} @> ARRAY['qty_current'] THEN NULL ELSE COALESCE(${body.qty_current ?? null}, p.qty_current) END,
            qty_harvested            = COALESCE(${body.qty_harvested ?? null}, p.qty_harvested),
            qty_lost                 = COALESCE(${body.qty_lost ?? null}, p.qty_lost),
            loss_cause               = CASE WHEN ${clear} @> ARRAY['loss_cause'] THEN NULL ELSE COALESCE(${body.loss_cause ?? null}, p.loss_cause) END,
            -- V4-SEEDGERMRATE-001 (BD-057). CLEARABLE, like qty_initial/qty_current above and
            -- unlike qty_harvested/qty_lost: both are numbers Dave TYPES from memory at two
            -- different sittings, so "I entered 20 and it was 200" needs a way back to empty.
            -- Without the clear arm a COALESCE-only assignment can raise a value and never
            -- unset one, which is the shape of BUG-PLANTREAD-001's sibling defects.
            seeds_sown               = CASE WHEN ${clear} @> ARRAY['seeds_sown'] THEN NULL ELSE COALESCE(${body.seeds_sown ?? null}, p.seeds_sown) END,
            seeds_germinated         = CASE WHEN ${clear} @> ARRAY['seeds_germinated'] THEN NULL ELSE COALESCE(${body.seeds_germinated ?? null}, p.seeds_germinated) END,
            source_type              = CASE WHEN ${clear} @> ARRAY['source_type'] THEN NULL ELSE COALESCE(${body.source_type ?? null}, p.source_type) END,
            source_ref               = CASE WHEN ${clear} @> ARRAY['source_ref'] THEN NULL ELSE COALESCE(${body.source_ref ?? null}, p.source_ref) END,
            source_generation        = CASE WHEN ${clear} @> ARRAY['source_generation'] THEN NULL ELSE COALESCE(${body.source_generation ?? null}, p.source_generation) END,
            parent_plant_id          = CASE WHEN ${clear} @> ARRAY['parent_plant_id'] THEN NULL ELSE COALESCE(${body.parent_plant_id ?? null}, p.parent_plant_id) END,
            divergence_type          = CASE WHEN ${clear} @> ARRAY['divergence_type'] THEN NULL ELSE COALESCE(${body.divergence_type ?? null}, p.divergence_type) END,
            lineage_note             = CASE WHEN ${clear} @> ARRAY['lineage_note'] THEN NULL ELSE COALESCE(${body.lineage_note ?? null}, p.lineage_note) END,
            succession_group_id      = CASE WHEN ${clear} @> ARRAY['succession_group_id'] THEN NULL ELSE COALESCE(${body.succession_group_id ?? null}, p.succession_group_id) END,
            succession_order         = CASE WHEN ${clear} @> ARRAY['succession_order'] THEN NULL ELSE COALESCE(${body.succession_order ?? null}, p.succession_order) END,
            assignee_user_id         = CASE
              WHEN ${hasAssignee} THEN ${body.assignee_user_id ?? null}
              ELSE p.assignee_user_id
            END,
            container_type           = COALESCE(${body.container_type ?? null}, p.container_type),
            container_size           = CASE WHEN ${clear} @> ARRAY['container_size'] THEN NULL ELSE COALESCE(${body.container_size ?? null}, p.container_size) END,
            location_id              = CASE
              WHEN ${hasLocation} THEN ${body.location_id ?? null}
              ELSE p.location_id
            END,
            -- V4-ACQMATURE-001. The verdict, its provenance and its stamp move together or not at
            -- all: every one of the three is gated on the SAME hasAcquiredMature sentinel, so there
            -- is no request shape that leaves a tag describing a verdict that is not there (the
            -- shape gates.yml's sweep_no_orphan_acquired_mature_source exists to catch).
            --
            -- Provenance and stamp are DERIVED IN SQL from the verdict param rather than accepted
            -- from the body. A client that could send its own acquired_mature_source could write
            -- 'backfill' over a real answer and make a guess indistinguishable from Dave's word,
            -- which is the exact distinction the column pair exists to preserve. Every write that
            -- arrives through this Lambda is, by definition, 'user'.
            --
            -- The verdict expression is repeated inside the two dependent CASEs on purpose, exactly
            -- as the sown_at_approx guard above does it and for the same reason: Postgres evaluates
            -- every SET expression against the PRE-update row, so a sibling column's new value is
            -- not readable here and the three reads agree only by construction.
            acquired_mature          = CASE
              WHEN ${hasAcquiredMature} THEN ${body.acquired_mature ?? null}
              ELSE p.acquired_mature
            END,
            acquired_mature_source   = CASE
              WHEN ${hasAcquiredMature}
                THEN (CASE WHEN ${body.acquired_mature ?? null}::boolean IS NULL THEN NULL ELSE 'user' END)
              ELSE p.acquired_mature_source
            END,
            acquired_mature_set_at   = CASE
              WHEN ${hasAcquiredMature}
                THEN (CASE WHEN ${body.acquired_mature ?? null}::boolean IS NULL THEN NULL ELSE now() END)
              ELSE p.acquired_mature_set_at
            END
          WHERE p.id = ${plantId}
            AND (
              -- V4-SOFTDEL-001 F4 container-deleted gate (rationale at the seen_event INSERT
              -- above). Must match the cur pre-flight SELECT exactly.
              EXISTS (SELECT 1 FROM public.container pp
                       WHERE pp.id = p.container_id AND pp.created_by = ANY(${householdIds})
                         AND pp.deleted_at IS NULL)
              OR (p.container_id IS NULL AND p.created_by = ANY(${householdIds}))
            )
            AND p.deleted_at IS NULL
          RETURNING p.id, p.container_id AS project_id, p.display_name AS name, p.quantity, p.notes, p.status, p.planted_at, p.created_by, p.created_at, p.updated_at, p.deleted_at, p.location_id, p.featured_image_id, p.cultivar_id AS variety_id, p.source_inventory_item_id, p.metadata, p.featured_photo_id, p.sown_at, p.germinated_at, p.transplanted_at, p.planted_out_at, p.sown_at_approx, p.germinated_at_approx, p.transplanted_at_approx, p.planted_out_at_approx, p.qty_initial, p.qty_current, p.qty_harvested, p.qty_lost, p.loss_cause, p.seeds_sown, p.seeds_germinated, p.source_type, p.source_ref, p.source_generation, p.parent_plant_id, p.divergence_type, p.lineage_note, p.succession_group_id, p.succession_order, p.assignee_user_id, p.container_type, p.container_size, p.acquired_mature, p.acquired_mature_source, p.acquired_mature_set_at, p.kind, p.workspace_id, p.last_seen_at, p.attr_override, p.version
        `,
        ];
        if (_statusChanged) {
          const _note = formatStatusChangeNote(_oldStatus, _newStatus, 'plant');
          const _meta = buildStatusChangeMetadata(_oldStatus, _newStatus, 'plant');
          _stmts.push(sql`
            INSERT INTO event_log
              (project_id, plant_id, event_type, event_date, notes, metadata, logged_by, created_by, source)
            VALUES
              (${_projectId}, ${plantId}, ${STATUS_CHANGE_EVENT_TYPE}, NOW(), ${_note}, ${_meta}, ${userId}, ${userId}, ${EVENT_SOURCE_STATUS})
          `);
          // BUG-EMPROJGUARD-001: self-guard on _projectId exactly as the plant-keyed sibling below
          // guards on plantId. garden_node.container_id is NULLABLE (project-less plantings are a
          // supported state per V3-CAPTURE-001), so a NULL here would insert a ZERO-parent row,
          // violate entity_memory_exactly_one_parent, and abort the WHOLE sql.transaction — taking
          // the status_change event_log write above with it and 500-ing the status change.
          // ON CONFLICT (project_id) cannot rescue it: NULLs are distinct in a unique index, so a
          // NULL project_id always takes the INSERT path.
          _stmts.push(sql`
            INSERT INTO entity_memory (project_id, last_event_at)
            SELECT ${_projectId}::uuid, NOW()
            WHERE ${_projectId}::uuid IS NOT NULL
            ON CONFLICT (project_id) DO UPDATE SET
              last_event_at = GREATEST(COALESCE(entity_memory.last_event_at, NOW()), NOW()),
              updated_at = NOW()
          `);
          // Care re-key Step B (care-rekey-001): plant-keyed dual-write of the status-change touch
          // (last_event_at only). Self-guards on plantId. Reads still project-keyed (Step D cuts over).
          _stmts.push(sql`
            INSERT INTO entity_memory (plant_id, last_event_at)
            SELECT ${plantId}::uuid, NOW()
            WHERE ${plantId}::uuid IS NOT NULL
            ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO UPDATE SET
              last_event_at = GREATEST(COALESCE(entity_memory.last_event_at, NOW()), NOW()),
              updated_at = NOW()
          `);
        }
        // V4-ANCHORSUPERSEDE-001 — THE SUPERSEDE MAINTAINER, write-path half.
        //
        // public.plant_anchor_derivation holds an INVENTED anchor for a planting that had no real
        // date (migrations/v4-anchorbase-001). The marking rule says a derived anchor and an
        // observed one may never coexist: the instant Dave enters a real date the guess has been
        // contradicted, and lambda/harvests/watch-route.js would otherwise keep citing it. The
        // retiring UPDATE existed only in 0b-backfill.sql's second transaction, which ran once on
        // 2026-08-12 and is not on any schedule, so nothing maintained the invariant at all.
        //
        // HERE, on the write path, rather than only in the nightly sweep: this is the single place
        // every client's anchor write converges (PlantingEditor, PlantForm, CaptureFlow and
        // TransplantDatePrompt all reach the columns through this PUT), so retiring in the SAME
        // transaction closes the window entirely for app writes instead of leaving a contradicted
        // guess citable until the next nightly run. The nightly sweep in lambda/daily-plan is kept
        // as the backstop for writers that never touch a Lambda (imports, one-off SQL, migrations)
        // and to heal rows that went stale before this shipped.
        //
        // EMITTED UNCONDITIONALLY, not behind a JS test of the body. The post-update anchor state
        // could be mirrored in JS from body + clear + cur, but a mirrored predicate is one edit to
        // the SET-list away from silently disagreeing with it, and the failure mode of that
        // disagreement is a live derivation nobody retires. The predicate lives in SQL, evaluated
        // against the row this transaction just wrote; the cost of always sending it is one probe
        // of uq_plant_anchor_derivation_live, which matches at most one row.
        //
        // Retire, never delete: the (guess, later truth) pair is the only accuracy measurement the
        // add-date baseline tier will ever produce. superseded_at IS NULL is what makes a re-run a
        // no-op. The EXISTS subquery is aliased gp rather than p on purpose — select-columns.test.js
        // extracts SELECT blocks by matching FROM public.garden_node p, and a p here would enter
        // that census as a fifth read block.
        _stmts.push(sql`
          UPDATE public.plant_anchor_derivation d
             SET superseded_at = now(),
                 superseded_by = 'observed_anchor',
                 updated_at    = now()
           WHERE d.plant_id = ${plantId}
             AND d.superseded_at IS NULL
             AND EXISTS (
                   SELECT 1 FROM public.garden_node gp
                    WHERE gp.id = d.plant_id
                      AND (gp.sown_at IS NOT NULL
                           OR gp.transplanted_at IS NOT NULL
                           OR gp.planted_out_at IS NOT NULL))
        `);
        const _txr = await sql.transaction(_stmts);
        const rows = _txr[1];
        if (!rows.length) return resp(404, { error: 'Not found' });

        // V4-HARVWEIGHTEST-001 — re-identifying a planting must re-file the calibration samples
        // captured from it. cultivar_weight_sample.cultivar_id is a COPY of the planting's cultivar
        // taken at capture time, so without this a weighing keeps describing whatever the planting
        // used to be called: "Cherry Rescue 1" (formerly Beefsteak) had two cherry tomatoes, 28 g
        // and 16 g, standing as the corpus's only evidence about a 350 g beefsteak.
        //
        // AFTER the transaction, not inside it: this is a correction to a satellite table, and a
        // failure here must not roll back the planting edit the user asked for. Same posture, and
        // the same try/catch, as the events Lambda's auto-capture hook.
        //
        // Gated on hasVariety rather than on an observed old->new transition. The function's own
        // mismatch predicate IS the change detector — it is a no-op when the corpus already agrees
        // — and that is deliberately stronger: both live re-identifications left NO audit row
        // (audit_events covers plant_varieties only), so a transition-based hook would have missed
        // both. This heals a variety changed by any writer, including psql, on the next save.
        if (hasVariety) {
          try {
            await sql`SELECT public.reattribute_plant_weight_samples(${plantId}::uuid, ${userId})`;
          } catch (e) {
            console.warn('[cal1] weight-sample re-attribution failed (planting saved):', e?.message);
          }
        }
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        // BUG-PLANTLESSWRITE-001: same EXISTS rewrite as PUT/archive.
        //
        // BUG-DELNOOPOK-001 (this change): the route used to return {ok:true} regardless of rows
        // affected, so a not-found / already-deleted / not-owned DELETE all reported success. It
        // now observes the soft-delete's own RETURNING and 404s when nothing matched, which is the
        // shape every sibling verb in this file already has (GET/PUT/archive/seen all 404 on a
        // foreign or unknown id) and the shape inventory-items and the restore routes ship.
        // The 404 deliberately COLLAPSES not-found and not-owned into one status — distinguishing
        // them would leak existence, and `plants.int.test.js` already pins that collapse for the
        // other four verbs.
        // BUG-CACHEORPHANLEAK-001 — the soft-delete must take the care-cache row with it.
        //
        // scripts/integrity-weekly-check.sh's `entity_memory_orphans` metric counts, as an ORPHAN,
        // exactly `em.plant_id IS NOT NULL AND NOT EXISTS (plants p WHERE p.id = em.plant_id AND
        // p.deleted_at IS NULL)`. This route soft-deleted the planting and left the cache row
        // standing, so every soft-delete of a planting that HAS a cache row permanently ratchets a
        // shipped alert metric by one. It has only cost one so far (prod: 1 of 33 soft-deleted
        // plantings carries a cache row, because the other 32 predate the plant-keyed cache) — but
        // it is a monotonic leak, and the next soft-delete of a live planting adds another forever.
        //
        // Deleting rather than soft-deleting the cache row is right on the metric's OWN semantics
        // and on the same reading V4-CACHEMISSINGROW-001 uses to exclude soft-deleted plantings
        // from its backfill: an archive COMPLETES a record, a soft-delete RETRACTS it, and a
        // retracted planting should have no care memory at all. Nothing reads it either way —
        // every rollup filters `gp.deleted_at IS NULL` and the by-id GET 404s.
        //
        // ONE STATEMENT, and that is load-bearing rather than tidy — STILL TRUE after
        // BUG-DELNOOPOK-001. A separate
        // `DELETE FROM entity_memory WHERE plant_id = $1` would carry NO ownership predicate,
        // turning this route into a cross-household write primitive: anyone could erase anyone's
        // care cache by id. That used to be unobservable too, because the route answered {ok:true}
        // regardless of rows affected; the 404 gate below removes the silence but NOT the
        // primitive, so the one-statement property is what still prevents it and must survive any
        // future edit. Driving the delete off the UPDATE's RETURNING means the
        // cache row can only go when the soft-delete it belongs to actually happened, under the
        // ownership predicate already proven above. garden_node is a simple renaming view
        // (information_schema reports is_updatable = YES), so UPDATE ... RETURNING works here.
        //
        // The row-count observation is a SECOND data-modifying CTE plus a terminal SELECT, not a
        // second round trip: `cache` references `gone`, and Postgres runs every data-modifying CTE
        // exactly once and to completion whether or not the primary query reads its output. So the
        // soft-delete, the cache delete and the 404 decision are still one statement, one snapshot,
        // one implicit transaction. Reading the count off the cache DELETE instead would be wrong —
        // it is legitimately 0 for a planting that has no cache row at all (32 of 33 soft-deleted
        // prod plantings predate the plant-keyed cache), which would 404 a successful delete.
        //
        // Loss on undelete is acceptable and self-healing: the cache is derivable from event_log,
        // and the deployed forward writer recreates the row on the next plant-anchored event.
        const _delRows = await sql`
          WITH gone AS (
            UPDATE public.garden_node p
            SET deleted_at = NOW()
            WHERE p.id = ${plantId}
              AND (
                -- V4-SOFTDEL-001 F4 container-deleted gate (rationale at the seen_event INSERT
                -- above). Applied here too so "invisible" and "immutable" stay the same set: after
                -- the read fix there is no UI path to this row anyway, and the real cleanup for a
                -- planting stranded under a deleted container is the projects-side propagation fix
                -- (F4 write side, lambda/projects/index.js — NOT done here), not a per-row DELETE.
                EXISTS (SELECT 1 FROM public.container pp
                         WHERE pp.id = p.container_id AND pp.created_by = ANY(${householdIds})
                           AND pp.deleted_at IS NULL)
                OR (p.container_id IS NULL AND p.created_by = ANY(${householdIds}))
              )
              AND p.deleted_at IS NULL
            RETURNING p.id
          ), cache AS (
            DELETE FROM public.entity_memory em
             USING gone
             WHERE em.plant_id = gone.id
          )
          SELECT id FROM gone
        `;
        if (!_delRows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      const projectId = event.queryStringParameters?.project_id ?? null;
      // V1.2a-3 Increment A (I2a-display): the list query now also selects
      // featured_photo_id + joins photos, mirroring the by-id GET path, so list
      // surfaces (Plants page, ProjectDetail plant rows) can render a thumbnail.
      // Before this, a photo uploaded to a plant linked correctly + auto-promoted
      // plants.featured_photo_id, but no list surface ever read it back — the
      // "photo never appears on the plant" half of bug I2a.
      // Forward-compatible with V3 PHOTO-MULTI: featured_photo_id becomes the
      // "primary photo" and this is a documented single-view_url consumer for
      // the V3-PHOTO-CONSUMER-AUDIT.
      // V1.2a-4 S1.A-hotfix: list SELECTs extended to include the 21 PROJ-RESCOPE
      // columns landed by proj-rescope-s1-0a-additive.sql (V102 §4.1) — matches
      // by-id GET above. Pairs with POST/PATCH write paths shipped in S1.
      // V4-PLANTSPAYLOAD-001 — opt-in `?view=grid` field projection.
      //
      // The default (no `view`) shape is UNTOUCHED and stays byte-identical: ten client call sites
      // read the wide list and only Garden.jsx opts in, so an additive param is the only shape that
      // bounds the blast radius. plants-grid-view.test.js pins both halves.
      //
      // What it drops and why: the Garden grid (Garden.jsx + projectTree.js + PlantingTile.jsx,
      // property-access scan) reads 10 top-level keys and exactly 2 of variety_ref's 21 subfields
      // (`name`, `crop_type_slug`). Measured against prod, variety_ref alone is 43.4% of the DB body
      // and its six prose fields (care_notes/soil_notes/common_diseases/expected_yield_notes/
      // growth_habit/source_url) are 25.1% — none of it reachable from a tile.
      //
      // What it KEEPS and why: both presigned photo URLs. They are the single largest term in the
      // wire body, but the tile renders the thumb and degrades onto the original for the 6-of-230
      // heroes that have none, so dropping either is a blank tile, not a saving.
      //
      // Aliased `gp`, not `p`, deliberately — select-columns.test.js and softdel-container.test.js
      // census the WIDE client-facing reads by their `p`-aliased garden_node source, and a
      // projection is by definition not one of them (same reason the anchor-supersede EXISTS above
      // uses gp). It stays swept for the gate that actually matters: softdel-container's
      // alias-agnostic pass counts EVERY container-reaching template and requires each alias it
      // reaches container through to be liveness-checked, and this branch is inside that count.
      // Its field set is guarded by its own exact-shape test, which is the stronger assertion here.
      // Do not spell the p-aliased FROM clause literally anywhere in this comment: that guard
      // splits RAW source, so the words alone would fabricate a branch it then cannot find.
      //
      // ORDER BY gp.created_at without selecting it: the client never reads created_at, and sorting
      // on an unselected column is free.
      const view = event.queryStringParameters?.view ?? null;
      const rows = view === 'grid'
        ? await sql`
            SELECT gp.id, gp.display_name AS name, gp.quantity,
                   gp.status, gp.container_id AS project_id,
                   gp.location_id, gp.assignee_user_id,
                   COALESCE(fp.id, fb.id) AS featured_photo_id,
                   -- The ONE key here with no Garden reader. It is carried because
                   -- hero-read-derivation.test.js holds EVERY hero-resolving read in the fleet to
                   -- the same contract, and "this surface has no set-featured control today" is not
                   -- a property a static guard can check — so an exemption would rot where a boolean
                   -- costs ~1.5% of the projected body. Keeping the invariant uniform is the cheaper
                   -- side of that trade.
                   (fp.id IS NOT NULL) AS featured_is_explicit,
                   COALESCE(fp.storage_path, fb.storage_path) AS featured_photo_storage_path,
                   CASE WHEN pv.id IS NOT NULL THEN
                     jsonb_build_object('name', pv.display_name, 'crop_type_slug', pv.crop_type_slug)
                   ELSE NULL END AS variety_ref
            FROM public.garden_node gp
            LEFT JOIN public.container pp ON pp.id = gp.container_id
            LEFT JOIN public.cultivar pv ON pv.id = gp.cultivar_id AND pv.deleted_at IS NULL
            LEFT JOIN LATERAL (
                   SELECT ph.id, ph.storage_path
                     FROM photos ph
                     LEFT JOIN public.event_log e ON e.id = ph.event_id
                    WHERE ph.id = gp.featured_photo_id
                      AND ph.deleted_at IS NULL
                      AND ph.created_by = ANY(${householdIds})
                      AND (ph.plant_id = gp.id OR e.plant_id = gp.id)
                    LIMIT 1
                 ) fp ON TRUE
            -- BUG-HEROLISTPERF-001 split+gated fallback, copied intact from the list read below.
            -- Both arms and the fp.storage_path gate are load-bearing; the rationale there governs.
            LEFT JOIN LATERAL (
                   SELECT x.id, x.storage_path
                     FROM (
                            ( SELECT ph.id, ph.storage_path, ph.created_at
                                FROM photos ph
                               WHERE fp.storage_path IS NULL
                                 AND ph.plant_id = gp.id
                                 AND ph.deleted_at IS NULL
                                 AND ph.created_by = ANY(${householdIds})
                               ORDER BY ph.created_at DESC, ph.id DESC
                               LIMIT 1 )
                            UNION ALL
                            ( SELECT ph.id, ph.storage_path, ph.created_at
                                FROM photos ph
                                JOIN public.event_log e ON e.id = ph.event_id
                               WHERE fp.storage_path IS NULL
                                 AND e.plant_id = gp.id
                                 AND ph.deleted_at IS NULL
                                 AND ph.created_by = ANY(${householdIds})
                               ORDER BY ph.created_at DESC, ph.id DESC
                               LIMIT 1 )
                          ) x
                    ORDER BY x.created_at DESC, x.id DESC
                    LIMIT 1
                 ) fb ON TRUE
            WHERE (( pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL )
                   OR (gp.container_id IS NULL AND gp.created_by = ANY(${householdIds})))
              AND gp.deleted_at IS NULL
              AND gp.archived_at IS NULL
              -- project_id stays honoured under ?view=grid rather than silently ignored. The ::uuid
              -- casts are required, not decorative: an untyped NULL parameter is what Postgres
              -- answers "could not determine data type of parameter" to.
              AND (${projectId}::uuid IS NULL OR gp.container_id = ${projectId}::uuid)
            ORDER BY gp.created_at DESC
            LIMIT 5000
          `
        : view === 'picker'
        ? await sql`
            -- V4-PICKERPAYLOAD-001 — the PLANTING-CHOOSER projection. Same additive opt-in contract
            -- as ?view=grid above (default shape byte-identical, blast radius bounded to the call
            -- sites that pass it), and for the same reason: the chooser is the most-opened list in
            -- the app and was fetching the WIDEST shape in it.
            --
            -- MEASURED on prod 2026-08-26, 233 live plantings:
            --   wide (default) DB body   814,399 B   + ~426 presigned S3 URLs
            --   this projection          101,153 B   + ZERO presigned URLs
            --
            -- What it drops and why. The consumer set is exactly two files — EventNew (which fetches
            -- the list and hands it to PlantingSelect as controlled data) and PlantingSelect's own
            -- self-fetch. Between them they read nine top-level keys and FOUR of variety_ref's
            -- twenty-odd. They read NO photo field at all, so the two LATERAL photo joins and both
            -- presigns are dropped outright — that is not only wire bytes but 2x233 signature
            -- computations and a UNION ALL fallback scan per request, for data the chooser cannot
            -- render.
            --
            -- default_unit is the one to be careful about and is NOT droppable: it is the crop's
            -- default harvest unit (V4-HARVUNITDEFAULT-001, read as vref?.default_unit through a
            -- destructured alias, which is why a variety_ref.<field> grep does not find it). It
            -- comes from crop_types, NOT from cultivar — there is no cultivar.default_unit column —
            -- so the ct join below is load-bearing. Build this projection off cultivar alone and the
            -- harvest unit silently stops defaulting per crop, with a green suite.
            --
            -- species is here for a THIRD consumer that the two-file census above does not name and
            -- a field-read grep does not reach: PutUp. PlantingSelect's select() hands the WHOLE
            -- variety_ref object onward through onDerive({ variety }), PutUp does setVariety(it), and
            -- VarietyPicker renders value.species as a visible line under the variety name. So the
            -- object crosses two component boundaries after leaving the surface that fetched it —
            -- census the HANDOFFS, not just the reads, or this projection silently blanks that line.
            --
            -- dtm_basis / harvest_habit are deliberately NOT carried: no consumer on this path imports
            -- plantingMaturity or reads them. If a chooser ever shows an est-harvest chip, they come
            -- back here rather than the call site reverting to the wide shape.
            SELECT gp.id, gp.display_name AS name, gp.quantity,
                   gp.container_id AS project_id, pp.display_name AS project_name,
                   gp.sown_at, gp.succession_order,
                   gp.cultivar_id AS variety_id,
                   -- Carried even though the WHERE already excludes archived rows: EventNew filters
                   -- !p.archived_at client-side as well, and a key that is absent rather than null
                   -- makes that filter vacuously true instead of redundant. Same visible result
                   -- today, but the redundancy is the point — it stays a real second check.
                   gp.archived_at,
                   CASE WHEN pv.id IS NOT NULL THEN
                     jsonb_build_object(
                       'id', pv.id, 'name', pv.display_name,
                       'crop_type_slug', pv.crop_type_slug,
                       'default_unit', ct.default_unit,
                       'species', pv.species)
                   ELSE NULL END AS variety_ref
            FROM public.garden_node gp
            LEFT JOIN public.container pp ON pp.id = gp.container_id
            LEFT JOIN public.cultivar pv ON pv.id = gp.cultivar_id AND pv.deleted_at IS NULL
            LEFT JOIN public.crop_types ct ON ct.slug = pv.crop_type_slug
            WHERE (( pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL )
                   OR (gp.container_id IS NULL AND gp.created_by = ANY(${householdIds})))
              AND gp.deleted_at IS NULL
              AND gp.archived_at IS NULL
              -- Same ::uuid casts as the grid branch, for the same reason: an untyped NULL parameter
              -- is what Postgres answers "could not determine data type of parameter" to.
              AND (${projectId}::uuid IS NULL OR gp.container_id = ${projectId}::uuid)
            ORDER BY gp.created_at DESC
            LIMIT 5000
          `
        : projectId
        ? await sql`
            SELECT p.id, p.display_name AS name, p.quantity,
                   p.status, p.notes, p.container_id AS project_id,
                   p.cultivar_id AS variety_id, p.source_inventory_item_id, p.metadata,
                   COALESCE(fp.id, fb.id) AS featured_photo_id,
                   (fp.id IS NOT NULL) AS featured_is_explicit,
                   COALESCE(fp.storage_path, fb.storage_path) AS featured_photo_storage_path,
                   p.created_at,
                   p.sown_at, p.sown_at_approx,
                   p.germinated_at, p.germinated_at_approx,
                   p.transplanted_at, p.transplanted_at_approx,
                   p.planted_out_at, p.planted_out_at_approx,
                   p.qty_initial, p.qty_current, p.qty_harvested, p.qty_lost, p.loss_cause,
                   p.seeds_sown, p.seeds_germinated,
                   p.source_type, p.source_ref, p.source_generation,
                   p.parent_plant_id, p.divergence_type, p.lineage_note,
                   p.succession_group_id, p.succession_order, p.assignee_user_id,
                   p.container_type, p.container_size, p.location_id,
                   p.acquired_mature, p.acquired_mature_source, p.acquired_mature_set_at,
                   pp.display_name AS project_name,
                   CASE WHEN pv.id IS NOT NULL THEN
                     jsonb_build_object(
                       'id', pv.id, 'name', pv.display_name, 'species', pv.species, 'genus', pv.genus,
                       'days_to_maturity_min', pv.days_to_maturity_min,
                       'days_to_maturity_max', pv.days_to_maturity_max,
                       'care_notes', pv.care_notes, 'soil_notes', pv.soil_notes,
                       'sun_requirements', pv.sun_requirements,
                       'common_diseases', pv.common_diseases,
                       'expected_yield_notes', pv.expected_yield_notes,
                       'photo_id', pv.photo_id, 'source_url', pv.source_url, 'scoville_min', pv.scoville_min, 'scoville_max', pv.scoville_max, 'growth_habit', pv.growth_habit, 'lifecycle', pv.lifecycle, 'crop_type_slug', pv.crop_type_slug, 'dtm_basis', COALESCE(pv.dtm_basis, ct.dtm_basis), 'default_unit', ct.default_unit, 'harvest_habit', ct.harvest_habit
                     )
                   ELSE NULL END AS variety_ref
            FROM public.garden_node p
            JOIN public.container pp ON pp.id = p.container_id
            LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id AND pv.deleted_at IS NULL
            LEFT JOIN public.crop_types ct ON ct.slug = pv.crop_type_slug AND ct.deleted_at IS NULL
            -- INV-HERO effective-hero derivation — full rationale on the by-id GET above
            -- (BUG-PHOTOHEROMOVE-001). Event-inclusive membership is load-bearing: 123 of 250
            -- live plant heroes are event-linked with a NULL photos.plant_id.
            LEFT JOIN LATERAL (
                   SELECT ph.id, ph.storage_path
                     FROM photos ph
                     LEFT JOIN public.event_log e ON e.id = ph.event_id
                    WHERE ph.id = p.featured_photo_id
                      AND ph.deleted_at IS NULL
                      AND ph.created_by = ANY(${householdIds})
                      AND (ph.plant_id = p.id OR e.plant_id = p.id)
                    LIMIT 1
                 ) fp ON TRUE
            -- BUG-HEROLISTPERF-001 — the LIST fallback is split into two index-usable arms and
            -- gated on the explicit arm. The by-id read above keeps the plain
            -- (ph.plant_id = p.id OR e.plant_id = p.id) disjunction because it resolves ONE row;
            -- here that same disjunction spans TWO relations, so the planner cannot use
            -- idx_photos_plant and re-scans the whole photo set per planting. Measured live on
            -- prod (259 live plantings x 1253 live photos, EXPLAIN ANALYZE 2026-08-12):
            -- 864 ms with loops=324527 -- on GET /api/plants, which every log-form mount fires.
            -- Split + gated: 4.6 ms, same 259 rows, byte-identical hero ids/urls/flags.
            --
            -- SEMANTICS ARE UNCHANGED, and both halves of that matter:
            --   * UNION ALL of (plant_id arm, event arm) is the SAME row set as the OR. Taking the
            --     newest of each arm and then the newest of those two is the newest overall, so
            --     the ORDER BY ... LIMIT 1 still picks exactly the row the disjunction picked.
            --   * fp.storage_path IS NULL gates the whole fallback on the explicit arm having
            --     resolved, reproducing the COALESCE below for EVERY nullability case -- including
            --     a hypothetical fp row with a NULL storage_path, which still falls through to fb.
            --     Deliberately NOT fp.id IS NULL: that is equivalent only while photos.storage_path
            --     stays NOT NULL, i.e. it would silently couple this query to a column constraint.
            --     Postgres compiles it to a One-Time Filter, so the fallback runs only for the
            --     plantings that actually need it (19 of 259 live).
            -- Event-inclusive membership is preserved by the second arm and is still load-bearing
            -- (123 live heroes) -- see the by-id rationale above before touching either arm.
            LEFT JOIN LATERAL (
                   SELECT x.id, x.storage_path
                     FROM (
                            ( SELECT ph.id, ph.storage_path, ph.created_at
                                FROM photos ph
                               WHERE fp.storage_path IS NULL
                                 AND ph.plant_id = p.id
                                 AND ph.deleted_at IS NULL
                                 AND ph.created_by = ANY(${householdIds})
                               ORDER BY ph.created_at DESC, ph.id DESC
                               LIMIT 1 )
                            UNION ALL
                            ( SELECT ph.id, ph.storage_path, ph.created_at
                                FROM photos ph
                                JOIN public.event_log e ON e.id = ph.event_id
                               WHERE fp.storage_path IS NULL
                                 AND e.plant_id = p.id
                                 AND ph.deleted_at IS NULL
                                 AND ph.created_by = ANY(${householdIds})
                               ORDER BY ph.created_at DESC, ph.id DESC
                               LIMIT 1 )
                          ) x
                    ORDER BY x.created_at DESC, x.id DESC
                    LIMIT 1
                 ) fb ON TRUE
            WHERE pp.created_by = ANY(${householdIds})
              -- V4-SOFTDEL-001 F4 container-deleted gate (rationale at the seen_event INSERT
              -- above). Top-level here because this branch INNER JOINs the container — the
              -- project-less arm cannot reach this query at all.
              AND pp.deleted_at IS NULL
              AND p.container_id = ${projectId}
              AND p.deleted_at IS NULL
              AND p.archived_at IS NULL
            ORDER BY p.created_at DESC
            LIMIT 5000
          `
        : await sql`
            SELECT p.id, p.display_name AS name, p.quantity,
                   p.status, p.notes, p.container_id AS project_id,
                   p.cultivar_id AS variety_id, p.source_inventory_item_id, p.metadata,
                   COALESCE(fp.id, fb.id) AS featured_photo_id,
                   (fp.id IS NOT NULL) AS featured_is_explicit,
                   COALESCE(fp.storage_path, fb.storage_path) AS featured_photo_storage_path,
                   p.created_at,
                   p.sown_at, p.sown_at_approx,
                   p.germinated_at, p.germinated_at_approx,
                   p.transplanted_at, p.transplanted_at_approx,
                   p.planted_out_at, p.planted_out_at_approx,
                   p.qty_initial, p.qty_current, p.qty_harvested, p.qty_lost, p.loss_cause,
                   p.seeds_sown, p.seeds_germinated,
                   p.source_type, p.source_ref, p.source_generation,
                   p.parent_plant_id, p.divergence_type, p.lineage_note,
                   p.succession_group_id, p.succession_order, p.assignee_user_id,
                   p.container_type, p.container_size, p.location_id,
                   p.acquired_mature, p.acquired_mature_source, p.acquired_mature_set_at,
                   pp.display_name AS project_name,
                   CASE WHEN pv.id IS NOT NULL THEN
                     jsonb_build_object(
                       'id', pv.id, 'name', pv.display_name, 'species', pv.species, 'genus', pv.genus,
                       'days_to_maturity_min', pv.days_to_maturity_min,
                       'days_to_maturity_max', pv.days_to_maturity_max,
                       'care_notes', pv.care_notes, 'soil_notes', pv.soil_notes,
                       'sun_requirements', pv.sun_requirements,
                       'common_diseases', pv.common_diseases,
                       'expected_yield_notes', pv.expected_yield_notes,
                       'photo_id', pv.photo_id, 'source_url', pv.source_url, 'scoville_min', pv.scoville_min, 'scoville_max', pv.scoville_max, 'growth_habit', pv.growth_habit, 'lifecycle', pv.lifecycle, 'crop_type_slug', pv.crop_type_slug, 'dtm_basis', COALESCE(pv.dtm_basis, ct.dtm_basis), 'default_unit', ct.default_unit, 'harvest_habit', ct.harvest_habit
                     )
                   ELSE NULL END AS variety_ref
            FROM public.garden_node p
            LEFT JOIN public.container pp ON pp.id = p.container_id
            LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id AND pv.deleted_at IS NULL
            LEFT JOIN public.crop_types ct ON ct.slug = pv.crop_type_slug AND ct.deleted_at IS NULL
            -- INV-HERO effective-hero derivation — full rationale on the by-id GET above
            -- (BUG-PHOTOHEROMOVE-001). Event-inclusive membership is load-bearing: 123 of 250
            -- live plant heroes are event-linked with a NULL photos.plant_id.
            LEFT JOIN LATERAL (
                   SELECT ph.id, ph.storage_path
                     FROM photos ph
                     LEFT JOIN public.event_log e ON e.id = ph.event_id
                    WHERE ph.id = p.featured_photo_id
                      AND ph.deleted_at IS NULL
                      AND ph.created_by = ANY(${householdIds})
                      AND (ph.plant_id = p.id OR e.plant_id = p.id)
                    LIMIT 1
                 ) fp ON TRUE
            -- BUG-HEROLISTPERF-001 — the LIST fallback is split into two index-usable arms and
            -- gated on the explicit arm. The by-id read above keeps the plain
            -- (ph.plant_id = p.id OR e.plant_id = p.id) disjunction because it resolves ONE row;
            -- here that same disjunction spans TWO relations, so the planner cannot use
            -- idx_photos_plant and re-scans the whole photo set per planting. Measured live on
            -- prod (259 live plantings x 1253 live photos, EXPLAIN ANALYZE 2026-08-12):
            -- 864 ms with loops=324527 -- on GET /api/plants, which every log-form mount fires.
            -- Split + gated: 4.6 ms, same 259 rows, byte-identical hero ids/urls/flags.
            --
            -- SEMANTICS ARE UNCHANGED, and both halves of that matter:
            --   * UNION ALL of (plant_id arm, event arm) is the SAME row set as the OR. Taking the
            --     newest of each arm and then the newest of those two is the newest overall, so
            --     the ORDER BY ... LIMIT 1 still picks exactly the row the disjunction picked.
            --   * fp.storage_path IS NULL gates the whole fallback on the explicit arm having
            --     resolved, reproducing the COALESCE below for EVERY nullability case -- including
            --     a hypothetical fp row with a NULL storage_path, which still falls through to fb.
            --     Deliberately NOT fp.id IS NULL: that is equivalent only while photos.storage_path
            --     stays NOT NULL, i.e. it would silently couple this query to a column constraint.
            --     Postgres compiles it to a One-Time Filter, so the fallback runs only for the
            --     plantings that actually need it (19 of 259 live).
            -- Event-inclusive membership is preserved by the second arm and is still load-bearing
            -- (123 live heroes) -- see the by-id rationale above before touching either arm.
            LEFT JOIN LATERAL (
                   SELECT x.id, x.storage_path
                     FROM (
                            ( SELECT ph.id, ph.storage_path, ph.created_at
                                FROM photos ph
                               WHERE fp.storage_path IS NULL
                                 AND ph.plant_id = p.id
                                 AND ph.deleted_at IS NULL
                                 AND ph.created_by = ANY(${householdIds})
                               ORDER BY ph.created_at DESC, ph.id DESC
                               LIMIT 1 )
                            UNION ALL
                            ( SELECT ph.id, ph.storage_path, ph.created_at
                                FROM photos ph
                                JOIN public.event_log e ON e.id = ph.event_id
                               WHERE fp.storage_path IS NULL
                                 AND e.plant_id = p.id
                                 AND ph.deleted_at IS NULL
                                 AND ph.created_by = ANY(${householdIds})
                               ORDER BY ph.created_at DESC, ph.id DESC
                               LIMIT 1 )
                          ) x
                    ORDER BY x.created_at DESC, x.id DESC
                    LIMIT 1
                 ) fb ON TRUE
            -- V4-SOFTDEL-001 F4 container-deleted gate (rationale at the seen_event INSERT above).
            -- This is the Plants page list — the surface where a planting stranded under a
            -- soft-deleted container would have stayed visible.
            WHERE (( pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL )
                   OR (p.container_id IS NULL AND p.created_by = ANY(${householdIds})))
              AND p.deleted_at IS NULL
              AND p.archived_at IS NULL
            ORDER BY p.created_at DESC
            LIMIT 5000
          `;
      // Sign each featured photo's S3 URL (900s) plus its thumbs/ companion, strip the raw
      // storage_path. See featuredPhotoUrls for why the thumb is additive and why it is a hint.
      const enriched = await Promise.all(rows.map(async (row) => {
        const photoUrls = await featuredPhotoUrls(row.featured_photo_storage_path);
        const { featured_photo_storage_path: _ignore, ...rest } = row;
        return { ...rest, ...photoUrls };
      }));
      return resp(200, enriched);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name) return resp(400, { error: 'name is required' });
      // V3-CAPTURE-001: project_id is now OPTIONAL (DB container_id is nullable). Photo-first
      // capture can create a project-less planting; V4 tagging will group/re-home it later.
      // Existing callers still pass project_id, so their behavior is unchanged.

      // V1.2a-4 S1 (PROJ-RESCOPE): server-side enum validation. NULL allowed.
      // V4-LOSSEVENT-001 widened this to seven — the SCHEMA-FIRST deploy ordering and the whole
      // rationale are on the PUT path above; this is its textual twin and both move together.
      const ALLOWED_LOSS = ['pest', 'disease', 'weather', 'transplant_shock', 'unknown', 'animal_damage', 'culled'];
      // V4-SOURCEFREE-001: source_type is free-text — no server allowlist (see PUT path).
      // BUG-DIVERGENCEVOCAB-001: must stay set-equal to plants_divergence_type_check. Rationale and
      // canonical source on the PUT path above; the drift guard asserts both copies match the
      // migration, so editing one without the other reds CI.
      const ALLOWED_DIVERGENCE = ['division', 'cutting', 'saved_seed_from'];
      const ALLOWED_CONTAINER = ['fabric_bag','plastic_pot','terracotta','ceramic','raised_bed','in_ground','tray_cell','hanging_basket','window_box','trough','whiskey_barrel','soil_block','solo_cup','other'];
      if (body.loss_cause != null && !ALLOWED_LOSS.includes(body.loss_cause)) {
        return resp(400, { error: `loss_cause must be one of ${ALLOWED_LOSS.join(', ')} or null` });
      }
      if (body.divergence_type != null && !ALLOWED_DIVERGENCE.includes(body.divergence_type)) {
        return resp(400, { error: `divergence_type must be one of ${ALLOWED_DIVERGENCE.join(', ')} or null` });
      }
      if (body.container_type != null && !ALLOWED_CONTAINER.includes(body.container_type)) {
        return resp(400, { error: `container_type must be one of ${ALLOWED_CONTAINER.join(', ')} or null` });
      }
      // V4-ACQMATURE-001. Strict boolean-or-null, shared with the PUT path via validate.js so the
      // two verbs cannot drift. An omitted key and an explicit null are both "never asked" on a
      // create — there is no prior row for a sentinel to preserve here, so unlike the PUT this path
      // needs no hasOwnProperty distinction.
      const _amErrPost = validateAcquiredMature(body);
      if (_amErrPost) return resp(400, { error: _amErrPost });
      // V4-LOSSEVENT-001 — same floor as the PUT path, same validator, so the two verbs cannot
      // drift. The INSERT below binds `body.qty_lost ?? 0`, which passes a negative through
      // untouched; qty-lost-guard.test.js asserts BOTH call sites exist.
      const _qlErrPost = validateQtyLost(body);
      if (_qlErrPost) return resp(400, { error: _qlErrPost });

      // ── AUTHZ: body-supplied PARENT ids (BUG-PARENTOWN-001, 5th instance of the pattern) ────────
      // Until now POST stored project_id / location_id / parent_plant_id / source_inventory_item_id /
      // succession_group_id exactly as sent. Every one has a DB foreign key, and a foreign key proves
      // the referenced row EXISTS — never that the caller OWNS it. So an authenticated non-member
      // could create a planting INSIDE another household's container (the very row the by-id
      // predicate's `project_id IS NULL` conjunct exists to keep unreachable — see the long comment
      // on the PUT path, which named this POST gap explicitly), or hang it off their location /
      // lineage parent and read the parent's fields back through the by-id GET's unscoped
      // `LEFT JOIN parent` (parent_plant_name, parent_project_id).
      //
      // PUT has gated location_id / parent_plant_id / source_inventory_item_id since
      // V4-AUTHZSWEEP-001; POST never did. Same loaders, same generic 400s, no existence oracle —
      // one pattern for both verbs. Runs BEFORE the INSERT so a rejected write leaves no row.
      //
      // NARROWING, measured read-only against live prod 2026-08-04 before shipping: of the 269 live
      // plantings, 269/269 project_id, 268/268 location_id, 41/41 source_inventory_item_id, 1/1
      // parent_plant_id and 203/203 succession_group_id still pass for a household member; all five
      // go to 0 for an authenticated non-member. No legitimate caller loses a write.
      //
      // NOT gated: variety_id (plant_varieties is a GLOBAL catalogue, unscoped in tags/index.js
      // entityExists('cultivar') too) and featured_photo_id / featured_image_id (not in the INSERT
      // column list below — unsettable on this verb).
      if (body.project_id != null) {
        if (!await loadOwnedProject(sql, body.project_id, householdIds)) {
          warnRejectedFk(userId, 'plants', 'project_id', body.project_id);
          return resp(400, { error: 'project_id does not match a project you can use' });
        }
      }
      if (body.location_id != null) {
        if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
          warnRejectedFk(userId, 'plants', 'location_id', body.location_id);
          return resp(400, { error: 'location_id does not match a location you can use' });
        }
      }
      if (body.parent_plant_id != null) {
        if (!await loadOwnedPlantingRef(sql, body.parent_plant_id, householdIds)) {
          warnRejectedFk(userId, 'plants', 'parent_plant_id', body.parent_plant_id);
          return resp(400, { error: 'parent_plant_id does not match a planting you can use' });
        }
      }
      if (body.source_inventory_item_id != null) {
        if (!await loadOwnedInventoryItem(sql, body.source_inventory_item_id, householdIds)) {
          warnRejectedFk(userId, 'plants', 'source_inventory_item_id', body.source_inventory_item_id);
          return resp(400, { error: 'source_inventory_item_id does not match an inventory item you can use' });
        }
      }
      if (body.succession_group_id != null) {
        if (!await loadOwnedPlantingRef(sql, body.succession_group_id, householdIds)) {
          warnRejectedFk(userId, 'plants', 'succession_group_id', body.succession_group_id);
          return resp(400, { error: 'succession_group_id does not match a planting you can use' });
        }
      }

      const qty = parseInt(body.quantity, 10);
      const qtyVal = isNaN(qty) || qty < 1 ? 1 : qty;
      // qty_initial defaults to quantity (per V102 §5.1 #4 + B.2 frontend default).
      const qtyInitialRaw = parseInt(body.qty_initial, 10);
      const qtyInitial = isNaN(qtyInitialRaw) || qtyInitialRaw < 1 ? qtyVal : qtyInitialRaw;

      const inserted = await sql`
        INSERT INTO public.garden_node
          (container_id, display_name, quantity, status, notes, created_by,
           cultivar_id, source_inventory_item_id, metadata,
           sown_at, sown_at_approx, germinated_at, germinated_at_approx,
           transplanted_at, transplanted_at_approx, planted_out_at, planted_out_at_approx,
           qty_initial, qty_current, qty_harvested, qty_lost, loss_cause,
           seeds_sown, seeds_germinated,
           source_type, source_ref, source_generation,
           parent_plant_id, divergence_type, lineage_note,
           succession_group_id, succession_order,
           container_type, container_size, location_id,
           acquired_mature, acquired_mature_source, acquired_mature_set_at)
        VALUES (
          ${body.project_id},
          ${body.name},
          ${qtyVal},
          ${body.status ?? null},
          ${body.notes ?? null},
          ${userId},
          ${body.variety_id ?? null},
          ${body.source_inventory_item_id ?? null},
          ${body.metadata ?? null},
          ${body.sown_at ?? null},
          -- BUG-SOWNAPPROXORPHAN-001, the create half. Same invariant as the PUT above: an
          -- X_approx qualifier with no X to qualify has no referent. PlantingEditor sends
          -- !!form.sown_at_approx unconditionally, so a create with the checkbox ticked and the
          -- date box empty writes the orphan directly. Computed in JS rather than as a SQL CASE
          -- because there is no prior row to consult here — the body IS the whole truth.
          ${approxOrNull(body.sown_at, body.sown_at_approx)},
          ${body.germinated_at ?? null},
          ${approxOrNull(body.germinated_at, body.germinated_at_approx)},
          ${body.transplanted_at ?? null},
          ${approxOrNull(body.transplanted_at, body.transplanted_at_approx)},
          ${body.planted_out_at ?? null},
          ${approxOrNull(body.planted_out_at, body.planted_out_at_approx)},
          ${qtyInitial},
          ${body.qty_current ?? null},
          ${body.qty_harvested ?? 0},
          ${body.qty_lost ?? 0},
          ${body.loss_cause ?? null},
          // V4-SEEDGERMRATE-001 (BD-057). seeds_sown arrives at CREATE because that is the sow —
          // Dave: "I will put in seed count sown". seeds_germinated is almost always null here and
          // filled in later ("later record germinations"), but it is accepted on create anyway so a
          // planting logged retrospectively can carry both in one write.
          // No `?? 0` default on either, unlike qty_harvested/qty_lost above: a NULL means "not
          // counted" and a 0 means "none came up", and those are different answers. Defaulting
          // would file every planting ever created as a total germination failure.
          ${body.seeds_sown ?? null},
          ${body.seeds_germinated ?? null},
          ${body.source_type ?? null},
          ${body.source_ref ?? null},
          ${body.source_generation ?? null},
          ${body.parent_plant_id ?? null},
          ${body.divergence_type ?? null},
          ${body.lineage_note ?? null},
          ${body.succession_group_id ?? null},
          ${body.succession_order ?? null},
          ${body.container_type ?? null},
          ${body.container_size ?? null},
          ${body.location_id ?? null},
          -- V4-ACQMATURE-001. Provenance and stamp are DERIVED from the verdict rather than read
          -- from the body — same rule as the PUT, same reason: a client that could name its own
          -- acquired_mature_source could write 'backfill' and make a guess indistinguishable from
          -- Dave's word. A create that says nothing leaves all three NULL, which is "never asked",
          -- not "no". The ::boolean cast is required because this param is compared to NULL in a
          -- bare expression rather than against a typed sibling column.
          ${body.acquired_mature ?? null},
          CASE WHEN ${body.acquired_mature ?? null}::boolean IS NULL THEN NULL ELSE 'user' END,
          CASE WHEN ${body.acquired_mature ?? null}::boolean IS NULL THEN NULL ELSE now() END
        )
        RETURNING id, container_id AS project_id, display_name AS name, quantity, notes, status, planted_at, created_by, created_at, updated_at, deleted_at, location_id, featured_image_id, cultivar_id AS variety_id, source_inventory_item_id, metadata, featured_photo_id, sown_at, germinated_at, transplanted_at, planted_out_at, sown_at_approx, germinated_at_approx, transplanted_at_approx, planted_out_at_approx, qty_initial, qty_current, qty_harvested, qty_lost, loss_cause, seeds_sown, seeds_germinated, source_type, source_ref, source_generation, parent_plant_id, divergence_type, lineage_note, succession_group_id, succession_order, container_type, container_size, acquired_mature, acquired_mature_source, acquired_mature_set_at, kind, workspace_id, last_seen_at, attr_override, version
      `;
      const newPlant = inserted[0];

      // V4-ANCHORBASE-001 — THE DERIVATION MAINTAINER, create-path half.
      //
      // The backfill (migrations/v4-anchorbase-001/0b-backfill.sql) ran once, on 2026-08-12, and
      // nothing has derived an anchor since — so a planting created after that date and carrying no
      // sown_at / transplanted_at / planted_out_at got no derived row at all and stayed invisible to
      // the harvest watch band. Verified read-only against live prod 2026-08-16: two of the three
      // anchorless plantings created since the backfill hold no derivation, and both are
      // PROJECT-LESS, which 0b's INNER JOIN to plant_projects would not have rescued either.
      // ./anchorCreate.js carries the tier reasoning, the ownership divergence and the clamp note.
      //
      // AFTER the INSERT and OUTSIDE any transaction, in a try/catch that logs and continues —
      // exactly the posture of the PUT path's weight-sample re-attribution hook below. This is a
      // satellite table holding an INFERRED value; losing a derivation costs one planting its place
      // in a watch band until a re-derivation pass, whereas failing the POST loses Dave the planting
      // he just entered. The nightly sweep in lambda/daily-plan is the backstop, so the failure is
      // recoverable by construction. NOTE the asymmetry with the PUT's retire, which IS in-transaction
      // and must be: a retire that fails leaves a guess standing beside a real date (the marking-rule
      // violation gates.yml asserts continuously), while a derive that fails leaves nothing at all.
      //
      // Placed before the succession self-reference UPDATE below rather than after it because that
      // UPDATE has its own early return, and only touches succession_group_id — a column this
      // derivation neither reads nor depends on. Sitting here it runs on exactly one path instead of
      // being duplicated across two.
      try {
        await deriveAnchorOnCreate(sql, newPlant.id);
      } catch (e) {
        console.warn('[anchorbase] create-path anchor derivation failed (planting saved):', e?.message);
      }

      // V1.2a-4 S1 (P3 / V102 §4.1 head-of-chain convention LOCKED): if caller
      // did not supply succession_group_id AND no parent_plant_id is set, this is
      // the head of a new succession chain — set succession_group_id = self.id.
      // Postgres cannot DEFAULT a self-reference; canonical pattern is INSERT then
      // UPDATE WHERE succession_group_id IS NULL.
      if (body.succession_group_id == null && body.parent_plant_id == null) {
        const updated = await sql`
          UPDATE public.garden_node
          SET succession_group_id = id
          WHERE id = ${newPlant.id}
            AND succession_group_id IS NULL
          RETURNING id, container_id AS project_id, display_name AS name, quantity, notes, status, planted_at, created_by, created_at, updated_at, deleted_at, location_id, featured_image_id, cultivar_id AS variety_id, source_inventory_item_id, metadata, featured_photo_id, sown_at, germinated_at, transplanted_at, planted_out_at, sown_at_approx, germinated_at_approx, transplanted_at_approx, planted_out_at_approx, qty_initial, qty_current, qty_harvested, qty_lost, loss_cause, seeds_sown, seeds_germinated, source_type, source_ref, source_generation, parent_plant_id, divergence_type, lineage_note, succession_group_id, succession_order, container_type, container_size, acquired_mature, acquired_mature_source, acquired_mature_set_at, kind, workspace_id, last_seen_at, attr_override, version
        `;
        if (updated.length) return resp(201, updated[0]);
      }
      return resp(201, newPlant);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('plants lambda error', err);
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};

