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
import { validatePostBody, validateBatchBody, validateHarvestFields, validateTreatmentCategory, HARVEST_UNITS, MAX_PLAUSIBLE, UUID_RE, normalizeEventDate, toGrams, isUserSuppliedWeight } from './validators.js';
import { validateClear, resolveFlagPair } from './clearFields.js';
import { computeStreak, STREAK_GRACE_DAYS } from './streak.js';
import { householdScope, loadOwnedLocation, loadOwnedInventoryItem, warnRejectedFk } from './household.js';
import { FRUITING_SOURCE_STATUSES, FLOWERING_SOURCE_STATUSES } from './statusTransitions.js';
import { awardCritterServer, readUserPrefs as readPrefsForCritter, readSpeciesPrefs as readSpeciesPrefsForCritter } from './critterAward.js';
import { applyBatchSideEffects } from './batchSideEffects.js';
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

// ── Write-FK ownership loaders (BUG-EVENTSOWN-001) ────────────────────────────────────────────
// A DB foreign key proves the referenced row EXISTS; it never proves the caller OWNS it. Contract,
// verbatim from the shipped loaders: return the row or null, and answer null with a GENERIC 400 —
// never "not found" vs "forbidden", because that distinction is itself a leak.
//
// Ownership predicates live in ./authz-parents.js — one canonical body, byte-identical copies in
// lambda/{events,photos,plants}/ (each Lambda zips from its own dir, so it cannot import upward).
// lambda/authz-parents-copies-sync.test.js fails if any copy drifts from the canonical file.
//
// NOTE — these deliberately do NOT use household.js loadOwnedPlanting. That one is the same query
// MINUS the `project_id IS NULL` conjunct and is therefore strictly LOOSER: without it the
// own-created_by arm reaches a planting the caller created inside another household's container.
import { loadOwnedProject, loadOwnedPlantingRef } from './authz-parents.js';

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// Daily flat-XP cap (V002 §11; F16 brief override): cap event_logged grants at 30 XP/user/day.
// Achievement XP is encouragement-class — milestones celebrate progress, not bounded by daily limits.
// V4-HARVESTQTY-001 reporting zone. The harvest summary's "this year" and "last 14 days" windows
// are CALENDAR windows anchored at 00:00 in this zone, not UTC days.
const HARVEST_TZ = 'America/New_York';

// Staleness ceiling for harvest-readiness candidates, in multiples of the crop's repeat interval.
//
// !! MUST EQUAL `MAX_OVERDUE_RATIO` in src/lib/harvestReadiness.js. !!
// The client predicate is authoritative for eligibility; this is defence-in-depth that also keeps
// the payload from carrying rows every consumer will discard. Two surfaces with DIFFERENT ceilings
// would make the looser one dead config and the pair a latent disagreement, so
// harvest-ready.test.js asserts the two constants are equal — change them together or that fails.
//
// Value chosen from the EMPIRICAL distribution of real picking rhythm on live prod, not a guess:
// across 220 observed consecutive-harvest gaps (gap / crop repeat_interval_days, repeating habits
// only) the distribution is p50=0.50, p90=1.50, p95=1.76, p99=4.00, max=19.00, and the tail above
// each candidate ceiling is >3: 4/220 (1.8%), >4: 2/220 (0.9%), >5: 1/220. p99 lands at 4.0, so 4
// is the marginally better-supported cut — but it differs from 3 by TWO events in the entire
// recorded history, which does not justify diverging from the client. Aligned on 3 deliberately.
//
// This is a BACKSTOP for the class of bug, not just the instance: it bounds the damage from ANY
// future status value (or a plain abandonment with no status change at all) so nothing can again
// sit at the top of the list at 10x overdue. Note the ratio is interval-relative and so
// systematically inflates short-interval crops — the wineberry's 10.5 was 21 days on a 2-day
// interval, while a 58-day-stale scallion only reaches 4.14. It therefore CANNOT substitute for
// the status filter below: a dormant planting picked recently sits at ratio <= 3 and would still
// nag forever.
const HARVEST_STALE_INTERVAL_CEILING = 3;

// ── Daily flat-XP cap ─────────────────────────────────────────────────────────────────────────
// Raised 30 -> 300 (Batch-B decision packet item 3). The unit is UNCHANGED — 10 XP per LOGGING
// ACTION, capped per user per day in the user's own timezone — so this is one constant, fully
// reversible, exactly as the packet frames it. Achievement XP stays UNCAPPED (F16, unchanged).
//
// THE NUMBER, re-measured live on prod 2026-08-04 rather than taken from the packet.
// The distribution that matters is LOGGING ACTIONS per active day, because after
// BUG-BATCHSIDEEFFECTS-001 a batch is one cap-eligible action (see batchSideEffects.js §Decision 1):
//     active days 73 | actions 2,630 | mean 36 | p50 20 | p75 52 | p90 81 | p95 106 | max 258
// Modelled over those 73 days at 10 XP/action:
//     cap      days capped   XP granted   XP forfeited   avg XP/active day
//      30 (old)   89.0%          2,090       24,210            29
//     100         61.6%          6,000       20,300            82
//     200         49.3%         10,110       16,190           138
//     300  <--    43.8%         13,500       12,800           185
//     500         28.8%         18,800        7,500           258
//    none          0.0%         26,300            0           360
// Why 300 and not higher or lower:
//   • 300 XP = 30 actions. The p50 day is 20 actions, so THE MEDIAN DAY NOW FINISHES UNCAPPED.
//     That is the stated defect — "logging stops paying by mid-morning" — closed at the median.
//     At 30 XP the median day capped after 3 of its 18 single-path actions (17% of the way in).
//   • It still binds on 43.8% of days, which keeps `daily_xp_remaining` a LIVE signal rather than
//     dead config. Removing the cap entirely would make that field a constant and delete the only
//     brake in the system.
//   • It bounds the outlier. A 258-action day would otherwise grant 2,580 XP — 68% of the user's
//     entire lifetime XP (3,790) in one day. Letting a single day dominate the whole record is the
//     over-reinforcement failure reward-ux-guideline V100 §8 guards against.
//   • 6.7x more XP actually granted over the same 73 days (2,020 -> 13,500).
//
// INTERACTION WITH BUG-BATCHSIDEEFFECTS-001, which was the thing to model before choosing:
// under the per-ACTION grain the cap-eligible population grows only 2,330 -> 2,630 (+13%), so this
// number is chosen for post-fix traffic, not yesterday's. Under a per-EVENT grain it would have
// grown to 12,025 (5.2x) and NO cap up to 1,000 XP leaves fewer than 58.9% of days capped — the
// two changes would have cancelled out. The grain decision and the cap decision are one decision.
//
// V102 note: this is reward-shaped, and V102 §5's standing recommendation for a crucible
// re-validation around a reward change applies. It does not gate the dev work (the mechanism,
// delivery discipline and award RATE are all untouched — only a cap constant moves).
const DAILY_FLAT_XP_CAP = 300;
// Per logging action: one single-event POST, or one batch of up to 500. Name kept for continuity
// with the deployed response contract (`daily_xp_remaining`); the grain is documented above.
const FLAT_XP_PER_EVENT = 10;

// V4-EVENTSOURCE-001 — event_log.source values written by THIS Lambda. The full value set, what
// each one means, and why 'direct' is reserved-but-never-inferred live in
// migrations/v4-eventsource-001/0a-additive-ddl.sql. Keep the two in step: the column carries a
// NOT VALID CHECK, so an unlisted value here 23514s on write.
// NOT set here: 'app_status' (lambda/plants + lambda/projects emit those rows) and 'import'.
const EVENT_SOURCE_SINGLE = 'app';
const EVENT_SOURCE_BATCH  = 'app_batch';

// Harvest constants, validator, UUID regex live in validators.js (DB-free, unit-testable).
// Re-exported here for backward compat with any caller importing from index.js directly.
export { HARVEST_UNITS, MAX_PLAUSIBLE, validatePostBody, UUID_RE };

// V4-SOFTDEL-001 F3 — POLICY SWITCH for events whose PLANTING is soft-deleted but whose
// CONTAINER is still live. Two defensible products, and this constant is the whole choice:
//   false (SHIPPED — preserves the pre-fix observable behavior): the event SURVIVES. The
//     watering/harvest really happened in that container; the user deleted a planting record,
//     not the history.
//   true  (the alternative): the event is HIDDEN, symmetric with the container rule.
// Deliberately NOT decided by this fix — flipping this one literal switches every event read
// surface at once (the 5 queries below + dashboard/handlers.js queryRecentEvents, whose copy of
// this constant is kept equal by lambda/events/softdel-feed.test.js).
// Measured on prod 2026-08-06: 56 live events sit under a soft-deleted planting (Dave, of
// 12,356 live events) and 0 (Jen, of 13); 0 of them carry a harvest_log row.
// The CONTAINER rule is NOT a switch — a soft-deleted container always hides its events.
export const HIDE_EVENTS_UNDER_DELETED_PLANTING = false;

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

      // Timezone for the streak / daily-XP window. The single path pre-fetches this the same way
      // (Step 1); the batch path never needed it before because it had no timezone-scoped side
      // effects. It does now.
      const batchTzRows = await sql`
        SELECT COALESCE(
          (SELECT user_timezone FROM profiles WHERE id = ${userId}),
          'America/New_York'
        ) AS tz
      `;
      const batchUserTz = batchTzRows[0].tz;
      const batchTzOffset = parseInt(event.headers?.['x-client-tz-offset'] ?? event.headers?.['X-Client-Tz-Offset'] ?? '0', 10);
      const batchTzOffsetMin = Number.isFinite(batchTzOffset) ? batchTzOffset : 0;

      // (1) Idempotency fast-path: same key (same owner) returns the prior batch, no re-insert.
      const prior = await sql`
        SELECT id, item_count FROM event_batches
        WHERE idempotency_key = ${key} AND created_by = ${userId}
      `;
      if (prior.length) {
        // Backfill event_ids from event_log for idempotent re-hits (Phase B+ critter wiring).
        // BUG-BATCHSIDEEFFECTS-001: this SELECT now carries plant_id / created_at / metadata too,
        // because the re-hit path re-runs the SAME side-effect function as the fresh path (see
        // batchSideEffects.js §Decision 3). Previously a re-hit returned here having done nothing,
        // so a Lambda that died between COMMIT and the reward hooks lost that batch's rewards
        // permanently. Every effect in that function is idempotent, so re-running COMPLETES a
        // partial first attempt and re-applies nothing.
        const priorEvents = await sql`
          SELECT id, plant_id, created_at, metadata FROM event_log
           WHERE metadata->>'batch_id' = ${prior[0].id}::text
             AND created_by = ${userId}
             AND deleted_at IS NULL
        `;
        const priorFx = await applyBatchSideEffects({
          sql,
          userId,
          userTz: batchUserTz,
          batchId: prior[0].id,
          eventType,
          events: priorEvents,
          itemCount: prior[0].item_count,
          tzOffsetMin: batchTzOffsetMin,
          dailyXpCap: DAILY_FLAT_XP_CAP,
          flatXpPerAction: FLAT_XP_PER_EVENT,
        });
        return resp(200, {
          batch_id: prior[0].id,
          count: prior[0].item_count,
          event_ids: priorEvents.map(r => r.id),
          idempotent: true,
          ...priorFx,
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
        -- a sensible review order: the "if (capped) return resp(400)" guard BELOW fires before
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
        // V4-EVENTSOURCE-001: `source` is a first-class provenance column (migration
        // v4-eventsource-001/0a), replacing the microsecond-timestamp collision heuristic that was
        // 98.5% false-positive precisely BECAUSE this statement gives every row in a batch the same
        // created_at. Set at the write, so provenance no longer depends on app_events surviving.
        sql`INSERT INTO event_log
              (project_id, location_id, plant_id, event_type, event_date, is_public,
               logged_by, created_by, metadata, source)
            SELECT p.container_id, pp.location_id, p.id, ${eventType}, ${eventDate}::timestamptz, true,
                   ${userId}, ${userId},
                   jsonb_build_object('batch_id', ${batchId}::text, 'batch_v', 1),
                   ${EVENT_SOURCE_BATCH}
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
          -- BUG-EMPROJGUARD-001 (batch path): container_id IS NULLABLE, so a project-less planting
          -- in the batch would contribute a ZERO-parent row and abort the whole batch transaction.
          -- Latent today (0 such plantings in prod) but reachable the moment CaptureFlow starts
          -- creating them, which BUG-CAPTUREFLOW400-001 unblocks.
          FROM public.garden_node p
          WHERE p.id = ANY(${plantIds}) AND p.container_id IS NOT NULL
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
        sql`
          -- Care re-key Step B (care-rekey-001): ADDITIVE plant-keyed dual-write. Mirrors the
          -- project-keyed upsert above but keyed PER-PLANTING on p.id, ON CONFLICT (plant_id).
          -- Columns match 0b-backfill.sql (no next_water_at — the plant cache is a pure recency
          -- cache; the daily-plan engine owns "due"). Reads still project-keyed (Step D cuts over).
          INSERT INTO entity_memory
            (plant_id, last_event_at,
             last_watered_at, last_fertilized_at, last_pruned_at, last_observed_at, last_harvested_at)
          SELECT p.id,
            ${eventDate}::timestamptz,
            CASE WHEN ${eventType} IN ('watering','rain')            THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'fertilizing'                   THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'pruning'                       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'observation'                   THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} IN ('harvest','first_harvest')    THEN ${eventDate}::timestamptz ELSE NULL END
          FROM public.garden_node p WHERE p.id = ANY(${plantIds})
          ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO UPDATE SET
            last_event_at      = GREATEST(COALESCE(entity_memory.last_event_at,      ${eventDate}::timestamptz), ${eventDate}::timestamptz),
            last_watered_at    = CASE WHEN ${eventType} IN ('watering','rain')         THEN GREATEST(COALESCE(entity_memory.last_watered_at,    ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_watered_at    END,
            last_fertilized_at = CASE WHEN ${eventType} = 'fertilizing'                THEN GREATEST(COALESCE(entity_memory.last_fertilized_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_fertilized_at END,
            last_pruned_at     = CASE WHEN ${eventType} = 'pruning'                    THEN GREATEST(COALESCE(entity_memory.last_pruned_at,     ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_pruned_at     END,
            last_observed_at   = CASE WHEN ${eventType} = 'observation'                THEN GREATEST(COALESCE(entity_memory.last_observed_at,   ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_observed_at   END,
            last_harvested_at  = CASE WHEN ${eventType} IN ('harvest','first_harvest') THEN GREATEST(COALESCE(entity_memory.last_harvested_at,  ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_harvested_at  END,
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
        // CAL-2 germination capture — logging a `germination` event stamps the planting's
        // germinated_at (the event date) the FIRST time only. Batch trigger-parity with the
        // single-event path below. Set-once idempotency via `germinated_at IS NULL` (a planting
        // already germinated is simply not matched → re-logs are no-ops). Scoped to the
        // already-resolved owner-scoped plantIds + explicit household ownership (garden_node has
        // no RLS, L-087). No-op for every other event_type via the ${eventType} gate.
        // germinated_at_approx=false → this is a real captured date, not an estimate.
        sql`
          UPDATE public.garden_node p
             SET germinated_at = ${eventDate}::timestamptz,
                 germinated_at_approx = false,
                 updated_at = NOW()
            FROM public.container pp
           WHERE ${eventType}::text = 'germination'
             AND p.id = ANY(${plantIds})
             AND p.container_id = pp.id
             AND pp.created_by = ANY(${householdIds})
             AND p.deleted_at IS NULL
             AND p.germinated_at IS NULL
        `,
      ]);
      // ── Post-transaction side effects (BUG-BATCHSIDEEFFECTS-001) ─────────────────────────────
      // This block used to be the critter hook and NOTHING ELSE, which is the whole defect: the
      // single-event path below runs six post-transaction effects and the batch path ran one, so
      // 80.6% of all logged events earned no XP, advanced no streak, evaluated no achievement and
      // emitted no telemetry. All six now live in ./batchSideEffects.js — one function, called
      // from here AND from the idempotency fast-path above, every effect idempotent. Read that
      // file's header for the four design decisions (grain, transaction placement, idempotency,
      // O(1) cost) and for exactly what a retry does to user_stats and XP.
      const insertedEvents = await sql`
        SELECT id, plant_id, created_at, metadata FROM event_log
         WHERE metadata->>'batch_id' = ${batchId}::text
           AND created_by = ${userId}
           AND deleted_at IS NULL
      `;
      const batchFx = await applyBatchSideEffects({
        sql,
        userId,
        userTz: batchUserTz,
        batchId,
        eventType,
        events: insertedEvents,
        itemCount: plantIds.length,
        tzOffsetMin: batchTzOffsetMin,
        dailyXpCap: DAILY_FLAT_XP_CAP,
        flatXpPerAction: FLAT_XP_PER_EVENT,
      });
      return resp(200, {
        batch_id: batchId,
        count: plantIds.length,
        // event_ids kept in response for backward-compat with Phase B+ clients (any deployed
        // Phase B+ build still iterates and calls /api/critters — UNIQUE INDEX makes those
        // idempotent re-hits). Will remove once all clients are Phase B++.
        event_ids: insertedEvents.map(r => r.id),
        // Same reward keys the single-event POST returns (xp_gained, daily_xp_remaining,
        // updated_streak, newly_earned_achievements, total_events). ADDITIVE — no existing client
        // field changes shape. The client does not read them yet; surfacing batch rewards in
        // LogMany is a src/ change and belongs to whoever owns that lane.
        ...batchFx,
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
          -- V4-SOFTDEL-001 F3: a soft-deleted container takes its events off every read surface
          -- with it. The DELETE handler and the harvest-summary queries in this file already
          -- filtered this; the feed/list/detail reads were the outliers, so undoing a container
          -- left its events on the feed with the container's name still resolving via this JOIN.
          AND pp.deleted_at IS NULL
          -- Deleted-PLANTING policy — see HIDE_EVENTS_UNDER_DELETED_PLANTING. Disabled today, so
          -- this OR short-circuits on its first operand and the EXISTS never executes.
          AND (${HIDE_EVENTS_UNDER_DELETED_PLANTING}::boolean IS NOT TRUE
               OR e.plant_id IS NULL
               OR EXISTS (SELECT 1 FROM public.garden_node gn
                           WHERE gn.id = e.plant_id AND gn.deleted_at IS NULL))
          AND (${fProject}::uuid IS NULL OR e.project_id = ${fProject}::uuid)
          AND (${fType}::text IS NULL OR e.event_type = ${fType}::text)
          AND (${fFrom}::timestamptz IS NULL OR e.event_date >= ${fFrom}::timestamptz)
          AND (${fTo}::timestamptz IS NULL OR e.event_date <= ${fTo}::timestamptz)
        ORDER BY e.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return resp(200, { events: rows, limit, offset, has_more: rows.length === limit });
    }

    // V4-HARVESTQTY-001: GET /api/events/harvest-summary?plant_id= — raw harvest rows for ONE
    // planting, plus that planting's project's UNATTRIBUTED harvests. Literal sub-route, matched
    // BEFORE the /api/events/:id regex (mirrors the whats-put-up precedent in the preservation
    // Lambda). Deliberately NOT folded into GET /api/plants/:id — a self-fetching section keeps
    // the shared planting payload untouched.
    //
    // Correctness invariants (from live-data review of 112 harvest_log rows):
    //   * The harvest DATE is event_log.event_date. harvest_log has NO date column and
    //     harvest_log.created_at misdates the 30% of rows that were backdated.
    //   * Attribution is harvest_log.event_id -> event_log.id, filtered on event_log.plant_id.
    //   * Soft-delete is filtered at every hop that exists in the chain: harvest_log.deleted_at,
    //     event_log.deleted_at, plants.deleted_at (+ ownership via container.created_by).
    //     plants.archived_at is INTENTIONALLY not filtered here — see the note below.
    //   * event_date is projected to the reporting zone server-side so the client never does
    //     tz math; a 23:00 ET Dec 31 pick returns harvest_date '2025-12-31'.
    if (rawPath === '/api/events/harvest-summary' && method === 'GET') {
      const plantId = event.queryStringParameters?.plant_id || null;
      if (!plantId || !UUID_RE.test(plantId)) return resp(400, { error: 'plant_id (uuid) required' });
      // NOTE on archived_at: GET /api/plants/:id filters only deleted_at, so an ARCHIVED planting
      // is still reachable on the planting-detail page (it renders an Unarchive affordance).
      // Filtering p.archived_at IS NULL on the pinned planting would blank the harvest summary on
      // exactly that page. Deletion hides; archiving does not.
      const rows = await sql`
        SELECT h.id, h.quantity, h.unit, h.quality_rating,
               e.id AS event_id, e.event_date,
               (e.event_date AT TIME ZONE ${HARVEST_TZ})::date AS harvest_date
        FROM harvest_log h
        JOIN event_log e ON e.id = h.event_id
        JOIN plants p ON p.id = e.plant_id
        JOIN public.container c ON c.id = e.project_id
        WHERE e.plant_id = ${plantId}::uuid
          AND h.deleted_at IS NULL
          AND e.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND c.created_by = ANY(${householdIds})
        ORDER BY e.event_date DESC
      `;
      // Unattributed: harvests in the SAME project with no plant_id. Surfaced (never silently
      // dropped) — 13 of 107 July rows are unlinked and three landed the same day, so this is a
      // live daily inflow. A summary that quietly omits them reads low and destroys trust.
      const unattributed = await sql`
        SELECT h.id, h.quantity, h.unit,
               (e.event_date AT TIME ZONE ${HARVEST_TZ})::date AS harvest_date
        FROM harvest_log h
        JOIN event_log e ON e.id = h.event_id
        JOIN public.container c ON c.id = e.project_id
        WHERE e.plant_id IS NULL
          AND e.project_id = (SELECT project_id FROM plants WHERE id = ${plantId}::uuid AND deleted_at IS NULL)
          AND h.deleted_at IS NULL
          AND e.deleted_at IS NULL
          AND c.created_by = ANY(${householdIds})
        ORDER BY e.event_date DESC
      `;
      const todayRows = await sql`SELECT (NOW() AT TIME ZONE ${HARVEST_TZ})::date AS et_today`;
      const ymd = (v) => (v == null ? null : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));
      return resp(200, {
        plant_id: plantId,
        time_zone: HARVEST_TZ,
        et_today: ymd(todayRows[0]?.et_today),
        rows: rows.map(r => ({ id: r.id, quantity: r.quantity, unit: r.unit, quality_rating: r.quality_rating, event_id: r.event_id, event_date: ymd(r.harvest_date) })),
        unattributed: unattributed.map(r => ({ id: r.id, quantity: r.quantity, unit: r.unit, event_date: ymd(r.harvest_date) })),
      });
    }

    // DELETE /api/events/batch/:id — undo a batch (soft-delete its events + recompute care memory).
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
        // Child-row handling — same three-way split as the single-event undo below (see the long
        // note at DELETE /api/events/:id): harvest_log cascades, photos detach + re-parent,
        // critter_state is left alone on purpose. Keyed on batch_id (not on deleted_at) so a
        // partially-undone batch converges instead of stranding the rest.
        sql`UPDATE harvest_log h SET deleted_at = NOW(), updated_at = NOW()
            FROM event_log e
            WHERE e.id = h.event_id AND e.metadata->>'batch_id' = ${batchId} AND h.deleted_at IS NULL`,
        sql`UPDATE photos ph SET
              event_id   = NULL,
              project_id = COALESCE(ph.project_id, e.project_id),
              plant_id   = COALESCE(ph.plant_id,   e.plant_id),
              updated_at = NOW()
            FROM event_log e
            WHERE e.id = ph.event_id AND e.metadata->>'batch_id' = ${batchId} AND ph.deleted_at IS NULL`,
        sql`
          -- BUG-CARECACHEUNDO-001 (2026-08-07): recompute EVERY recency column, not just watering.
          -- Was last_watered_at only, so undoing a harvest / fertilizing / pruning / observation
          -- left the matching column — and last_event_at — permanently ahead of the event log. The
          -- forward upserts are all GREATEST(), so the cache can never walk backwards on its own and
          -- nothing else repaired it. Confirmed on prod: 2 plant rows cached a soft-deleted harvest.
          --
          -- The harvest filter here is 'harvest' ONLY, deliberately NOT the plant arm's
          -- IN ('harvest','first_harvest'): a recompute must be the exact inverse of its OWN arm's
          -- writer, and the project-keyed upsert maps only 'harvest' (line ~1673). Widening it would
          -- make an unrelated undo raise last_harvested_at to a first_harvest date no forward write
          -- ever set. The plant arm below uses the wider set because ITS writer does (0b-backfill).
          WITH affected AS (
            SELECT DISTINCT project_id FROM event_log WHERE metadata->>'batch_id' = ${batchId}
          ),
          surv AS (
            SELECT a.project_id,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.project_id = a.project_id AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL) AS mw,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.project_id = a.project_id AND e.deleted_at IS NULL) AS me,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.project_id = a.project_id AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL) AS mf,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.project_id = a.project_id AND e.event_type = 'pruning' AND e.deleted_at IS NULL) AS mp,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.project_id = a.project_id AND e.event_type = 'observation' AND e.deleted_at IS NULL) AS mo,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.project_id = a.project_id AND e.event_type = 'harvest' AND e.deleted_at IS NULL) AS mh,
              -- BUG-LASTISSUEPLANT-001 (2026-08-07): last_issue_at was missing from this recompute
              -- even though the forward upsert writes it through GREATEST — i.e. the column the
              -- CARECACHEUNDO fix above says it repaired was itself still one-way. Keyed on the
              -- FLAG, not on event_type, because that is what its forward writer keys on.
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.project_id = a.project_id AND e.flagged_as_issue = true AND e.deleted_at IS NULL) AS mi
            FROM affected a
          )
          UPDATE entity_memory em SET
            last_watered_at = surv.mw,
            last_event_at = surv.me,
            last_fertilized_at = surv.mf,
            last_pruned_at = surv.mp,
            last_observed_at = surv.mo,
            last_harvested_at = surv.mh,
            last_issue_at = surv.mi,
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
        sql`
          -- Care re-key Step B (care-rekey-001): parallel plant-keyed recompute after the batch
          -- soft-delete. Recomputes EACH affected planting's recency from its OWN surviving events
          -- (keyed on e.plant_id). Recency-only (no next_water_at — the nightly engine owns "due").
          -- Runs in the same tx after the soft-delete, so MAX() excludes the undone rows.
          --
          -- BUG-CARECACHEUNDO-001 (2026-08-07): was last_watered_at only. Column set and event_type
          -- mapping now mirror 0b-backfill.sql exactly — which is also exactly the plant-keyed
          -- forward upsert (line ~1717) — so this is that writer's precise inverse.
          WITH affected AS (
            SELECT DISTINCT plant_id FROM event_log
            WHERE metadata->>'batch_id' = ${batchId} AND plant_id IS NOT NULL
          ),
          surv AS (
            SELECT a.plant_id,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = a.plant_id AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL) AS mw,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = a.plant_id AND e.deleted_at IS NULL) AS me,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = a.plant_id AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL) AS mf,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = a.plant_id AND e.event_type = 'pruning' AND e.deleted_at IS NULL) AS mp,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = a.plant_id AND e.event_type = 'observation' AND e.deleted_at IS NULL) AS mo,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = a.plant_id AND e.event_type IN ('harvest','first_harvest') AND e.deleted_at IS NULL) AS mh,
              -- BUG-LASTISSUEPLANT-001 (2026-08-07): the plant-keyed forward upsert now writes
              -- last_issue_at, so its inverse belongs here or the column becomes one-way the day
              -- the writer lands. Flag-keyed, matching that writer.
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = a.plant_id AND e.flagged_as_issue = true AND e.deleted_at IS NULL) AS mi
            FROM affected a
          )
          UPDATE entity_memory em SET
            last_watered_at = surv.mw,
            last_event_at = surv.me,
            last_fertilized_at = surv.mf,
            last_pruned_at = surv.mp,
            last_observed_at = surv.mo,
            last_harvested_at = surv.mh,
            last_issue_at = surv.mi,
            updated_at = NOW()
          FROM surv WHERE em.plant_id = surv.plant_id
        `,
        sql`UPDATE event_batches SET undone_at = NOW() WHERE id = ${batchId}`,
      ]);
      return resp(200, { undone: true, batch_id: batchId });
    }

    // V4-HARVESTSURF-001: GET /api/events/harvest-ready — CANDIDATES for the Today harvest-ready
    // band. Literal sub-route, matched BEFORE the /api/events/:id regex (same precedence handling as
    // harvest-summary above). Household-scoped through container.created_by exactly like the feed.
    //
    // This route deliberately returns candidates, NOT verdicts: SQL narrows (live plantings owned by
    // the household that have ≥1 prior harvest, plus the crop's cadence attributes and the ET-day age
    // of the last pick); src/lib/harvestReadiness.js decides eligibility and ranking as a pure,
    // testable function. et_doy travels with the payload so the client never does zone math.
    //
    // Correctness invariants (same live-data review as harvest-summary):
    //   * The harvest DATE is event_log.event_date — NEVER harvest_log.created_at (30% backdated).
    //   * Evidence only: a planting with no prior recorded pick can never appear, so nothing here is
    //     a prediction of first harvest. WHAT COUNTS AS EVIDENCE IS THE DATED PICK, NOT A QUANTITY.
    //     This was originally an INNER JOIN to harvest_log, which silently excluded every
    //     `first_harvest` event: first_harvest is a MILESTONE that carries no quantity by design
    //     (validators.js 400s on harvest fields for it, and the harvest_log write CTE is gated on
    //     eventType === 'harvest'), so it NEVER has a harvest_log row. Verified in prod 2026-07-21:
    //     5/5 first_harvest orphaned vs 112/112 harvest logged. Net effect was a permanent structural
    //     hole — a planting whose ONLY pick was logged as first_harvest was invisible here forever.
    //     The LEFT JOIN + `(h.id IS NOT NULL OR e.event_type = 'first_harvest')` admits that dated
    //     evidence while STILL rejecting a `harvest` event whose harvest_log row was soft-deleted
    //     (h.id goes NULL and the event_type escape does not apply to it). Deliberately NOT fixed by
    //     backfilling harvest_log: quantity/unit are NOT NULL with a unit CHECK and no source value
    //     exists, so a backfill would fabricate user data that harvest-summary renders as recorded.
    //     Measured delta on prod at the time of the change: candidates 25 -> 27, zero lost, and zero
    //     newly ELIGIBLE (both added rows are scallions on the 'onion' slug, habit='single').
    //   * harvest_count now counts milestone picks too. It has no consumer today (produced in the
    //     payload, read nowhere) — if one appears, note it means "recorded picks", not "logged
    //     quantities".
    //   * days_since_last_harvest is whole ET days; it can be NEGATIVE if a pick was future-dated,
    //     and that row is passed through unfiltered for the pure predicate to reject.
    //   * Live planting = deleted_at/archived_at NULL and status not failed/ended/DORMANT. (Unlike
    //     harvest-summary, archived IS filtered — this is an ambient nudge, not a pinned detail page.)
    //     `dormant` was added after a wild wineberry that had gone dormant on 2026-07-31 (a
    //     server-emitted `status_change` "Harvested -> Dormant") ranked #1 of 18 at 10.5x overdue for
    //     days. statusTransitions.js already classifies dormant as a terminal/past state alongside
    //     failed/ended, and dashboard/handlers.js excludes it in 7 places — this route was the
    //     outlier. Dormant is the non-productive terminal subset; `fruiting`/`harvested` are also
    //     "past" states there but are exactly the productive ones this route exists to surface.
    //   * Staleness ceiling (HARVEST_STALE_INTERVAL_CEILING): a candidate more than N repeat
    //     intervals past its last pick is dropped as no-longer-active rhythm. NULL-safe and
    //     no-op for non-positive intervals, so rows the pure client predicate is responsible for
    //     rejecting (NULL interval, `single` habit) still arrive unchanged — and a NEGATIVE
    //     days_since (future-dated pick) still passes through for the client to reject, as before.
    if (rawPath === '/api/events/harvest-ready' && method === 'GET') {
      const rows = await sql`
        WITH last_pick AS (
          SELECT e.plant_id,
                 MAX((e.event_date AT TIME ZONE ${HARVEST_TZ})::date) AS last_date,
                 COUNT(*) AS harvest_count
          FROM event_log e
          LEFT JOIN harvest_log h ON h.event_id = e.id AND h.deleted_at IS NULL
          WHERE e.event_type IN ('harvest', 'first_harvest')
            AND e.deleted_at IS NULL
            AND e.plant_id IS NOT NULL
            AND (h.id IS NOT NULL OR e.event_type = 'first_harvest')
          GROUP BY e.plant_id
        )
        SELECT p.id AS plant_id, p.project_id, p.name,
               ct.slug AS crop_type_slug, ct.display_name AS crop_display_name,
               ct.harvest_habit, ct.repeat_interval_days,
               ct.harvest_season_start_doy, ct.harvest_season_end_doy,
               lp.last_date, lp.harvest_count,
               ((NOW() AT TIME ZONE ${HARVEST_TZ})::date - lp.last_date) AS days_since_last_harvest
        FROM last_pick lp
        JOIN plants p ON p.id = lp.plant_id
        JOIN public.container c ON c.id = p.project_id
        JOIN plant_varieties pv ON pv.id = p.variety_id AND pv.deleted_at IS NULL
        JOIN crop_types ct ON ct.slug = pv.crop_type_slug AND ct.deleted_at IS NULL
        WHERE c.created_by = ANY(${householdIds})
          AND c.deleted_at IS NULL
          AND c.archived_at IS NULL
          AND p.deleted_at IS NULL
          AND p.archived_at IS NULL
          AND (p.status IS NULL OR p.status NOT IN ('failed', 'ended', 'dormant'))
          AND (
            ct.repeat_interval_days IS NULL
            OR ct.repeat_interval_days <= 0
            OR ((NOW() AT TIME ZONE ${HARVEST_TZ})::date - lp.last_date)
                 <= ${HARVEST_STALE_INTERVAL_CEILING} * ct.repeat_interval_days
          )
      `;
      const meta = await sql`
        SELECT (NOW() AT TIME ZONE ${HARVEST_TZ})::date AS et_today,
               EXTRACT(DOY FROM (NOW() AT TIME ZONE ${HARVEST_TZ})::date)::int AS et_doy
      `;
      const ymdRO = (v) => (v == null ? null : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));
      return resp(200, {
        time_zone: HARVEST_TZ,
        et_today: ymdRO(meta[0]?.et_today),
        et_doy: meta[0]?.et_doy ?? null,
        candidates: rows.map(r => ({
          plant_id: r.plant_id,
          project_id: r.project_id,
          name: r.name,
          crop_type_slug: r.crop_type_slug,
          crop_display_name: r.crop_display_name,
          harvest_habit: r.harvest_habit,
          repeat_interval_days: r.repeat_interval_days == null ? null : Number(r.repeat_interval_days),
          harvest_season_start_doy: r.harvest_season_start_doy == null ? null : Number(r.harvest_season_start_doy),
          harvest_season_end_doy: r.harvest_season_end_doy == null ? null : Number(r.harvest_season_end_doy),
          last_harvest_date: ymdRO(r.last_date),
          harvest_count: Number(r.harvest_count),
          days_since_last_harvest: r.days_since_last_harvest == null ? null : Number(r.days_since_last_harvest),
        })),
      });
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
                -- V4-EVENTSOURCE-001/0c added UNIQUE (user_id, reason, source_id) WHERE
                -- source_id IS NOT NULL. This grant already could not duplicate (it only reads the
                -- rows the inserted CTE actually created), so DO NOTHING never fires here — it is
                -- present so a future change cannot turn a silent no-op into a 23505 that aborts
                -- the whole statement.
                ON CONFLICT (user_id, reason, source_id) WHERE source_id IS NOT NULL DO NOTHING
                RETURNING amount, source_id
              ),
              stats_xp AS (
                -- BUG-XPPROGRESSION-001: the literal 1 in the level position is now a SEED, not
                -- a value. trg_user_stats_level (migrations/v4-xpprogression-001/0a) fires BEFORE
                -- both the INSERT and the ON CONFLICT UPDATE and overwrites it with xp_level(NEW.xp),
                -- so resolving an issue that crosses a threshold moves the level here too — a path
                -- with no Step-3b/3c equivalent that a per-caller level computation would have
                -- missed. The column stays in the list because this upsert must initialize the
                -- NOT-NULL set for a user with no row yet (pinned by resolve-stats-upsert.test.js);
                -- it is the trigger, not this literal, that makes the value correct.
                INSERT INTO user_stats (user_id, xp, level, current_streak, longest_streak, total_events, updated_at)
                SELECT ${userId}, COALESCE((SELECT SUM(amount) FROM xp_grants), 0), 1, 0, 0, 0, NOW()
                WHERE EXISTS (SELECT 1 FROM xp_grants)
                ON CONFLICT (user_id) DO UPDATE SET
                  xp = user_stats.xp + EXCLUDED.xp,
                  updated_at = NOW()
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

      // PUT /api/events/:id — edit an existing event. BUG-HARVESTEDIT-001.
      //
      // THIS ROUTE DID NOT EXIST. EventDetail has shipped a full edit form with a Save button since
      // its introduction, and that Save has always PUT to this path and fallen through to the 405
      // below — so editing ANY event has been silently broken in prod, for every event type, not
      // just harvests. `git log -S` finds no PUT handler ever present here and no test covered one.
      //
      // The harvest half is the part with data consequences. harvest_log had exactly ONE write (the
      // INSERT in the create CTE) and no UPDATE anywhere, so quantity/unit/quality_rating and the
      // CAL-1 weight columns were write-once: a mistyped harvest could never be corrected, and the
      // Harvests page totals — which read harvest_log, not event_log.quantity — stayed wrong
      // permanently. Prod carries 306 harvest_log rows against 297 harvest events.
      //
      // Full-replace on the named event fields (the tag-modal grammar used elsewhere in this repo:
      // the client submits the whole set every save, so an omitted key means "cleared"). `harvest`
      // is a SEPARATE opt-in sub-object: absent means "don't touch harvest_log", which is what lets
      // a non-harvest edit — and every existing caller — stay byte-identical in behaviour.
      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');

        if (!body.event_type) return resp(400, { error: 'event_type is required' });
        // Same reservation as the POST path: status_change is server-emitted only, so it can be
        // neither logged nor edited INTO by a client.
        if (body.event_type === 'status_change') {
          return resp(400, { error: 'status_change is set automatically and cannot be set directly' });
        }
        const eventDate = normalizeEventDate(body.event_date);
        if (body.event_date != null && eventDate === null) {
          return resp(400, { error: 'event_date invalid' });
        }
        if (body.harvest != null) {
          const harvestErr = validateHarvestFields(body.harvest);
          if (harvestErr) return resp(harvestErr.status, { error: harvestErr.error });
        }
        // BUG-EVENTEDITFIELDS-001: same rule and same message the POST applies (validators.js:118).
        // Stated as a shared constant rather than re-typed, because a hand-rolled copy that drifts
        // lets a bad value reach event_log_treatment_category_check — a VALIDATED CHECK, so the
        // 23514 aborts the transaction and the user gets a raw constraint NAME instead of this
        // sentence. (CORRECTED 2026-08-07: this used to say "an opaque 500". It is not — the catch
        // at the bottom of this file maps 23514 -> 400, and a transaction does NOT swallow
        // err.code; both were measured on staging. Pre-validating still buys a readable message,
        // which is the actual reason to keep it.)
        const catErr = validateTreatmentCategory(body.treatment_category);
        if (catErr) return resp(catErr.status, { error: catErr.error });

        // Authz + existence in one read, matching the DELETE/GET pattern exactly (container
        // ownership via project_id). Verified safe against live data: 0 of 11,583 undeleted events
        // carry a NULL project_id, so the inner join excludes nothing real. Deliberately NOT a
        // looser rule invented for this fix — a bug fix is the wrong place to widen authz.
        const owned = await sql`
          SELECT el.id, el.event_type, el.plant_id,
                 -- BUG-CACHEGATE-001: the PRE-edit event_date. The care-cache trigger predicate has
                 -- to know whether this PUT actually MOVED the date, and event_date is
                 -- preserve-on-absent (the COALESCE in the UPDATE below), so "the body sent one" is
                 -- not "it changed". This column was never selected, which is WHY the date axis was
                 -- missing from the old gate: the predicate could not be written with the data the
                 -- route had loaded. Free — this SELECT already runs and already reads this row.
                 el.event_date,
                 -- BUG-EVENTEDITFIELDS-001: the PUT is PARTIAL, so resolving the flagged/severity
                 -- pair needs the row's current values, not just the body's. Read here rather than
                 -- in a second round trip — this SELECT already exists and already runs.
                 el.flagged_as_issue, el.severity,
                 -- Slice 3: the OLD anchors. Needed after the UPDATE has already overwritten them,
                 -- to recompute the cache on the anchor the event just LEFT.
                 el.project_id, el.location_id,
                 (SELECT h.id FROM harvest_log h
                   WHERE h.event_id = el.id AND h.deleted_at IS NULL LIMIT 1) AS harvest_log_id
            FROM event_log el
            JOIN public.container pp ON pp.id = el.project_id
           WHERE el.id = ${eventId}
             AND el.deleted_at IS NULL
             AND pp.created_by = ANY(${householdIds})
             AND pp.deleted_at IS NULL
        `;
        if (!owned.length) return resp(404, { error: 'Not found' });
        const existing = owned[0];
        const hasHarvestRow = existing.harvest_log_id != null;

        // Pairing guard. harvest_log rows belong to harvest events; an event_type edit that breaks
        // that pairing is refused EXPLICITLY rather than silently orphaning a harvest row (which
        // would vanish from the Harvests totals with no record of why) or silently inventing one.
        // Both directions are stated so the message tells the user what to do instead.
        if (hasHarvestRow && body.event_type !== 'harvest') {
          return resp(400, {
            error: 'cannot change a harvest event to another type while it has harvest details — delete the event and log a new one',
          });
        }
        if (!hasHarvestRow && body.event_type === 'harvest') {
          return resp(400, {
            error: 'cannot convert an existing event into a harvest — log a new harvest instead',
          });
        }

        // BUG-EVENTEDITFIELDS-001. Three groups of columns were creatable but not editable, so
        // EventDetail could not edit what EventNew had just written. Added here with
        // preserve-on-absent + an explicit clear channel, NOT with the full-replace grammar the
        // four columns above use — see clearFields.js for why that distinction is load-bearing.
        const cerr = validateClear(body.clear, body);
        if (cerr) return resp(400, { error: cerr });
        const clear = Array.isArray(body.clear) ? body.clear : [];

        const pair = resolveFlagPair(body, existing, clear);
        if (pair.error) return resp(400, { error: pair.error });

        // ── Slice 3: RE-ANCHOR ───────────────────────────────────────────────────────────────
        // Logging against the wrong planting is the most likely data-entry mistake in a
        // 12,500-event log, and until now the only remedy was destructive: delete and re-log,
        // which loses the event id, breaks undo evidence, and re-fires every Lambda side effect.
        //
        // The OLD anchors come from `existing` because the UPDATE below overwrites them.
        const oldProjectId  = existing.project_id;
        const oldPlantId    = existing.plant_id;
        // project_id may be CHANGED but never CLEARED — see clearFields.js. `?? old` enforces it
        // structurally: there is no body that produces null here.
        const newProjectId  = body.project_id ?? oldProjectId;
        const newPlantId    = body.plant_id ?? oldPlantId;
        const newLocationId = body.location_id ?? existing.location_id;

        const projectChanged = newProjectId !== oldProjectId;
        const plantChanged   = newPlantId !== oldPlantId;

        // ── BUG-CACHEGATE-001: the CACHE-DIRTY predicate ──────────────────────────────────────
        // Anchor movement is only ONE of FOUR ways this PUT invalidates entity_memory. The other
        // three ran no recompute at all, and every forward upsert is GREATEST(), so the drift was
        // permanent and accreted one cell per edit — BUG-CARECACHEUNDO-001's exact mechanism
        // arriving through a different door, in a route that shipped AFTER that repair.
        //
        // Each axis has its OWN wire grammar, so "changed" is derived per axis and never from one
        // uniform "did the body send this key" test:
        //   event_type  FULL-REPLACE and required (400 above if absent) -> compare to the row.
        //   event_date  PRESERVE-ON-ABSENT (the COALESCE in the UPDATE) -> an absent key is NOT a
        //               change. Compared as an INSTANT, not a string: normalizeEventDate rewrites a
        //               date-only value to noon UTC, so a string compare would report a false
        //               change on every save from the date picker and destroy the no-op case.
        //   flag        RESOLVED by resolveFlagPair (body OR the row), so compare pair.flagged.
        //               Against body.flagged_as_issue an absent key reads as "unflagged" and would
        //               recompute on every save.
        //   anchors     already resolved above.
        // location_id is deliberately NOT an axis: entity_memory has a location-keyed arm, but no
        // writer in this route has ever touched it.
        const typeChanged = body.event_type !== existing.event_type;
        const dateChanged = eventDate != null
          && new Date(eventDate).getTime() !== new Date(existing.event_date).getTime();
        const flagChanged = (pair.flagged === true) !== (existing.flagged_as_issue === true);
        const cacheDirty  = projectChanged || plantChanged || typeChanged || dateChanged || flagChanged;

        // next_water_at is NOT a recency column — the nightly daily-plan engine owns "due" — so it
        // is re-derived ONLY when this edit could have moved surv.mw on SOME key: the event WAS a
        // watering/rain, or it NOW is. The union is the point. Gating on the post-edit type alone is
        // exactly GAP 3; gating on nothing would let an unrelated retitle clobber the engine's value.
        const waterTouched = ['watering', 'rain'].includes(existing.event_type)
          || ['watering', 'rain'].includes(body.event_type);

        // Ownership on every id being moved TO. The UPDATE's own household predicate authorizes
        // the event's CURRENT container and says nothing about the destination — the
        // BUG-EVENTSOWN-001 shape. Generic 400 either way: found-vs-forbidden is itself a leak.
        if (body.project_id != null && !await loadOwnedProject(sql, body.project_id, householdIds)) {
          warnRejectedFk(userId, 'event_log', 'project_id', body.project_id);
          return resp(400, { error: 'Invalid project_id' });
        }
        if (body.plant_id != null && !await loadOwnedPlantingRef(sql, body.plant_id, householdIds)) {
          warnRejectedFk(userId, 'event_log', 'plant_id', body.plant_id);
          return resp(400, { error: 'Invalid plant_id' });
        }
        if (body.location_id != null && !await loadOwnedLocation(sql, body.location_id, householdIds)) {
          warnRejectedFk(userId, 'event_log', 'location_id', body.location_id);
          return resp(400, { error: 'Invalid location_id' });
        }
        // BUG-AUTHZFKENUM-001: treatment_product_id -> inventory_items sat on the SAME statement as
        // the three gates above and had none of its own. Integrity (a treatment logged against
        // another household's product) plus a weak existence oracle: a live foreign id answered 200
        // while a nonexistent one raised 23503 -> 400. Same generic 400 for both now.
        if (body.treatment_product_id != null && !await loadOwnedInventoryItem(sql, body.treatment_product_id, householdIds)) {
          warnRejectedFk(userId, 'event_log', 'treatment_product_id', body.treatment_product_id);
          return resp(400, { error: 'Invalid treatment_product_id' });
        }

        // event_log_has_anchor admits plant-or-project only (widening it to location is
        // V4-EVENTANCHOR-001, still blocked). Checked here so a violation is a 400 naming the
        // FIELD rather than one naming the CONSTRAINT. (CORRECTED 2026-08-07: previously "an opaque
        // 500" — the catch maps 23514 -> 400 and transactions preserve err.code; both measured.)
        //
        // UNREACHABLE as written, deliberately kept (audited 2026-08-07). newProjectId falls back to
        // oldProjectId, and the ownership SELECT that produced oldProjectId INNER JOINs container on
        // project_id — so oldProjectId is never null for a row that got this far, and the conjunction
        // can never be true. Defence-in-depth against a future edit that relaxes that JOIN or lets a
        // caller null project_id explicitly. Noted so nobody later "proves" the path is reachable and
        // builds a test around it, and so nobody deletes it as dead without seeing what holds it up.
        if (newProjectId == null && newPlantId == null) {
          return resp(400, { error: 'an event must keep a plant_id or a project_id' });
        }

        // V4-TREATLOG-001 parity with the POST (:1584): the five treatment columns are recorded
        // ONLY for these two types. On an edit that changes the type AWAY from a treatment type,
        // this forces them back to NULL rather than leaving orphaned treatment data on, say, a
        // watering event — the POST would never have produced that row.
        const isTreatment = body.event_type === 'pest_treatment' || body.event_type === 'doctored';

        const updatedRows = await sql`
          UPDATE event_log el
             SET event_type    = ${body.event_type},
                 event_date    = COALESCE(${eventDate}::timestamptz, el.event_date),
                 title         = ${body.title ?? null},
                 notes         = ${body.notes ?? null},
                 private_notes = ${body.private_notes ?? null},
                 quantity      = ${body.quantity ?? null},
                 is_public     = COALESCE(${body.is_public ?? null}::boolean, el.is_public),
                 -- Slice 3 re-anchor. Bound from the RESOLVED locals, not from the body: project_id
                 -- must never become NULL (the ownership SELECT, this UPDATE and the DELETE route
                 -- all INNER JOIN container on it, so a NULL is a permanently unreachable event).
                 project_id    = ${newProjectId}::uuid,
                 plant_id      = ${newPlantId}::uuid,
                 location_id   = ${newLocationId}::uuid,
                 flagged_as_issue = ${pair.flagged}::boolean,
                 severity         = ${pair.severity}::smallint,
                 treatment_product_id   = CASE WHEN NOT ${isTreatment}::boolean THEN NULL
                                               WHEN ${clear} @> ARRAY['treatment_product_id'] THEN NULL
                                               ELSE COALESCE(${body.treatment_product_id ?? null}, el.treatment_product_id) END,
                 treatment_product_text = CASE WHEN NOT ${isTreatment}::boolean THEN NULL
                                               WHEN ${clear} @> ARRAY['treatment_product_text'] THEN NULL
                                               ELSE COALESCE(${body.treatment_product_text ?? null}, el.treatment_product_text) END,
                 treatment_category     = CASE WHEN NOT ${isTreatment}::boolean THEN NULL
                                               WHEN ${clear} @> ARRAY['treatment_category'] THEN NULL
                                               ELSE COALESCE(${body.treatment_category ?? null}, el.treatment_category) END,
                 treatment_amount       = CASE WHEN NOT ${isTreatment}::boolean THEN NULL
                                               WHEN ${clear} @> ARRAY['treatment_amount'] THEN NULL
                                               ELSE COALESCE(${body.treatment_amount ?? null}, el.treatment_amount) END,
                 pest_target            = CASE WHEN NOT ${isTreatment}::boolean THEN NULL
                                               WHEN ${clear} @> ARRAY['pest_target'] THEN NULL
                                               ELSE COALESCE(${body.pest_target ?? null}, el.pest_target) END,
                 updated_at    = NOW()
            FROM public.container pp
           WHERE el.id = ${eventId}
             AND el.deleted_at IS NULL
             AND pp.id = el.project_id
             AND pp.created_by = ANY(${householdIds})
             AND pp.deleted_at IS NULL
          RETURNING el.id, el.project_id, el.location_id, el.plant_id, el.event_type,
                    el.event_date, el.title, el.notes, el.private_notes, el.quantity,
                    el.is_public, el.logged_by, el.created_at, el.updated_at,
                    el.flagged_as_issue, el.severity, el.resolved_at, el.resolved_by,
                    -- BUG-EVENTEDITFIELDS-001: returned so the client can re-seed its form from
                    -- the SAVED row rather than from what it hoped it sent. The isTreatment gate
                    -- above can null all five, and the client has to be able to see that happen.
                    el.treatment_product_id, el.treatment_product_text, el.treatment_category,
                    el.treatment_amount, el.pest_target
        `;
        if (!updatedRows.length) return resp(404, { error: 'Not found' });

        let harvestRow = null;
        if (body.harvest != null && hasHarvestRow) {
          const hq = body.harvest.quantity;
          const hu = body.harvest.unit;
          const hqual = body.harvest.quality_rating ?? null;
          // V4-HARVDUAL-001 Slice A. The weight derivation now lives in ONE place —
          // public.resolve_harvest_weight (migrations/v4-cal1-harvweight-002) — called identically
          // here and in the POST CTE. It previously existed as two hand-copied SQL expressions kept
          // in agreement by a comment, which is the same shape as the bug this route was built to
          // fix. It also now resolves through the refweight-001 variety->crop unit_weights tiers
          // rather than crop_types.grams_per_unit alone; the old expression would have overwritten a
          // MEASURED per-variety weight (Super Sweet 100 @ 8 g/fruit) with the crop-level tomato
          // average (123 g/fruit) on any unrelated edit.
          //
          // The function returns both columns together, so chk_harvest_log_weight_pairing
          // ((weight_grams IS NULL) = (weight_estimated IS NULL)) holds by construction and a
          // half-update can no longer raise 23514.
          //
          // 0 is the "no user weight" sentinel, NOT null, and the nullability is reintroduced in SQL
          // with NULLIF. The reason this comment used to give for that — that the neon HTTP driver
          // cannot type a null JS param even with a ::cast — is FALSE, probed against prod on 0.10.4
          // (the pinned version): a ::cast always types a NULL bind, in COALESCE/GREATEST/CASE
          // alike. The shape is kept because it works and the validator rejects weight <= 0, which
          // makes 0 unambiguous — but nothing forces it, so a future edit is free to bind NULL
          // directly. Do not cite the driver as a constraint anywhere; it is not one.
          const hUserGrams = typeof body.harvest.weight === 'number'
            ? toGrams(body.harvest.weight, body.harvest.weight_unit) : 0;
          // Explicit null means "I'm clearing my weight" -> fall back to the reference estimate.
          // An ABSENT key must preserve a weight the user previously recorded (see validators.js).
          const hClearWeight = body.harvest.weight === null;
          const updatedHarvest = await sql`
            UPDATE harvest_log h
               SET quantity         = ${hq}::numeric,
                   unit             = ${hu},
                   quality_rating   = ${hqual}::smallint,
                   -- NEVER let an unrelated edit BLANK a stored weight (2026-08-06).
                   -- resolve_harvest_weight returns NULL whenever no tier can price the row — e.g.
                   -- Wild Blackberry, whose plant_varieties.unit_weights is NULL. Four live rows
                   -- store weight_basis='cultivar' with real grams from a time when a tier did
                   -- resolve; overwriting unconditionally meant that tapping a QUALITY STAR silently
                   -- discarded them. The carry-forward below only covers USER-TYPED weights
                   -- (weight_estimated=false), so estimated rows had no protection at all.
                   -- Keep the whole triple from ONE source so both validated CHECKs still hold:
                   -- ..._pairing needs (grams IS NULL) = (basis IS NULL), and ..._estimated needs
                   -- estimated = (basis <> 'measured'). An explicit clear still clears.
                   --
                   -- h.unit is the OLD unit (SET expressions see the pre-UPDATE row). It is the
                   -- discriminator, because rw.weight_grams IS NULL is OVERLOADED — it means BOTH
                   -- "no tier can price this variety" (preserve: the Wild Blackberry case above) AND
                   -- "the quantity is no longer denominated in weight" (RECOMPUTE, i.e. clear).
                   -- Without it, 3 lb -> 3 count keeps the stale 1360.776 g and silently inflates the
                   -- harvest totals, breaking BUG-HARVESTEDIT-001 ("CLEARS a stale weight when the
                   -- unit goes back to a non-weight"). This is the SAME test the carry-forward
                   -- subquery below already applies for the same reason — the two must agree, or a
                   -- weight DERIVED from a weight-unit quantity outlives the unit it came from.
                   --
                   -- SCALED, not carried verbatim (2026-08-07). Everything reaching this branch is an
                   -- ESTIMATE — grams the resolver once produced as quantity * per-unit factor. A
                   -- USER-TYPED weight never lands here: the carry-forward below feeds it back as
                   -- p_user_grams, so the resolver returns non-NULL and the ELSE arm wins. That
                   -- asymmetry is the whole point. A weighing is an INDEPENDENT fact — correcting the
                   -- count from 4 to 8 must not double what the scale actually said — whereas an
                   -- estimate is a pure function OF the quantity, so holding it fixed while the
                   -- quantity moves is simply a wrong number. Editing 1 count -> 10 count kept the
                   -- 1-count grams and understated the row 10x, and since V4-HARVWEIGHTREAD-001 that
                   -- figure is summed into the Harvests and PlantingDetail totals on screen.
                   -- Re-deriving through the ratio reconstructs the per-unit factor the resolver can
                   -- no longer look up. Quantity unchanged -> ratio 1 -> byte-identical to before.
                   -- NULLIF+COALESCE, never a nested CASE: quantity has no positivity CHECK, and a
                   -- division by zero here would NULL the grams while basis stayed set — a hard 23514
                   -- on chk_harvest_log_weight_basis_pairing. An unscalable row keeps its old weight.
                   -- Left unrounded to match the resolver, which does not round p_qty * f.factor.
                   -- (No backticks anywhere in here: this SQL is a JS template literal, and one
                   -- would close the string mid-statement.)
                   weight_grams     = CASE WHEN rw.weight_grams IS NULL AND NOT ${hClearWeight}::boolean
                                            AND h.unit NOT IN ('g','kg','lb','oz')
                                           THEN h.weight_grams * COALESCE(${hq}::numeric / NULLIF(h.quantity, 0), 1)
                                           ELSE rw.weight_grams END,
                   weight_estimated = CASE WHEN rw.weight_grams IS NULL AND NOT ${hClearWeight}::boolean
                                            AND h.unit NOT IN ('g','kg','lb','oz')
                                           THEN h.weight_estimated ELSE rw.weight_estimated END,
                   -- Slice C: the third column of the resolver. NOT optional — pervariety-001's
                   -- chk_harvest_log_weight_basis_pairing is VALIDATED, so writing a weight without
                   -- its basis is a hard 23514.
                   weight_basis     = CASE WHEN rw.weight_grams IS NULL AND NOT ${hClearWeight}::boolean
                                            AND h.unit NOT IN ('g','kg','lb','oz')
                                           THEN h.weight_basis ELSE rw.weight_basis END,
                   updated_at = NOW()
              FROM event_log ne,
              LATERAL public.resolve_harvest_weight(
                ne.plant_id, ${hu}, ${hq}::numeric,
                COALESCE(
                  NULLIF(${hUserGrams}::numeric, 0),
                  CASE WHEN ${hClearWeight}::boolean THEN NULL ELSE (
                    -- Carry forward a weight the user typed on an earlier save, so editing the
                    -- quality star does not silently discard their measurement.
                    -- The unit-NOT-IN-weight-units guard distinguishes the two ways a row
                    -- can be weight_estimated=false: a USER-SUPPLIED weight (preserve it — it is an
                    -- independent fact) versus a weight DERIVED from a weight-unit quantity
                    -- (recompute it — 3 lb -> 3 count must clear, per the original contract here).
                    SELECT h2.weight_grams FROM harvest_log h2
                     WHERE h2.event_id = ${eventId}
                       AND h2.deleted_at IS NULL
                       AND h2.weight_estimated = false
                       AND h2.unit NOT IN ('g','kg','lb','oz')
                     LIMIT 1
                  ) END
                )
              ) rw
             WHERE h.event_id = ${eventId}
               AND h.deleted_at IS NULL
               AND ne.id = h.event_id
            RETURNING h.id, h.quantity, h.unit, h.quality_rating, h.weight_grams, h.weight_estimated, h.weight_basis
          `;
          harvestRow = updatedHarvest[0] ?? null;

          // V4-HARVDUAL-001 Slice C — keep the calibration sample in step with the edit. Called
          // UNCONDITIONALLY (unlike the create path), because an edit can also REMOVE a weight or
          // switch the unit to lb, and the function's job is then to retire the sample this event
          // produced earlier.
          //
          // The grams come from the POST-UPDATE ROW, not from the request body. Those differ: when
          // the client omits `weight` entirely, Slice A deliberately CARRIES FORWARD the weight the
          // user typed on an earlier save, so hUserGrams is 0 while the row still holds a real
          // measurement. Reading the request here would retire a sample whose weight is still very
          // much present. The row's own (weight_estimated=false AND unit is not a weight unit) pair
          // is the same test used everywhere else to mean "the user typed this".
          const savedGrams = isUserSuppliedWeight(harvestRow) ? Number(harvestRow.weight_grams) : 0;
          try {
            await sql`SELECT public.record_harvest_weight_sample(
              ${eventId}::uuid, ${updatedRows[0].plant_id}::uuid, ${hu},
              ${hq}::numeric, NULLIF(${savedGrams}::numeric, 0), ${userId})`;
          } catch (e) {
            console.warn('[cal1] auto-capture of the weight sample failed (edit saved):', e?.message);
          }
        }

        // ── Slice 3: care-cache maintenance for a re-anchor ──────────────────────────────────
        //
        // A re-anchor is, for cache purposes, exactly a DELETE-from-old plus an INSERT-into-new.
        // So the correct maintenance is ONE uniform rule: recompute from surviving events on BOTH
        // the old and the new anchor. It runs AFTER the event_log UPDATE has committed the new
        // anchor, so the surv predicates already see the world as it now is:
        //   * old anchor — the moved row no longer matches, so surv correctly EXCLUDES it. Because
        //     these arms assign DIRECTLY from surv and never through GREATEST, the cached value
        //     can walk BACKWARDS. That is the whole property BUG-CARECACHEUNDO-001 bought.
        //   * new anchor — the moved row now matches, so surv INCLUDES it.
        //
        // Why recompute on the new side rather than reuse the forward GREATEST upsert: GREATEST is
        // sufficient for the new side alone, but not when the same PUT also moves event_date
        // BACKWARDS (this route allows that), and not under a move-then-move-back. One uniform
        // rule beats two conditional ones, and removes any need to reason about direction.
        //
        // WITHOUT THIS, the failure is INVISIBLE to every assertion that reads back the event row:
        // the event moves correctly and the old planting simply keeps claiming a watering it no
        // longer has, forever, because every forward upsert is GREATEST.
        //
        // Per-arm writer parity is deliberate and asserted: the plant-keyed arms map
        // IN ('harvest','first_harvest') and the project-keyed arms map = 'harvest', because their
        // forward writers do. A recompute must invert ITS OWN arm's writer; unifying them would
        // move last_harvested_at to a date no forward write ever produced.
        //
        // Bind names are deliberately distinct (oldProjectId / newProjectId / oldPlantId /
        // newPlantId). undo-recompute.test.js anchors its four arms by scanning BACKWARDS from a
        // tail string, so reusing ${projectId} / ${plantId} here could silently retarget its
        // assertions onto these statements.
        if (cacheDirty) {
          const reanchor = [];
          // WHICH ARM RUNS FOR WHICH KEY (BUG-CACHEGATE-001). The four arms are written against
          // oldProjectId / newProjectId / oldPlantId / newPlantId. When nothing MOVED those are the
          // SAME key, so running both on it is either redundant or — for the "vacated" arm — a
          // claim about something that did not happen. Arms are therefore SELECTED per key:
          //   project unchanged -> OLD arm only. It is the only arm carrying next_water_at, and
          //                        every event-bearing project has a cache row (the POST upserts
          //                        it), so its bare UPDATE cannot silently match zero rows.
          //   project changed   -> OLD (vacated) + NEW upsert (destination may never have had one).
          //   plant unchanged   -> NEW arm only. Same values either way, and being an upsert it
          //                        also HEALS a planting that has events but no cache row. The
          //                        plant arms carry no next_water_at, so nothing is lost.
          //   plant changed     -> OLD (vacated) + NEW upsert.
          // Bind names stay distinct: undo-recompute.test.js anchors ITS four arms by scanning
          // backwards from the ${projectId} / ${plantId} tails and would silently retarget onto
          // these statements if they were reused.
          {
            // OLD project — ALWAYS. When the project did not change, ${oldProjectId} IS the current
            // project and this is the in-place recompute that GAPs 1, 2 and 4 needed.
            // Row is guaranteed to exist (the POST upserted it).
            reanchor.push(sql`
              WITH surv AS (
                SELECT (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.project_id = ${oldProjectId} AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL) AS mw,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.project_id = ${oldProjectId} AND e.deleted_at IS NULL) AS me,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.project_id = ${oldProjectId} AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL) AS mf,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.project_id = ${oldProjectId} AND e.event_type = 'pruning' AND e.deleted_at IS NULL) AS mp,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.project_id = ${oldProjectId} AND e.event_type = 'observation' AND e.deleted_at IS NULL) AS mo,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.project_id = ${oldProjectId} AND e.event_type = 'harvest' AND e.deleted_at IS NULL) AS mh,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.project_id = ${oldProjectId} AND e.flagged_as_issue = true AND e.deleted_at IS NULL) AS mi
              )
              UPDATE entity_memory em SET
                last_watered_at = surv.mw, last_event_at = surv.me, last_fertilized_at = surv.mf,
                last_pruned_at = surv.mp, last_observed_at = surv.mo, last_harvested_at = surv.mh,
                last_issue_at = surv.mi,
                -- BUG-CACHEGATE-001 GAP 3. This used to bind movedType = body.event_type, the
                -- POST-edit type (written with a dollar-brace, which is why this sentence does not
                -- reproduce it: inside this template literal a dollar-brace INTERPOLATES even
                -- inside a SQL comment, so naming the old binding literally here would throw
                -- ReferenceError on every re-anchor).
                -- It was a fact about the EVENT, not about the key it LEFT. So a re-anchor that
                -- also retyped left the vacated container holding a due date derived from a
                -- watering that was by then neither its event nor a watering, while
                -- last_watered_at correctly walked backwards in the same statement: a mutually
                -- inconsistent pair, which is the tell that made this a distinct defect from GAP 2.
                -- What matters is only whether THIS edit could have moved surv.mw on SOME key,
                -- which is the OLD-or-NEW union in waterTouched. The value is now always that key's
                -- OWN surviving waterings. Gated, not removed: the nightly daily-plan engine owns
                -- "due", and recomputing on an unrelated retitle would clobber its value.
                -- Interval default reunified with the other five care-cache writers, which all use
                -- the location_type CASE; this arm alone used a flat 4 and disagreed for
                -- outdoor_container (2) and inground/indoor_mature (5).
                next_water_at = CASE WHEN NOT ${waterTouched}::boolean THEN em.next_water_at
                  WHEN surv.mw IS NULL THEN NULL ELSE surv.mw + (COALESCE(em.watering_interval_days,
                    CASE em.location_type
                      WHEN 'indoor_seedling'   THEN 1
                      WHEN 'outdoor_container' THEN 2
                      WHEN 'outdoor_bed'       THEN 4
                      WHEN 'outdoor_inground'  THEN 5
                      WHEN 'indoor_mature'     THEN 5
                      ELSE 4
                    END)::int * INTERVAL '1 day') END,
                updated_at = NOW()
              FROM surv WHERE em.project_id = ${oldProjectId}
            `);
          }
          if (projectChanged) {
            // NEW project — the row may not exist yet, so this is an upsert. A bare UPDATE would
            // silently match zero rows on a container that has never carried an event.
            reanchor.push(sql`
              INSERT INTO entity_memory
                (project_id, last_event_at, last_watered_at, last_fertilized_at,
                 last_pruned_at, last_observed_at, last_harvested_at, last_issue_at)
              SELECT ${newProjectId}::uuid,
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.project_id = ${newProjectId} AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.project_id = ${newProjectId} AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.project_id = ${newProjectId} AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.project_id = ${newProjectId} AND e.event_type = 'pruning' AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.project_id = ${newProjectId} AND e.event_type = 'observation' AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.project_id = ${newProjectId} AND e.event_type = 'harvest' AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.project_id = ${newProjectId} AND e.flagged_as_issue = true AND e.deleted_at IS NULL)
              ON CONFLICT (project_id) DO UPDATE SET
                last_event_at = EXCLUDED.last_event_at,
                last_watered_at = EXCLUDED.last_watered_at,
                last_fertilized_at = EXCLUDED.last_fertilized_at,
                last_pruned_at = EXCLUDED.last_pruned_at,
                last_observed_at = EXCLUDED.last_observed_at,
                last_harvested_at = EXCLUDED.last_harvested_at,
                last_issue_at = EXCLUDED.last_issue_at,
                updated_at = NOW()
            `);
          }
          if (plantChanged && oldPlantId) {
            // OLD planting. Recency only — no next_water_at on a plant-keyed arm, matching the
            // plant-keyed forward writer, which does not carry that column.
            reanchor.push(sql`
              WITH surv AS (
                SELECT (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.plant_id = ${oldPlantId} AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL) AS mw,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.plant_id = ${oldPlantId} AND e.deleted_at IS NULL) AS me,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.plant_id = ${oldPlantId} AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL) AS mf,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.plant_id = ${oldPlantId} AND e.event_type = 'pruning' AND e.deleted_at IS NULL) AS mp,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.plant_id = ${oldPlantId} AND e.event_type = 'observation' AND e.deleted_at IS NULL) AS mo,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.plant_id = ${oldPlantId} AND e.event_type IN ('harvest','first_harvest') AND e.deleted_at IS NULL) AS mh,
                (SELECT MAX(e.event_date) FROM event_log e
                  WHERE e.plant_id = ${oldPlantId} AND e.flagged_as_issue = true AND e.deleted_at IS NULL) AS mi
              )
              UPDATE entity_memory em SET
                last_watered_at = surv.mw, last_event_at = surv.me, last_fertilized_at = surv.mf,
                last_pruned_at = surv.mp, last_observed_at = surv.mo, last_harvested_at = surv.mh,
                last_issue_at = surv.mi,
                updated_at = NOW()
              FROM surv WHERE em.plant_id = ${oldPlantId}
            `);
          }
          // Guarded on newPlantId, NOT on plantChanged (BUG-CACHEGATE-001): when the planting did
          // not change this is the in-place recompute GAPs 1/2/4 need, and preferring the upsert
          // over the OLD arm additionally CREATES the cache row for a planting that has events but
          // none. Still guarded non-null, but NOT for the reason this comment used to give: it
          // claimed the neon driver cannot type a NULL bound param even with an explicit ::uuid
          // cast. That is false — probed against prod on 0.10.4 (the version every lambda/*/
          // package.json pins), 30+ shapes: a cast ALWAYS types a NULL bind. Uncast binds also work
          // wherever Postgres can infer a type; they fail only in un-inferable positions (a
          // variadic "any" arg such as jsonb_build_object's), and there a NON-NULL value fails
          // identically — so that is a cast problem, never a NULL one.
          //
          // The old comment's CONCLUSION was right even though its mechanism was wrong: an
          // unguarded bind really does 500 every project-level event, just not for driver reasons.
          // plant_id is NULL on every project-level event; this INSERT (unlike the POST arm below,
          // ~:2185) carries no IS-NOT-NULL self-guard in its WHERE and supplies no project_id or
          // location_id, so a NULL bind writes a ZERO-parent row, violates
          // entity_memory_exactly_one_parent (23514), aborts the transaction, and the catch below
          // rethrows — a 500. Same fact the POST arm already documents at ~:2165. Keep the guard.
          if (newPlantId) {
            reanchor.push(sql`
              INSERT INTO entity_memory
                (plant_id, last_event_at, last_watered_at, last_fertilized_at,
                 last_pruned_at, last_observed_at, last_harvested_at, last_issue_at)
              SELECT ${newPlantId}::uuid,
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${newPlantId} AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${newPlantId} AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${newPlantId} AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${newPlantId} AND e.event_type = 'pruning' AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${newPlantId} AND e.event_type = 'observation' AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${newPlantId} AND e.event_type IN ('harvest','first_harvest') AND e.deleted_at IS NULL),
                (SELECT MAX(e.event_date) FROM event_log e WHERE e.plant_id = ${newPlantId} AND e.flagged_as_issue = true AND e.deleted_at IS NULL)
              ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO UPDATE SET
                last_event_at = EXCLUDED.last_event_at,
                last_watered_at = EXCLUDED.last_watered_at,
                last_fertilized_at = EXCLUDED.last_fertilized_at,
                last_pruned_at = EXCLUDED.last_pruned_at,
                last_observed_at = EXCLUDED.last_observed_at,
                last_harvested_at = EXCLUDED.last_harvested_at,
                last_issue_at = EXCLUDED.last_issue_at,
                updated_at = NOW()
            `);
          }
          // harvest_log carries a DENORMALIZED project_id, written only by the POST CTE. No read
          // surface filters on it today (harvest-summary drives from event_log), so a stale value
          // is hygiene rather than correctness — but it is one statement, and leaving it means the
          // Harvests totals could one day count a harvest under the container it left.
          // Its own RETURNING keeps harvest-weight-preserve.test.js's forward
          // indexOf-until-weight_basis scan from swallowing it into the weight statement's slice.
          if (projectChanged) {
            reanchor.push(sql`
              UPDATE harvest_log hl SET project_id = ${newProjectId}::uuid, updated_at = NOW()
               WHERE hl.event_id = ${eventId} AND hl.deleted_at IS NULL
              RETURNING hl.id
            `);
          }
          if (reanchor.length) {
            try {
              await sql.transaction(reanchor);
            } catch (e) {
              // The event_log UPDATE has ALREADY COMMITTED — it is a separate statement and the
              // neon HTTP driver auto-commits each one — so on failure the event has moved and the
              // cache has not, with nothing to reconcile it. That non-atomicity is pre-existing,
              // but this ticket widens the window from "re-anchors only" to "every type/date/flag
              // edit", so the failure needs to be greppable rather than invisible. Rethrown: the
              // caller still gets its 500. Folding the event UPDATE into this transaction is the
              // real fix and is its own ticket — the route needs its RETURNING before these arms
              // can even be built.
              console.error('[cachegate] care-cache recompute FAILED after the event committed',
                JSON.stringify({ eventId, oldProjectId, newProjectId, oldPlantId, newPlantId,
                  error: e?.message }));
              throw e;
            }
          }
        }

        return resp(200, { ...updatedRows[0], harvest: harvestRow });
      }

      if (method === 'GET') {
        const rows = await sql`
          SELECT
            e.id, e.project_id, e.location_id, e.plant_id,
            e.event_type, e.event_date, e.title, e.notes, e.private_notes,
            e.quantity, e.is_public, e.logged_by, e.created_at,
            e.metadata,
            e.flagged_as_issue, e.severity, e.resolved_at, e.resolved_by,
            -- BUG-EVENTEDITFIELDS-001: the five treatment columns were WRITTEN by the POST and
            -- never READ back by this GET, so EventDetail.startEdit seeded its form without them.
            -- Adding the PUT write path without this would be strictly worse than the original
            -- bug: the form would round-trip blanks over five populated columns and every
            -- client-only test would still pass. Read and write ship together, in one commit.
            e.treatment_product_id, e.treatment_product_text, e.treatment_category,
            e.treatment_amount, e.pest_target,
            pp.display_name AS project_name,
            -- BUG-HARVESTEDIT-001: the harvest detail row, so the edit form can SEED itself. Without
            -- this the client cannot render the real quantity/unit at all — it only ever saw
            -- event_log.quantity, a free-text field that is not what the Harvests totals read.
            -- LEFT JOIN, not INNER: a non-harvest event must still return, with harvest null.
            (SELECT row_to_json(x) FROM (
               SELECT h.id, h.quantity, h.unit, h.quality_rating, h.weight_grams, h.weight_estimated, h.weight_basis
                 FROM harvest_log h
                WHERE h.event_id = e.id AND h.deleted_at IS NULL
                LIMIT 1
             ) x) AS harvest
          FROM event_log e
          JOIN public.container pp ON pp.id = e.project_id
          WHERE e.id = ${eventId}
            AND e.deleted_at IS NULL
            AND pp.created_by = ANY(${householdIds})
            -- V4-SOFTDEL-001 F3: match the DELETE handler below, which already carries
            -- pp.deleted_at IS NULL. Without it this GET 200s a detail page for an event whose
            -- container is in the trash — and the delete button on that page 404s.
            AND pp.deleted_at IS NULL
            -- Deleted-PLANTING policy — see HIDE_EVENTS_UNDER_DELETED_PLANTING (disabled today).
            AND (${HIDE_EVENTS_UNDER_DELETED_PLANTING}::boolean IS NOT TRUE
                 OR e.plant_id IS NULL
                 OR EXISTS (SELECT 1 FROM public.garden_node gn
                             WHERE gn.id = e.plant_id AND gn.deleted_at IS NULL))
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      // DELETE /api/events/:id — single-event undo. SOFT-DELETE ONLY (deleted_at; never
      // hard-delete) + watering entity_memory recompute, mirroring the batch-undo path above.
      // Callers: Dashboard 5s undo toast, EventDetail delete, ProjectDetail delete.
      // XP/streak/achievements are NOT reversed here (same as batch undo — reconciliation
      // cron concern, V1.2a-2).
      //
      // CHILD-ROW HANDLING (BUG-EVTCASCADE-001, 2026-08-03). Until this fix the undo touched
      // event_log ONLY, so every delete stranded its children against a dead parent: 18 of 45
      // all-time deletes leaked (9 harvest_log + 6 photos + 6 critter_state), and integrity-weekly
      // caught the growth 2026-08-03. Each child type gets the treatment its SEMANTICS demand —
      // a blanket cascade would have destroyed photos:
      //   * harvest_log  -> CASCADE soft-delete. It is a pure detail record of the harvest event
      //     (no date of its own; readers all drive FROM event_log and LEFT JOIN it). With the
      //     event gone the quantity means nothing, so an undo must take it too — otherwise the
      //     row is unreachable-but-live debt forever.
      //   * photos       -> DETACH, never delete. A photo is irreplaceable user content that
      //     happens to hang off an event; deleting a harvest must not eat the picture. Null the
      //     dangling event_id and re-parent to the event's project/plant so the photo survives in
      //     the gallery AND photos_must_have_parent still holds (it is COALESCE, not assignment —
      //     an existing parent always wins).
      //   * critter_state -> DELIBERATELY UNTOUCHED. Rewards are never clawed back on undo (same
      //     policy as the XP/streak/achievements note above). integrity-weekly's orphan predicate
      //     was narrowed to match, so a soft-deleted parent no longer reads as corruption; a
      //     MISSING (hard-deleted) parent still does.
      if (method === 'DELETE') {
        const owned = await sql`
          SELECT el.id, el.project_id, el.event_type, el.plant_id
          FROM event_log el
          JOIN public.container pp ON pp.id = el.project_id
          WHERE el.id = ${eventId}
            AND el.deleted_at IS NULL
            AND pp.created_by = ANY(${householdIds})
            AND pp.deleted_at IS NULL
        `;
        if (!owned.length) return resp(404, { error: 'Not found' });
        const projectId = owned[0].project_id;
        const plantId = owned[0].plant_id;
        const stmts = [
          sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
          sql`UPDATE event_log SET deleted_at = NOW(), updated_at = NOW()
              WHERE id = ${eventId} AND deleted_at IS NULL`,
          sql`UPDATE harvest_log SET deleted_at = NOW(), updated_at = NOW()
              WHERE event_id = ${eventId} AND deleted_at IS NULL`,
          // Re-parent FROM the event row rather than from JS locals. The old reason given here —
          // that the neon driver cannot type a NULL bound param even with an explicit ::uuid cast —
          // is false; see the correction above (probed on 0.10.4 against prod). The real reason is
          // provenance: plant_id is NULL on every project-level event, so the JS locals cannot say
          // which parent is the live one, while the event row always can. Reading both parents out
          // of event_log lets the COALESCEs below pick the surviving parent without JS deciding.
          sql`UPDATE photos ph SET
                event_id   = NULL,
                project_id = COALESCE(ph.project_id, e.project_id),
                plant_id   = COALESCE(ph.plant_id,   e.plant_id),
                updated_at = NOW()
              FROM event_log e
              WHERE e.id = ${eventId} AND ph.event_id = ${eventId} AND ph.deleted_at IS NULL`,
        ];
        // BUG-CARECACHEUNDO-001 (2026-08-07): this recompute used to be gated on
        // `event_type === 'watering' || 'rain'`, so undoing a harvest / fertilizing / pruning /
        // observation soft-deleted the event and then updated NOTHING. The forward upserts are all
        // GREATEST(), so the stale column could never walk backwards on its own and nothing else
        // repaired it — the drift was permanent. The gate is gone: every undo now recomputes every
        // recency column from the surviving events.
        //
        // next_water_at stays watering-gated, in SQL rather than in JS. It is NOT a recency cache —
        // the nightly daily-plan engine owns "due" — so recomputing it from last_watered + interval
        // on an unrelated undo would clobber the engine's value. Binding the undone event's type
        // keeps that one column's behaviour byte-for-byte what it was.
        const undoneType = owned[0].event_type;
        stmts.push(sql`
          WITH surv AS (
            SELECT (SELECT MAX(e.event_date) FROM event_log e
              WHERE e.project_id = ${projectId} AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL) AS mw,
            (SELECT MAX(e.event_date) FROM event_log e
              WHERE e.project_id = ${projectId} AND e.deleted_at IS NULL) AS me,
            (SELECT MAX(e.event_date) FROM event_log e
              WHERE e.project_id = ${projectId} AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL) AS mf,
            (SELECT MAX(e.event_date) FROM event_log e
              WHERE e.project_id = ${projectId} AND e.event_type = 'pruning' AND e.deleted_at IS NULL) AS mp,
            (SELECT MAX(e.event_date) FROM event_log e
              WHERE e.project_id = ${projectId} AND e.event_type = 'observation' AND e.deleted_at IS NULL) AS mo,
            (SELECT MAX(e.event_date) FROM event_log e
              WHERE e.project_id = ${projectId} AND e.event_type = 'harvest' AND e.deleted_at IS NULL) AS mh,
            (SELECT MAX(e.event_date) FROM event_log e
              WHERE e.project_id = ${projectId} AND e.flagged_as_issue = true AND e.deleted_at IS NULL) AS mi
          )
          UPDATE entity_memory em SET
            last_watered_at = surv.mw,
            last_event_at = surv.me,
            last_fertilized_at = surv.mf,
            last_pruned_at = surv.mp,
            last_observed_at = surv.mo,
            last_harvested_at = surv.mh,
            last_issue_at = surv.mi,
            next_water_at = CASE WHEN ${undoneType}::text NOT IN ('watering','rain') THEN em.next_water_at
              WHEN surv.mw IS NULL THEN NULL ELSE
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
        if (plantId) {
          stmts.push(sql`
            -- Care re-key Step B (care-rekey-001): plant-keyed recompute (single undo). Recency
            -- only (no next_water_at). Recomputes THIS planting's care cache from its own
            -- surviving events. Guarded on plantId (project-level events have plant_id NULL).
            -- BUG-CARECACHEUNDO-001: was last_watered_at only; column set and event_type mapping
            -- now mirror 0b-backfill.sql / the plant-keyed forward upsert exactly.
            WITH surv AS (
              SELECT (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = ${plantId} AND e.event_type IN ('watering','rain') AND e.deleted_at IS NULL) AS mw,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = ${plantId} AND e.deleted_at IS NULL) AS me,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = ${plantId} AND e.event_type = 'fertilizing' AND e.deleted_at IS NULL) AS mf,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = ${plantId} AND e.event_type = 'pruning' AND e.deleted_at IS NULL) AS mp,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = ${plantId} AND e.event_type = 'observation' AND e.deleted_at IS NULL) AS mo,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = ${plantId} AND e.event_type IN ('harvest','first_harvest') AND e.deleted_at IS NULL) AS mh,
              (SELECT MAX(e.event_date) FROM event_log e
                WHERE e.plant_id = ${plantId} AND e.flagged_as_issue = true AND e.deleted_at IS NULL) AS mi
            )
            UPDATE entity_memory em SET
              last_watered_at = surv.mw,
              last_event_at = surv.me,
              last_fertilized_at = surv.mf,
              last_pruned_at = surv.mp,
              last_observed_at = surv.mo,
              last_harvested_at = surv.mh,
              last_issue_at = surv.mi,
              updated_at = NOW()
            FROM surv WHERE em.plant_id = ${plantId}
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

      // BUG-UNSCOPEDPLANTLOG-001: plant_id WITHOUT project_id fell through BOTH branches below into
      // the unfiltered household feed — plantId was read and then silently ignored, so a
      // project-less planting's event log rendered the whole garden's most recent `limit` events
      // under that planting's name (in prod, 50/50 watering). Not a fringe shape: PlantingDetail
      // omits project_id BY DESIGN for CaptureFlow rows that have none, so this was the ONLY
      // request it ever sent for them.
      //
      // Ownership CANNOT run through the container here — there is no project to join. It runs
      // through the planting itself, via the same canonical predicate the POST path uses
      // (loadOwnedPlantingRef, whose own-created_by arm is exactly the project-less case). That
      // loader also rejects a malformed uuid with null rather than letting a 22P02 become a 500,
      // and it filters gn.deleted_at — which is why the HIDE_EVENTS_UNDER_DELETED_PLANTING guard
      // the other two branches carry is a no-op here and deliberately omitted.
      if (plantId && !projectId) {
        if (!await loadOwnedPlantingRef(sql, plantId, householdIds)) return resp(404, { error: 'Not found' });
        const plantRows = await sql`
          SELECT
            e.id, e.project_id, e.location_id, e.plant_id,
            e.event_type, e.event_date, e.notes,
            e.quantity, e.is_public, e.logged_by, e.created_at,
            e.metadata,
            pp.display_name AS project_name
          FROM event_log e
          -- LEFT, not the INNER join the other two branches use. A project-less planting's events
          -- carry project_id NULL, and an inner join on e.project_id drops every one of them — the
          -- same NULL-parent hazard harvest-summary's unattributed arm exists to handle. This
          -- branch would otherwise trade "shows the whole garden" for "shows nothing", which is
          -- the quieter and worse of the two lies.
          LEFT JOIN public.container pp ON pp.id = e.project_id
          WHERE e.plant_id = ${plantId}
            AND e.deleted_at IS NULL
            -- Household scope is already established on the planting above; this second arm keeps
            -- the container rule for the rows that DO have one (a caller may pass plant_id alone
            -- for a planting that has a project).
            AND (e.project_id IS NULL
                 OR (pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL))
          ORDER BY e.event_date DESC, e.created_at DESC
          LIMIT ${limit}
        `;
        return resp(200, plantRows);
      }

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
              -- V4-SOFTDEL-001 F3 (container rule; see the /feed route above for the rationale).
              AND pp.deleted_at IS NULL
              -- Deleted-PLANTING policy — see HIDE_EVENTS_UNDER_DELETED_PLANTING (disabled today).
              AND (${HIDE_EVENTS_UNDER_DELETED_PLANTING}::boolean IS NOT TRUE
                   OR e.plant_id IS NULL
                   OR EXISTS (SELECT 1 FROM public.garden_node gn
                               WHERE gn.id = e.plant_id AND gn.deleted_at IS NULL))
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
              -- V4-SOFTDEL-001 F3 (container rule; see the /feed route above for the rationale).
              AND pp.deleted_at IS NULL
              -- Deleted-PLANTING policy — see HIDE_EVENTS_UNDER_DELETED_PLANTING (disabled today).
              AND (${HIDE_EVENTS_UNDER_DELETED_PLANTING}::boolean IS NOT TRUE
                   OR e.plant_id IS NULL
                   OR EXISTS (SELECT 1 FROM public.garden_node gn
                               WHERE gn.id = e.plant_id AND gn.deleted_at IS NULL))
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
              -- V4-SOFTDEL-001 F3 (container rule; see the /feed route above for the rationale).
              AND pp.deleted_at IS NULL
              -- Deleted-PLANTING policy — see HIDE_EVENTS_UNDER_DELETED_PLANTING (disabled today).
              AND (${HIDE_EVENTS_UNDER_DELETED_PLANTING}::boolean IS NOT TRUE
                   OR e.plant_id IS NULL
                   OR EXISTS (SELECT 1 FROM public.garden_node gn
                               WHERE gn.id = e.plant_id AND gn.deleted_at IS NULL))
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
      // BUG-CAPTUREFLOW400-001: normalize absent -> NULL. validatePostBody now admits a body with
      // plant_id and no project_id, so this is genuinely nullable rather than validator-guaranteed.
      const projectId = body.project_id ?? null;
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
      // V4-HARVDUAL-001 Slice A — optional user-supplied weight, converted to grams server-side
      // (the client sends whatever the scale read). 0 = not supplied; see the CTE note below.
      const harvestUserGrams = isHarvest && typeof body.harvest.weight === 'number'
        ? toGrams(body.harvest.weight, body.harvest.weight_unit) : 0;

      // ── Step 0: household ownership gate on every body-supplied parent id ────────────────────
      // BUG-EVENTSOWN-001 / events-authz-gap-V100. Before this, POST /api/events took body
      // project_id / plant_id / location_id straight from the request and inserted them. RLS policy
      // `events_auth_insert` only asserts current_user_id() = created_by — it says nothing about
      // the PARENTS — and `garden_node` / `container` are views with no security_invoker, so base
      // table RLS does not even apply to this Lambda's queries. The Lambda predicate is the ONLY
      // real authorization gate here.
      //
      // Impact this closes is not "a junk row": the transaction below upserts entity_memory
      // (last_watered_at / next_water_at / last_harvested_at / last_issue_at), which the Today band
      // and the daily-plan engine read. A forged watering event silently SUPPRESSES a real care
      // reminder on someone else's planting — the failure mode is a dead plant, not a visible bad
      // row. Severity MEDIUM only because the prod Clerk instance is sign_up.mode=restricted;
      // **if that is ever switched off restricted this reclassifies to HIGH**.
      //
      // Same predicate, same generic-400 contract, same warnRejectedFk observability as the
      // BUG-TAGENTOWN-001 fix in lambda/tags and the sweep landing in lambda/plants — one pattern.
      // location_id is gated too: the assessment's table listed only project_id/plant_id, but
      // body.location_id is inserted on this path with no check either and is the same class.
      //
      // NARROWING CHANGE — measured blast radius on live prod 2026-08-04. Historical rows that
      // WOULD have been rejected by these predicates: 1 (soft-deleted project), 39 (soft-deleted
      // planting, 35 of them via the batch path which is separately scoped), 31 (soft-deleted
      // location). All are parents soft-deleted AFTER their event was written, and only 9 live
      // single-path events carry a location_id at all. No client sends a foreign id. Per the
      // assessment this should ship on its own, not folded into a feature promote.
      if (projectId) {
        if (!await loadOwnedProject(sql, projectId, householdIds)) {
          warnRejectedFk(userId, 'event_log', 'project_id', projectId);
          return resp(400, { error: 'Invalid project_id' });
        }
      }
      if (body.plant_id) {
        if (!await loadOwnedPlantingRef(sql, body.plant_id, householdIds)) {
          warnRejectedFk(userId, 'event_log', 'plant_id', body.plant_id);
          return resp(400, { error: 'Invalid plant_id' });
        }
      }
      if (body.location_id) {
        // V4-AUTHZRESIDUE-001 — P0 FIX. This read `!AUTHZ_UUID_RE.test(String(body.location_id)) ||`
        // against a constant that exists NOWHERE in the repo (the file imports UUID_RE, not
        // AUTHZ_UUID_RE), so every POST /api/events carrying a location_id threw ReferenceError,
        // fell to the generic catch, and answered 500 — the ownership gate never ran and the write
        // never happened. Nothing caught it: eslint.config.js is a scoped design-token ruleset that
        // never runs no-undef over lambda/, and the events tests are static source-regex scans.
        // The local guard is now redundant rather than merely fixed: household.js loadOwnedLocation
        // carries its own UUID pre-check, so a malformed id answers the same 400 as a foreign one.
        // That completes this block's original "drop this line when the loaders merge and gain their
        // own guard" note. A new lambda/authz-write-fk.test.js block now fails CI on any undeclared
        // SCREAMING_CASE constant in a handler, which is what would have caught this.
        if (!await loadOwnedLocation(sql, body.location_id, householdIds)) {
          warnRejectedFk(userId, 'event_log', 'location_id', body.location_id);
          return resp(400, { error: 'Invalid location_id' });
        }
      }
      // BUG-AUTHZFKENUM-001 — the create half of the treatment_product_id gate (see the PUT arm).
      // Gated on the raw body value rather than the isTreatment-narrowed `treatmentProductId`
      // computed below: a non-treatment event discards the field anyway, so the only behaviour
      // change is that a foreign id is rejected instead of silently dropped, and gating the raw
      // field is what keeps this a single unconditional call site the static guard can count.
      if (body.treatment_product_id != null) {
        if (!await loadOwnedInventoryItem(sql, body.treatment_product_id, householdIds)) {
          warnRejectedFk(userId, 'event_log', 'treatment_product_id', body.treatment_product_id);
          return resp(400, { error: 'Invalid treatment_product_id' });
        }
      }

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
               logged_by, created_by, metadata, source,
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
              -- V4-EVENTSOURCE-001: provenance recorded at the write. This is what makes app_events
              -- droppable later WITHOUT losing the only "did this come through the app?" surface in
              -- the schema (packet item 10 Option B). Do not drop app_events until this has landed
              -- AND the drift repair has completed — daily_xp_capped is still the only measurement
              -- of forfeited XP anywhere.
              ${EVENT_SOURCE_SINGLE},
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
              flagged_as_issue, severity, resolved_at, resolved_by, source,
              treatment_product_id, treatment_product_text, treatment_category, treatment_amount, pest_target,
              created_at, updated_at
          ),
          new_harvest AS (
            INSERT INTO harvest_log
              (event_id, project_id, quantity, unit, quality_rating, notes, created_by,
               weight_grams, weight_estimated, weight_basis)
            SELECT
              ne.id, ne.project_id,
              ${harvestQty}::numeric,
              ${harvestUnit},
              ${harvestQuality}::smallint,
              ${harvestNotes},
              ${userId},
              -- CAL-1 weight, resolved by public.resolve_harvest_weight (v2, slicec-001) — the
              -- SINGLE derivation locus, called identically by the PUT recompute above. Order:
              -- user-supplied grams > weight-unit harvest > cultivar_weight_derived (real samples) >
              -- variety unit_weights > crop unit_weights (gated on variety_grams_required) > NULL.
              -- NULL = UNKNOWN = no estimate, still never guessed. The function returns all THREE
              -- columns together so every harvest_log weight CHECK holds by construction.
              -- 0 is the "no user weight" sentinel and NULLIF reintroduces the nullability inside
              -- SQL. NOT because the driver cannot type a null bound param — that claim is false,
              -- probed on the pinned 0.10.4 against prod. Kept because it works; see the PUT arm.
              rw.weight_grams,
              rw.weight_estimated,
              rw.weight_basis
            FROM new_event ne,
            LATERAL public.resolve_harvest_weight(
              ne.plant_id, ${harvestUnit}, ${harvestQty}::numeric,
              NULLIF(${harvestUserGrams}::numeric, 0)
            ) rw
            WHERE ${isHarvest}::boolean = true
            RETURNING id, quantity, unit, quality_rating, notes, weight_grams, weight_estimated, weight_basis
          )
          SELECT
            ne.*,
            (SELECT row_to_json(nh) FROM new_harvest nh) AS harvest_row
          FROM new_event ne
        `,
        sql`
          -- BUG-EMPROJGUARD-001 (POST path): self-guard on project_id, mirroring the plant-keyed
          -- sibling below. Was an unconditional VALUES, which was safe only while validatePostBody
          -- required project_id. Now that a plant-only body is admitted (BUG-CAPTUREFLOW400-001),
          -- an unguarded NULL would insert a ZERO-parent row, violate exactly_one_parent, and abort
          -- the whole transaction — converting the old guaranteed 400 into a 500. These two fixes
          -- MUST ship together.
          INSERT INTO entity_memory
            (project_id, last_event_at,
             last_watered_at, last_fertilized_at, last_pruned_at, last_observed_at, last_harvested_at,
             next_water_at, last_issue_at)
          SELECT
            ${projectId}::uuid,
            ${eventDate}::timestamptz,
            CASE WHEN ${eventType} IN ('watering','rain')      THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'fertilizing' THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'pruning'       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'observation'   THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'harvest'       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} IN ('watering','rain')      THEN ${eventDate}::timestamptz + INTERVAL '4 days' ELSE NULL END,
            CASE WHEN ${flagged}::boolean = true     THEN ${eventDate}::timestamptz ELSE NULL END
          WHERE ${projectId}::uuid IS NOT NULL
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
        sql`
          -- Care re-key Step B (care-rekey-001): ADDITIVE plant-keyed dual-write (single event).
          -- Self-guards on plant_id — project-level events have plant_id NULL, so the SELECT yields
          -- no row (never violates the 3-way exactly-one-parent CHECK). Columns match 0b-backfill.sql
          -- (no next_water_at). Reads still project-keyed (Step D cuts over).
          --
          -- BUG-LASTISSUEPLANT-001 (2026-08-07): last_issue_at was omitted here while the
          -- project-keyed sibling above has written it since it shipped, so ALL 262 plant rows read
          -- NULL and 72 of them sat permanently BEHIND the event log — exactly the 72 live flagged
          -- events. Harmless only while reads stay project-keyed; Step D's cutover would have turned
          -- it into a silent Findings regression with nothing failing and nothing logging.
          -- next_water_at stays out on purpose: the nightly engine owns "due", not this writer.
          INSERT INTO entity_memory
            (plant_id, last_event_at,
             last_watered_at, last_fertilized_at, last_pruned_at, last_observed_at, last_harvested_at,
             last_issue_at)
          SELECT ${body.plant_id ?? null}::uuid,
            ${eventDate}::timestamptz,
            CASE WHEN ${eventType} IN ('watering','rain')            THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'fertilizing'                   THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'pruning'                       THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} = 'observation'                   THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${eventType} IN ('harvest','first_harvest')    THEN ${eventDate}::timestamptz ELSE NULL END,
            CASE WHEN ${flagged}::boolean = true                     THEN ${eventDate}::timestamptz ELSE NULL END
          WHERE ${body.plant_id ?? null}::uuid IS NOT NULL
          ON CONFLICT (plant_id) WHERE plant_id IS NOT NULL DO UPDATE SET
            last_event_at      = GREATEST(COALESCE(entity_memory.last_event_at,      ${eventDate}::timestamptz), ${eventDate}::timestamptz),
            last_watered_at    = CASE WHEN ${eventType} IN ('watering','rain')         THEN GREATEST(COALESCE(entity_memory.last_watered_at,    ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_watered_at    END,
            last_fertilized_at = CASE WHEN ${eventType} = 'fertilizing'                THEN GREATEST(COALESCE(entity_memory.last_fertilized_at, ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_fertilized_at END,
            last_pruned_at     = CASE WHEN ${eventType} = 'pruning'                    THEN GREATEST(COALESCE(entity_memory.last_pruned_at,     ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_pruned_at     END,
            last_observed_at   = CASE WHEN ${eventType} = 'observation'                THEN GREATEST(COALESCE(entity_memory.last_observed_at,   ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_observed_at   END,
            last_harvested_at  = CASE WHEN ${eventType} IN ('harvest','first_harvest') THEN GREATEST(COALESCE(entity_memory.last_harvested_at,  ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_harvested_at  END,
            -- BUG-LASTISSUEPLANT-001, second pass. The first pass added last_issue_at to the INSERT
            -- column list and the SELECT above but NOT here, which made the fix a no-op for every
            -- row that already exists: a brand-new planting whose first event is flagged got a
            -- value, and all 262 live plant rows could never advance one. The INSERT arm of an
            -- upsert only runs on first touch — the DO UPDATE is the arm that does the work on a
            -- mature table, and it is the easier of the two to leave out because the column list
            -- above reads complete.
            last_issue_at      = CASE WHEN ${flagged}::boolean = true                  THEN GREATEST(COALESCE(entity_memory.last_issue_at,      ${eventDate}::timestamptz), ${eventDate}::timestamptz) ELSE entity_memory.last_issue_at      END,
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
        // CAL-2 germination capture — logging a `germination` event on a specific planting stamps
        // germinated_at (the event date) the FIRST time only (set-once via `germinated_at IS NULL`).
        // Same explicit household ownership scope + no-RLS caveat as the flowering/fruit_set
        // UPDATEs above (L-087). No-op on every non-germination event (the ${eventType} gate) and
        // when plant_id is null / the planting is already germinated. germinated_at_approx=false.
        sql`
          UPDATE public.garden_node p
             SET germinated_at = ${eventDate}::timestamptz,
                 germinated_at_approx = false,
                 updated_at = NOW()
            FROM public.container pp
           WHERE ${eventType}::text = 'germination'
             AND p.id = ${body.plant_id ?? null}
             AND p.container_id = pp.id
             AND pp.created_by = ANY(${householdIds})
             AND p.deleted_at IS NULL
             AND p.germinated_at IS NULL
        `,
      ]);

      // F12 — JS-side extraction of harvest sub-row from the joined CTE row.
      const newEvent = txResult[1][0];
      const harvest = newEvent.harvest_row;
      delete newEvent.harvest_row;
      newEvent.harvest = harvest;
      const eventId = newEvent.id;

      // V4-HARVDUAL-001 Slice C — auto-capture the calibration sample. A harvest logged with BOTH a
      // count and a weight IS a per-variety measurement ("5 San Marzano, 337 g" = 67.4 g/fruit), and
      // capturing it is what retires the reference-estimate tier one variety at a time.
      //
      // Runs AFTER the transaction, not inside it: record_harvest_weight_sample needs the event row
      // to exist (FK + it reads event_date), and a CTE's INSERT is not visible to a function called
      // from a sibling CTE in the same statement. sql.transaction() also cannot feed statement 1's
      // returned id into statement 2.
      //
      // NEVER THROWS, mirroring the critter hook below: a calibration sample is derived data, and
      // losing one must never fail the user's harvest save. Recovery is by RE-SAVING the harvest
      // (the PUT path calls this function unconditionally), or by calling
      // record_harvest_weight_sample directly for the affected event ids.
      //
      // NOT by the 0c backfill — an earlier version of this comment claimed that and it is FALSE
      // (corrected 2026-08-04). 0c-backfill-basis.sql never references cultivar_weight_sample at
      // all, and it is deliberately measured-safe: its WHERE clause excludes every row where
      // (weight_estimated IS FALSE AND unit NOT IN ('g','kg','lb','oz')) — i.e. precisely the
      // user-weighed rows a calibration sample comes from. Re-running 0c recovers NOTHING here.
      //
      // All the branch logic (weight-unit harvests, unattributed plantings, unchanged re-saves)
      // lives in the SQL function, so this stays a single call from both write paths.
      if (isHarvest && harvestUserGrams > 0) {
        try {
          await sql`SELECT public.record_harvest_weight_sample(
            ${eventId}::uuid, ${newEvent.plant_id}::uuid, ${harvestUnit},
            ${harvestQty}::numeric, ${harvestUserGrams}::numeric, ${userId})`;
        } catch (e) {
          console.warn('[cal1] auto-capture of the weight sample failed (harvest saved):', e?.message);
        }
      }

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
      //
      // BUG-BATCHSIDEEFFECTS-001 — total_events is now the RECOMPUTED live count, not `+ 1`.
      // The blind increment was the only non-idempotent column in this block and the direct cause
      // of user_stats.total_events reading 2,003 against 11,993 real live rows: every batch event
      // bypassed this path entirely, and a retry of this path double-counted. An absolute value is
      // idempotent by definition, keeps the single and batch paths in agreement (batchSideEffects.js
      // Step 2 writes the identical expression), and converges rather than accumulating.
      // ⚠ DEPLOY-VISIBLE: the FIRST event logged after this ships jumps total_events from 2,003 to
      // ~12,000 in one step. Verified safe against an achievement avalanche — the event_count
      // ladder tops out at 500 (five_hundred) and all four rungs are already earned by the only
      // user with batch history. The extra aggregate rides inside the query that was already
      // scanning these exact rows, so it costs no additional round trip.
      let achievementResult = { newly_earned: [], current_streak: null, total_events: null, level_before: null };
      // BUG-XPPROGRESSION-001 — the action's FINAL level, threaded forward through the three blocks
      // that can move XP (3a readback, 3b flat grant, 3c achievement grant). Every assignment is a
      // value trg_user_stats_level wrote; nothing here computes a level. Kept separate from
      // `level_before` so `leveled_up` is a comparison of two distinct readings, not of a variable
      // with itself.
      let levelAfter = null;
      try {
        const actRows = await sql`
          WITH z AS (SELECT ${userTz}::text AS tz)
          SELECT
            to_char((NOW() AT TIME ZONE (SELECT tz FROM z))::date, 'YYYY-MM-DD') AS today,
            (SELECT count(*)::int FROM event_log e
              WHERE e.created_by = ${userId} AND e.deleted_at IS NULL) AS live_events,
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
        const liveEvents = actRows[0]?.live_events ?? null;
        const activityDays = (actRows[0]?.days ?? []).map((d) => String(d).slice(0, 10));
        const { current, longest } = computeStreak(activityDays, todayStr, STREAK_GRACE_DAYS);
        const latestDay = activityDays.length ? activityDays[0] : todayStr;

        const statsRows = await sql`
          INSERT INTO user_stats (user_id, total_events, last_active_date, current_streak, longest_streak)
          VALUES (${userId}, ${liveEvents}, ${latestDay}::date, ${current}, ${longest})
          ON CONFLICT (user_id) DO UPDATE SET
            total_events     = ${liveEvents},
            current_streak   = ${current},
            longest_streak   = GREATEST(user_stats.longest_streak, ${longest}),
            last_active_date = ${latestDay}::date,
            updated_at       = NOW()
          RETURNING current_streak, total_events, level
        `;
        if (statsRows.length) {
          achievementResult.current_streak = statsRows[0].current_streak;
          achievementResult.total_events   = statsRows[0].total_events;
          // BUG-XPPROGRESSION-001 — `level` is read back, never computed here. It is derived from
          // `xp` by trg_user_stats_level (migrations/v4-xpprogression-001/0a) on every write to
          // this table, so this upsert gets the current level for free even though it touches no
          // XP column. This is `level_before` for the level-up comparison at the end of the block.
          achievementResult.level_before = statsRows[0].level;
          levelAfter = statsRows[0].level;
        }
      } catch (statsErr) {
        console.warn('user_stats streak upsert failed (non-fatal)', statsErr.message);
      }

      // ── Step 3b: flat XP grant with daily cap (timezone-aware) ───────────────────────────────
      // BUG-XPPROGRESSION-001 — THIS BLOCK MOVED. It used to be Step 4, i.e. it ran AFTER the
      // achievement evaluation that is now Step 3c. The order is now: move the XP, then judge
      // against it. That is a hard requirement of the `level` trigger branch, not a tidy-up:
      // `level` is derived from `xp`, so evaluating `WHEN 'level'` before this grant lands would
      // judge the user against their XP as of BEFORE the action they just took, and level_5 /
      // level_9 would fire one logging action late. For the main user (20 median actions/day) that
      // lag is seconds; for the second user (8 active days in 120, 2 median actions) the crossing
      // action is very often the LAST of a session, so "one action late" is "weeks late, or never
      // if they stop" — the same unreachable-content failure this ticket exists to kill, in
      // miniature. Every other trigger type is unaffected: the evaluator's other inputs (streak,
      // total_events, event counts) come from Step 3a and event_log, not from XP.
      // SAFE TO REORDER — verified, not assumed: the two blocks have no data dependency in either
      // direction. This grant reads only (user, tz, today's event_logged sum) and the daily cap
      // deliberately filters `reason = 'event_logged'`, so achievement XP has never counted toward
      // it (F16) and still does not. Step 5's telemetry still runs after both.
      let flatXpResult = { granted: 0, today_total: 0, daily_xp_remaining: DAILY_FLAT_XP_CAP, level: null };
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
            -- eventId is brand new on every single-event POST, so this cannot conflict today. It is
            -- here so the single and batch grants carry the SAME retry semantics: at most one
            -- 'event_logged' grant per logging action, enforced by 0c rather than by convention.
            ON CONFLICT (user_id, reason, source_id) WHERE source_id IS NOT NULL DO NOTHING
            RETURNING amount
          ),
          stats AS (
            UPDATE user_stats
              SET xp = user_stats.xp + COALESCE((SELECT amount FROM flat_grant), 0),
                  updated_at = NOW()
            WHERE user_id = ${userId}
            -- level is absent from this SET list ON PURPOSE. trg_user_stats_level derives it from
            -- the NEW xp in the same statement, so it is returned already-correct below. Assigning
            -- it here would be a second, driftable copy of the curve — the exact defect
            -- V4-CAL1-HARVWEIGHT-002 extracted a SQL function to kill.
            RETURNING xp, level
          )
          SELECT
            COALESCE((SELECT amount FROM flat_grant), 0)::int AS granted,
            ((SELECT today_sum FROM today_xp) + COALESCE((SELECT amount FROM flat_grant), 0))::int AS today_total,
            (SELECT level FROM stats) AS level_after_flat
        `;
        if (rows.length) {
          flatXpResult.granted     = rows[0].granted;
          flatXpResult.today_total = rows[0].today_total;
          flatXpResult.daily_xp_remaining = Math.max(0, DAILY_FLAT_XP_CAP - rows[0].today_total);
          if (rows[0].level_after_flat != null) {
            flatXpResult.level = rows[0].level_after_flat;
            levelAfter = rows[0].level_after_flat;
          }
        }
      } catch (xpErr) {
        console.warn('flat XP grant failed (non-fatal)', xpErr.message);
      }

      // ── Step 3c: inline achievement evaluation for existing trigger types ────────────────────
      // F17 brief override: harvest_quantity / harvest_quality CASE branches DEFERRED to V4.
      // issue_resolve_count is resolve-path-only by design — intentional no-op on POST.
      // harvest_century works automatically via the existing event_type_count evaluator (count of
      // event_type='harvest' events); no special handling needed for V1.2a-2 ship.
      // F16: no daily cap on achievement XP — encouragement-class grants stay uncapped.
      // BUG-XPPROGRESSION-001 — was Step 3b; now runs after the flat grant (see Step 3b's header).
      try {
        if (achievementResult.current_streak != null) {
          const streakVal = achievementResult.current_streak;
          const totalVal  = achievementResult.total_events;
          // Post-grant level, falling back to the Step-3a readback if the flat grant failed or was
          // capped out. NOT computed in JS — both sources are values trg_user_stats_level wrote.
          const levelVal  = levelAfter;
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
                  -- BUG-XPPROGRESSION-001. Unlocks level_5 (True Gardener, 100 XP, {"level":5}) and
                  -- level_9 (Master, 500 XP, {"level":9}) — both live, both is_active, both with
                  -- ZERO earners since 2026-04-21 because this branch did not exist and every
                  -- level trigger_type fell through to ELSE false. src/pages/Achievements.jsx has
                  -- been printing "Reach level 5" as a locked hint the whole time.
                  -- levelVal is READ from user_stats (trg_user_stats_level owns it), never computed
                  -- in JS, and is post-flat-grant — see Step 3b's reorder note.
                  WHEN 'level'            THEN ${levelVal}::int   >= (a.trigger_value->>'level')::int
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
              -- See the resolve path above: defensive against the new 0c unique index, never fires.
              ON CONFLICT (user_id, reason, source_id) WHERE source_id IS NOT NULL DO NOTHING
              RETURNING amount, source_id
            ),
            stats_xp AS (
              UPDATE user_stats
                SET xp = user_stats.xp + COALESCE((SELECT SUM(amount) FROM xp_grants), 0),
                    updated_at = NOW()
              WHERE user_id = ${userId}
                AND EXISTS (SELECT 1 FROM xp_grants)
              -- Achievement XP can itself cross a level boundary. level is not in the SET list
              -- (the trigger owns it); returning it lets the response report the FINAL level of the
              -- action rather than the mid-action one.
              RETURNING xp, level
            )
            SELECT COALESCE(
              (SELECT json_agg(
                 json_build_object('slug', a.slug, 'name', a.name, 'emoji', a.emoji, 'xp_reward', a.xp_reward)
                 ORDER BY a.sort_order
               )
               FROM xp_grants xg JOIN achievements a ON a.id = xg.source_id),
              '[]'::json
            ) AS newly_earned,
            (SELECT level FROM stats_xp) AS level_after_achievements
          `;
          if (earnedRows.length) {
            achievementResult.newly_earned = earnedRows[0].newly_earned ?? [];
            // NULL whenever no achievement XP was granted (stats_xp is guarded on EXISTS) — in that
            // case the level after the flat grant is already final.
            if (earnedRows[0].level_after_achievements != null) {
              levelAfter = earnedRows[0].level_after_achievements;
            }
          }
        }
      } catch (achErr) {
        console.warn('achievement eval failed (non-fatal)', achErr.message);
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
        // BUG-XPPROGRESSION-001. `level` was previously absent from every response, so even a
        // correct level would have been invisible to the client. `leveled_up` is a comparison of
        // two READINGS of user_stats.level (before Step 3a's upsert vs after the last XP grant),
        // never a JS recomputation — so it stays true to whatever the trigger decided.
        // Both are null in the degraded case where Step 3a itself threw; the client must treat
        // null as "unknown", not as level 0.
        level: levelAfter,
        leveled_up: levelAfter != null && achievementResult.level_before != null
          && levelAfter > achievementResult.level_before,
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

