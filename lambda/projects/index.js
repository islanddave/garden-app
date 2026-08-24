import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope, loadOwnedLocation, warnRejectedFk } from './household.js';
import { loadOwnedProject } from './authz-parents.js';
import { resolvePhotoViewUrl } from './photo-access.js';
import { isStatusChange, formatStatusChangeNote, buildStatusChangeMetadata, STATUS_CHANGE_EVENT_TYPE } from './statusEvents.js';
import { validateClear } from './validate.js';

// V4-EVENTSOURCE-001 — event_log.source value written by THIS Lambda. lambda/events/index.js
// declares 'app'/'app_batch' and explicitly delegates 'app_status' here; the full value set and
// why 'direct' is reserved-but-never-inferred live in
// migrations/v4-eventsource-001/0a-additive-ddl.sql. The column carries a NOT VALID CHECK, so an
// unlisted value 23514s on write. 0a is applied to prod AND staging, so including the column in
// the INSERT below cannot 42703.
const EVENT_SOURCE_STATUS = 'app_status';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
// S3 client for featured-photo view URL enrichment.
// Matches lambda/photos checksum hardening (3.679+ presign-URL incompatibility).
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

function resp(statusCode, body, extra = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
    body: JSON.stringify(body),
  };
}

// V3-REPARENT-001: native reparent core. One atomic CTE (a single neon request = one txn):
// pre-move snapshot -> reparent_event (op_id-deduped) -> version-guarded parent UPDATE.
// The base-table trigger container_reparent_after fires on the parent_project_id change,
// running in-txn acyclicity (RAISE on cycle -> the whole statement aborts) + closure
// maintenance. (container is an auto-updatable view over plant_projects; we write the base.)
export async function reparentCore(sql, { subjectId, newParentId, opId, expectedVersion, userId, householdIds }) {
  // 1. Idempotent replay: this op_id already recorded -> return the prior outcome, no re-move.
  const prior = await sql`
    SELECT subject_id, new_parent_id, moved_at FROM reparent_event WHERE op_id = ${opId}
  `;
  if (prior.length) {
    return { status: 200, body: { id: prior[0].subject_id, parent_project_id: prior[0].new_parent_id, moved_at: prior[0].moved_at, replayed: true } };
  }
  // 2. Load the target (household-scoped, live).
  const tgt = await sql`
    SELECT /* reparent-internal */ id, parent_project_id AS old_parent, version
    FROM plant_projects
    WHERE id = ${subjectId} AND deleted_at IS NULL AND created_by = ANY(${householdIds})
  `;
  if (!tgt.length) return { status: 404, body: { error: 'Project not found' } };
  if (newParentId === subjectId) return { status: 400, body: { error: 'A project cannot be its own parent' } };
  if (tgt[0].version !== expectedVersion) {
    return { status: 409, body: { error: 'Version conflict — reload and retry', current_version: tgt[0].version } };
  }
  // 3. Validate the new parent (FK is a backstop; this enforces household + not-deleted for clean UX).
  if (newParentId != null) {
    const p = await sql`
      SELECT /* reparent-internal */ id FROM plant_projects
      WHERE id = ${newParentId} AND deleted_at IS NULL AND created_by = ANY(${householdIds})
    `;
    if (!p.length) return { status: 422, body: { error: 'New parent not found in your garden' } };
  }
  // 4. Atomic move: snapshot + event + version-guarded update in one statement.
  try {
    const rows = await sql`
      WITH tgt AS (
        SELECT /* reparent-internal */ id, parent_project_id AS old_parent, version, workspace_id,
               jsonb_build_object(
                 'parent_project_id', parent_project_id,
                 'version', version,
                 'name', name,
                 'status', status,
                 'snapshot_at', NOW()
               ) AS snap
        FROM plant_projects
        WHERE id = ${subjectId} AND deleted_at IS NULL
          AND created_by = ANY(${householdIds})
          AND version = ${expectedVersion}
      ),
      ev AS (
        INSERT INTO reparent_event
          (subject, subject_id, old_parent_id, new_parent_id, snapshot, op_id, moved_by, workspace_id)
        SELECT 'container'::node_class, t.id, t.old_parent, ${newParentId}, t.snap, ${opId}, ${userId}, t.workspace_id
        FROM tgt t
        RETURNING subject_id, old_parent_id
      ),
      upd AS (
        UPDATE plant_projects
        SET parent_project_id = ${newParentId}, version = version + 1, updated_at = NOW()
        WHERE id = (SELECT subject_id FROM ev)
        RETURNING id, version, parent_project_id
      )
      SELECT u.id, u.version, u.parent_project_id, e.old_parent_id
      FROM upd u JOIN ev e ON e.subject_id = u.id
    `;
    if (!rows.length) {
      const cur = await sql`SELECT /* reparent-internal */ version FROM plant_projects WHERE id = ${subjectId}`;
      return { status: 409, body: { error: 'Version conflict — reload and retry', current_version: cur[0]?.version } };
    }
    return { status: 200, body: { id: rows[0].id, parent_project_id: rows[0].parent_project_id, version: rows[0].version, old_parent_id: rows[0].old_parent_id } };
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (/cycle/i.test(msg)) return { status: 422, body: { error: 'Move would create a cycle (target is a descendant of itself)' } };
    if (/reparent_op_uniq|duplicate key/i.test(msg)) {
      const r = await sql`SELECT subject_id, new_parent_id, moved_at FROM reparent_event WHERE op_id = ${opId}`;
      if (r.length) return { status: 200, body: { id: r[0].subject_id, parent_project_id: r[0].new_parent_id, moved_at: r[0].moved_at, replayed: true } };
    }
    if (/foreign key|fkey/i.test(msg)) return { status: 422, body: { error: 'New parent does not exist' } };
    throw err;
  }
}

// WS-A1: public project share route target. `/garden/:slug` is an UNAUTHENTICATED surface, so
// this runs BEFORE verifyToken in the handler (early return). TWO independent boundaries guard it:
//
//   (1) ROW GATE — is_public on both the project and its events. ADDED 2026-08-24, reversing the
//       earlier "post-PUBHIDE: no is_public gate, per Dave's locked decision". Reversed by Dave
//       ("add the filter and keep the route") after an audit found this route serving is_public=false
//       projects, with notes, to anyone who guesses a slug. CAVEAT for whoever reads this next:
//       V4-PUBHIDE-001 removed the is_public toggle from every create/edit form and defaults it
//       true server-side, so this gate hides the 5 projects historically marked private and gives
//       NO ongoing control — there is no UI to unpublish. A `published_at` column (default NULL) is
//       the intended durable axis; until it ships, do not read this gate as user-facing curation.
//   (2) COLUMN GATE — the deny-by-default projection below. The response object is built
//       key-by-key and a DB row is NEVER spread, so a newly-added or sensitive column can't leak.
//
// The two are deliberately independent: a row that passes (1) still cannot leak a column that (2)
// omits, and each is tested separately so neither can mask a regression in the other.
// slug is globally unique (plant_projects_slug_key) and is a bound parameter (neon tagged-template),
// never string-interpolated.
async function handlePublicProject(slug, secrets) {
  try {
    const sql = neon(secrets.NEON_DATABASE_URL);
    // Location comes via a LEFT JOIN taking ONLY full_path; raw location_id is never returned.
    const rows = await sql`
      SELECT /* public-slug: deny-by-default allowlist */
             c.id,
             c.display_name,
             c.slug,
             c.status,
             c.species,
             c.variety,
             c.description,
             to_char(c.start_date, 'YYYY-MM-DD') AS start_date,
             lwp.full_path AS location_path
      FROM public.container c
      LEFT JOIN locations_with_path lwp
        ON lwp.id = c.location_id AND lwp.deleted_at IS NULL
      WHERE c.slug = ${slug}
        AND c.is_public IS TRUE
        AND c.deleted_at IS NULL
        AND c.archived_at IS NULL
      LIMIT 1
    `;
    if (!rows.length) return resp(404, { error: 'Not found' });
    const row = rows[0];

    // Public timeline: an explicit allowlist of event columns; every other event column is
    // omitted by default (deny-by-default), so nothing sensitive can leak into the response.
    const events = await sql`
      SELECT id, event_type, event_date, notes, quantity
      FROM event_log
      WHERE project_id = ${row.id}
        AND is_public IS TRUE
        AND deleted_at IS NULL
      ORDER BY event_date DESC
      LIMIT 200
    `;

    // Deny-by-default: build the public response object key-by-key. NEVER spread a DB row.
    return resp(200, {
      name: row.display_name,
      slug: row.slug,
      status: row.status,
      species: row.species,
      variety: row.variety,
      description: row.description,
      start_date: row.start_date,
      location_path: row.location_path ?? null,
      events: events.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        event_date: e.event_date,
        notes: e.notes,
        quantity: e.quantity,
      })),
    });
  } catch (err) {
    console.error('handlePublicProject error', err?.message ?? err);
    return resp(500, { error: 'Internal server error' });
  }
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  let secrets;
  try {
    secrets = await getSecrets();
    if (!secrets.CLERK_SECRET_KEY || !secrets.NEON_DATABASE_URL) {
      console.error('projects lambda: missing required secrets', Object.keys(secrets));
      return resp(500, { error: 'Internal server error' });
    }
  } catch (err) {
    console.error('projects lambda: secrets fetch failed', err);
    return resp(500, { error: 'Internal server error' });
  }

  // WS-A1: public project share route. Served BEFORE verifyToken so `/garden/:slug` renders
  // unauthenticated. Two-segment path (/public/:slug) — cannot collide with the one-segment
  // by-id idMatch (/api/projects/:id) below, which requires no interior slash. GET-only; any
  // other method to this path falls through to verifyToken (stays auth-gated).
  const publicMethod = event.requestContext?.http?.method ?? 'GET';
  const publicMatch = publicMethod === 'GET'
    ? (event.rawPath ?? '').match(/^\/api\/projects\/public\/([^/]+)$/)
    : null;
  if (publicMatch) {
    return await handlePublicProject(publicMatch[1], secrets);
  }

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

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/projects';
  const qs = event.queryStringParameters ?? {};

  // Must check /types routes before idMatch — otherwise 'types' is treated as a project UUID
  const typesItemMatch = rawPath.match(/^\/api\/projects\/types\/([^/]+)$/);
  const typesMatch = rawPath === '/api/projects/types';

  // /deleted is a single trailing segment, so idMatch would parse it as a project id — excluded
  // here for the same reason /types already is (see the comment above).
  const idMatch = rawPath !== '/api/projects/deleted'
    && rawPath.match(/^\/api\/projects\/([^/]+)$/);

  // V4-RESTORESURFACE-001: recovery path for containers. Extra segment, so idMatch can't catch it.
  const restoreMatch = rawPath.match(/^\/api\/projects\/([^/]+)\/restore$/);

  // V3-ARCHIVE-001: soft-archive toggle. Extra path segment, so idMatch above won't catch it.
  const archiveMatch = rawPath.match(/^\/api\/projects\/([^/]+)\/archive$/);

  // V3-REPARENT-001: native reparent + restore. Extra path segments (won't hit idMatch).
  const reparentMatch = rawPath.match(/^\/api\/projects\/([^/]+)\/reparent$/);
  const reparentRestoreMatch = rawPath.match(/^\/api\/projects\/([^/]+)\/reparent\/restore$/);

  try {
    const sql = neon(secrets.NEON_DATABASE_URL);
    // HOUSEHOLD-MODE: widened at V3-ROLES teardown
    const householdIds = householdScope(userId);

    // --- /api/projects/types/:id ---
    if (typesItemMatch) {
      const typeId = typesItemMatch[1];
      if (method === 'DELETE') {
        // BUG-DELNOOPOK-001: RETURNING-gated, so a not-found / already-deleted / not-owned DELETE
        // 404s instead of reporting success. Collapsing those three into one status is deliberate
        // (distinguishing them leaks existence) and matches every sibling route.
        //
        // The predicate is `created_by = ${userId}`, NOT `= ANY(${householdIds})`, and that is
        // DELIBERATELY LEFT ALONE here: household-mode.test.js:60 pins it by name
        // ('project_types delete guard remains owner-only (out of scope)'). Widening it is a
        // separate authz decision, not a rider on a response-contract fix. The 404 does not make
        // it user-visible: ProjectTypes.jsx:147 only renders the Delete button when
        // `t.created_by === userId`, so a second household member has no path to this route for a
        // type they do not own. Revisit only together with that test.
        const rows = await sql`
          UPDATE project_types SET deleted_at = NOW()
          WHERE id = ${typeId} AND created_by = ${userId} AND deleted_at IS NULL
          RETURNING id
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }
      return resp(405, { error: 'Method not allowed' });
    }

    // --- /api/projects/types ---
    if (typesMatch) {
      if (method === 'GET') {
        const rows = await sql`
          SELECT id, name, category, description, icon, created_by
          FROM project_types
          WHERE deleted_at IS NULL
          ORDER BY category, name
        `;
        return resp(200, rows);
      }
      if (method === 'POST') {
        const body = JSON.parse(event.body ?? '{}');
        if (!body.name) return resp(400, { error: 'name is required' });
        const rows = await sql`
          INSERT INTO project_types (name, category, description, icon, created_by)
          VALUES (
            ${body.name},
            ${body.category ?? 'garden'},
            ${body.description ?? null},
            ${body.icon ?? '📋'},
            ${userId}
          )
          RETURNING *
        `;
        return resp(201, rows[0]);
      }
      return resp(405, { error: 'Method not allowed' });
    }

    // --- /api/projects/:id/archive (V3-ARCHIVE-001) ---
    if (archiveMatch) {
      const projectId = archiveMatch[1];
      if (method !== 'PATCH') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');
      const archived = body.archived !== false; // default true; {archived:false} un-archives
      // Decision 2: this is the REAL "Archive instead" target (sets archived_at = hides);
      // status='ended' stays an orthogonal lifecycle label, untouched here.
      const rows = await sql`
        UPDATE public.container
        SET archived_at = CASE WHEN ${archived} THEN NOW() ELSE NULL END
        WHERE id = ${projectId}
          AND created_by = ANY(${householdIds})
          AND deleted_at IS NULL
        RETURNING id, archived_at
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(200, rows[0]);
    }

    // --- /api/projects/:id/reparent/restore (V3-REPARENT-001) ---
    // Undo a prior move: re-point the subject to the old_parent_id captured in source_op_id's
    // reparent_event. The restore is itself a reparent (own op_id, own snapshot) — fully auditable.
    if (reparentRestoreMatch) {
      const subjectId = reparentRestoreMatch[1];
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');
      if (!body.op_id) return resp(400, { error: 'op_id is required (idempotency key)' });
      if (!body.source_op_id) return resp(400, { error: 'source_op_id is required (the move to undo)' });
      if (typeof body.expected_version !== 'number') return resp(400, { error: 'expected_version (number) is required' });
      const src = await sql`
        SELECT old_parent_id FROM reparent_event
        WHERE op_id = ${body.source_op_id} AND subject_id = ${subjectId}
      `;
      if (!src.length) return resp(404, { error: 'No reparent event found for source_op_id' });
      const out = await reparentCore(sql, {
        subjectId,
        newParentId: src[0].old_parent_id,
        opId: body.op_id,
        expectedVersion: body.expected_version,
        userId,
        householdIds,
      });
      return resp(out.status, out.body);
    }

    // --- /api/projects/:id/reparent (V3-REPARENT-001) ---
    if (reparentMatch) {
      const subjectId = reparentMatch[1];
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      const body = JSON.parse(event.body ?? '{}');
      if (!body.op_id) return resp(400, { error: 'op_id is required (idempotency key)' });
      if (typeof body.expected_version !== 'number') return resp(400, { error: 'expected_version (number) is required' });
      const newParentId = body.new_parent_id ?? null; // null = move to root
      const out = await reparentCore(sql, {
        subjectId,
        newParentId,
        opId: body.op_id,
        expectedVersion: body.expected_version,
        userId,
        householdIds,
      });
      return resp(out.status, out.body);
    }

    // --- /api/projects/:id ---
    // ── V4-RESTORESURFACE-001 — the recovery path for containers (audit I9) ────────────────────
    //
    // 12 containers are soft-deleted in prod with no way back — and restoring one is worth more
    // than its own row: 11 of the 33 soft-deleted PLANTINGS are invisible to the plants recovery
    // surface precisely because their container is deleted (the F4 gate). This route is the first
    // step of that two-step path, so it unblocks a third of the planting backlog as a side effect.
    if (rawPath === '/api/projects/deleted' && method === 'GET') {
      const rawLimit = Number(event?.queryStringParameters?.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
      // The planting counts are a SEPARATE query rather than a correlated subquery on purpose: a
      // subquery's own FROM truncates this block for select-columns.test.js's extractor, which
      // would silently exempt this read from the PROJ-RESCOPE column guard. A read that dodges a
      // guard by accident is worse than one that fails it.
      const rows = await sql`
        SELECT c.id, c.display_name AS name, c.slug, c.type AS kind,
               c.parent_id AS parent_project_id, c.target_end_date, c.kind_set_at,
               c.created_at, c.deleted_at
          FROM public.container c
         WHERE c.deleted_at IS NOT NULL
           AND c.created_by = ANY(${householdIds})
         ORDER BY c.deleted_at DESC, c.id DESC
         LIMIT ${limit}
      `;
      const ids = rows.map((r) => r.id);
      // Why the count matters: restoring a container is the FIRST step of a two-step recovery —
      // plantings under a deleted container are invisible to /api/plants/deleted until it is live.
      const counts = ids.length ? await sql`
        SELECT container_id, count(*)::int AS n
          FROM public.garden_node
         WHERE container_id = ANY(${ids}::uuid[]) AND deleted_at IS NOT NULL
         GROUP BY container_id
      ` : [];
      const byId = Object.fromEntries(counts.map((c) => [c.container_id, c.n]));
      return resp(200, {
        projects: rows.map((r) => ({ ...r, deleted_planting_count: byId[r.id] ?? 0 })),
      });
    }

    if (restoreMatch && method === 'POST') {
      const projectId = restoreMatch[1];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(projectId))) {
        return resp(404, { error: 'Not found' });
      }
      const [existing] = await sql`
        SELECT /* restore-probe */ id, deleted_at FROM public.container
         WHERE id = ${projectId} AND created_by = ANY(${householdIds})
      `;
      if (!existing) return resp(404, { error: 'Not found' });
      if (!existing.deleted_at) {
        return resp(200, { id: existing.id, deleted_at: null, already_restored: true });
      }
      // Restores the CONTAINER ONLY. Its plantings keep whatever deleted_at they carry: the DELETE
      // arm above never cascaded to them, so resurrecting them here would restore rows the user
      // never deleted at this level. They become visible in /api/plants/deleted once this row is
      // live, and are restored individually from there — the deliberate two-step.
      const rows = await sql`
        UPDATE public.container
           SET deleted_at = NULL
         WHERE id = ${projectId}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NOT NULL
        RETURNING id, display_name AS name, deleted_at
      `;
      if (!rows.length) return resp(404, { error: 'Not found' });
      return resp(200, rows[0]);
    }

    if (idMatch) {
      const projectId = idMatch[1];

      if (method === 'GET') {
        const [projectRows, plantCountRows, eventCountRows] = await Promise.all([
          sql`
            SELECT pp.id, pp.display_name AS name, pp.slug, pp.status, pp.variety, pp.description,
                   to_char(pp.start_date, 'YYYY-MM-DD') AS start_date,
                   pp.is_public, pp.location_id, pp.created_at, pp.updated_at, pp.created_by,
                   pp.parent_id AS parent_project_id, pp.version,
                   COALESCE(fp.id, fb.id) AS featured_photo_id,
                   (fp.id IS NOT NULL) AS featured_is_explicit,
                   pp.classification AS kind,
                   to_char(pp.target_end_date, 'YYYY-MM-DD') AS target_end_date,
                   pp.kind_set_at, pp.archived_at, pp.assignee_user_id,
                   p.display_name AS parent_project_name,
                   COALESCE(fp.storage_path, fb.storage_path) AS featured_photo_storage_path
            FROM public.container pp
            LEFT JOIN public.container p ON p.id = pp.parent_id AND p.deleted_at IS NULL
            -- BUG-PHOTOHEROMOVE-001 / INV-HERO — the hero is DERIVED here, never trusted from the
            -- stored pointer. Same shape as fetchSpaceHero (lambda/photos/index.js:~314); read its
            -- long-form rationale before touching this. Two predicates: the photo must be ALIVE,
            -- and it must STILL be a member of this project's gallery.
            --
            -- The membership arm is the one that bites today. Reassign ships (PhotoLibrary's tag
            -- modal, full-replace PUT): moving photo P from project A to B re-parents the row and
            -- leaves A.featured_photo_id = P. NOTHING IS DELETED, so no deleted_at filter can ever
            -- catch it — only re-checking membership can.
            --
            -- The predicate fp.project_id = pp.id is exactly the linkage the set-featured WRITE validator
            -- already enforces (~:540 below). Read half and write half of ONE invariant: diverging
            -- them manufactures the silent-revert bug fetchSpaceHero documents (the user re-picks
            -- the photo, the write accepts, the read demotes it again). Change one, change both.
            -- NOTE this is the project's OWN photos only — deliberately NOT the ?attachedTo union,
            -- which is planting-scoped and treats project_id as a container, not an attachment.
            LEFT JOIN photos fp
                   ON fp.id = pp.featured_photo_id
                  AND fp.deleted_at IS NULL
                  AND fp.created_by = ANY(${householdIds})
                  AND fp.project_id = pp.id
            LEFT JOIN LATERAL (
                   SELECT ph.id, ph.storage_path
                     FROM photos ph
                    WHERE ph.project_id = pp.id
                      AND ph.deleted_at IS NULL
                      AND ph.created_by = ANY(${householdIds})
                    ORDER BY ph.created_at DESC, ph.id DESC
                    LIMIT 1
                 ) fb ON TRUE
            WHERE pp.id = ${projectId}
              AND pp.created_by = ANY(${householdIds})
              AND pp.deleted_at IS NULL
          `,
          sql`
            SELECT COUNT(*)::int AS count
            FROM garden_node
            WHERE container_id = ${projectId}
              AND deleted_at IS NULL
              AND archived_at IS NULL
          `,
          sql`
            SELECT COUNT(*)::int AS count
            FROM event_log e
            WHERE e.project_id = ${projectId}
              AND e.deleted_at IS NULL
              -- M14 / V4-ARCHIVEHIDE-001 L1 PARITY. This count is what ProjectDetail's "Event log
              -- (N)" badge reads, and it must count the rows the LIST returns — not a different,
              -- larger set. The list (GET /api/events?project_id=…, the project-scoped branch of
              -- Route 4 in lambda/events/index.js) hides events whose planting is ARCHIVED; this
              -- COUNT did not, so it over-reported on every project holding an archived planting.
              -- Measured on prod before this line landed: 8 projects diverged — Peppers 5257 vs
              -- 4517, Tomatoes 3277 vs 3238, Lettuce 96 vs 57, Succulents & Cacti 60 vs 59, and
              -- four that the list empties completely (Loofah Sponge 67, Cilantro 32, Spinach 13,
              -- Lithops 1). On those four the badge would have read a count above a log correctly
              -- rendering "No events yet".
              --
              -- The predicate is COPIED from that branch and must stay identical to it, including
              -- the NOT EXISTS shape: a join would drop events with no planting anchor, which the
              -- list keeps. archived_at, never deleted_at — the two axes are orthogonal and
              -- lambda/plants' archive UPDATE deliberately keeps deleted_at NULL so unarchive
              -- stays recoverable.
              --
              -- NOT mirrored here: that branch's HIDE_EVENTS_UNDER_DELETED_PLANTING guard, which
              -- is a compile-time FALSE constant in lambda/events and therefore a no-op on both sides
              -- today. If it is ever switched on, this count diverges again and must follow it.
              AND NOT EXISTS (SELECT 1 FROM public.garden_node ga
                               WHERE ga.id = e.plant_id AND ga.archived_at IS NOT NULL)
          `,
        ]);
        if (!projectRows.length) return resp(404, { error: 'Not found' });
        const row = projectRows[0];
        const featured_photo_view_url = await resolvePhotoViewUrl(row.featured_photo_storage_path, { presign: getFeaturedPhotoViewUrl, sm });
        // Strip the join-only column from the response; expose only the signed URL.
        const { featured_photo_storage_path: _ignore, ...rest } = row;
        return resp(200, {
          ...rest,
          featured_photo_view_url,
          plant_count: plantCountRows[0].count,
          event_count: eventCountRows[0].count,
        });
      }

      // V1.2a-4 S6: admin classify route — PATCH /api/projects/:id
      // ADMIN_CLERK_SUBS env var allowlist (fail-closed). Transactional audit + UPDATE
      // via single CTE so audit row only commits when UPDATE matches a live row.
      // Per design proj-rescope-s6-design-V001-20260519.1625.md §5.1.
      if (method === 'PATCH') {
        const ADMIN_CLERK_SUBS = (process.env.ADMIN_CLERK_SUBS ?? '')
          .split(',').map(s => s.trim()).filter(Boolean);
        if (ADMIN_CLERK_SUBS.length === 0) {
          return resp(403, { error: 'Admin route not configured' });
        }
        if (!ADMIN_CLERK_SUBS.includes(userId)) {
          return resp(403, { error: 'Not authorized' });
        }

        const body = JSON.parse(event.body ?? '{}');
        const ALLOWED_KINDS = ['campaign', 'category', 'cultivar'];
        const hasKind = Object.prototype.hasOwnProperty.call(body, 'kind');
        if (hasKind && body.kind != null && !ALLOWED_KINDS.includes(body.kind)) {
          return resp(400, { error: `kind must be one of ${ALLOWED_KINDS.join(', ')} or null` });
        }
        const hasParent = Object.prototype.hasOwnProperty.call(body, 'parent_project_id');
        if (hasParent && body.parent_project_id === projectId) {
          return resp(400, { error: 'A project cannot be its own parent' });
        }
        if (!hasKind && !hasParent) {
          return resp(400, { error: 'PATCH body must include kind and/or parent_project_id' });
        }

        // Single CTE: audit INSERT pulls pre_state from plant_projects, UPDATE
        // changes it. If WHERE matches no row, both CTEs return empty → no
        // orphan audit. WHERE has no `created_by = userId` — admin overrides ownership.
        const rows = await sql`
          WITH pre AS (
            SELECT id, classification AS kind, parent_id AS parent_project_id, display_name AS name,
                   target_end_date, kind_set_at
            FROM public.container
            WHERE id = ${projectId} AND deleted_at IS NULL
          ),
          audit AS (
            INSERT INTO proj_rescope_events
              (project_id, action, pre_state, pre_state_schema_version, actor)
            SELECT id, 'admin_classify',
                   jsonb_build_object(
                     'kind', kind,
                     'parent_project_id', parent_project_id,
                     'name', name
                   ),
                   1, ${userId}
            FROM pre
            RETURNING project_id
          )
          UPDATE public.container
          SET
            classification = CASE WHEN ${hasKind} THEN ${body.kind ?? null} ELSE classification END,
            kind_set_at = CASE
              WHEN ${hasKind && body.kind != null} AND classification IS NULL THEN NOW()
              ELSE kind_set_at
            END,
            parent_id = CASE
              WHEN ${hasParent} THEN ${body.parent_project_id ?? null}
              ELSE parent_id
            END
          WHERE id = ${projectId} AND deleted_at IS NULL
            AND id IN (SELECT id FROM pre)
          RETURNING id, display_name AS name, slug, classification AS kind, kind_set_at, parent_id AS parent_project_id
        `;
        if (!rows.length) return resp(404, { error: 'Not found or soft-deleted' });
        return resp(200, rows[0]);
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        // Prevent self-reference
        if (body.parent_project_id && body.parent_project_id === projectId) {
          return resp(400, { error: 'A project cannot be its own parent' });
        }

        // V1.2a-4 S1 (PROJ-RESCOPE): validate kind enum server-side. Mirrors
        // the DB CHECK (kind IN ('campaign','category','cultivar') OR kind IS NULL).
        const ALLOWED_KINDS = ['campaign', 'category', 'cultivar'];
        const hasKind = Object.prototype.hasOwnProperty.call(body, 'kind');
        if (hasKind && body.kind != null && !ALLOWED_KINDS.includes(body.kind)) {
          return resp(400, { error: `kind must be one of ${ALLOWED_KINDS.join(', ')} or null` });
        }

        // V2-PHOTO-F1: strict validation for featured_photo_id.
        // If the field is present AND non-null, the photo must exist AND be
        // linked to this project via photos.project_id. Otherwise return 400.
        // Field-presence test (not truthy test) lets callers set it to null to clear.
        const hasFeatured = Object.prototype.hasOwnProperty.call(body, 'featured_photo_id');
        const hasAssignee = Object.prototype.hasOwnProperty.call(body, 'assignee_user_id');
        if (hasFeatured && body.featured_photo_id != null) {
          const linkRows = await sql`
            SELECT 1 FROM photos
             WHERE id = ${body.featured_photo_id}
               AND project_id = ${projectId}
               AND created_by = ANY(${householdIds})
               AND deleted_at IS NULL
          `;
          if (!linkRows.length) {
            return resp(400, { error: 'featured_photo_id must be a photo linked to this project' });
          }
        }

        // AUTHZ (V4-AUTHZSWEEP-001): the PUT can set location_id too, so it needs the same gate as
        // the create path — otherwise the edit path reopens exactly what the create path closes.
        if (body.location_id != null) {
          if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
            warnRejectedFk(userId, 'container', 'location_id', body.location_id);
            return resp(400, { error: 'location_id does not match a location you can use' });
          }
        }

        // AUTHZ (BUG-AUTHZFKENUM-001): parent_project_id is a cross-entity FK set straight from the
        // body, and this PUT was the ONE path that took it ungated — POST gates it inline against
        // container.created_by and reparentCore validates the new parent, so only the edit verb was
        // open. Cost was not merely a bad FK: the read surface at the top of this file LEFT JOINs
        // `public.container p ON p.id = pp.parent_id` with NO household predicate and selects
        // `p.display_name AS parent_project_name`, so an attacker who parented their own project to
        // a victim's container read that container's name back out of their own GET. Generic 400,
        // no existence oracle. Measured on live prod: 68 parented projects, all single-owner — this
        // gate costs zero legitimate writes. Self-reference is caught above; this is ownership.
        if (body.parent_project_id != null) {
          if (!await loadOwnedProject(sql, body.parent_project_id, householdIds)) {
            warnRejectedFk(userId, 'container', 'parent_id', body.parent_project_id);
            return resp(400, { error: 'parent_project_id does not match a project you can use' });
          }
        }

        // V1.2a-4 S1: when kind transitions NULL -> non-NULL, stamp kind_set_at = NOW().
        // Otherwise leave kind_set_at alone. Handled inline in the UPDATE using CASE.
        const cur = await sql`
          SELECT c.status AS old_status
          FROM public.container c
          WHERE c.id = ${projectId}
            AND c.created_by = ANY(${householdIds})
            AND c.deleted_at IS NULL
        `;
        if (!cur.length) return resp(404, { error: 'Not found' });

        // BUG-BLANKNAME-001 (2026-08-07). display_name is NOT NULL, but the COALESCE only guards
        // NULL and ProjectDetail.jsx:391 sends `form.name.trim()` — so an emptied box sends '',
        // which is not NULL, passes both the COALESCE and the constraint, and blanks the project
        // name every card, picker and the unauthenticated /garden/:slug share route renders.
        // Cosmetic here rather than a care regression (unlike the locations twin, whose name feeds
        // the daily-plan `covered` predicate), but the same one-line class and the same fix.
        //
        // Narrow on purpose: `name: null` and an absent key are this PUT's existing no-op grammar
        // and every current caller depends on them. Only a present, non-null, whitespace-only
        // string is refused. Mirrors varieties/validate.js:54.
        if (body.name != null && (typeof body.name !== 'string' || !body.name.trim())) {
          return resp(400, { error: 'name cannot be blank' });
        }

        // BUG-COALESCECLEAR-001. `clear` is an explicit array of column keys to set to NULL.
        // Absent/[] is byte-identical to the prior behaviour, so every existing caller is
        // unaffected and this ships inert until a client opts in. Validated BEFORE the UPDATE so an
        // un-clearable key is a 400 with a message, never a constraint violation.
        //
        // (Measured this session: `err.code` and `err.constraint` DO survive `sql.transaction`
        // intact, so the 23514 -> 400 mapping in this file's catch is live on the PUT path, not
        // dead code as two comments elsewhere in the repo claimed. Pre-validating here is still
        // right — a named 400 beats a constraint name — but it is belt, not the only belt.)
        const _cerr = validateClear(body.clear, body);
        if (_cerr) return resp(400, { error: _cerr });
        const clear = Array.isArray(body.clear) ? body.clear : [];

        const _oldStatus = cur[0].old_status ?? null;
        const _newStatus = body.status != null ? body.status : _oldStatus;
        const _statusChanged = isStatusChange(_oldStatus, _newStatus);

        // V3-EVENT-003 (project-level): emit a status_change audit event IN THE SAME
        // TRANSACTION as the project status UPDATE, only on a real change. container has no
        // RLS (explicit household scope above); event_log + entity_memory do -> set_config.
        const _stmts = [
          sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
          sql`
          UPDATE public.container
          SET
            display_name     = COALESCE(${body.name ?? null}, display_name),
            description      = CASE WHEN ${clear} @> ARRAY['description'] THEN NULL ELSE COALESCE(${body.description ?? null}, description) END,
            status           = COALESCE(${body.status ?? null}, status),
            variety          = CASE WHEN ${clear} @> ARRAY['variety'] THEN NULL ELSE COALESCE(${body.variety ?? null}, variety) END,
            start_date       = CASE WHEN ${clear} @> ARRAY['start_date'] THEN NULL ELSE COALESCE(${body.start_date ?? null}, start_date) END,
            is_public        = COALESCE(${body.is_public ?? null}, is_public),
            location_id      = CASE WHEN ${clear} @> ARRAY['location_id'] THEN NULL ELSE COALESCE(${body.location_id ?? null}, location_id) END,
            parent_id = CASE
              WHEN ${Object.prototype.hasOwnProperty.call(body, 'parent_project_id')} THEN ${body.parent_project_id ?? null}
              ELSE parent_id
            END,
            featured_photo_id = CASE
              WHEN ${hasFeatured} THEN ${body.featured_photo_id ?? null}
              ELSE featured_photo_id
            END,
            classification = CASE
              WHEN ${hasKind} THEN ${body.kind ?? null}
              ELSE classification
            END,
            kind_set_at = CASE
              WHEN ${hasKind && body.kind != null} AND classification IS NULL THEN NOW()
              ELSE kind_set_at
            END,
            target_end_date = CASE WHEN ${clear} @> ARRAY['target_end_date'] THEN NULL ELSE COALESCE(${body.target_end_date ?? null}, target_end_date) END,
            assignee_user_id = CASE
              WHEN ${hasAssignee} THEN ${body.assignee_user_id ?? null}
              ELSE assignee_user_id
            END
          WHERE id = ${projectId}
            AND created_by = ANY(${householdIds})
            AND deleted_at IS NULL
          RETURNING id, display_name AS name, slug, status, variety, description,
                    to_char(start_date, 'YYYY-MM-DD') AS start_date,
                    is_public, location_id, created_at, updated_at, created_by,
                    parent_id AS parent_project_id, featured_photo_id,
                    classification AS kind,
                    to_char(target_end_date, 'YYYY-MM-DD') AS target_end_date,
                    kind_set_at,
                    assignee_user_id
        `,
        ];
        if (_statusChanged) {
          const _note = formatStatusChangeNote(_oldStatus, _newStatus, 'project');
          const _meta = buildStatusChangeMetadata(_oldStatus, _newStatus, 'project');
          _stmts.push(sql`
            INSERT INTO event_log
              (project_id, plant_id, event_type, event_date, notes, metadata, logged_by, created_by, source)
            VALUES
              (${projectId}, ${null}, ${STATUS_CHANGE_EVENT_TYPE}, NOW(), ${_note}, ${_meta}, ${userId}, ${userId}, ${EVENT_SOURCE_STATUS})
          `);
          _stmts.push(sql`
            INSERT INTO entity_memory (project_id, last_event_at)
            VALUES (${projectId}, NOW())
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
        // BUG-DELNOOPOK-001: RETURNING-gated. Was an unconditional {ok:true}, so a not-found /
        // already-deleted / not-owned DELETE reported success; now 404, matching the PUT directly
        // above (:784) and every other verb on this path.
        const rows = await sql`
          UPDATE public.container
          SET deleted_at = NOW()
          WHERE id = ${projectId}
            AND created_by = ANY(${householdIds})
            AND deleted_at IS NULL
          RETURNING id
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // --- /api/projects ---
    // Care re-key Step D (care-rekey-001 / V4-CAREKEY-001): the four last_activity_at subselects
    // below read the CONTAINER CARE ROLLUP — the newest last_event_at across { the container's
    // plantings' entity_memory rows } ∪ { the container's own row } — not the single container-keyed
    // row they used to read. Same rollup shape as dashboard/handlers.js; the long rationale lives
    // there. The project arm stays in the OR because project-LEVEL events (no plant_id) are the only
    // activity 7 live containers have, and 55 live events carry no plant_id at all. MAX ignores NULL,
    // so a container with only one arm still reports it, and the COALESCE to created_at is unchanged.
    if (method === 'GET') {
      // V1.2a-4 S6: admin extension — ?admin=1 returns ALL alive rows regardless
      // of ownership. Allowlist same as PATCH (ADMIN_CLERK_SUBS). Fail-closed.
      // Per design proj-rescope-s6-design-V001-20260519.1625.md §5.4.
      const adminMode = qs.admin === '1';
      if (adminMode) {
        const ADMIN_CLERK_SUBS = (process.env.ADMIN_CLERK_SUBS ?? '')
          .split(',').map(s => s.trim()).filter(Boolean);
        if (ADMIN_CLERK_SUBS.length === 0) {
          return resp(403, { error: 'Admin route not configured' });
        }
        if (!ADMIN_CLERK_SUBS.includes(userId)) {
          return resp(403, { error: 'Not authorized' });
        }
        const rows = await sql`
          SELECT id, display_name AS name, slug, status, variety,
                 to_char(start_date, 'YYYY-MM-DD') AS start_date,
                 is_public, location_id, created_at, updated_at, created_by,
                 parent_id AS parent_project_id,
                 classification AS kind, to_char(target_end_date, 'YYYY-MM-DD') AS target_end_date,
                 kind_set_at,
                 assignee_user_id,
                 COALESCE((SELECT MAX(em.last_event_at) FROM entity_memory em
                           WHERE em.project_id = container.id
                              OR em.plant_id IN (SELECT gp.id FROM public.garden_node gp
                                                  WHERE gp.container_id = container.id AND gp.deleted_at IS NULL)),
                          created_at) AS last_activity_at
          FROM public.container
          WHERE deleted_at IS NULL
          ORDER BY parent_id NULLS FIRST, display_name ASC
        `;
        return resp(200, rows);
      }

      // Optional filter: ?parent_id=<uuid> returns only children of that parent
      // ?parent_id=null returns only root-level projects
      const parentIdFilter = qs.parent_id;

      // V1.2a-4 S1.A-hotfix: add kind_set_at to LIST SELECTs to match by-id +
      // POST/PUT response shape. kind + target_end_date already returned by S1
      // ship; kind_set_at was the gap. Pairs with PROJ-RESCOPE §4.1 columns.
      let rows;
      if (parentIdFilter === 'null' || parentIdFilter === '') {
        rows = await sql`
          SELECT id, display_name AS name, slug, status, variety,
                 to_char(start_date, 'YYYY-MM-DD') AS start_date,
                 is_public, location_id, created_at, updated_at, parent_id AS parent_project_id,
                 classification AS kind, to_char(target_end_date, 'YYYY-MM-DD') AS target_end_date,
                 kind_set_at,
                 assignee_user_id,
                 COALESCE((SELECT MAX(em.last_event_at) FROM entity_memory em
                           WHERE em.project_id = container.id
                              OR em.plant_id IN (SELECT gp.id FROM public.garden_node gp
                                                  WHERE gp.container_id = container.id AND gp.deleted_at IS NULL)),
                          created_at) AS last_activity_at
          FROM public.container
          WHERE created_by = ANY(${householdIds})
            AND deleted_at IS NULL
            AND archived_at IS NULL
            AND parent_id IS NULL
          ORDER BY start_date DESC NULLS LAST, created_at DESC
        `;
      } else if (parentIdFilter) {
        rows = await sql`
          SELECT id, display_name AS name, slug, status, variety,
                 to_char(start_date, 'YYYY-MM-DD') AS start_date,
                 is_public, location_id, created_at, updated_at, parent_id AS parent_project_id,
                 classification AS kind, to_char(target_end_date, 'YYYY-MM-DD') AS target_end_date,
                 kind_set_at,
                 assignee_user_id,
                 COALESCE((SELECT MAX(em.last_event_at) FROM entity_memory em
                           WHERE em.project_id = container.id
                              OR em.plant_id IN (SELECT gp.id FROM public.garden_node gp
                                                  WHERE gp.container_id = container.id AND gp.deleted_at IS NULL)),
                          created_at) AS last_activity_at
          FROM public.container
          WHERE created_by = ANY(${householdIds})
            AND deleted_at IS NULL
            AND archived_at IS NULL
            AND parent_id = ${parentIdFilter}
          ORDER BY start_date DESC NULLS LAST, created_at DESC
        `;
      } else {
        rows = await sql`
          SELECT id, display_name AS name, slug, status, variety,
                 to_char(start_date, 'YYYY-MM-DD') AS start_date,
                 is_public, location_id, created_at, updated_at, parent_id AS parent_project_id,
                 classification AS kind, to_char(target_end_date, 'YYYY-MM-DD') AS target_end_date,
                 kind_set_at,
                 assignee_user_id,
                 COALESCE((SELECT MAX(em.last_event_at) FROM entity_memory em
                           WHERE em.project_id = container.id
                              OR em.plant_id IN (SELECT gp.id FROM public.garden_node gp
                                                  WHERE gp.container_id = container.id AND gp.deleted_at IS NULL)),
                          created_at) AS last_activity_at
          FROM public.container
          WHERE created_by = ANY(${householdIds})
            AND deleted_at IS NULL
            AND archived_at IS NULL
          ORDER BY start_date DESC NULLS LAST, created_at DESC
        `;
      }
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name) return resp(400, { error: 'name is required' });
      // V1.2a-4 S1 (PROJ-RESCOPE): validate kind enum server-side. A null/absent
      // kind is coalesced to a default below (S6) so alive rows are never kind=NULL.
      const ALLOWED_KINDS = ['campaign', 'category', 'cultivar'];
      if (body.kind != null && !ALLOWED_KINDS.includes(body.kind)) {
        return resp(400, { error: `kind must be one of ${ALLOWED_KINDS.join(', ')} or null` });
      }
      // V1.2a-4 S6 (PROJ-RESCOPE): an alive plant_projects row must never have
      // kind=NULL or the s6-0a CHECK (kind IS NOT NULL OR deleted_at IS NOT NULL)
      // 500s every such create (e.g. ProjectNew's "Not sure yet" default sends
      // null). Coalesce a missing kind to 'campaign' (dominant new-project type);
      // /admin/classify can reclassify later. Server-side backstop for ALL callers.
      const effectiveKind = body.kind ?? 'campaign';
      // AUTHZ (V4-AUTHZSWEEP-001): location_id and parent_project_id are cross-entity FKs taken
      // straight from the body. The reparent path (reparentCore) already proves ownership of a new
      // parent; the CREATE path did not, so a project could be born parented to another household's
      // container — inheriting its position in that household's tree. Generic 400s, no existence
      // oracle. A container is the projects table's own row type, so its owner column is created_by.
      if (body.location_id != null) {
        if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
          warnRejectedFk(userId, 'container', 'location_id', body.location_id);
          return resp(400, { error: 'location_id does not match a location you can use' });
        }
      }
      if (body.parent_project_id != null) {
        const parentRows = await sql`
          SELECT /* authz-parent-check */ id FROM public.container
           WHERE id = ${body.parent_project_id}
             AND created_by = ANY(${householdIds})
             AND deleted_at IS NULL
        `;
        if (!parentRows.length) {
          warnRejectedFk(userId, 'container', 'parent_id', body.parent_project_id);
          return resp(400, { error: 'parent_project_id does not match a project you can use' });
        }
      }
      // Validate parent_project_id is not self-referential (can't know id yet, but guard against explicit self-reference attempts via name matching — full guard at PUT)
      const rows = await sql`
        INSERT INTO public.container
          (display_name, slug, status, variety, description, start_date, is_public, location_id, created_by, parent_id,
           classification, target_end_date, kind_set_at)
        VALUES (
          ${body.name},
          ${body.slug ?? body.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')},
          ${body.status ?? 'planning'},
          ${body.variety ?? null},
          ${body.description ?? null},
          ${body.start_date ?? null},
          ${body.is_public ?? true},
          ${body.location_id ?? null},
          ${userId},
          ${body.parent_project_id ?? null},
          ${effectiveKind},
          ${body.target_end_date ?? null},
          ${new Date().toISOString()}
        )
        RETURNING id, display_name AS name, slug, status, variety, description,
                  to_char(start_date, 'YYYY-MM-DD') AS start_date,
                  is_public, location_id, created_at, updated_at, created_by,
                  parent_id AS parent_project_id,
                  classification AS kind,
                  to_char(target_end_date, 'YYYY-MM-DD') AS target_end_date,
                  kind_set_at
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('projects lambda error', err);
    // BUG-PROJKINDCLEAR-001. Mirrors lambda/plants/index.js's catch verbatim. Without this, a
    // constraint the CLIENT can provoke surfaces as a bare 500 with no message: `classification`
    // is already CASE-clearable on both PATCH (:492) and PUT (:588), but
    // plant_projects_kind_not_null_unless_deleted is VALIDATED and forbids NULL on a live row, so
    // {kind: null} raises 23514 and the user sees "Internal server error". Latent today only
    // because ProjectsAdminClassify guards the call — unexercised, not fixed. A caller-provokable
    // constraint violation is a 400; only genuinely unexpected failures are 500s.
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};

