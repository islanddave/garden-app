import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { householdScope } from './household.js';
import { isStatusChange, formatStatusChangeNote, buildStatusChangeMetadata, STATUS_CHANGE_EVENT_TYPE } from './statusEvents.js';

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

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/projects';
  const qs = event.queryStringParameters ?? {};

  // Must check /types routes before idMatch — otherwise 'types' is treated as a project UUID
  const typesItemMatch = rawPath.match(/^\/api\/projects\/types\/([^/]+)$/);
  const typesMatch = rawPath === '/api/projects/types';

  const idMatch = rawPath.match(/^\/api\/projects\/([^/]+)$/);

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
        await sql`
          UPDATE project_types SET deleted_at = NOW()
          WHERE id = ${typeId} AND created_by = ${userId} AND deleted_at IS NULL
        `;
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
    if (idMatch) {
      const projectId = idMatch[1];

      if (method === 'GET') {
        const [projectRows, plantCountRows, eventCountRows] = await Promise.all([
          sql`
            SELECT pp.id, pp.display_name AS name, pp.slug, pp.status, pp.variety, pp.description,
                   to_char(pp.start_date, 'YYYY-MM-DD') AS start_date,
                   pp.is_public, pp.location_id, pp.created_at, pp.updated_at, pp.created_by,
                   pp.parent_id AS parent_project_id, pp.version, pp.featured_photo_id,
                   pp.classification AS kind,
                   to_char(pp.target_end_date, 'YYYY-MM-DD') AS target_end_date,
                   pp.kind_set_at, pp.archived_at, pp.assignee_user_id,
                   p.display_name AS parent_project_name,
                   fp.storage_path AS featured_photo_storage_path
            FROM public.container pp
            LEFT JOIN public.container p ON p.id = pp.parent_id AND p.deleted_at IS NULL
            LEFT JOIN photos fp ON fp.id = pp.featured_photo_id
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
            FROM event_log
            WHERE project_id = ${projectId}
              AND deleted_at IS NULL
          `,
        ]);
        if (!projectRows.length) return resp(404, { error: 'Not found' });
        const row = projectRows[0];
        const featured_photo_view_url = await getFeaturedPhotoViewUrl(row.featured_photo_storage_path);
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
          `;
          if (!linkRows.length) {
            return resp(400, { error: 'featured_photo_id must be a photo linked to this project' });
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
            description      = COALESCE(${body.description ?? null}, description),
            status           = COALESCE(${body.status ?? null}, status),
            variety          = COALESCE(${body.variety ?? null}, variety),
            start_date       = COALESCE(${body.start_date ?? null}, start_date),
            is_public        = COALESCE(${body.is_public ?? null}, is_public),
            location_id      = COALESCE(${body.location_id ?? null}, location_id),
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
            target_end_date = COALESCE(${body.target_end_date ?? null}, target_end_date),
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
              (project_id, plant_id, event_type, event_date, notes, metadata, logged_by, created_by)
            VALUES
              (${projectId}, ${null}, ${STATUS_CHANGE_EVENT_TYPE}, NOW(), ${_note}, ${_meta}, ${userId}, ${userId})
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
        await sql`
          UPDATE public.container
          SET deleted_at = NOW()
          WHERE id = ${projectId}
            AND created_by = ANY(${householdIds})
            AND deleted_at IS NULL
        `;
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // --- /api/projects ---
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
                 COALESCE((SELECT em.last_event_at FROM entity_memory em WHERE em.project_id = container.id), created_at) AS last_activity_at
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
                 COALESCE((SELECT em.last_event_at FROM entity_memory em WHERE em.project_id = container.id), created_at) AS last_activity_at
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
                 COALESCE((SELECT em.last_event_at FROM entity_memory em WHERE em.project_id = container.id), created_at) AS last_activity_at
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
                 COALESCE((SELECT em.last_event_at FROM entity_memory em WHERE em.project_id = container.id), created_at) AS last_activity_at
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
          ${body.is_public ?? false},
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
    return resp(500, { error: 'Internal server error' });
  }
};

