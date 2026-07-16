// /api/events — Lambda 2.2.x (V1.2a-2 Session 2)
// V002 spec: garden/v12a2-session2-lambda-design-V002-20260513.md
// Brief overrides (Dave 2026-05-13): F16=path-b (achievement XP UNCAPPED — daily 30-XP cap
// is event_logged-only); F17=scope reduction (ship harvest infra + validators + F18 caps,
// DEFER harvest_quantity/harvest_quality CASE branches to V4; harvest_century works via
// existing event_type_count evaluator; issue_resolve_count SHIPS in PATCH path);
// F19=moot since quality_grower not evaluated this session.
//
// Endpoints:
//   GET    /api/events                       (unchanged from 2.1.x)
//   GET    /api/events/:id                   (unchanged from 2.1.x; UUID pre-validated per F9)
//   POST   /api/events                       (extended: flagged_as_issue, severity, harvest{})
//   PATCH  /api/events/:id                   (NEW: issue resolve; UUID pre-validated per F9)
//   DELETE /api/events/:id                   (ADDED 2026-06-10: single-event undo, soft-delete only —
//                                             never existed server-side; clients always got 405)
//   POST   /api/notifications/subscribe      (NEW)
//
// Routing precedence (F10):
//   1. POST /api/notifications/subscribe       — exact path
//   2. PATCH /api/events/:id                   — regex, UUID-pre-validated
//   3. GET   /api/events/:id                   — regex, UUID-pre-validated
//   4. GET / POST /api/events                  — base path

import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { validatePostBody, validateBatchBody, HARVEST_UNITS, MAX_PLAUSIBLE, UUID_RE, normalizeEventDate } from './validators.js';
import { computeStreak, STREAK_GRACE_DAYS } from './streak.js';
import { householdScope } from './household.js';
import { FRUITING_SOURCE_STATUSES, FLOWERING_SOURCE_STATUSES } from './statusTransitions.js';
import { awardCritterServer, awardCrittersForBatch, readUserPrefs as readPrefsForCritter, readSpeciesPrefs as readSpeciesPrefsForCritter } from './critterAward.js';
import { randomUUID } from 'node:crypto';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

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

// Daily flat-XP cap (V002 §11; F16 brief override): cap event_logged grants at 30 XP/user/day.
// Achievement XP is encouragement-class — milestones celebrate progress, not bounded by daily limits.
const DAILY_FLAT_XP_CAP = 30;
const FLAT_XP_PER_EVENT = 10;

// Harvest constants, validator, UUID regex live in validators.js (DB-free, unit-testable).
// Re-exported here for backward compat with any caller importing from index.js directly.
export { HARVEST_UNITS, MAX_PLAUSIBLE, validatePostBody, UUID_RE };

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
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown (event ENTITY reads/writes only; achievement/XP/streak queries stay per-user)
  const householdIds = householdScope(userId);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/events';

  try {
    // ── Route 1 (F10 precedence): POST /api/notifications/subscribe ────────────────────────────
    if (rawPath === '/api/notifications/subscribe' && method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!['default', 'granted', 'denied'].includes(body.permission_state)) {
        return resp(400, { error: 'permission_state must be default, granted, or denied' });
      }
      const state = body.permission_state;

      // F29 — defensive profiles INSERT so notification_subscriptions FK never fails on first call.
      // Brief override: profiles PK is `id`, not `user_id` (V002 §3.3 draft used wrong column name).
      await sql`INSERT INTO profiles (id) VALUES (${userId}) ON CONFLICT (id) DO NOTHING`;

      const rows = await sql`
        INSERT INTO notification_subscriptions
          (user_id, permission_state, granted_at, last_prompted_at)
        VALUES (
          ${userId},
          ${state},
          CASE WHEN ${state} = 'granted' THEN NOW() ELSE NULL END,
          CASE WHEN ${state} <> 'default' THEN NOW() ELSE NULL END
        )
        ON CONFLICT (user_id) DO UPDATE SET
          permission_state = EXCLUDED.permission_state,
          granted_at = CASE
            WHEN EXCLUDED.permission_state = 'granted'
              AND notification_subscriptions.granted_at IS NULL
              THEN NOW()
            ELSE notification_subscriptions.granted_at
          END,
          last_prompted_at = CASE
            WHEN EXCLUDED.permission_state <> 'default' THEN NOW()
            ELSE notification_subscriptions.last_prompted_at
          END,
          updated_at = NOW()
        RETURNING permission_state, granted_at, last_prompted_at, updated_at
      `;

      // F28 — canonical event name: notification_permission_<state>
      try {
        await sql`
          INSERT INTO app_events (user_clerk_sub, event_name, event_source, metadata)
          VALUES (${userId}, ${'notification_permission_' + state}, 'lambda', ${{ source: 'banner' }})
        `;
      } catch (telErr) {
        console.warn('notification telemetry failed (non-fatal)', telErr.message);
      }

      return resp(200, rows[0]);
    }

    // ── Bulk "Quick Log" / Unit A (2026-05-24): batch routes BEFORE the /:id regex ──────────────
    // POST /api/events/batch — apply one event_type to many plantings (one event per planting).
    if (rawPath === '/api/events/batch' && method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const vErr = validateBatchBody(body);
      if (vErr) return resp(vErr.status, { error: vErr.error });

      const eventType = body.event_type;
      const eventDate = normalizeEventDate(body.event_date) ?? new Date().toISOString();
      const key = body.idempotency_key;
      const scope = body.scope;
      const scopeType = scope.type;
      const projectId = scope.project_id ?? null;
      const locationId = scope.location_id ?? null;
      const excludeIds = Array.isArray(body.exclude_plant_ids) ? body.exclude_plant_ids : [];
      const dryRun = body.dry_run === true;

      // (1) Idempotency fast-path: same key (same owner) returns the prior batch, no re-insert.
      const prior = await sql`
        SELECT id, item_count FROM event_batches
        WHERE idempotency_key = ${key} AND created_by = ${userId}
      `;
      if (prior.length) {
        // Backfill event_ids from event_log for idempotent re-hits (Phase B+ critter wiring).
        const priorEvents = await sql`
          SELECT id FROM event_log
           WHERE metadata->>'batch_id' = ${prior[0].id}::text
             AND created_by = ${userId}
             AND deleted_at IS NULL
        `;
        return resp(200, {
          batch_id: prior[0].id,
          count: prior[0].item_count,
          event_ids: priorEvents.map(r => r.id),
          idempotent: true,
        });
      }

      // (2) Resolve scope server-side → owner-scoped, alive plantings (never trust a client list).
      const resolved = await sql`
        SELECT p.id AS plant_id, p.display_name AS plant_name
        FROM public.garden_node p JOIN public.container pp ON pp.id = p.container_id
        WHERE p.deleted_at IS NULL AND pp.deleted_at IS NULL AND p.archived_at IS NULL
          AND pp.created_by = ANY(${householdIds})
          AND CASE ${scopeType}
                WHEN 'all'     THEN true
                WHEN 'project' THEN pp.id = ${projectId}
                WHEN 'space'   THEN COALESCE(p.location_id, pp.location_id) IN (
                  -- BUG-SPACEFILTER-001: match on the PLANTING's own location first, project as
                  -- fallback (planting-level location wins — same rule the Today tab uses). A
                  -- planting reassigned to a sub-space (e.g. Drive > Trough) while its project
                  -- sits elsewhere (e.g. Pasture > Bag Area) was previously invisible to the
                  -- By-Space bulk filter, which only saw pp.location_id (the project's location).
                  -- V4-LOGMANYLOC-001: hierarchical cascade — a selected space matches its own
                  -- plantings PLUS every descendant location (recursive parent_id walk). A leaf
                  -- location with no children resolves to just itself (byte-identical to the old
                  -- exact-match behavior), so this is backward-compatible.
                  WITH RECURSIVE loc_subtree AS (
                    SELECT id FROM locations WHERE id = ${locationId} AND deleted_at IS NULL
                    UNION ALL
                    SELECT l.id FROM locations l
                      JOIN loc_subtree st ON l.parent_id = st.id
                      WHERE l.deleted_at IS NULL
                  )
                  SELECT id FROM loc_subtree
                )
                ELSE false
              END
          AND NOT (p.id = ANY(${excludeIds}))
        -- BUG-BATCHORDER-001: the scope SELECT had NO ORDER BY, so row order was whatever the
        -- planner handed back — the review list came back in arbitrary order, and the LIMIT 501 +
        -- slice(0,500) below was nondeterministic across calls. Scope is PREVIEW determinism +
        -- a sensible review order: the "if (capped) return resp(400)" guard at :228 fires before
        -- any write, so a >500 scope can never log the "wrong" plantings — dry-run and write cannot
        -- diverge. p.id is the tiebreaker: display_name is NOT unique (two "Sun Gold" plantings),
        -- and ties would leave the cap nondeterministic in miniature. The client sort in
        -- ScopeChecklist is presentation only and does not substitute for this.
        ORDER BY p.display_name, p.id
        LIMIT 501
      `;
      const capped = resolved.length > 500;
      const previewRows = resolved.slice(0, 500).map((r) => ({ id: r.plant_id, name: r.plant_name }));
      const plantIds = resolved.slice(0, 500).map((r) => r.plant_id);
      // dry_run: server-accurate preview (count + plantings), no write, no idempotency needed.
      if (dryRun) return resp(200, { count: plantIds.length, capped, plantings: previewRows });
      if (plantIds.length === 0) return resp(400, { error: 'No plantings matched the scope' });
      if (capped) return resp(400, { error: 'Too many plantings (>500) — narrow the scope' });
      const batchId = randomUUID();
      const scopeJson = JSON.stringify(scope);

      // (3) One transaction: batch row + resolve-and-insert events + per-project entity_memory.
      await sql.transaction([
        sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
        sql`INSERT INTO event_batches
              (id, idempotency_key, created_by, event_type, scope_json, event_date, item_count, status)
            VALUES (${batchId}, ${key}, ${userId}, ${eventType}, ${scopeJson}::jsonb,
                    ${eventDate}::timestamptz::date, ${plantIds.length}, 'complete')`,
        sql`INSERT INTO event_log
              (project_id, location_id, plant_id, event_type, event_date, is_public,
               logged_by, created_by, metadata)
            SELECT p.container_id, pp.location_id, p.id, ${eventType}, ${eventDate}::timestamptz, true,
                   ${userId}, ${userId},
                   jsonb_build_object('batch_id', ${batchId}::text, 'batch_v', 1)
            FROM public.garden_node p JOIN public.container pp ON pp.id = p.container_id
            WHERE p.id = ANY(${plantIds})`,
        sql`
          INSERT INTO entity_memory
            (project_id, last_event_at,
             last_watered_at, last_fertilized_at, last_pruned_at, last_observed_at, last_harvested_at,
             next_water_at, last_issue_at)
          SELECT DISTINCT p.container_id,
            ${eventDate}::timestamptz,
            CASE WHEN ${eventType} IN ('watering','rain')      THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'fertilizing' THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'pruning'       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'observation'   THEN ${eventDate}::timestamptz ELSE NULL END,
            NULL::timestamptz,
            CASE WHEN ${eventType} IN ('watering','rain')      THEN ${eventDate}::timestamptz + INTERVAL '4 days' ELSE NULL END,
            NULL::timestamptz
          FROM public.garden_node p WHERE p.id = ANY(${plantIds})
          ON CONFLICT (project_id) DO UPDATE SET
            last_event_at      = GREATEST(COALESCE(entity_memory.last_event_at,      ${eventDate}::timestamptz), ${eventDate}::timestamptz),
            last_watered_at    = CASE WHEN ${eventType} IN ('watering','rain')      THEN GREATEST(COALESCE(entity_memory.last_watered_at,    ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_watered_at    END,
            last_fertilized_at = CASE WHEN ${eventType} = 'fertilizing' THEN GREATEST(COALESCE(entity_memory.last_fertilized_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_fertilized_at END,
            last_pruned_at     = CASE WHEN ${eventType} = 'pruning'       THEN GREATEST(COALESCE(entity_memory.last_pruned_at,     ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_pruned_at     END,
            last_observed_at   = CASE WHEN ${eventType} = 'observation'   THEN GREATEST(COALESCE(entity_memory.last_observed_at,   ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_observed_at   END,
            next_water_at      = CASE WHEN ${eventType} IN ('watering','rain')
              THEN GREATEST(COALESCE(entity_memory.last_watered_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz)
                   + (COALESCE(entity_memory.watering_interval_days,
                       CASE entity_memory.location_type
                         WHEN 'indoor_seedling'   THEN 1
                         WHEN 'outdoor_container' THEN 2
                         WHEN 'outdoor_bed'       THEN 4
                         WHEN 'outdoor_inground'  THEN 5
                         WHEN 'indoor_mature'     THEN 5
                         ELSE 4
                       END)::int * INTERVAL '1 day')
              ELSE entity_memory.next_water_at
            END,
            updated_at = NOW()
        `,
        // V4-EVENTSEL-002 — batch trigger-parity: flowering + fruit_set advance planting
        // status exactly like the single-event path (the two UPDATEs in the single tx below),
        // forward-only and IDEMPOTENT via the *_SOURCE_STATUSES guard (a planting already at or
        // past the target status is simply not matched). Scoped to the already-resolved
        // owner-scoped plantIds + explicit household ownership (garden_node has no RLS, L-087).
        // No-op for every other event_type via the ${eventType} gate.
        sql`
          UPDATE public.garden_node p
             SET status = 'fruiting', updated_at = NOW()
            FROM public.container pp
           WHERE ${eventType}::text = 'fruit_set'
             AND p.id = ANY(${plantIds})
             AND p.container_id = pp.id
             AND pp.created_by = ANY(${householdIds})
             AND p.deleted_at IS NULL
             AND p.status = ANY(${FRUITING_SOURCE_STATUSES})
        `,
        sql`
          UPDATE public.garden_node p
             SET status = 'flowering', updated_at = NOW()
            FROM public.container pp
           WHERE ${eventType}::text = 'flowering'
             AND p.id = ANY(${plantIds})
             AND p.container_id = pp.id
             AND pp.created_by = ANY(${householdIds})
             AND p.deleted_at IS NULL
             AND p.status = ANY(${FLOWERING_SOURCE_STATUSES})
        `,
      ]);
      // MVP-Critter server-side hook (Phase B++ refactor 2026-05-30) — fetch inserted events
      // with plant_id + created_at, then call awardCrittersForBatch which awards critters
      // INLINE in the events Lambda (one prefs fetch reused across the whole batch).
      // Replaces the prior client-side fan-out (LogMany iterating event_ids).
      const insertedEvents = await sql`
        SELECT id, plant_id, created_at, metadata FROM event_log
         WHERE metadata->>'batch_id' = ${batchId}::text
           AND created_by = ${userId}
           AND deleted_at IS NULL
      `;
      try {
        const tzOffsetHeader = parseInt(event.headers?.['x-client-tz-offset'] ?? event.headers?.['X-Client-Tz-Offset'] ?? '0', 10);
        await awardCrittersForBatch({
          sql,
          userId,
          events: insertedEvents,
          householdId: userId,
          tzOffsetMin: Number.isFinite(tzOffsetHeader) ? tzOffsetHeader : 0,
        });
      } catch (critterErr) {
        console.warn('critter batch hook failed (non-fatal):', critterErr?.message ?? String(critterErr));
      }
      return resp(200, {
        batch_id: batchId,
        count: plantIds.length,
        // event_ids kept in response for backward-compat with Phase B+ clients (any deployed
        // Phase B+ build still iterates and calls /api/critters — UNIQUE INDEX makes those
        // idempotent re-hits). Will remove once all clients are Phase B++.
        event_ids: insertedEvents.map(r => r.id),
      });
    }

    // GET /api/events/batches — recent (non-undone) batches for the durable Undo affordance.
    if (rawPath === '/api/events/batches' && method === 'GET') {
      const rows = await sql`
        SELECT id, event_type, scope_json, item_count, event_date, created_at
        FROM event_batches
        WHERE created_by = ${userId} AND undone_at IS NULL AND status = 'complete'
        ORDER BY created_at DESC LIMIT 10
      `;
      return resp(200, { batches: rows });
    }

    // V3-FEED-001: paginated, filterable activity feed for the /feed page. Returns RAW events
    // (batch member rows included) created_at DESC; the client collapses batches over the
    // accumulated set and paginates via offset (so a batch split across a page boundary still
    // merges client-side). Filters are null-guarded with explicit casts (L-086 42P18-safe).
    // Forward-looking critter join (cs.*) lets the feed surface a critter earned at logging time
    // (V4 social-feed vision). Event-entity read -> household-scoped (counts toward the surgical
    // widening invariant in household-mode.test.js).
    if (rawPath === '/api/events/feed' && method === 'GET') {
      const qp = event.queryStringParameters ?? {};
      const limit = Math.min(parseInt(qp.limit ?? '30', 10) || 30, 100);
      const offset = Math.max(parseInt(qp.offset ?? '0', 10) || 0, 0);
      const fProject = qp.project_id || null;
      const fType = qp.event_type || null;
      const fFrom = qp.from || null;
      const fTo = qp.to || null;
      const rows = await sql`
        SELECT
          e.id, e.project_id, e.plant_id, e.event_type, e.event_date, e.created_at, e.notes,
          e.metadata->>'batch_id' AS batch_id,
          eb.item_count,
          pp.display_name AS project_name,
          pr.display_name AS logged_by_name,
          cs.id AS critter_id, cs.species_id AS critter_species_id
        FROM event_log e
        JOIN public.container pp ON pp.id = e.project_id
        LEFT JOIN profiles pr ON pr.id = e.logged_by
        LEFT JOIN event_batches eb ON eb.id::text = e.metadata->>'batch_id'
        LEFT JOIN public.critter_state cs ON cs.source_event_id = e.id AND cs.deleted_at IS NULL
        WHERE pp.created_by = ANY(${householdIds})
          AND e.deleted_at IS NULL
          AND pp.archived_at IS NULL
          AND (${fProject}::uuid IS NULL OR e.project_id = ${fProject}::uuid)
          AND (${fType}::text IS NULL OR e.event_type = ${fType}::text)
          AND (${fFrom}::timestamptz IS NULL OR e.event_date >= ${fFrom}::timestamptz)
          AND (${fTo}::timestamptz IS NULL OR e.event_date <= ${fTo}::timestamptz)
        ORDER BY e.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return resp(200, { events: rows, limit, offset, has_more: rows.length === limit });
    }

    // DELETE /api/events/batch/:id — undo a batch (soft-delete its events + recompute watering memory).
    const batchUndo = rawPath.match(/^\/api\/events\/batch\/([^/]+)$/);
    if (batchUndo && method === 'DELETE') {
      const batchId = batchUndo[1];
      if (!UUID_RE.test(batchId)) return resp(404, { error: 'Not found' });
      const owned = await sql`
        SELECT id FROM event_batches
        WHERE id = ${batchId} AND created_by = ${userId} AND undone_at IS NULL
      `;
      if (!owned.length) return resp(404, { error: 'Not found' });

      await sql.transaction([
        sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
        sql`UPDATE event_log SET deleted_at = NOW(), updated_at = NOW()
            WHERE metadata->>'batch_id' = ${batchId} AND deleted_at IS NULL`,
        sql`
          WITH affected AS (
            SELECT DISTINCT project_id FROM event_log WHERE metadata->>'batch_id' = ${batchId}
          ),
          surv AS (
            SELECT a.project_id,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.project_id = a.project_id AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL) AS mw
            FROM affected a
          )
          UPDATE entity_memory em SET
            last_watered_at = surv.mw,
            next_water_at = CASE WHEN surv.mw IS NULL THEN NULL ELSE
              surv.mw + (COALESCE(em.watering_interval_days,
                CASE em.location_type
                  WHEN 'indoor_seedling'   THEN 1
                  WHEN 'outdoor_container' THEN 2
                  WHEN 'outdoor_bed'       THEN 4
                  WHEN 'outdoor_inground'  THEN 5
                  WHEN 'indoor_mature'     THEN 5
                  ELSE 4
                END)::int * INTERVAL '1 day')
            END,
            updated_at = NOW()
          FROM surv WHERE em.project_id = surv.project_id
        `,
        sql`UPDATE event_batches SET undone_at = NOW() WHERE id = ${batchId}`,
      ]);
      return resp(200, { undone: true, batch_id: batchId });
    }

    // ── Route 2/3 (F10 precedence): /api/events/:id (PATCH then GET) ──────────────────────────
    const idMatch = rawPath.match(/^\/api\/events\/([^/]+)$/);
    if (idMatch) {
      const eventId = idMatch[1];
      // F9 — UUID pre-validation returns 404 (existence-oblivious, no parse oracle)
      if (!UUID_RE.test(eventId)) return resp(404, { error: 'Not found' });

      if (method === 'PATCH') {
        const body = JSON.parse(event.body ?? '{}');
        if (body.resolved !== true) return resp(400, { error: 'resolved must be true' });

        // §2.3 — single-statement UPDATE with auth via plant_projects join.
        // F8 NOW()-relative achievement gate in RETURNING (not preserved resolved_at).
        // F26 resolved_by COALESCE preserves first-resolver on idempotent re-PATCH.
        const updated = await sql`
          UPDATE event_log el
          SET resolved_at = COALESCE(el.resolved_at, NOW()),
              resolved_by = COALESCE(el.resolved_by, ${userId}),
              updated_at  = NOW()
          FROM public.container pp
          WHERE el.id = ${eventId}
            AND el.flagged_as_issue = true
            AND el.deleted_at IS NULL
            AND pp.id = el.project_id
            AND pp.created_by = ANY(${householdIds})
            AND pp.deleted_at IS NULL
          RETURNING
            el.id, el.project_id, el.event_type, el.flagged_as_issue,
            el.severity, el.resolved_at, el.resolved_by, el.created_at,
            (NOW() >= el.created_at + INTERVAL '24 hours') AS qualifies_for_achievement
        `;
        if (!updated.length) return resp(404, { error: 'Not found' });
        const row = updated[0];

        // Pre-fetch timezone for distinct-days computation. COALESCE to America/New_York.
        const tzRows = await sql`
          SELECT COALESCE(
            (SELECT user_timezone FROM profiles WHERE id = ${userId}),
            'America/New_York'
          ) AS tz
        `;
        const userTz = tzRows[0].tz;

        // §2.5 issue_resolve_count achievement evaluator.
        // F20 caretaker (count>=10) requires >=3 distinct calendar days.
        // RETURNING-gate chain is the race mitigation for parallel PATCH-resolves crossing same threshold.
        let newlyEarned = [];
        let xpGained = 0;
        if (row.qualifies_for_achievement) {
          try {
            const earnedRows = await sql`
              WITH resolved_set AS (
                SELECT
                  el.id,
                  el.resolved_at,
                  DATE(el.resolved_at AT TIME ZONE ${userTz}) AS resolve_day
                FROM event_log el
                JOIN public.container pp ON pp.id = el.project_id
                WHERE pp.created_by = ${userId}
                  AND pp.deleted_at IS NULL
                  AND el.deleted_at IS NULL
                  AND el.flagged_as_issue = true
                  AND el.resolved_at IS NOT NULL
                  AND el.resolved_at >= el.created_at + INTERVAL '24 hours'
              ),
              resolved_stats AS (
                SELECT
                  COUNT(*)::int AS cnt,
                  COUNT(DISTINCT resolve_day)::int AS distinct_days
                FROM resolved_set
              ),
              candidates AS (
                SELECT a.id, a.xp_reward, a.slug
                FROM achievements a, resolved_stats rs
                WHERE a.is_active = true
                  AND a.trigger_type = 'issue_resolve_count'
                  AND NOT EXISTS (
                    SELECT 1 FROM user_achievements ua
                    WHERE ua.user_id = ${userId} AND ua.achievement_id = a.id
                  )
                  AND rs.cnt >= (a.trigger_value->>'count')::int
                  AND (
                    (a.trigger_value->>'count')::int < 10
                    OR rs.distinct_days >= COALESCE((a.trigger_value->>'min_distinct_days')::int, 3)
                  )
              ),
              inserted AS (
                INSERT INTO user_achievements (user_id, achievement_id, trigger_event_id)
                SELECT ${userId}, c.id, ${eventId}::uuid FROM candidates c
                ON CONFLICT (user_id, achievement_id) DO NOTHING
                RETURNING achievement_id
              ),
              xp_grants AS (
                INSERT INTO xp_events (user_id, amount, reason, source_id)
                SELECT ${userId}, a.xp_reward, 'achievement_earned', i.achievement_id
                FROM inserted i JOIN achievements a ON a.id = i.achievement_id
                RETURNING amount, source_id
              ),
              stats_xp AS (
                UPDATE user_stats
                  SET xp = user_stats.xp + COALESCE((SELECT SUM(amount) FROM xp_grants), 0),
                      updated_at = NOW()
                WHERE user_id = ${userId}
                  AND EXISTS (SELECT 1 FROM xp_grants)
                RETURNING xp
              )
              SELECT
                COALESCE(
                  (SELECT json_agg(
                     json_build_object('slug', a.slug, 'name', a.name, 'emoji', a.emoji, 'xp_reward', a.xp_reward)
                     ORDER BY a.sort_order
                   )
                   FROM xp_grants xg JOIN achievements a ON a.id = xg.source_id),
                  '[]'::json
                ) AS newly_earned,
                COALESCE((SELECT SUM(amount) FROM xp_grants), 0)::int AS xp_total
            `;
            if (earnedRows.length) {
              newlyEarned = earnedRows[0].newly_earned ?? [];
              xpGained = earnedRows[0].xp_total ?? 0;
            }
          } catch (achErr) {
            console.warn('resolve achievement eval failed (non-fatal)', achErr.message);
          }
        }

        // §2.6 telemetry — only on UPDATE-success path (skip on 404)
        try {
          await sql`
            INSERT INTO app_events (user_clerk_sub, event_name, event_source, metadata)
            VALUES (${userId}, 'event_resolved', 'lambda',
              ${{ event_id: eventId, project_id: row.project_id, severity: row.severity, qualified: row.qualifies_for_achievement }})
          `;
        } catch (telErr) {
          console.warn('resolve telemetry failed (non-fatal)', telErr.message);
        }

        return resp(200, {
          id: row.id,
          project_id: row.project_id,
          event_type: row.event_type,
          flagged_as_issue: row.flagged_as_issue,
          severity: row.severity,
          resolved_at: row.resolved_at,
          resolved_by: row.resolved_by,
          newly_earned_achievements: newlyEarned,
          xp_gained: xpGained,
        });
      }

      if (method === 'GET') {
        const rows = await sql`
          SELECT
            e.id, e.project_id, e.location_id, e.plant_id,
            e.event_type, e.event_date, e.notes, e.private_notes,
            e.quantity, e.is_public, e.logged_by, e.created_at,
            e.metadata,
            e.flagged_as_issue, e.severity, e.resolved_at,
            pp.display_name AS project_name
          FROM event_log e
          JOIN public.container pp ON pp.id = e.project_id
          WHERE e.id = ${eventId}
            AND e.deleted_at IS NULL
            AND pp.created_by = ANY(${householdIds})
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      // DELETE /api/events/:id — single-event undo. SOFT-DELETE ONLY (deleted_at; never
      // hard-delete) + watering entity_memory recompute, mirroring the batch-undo path above.
      // Callers: Dashboard 5s undo toast, EventDetail delete, ProjectDetail delete.
      // XP/streak/achievements are NOT reversed here (same as batch undo — reconciliation
      // cron concern, V1.2a-2).
      if (method === 'DELETE') {
        const owned = await sql`
          SELECT el.id, el.project_id, el.event_type
          FROM event_log el
          JOIN public.container pp ON pp.id = el.project_id
          WHERE el.id = ${eventId}
            AND el.deleted_at IS NULL
            AND pp.created_by = ANY(${householdIds})
            AND pp.deleted_at IS NULL
        `;
        if (!owned.length) return resp(404, { error: 'Not found' });
        const projectId = owned[0].project_id;
        const stmts = [
          sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
          sql`UPDATE event_log SET deleted_at = NOW(), updated_at = NOW()
              WHERE id = ${eventId} AND deleted_at IS NULL`,
        ];
        if (owned[0].event_type === 'watering' || owned[0].event_type === 'rain') {
          // Recompute watering memory from SURVIVING events (runs after the soft-delete in
          // the same transaction, so MAX() excludes the undone event) — batch-undo parity.
          stmts.push(sql`
            WITH surv AS (
              SELECT (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.project_id = ${projectId} AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL) AS mw
            )
            UPDATE entity_memory em SET
              last_watered_at = surv.mw,
              next_water_at = CASE WHEN surv.mw IS NULL THEN NULL ELSE
                surv.mw + (COALESCE(em.watering_interval_days,
                  CASE em.location_type
                    WHEN 'indoor_seedling'   THEN 1
                    WHEN 'outdoor_container' THEN 2
                    WHEN 'outdoor_bed'       THEN 4
                    WHEN 'outdoor_inground'  THEN 5
                    WHEN 'indoor_mature'     THEN 5
                    ELSE 4
                  END)::int * INTERVAL '1 day')
              END,
              updated_at = NOW()
            FROM surv WHERE em.project_id = ${projectId}
          `);
        }
        await sql.transaction(stmts);
        return resp(200, { undone: true, id: eventId });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // ── Route 4: /api/events (collection) ──────────────────────────────────────────────────────
    if (method === 'GET') {
      const projectId = event.queryStringParameters?.project_id ?? null;
      // HS-2 (V002 §4 / Lane C): planting-scoped server-side filter. PlantingDetail passes
      // &plant_id= so the LIMIT applies to THIS planting's events, not the whole project.
      // Without it, on a busy project older planting events fall off the 200 cap and the
      // planting falsely shows "no events" (a silent lie). plant_id already exists per row.
      const plantId = event.queryStringParameters?.plant_id ?? null;
      const limit = Math.min(parseInt(event.queryStringParameters?.limit ?? '50', 10), 200);

      // project_id + plant_id: planting-scoped (HS-2). Filter by plant_id BEFORE the LIMIT.
      const rows = (projectId && plantId)
        ? await sql`
            SELECT
              e.id, e.project_id, e.location_id, e.plant_id,
              e.event_type, e.event_date, e.notes,
              e.quantity, e.is_public, e.logged_by, e.created_at,
              e.metadata,
              pp.display_name AS project_name
            FROM event_log e
            JOIN public.container pp ON pp.id = e.project_id
            WHERE pp.created_by = ANY(${householdIds})
              AND e.project_id = ${projectId}
              AND e.plant_id = ${plantId}
              AND e.deleted_at IS NULL
            ORDER BY e.event_date DESC, e.created_at DESC
            LIMIT ${limit}
          `
        : projectId
        ? await sql`
            SELECT
              e.id, e.project_id, e.location_id, e.plant_id,
              e.event_type, e.event_date, e.notes,
              e.quantity, e.is_public, e.logged_by, e.created_at,
              e.metadata,
              pp.display_name AS project_name
            FROM event_log e
            JOIN public.container pp ON pp.id = e.project_id
            WHERE pp.created_by = ANY(${householdIds})
              AND e.project_id = ${projectId}
              AND e.deleted_at IS NULL
            ORDER BY e.event_date DESC, e.created_at DESC
            LIMIT ${limit}
          `
        : await sql`
            SELECT
              e.id, e.project_id, e.location_id, e.plant_id,
              e.event_type, e.event_date, e.notes,
              e.quantity, e.is_public, e.logged_by, e.created_at,
              e.metadata,
              pp.display_name AS project_name
            FROM event_log e
            JOIN public.container pp ON pp.id = e.project_id
            WHERE pp.created_by = ANY(${householdIds})
              AND e.deleted_at IS NULL
            ORDER BY e.event_date DESC, e.created_at DESC
            LIMIT ${limit}
          `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const vErr = validatePostBody(body);
      if (vErr) return resp(vErr.status, { error: vErr.error });

      const eventDate = normalizeEventDate(body.event_date) ?? new Date().toISOString();
      const eventType = body.event_type;
      const projectId = body.project_id;
      const metadata = body.metadata ?? null;
      // B8 — normalize flagged_as_issue ONCE; use throughout SQL bindings.
      const flagged = body.flagged_as_issue === true;
      const severity = flagged ? body.severity : null;
      // V4-TREATLOG-001: structured treatment capture (pest_treatment / doctored). All nullable;
      // only recorded for those two types so a stray field on other events is ignored.
      const isTreatment = eventType === 'pest_treatment' || eventType === 'doctored';
      const treatmentProductId   = isTreatment ? (body.treatment_product_id ?? null) : null;
      const treatmentProductText = isTreatment ? (body.treatment_product_text ?? null) : null;
      const treatmentCategory    = isTreatment ? (body.treatment_category ?? null) : null;
      const treatmentAmount      = isTreatment ? (body.treatment_amount ?? null) : null;
      const pestTarget           = isTreatment ? (body.pest_target ?? null) : null;
      const isHarvest = eventType === 'harvest';
      const harvestQty = isHarvest ? body.harvest.quantity : null;
      const harvestUnit = isHarvest ? body.harvest.unit : null;
      const harvestQuality = isHarvest ? (body.harvest.quality_rating ?? null) : null;
      const harvestNotes = isHarvest ? (body.harvest.notes ?? null) : null;

      // ── Step 1: pre-fetch user_timezone (COALESCE to America/New_York) ───────────────────────
      const tzRows = await sql`
        SELECT COALESCE(
          (SELECT user_timezone FROM profiles WHERE id = ${userId}),
          'America/New_York'
        ) AS tz
      `;
      const userTz = tzRows[0].tz;

      // ── Step 2: atomic transaction — set_config + dual-write CTE + entity_memory UPSERT ──────
      // Statement 2 (CTE): event_log + harvest_log (conditional) via WITH new_event AS / new_harvest AS.
      // F3 quantity_numeric synced for harvest events. F15 explicit RETURNING allow-list (no *).
      // F12 JS extraction: harvest_row stripped from row, exposed as `harvest` key.
      // Statement 3: entity_memory UPSERT with last_issue_at (F2 — present in INSERT col list, VALUES,
      // and ON CONFLICT branch). B1 prod vocabulary: 'watering' / 'fertilizing' / 'pruning' /
      // 'observation' / 'harvest' verbatim.
      const txResult = await sql.transaction([
        sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
        sql`
          WITH new_event AS (
            INSERT INTO event_log
              (project_id, location_id, plant_id, event_type, event_date,
               notes, private_notes, quantity, quantity_numeric, is_public,
               logged_by, created_by, metadata,
               flagged_as_issue, severity,
               treatment_product_id, treatment_product_text, treatment_category, treatment_amount, pest_target)
            VALUES (
              ${projectId},
              ${body.location_id ?? null},
              ${body.plant_id ?? null},
              ${eventType},
              ${eventDate}::timestamptz,
              ${body.notes ?? null},
              ${body.private_notes ?? null},
              ${body.quantity ?? null},
              ${harvestQty}::numeric,
              ${body.is_public ?? true},
              ${userId},
              ${userId},
              ${metadata},
              ${flagged},
              ${severity},
              ${treatmentProductId},
              ${treatmentProductText},
              ${treatmentCategory},
              ${treatmentAmount},
              ${pestTarget}
            )
            RETURNING
              id, project_id, location_id, plant_id, event_type, event_date,
              notes, private_notes, quantity, quantity_numeric, is_public,
              logged_by, created_by, metadata,
              flagged_as_issue, severity, resolved_at, resolved_by,
              treatment_product_id, treatment_product_text, treatment_category, treatment_amount, pest_target,
              created_at, updated_at
          ),
          new_harvest AS (
            INSERT INTO harvest_log
              (event_id, project_id, quantity, unit, quality_rating, notes, created_by)
            SELECT
              ne.id, ne.project_id,
              ${harvestQty}::numeric,
              ${harvestUnit},
              ${harvestQuality}::smallint,
              ${harvestNotes},
              ${userId}
            FROM new_event ne
            WHERE ${isHarvest}::boolean = true
            RETURNING id, quantity, unit, quality_rating, notes
          )
          SELECT
            ne.*,
            (SELECT row_to_json(nh) FROM new_harvest nh) AS harvest_row
          FROM new_event ne
        `,
        sql`
          INSERT INTO entity_memory
            (project_id, last_event_at,
             last_watered_at, last_fertilized_at, last_pruned_at, last_observed_at, last_harvested_at,
             next_water_at, last_issue_at)
          VALUES (
            ${projectId},
            ${eventDate}::timestamptz,
            CASE WHEN ${eventType} IN ('watering','rain')      THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'fertilizing' THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'pruning'       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'observation'   THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'harvest'       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} IN ('watering','rain')      THEN ${eventDate}::timestamptz + INTERVAL '4 days' ELSE NULL END,
            CASE WHEN ${flagged}::boolean = true     THEN ${eventDate}::timestamptz ELSE NULL END
          )
          ON CONFLICT (project_id) DO UPDATE SET
            last_event_at      = GREATEST(COALESCE(entity_memory.last_event_at,      ${eventDate}::timestamptz), ${eventDate}::timestamptz),
            last_watered_at    = CASE WHEN ${eventType} IN ('watering','rain')      THEN GREATEST(COALESCE(entity_memory.last_watered_at,    ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_watered_at    END,
            last_fertilized_at = CASE WHEN ${eventType} = 'fertilizing' THEN GREATEST(COALESCE(entity_memory.last_fertilized_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_fertilized_at END,
            last_pruned_at     = CASE WHEN ${eventType} = 'pruning'       THEN GREATEST(COALESCE(entity_memory.last_pruned_at,     ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_pruned_at     END,
            last_observed_at   = CASE WHEN ${eventType} = 'observation'   THEN GREATEST(COALESCE(entity_memory.last_observed_at,   ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_observed_at   END,
            last_harvested_at  = CASE WHEN ${eventType} = 'harvest'       THEN GREATEST(COALESCE(entity_memory.last_harvested_at,  ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_harvested_at  END,
            next_water_at      = CASE WHEN ${eventType} IN ('watering','rain')
              THEN GREATEST(COALESCE(entity_memory.last_watered_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz)
                   + (COALESCE(
                       entity_memory.watering_interval_days,
                       CASE entity_memory.location_type
                         WHEN 'indoor_seedling'   THEN 1
                         WHEN 'outdoor_container' THEN 2
                         WHEN 'outdoor_bed'       THEN 4
                         WHEN 'outdoor_inground'  THEN 5
                         WHEN 'indoor_mature'     THEN 5
                         ELSE 4
                       END
                     )::int * INTERVAL '1 day')
              ELSE entity_memory.next_water_at
            END,
            last_issue_at      = CASE WHEN ${flagged}::boolean = true
              THEN GREATEST(COALESCE(entity_memory.last_issue_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz)
              ELSE entity_memory.last_issue_at
            END,
            updated_at = NOW()
        `,
        // V3-FRUITSET-001: logging a `fruit_set` event on a specific planting auto-advances
        // it to 'fruiting' (forward-only). garden_node has no RLS, so ownership is scoped
        // explicitly via container.created_by = ANY(householdIds) (L-087). No-op on every
        // non-fruit_set event (the ${eventType} gate) and when plant_id is null / status is
        // terminal / already fruiting. Status-change-as-event row is V3-EVENT-003, not here.
        sql`
          UPDATE public.garden_node p
             SET status = 'fruiting', updated_at = NOW()
            FROM public.container pp
           WHERE ${eventType}::text = 'fruit_set'
             AND p.id = ${body.plant_id ?? null}
             AND p.container_id = pp.id
             AND pp.created_by = ANY(${householdIds})
             AND p.deleted_at IS NULL
             AND p.status = ANY(${FRUITING_SOURCE_STATUSES})
        `,
        // V3-FLOWERING-001: logging a `flowering` event on a specific planting auto-advances
        // it to 'flowering' (forward-only). Same explicit household ownership scope + no-RLS
        // caveat as the fruit_set UPDATE above (L-087). No-op on every non-flowering event
        // (the ${eventType} gate) and when plant_id is null / status is already flowering-or-later
        // / terminal. Status-change-as-event row is V3-EVENT-003, not here.
        sql`
          UPDATE public.garden_node p
             SET status = 'flowering', updated_at = NOW()
            FROM public.container pp
           WHERE ${eventType}::text = 'flowering'
             AND p.id = ${body.plant_id ?? null}
             AND p.container_id = pp.id
             AND pp.created_by = ANY(${householdIds})
             AND p.deleted_at IS NULL
             AND p.status = ANY(${FLOWERING_SOURCE_STATUSES})
        `,
      ]);

      // F12 — JS-side extraction of harvest sub-row from the joined CTE row.
      const newEvent = txResult[1][0];
      const harvest = newEvent.harvest_row;
      delete newEvent.harvest_row;
      newEvent.harvest = harvest;
      const eventId = newEvent.id;

      // MVP-Critter server-side hook (Phase B++ refactor 2026-05-30) — fire awardCritterServer
      // for the inserted event. Inline (same Lambda, same DB connection); critter_state row
      // exists by the time this POST returns 201 → Dashboard backfill on next navigate finds
      // it deterministically (no race). Plant-only per MVP §1.1: silent no-op when plant_id null.
      // NEVER throws — internal try/catch + console.warn telemetry per spec §3.10.
      try {
        // Smoke / admin can bypass server-side awarding by setting metadata._skip_critter_award: true.
        // Production frontend NEVER sets this — it lets the hook do its thing.
        const skipAward = newEvent.metadata && (newEvent.metadata._skip_critter_award === true);
        if (!skipAward && newEvent.plant_id) {
          const tzOffsetHeader = parseInt(event.headers?.['x-client-tz-offset'] ?? event.headers?.['X-Client-Tz-Offset'] ?? '0', 10);
          // Fetch prefs + species prefs once for this event (cheap; one-row lookups).
          let critterPrefs = null;
          let speciesPrefs = {};
          try {
            critterPrefs = await readPrefsForCritter(sql, userId);
            speciesPrefs = await readSpeciesPrefsForCritter(sql, userId);
          } catch (prefsErr) {
            console.warn('critter prefs fetch failed (using defaults):', prefsErr?.message ?? String(prefsErr));
          }
          await awardCritterServer({
            sql,
            userId,
            eventId,
            plantId: newEvent.plant_id,
            eventCreatedAt: newEvent.created_at,
            householdId: userId,
            tzOffsetMin: Number.isFinite(tzOffsetHeader) ? tzOffsetHeader : 0,
            prefs: critterPrefs,
            speciesPrefs,
            // speciesMultipliers: future season/milestone config (V4 blocker). Empty = use base_probability.
            speciesMultipliers: {},
          });
        }
      } catch (critterErr) {
        console.warn('critter award hook failed (non-fatal):', critterErr?.message ?? String(critterErr));
      }

      // ── Step 3a: user_stats streak — recompute from DISTINCT activity days ──────────────────
      // V1.2-streak-fix (2026-05-25): the streak counts DISTINCT calendar days with activity, keyed
      // on event_date in the user's TZ — NOT the logging moment. This is why bulk/backfilled
      // consecutive days now count (old NOW()-based math credited only the day you pressed log).
      // The pure helper (./streak.js) owns the math; the dashboard recomputes the same way at read
      // time so a stale streak never lingers. Break-recovery: graceDays=1 forgives one missed day.
      let achievementResult = { newly_earned: [], current_streak: null, total_events: null };
      try {
        const actRows = await sql`
          WITH z AS (SELECT ${userTz}::text AS tz)
          SELECT
            to_char((NOW() AT TIME ZONE (SELECT tz FROM z))::date, 'YYYY-MM-DD') AS today,
            COALESCE((
              SELECT json_agg(d ORDER BY d DESC) FROM (
                SELECT DISTINCT (e.event_date AT TIME ZONE (SELECT tz FROM z))::date AS d
                FROM event_log e
                WHERE e.created_by = ${userId}
                  AND e.deleted_at IS NULL
                  AND (e.event_date AT TIME ZONE (SELECT tz FROM z))::date
                      <= (NOW() AT TIME ZONE (SELECT tz FROM z))::date
              ) days
            ), '[]'::json) AS days
        `;
        const todayStr = actRows[0]?.today ?? null;
        const activityDays = (actRows[0]?.days ?? []).map((d) => String(d).slice(0, 10));
        const { current, longest } = computeStreak(activityDays, todayStr, STREAK_GRACE_DAYS);
        const latestDay = activityDays.length ? activityDays[0] : todayStr;

        const statsRows = await sql`
          INSERT INTO user_stats (user_id, total_events, last_active_date, current_streak, longest_streak)
          VALUES (${userId}, 1, ${latestDay}::date, ${current}, ${longest})
          ON CONFLICT (user_id) DO UPDATE SET
            total_events     = user_stats.total_events + 1,
            current_streak   = ${current},
            longest_streak   = GREATEST(user_stats.longest_streak, ${longest}),
            last_active_date = ${latestDay}::date,
            updated_at       = NOW()
          RETURNING current_streak, total_events
        `;
        if (statsRows.length) {
          achievementResult.current_streak = statsRows[0].current_streak;
          achievementResult.total_events   = statsRows[0].total_events;
        }
      } catch (statsErr) {
        console.warn('user_stats streak upsert failed (non-fatal)', statsErr.message);
      }

      // ── Step 3b: inline achievement evaluation for existing trigger types ────────────────────
      // F17 brief override: harvest_quantity / harvest_quality CASE branches DEFERRED to V4.
      // issue_resolve_count is resolve-path-only by design — intentional no-op on POST.
      // harvest_century works automatically via the existing event_type_count evaluator (count of
      // event_type='harvest' events); no special handling needed for V1.2a-2 ship.
      // F16: no daily cap on achievement XP — encouragement-class grants stay uncapped.
      try {
        if (achievementResult.current_streak != null) {
          const streakVal = achievementResult.current_streak;
          const totalVal  = achievementResult.total_events;
          const earnedRows = await sql`
            WITH today_in_tz AS (
              SELECT (NOW() AT TIME ZONE ${userTz})::date AS today_date,
                     EXTRACT(HOUR FROM (NOW() AT TIME ZONE ${userTz}))::int AS hour_in_tz
            ),
            event_counts AS (
              SELECT
                COUNT(*) FILTER (WHERE event_type = ${eventType})::int AS type_events,
                COUNT(*) FILTER (
                  WHERE (event_date AT TIME ZONE ${userTz})::date = (SELECT today_date FROM today_in_tz)
                )::int AS today_events
              FROM event_log
              WHERE created_by = ${userId} AND deleted_at IS NULL
            ),
            candidates AS (
              SELECT a.id, a.xp_reward
              FROM achievements a, event_counts ec, today_in_tz t
              WHERE a.is_active = true
                AND NOT EXISTS (
                  SELECT 1 FROM user_achievements ua
                  WHERE ua.user_id = ${userId} AND ua.achievement_id = a.id
                )
                AND CASE a.trigger_type
                  WHEN 'streak'           THEN ${streakVal}::int >= (a.trigger_value->>'days')::int
                  WHEN 'event_count'      THEN ${totalVal}::int  >= (a.trigger_value->>'count')::int
                  WHEN 'event_type_count' THEN
                    (a.trigger_value->>'type') = ${eventType}
                    AND ec.type_events >= (a.trigger_value->>'count')::int
                    AND NOT (a.trigger_value ? 'has_private_notes')
                  WHEN 'time_of_day'      THEN
                    (a.trigger_value ? 'hour_gte' AND t.hour_in_tz >= (a.trigger_value->>'hour_gte')::int)
                    OR
                    (a.trigger_value ? 'hour_lt'  AND t.hour_in_tz <  (a.trigger_value->>'hour_lt')::int)
                  WHEN 'multi_per_day'    THEN ec.today_events >= (a.trigger_value->>'count')::int
                  ELSE false
                END
            ),
            inserted AS (
              INSERT INTO user_achievements (user_id, achievement_id, trigger_event_id)
              SELECT ${userId}, c.id, ${eventId}::uuid FROM candidates c
              ON CONFLICT (user_id, achievement_id) DO NOTHING
              RETURNING achievement_id
            ),
            xp_grants AS (
              INSERT INTO xp_events (user_id, amount, reason, source_id)
              SELECT ${userId}, a.xp_reward, 'achievement_earned', i.achievement_id
              FROM inserted i JOIN achievements a ON a.id = i.achievement_id
              RETURNING amount, source_id
            ),
            stats_xp AS (
              UPDATE user_stats
                SET xp = user_stats.xp + COALESCE((SELECT SUM(amount) FROM xp_grants), 0),
                    updated_at = NOW()
              WHERE user_id = ${userId}
                AND EXISTS (SELECT 1 FROM xp_grants)
              RETURNING xp
            )
            SELECT COALESCE(
              (SELECT json_agg(
                 json_build_object('slug', a.slug, 'name', a.name, 'emoji', a.emoji, 'xp_reward', a.xp_reward)
                 ORDER BY a.sort_order
               )
               FROM xp_grants xg JOIN achievements a ON a.id = xg.source_id),
              '[]'::json
            ) AS newly_earned
          `;
          if (earnedRows.length) {
            achievementResult.newly_earned = earnedRows[0].newly_earned ?? [];
          }
        }
      } catch (achErr) {
        console.warn('achievement eval failed (non-fatal)', achErr.message);
      }

      // ── Step 4: flat XP grant with daily cap (timezone-aware) ────────────────────────────────
      let flatXpResult = { granted: 0, today_total: 0, daily_xp_remaining: DAILY_FLAT_XP_CAP };
      try {
        const rows = await sql`
          WITH today_xp AS (
            SELECT COALESCE(SUM(amount), 0)::int AS today_sum
            FROM xp_events
            WHERE user_id = ${userId}
              AND reason = 'event_logged'
              AND (created_at AT TIME ZONE ${userTz})::date = (NOW() AT TIME ZONE ${userTz})::date
          ),
          flat_grant AS (
            INSERT INTO xp_events (user_id, amount, reason, source_id)
            SELECT ${userId}, ${FLAT_XP_PER_EVENT}, 'event_logged', ${eventId}::uuid
            FROM today_xp
            WHERE today_sum < ${DAILY_FLAT_XP_CAP}
            RETURNING amount
          ),
          stats AS (
            UPDATE user_stats
              SET xp = user_stats.xp + COALESCE((SELECT amount FROM flat_grant), 0),
                  updated_at = NOW()
            WHERE user_id = ${userId}
            RETURNING xp
          )
          SELECT
            COALESCE((SELECT amount FROM flat_grant), 0)::int AS granted,
            ((SELECT today_sum FROM today_xp) + COALESCE((SELECT amount FROM flat_grant), 0))::int AS today_total
        `;
        if (rows.length) {
          flatXpResult.granted     = rows[0].granted;
          flatXpResult.today_total = rows[0].today_total;
          flatXpResult.daily_xp_remaining = Math.max(0, DAILY_FLAT_XP_CAP - rows[0].today_total);
        }
      } catch (xpErr) {
        console.warn('flat XP grant failed (non-fatal)', xpErr.message);
      }

      // ── Step 5: app_events telemetry ────────────────────────────────────────────────────────
      try {
        const telemetryEvents = [{
          name: 'log_entry_created',
          metadata: { event_type: eventType, project_id: projectId, event_id: eventId },
        }];
        if (flatXpResult.granted === 0 && flatXpResult.today_total >= DAILY_FLAT_XP_CAP) {
          telemetryEvents.push({
            name: 'daily_xp_capped',
            metadata: { event_id: eventId, today_total: flatXpResult.today_total },
          });
        }
        for (const t of telemetryEvents) {
          await sql`
            INSERT INTO app_events (user_clerk_sub, event_name, event_source, metadata)
            VALUES (${userId}, ${t.name}, 'lambda', ${t.metadata})
          `;
        }
      } catch (telErr) {
        console.warn('app_events telemetry failed (non-fatal)', telErr.message);
      }

      // F16 — achievement XP is uncapped; xp_gained sums flat + all earned-achievement rewards.
      const xpFromAchievements = achievementResult.newly_earned.reduce((s, a) => s + (a.xp_reward ?? 0), 0);
      return resp(201, {
        ...newEvent,
        newly_earned_achievements: achievementResult.newly_earned,
        updated_streak: achievementResult.current_streak,
        xp_gained: flatXpResult.granted + xpFromAchievements,
        daily_xp_remaining: flatXpResult.daily_xp_remaining,
      });
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('events lambda error', err);
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    if (err.code === '23505') return resp(409, { error: `Unique violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};

