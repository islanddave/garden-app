// watch-route.js — V4-HARVSURFACE-001 slice 1 request handlers for the Today watch list.
//
// Lives beside index.js rather than inside it so the SQL and the request/response contract are
// testable with an injected `sql` (see watch-route.test.js — a recording tagged-template stub that
// runs THIS code, not a regex over it). index.js keeps its role as the auth/secrets/CORS seam.
//
// ROUTING. These paths ride the EXISTING /api/harvests prefix in src/lib/api.js, which is a
// first-match PREFIX table — so /api/harvests/watch resolves to VITE_API_HARVESTS and this Lambda
// with ZERO infra change: no new Function URL, no new repo variable, no deploy-lambda.yml matrix
// entry, no api.js edit. That is the whole reason this route landed here rather than in a new
// Lambda or in lambda/events (whose harvest-ready route is correctly evidence-only; see watch.js).
//
// THIS LAMBDA WAS READ-ONLY BEFORE THIS SLICE and index.js 405s anything that is not
// GET /api/harvests. The dismissal write is the first mutation it has ever performed, so it is
// deliberately narrow: one INSERT into one new standalone table, one UPDATE that sets undone_at on
// a row the caller owns. It touches no existing relation. (V4-WATCHIMPRESSION-001 later added one
// more narrow write: the GET path's NON-FATAL batch insert into public.watch_impression — see the
// impression-log section below; it too touches no existing relation and cannot fail the request.)

import {
  WATCH_MODEL_VERSION, NURSERY_OFFSET_DAYS_FALLBACK, DERIVED_ANCHOR_ENABLED,
  buildWatchList, buildDismissalSnapshot, toYmd,
} from './watch.js';

// V4-ANCHORFLIP-001 condition 1 — the seam that makes a ROUTE-LEVEL flag-on test possible.
//
// The consult's objection to the flip was that the flag-on path had never been exercised through
// the ROUTE, only through fixtures handed straight to the pure module — so the join, the column
// aliases and the resolver were each tested in isolation and their COMPOSITION was tested nowhere.
// Reading the flag through one function lets watch-route.test.js drive the whole handler flag-on
// against real-shaped rows, which is the only place a mis-aliased column would surface.
//
// THIS IS NOT THE FLIP AND DOES NOT WEAKEN IT. `ctx` is a closed object literal built in
// index.js — no request field, header or query parameter reaches it — so in every deployed
// environment this resolves to DERIVED_ANCHOR_ENABLED, which is `false` and stays false until
// condition 9 (Dave's call). The override exists for tests exactly as `siblingHabits` does in
// watch.js, and for the same reason: a measured effect nobody can reproduce is an unverified one.
export function resolveDerivedEnabled(ctx) {
  return typeof ctx?.derivedEnabled === 'boolean' ? ctx.derivedEnabled : DERIVED_ANCHOR_ENABLED;
}

export const WATCH_PATH = '/api/harvests/watch';
export const DISMISS_PATH = '/api/harvests/watch/dismiss';
export const DISMISSALS_PATH = '/api/harvests/watch/dismissals';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

// The reasons the CHECK constraint permits. Only 'not_yet' is calibration-bearing — the other two
// are data corrections and MUST be excluded when fitting, which is why they are distinguishable
// rather than collapsed. A row dismissed as 'wrong_target' is not evidence a crop was unripe.
export const DISMISSAL_REASONS = new Set(['not_yet', 'not_mine', 'wrong_target']);
export const CALIBRATION_REASON = 'not_yet';

// Default visible cap (design §3.5: "Cap the visible group at 5 — a nine-row declarative group is an
// inventory again"). Enforced SERVER-side as the default so a client that forgets cannot regress the
// surface into the shape Dave rejected, and overridable because the client owns an expandable tail.
// MAX_LIMIT raised 50 -> 200 for the tail contract (panel Q4): the band fetches the whole queue in
// one request so the in-place expand needs no second round trip; total_watching stays the honest
// depth if the queue ever exceeds even this.
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 200;

export function parseLimit(raw) {
  if (raw == null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, MAX_LIMIT);
}

// ── The candidate query ──────────────────────────────────────────────────────────────────────────
//
// Returns raw rows for the PURE classifier in watch.js. SQL narrows and gathers anchors; it decides
// nothing — same split the shipped harvest-ready route uses, and the reason the eligibility rules
// are unit-testable at all.
//
// SHAPE NOTES, all verified against live prod 2026-08-12 (read-only, garden_ro):
//   * View vocabulary: garden_node = plants, cultivar = plant_varieties. garden_node's FK to the
//     project is `container_id`, NOT `project_id` (the base table's name). Getting that wrong is a
//     hard error, not a silent one.
//   * Household scope anchors on plant_projects.created_by, matching the rest of this Lambda. It
//     does NOT anchor on the planting: garden_node.created_by exists but the project is the
//     ownership root everywhere else in this file.
//   * Live planting = deleted_at/archived_at NULL and status NOT IN (failed, ended, dormant), the
//     same definition lambda/events/index.js:893 settled on after a dormant wineberry ranked #1.
//   * The harvest-evidence CTE keeps the LEFT JOIN + first_harvest escape from the shipped route:
//     `first_harvest` is a MILESTONE that carries no quantity by design and therefore NEVER has a
//     harvest_log row (5/5 orphaned on prod). An INNER JOIN here would tell the watch list that a
//     planting Dave has already picked still needs watching — the exact inverse of the bug being
//     fixed.
//   * The pick date is event_log.event_date, never harvest_log.created_at (~30% backdated).
//
// SIBLING ANCHOR (design §3.4 rank 2, "the strongest anchor available in the data and it is
// currently unused"). Same project AND same crop_type_slug — the design's justification is "same
// genetics, same site, same weather", and same-project alone does not establish the first of those
// for a mixed project. MIN(first pick) across siblings, because the design admits a planting to the
// queue when its EARLIEST defensible anchor fires: if the bed has been picking for 30 days, this
// planting has been worth checking for 30 days, and dating it from the most recent sibling would
// understate that.
//
// NURSERY OFFSET is computed PER HOUSEHOLD from that household's own plantings rather than baked in
// — the correction for a from-sow DTM read off a transplant date should reflect how this gardener
// actually starts seeds. Dave's median is 31 days over 39 dual-dated plantings (n is reported on the
// wire so a thin sample is visible rather than silently trusted); below 5 samples it falls back to
// the documented constant.
export async function queryWatchRows(sql, householdIds, userId, tz) {
  return sql`
    WITH bounds AS (
      SELECT (now() AT TIME ZONE ${tz})::date AS et_today,
             -- Grow year = Nov 1 - Oct 31 (the season boundary this codebase already uses).
             (make_date(
                EXTRACT(YEAR FROM (now() AT TIME ZONE ${tz})::date)::int
                  - CASE WHEN EXTRACT(MONTH FROM (now() AT TIME ZONE ${tz})::date)::int >= 11 THEN 0 ELSE 1 END,
                11, 1))::date AS season_start
    ),
    picks AS (
      SELECT e.plant_id,
             count(*)::int AS harvest_count,
             MIN((e.event_date AT TIME ZONE ${tz})::date) AS first_pick_date
        FROM event_log e
        LEFT JOIN harvest_log h ON h.event_id = e.id AND h.deleted_at IS NULL
        CROSS JOIN bounds b
       WHERE e.event_type IN ('harvest', 'first_harvest')
         AND e.deleted_at IS NULL
         AND e.plant_id IS NOT NULL
         AND (h.id IS NOT NULL OR e.event_type = 'first_harvest')
         AND (e.event_date AT TIME ZONE ${tz})::date >= b.season_start
       GROUP BY e.plant_id
    ),
    fruit_set AS (
      SELECT e.plant_id, MAX((e.event_date AT TIME ZONE ${tz})::date) AS fruit_set_date
        FROM event_log e CROSS JOIN bounds b
       WHERE e.event_type = 'fruit_set'
         AND e.deleted_at IS NULL
         AND e.plant_id IS NOT NULL
         AND (e.event_date AT TIME ZONE ${tz})::date >= b.season_start
       GROUP BY e.plant_id
    ),
    live AS (
      SELECT gn.id            AS plant_id,
             gn.container_id  AS project_id,
             gn.display_name  AS planting_name,
             gn.status,
             gn.location_id,
             gn.sown_at, gn.transplanted_at, gn.planted_out_at,
             cv.id            AS variety_id,
             cv.display_name  AS variety_name,
             cv.crop_type_slug,
             cv.days_to_maturity_min, cv.days_to_maturity_max,
             ct.display_name  AS crop_display_name,
             ct.harvest_habit, ct.dtm_basis, ct.set_to_first_pick_days
        FROM garden_node gn
        JOIN plant_projects pj ON pj.id = gn.container_id
        JOIN cultivar cv       ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
        JOIN crop_types ct     ON ct.slug = cv.crop_type_slug AND ct.deleted_at IS NULL
       WHERE pj.created_by = ANY(${householdIds})
         AND pj.deleted_at IS NULL
         AND pj.archived_at IS NULL
         AND gn.deleted_at IS NULL
         AND gn.archived_at IS NULL
         AND (gn.status IS NULL OR gn.status NOT IN ('failed', 'ended', 'dormant'))
    ),
    sibling AS (
      SELECT l.plant_id,
             s.plant_id      AS sibling_plant_id,
             s.planting_name AS sibling_planting_name,
             s.first_pick_date AS sibling_first_pick_date,
             -- Panel Q2: the sibling's own planting dates ride along so the basis string can state
             -- the planting-date offset — a 3-week succession breaks the shared-clock premise.
             s.sown_at        AS sibling_sown_at,
             s.transplanted_at AS sibling_transplanted_at,
             s.planted_out_at AS sibling_planted_out_at
        FROM live l
        JOIN LATERAL (
          SELECT sl.plant_id, sl.planting_name, sl.sown_at, sl.transplanted_at, sl.planted_out_at,
                 pk.first_pick_date
            FROM live sl
            JOIN picks pk ON pk.plant_id = sl.plant_id
           WHERE sl.project_id = l.project_id
             AND sl.plant_id <> l.plant_id
             AND sl.crop_type_slug IS NOT DISTINCT FROM l.crop_type_slug
             AND pk.first_pick_date IS NOT NULL
           ORDER BY pk.first_pick_date ASC, sl.plant_id ASC
           LIMIT 1
        ) s ON true
    ),
    -- Active "not yet" suppression, scoped to THIS USER (not the household): a dismissal records
    -- who OBSERVED. Dave's phone and his tablet share a user_id, which is what makes the dismissal
    -- cross-device; Jen looking at a melon must not clear it from Dave's queue, and both
    -- observations are independently valid calibration samples.
    -- suppressed_until NULL = suppress for the rest of the grow year (design §3.5 makes dismissal a
    -- queue EXIT); a date re-opens the watch on that day. Season-scoped either way.
    dismissed AS (
      SELECT d.plant_id
        FROM public.harvest_watch_dismissal d CROSS JOIN bounds b
       WHERE d.user_id = ${userId}
         AND d.undone_at IS NULL
         AND d.observed_on >= b.season_start
         AND (d.suppressed_until IS NULL OR d.suppressed_until > b.et_today)
       GROUP BY d.plant_id
    ),
    -- The MOST RECENT (not-undone) dismissal per planting this season, active or expired. Two
    -- consumers, both panel-decided (Q3/Q4): the snoozed payload prints its suppressed_until as the
    -- return date, and the byte-identical-basis guard reconstructs the dismissed instance's basis
    -- from its frozen anchor columns. Separate from the dismissed CTE above on purpose — that one
    -- answers "is suppression ACTIVE", this one answers "what did the last dismissal freeze".
    last_dismissal AS (
      SELECT DISTINCT ON (d.plant_id)
             d.plant_id, d.observed_on, d.suppressed_until,
             d.anchor_kind, d.anchor_date, d.anchor_basis, d.anchor_basis_shifted,
             d.expected_days, d.lead_days
        FROM public.harvest_watch_dismissal d CROSS JOIN bounds b
       WHERE d.user_id = ${userId}
         AND d.undone_at IS NULL
         AND d.observed_on >= b.season_start
       ORDER BY d.plant_id, d.observed_on DESC, d.dismissed_at DESC
    ),
    -- V4-ANCHORFLIP-001 condition 1 — the derived anchor (public.plant_anchor_derivation,
    -- migrations/v4-anchorbase-001). Until this join existed, flipping watch.js's
    -- DERIVED_ANCHOR_ENABLED was a RUNTIME NO-OP: availableAnchors() read undefined for every
    -- derived_anchor_* field and the tier could never fire. That is what the expert consult refused
    -- to flip, and the join is the first of its nine conditions.
    --
    -- (No backticks anywhere in this comment block, deliberately: it lives inside a tagged-template
    -- literal, where a backtick TERMINATES the SQL string. Caught by the parse gate, 2026-08-13.)
    --
    -- TWO PREDICATES, BOTH LOAD-BEARING, and neither is a tidiness filter:
    --   * superseded_at IS NULL — a derivation contradicted by a real date is RETIRED, not deleted
    --     (it is the only accuracy measurement tier 3 will ever produce). Selecting a retired row
    --     would cite a guess the data has already disproved. uq_plant_anchor_derivation_live makes
    --     this predicate return at most one row per planting, so the LEFT JOIN cannot fan out.
    --   * plausibility IS NULL — 0a2's marks. rescue_suspect (the add-date is an ACQUISITION date,
    --     not a planting date) and post_frost_impossible (anchor + catalogue DTM lands past first
    --     frost) are rows the backfill itself flagged as not believable. On prod that is 26 of 66.
    --     They stay in the table as evidence and MUST NOT feed the tier.
    --
    -- No user_id predicate on purpose: the live CTE above is already scoped to the household through
    -- plant_projects.created_by, and the derivation's own user_id is the PROJECT OWNER (consult
    -- decision 1, item 4) — re-filtering on it would drop the 13 plantings whose plants.created_by
    -- is the rescue-intake pseudo-user without adding any isolation the join does not already have.
    --
    -- RELATION EXISTS EVERYWHERE THIS RUNS: 0a/0a2 are applied to staging (12 rows) and prod (66),
    -- and CI's integration job branches off staging. Unlike the impression writer this join is NOT
    -- wrapped in a try/catch — it is in the request's critical path, so a missing relation must fail
    -- loudly rather than silently degrade the queue to its pre-derivation shape.
    derived AS (
      SELECT d.plant_id,
             d.anchor_date  AS derived_anchor_date,
             d.anchor_field AS derived_anchor_field,
             d.source       AS derived_anchor_source,
             d.confidence   AS derived_anchor_confidence
        FROM public.plant_anchor_derivation d
       WHERE d.superseded_at IS NULL
         AND d.plausibility IS NULL
    ),
    nursery AS (
      SELECT count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY (gn.transplanted_at - gn.sown_at)
             )::int AS median_gap
        FROM garden_node gn
        JOIN plant_projects pj ON pj.id = gn.container_id
       WHERE pj.created_by = ANY(${householdIds})
         AND gn.deleted_at IS NULL
         AND gn.sown_at IS NOT NULL
         AND gn.transplanted_at IS NOT NULL
         AND gn.transplanted_at >= gn.sown_at
    )
    SELECT l.*,
           COALESCE(pk.harvest_count, 0)      AS prior_harvest_count,
           fs.fruit_set_date,
           sb.sibling_plant_id, sb.sibling_planting_name, sb.sibling_first_pick_date,
           sb.sibling_sown_at, sb.sibling_transplanted_at, sb.sibling_planted_out_at,
           (dm.plant_id IS NOT NULL)          AS dismissed_active,
           to_char(ld.observed_on, 'YYYY-MM-DD')       AS dismissal_observed_on,
           to_char(ld.suppressed_until, 'YYYY-MM-DD')  AS dismissal_suppressed_until,
           ld.anchor_kind                     AS dismissal_anchor_kind,
           to_char(ld.anchor_date, 'YYYY-MM-DD')       AS dismissal_anchor_date,
           ld.anchor_basis                    AS dismissal_anchor_basis,
           ld.anchor_basis_shifted            AS dismissal_anchor_basis_shifted,
           ld.expected_days                   AS dismissal_expected_days,
           ld.lead_days                       AS dismissal_lead_days,
           -- V4-ANCHORFLIP-001 condition 1. to_char, matching the dismissal dates above: a bare date
           -- column round-trips through the driver as a Date whose civil day depends on the reader's
           -- zone, and this value feeds the date arithmetic the whole tier rests on.
           to_char(dv.derived_anchor_date, 'YYYY-MM-DD') AS derived_anchor_date,
           dv.derived_anchor_field, dv.derived_anchor_source, dv.derived_anchor_confidence,
           loc.name                           AS location_name,
           to_char(b.et_today, 'YYYY-MM-DD')  AS et_today,
           to_char(b.season_start, 'YYYY-MM-DD') AS season_start,
           nu.n                               AS nursery_sample_n,
           nu.median_gap                      AS nursery_median_gap
      FROM live l
      CROSS JOIN bounds b
      CROSS JOIN nursery nu
      LEFT JOIN picks pk     ON pk.plant_id = l.plant_id
      LEFT JOIN fruit_set fs ON fs.plant_id = l.plant_id
      LEFT JOIN sibling sb   ON sb.plant_id = l.plant_id
      LEFT JOIN dismissed dm ON dm.plant_id = l.plant_id
      LEFT JOIN last_dismissal ld ON ld.plant_id = l.plant_id
      LEFT JOIN derived dv   ON dv.plant_id = l.plant_id
      LEFT JOIN locations loc ON loc.id = l.location_id AND loc.deleted_at IS NULL
  `;
}

// Below this many dual-dated plantings the household's own median is too thin to trust; fall back
// to the documented constant rather than let one atypical pair set the offset for every crop.
export const NURSERY_MIN_SAMPLE = 5;

export function resolveNurseryOffset(rows) {
  const r = rows?.[0];
  const n = Number(r?.nursery_sample_n ?? 0);
  const gap = Number(r?.nursery_median_gap);
  if (n >= NURSERY_MIN_SAMPLE && Number.isFinite(gap) && gap >= 0) {
    return { days: gap, source: 'household_median', sample_n: n };
  }
  return { days: NURSERY_OFFSET_DAYS_FALLBACK, source: 'fallback_constant', sample_n: n };
}

// ── Impression log (V4-WATCHIMPRESSION-001) ──────────────────────────────────────────────────────
//
// Panel Q3 named this "the highest-value missing piece in the whole design": the dismissal table
// records every "not yet" tap, but nothing records which rows were SHOWN — so every rate in the
// dismissal-calibration refit has an unrecoverable denominator, and a row that was
// correct-but-not-tapped is indistinguishable from a row never seen. The GET path writes one row
// per SERVED planting per region per ET day into public.watch_impression
// (migrations/v4-watchimpression-001), stamped with the SAME WATCH_MODEL_VERSION the dismissal
// rows carry, so numerator and denominator join within one model generation.
//
// REGION HONESTY (the column that keeps the analysis truthful): the server knows what it SERVED,
// not what a human looked at. 'top5' rows render without user action (served ~= seen is fair
// there); 'tail' means IN-THE-RESPONSE-BUT-COLLAPSED — the client expands on tap and there is NO
// client beacon in v1 to say whether it ever did; 'snoozed' rows sit inside the tail's collapsed
// Snoozed subgroup. Rates over 'tail'/'snoozed' impressions are rates over opportunities, not
// views, and the region column is what lets the refit say so instead of silently conflating them.
//
// THE SPLIT MIRRORS THE CLIENT. src/lib/harvestWatch.js selectWatchDisplay allocates the 5 visible
// slots (MAX_WATCH_ROWS=5, per-project cap WATCH_PROJECT_SLOT_CAP=2 — panel Q2) CLIENT-side over
// the served ranked list. That walk is deterministic, so the server reproduces it here to label
// regions; the lambda cannot import src/lib (separate module graphs), so the constants are
// mirrored: DEFAULT_LIMIT already IS the §3.5 visible cap of 5, and the project cap is restated
// below. If either side's constants drift, the region labels lie — change them in lockstep.
export const IMPRESSION_PROJECT_SLOT_CAP = 2; // mirrors src/lib/harvestWatch.js WATCH_PROJECT_SLOT_CAP

// Region/slot assignment over the SERVED slice (post-limit) plus the snoozed payload. Slices, not
// the full queue, on purpose: an unserved row was never on any screen and gets NO impression —
// "never seen" must stay distinguishable from "shown", which is the whole point of the table.
// slot is the 1-based position WITHIN the region (top5 1..5; tail in rank order — tail position
// governs how many reveal-taps stand between the row and a human); NULL for snoozed, whose order
// is a return date, not a rank.
export function splitImpressionRegions(served, snoozed) {
  const rows = [];
  const byProject = new Map();
  let visible = 0;
  let tail = 0;
  for (const c of served ?? []) {
    if (c?.plant_id == null) continue;
    const key = c.project_id ?? `plant:${c.plant_id}`; // a projectless row can never monopolize
    const held = byProject.get(key) ?? 0;
    const isVisible = visible < DEFAULT_LIMIT && held < IMPRESSION_PROJECT_SLOT_CAP;
    if (isVisible) { byProject.set(key, held + 1); visible += 1; } else { tail += 1; }
    rows.push({
      plant_id: c.plant_id,
      slot: isVisible ? visible : tail,
      region: isVisible ? 'top5' : 'tail',
      // Frozen as served, same leakage/drift rationale as the dismissal snapshot. Snoozed rows
      // carry neither — their frozen anchor already lives on their dismissal row.
      anchor_kind: c.anchor?.kind ?? null,
      check_from: toYmd(c.check_from),
    });
  }
  for (const s of snoozed ?? []) {
    if (s?.plant_id == null) continue;
    rows.push({ plant_id: s.plant_id, slot: null, region: 'snoozed', anchor_kind: null, check_from: null });
  }
  return rows;
}

// NON-FATAL BY CONSTRUCTION — same fail-open posture as weather_daily's writer (daily-plan
// handler.js writeWeatherDaily): this is substrate accumulation, and losing one request's
// impressions is a rounding error against failing the GET that renders Today. Never throws, never
// returns a rejected promise; a failure (including "relation does not exist" while the migration
// has not landed yet) logs a warning and the response goes out unchanged.
//
// One statement per request: the batch rides a single INSERT..SELECT over unnest'd arrays, with an
// explicit ::cast on EVERY bind — scalar binds in a SELECT list and nullable array elements are
// both untypeable for Neon's driver ("could not determine data type of parameter"), which inside
// this try/catch would present as the impression log silently never populating.
//
// ON CONFLICT (user_id, plant_id, shown_on, region) DO NOTHING against uq_watch_impression_day:
// N Today opens in one day collapse to one row per region — the DAY is the exposure grain (the
// queue only re-ranks at midnight ET), and without the guard "impressions per day" would measure
// phone-checking frequency, not exposure. region is in the key because a mid-day dismissal
// legitimately moves a row between regions within one day; both facts get recorded.
export async function recordWatchImpressions(sql, { userId, shownOn, served, snoozed }) {
  try {
    // No ET day to stamp -> write nothing. Guessing a civil day would corrupt the dedupe grain,
    // and binding NULL into a NOT NULL column would fail the whole batch anyway.
    if (!shownOn) return 0;
    const rows = splitImpressionRegions(served, snoozed);
    if (rows.length === 0) return 0;
    await sql`
      INSERT INTO public.watch_impression
        (user_id, plant_id, shown_on, slot, region, model_version, anchor_kind, check_from)
      SELECT ${userId}::text, u.plant_id, ${shownOn}::date, u.slot, u.region,
             ${WATCH_MODEL_VERSION}::text, u.anchor_kind, u.check_from
        FROM unnest(
               ${rows.map((r) => r.plant_id)}::uuid[],
               ${rows.map((r) => r.slot)}::smallint[],
               ${rows.map((r) => r.region)}::text[],
               ${rows.map((r) => r.anchor_kind)}::text[],
               ${rows.map((r) => r.check_from)}::date[]
             ) AS u(plant_id, slot, region, anchor_kind, check_from)
      ON CONFLICT (user_id, plant_id, shown_on, region) DO NOTHING
    `;
    // Named observability, matching the weather writer: a log that quietly writes nothing (empty
    // splits, all-conflict days) stays visible in CloudWatch before the refit ever reads it.
    console.log(JSON.stringify({
      metric: 'watch_impressions', model_version: WATCH_MODEL_VERSION, shown_on: shownOn,
      top5: rows.filter((r) => r.region === 'top5').length,
      tail: rows.filter((r) => r.region === 'tail').length,
      snoozed: rows.filter((r) => r.region === 'snoozed').length,
    }));
    return rows.length;
  } catch (e) {
    console.warn(JSON.stringify({
      msg: 'watch_impression write failed — GET response unaffected', error: e?.message,
    }));
    return 0;
  }
}

// GET /api/harvests/watch
export async function handleWatchGet(ctx) {
  const { sql, householdIds, userId, tz, query = {} } = ctx;
  const limit = parseLimit(query.limit);
  if (limit == null) return { statusCode: 400, body: { error: 'limit must be a positive integer' } };

  const rows = await queryWatchRows(sql, householdIds, userId, tz);
  const etToday = toYmd(rows?.[0]?.et_today) ?? toYmd(ctx.etTodayFallback);
  const nursery = resolveNurseryOffset(rows);

  const { candidates, excluded, snoozed } = buildWatchList(rows, etToday, {
    nurseryOffsetDays: nursery.days, derivedEnabled: resolveDerivedEnabled(ctx),
  });

  // PANEL Q2: persist the resolver's exclusion breakdown, do not merely return it. v1 is one
  // structured JSON line per invocation — CloudWatch retains it, so the model's own false-positive
  // region stays on record across resolver changes (the sibling restriction removed the only two
  // n>=20 calibration crops; this line is the audit trail of what the restriction excluded). The
  // filed impression log now exists too — recordWatchImpressions below writes the row-level
  // denominator to public.watch_impression; this line stays as the aggregate-level view of the
  // same request.
  console.log(JSON.stringify({
    metric: 'watch_excluded', model_version: WATCH_MODEL_VERSION, et_today: etToday,
    total_watching: candidates.length, snoozed: snoozed.length, excluded,
  }));

  // What actually goes on the wire — and therefore what the impression log records. An unserved
  // row (a limit below the queue depth) was never on any screen and gets NO impression row.
  const served = candidates.slice(0, limit);

  // V4-WATCHIMPRESSION-001 (panel Q3's "highest-value missing piece"): record what was served,
  // BEFORE the response goes out but never in its way — the writer is non-fatal by construction
  // and a failure (including the migration not having landed yet) cannot affect this GET.
  await recordWatchImpressions(sql, { userId, shownOn: etToday, served, snoozed });

  return {
    statusCode: 200,
    body: {
      time_zone: tz,
      et_today: etToday,
      season_start: toYmd(rows?.[0]?.season_start),
      model_version: WATCH_MODEL_VERSION,
      // The offset that shaped every calendar anchor in this payload, with its provenance and
      // sample size — a client (or a later audit) can see whether the correction rested on this
      // household's own data or on the documented constant.
      nursery_offset: nursery,
      limit,
      // total_watching is the TRUE queue depth, so a client can render an honest tail count. The
      // shipped band's "Showing 3 of 28 ready" line was arithmetically false for exactly the reason
      // this field exists: it counted a different population than it showed.
      total_watching: candidates.length,
      candidates: served,
      // Why every non-candidate is absent. A zero-length list is then explainable instead of being
      // the unreadable silence HarvestReadyBand's `return null` produces for three different states.
      excluded,
      // The suppressed rows themselves (panel Q3/Q4): the tail's "Snoozed" subgroup prints each one
      // with its return date. NOT subject to `limit` — snoozing more things must never hide them.
      snoozed,
    },
  };
}

// POST /api/harvests/watch/dismissals  { plant_id, reason?, observed_on?, note? }
//
// The snapshot is built SERVER-SIDE from the server's own candidate row. The client sends WHICH
// planting and (optionally) WHEN it was observed — never the model fields. A client that could post
// its own snapshot could poison the calibration set, and a stale PWA bundle would post an old
// model's numbers stamped with the current version string.
export async function handleDismissalPost(ctx) {
  const { sql, householdIds, userId, tz, body = {} } = ctx;

  const plantId = body.plant_id;
  if (!isUuid(plantId)) return { statusCode: 400, body: { error: 'plant_id must be a uuid' } };

  const reason = body.reason ?? CALIBRATION_REASON;
  if (!DISMISSAL_REASONS.has(reason)) {
    return { statusCode: 400, body: { error: `reason must be one of: ${[...DISMISSAL_REASONS].join(', ')}` } };
  }

  const note = body.note == null ? null : String(body.note).slice(0, 500);

  const rows = await queryWatchRows(sql, householdIds, userId, tz);
  const etToday = toYmd(rows?.[0]?.et_today) ?? toYmd(ctx.etTodayFallback);
  const nursery = resolveNurseryOffset(rows);

  // observed_on defaults to today and may be BACKDATED, following this codebase's event_date
  // convention (Dave reads the list, walks out, comes back, then logs). Future dates are refused —
  // an observation cannot have happened tomorrow, and one would silently corrupt every calibration
  // interval derived from it.
  const observedOn = toYmd(body.observed_on) ?? etToday;
  if (observedOn == null) return { statusCode: 400, body: { error: 'observed_on must be YYYY-MM-DD' } };
  if (etToday != null && observedOn > etToday) {
    return { statusCode: 400, body: { error: 'observed_on cannot be in the future' } };
  }

  // Household membership is proven by the candidate query itself: it is already scoped to
  // plant_projects.created_by = ANY(household), so a planting outside the household is simply not
  // in `rows`. Same generic answer for absent / foreign / soft-deleted — no existence oracle.
  // Same resolver settings as the GET, and that is a correctness requirement rather than tidiness:
  // if the two disagreed, a row the GET served could not be dismissed (404 "no active candidate")
  // — the dismissal path must see exactly the queue the user was looking at.
  const { candidates } = buildWatchList(rows, etToday, {
    nurseryOffsetDays: nursery.days, derivedEnabled: resolveDerivedEnabled(ctx),
  });
  const candidate = candidates.find((c) => c.plant_id === plantId);
  if (!candidate) {
    return { statusCode: 404, body: { error: 'No active watch-list candidate for that planting' } };
  }

  const snap = buildDismissalSnapshot(candidate, observedOn);

  // ON CONFLICT DO NOTHING against the partial day-grain unique index: a double-tap is a 200 with
  // the existing row rather than a 409 the UI would have to explain, and it does not mint a second
  // sample for the same observation. A genuine re-check on a LATER day is a new row by design.
  // suppressed_until (panel Q3, bounded suppression): observed_on + WATCH_SUPPRESS_DAYS, computed
  // in the snapshot and bound with an explicit ::date cast. The read path already honoured the
  // column; this write is the one bind that had been missing.
  const inserted = await sql`
    INSERT INTO public.harvest_watch_dismissal (
      user_id, plant_id, project_id, observed_on, suppressed_until, reason, note, model_version,
      crop_type_slug, variety_id, anchor_kind, anchor_date, anchor_basis, anchor_basis_shifted,
      expected_days, lead_days, check_from, days_watching
    ) VALUES (
      ${userId}, ${snap.plant_id}::uuid, ${snap.project_id}::uuid, ${snap.observed_on}::date,
      ${snap.suppressed_until}::date,
      ${reason}, ${note}, ${snap.model_version},
      ${snap.crop_type_slug}, ${snap.variety_id}::uuid, ${snap.anchor_kind}, ${snap.anchor_date}::date,
      ${snap.anchor_basis}, ${snap.anchor_basis_shifted},
      ${snap.expected_days}::smallint, ${snap.lead_days}::smallint,
      ${snap.check_from}::date, ${snap.days_watching}::smallint
    )
    ON CONFLICT (user_id, plant_id, observed_on) WHERE undone_at IS NULL DO NOTHING
    RETURNING id, plant_id, observed_on, to_char(suppressed_until, 'YYYY-MM-DD') AS suppressed_until,
              dismissed_at, reason, model_version
  `;

  if (inserted.length > 0) {
    return { statusCode: 201, body: { dismissal: inserted[0], created: true } };
  }

  const existing = await sql`
    SELECT id, plant_id, observed_on, to_char(suppressed_until, 'YYYY-MM-DD') AS suppressed_until,
           dismissed_at, reason, model_version
      FROM public.harvest_watch_dismissal
     WHERE user_id = ${userId} AND plant_id = ${plantId}::uuid
       AND observed_on = ${observedOn}::date AND undone_at IS NULL
     LIMIT 1
  `;
  return { statusCode: 200, body: { dismissal: existing[0] ?? null, created: false } };
}

// POST /api/harvests/watch/dismiss  { plant_id, project_id?, dismissed: true|false }
//
// The BOOLEAN form the UI lane committed against, and the primary dismissal surface. It exists
// because the named v1 risk in Dave's decision is a reflexive tap teaching the model noise, and a
// dismissal with no recovery is exactly how that risk lands.
//
// THE BOOLEAN DOES NOT CORRUPT THE CALIBRATION SIGNAL — but only because `dismissed: false` is a
// RETRACTION, never a delete. It sets undone_at on the active row; the row, its frozen model
// snapshot and its observed_on all survive. That is strictly BETTER for calibration than a design
// with no undo:
//   * a retracted observation is itself labelled data (the user looked again, or mis-tapped), and
//     the fitting query can include or exclude it explicitly via undone_at;
//   * without an undo path, every reflexive mis-tap would be a permanent, unmarked FALSE negative
//     silently poisoning the set, with no way to tell it from a real one.
// So the boolean is accepted as specified. The one invariant it must never acquire is a hard
// DELETE — that would destroy samples and bias the set toward observations someone stayed confident
// about. See handleDismissalUndo.
export async function handleDismissToggle(ctx) {
  const { sql, userId, body = {} } = ctx;

  const plantId = body.plant_id;
  if (!isUuid(plantId)) return { statusCode: 400, body: { error: 'plant_id must be a uuid' } };
  if (typeof body.dismissed !== 'boolean') {
    return { statusCode: 400, body: { error: 'dismissed must be a boolean' } };
  }

  if (body.dismissed) {
    const res = await handleDismissalPost(ctx);
    if (res.statusCode >= 400) return res;
    return {
      statusCode: res.statusCode,
      body: { plant_id: plantId, project_id: res.body.dismissal?.project_id ?? body.project_id ?? null, dismissed: true, dismissal: res.body.dismissal },
    };
  }

  // Retract: soft-undo ONLY the single most recent active dismissal on the planting.
  //
  // PANEL Q3, BLOCKING PREREQUISITE (harvest-panel-decisions-20260812.md) — this REVERSES the
  // earlier plural retraction. Under season-long suppression only one active row ever existed, so
  // clearing "all" was harmless. Under bounded 10-day suppression rows ACCUMULATE (one per
  // observation day across the season), and a single "Undo" tap that clears them all retracts every
  // accumulated calibration sample for the planting — corrupting the dataset the table exists to
  // build. Undo now means "take back the tap I just made": one row, the newest. Older samples are
  // independent observations made on other days and stand on their own; a user who truly wants them
  // gone peels them one Undo at a time (or via DELETE /watch/dismissals/:id, the preferred by-id
  // path the client uses when it holds the id). Suppression concerns don't arise: only the newest
  // row's suppressed_until can still be in the future, so undoing it always un-suppresses.
  const rows = await sql`
    UPDATE public.harvest_watch_dismissal
       SET undone_at = now()
     WHERE id = (
             SELECT id
               FROM public.harvest_watch_dismissal
              WHERE user_id = ${userId} AND plant_id = ${plantId}::uuid AND undone_at IS NULL
              ORDER BY observed_on DESC, dismissed_at DESC
              LIMIT 1
           )
       AND user_id = ${userId}
     RETURNING id, plant_id, observed_on, undone_at
  `;
  return {
    statusCode: 200,
    body: { plant_id: plantId, project_id: body.project_id ?? null, dismissed: false, retracted: rows },
  };
}

// DELETE /api/harvests/watch/dismissals/:id — soft undo of ONE specific dismissal by id. As of the
// panel Q3 retraction fix this is the PREFERRED undo path: the band holds the id from the dismissal
// response and retracts exactly the row it created, with zero ambiguity about which sample is being
// taken back. NEVER a hard delete: an undo is itself signal (the user changed their mind about what
// they saw), and deleting samples biases the calibration set toward the observations someone stayed
// confident about.
export async function handleDismissalUndo(ctx, dismissalId) {
  const { sql, userId } = ctx;
  if (!isUuid(dismissalId)) return { statusCode: 400, body: { error: 'id must be a uuid' } };

  // Scoped to user_id, so one user cannot undo another's observation. Already-undone rows are
  // idempotent no-ops rather than errors.
  const rows = await sql`
    UPDATE public.harvest_watch_dismissal
       SET undone_at = now()
     WHERE id = ${dismissalId}::uuid AND user_id = ${userId} AND undone_at IS NULL
     RETURNING id, plant_id, undone_at
  `;
  if (rows.length === 0) return { statusCode: 404, body: { error: 'Not found' } };
  return { statusCode: 200, body: { undone: true, dismissal: rows[0] } };
}

// The by-id undo route, as an executable PATTERN rather than a startsWith: the client now calls
// this path directly (undo-by-id), and clientRouteLambdaContract.test.js proves client paths against
// the Lambda's own declared regexes — a startsWith is invisible to that guard.
const DISMISSAL_BY_ID_RE = /^\/api\/harvests\/watch\/dismissals\/([^/]+)$/;

// Path router. Returns null when the request is not a watch route, so index.js falls through to its
// existing /api/harvests handling unchanged.
// DISMISS_PATH is matched BEFORE DISMISSALS_PATH's prefix rules. Both start with
// '/api/harvests/watch/dismiss', so order is load-bearing here exactly as it is in api.js's
// first-match prefix table.
export function matchWatchRoute(method, rawPath) {
  if (rawPath === WATCH_PATH && method === 'GET') return { kind: 'watch_get' };
  if (rawPath === DISMISS_PATH && method === 'POST') return { kind: 'dismiss_toggle' };
  if (rawPath === DISMISSALS_PATH && method === 'POST') return { kind: 'dismissal_post' };
  const byId = method === 'DELETE' ? rawPath.match(DISMISSAL_BY_ID_RE) : null;
  if (byId) {
    return { kind: 'dismissal_undo', id: byId[1] };
  }
  // A watch path with the wrong verb is a 405, NOT a fall-through: falling through would hand it to
  // the /api/harvests read model, which answers a 405 with a message about the wrong route.
  if (rawPath === WATCH_PATH || rawPath === DISMISS_PATH || rawPath.startsWith(DISMISSALS_PATH)) {
    return { kind: 'method_not_allowed' };
  }
  return null;
}
