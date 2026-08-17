// /api/critters Lambda — MVP-Critter Stages 1+2+3 server.
// Canonical spec: mvp-critter-pre-build-revision-V001-20260528.md §2 (Lambda routes + handlers).
// Binding parent: reward-ux-guideline-V100-20260518.1830.md (CONTENT-LOCKED).
//
// Routes (11):
//   POST   /api/critters                           Award critter for action-completion event (MVP plant-only)
//   GET    /api/critters/active                    Unviewed + unfaded list for household
//   GET    /api/critters/collection             Per-user lifetime stickerbook summary (Collection page Phase 2 wiring)
//   GET    /api/critters/:id                       Single row (smoke verification)
//   PATCH  /api/critters/viewed                    Mark unviewed → viewed (Stage 3 dot clear, race-window guarded)
//   PATCH  /api/critters/species-prefs             D-INV-1 Option A: long-press love/meh weight
//   POST   /api/notifications/garden-view-opened   Updates last_garden_view_at (Stage 4 reopen instrumentation §3.3)
//   GET    /api/notifications/prefs                Read current prefs (stateless defaults)
//   PATCH  /api/notifications/prefs                Persist toggle change
//   POST   /api/notifications/coachmark-dismissed  One-shot: writes coachmark_seen_at = now()
//   POST   /api/notifications/opt-in-dismissed     One-shot: writes opt_in_prompt_seen_at = now() (suppression-flag fix §3.8)
//
// Scope: ZERO RLS in current Neon. Lambda enforces via householdScope(clerk_sub) → created_by = ANY(${ids}).
// Idempotency: POST /api/critters relies on UNIQUE INDEX idx_critter_state_source_event_id.
//   PG 23505 (unique_violation) caught + returns existing row → idempotent success (revision §3.27).
// CORS: Lambda URL config owns it. Handler keeps CORS = {} per L-097.
// Deploy marker: cold-start console.log per revision §2.6 — smoke greps last 5min logs before block I.

import { neon } from '@neondatabase/serverless'
import { verifyToken } from '@clerk/backend'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { householdScope } from './household.js'
import {
  validatePrefsPatchBody, validateSpeciesPrefsPatchBody,
  validateMarkViewedPatchBody, UUID_RE,
} from './validators.js'

// Deploy marker — fires once per cold start. Smoke step greps last 5min CloudWatch for this string.
// L-072 / L-104 family: green tests ≠ green deploy. Marker proves the *running* Lambda is current.
console.log(`critter-lambda: deploy-marker ${process.env.GIT_SHA ?? 'unknown'}`)

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' })

let _secrets = null
async function getSecrets() {
  if (_secrets) return _secrets
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' })
  const res = await sm.send(cmd)
  _secrets = JSON.parse(res.SecretString)
  return _secrets
}

const CORS = {} // Lambda URL config owns CORS — handler must NOT duplicate (L-097)

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

// Quiet-hours server-side evaluation per revision §3.6. Returns ISO timestamp of the
// "dot becomes visible" moment — either now (outside quiet hours) or the next 07:00 local.
// Client TZ is passed via header `x-client-tz-offset` (minutes from UTC, JS convention).
function computeDotVisibleAfter(now, quietStart, quietEnd, tzOffsetMin) {
  // Defaults if prefs missing.
  const start = quietStart ?? '21:00'
  const end = quietEnd ?? '07:00'
  const offset = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0
  // Local now = UTC now + (-offset) minutes (JS getTimezoneOffset() returns minutes west of UTC).
  const localNow = new Date(now.getTime() - offset * 60 * 1000)
  const localHM = `${String(localNow.getUTCHours()).padStart(2, '0')}:${String(localNow.getUTCMinutes()).padStart(2, '0')}`
  // Quiet hours window. Two cases: same-day (start < end, e.g., 13:00-15:00) or cross-midnight (start > end, default 21:00-07:00).
  const inQuiet = start > end
    ? (localHM >= start || localHM < end)
    : (localHM >= start && localHM < end)
  if (!inQuiet) return now.toISOString()
  // Compute next 07:00 local. If localHM >= start (still tonight), end-time is "tomorrow morning";
  // if localHM < end (already past midnight), end-time is "today morning".
  const [eh, em] = end.split(':').map(Number)
  const target = new Date(localNow)
  target.setUTCHours(eh, em, 0, 0)
  if (target <= localNow) target.setUTCDate(target.getUTCDate() + 1)
  // Back to UTC.
  return new Date(target.getTime() + offset * 60 * 1000).toISOString()
}

// Read user prefs with stateless defaults (revision §3.2). Never persists on read.
async function readUserPrefs(sql, clerkSub) {
  const rows = await sql`
    SELECT critter_visit, quiet_hours_start, quiet_hours_end,
           coachmark_seen_at, opt_in_prompt_seen_at, last_garden_view_at,
           garden_group_by, garden_sort_order, garden_expanded,
           garden_bloom_seen, garden_helper_rung1_seen,
           today_skipped, log_many_all_selected, whats_new_last_seen,
           created_at, updated_at
      FROM public.user_notification_prefs
     WHERE created_by = ${clerkSub}
     LIMIT 1
  `
  if (rows.length > 0) return rows[0]
  return {
    critter_visit: 'in_app_only',
    quiet_hours_start: '21:00:00',
    quiet_hours_end: '07:00:00',
    coachmark_seen_at: null,
    opt_in_prompt_seen_at: null,
    last_garden_view_at: null,
    garden_group_by: null,
    garden_sort_order: null,
    garden_expanded: null,
    garden_bloom_seen: null,
    garden_helper_rung1_seen: null,
    // V4-USERPREFS-001. NULL is the honest default for all three: it means "this user has not set
    // it", which is what every client-side fallback already assumes. Do NOT substitute a concrete
    // default here — that would make "unset" indistinguishable from a real choice, the same trap
    // V4-ACQMATURE-001's nullable-no-default column exists to avoid.
    today_skipped: null,
    log_many_all_selected: null,
    whats_new_last_seen: null,
    created_at: null, updated_at: null,
  }
}

// ─── handler ───────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' }
  }

  const secrets = await getSecrets()
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  let userId
  try {
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: [
        'https://garden.futureishere.net',
        'https://dg6mmjhepoyt9.cloudfront.net',
      ],
    })
    userId = payload.sub
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err))
    return resp(401, { error: 'Unauthorized' })
  }
  // V4-AUTHZRESIDUE-001 (mirrors lambda/plants + lambda/photos): householdScope('') returns [''] and
  // `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty/absent JWT subject would be a live
  // ownership value rather than a no-match. verifyToken rejects such a token first, so this is
  // defence-in-depth; the point is that the invariant is ENFORCED here rather than relied upon.
  if (!userId) return resp(401, { error: 'Unauthorized' })

  const sql = neon(secrets.NEON_DATABASE_URL)
  const householdIds = householdScope(userId)
  const method = event.requestContext?.http?.method ?? 'GET'
  const rawPath = event.rawPath ?? ''
  const headers = event.headers ?? {}
  const tzOffsetMin = parseInt(headers['x-client-tz-offset'] ?? headers['X-Client-Tz-Offset'] ?? '0', 10)

  try {
    // ── Route 1: POST /api/critters — RETIRED 2026-08-12 (BUG-CRITTERSELFGRANT-001) ──────
    // This route inserted a critter_state row for ANY event in the caller's household: no
    // event_type gate, NO PROBABILITY ROLL AT ALL, and the CALLER CHOSE species_id. It was a
    // guaranteed self-grant of the one reward in this system that writes durable data (xp, streak
    // and total_events are all recomputed from event_log; a critter_state row persists until
    // someone deletes it). Strictly worse than the ~47.5% server roll that BUG-CRITTERNONREWARD-001
    // gated, and it predated the NON_REWARD_EVENT_TYPES partition entirely.
    //
    // Retired rather than gated. Gating would have needed a codegen change — the event-type
    // vocabulary generates into lambda/events/ only — to teach this Lambda a vocabulary it has no
    // other reason to know, in order to keep a route with no callers alive.
    //
    // Evidence there were none, checked before removal rather than assumed:
    //   * SPA: critterClient.awardCritter() had zero call sites; EventNew.jsx:1041 records that the
    //     server-side hook (events Lambda -> critterAward.js) replaced it. That dead client function
    //     is removed in the same commit, so no client can name this path.
    //   * PROD: all 1277 live critter_state rows carry meta->>'deterministic_seed', which ONLY
    //     awardCritterServer writes; this route wrote the caller's meta (default {}). Zero rows have
    //     ever come from here. (Live read-only query, 2026-08-12.)
    // Requests now fall through to the 404 at the bottom of this handler.

    // ── Route 2: GET /api/critters/active ───────────────────────────────
    // Two lifetime counts per species_id (incl. viewed/faded; excludes soft-deleted):
    //   species_user_count      — scoped to THIS user (created_by = userId). Drives the
    //                              "✨ First sighting!" celebration. Stickerbook is per-person
    //                              per Dave 2026-05-31 (each user collects their own roster).
    //   species_household_count — scoped to household (ANY(householdIds)). Plumbed but not
    //                              yet surfaced — reserved for future "Welcome to your garden"
    //                              household-milestone moment (separate from personal stickerbook).
    if (rawPath === '/api/critters/active' && method === 'GET') {
      const rows = await sql`
        -- V4-PERFCRITTER-001: per-species lifetime counts via single-pass GROUP BY CTEs
        -- (was correlated per-row COUNT subqueries). Counts include viewed/faded, exclude
        -- soft-deleted — identical scope to the prior subqueries. Response shape byte-identical
        -- (verified vs prod 2026-07-01). user_counts drives the personal "First sighting!"
        -- celebration; hh_counts is household-scoped (plumbed, not yet surfaced).
        WITH active AS (
          SELECT cs.id, cs.species_id, cs.target_kind, cs.target_id, cs.plant_id,
                 cs.source_event_id, cs.earned_at, cs.viewed_at, cs.faded_at,
                 cs.dot_visible_after, cs.meta
            FROM public.critter_state cs
           WHERE cs.created_by = ANY(${householdIds})
             AND cs.faded_at IS NULL
             AND cs.deleted_at IS NULL
        ),
        user_counts AS (
          SELECT species_id, COUNT(*)::int AS c
            FROM public.critter_state
           WHERE created_by = ${userId}
             AND deleted_at IS NULL
           GROUP BY species_id
        ),
        hh_counts AS (
          SELECT species_id, COUNT(*)::int AS c
            FROM public.critter_state
           WHERE created_by = ANY(${householdIds})
             AND deleted_at IS NULL
           GROUP BY species_id
        )
        SELECT a.id, a.species_id, a.target_kind, a.target_id, a.plant_id,
               a.source_event_id, a.earned_at, a.viewed_at, a.faded_at,
               a.dot_visible_after, a.meta,
               COALESCE(uc.c, 0) AS species_user_count,
               COALESCE(hc.c, 0) AS species_household_count
          FROM active a
          LEFT JOIN user_counts uc ON uc.species_id = a.species_id
          LEFT JOIN hh_counts hc ON hc.species_id = a.species_id
         ORDER BY a.earned_at DESC
      `
      return resp(200, { critters: rows })
    }

    // ── Route 2.5: GET /api/critters/collection (per-user stickerbook) ──
    // Per-USER lifetime species summary for Collection page Phase 2 wiring.
    // Scope: created_by = userId (NOT householdIds). Per Dave 2026-05-31
    //   ("stickerbook is per person, not per household"). species_household_count
    //   remains plumbed on Route 2 for the household-first celebration badge;
    //   this route is the per-USER lifetime view (the stickerbook).
    // Lifetime: includes viewed AND faded rows (excludes only soft-deleted).
    // Species never earned by the user are absent from the response — the frontend
    // renders them as silhouettes per spec V001.
    // IMPORTANT: declared BEFORE Route 3 (GET /api/critters/:id) so the "collection"
    //   path segment doesn't get UUID-matched as an :id by Route 3's regex.
    if (rawPath === '/api/critters/collection' && method === 'GET') {
      const rows = await sql`
        SELECT species_id,
               COUNT(*)::int AS count,
               MIN(earned_at) AS first_seen_at,
               MAX(earned_at) AS last_seen_at
          FROM public.critter_state
         WHERE created_by = ${userId}
           AND deleted_at IS NULL
         GROUP BY species_id
         ORDER BY first_seen_at ASC
      `
      return resp(200, { species: rows })
    }

    // ── Route 3: GET /api/critters/:id (smoke verification) ─────────────
    const byId = rawPath.match(/^\/api\/critters\/([^/]+)$/)
    if (byId && method === 'GET') {
      const id = byId[1]
      if (!UUID_RE.test(id)) return resp(400, { error: 'id must be a UUID' })
      const rows = await sql`
        SELECT id, species_id, target_kind, target_id, plant_id,
               source_event_id, earned_at, viewed_at, faded_at, dot_visible_after, meta
          FROM public.critter_state
         WHERE id = ${id}
           AND created_by = ANY(${householdIds})
           AND deleted_at IS NULL
         LIMIT 1
      `
      if (rows.length === 0) return resp(404, { error: 'not found' })
      return resp(200, { critter: rows[0] })
    }

    // ── Route 4: PATCH /api/critters/viewed (Stage 3 dot clear) ─────────
    // Session 3.5 (revision §3.26): accepts optional { actually_seen_critter_ids: [uuid...] }.
    // Non-empty → mark ONLY those ids (per-sprite IO-gated marking). Missing/empty → bulk fallback.
    // Race-window guard (revision §2.5) preserved in both branches.
    if (rawPath === '/api/critters/viewed' && method === 'PATCH') {
      const gateHeader = headers['x-garden-view-opened-at'] ?? headers['X-Garden-View-Opened-At']
      const gate = gateHeader ?? new Date().toISOString()
      // Body is OPTIONAL on this route (legacy callers send no body for bulk path).
      let actuallySeenIds = null
      if (event.body) {
        let parsed
        try { parsed = JSON.parse(event.body) } catch { return resp(400, { error: 'malformed JSON body' }) }
        const vErr = validateMarkViewedPatchBody(parsed)
        if (vErr) return resp(vErr.status, { error: vErr.error })
        if (parsed && Array.isArray(parsed.actually_seen_critter_ids) && parsed.actually_seen_critter_ids.length > 0) {
          actuallySeenIds = parsed.actually_seen_critter_ids
        }
      }
      let upd
      if (actuallySeenIds) {
        // Per-sprite path: scope-bound + race-window-guarded, but limited to the supplied id set.
        upd = await sql`
          UPDATE public.critter_state
             SET viewed_at = now()
           WHERE created_by = ANY(${householdIds})
             AND viewed_at IS NULL
             AND deleted_at IS NULL
             AND earned_at < ${gate}::timestamptz
             AND id = ANY(${actuallySeenIds}::uuid[])
          RETURNING id
        `
      } else {
        // Bulk fallback (legacy behavior).
        upd = await sql`
          UPDATE public.critter_state
             SET viewed_at = now()
           WHERE created_by = ANY(${householdIds})
             AND viewed_at IS NULL
             AND deleted_at IS NULL
             AND earned_at < ${gate}::timestamptz
             AND id IN (
               SELECT id FROM public.critter_state
                WHERE created_by = ANY(${householdIds})
                  AND viewed_at IS NULL
                  AND deleted_at IS NULL
                  AND earned_at < ${gate}::timestamptz
                ORDER BY earned_at DESC
                LIMIT 50
             )
          RETURNING id
        `
      }
      return resp(200, { marked_viewed_ids: upd.map(r => r.id) })
    }

    // ── Route 5: PATCH /api/critters/species-prefs (D-INV-1 Option A) ───
    if (rawPath === '/api/critters/species-prefs' && method === 'PATCH') {
      const body = JSON.parse(event.body ?? '{}')
      const vErr = validateSpeciesPrefsPatchBody(body)
      if (vErr) return resp(vErr.status, { error: vErr.error })
      const rows = await sql`
        INSERT INTO public.critter_species_prefs (created_by, species_id, weight)
        VALUES (${userId}, ${body.species_id}, ${body.weight})
        ON CONFLICT (created_by, species_id) DO UPDATE
          SET weight = EXCLUDED.weight, set_at = now()
        RETURNING created_by, species_id, weight, set_at
      `
      return resp(200, rows[0])
    }

    // ── Route 6: POST /api/notifications/garden-view-opened ─────────────
    if (rawPath === '/api/notifications/garden-view-opened' && method === 'POST') {
      await sql`
        INSERT INTO public.user_notification_prefs (created_by, last_garden_view_at)
        VALUES (${userId}, now())
        ON CONFLICT (created_by) DO UPDATE
          SET last_garden_view_at = now(), updated_at = now()
      `
      return resp(200, { last_garden_view_at: new Date().toISOString() })
    }

    // ── Route 7: GET /api/notifications/prefs (stateless defaults) ──────
    if (rawPath === '/api/notifications/prefs' && method === 'GET') {
      const prefs = await readUserPrefs(sql, userId)
      return resp(200, prefs)
    }

    // ── Route 8: PATCH /api/notifications/prefs ─────────────────────────
    if (rawPath === '/api/notifications/prefs' && method === 'PATCH') {
      const body = JSON.parse(event.body ?? '{}')
      const vErr = validatePrefsPatchBody(body)
      if (vErr) return resp(vErr.status, { error: vErr.error })
      // Build column set dynamically (NULLs are skip via COALESCE on UPDATE).
      // Use INSERT...ON CONFLICT DO UPDATE for upsert.
      const cv = body.critter_visit ?? null
      const qs = body.quiet_hours_start ?? null
      const qe = body.quiet_hours_end ?? null
      const gg = body.garden_group_by ?? null
      const gso = body.garden_sort_order ?? null
      const geArr = body.garden_expanded ?? null
      const ge = geArr == null ? null : JSON.stringify(geArr)
      const gbsArr = body.garden_bloom_seen ?? null
      const gbs = gbsArr == null ? null : JSON.stringify(gbsArr)
      const ghr = body.garden_helper_rung1_seen ?? null
      // V4-USERPREFS-001. today_skipped is jsonb, so it is stringified here and cast at every
      // binding site below — EVERY site, including the INSERT VALUES and both COALESCE arms. A
      // bare NULL parameter has no inferable type to Postgres and fails with "could not determine
      // data type of parameter" rather than with anything that names the column; the cast is what
      // makes the null arm legal, not a stylistic flourish.
      const tsObj = body.today_skipped ?? null
      const ts = tsObj == null ? null : JSON.stringify(tsObj)
      const lma = body.log_many_all_selected ?? null
      const wnls = body.whats_new_last_seen ?? null
      const rows = await sql`
        INSERT INTO public.user_notification_prefs (created_by, critter_visit, quiet_hours_start, quiet_hours_end, garden_group_by, garden_sort_order, garden_expanded, garden_bloom_seen, garden_helper_rung1_seen, today_skipped, log_many_all_selected, whats_new_last_seen)
        VALUES (
          ${userId},
          COALESCE(${cv}, 'in_app_only'),
          COALESCE(${qs}::time, '21:00'::time),
          COALESCE(${qe}::time, '07:00'::time),
          ${gg},
          ${gso},
          ${ge},
          ${gbs},
          ${ghr},
          ${ts}::jsonb,
          ${lma}::boolean,
          ${wnls}::text
        )
        ON CONFLICT (created_by) DO UPDATE SET
          critter_visit      = COALESCE(${cv}, public.user_notification_prefs.critter_visit),
          quiet_hours_start  = COALESCE(${qs}::time, public.user_notification_prefs.quiet_hours_start),
          quiet_hours_end    = COALESCE(${qe}::time, public.user_notification_prefs.quiet_hours_end),
          garden_group_by    = COALESCE(${gg}, public.user_notification_prefs.garden_group_by),
          garden_sort_order  = COALESCE(${gso}, public.user_notification_prefs.garden_sort_order),
          garden_expanded    = COALESCE(${ge}, public.user_notification_prefs.garden_expanded),
          garden_bloom_seen  = COALESCE(${gbs}, public.user_notification_prefs.garden_bloom_seen),
          garden_helper_rung1_seen = COALESCE(${ghr}, public.user_notification_prefs.garden_helper_rung1_seen),
          today_skipped        = COALESCE(${ts}::jsonb, public.user_notification_prefs.today_skipped),
          log_many_all_selected = COALESCE(${lma}::boolean, public.user_notification_prefs.log_many_all_selected),
          whats_new_last_seen  = COALESCE(${wnls}::text, public.user_notification_prefs.whats_new_last_seen),
          updated_at         = now()
        RETURNING critter_visit, quiet_hours_start, quiet_hours_end,
                  coachmark_seen_at, opt_in_prompt_seen_at, last_garden_view_at, garden_group_by, garden_sort_order, garden_expanded, garden_bloom_seen, garden_helper_rung1_seen, today_skipped, log_many_all_selected, whats_new_last_seen, updated_at
      `
      return resp(200, rows[0])
    }

    // ── Route 9: POST /api/notifications/coachmark-dismissed (idempotent one-shot) ──
    if (rawPath === '/api/notifications/coachmark-dismissed' && method === 'POST') {
      const rows = await sql`
        INSERT INTO public.user_notification_prefs (created_by, coachmark_seen_at)
        VALUES (${userId}, now())
        ON CONFLICT (created_by) DO UPDATE
          SET coachmark_seen_at = COALESCE(public.user_notification_prefs.coachmark_seen_at, now()),
              updated_at = now()
        RETURNING coachmark_seen_at
      `
      return resp(200, rows[0])
    }

    // ── Route 10: POST /api/notifications/opt-in-dismissed ──────────────
    // Suppression-flag fix per revision §3.8: caller ONLY POSTs after prompt ACTUALLY rendered.
    if (rawPath === '/api/notifications/opt-in-dismissed' && method === 'POST') {
      const rows = await sql`
        INSERT INTO public.user_notification_prefs (created_by, opt_in_prompt_seen_at)
        VALUES (${userId}, now())
        ON CONFLICT (created_by) DO UPDATE
          SET opt_in_prompt_seen_at = COALESCE(public.user_notification_prefs.opt_in_prompt_seen_at, now()),
              updated_at = now()
        RETURNING opt_in_prompt_seen_at
      `
      return resp(200, rows[0])
    }


    return resp(404, { error: `route not found: ${method} ${rawPath}` })
  } catch (err) {
    console.error('critter-lambda error:', err)
    return resp(500, { error: 'Internal Server Error' })
  }
}
