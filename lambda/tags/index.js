// /api/tags + /api/entity-tags — V4-TAGSUB-001 faceted tag substrate Lambda.
// Pattern: mirrors lambda/varieties/index.js (Clerk JWT, Secrets Manager, Function-URL-owns-CORS, pg error map).
//
// Auth: Clerk JWT per request -> userId = JWT.sub. Scoping enforced in WHERE clauses (Neon makes PG RLS vestigial).
// Visibility (D-SCOPE): ONE canonical predicate shape used by every read of tag/entity_tag — a private tag never
//   leaks cross-user; shared widens only to householdScope; system (derived) is always visible. The
//   tags-canonical-predicate.test.js static guard fails CI if any tag read drifts from this shape.
// Derive (D-ARCH): type:/lifecycle: are system-owned derived tags from crop-derive.js. The single-cultivar path
//   runs IN-PROCESS (varieties Lambda calls applyDerive post-commit, fail-open). The bulk form here is admin-gated.
// Audit: tag/entity_tag have NO audit trigger (verified prod 2026-06-25); created_by captures the actor. Full
//   audit-trigger parity is a tracked follow-up (D-AUDIT, partial-defer).
// NOTE: @neondatabase/serverless 0.10.x has NO sql.unsafe / sql.query — all identifiers are literal in-template.

import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { householdScope } from './household.js';
import { assembleBulkEntities } from './bulk.js';
import { applyDerive } from './crop-derive.js';
import {
  slugify, validateTagCreate, validateTagPatch, validateEntityTagCreate, isAdmin,
} from './validate.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config owns CORS — handler must not duplicate.
function resp(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) };
}

async function checkRateLimit(sql, actor, bucketKey, limit) {
  const rows = await sql`
    INSERT INTO public.rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)
    VALUES (${actor}, ${bucketKey}, date_trunc('hour', NOW()), 1)
    ON CONFLICT (actor_clerk_sub, bucket_key, window_start)
    DO UPDATE SET count = public.rate_limit_buckets.count + 1
    WHERE public.rate_limit_buckets.count < ${limit}
    RETURNING count`;
  return rows.length > 0;
}

// Existence check for the polymorphic entity_tag target (D-ENTITY; entity_id has no FK). Literal per-type
// query because the driver can't parameterize an identifier. Household-scoped (BUG-TAGENTOWN-001): a
// requester may only attach to entities their household owns — cross-household ids return false (404),
// which also avoids confirming foreign ids exist. EXCEPTION: cultivar stays unscoped — plant_varieties
// reads are globally readable by design (see lambda/varieties/index.js).
async function entityExists(sql, entityType, entityId, household) {
  let rows = [];
  if (entityType === 'plant') rows = await sql`
    SELECT 1 FROM public.garden_node gn
    LEFT JOIN public.container pp ON pp.id = gn.container_id
    WHERE gn.id = ${entityId} AND gn.deleted_at IS NULL
      AND ( pp.created_by = ANY(${household})
            OR (gn.container_id IS NULL AND gn.created_by = ANY(${household})) )`;
  else if (entityType === 'cultivar') rows = await sql`SELECT 1 FROM public.plant_varieties WHERE id = ${entityId} AND deleted_at IS NULL`;
  else if (entityType === 'location') rows = await sql`SELECT 1 FROM public.locations WHERE id = ${entityId} AND deleted_at IS NULL AND created_by = ANY(${household})`;
  else if (entityType === 'project') rows = await sql`SELECT 1 FROM public.plant_projects WHERE id = ${entityId} AND deleted_at IS NULL AND created_by = ANY(${household})`;
  return rows.length > 0;
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

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
        'https://staging.garden.futureishere.net',
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
  // AE-047: Neon pooler intermittently defaults default_transaction_read_only=on; force RW before any write.
  try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`; } catch { /* read paths tolerate */ }

  const household = householdScope(userId);
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? '/api/tags';
  const qp = event.queryStringParameters ?? {};

  // Ordered route match — literals BEFORE the :id catch-all (D-ROUTE).
  const mDerive = path.match(/^\/api\/tags\/derive\/sync$/);
  const mMerge = path.match(/^\/api\/tags\/([^/]+)\/merge$/);
  const mTagId = path.match(/^\/api\/tags\/([^/]+)$/);
  const mEtId = path.match(/^\/api\/entity-tags\/([^/]+)$/);

  try {
    // ── POST /api/tags/derive/sync  (admin-only bulk / single backfill) ─────────────────────────────
    if (mDerive) {
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      if (!isAdmin(userId, process.env)) return resp(403, { error: 'Admin only' });
      const body = JSON.parse(event.body ?? '{}');
      const totals = await applyDerive(sql, body.cultivar_id ?? null);
      return resp(200, totals);
    }

    // ── POST /api/tags/:id/merge ────────────────────────────────────────────────────────────────────
    if (mMerge) {
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      const fromId = mMerge[1];
      const body = JSON.parse(event.body ?? '{}');
      const intoId = body.into_id;
      if (!intoId) return resp(400, { error: 'into_id is required' });
      if (intoId === fromId) return resp(400, { error: 'cannot merge a tag into itself' });
      if (!(await checkRateLimit(sql, userId, 'tag.merge', 30))) return resp(429, { error: 'Rate limit exceeded — 30/hour for tag.merge' });

      const pair = await sql`
        SELECT id, facet, source FROM public.tag
        WHERE id IN (${fromId}, ${intoId}) AND owner_id = ${userId} AND source = 'user' AND deleted_at IS NULL`;
      const from = pair.find(r => r.id === fromId);
      const into = pair.find(r => r.id === intoId);
      if (!from || !into) return resp(404, { error: 'Both tags must exist, be user tags, and be owned by you' });
      if (from.facet !== into.facet) return resp(400, { error: 'Can only merge tags of the same facet' });

      // Atomic: (1) soft-delete source links that would collide with a live target link; (2) re-point the rest;
      // (3) soft-delete the merged-away tag. One transaction so a retry never sees a partial state (D-MERGE).
      const results = await sql.transaction([
        sql`UPDATE public.entity_tag src SET deleted_at = now()
            WHERE src.tag_id = ${fromId} AND src.deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM public.entity_tag tgt
                          WHERE tgt.tag_id = ${intoId} AND tgt.entity_type = src.entity_type
                            AND tgt.entity_id = src.entity_id AND tgt.deleted_at IS NULL)`,
        sql`UPDATE public.entity_tag SET tag_id = ${intoId}
            WHERE tag_id = ${fromId} AND deleted_at IS NULL RETURNING id`,
        sql`UPDATE public.tag SET deleted_at = now(), updated_at = now() WHERE id = ${fromId} AND owner_id = ${userId}`,
      ]);
      return resp(200, { ok: true, into_id: intoId, links_repointed: results[1].length });
    }

    // ── /api/tags/:id  (PATCH rename/visibility, DELETE soft-delete) ────────────────────────────────
    if (mTagId) {
      const id = mTagId[1];
      if (method === 'PATCH') {
        const body = JSON.parse(event.body ?? '{}');
        const verr = validateTagPatch(body);
        if (verr) return resp(400, { error: verr });
        const newSlug = body.label != null ? slugify(body.label) : null;
        const rows = await sql`
          UPDATE public.tag SET
            label = COALESCE(${body.label ?? null}, label),
            slug = COALESCE(${newSlug}, slug),
            visibility = COALESCE(${body.visibility ?? null}, visibility),
            updated_at = now()
          WHERE id = ${id} AND owner_id = ${userId} AND source = 'user' AND deleted_at IS NULL
          RETURNING id, facet, label, slug, source, owner_id, visibility, created_by, created_at, updated_at`;
        if (!rows.length) return resp(404, { error: 'Not found or not an editable user tag' });
        return resp(200, rows[0]);
      }
      if (method === 'DELETE') {
        const rows = await sql`
          UPDATE public.tag SET deleted_at = now(), updated_at = now()
          WHERE id = ${id} AND owner_id = ${userId} AND source = 'user' AND deleted_at IS NULL RETURNING id`;
        if (!rows.length) return resp(404, { error: 'Not found or not a deletable user tag' });
        await sql`UPDATE public.entity_tag SET deleted_at = now() WHERE tag_id = ${id} AND deleted_at IS NULL`;
        return resp(200, { ok: true });
      }
      return resp(405, { error: 'Method not allowed' });
    }

    // ── /api/tags  (GET list, POST create) ──────────────────────────────────────────────────────────
    if (path === '/api/tags') {
      if (method === 'GET') {
        const facet = qp.facet ?? null;
        const q = qp.q ? `%${qp.q.toLowerCase()}%` : null;
        // CANONICAL visibility predicate (D-SCOPE).
        const rows = await sql`
          SELECT id, facet, label, slug, source, owner_id, visibility, created_by, created_at, updated_at
          FROM public.tag
          WHERE deleted_at IS NULL
            AND ( (visibility = 'private' AND owner_id = ${userId})
                  OR (visibility = 'shared' AND owner_id = ANY(${household}))
                  OR owner_id = 'system' )
            AND (${facet}::text IS NULL OR facet = ${facet})
            AND (${q}::text IS NULL OR LOWER(label) LIKE ${q})
          ORDER BY facet, label LIMIT 200`;
        return resp(200, rows);
      }
      if (method === 'POST') {
        const body = JSON.parse(event.body ?? '{}');
        const verr = validateTagCreate(body);
        if (verr) return resp(400, { error: verr });
        if (!(await checkRateLimit(sql, userId, 'tag.create', 60))) return resp(429, { error: 'Rate limit exceeded — 60/hour for tag.create' });
        const facet = body.facet, slug = slugify(body.label), label = body.label.trim();
        const visibility = body.visibility ?? 'shared';
        // Revive-or-insert against uq_tag_facet_slug_owner WHERE deleted_at IS NULL (D-SQL2); idempotent on the natural key.
        const rows = await sql`
          WITH live AS (
            SELECT id, facet, label, slug, source, owner_id, visibility, created_by, created_at, updated_at, 'live'::text AS _origin
            FROM public.tag WHERE facet = ${facet} AND slug = ${slug} AND owner_id = ${userId} AND deleted_at IS NULL
          ), revived AS (
            UPDATE public.tag SET deleted_at = NULL, label = ${label}, visibility = ${visibility}, updated_at = now()
            WHERE id = (SELECT id FROM public.tag WHERE facet = ${facet} AND slug = ${slug} AND owner_id = ${userId} AND deleted_at IS NOT NULL ORDER BY created_at LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM live)
            RETURNING id, facet, label, slug, source, owner_id, visibility, created_by, created_at, updated_at, 'revived'::text AS _origin
          ), inserted AS (
            INSERT INTO public.tag (facet, label, slug, source, owner_id, visibility, created_by)
            SELECT ${facet}, ${label}, ${slug}, 'user', ${userId}, ${visibility}, ${userId}
            WHERE NOT EXISTS (SELECT 1 FROM live) AND NOT EXISTS (SELECT 1 FROM revived)
            RETURNING id, facet, label, slug, source, owner_id, visibility, created_by, created_at, updated_at, 'inserted'::text AS _origin
          )
          SELECT * FROM live UNION ALL SELECT * FROM revived UNION ALL SELECT * FROM inserted`;
        const row = rows[0];
        const created = row._origin !== 'live';
        delete row._origin;
        return resp(created ? 201 : 200, row);
      }
      return resp(405, { error: 'Method not allowed' });
    }

    // ── /api/entity-tags/:id  (DELETE soft-detach by surrogate id) ──────────────────────────────────
    if (mEtId) {
      if (method !== 'DELETE') return resp(405, { error: 'Method not allowed' });
      const rows = await sql`
        UPDATE public.entity_tag et SET deleted_at = now()
        FROM public.tag t
        WHERE et.id = ${mEtId[1]} AND et.tag_id = t.id AND et.deleted_at IS NULL
          AND t.owner_id = ${userId} AND t.source = 'user'
        RETURNING et.id`;
      if (!rows.length) return resp(404, { error: 'Not found or not a detachable user link' });
      return resp(200, { ok: true });
    }

    // ── /api/entity-tags  (GET for an entity, POST attach) ──────────────────────────────────────────
    if (path === '/api/entity-tags') {
      if (method === 'GET') {
        const et = qp.entity_type, eid = qp.entity_id;
        if (!et) return resp(400, { error: 'entity_type is required' });
        // ── BULK mode (GARDENIA, V4-GARDENIA-001): entity_type given, NO entity_id -> the household's
        //    whole-garden planting->tags map in ONE round trip, avoiding N+1 over ~170 plantings.
        //    Shape: { entities: { <planting_id>: { direct: Tag[], projected: Tag[] } } }. Only 'plant'
        //    is supported (container-scope + cultivar projection are plant-specific). Read-only.
        //    V4-ARCHIVEHIDE-001 (L4): both bulk queries walked garden_node on `deleted_at IS NULL`
        //    alone, so an ARCHIVED planting's tags were loaded into the whole-garden map. The map is
        //    consumed beside GET /api/plants (src/lib/projectTree.js), which already filters
        //    archived_at — so today the extra keys are unreachable rather than rendered, and prod
        //    measures 0 leaked rows (no archived planting currently carries a tag, 2026-08-13). It is
        //    LATENT, not absent: tagging any planting and archiving it opens it, and "must not be
        //    loaded at all" is not satisfied by a consumer that happens not to look. AXIS is
        //    archived_at, not deleted_at; the existing deleted_at predicates are untouched.
        //    NOT applied to the single-entity ?entity_id= read below — that is the planting's own
        //    detail page, the one route an archived planting still has.
        if (!eid) {
          if (et !== 'plant') return resp(400, { error: 'bulk entity-tags is only supported for entity_type=plant' });
          const directRows = await sql`
            SELECT et.entity_id, t.id, t.facet, t.label, t.slug, t.source, t.owner_id, t.visibility, t.created_by, t.created_at, t.updated_at
            FROM public.garden_node gn
            LEFT JOIN public.container pp ON pp.id = gn.container_id
            JOIN public.entity_tag et ON et.entity_type = 'plant' AND et.entity_id = gn.id AND et.deleted_at IS NULL
            JOIN public.tag t ON t.id = et.tag_id AND t.deleted_at IS NULL
            WHERE gn.deleted_at IS NULL
              AND gn.archived_at IS NULL
              AND ( pp.created_by = ANY(${household})
                    OR (gn.container_id IS NULL AND gn.created_by = ANY(${household})) )
              AND ( (t.visibility = 'private' AND t.owner_id = ${userId})
                    OR (t.visibility = 'shared' AND t.owner_id = ANY(${household}))
                    OR t.owner_id = 'system' )`;
          const projRows = await sql`
            SELECT gn.id AS entity_id, t.id, t.facet, t.label, t.slug, t.source, t.owner_id, t.visibility, t.created_by, t.created_at, t.updated_at
            FROM public.garden_node gn
            LEFT JOIN public.container pp ON pp.id = gn.container_id
            JOIN public.entity_tag et ON et.entity_type = 'cultivar' AND et.entity_id = gn.cultivar_id AND et.deleted_at IS NULL
            JOIN public.tag t ON t.id = et.tag_id AND t.deleted_at IS NULL AND t.source = 'derived'
            WHERE gn.deleted_at IS NULL
              AND gn.archived_at IS NULL
              AND ( pp.created_by = ANY(${household})
                    OR (gn.container_id IS NULL AND gn.created_by = ANY(${household})) )`;
          return resp(200, { entities: assembleBulkEntities(directRows, projRows) });
        }
        const direct = await sql`
          SELECT t.id, t.facet, t.label, t.slug, t.source, t.owner_id, t.visibility, t.created_by, t.created_at, t.updated_at
          FROM public.entity_tag et JOIN public.tag t ON t.id = et.tag_id
          WHERE et.entity_type = ${et} AND et.entity_id = ${eid} AND et.deleted_at IS NULL AND t.deleted_at IS NULL
            AND ( (t.visibility = 'private' AND t.owner_id = ${userId})
                  OR (t.visibility = 'shared' AND t.owner_id = ANY(${household}))
                  OR t.owner_id = 'system' )`;
        let projected = [];
        if (et === 'plant') {
          // Project the planting's cultivar derived type:/lifecycle: (not materialized per-planting).
          projected = await sql`
            SELECT t.id, t.facet, t.label, t.slug, t.source, t.owner_id, t.visibility, t.created_by, t.created_at, t.updated_at
            FROM public.garden_node gn
            JOIN public.entity_tag et ON et.entity_type = 'cultivar' AND et.entity_id = gn.cultivar_id AND et.deleted_at IS NULL
            JOIN public.tag t ON t.id = et.tag_id AND t.deleted_at IS NULL AND t.source = 'derived'
            WHERE gn.id = ${eid}`;
        }
        return resp(200, { direct, projected });
      }
      if (method === 'POST') {
        const body = JSON.parse(event.body ?? '{}');
        const verr = validateEntityTagCreate(body);
        if (verr) return resp(400, { error: verr });
        if (!(await checkRateLimit(sql, userId, 'entity_tag.attach', 600))) return resp(429, { error: 'Rate limit exceeded — 600/hour for entity_tag.attach' });
        const tagRows = await sql`SELECT id, source, owner_id FROM public.tag WHERE id = ${body.tag_id} AND deleted_at IS NULL`;
        if (!tagRows.length) return resp(404, { error: 'tag not found' });
        if (tagRows[0].source !== 'user') return resp(403, { error: 'derived tags are system-managed and cannot be attached' });
        if (tagRows[0].owner_id !== userId) return resp(403, { error: 'not your tag' });
        if (!(await entityExists(sql, body.entity_type, body.entity_id, household))) {
          return resp(404, { error: `${body.entity_type} ${body.entity_id} not found` });
        }
        const rows = await sql`
          WITH live AS (
            SELECT id, 'live'::text AS _origin FROM public.entity_tag
            WHERE tag_id = ${body.tag_id} AND entity_type = ${body.entity_type} AND entity_id = ${body.entity_id} AND deleted_at IS NULL
          ), revived AS (
            UPDATE public.entity_tag SET deleted_at = NULL
            WHERE id = (SELECT id FROM public.entity_tag WHERE tag_id = ${body.tag_id} AND entity_type = ${body.entity_type} AND entity_id = ${body.entity_id} AND deleted_at IS NOT NULL ORDER BY created_at LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM live)
            RETURNING id, 'revived'::text AS _origin
          ), inserted AS (
            INSERT INTO public.entity_tag (tag_id, entity_type, entity_id, created_by)
            SELECT ${body.tag_id}, ${body.entity_type}, ${body.entity_id}, ${userId}
            WHERE NOT EXISTS (SELECT 1 FROM live) AND NOT EXISTS (SELECT 1 FROM revived)
            RETURNING id, 'inserted'::text AS _origin
          )
          SELECT * FROM live UNION ALL SELECT * FROM revived UNION ALL SELECT * FROM inserted`;
        const created = rows[0]._origin !== 'live';
        return resp(created ? 201 : 200, { id: rows[0].id });
      }
      return resp(405, { error: 'Method not allowed' });
    }

    return resp(404, { error: 'Not found' });
  } catch (err) {
    console.error('tags lambda error', err);
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    if (err.code === '23505') return resp(409, { error: `Unique violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
