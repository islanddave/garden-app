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
import { householdScope } from './household.js';
import { resolvePhotoViewUrl } from './photo-access.js';
import { isStatusChange, formatStatusChangeNote, buildStatusChangeMetadata, STATUS_CHANGE_EVENT_TYPE } from './statusEvents.js';
import { reconcileNextWaterAt } from './waterVerdict.js';

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

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
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

  const sql = neon(secrets.NEON_DATABASE_URL);
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/plants';

  const idMatch = rawPath.match(/^\/api\/plants\/([^/]+)$/);
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

  try {
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
      const ins = await sql`
        INSERT INTO seen_event (leaf_id, seen_at, source)
        SELECT ln.id, COALESCE(${seenAt}::timestamptz, now()), ${source}
        FROM public.garden_node ln
        JOIN public.container pp ON pp.id = ln.container_id
        WHERE ln.id = ${plantId} AND ln.deleted_at IS NULL AND ln.archived_at IS NULL AND pp.created_by = ANY(${householdIds})
        RETURNING leaf_id
      `;
      if (!ins.length) return resp(404, { error: 'Not found' });
      // Read back the trigger-maintained last_seen_at (no `p` alias → regex-safe).
      const back = await sql`SELECT last_seen_at FROM public.garden_node WHERE id = ${plantId}`;
      return resp(201, { leaf_id: ins[0].leaf_id, last_seen_at: back[0]?.last_seen_at ?? null });
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
      const rows = await sql`
        UPDATE public.garden_node p
        SET archived_at = CASE WHEN ${archived} THEN NOW() ELSE NULL END
        FROM public.container pp
        WHERE p.id = ${plantId}
          AND p.container_id = pp.id
          AND pp.created_by = ANY(${householdIds})
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
                 p.featured_photo_id, fp.storage_path AS featured_photo_storage_path,
                 p.created_at, p.updated_at,
                 p.sown_at, p.sown_at_approx,
                 p.germinated_at, p.germinated_at_approx,
                 p.transplanted_at, p.transplanted_at_approx,
                 p.planted_out_at, p.planted_out_at_approx,
                 p.qty_initial, p.qty_current, p.qty_harvested, p.qty_lost, p.loss_cause,
                 p.source_type, p.source_ref, p.source_generation,
                 p.parent_plant_id, p.divergence_type, p.lineage_note,
                 p.succession_group_id, p.succession_order, p.assignee_user_id,
                 p.container_type, p.container_size, p.location_id,
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
                     'photo_id', pv.photo_id, 'source_url', pv.source_url, 'scoville_min', pv.scoville_min, 'scoville_max', pv.scoville_max, 'growth_habit', pv.growth_habit, 'lifecycle', pv.lifecycle
                   )
                 ELSE NULL END AS variety_ref,
                 parent.display_name AS parent_plant_name, parent.container_id AS parent_project_id,
                 em.next_water_at, em.location_type, em.watering_interval_days, em.last_watered_at
          FROM public.garden_node p
          JOIN public.container pp ON pp.id = p.container_id
          LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id AND pv.deleted_at IS NULL
          LEFT JOIN photos fp ON fp.id = p.featured_photo_id
          LEFT JOIN public.garden_node parent ON parent.id = p.parent_plant_id AND parent.deleted_at IS NULL
          LEFT JOIN entity_memory em ON em.project_id = pp.id
          WHERE p.id = ${plantId}
            AND p.deleted_at IS NULL
            AND pp.created_by = ANY(${householdIds})
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

        const featured_photo_view_url = await resolvePhotoViewUrl(row.featured_photo_storage_path, { presign: getFeaturedPhotoViewUrl, sm });
        const { featured_photo_storage_path: _ignore, ...rest } = row;
        return resp(200, { ...rest, featured_photo_view_url });
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');

        // V1.2a-4 S1 (PROJ-RESCOPE): server-side enum validation for the new
        // lifecycle/source/lineage fields. Mirrors DB CHECK constraints; NULL allowed.
        const ALLOWED_LOSS = ['pest', 'disease', 'weather', 'transplant_shock', 'unknown'];
        // V4-SOURCEFREE-001: source_type is free-text (like event_type). No server allowlist; DB CHECK dropped. UI dropdownRegistry is the single source of truth.
        const ALLOWED_DIVERGENCE = ['mutation', 'cross', 'selection', 'unknown'];
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
               AND (ph.plant_id = ${plantId} OR e.plant_id = ${plantId})
          `;
          if (!linkRows.length) {
            return resp(400, { error: 'featured_photo_id must be a photo linked to this plant' });
          }
        }

        const cur = await sql`
          SELECT gn.status AS old_status, gn.container_id AS proj_id
          FROM public.garden_node gn
          JOIN public.container pp ON pp.id = gn.container_id
          WHERE gn.id = ${plantId}
            AND pp.created_by = ANY(${householdIds})
            AND gn.deleted_at IS NULL
        `;
        if (!cur.length) return resp(404, { error: 'Not found' });
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
            notes                    = COALESCE(${body.notes ?? null}, p.notes),
            cultivar_id              = CASE
              WHEN ${hasVariety} THEN ${body.variety_id ?? null}
              ELSE p.cultivar_id
            END,
            source_inventory_item_id = COALESCE(${body.source_inventory_item_id ?? null}, p.source_inventory_item_id),
            metadata                 = COALESCE(${body.metadata ?? null}, p.metadata),
            featured_photo_id        = CASE
              WHEN ${hasFeatured} THEN ${body.featured_photo_id ?? null}
              ELSE p.featured_photo_id
            END,
            -- V1.2a-4 S1 (PROJ-RESCOPE / V102 §4.1): lifecycle / attrition / source / lineage / succession columns.
            sown_at                  = COALESCE(${body.sown_at ?? null}, p.sown_at),
            sown_at_approx           = COALESCE(${body.sown_at_approx ?? null}, p.sown_at_approx),
            germinated_at            = COALESCE(${body.germinated_at ?? null}, p.germinated_at),
            germinated_at_approx     = COALESCE(${body.germinated_at_approx ?? null}, p.germinated_at_approx),
            transplanted_at          = COALESCE(${body.transplanted_at ?? null}, p.transplanted_at),
            transplanted_at_approx   = COALESCE(${body.transplanted_at_approx ?? null}, p.transplanted_at_approx),
            planted_out_at           = COALESCE(${body.planted_out_at ?? null}, p.planted_out_at),
            planted_out_at_approx    = COALESCE(${body.planted_out_at_approx ?? null}, p.planted_out_at_approx),
            qty_initial              = COALESCE(${body.qty_initial ?? null}, p.qty_initial),
            qty_current              = COALESCE(${body.qty_current ?? null}, p.qty_current),
            qty_harvested            = COALESCE(${body.qty_harvested ?? null}, p.qty_harvested),
            qty_lost                 = COALESCE(${body.qty_lost ?? null}, p.qty_lost),
            loss_cause               = COALESCE(${body.loss_cause ?? null}, p.loss_cause),
            source_type              = COALESCE(${body.source_type ?? null}, p.source_type),
            source_ref               = COALESCE(${body.source_ref ?? null}, p.source_ref),
            source_generation        = COALESCE(${body.source_generation ?? null}, p.source_generation),
            parent_plant_id          = COALESCE(${body.parent_plant_id ?? null}, p.parent_plant_id),
            divergence_type          = COALESCE(${body.divergence_type ?? null}, p.divergence_type),
            lineage_note             = COALESCE(${body.lineage_note ?? null}, p.lineage_note),
            succession_group_id      = COALESCE(${body.succession_group_id ?? null}, p.succession_group_id),
            succession_order         = COALESCE(${body.succession_order ?? null}, p.succession_order),
            assignee_user_id         = CASE
              WHEN ${hasAssignee} THEN ${body.assignee_user_id ?? null}
              ELSE p.assignee_user_id
            END,
            container_type           = COALESCE(${body.container_type ?? null}, p.container_type),
            container_size           = COALESCE(${body.container_size ?? null}, p.container_size),
            location_id              = CASE
              WHEN ${hasLocation} THEN ${body.location_id ?? null}
              ELSE p.location_id
            END
          FROM public.container pp
          WHERE p.id = ${plantId}
            AND p.container_id = pp.id
            AND pp.created_by = ANY(${householdIds})
            AND p.deleted_at IS NULL
          RETURNING p.id, p.container_id AS project_id, p.display_name AS name, p.quantity, p.notes, p.status, p.planted_at, p.created_by, p.created_at, p.updated_at, p.deleted_at, p.location_id, p.featured_image_id, p.cultivar_id AS variety_id, p.source_inventory_item_id, p.metadata, p.featured_photo_id, p.sown_at, p.germinated_at, p.transplanted_at, p.planted_out_at, p.sown_at_approx, p.germinated_at_approx, p.transplanted_at_approx, p.planted_out_at_approx, p.qty_initial, p.qty_current, p.qty_harvested, p.qty_lost, p.loss_cause, p.source_type, p.source_ref, p.source_generation, p.parent_plant_id, p.divergence_type, p.lineage_note, p.succession_group_id, p.succession_order, p.assignee_user_id, p.container_type, p.container_size, p.kind, p.workspace_id, p.last_seen_at, p.attr_override, p.version
        `,
        ];
        if (_statusChanged) {
          const _note = formatStatusChangeNote(_oldStatus, _newStatus, 'plant');
          const _meta = buildStatusChangeMetadata(_oldStatus, _newStatus, 'plant');
          _stmts.push(sql`
            INSERT INTO event_log
              (project_id, plant_id, event_type, event_date, notes, metadata, logged_by, created_by)
            VALUES
              (${_projectId}, ${plantId}, ${STATUS_CHANGE_EVENT_TYPE}, NOW(), ${_note}, ${_meta}, ${userId}, ${userId})
          `);
          _stmts.push(sql`
            INSERT INTO entity_memory (project_id, last_event_at)
            VALUES (${_projectId}, NOW())
            ON CONFLICT (project_id) DO UPDATE SET
              last_event_at = GREATEST(COALESCE(entity_memory.last_event_at, NOW()), NOW()),
              updated_at = NOW()
          `);
        }
        const _txr = await sql.transaction(_stmts);
        const rows = _txr[1];
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        await sql`
          UPDATE public.garden_node p
          SET deleted_at = NOW()
          FROM public.container pp
          WHERE p.id = ${plantId}
            AND p.container_id = pp.id
            AND pp.created_by = ANY(${householdIds})
            AND p.deleted_at IS NULL
        `;
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
      const rows = projectId
        ? await sql`
            SELECT p.id, p.display_name AS name, p.quantity,
                   p.status, p.notes, p.container_id AS project_id,
                   p.cultivar_id AS variety_id, p.source_inventory_item_id, p.metadata,
                   p.featured_photo_id, fp.storage_path AS featured_photo_storage_path,
                   p.created_at,
                   p.sown_at, p.sown_at_approx,
                   p.germinated_at, p.germinated_at_approx,
                   p.transplanted_at, p.transplanted_at_approx,
                   p.planted_out_at, p.planted_out_at_approx,
                   p.qty_initial, p.qty_current, p.qty_harvested, p.qty_lost, p.loss_cause,
                   p.source_type, p.source_ref, p.source_generation,
                   p.parent_plant_id, p.divergence_type, p.lineage_note,
                   p.succession_group_id, p.succession_order, p.assignee_user_id,
                   p.container_type, p.container_size, p.location_id,
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
                       'photo_id', pv.photo_id, 'source_url', pv.source_url, 'scoville_min', pv.scoville_min, 'scoville_max', pv.scoville_max, 'growth_habit', pv.growth_habit, 'lifecycle', pv.lifecycle
                     )
                   ELSE NULL END AS variety_ref
            FROM public.garden_node p
            JOIN public.container pp ON pp.id = p.container_id
            LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id AND pv.deleted_at IS NULL
            LEFT JOIN photos fp ON fp.id = p.featured_photo_id
            WHERE pp.created_by = ANY(${householdIds})
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
                   p.featured_photo_id, fp.storage_path AS featured_photo_storage_path,
                   p.created_at,
                   p.sown_at, p.sown_at_approx,
                   p.germinated_at, p.germinated_at_approx,
                   p.transplanted_at, p.transplanted_at_approx,
                   p.planted_out_at, p.planted_out_at_approx,
                   p.qty_initial, p.qty_current, p.qty_harvested, p.qty_lost, p.loss_cause,
                   p.source_type, p.source_ref, p.source_generation,
                   p.parent_plant_id, p.divergence_type, p.lineage_note,
                   p.succession_group_id, p.succession_order, p.assignee_user_id,
                   p.container_type, p.container_size, p.location_id,
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
                       'photo_id', pv.photo_id, 'source_url', pv.source_url, 'scoville_min', pv.scoville_min, 'scoville_max', pv.scoville_max, 'growth_habit', pv.growth_habit, 'lifecycle', pv.lifecycle
                     )
                   ELSE NULL END AS variety_ref
            FROM public.garden_node p
            JOIN public.container pp ON pp.id = p.container_id
            LEFT JOIN public.cultivar pv ON pv.id = p.cultivar_id AND pv.deleted_at IS NULL
            LEFT JOIN photos fp ON fp.id = p.featured_photo_id
            WHERE pp.created_by = ANY(${householdIds})
              AND p.deleted_at IS NULL
              AND p.archived_at IS NULL
            ORDER BY p.created_at DESC
            LIMIT 5000
          `;
      // Sign each featured photo's S3 URL (900s), strip the raw storage_path.
      const enriched = await Promise.all(rows.map(async (row) => {
        const featured_photo_view_url = await resolvePhotoViewUrl(row.featured_photo_storage_path, { presign: getFeaturedPhotoViewUrl, sm });
        const { featured_photo_storage_path: _ignore, ...rest } = row;
        return { ...rest, featured_photo_view_url };
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
      const ALLOWED_LOSS = ['pest', 'disease', 'weather', 'transplant_shock', 'unknown'];
      // V4-SOURCEFREE-001: source_type is free-text — no server allowlist (see PUT path).
      const ALLOWED_DIVERGENCE = ['mutation', 'cross', 'selection', 'unknown'];
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
           source_type, source_ref, source_generation,
           parent_plant_id, divergence_type, lineage_note,
           succession_group_id, succession_order,
           container_type, container_size, location_id)
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
          ${body.sown_at_approx ?? false},
          ${body.germinated_at ?? null},
          ${body.germinated_at_approx ?? false},
          ${body.transplanted_at ?? null},
          ${body.transplanted_at_approx ?? false},
          ${body.planted_out_at ?? null},
          ${body.planted_out_at_approx ?? false},
          ${qtyInitial},
          ${body.qty_current ?? null},
          ${body.qty_harvested ?? 0},
          ${body.qty_lost ?? 0},
          ${body.loss_cause ?? null},
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
          ${body.location_id ?? null}
        )
        RETURNING id, container_id AS project_id, display_name AS name, quantity, notes, status, planted_at, created_by, created_at, updated_at, deleted_at, location_id, featured_image_id, cultivar_id AS variety_id, source_inventory_item_id, metadata, featured_photo_id, sown_at, germinated_at, transplanted_at, planted_out_at, sown_at_approx, germinated_at_approx, transplanted_at_approx, planted_out_at_approx, qty_initial, qty_current, qty_harvested, qty_lost, loss_cause, source_type, source_ref, source_generation, parent_plant_id, divergence_type, lineage_note, succession_group_id, succession_order, container_type, container_size, kind, workspace_id, last_seen_at, attr_override, version
      `;
      const newPlant = inserted[0];

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
          RETURNING id, container_id AS project_id, display_name AS name, quantity, notes, status, planted_at, created_by, created_at, updated_at, deleted_at, location_id, featured_image_id, cultivar_id AS variety_id, source_inventory_item_id, metadata, featured_photo_id, sown_at, germinated_at, transplanted_at, planted_out_at, sown_at_approx, germinated_at_approx, transplanted_at_approx, planted_out_at_approx, qty_initial, qty_current, qty_harvested, qty_lost, loss_cause, source_type, source_ref, source_generation, parent_plant_id, divergence_type, lineage_note, succession_group_id, succession_order, container_type, container_size, kind, workspace_id, last_seen_at, attr_override, version
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

