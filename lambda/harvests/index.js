// /api/harvests (V4-HARVESTVIEW-001): the Harvests page READ MODEL. GET-only, Clerk-authed,
// household-scoped, soft-delete filtered. The Log feed (day-grouped entries) plus Totals (live-computed
// aggregates). Mutates nothing. The Today watch list and season stats ride this prefix in watch-route.js
// and season-stats.js.
//
// Mirrors lambda/daily-plan-read/index.js (auth/secrets/CORS/handler seam) and lambda/preservation/index.js
// (the crop-key join garden_node.cultivar_id -> cultivar.crop_type_slug -> crop_types).
//
// INVARIANTS
//   * Household scope anchors on event_log.project_id -> plant_projects.created_by, NEVER on the nullable
//     event_log.plant_id join. project_id is nullable (plant-only events on project-less plantings), so
//     the join is LEFT and scope has two arms: through the project when there is one, else through the
//     event's own created_by. The second arm is gated on `e.project_id IS NULL`, not a bare COALESCE, so a
//     project_id pointing at a missing row can never fall through to the logger's id. This matches
//     stat_pick's owner, coalesce(pj.created_by, e.created_by), and differs from watch-route.js, which
//     scopes a project-less row through the PLANTING's owner; the two admit different rows when the
//     logger is not the planting's owner.
//   * Entry set = event_log rows with event_type IN ('harvest','first_harvest'), deleted_at IS NULL.
//   * LEFT JOIN harvest_log/garden_node/cultivar/crop_types with EVERY soft-delete predicate in the JOIN
//     ON clause, never WHERE: a WHERE re-inner-joins and drops the quantity-less and orphan events the
//     page must render.
//   * plant_id and variety_id are nullable, so everything is LEFT JOINed with an "Other" bucket for
//     unattributed rows, so Log and Totals always reconcile.
//   * Photos via LATERAL json_agg: a plain join fan-out multiplies event rows and corrupts the keyset page.
//   * day_key = YYYY-MM-DD in HARVEST_TZ, computed SERVER-SIDE so the client groups on the string with no
//     timezone math.
//   * Photo thumbnails (I7): this Lambda returns photo IDs only, with no S3 presign and no S3_PHOTOS/PHOTO_CDN
//     env, for both the entries and aggregates.crops[].hero_photo_id. The client resolves each id lazily
//     against the household-scoped GET /api/photos/view-url/:id. The tier the client asks for matters (crop
//     heroes were ~24x smaller as thumbs than originals). Giving this Lambda the photos bucket would
//     save round trips but is Dave's call, not a lane's.
import { neon } from '@neondatabase/serverless';
import { householdScope } from './household.js';
import { requestContext } from './request-context.js';
// Pure, DB-free helpers live in ./aggregate.js so they unit-test without this file's runtime deps.
import { parseTimeframe, encodeCursor, decodeCursor, projectEntry, computeAggregates, applyWeights, applyCropHeroPhotos } from './aggregate.js';
// Today watch list and "not yet" dismissal: watch.js holds the candidate logic, watch-route.js the SQL
// and request contract.
import {
  matchWatchRoute, handleWatchGet, handleDismissToggle, handleDismissalPost, handleDismissalUndo,
} from './watch-route.js';
// Season stats read route, same prefix seam; the numbers live in the stat_* views.
import { matchSeasonStatsRoute, handleSeasonStatsGet } from './season-stats.js';
export { parseTimeframe, encodeCursor, decodeCursor, isoWeekStart, projectEntry, computeAggregates, shapeWeightRow, applyWeights, applyCropHeroPhotos } from './aggregate.js';

// Season = grow-year Nov 1 - Oct 31; day bucketing and season boundaries share this ONE zone, the same
// constant as the events lambda's HARVEST_TZ. Not per-user.
const HARVEST_TZ = 'America/New_York';
const PAGE_LIMIT = 50;

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate.
function resp(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) };
}

// projectEntry() in aggregate.js lists its output fields EXPLICITLY, so a column added to the SELECTs
// below must also be added there or it is fetched and silently dropped (BUG-HARVWEIGHTWIRE-001). Weight
// shaping and merging live in aggregate.js because this file cannot be imported under the root vitest
// run (neon/clerk/aws), and a Map-key bug there is invisible to a regex over source.

// ── Handler ──────────────────────────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  // The kit answers OPTIONS and every sign-in refusal (401, the household gate's 403) before any statement,
  // and scopes only after its empty-sub 401.
  const ctx = await requestContext(event, { resp, neon, scope: householdScope });
  if (ctx.response) return ctx.response;
  const { userId, sql, householdIds } = ctx;
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/harvests';

  // The watch list and season stats ride this Lambda's EXISTING /api/harvests prefix: src/lib/api.js
  // routes by first-match PREFIX, so they need no new Function URL, repo variable or deploy matrix entry.
  // Matched BEFORE the /api/harvests exact-path guard below, which would otherwise 404 them. The two
  // matchers' paths are disjoint, so either order works.
  const watchRoute = matchWatchRoute(method, rawPath) ?? matchSeasonStatsRoute(method, rawPath);
  if (watchRoute) {
    if (watchRoute.kind === 'method_not_allowed') return resp(405, { error: 'Method not allowed' });
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      } catch {
        return resp(400, { error: 'Malformed JSON body' });
      }
    }
    const ctx = {
      sql,
      householdIds,
      userId,
      tz: HARVEST_TZ,
      query: event.queryStringParameters ?? {},
      body,
    };
    try {
      let out;
      if (watchRoute.kind === 'watch_get') out = await handleWatchGet(ctx);
      else if (watchRoute.kind === 'dismiss_toggle') out = await handleDismissToggle(ctx);
      else if (watchRoute.kind === 'dismissal_post') out = await handleDismissalPost(ctx);
      else if (watchRoute.kind === 'season_stats_get') out = await handleSeasonStatsGet(ctx);
      else out = await handleDismissalUndo(ctx, watchRoute.id);
      return resp(out.statusCode, out.body);
    } catch (err) {
      console.error('harvests watch route error', err);
      return resp(500, { error: 'Internal server error' });
    }
  }

  // An unknown path is a 404, not a 405: an installed app older than a route's removal still calls it
  // (POST /api/harvests/ready-impressions) and must be told the route is gone. Guarded in index.test.js.
  if (rawPath !== '/api/harvests') return resp(404, { error: 'Not found' });
  if (method !== 'GET') return resp(405, { error: 'Method not allowed' });

  const qp = event.queryStringParameters ?? {};
  const tf = parseTimeframe(qp.timeframe);
  if (!tf) return resp(400, { error: 'timeframe must be one of: 7d, month, season:<year>, all' });
  const crop = qp.crop || null;
  const project = qp.project || null;
  // ?plant=<uuid> scopes the read model to ONE planting, so PlantingDetail's timeline shows the same
  // weight and provenance as the Harvests log from one read model. GET /api/events never joins
  // harvest_log. Nullable like `project`: an absent param is a no-op.
  const plant = qp.plant || null;
  // ?created_since=<ISO> narrows ENTRIES ONLY to rows LOGGED since that instant. Deliberately not applied
  // to the aggregates or weight queries: the compose surface wants the last few hours of logging for
  // batch detection AND full-season totals in one response (BUG-COMPOSETOTALS-001: totals read off a
  // 50-row entries page came out ~4x low). It filters on created_at, NOT event_date, because a harvest
  // logged tonight but dated three days back drops off the event_date window and the composed post would
  // omit produce that was just picked.
  const createdSince = qp.created_since || null;
  const seasonYear = tf.kind === 'season' ? tf.year : 0;

  const includeRaw = (qp.include ?? 'entries,aggregates').split(',').map((s) => s.trim()).filter(Boolean);
  const wantEntries = includeRaw.includes('entries');
  const wantAggregates = includeRaw.includes('aggregates');

  const cur = decodeCursor(qp.cursor);
  const curDate = cur ? cur.eventDate : null;
  // null for a pre-deploy 2-part cursor, which the WHERE clause below branches on.
  const curCreated = cur ? (cur.createdAt ?? null) : null;
  const curId = cur ? cur.id : null;

  try {
    // ARCHIVED plantings and containers are excluded from the three read models (entries, aggregates,
    // weight totals). The axis is archived_at, NOT deleted_at: they are orthogonal columns.
    //
    // WHY A `NOT EXISTS` IN THE WHERE AND NOT `AND gn.archived_at IS NULL` ON THE JOIN: the join is a LEFT
    // JOIN (orphan harvests must survive), so an ON predicate would NULL the gn columns and keep the
    // harvest, still counted in every total but anonymised. The anti-join drops it. `plant_id IS NULL`
    // rows are unaffected: NOT EXISTS over a NULL id is true.
    //
    // CARVED OUT when ?plant= names one planting: that is PlantingDetail's own harvest list, the
    // deliberate route to an archived planting (lambda/events/index.js: "Deletion hides; archiving does
    // not"). No other caller sends ?plant=, so the carve-out cannot re-open the aggregate leak.
    //
    // The container axis is its own clause beside the planting anti-join, with the same ?plant= gate;
    // archiving a container does not cascade to its plantings. The `OR pj.deleted_at IS NOT NULL` arm is
    // load-bearing: a container archived and LATER soft-deleted keeps its archived_at, and the
    // Deleted-Planting History Rule (DEC-ARCHIVECARVEOUTS-001) keeps a soft-deleted container's picks in
    // the log, totals and weights. pj.deleted_at is otherwise never a filter here. NULL-safe for a
    // project-less pick.
    //
    // OPEN: this changes season totals (archived plantings' picks no longer count). R3 recon
    // DAVE-DECISION 1 reads it the other way ("keep harvest/weight aggregates intact"). If archiving
    // should keep the harvest record, these predicates are the ones to revert.
    const out = { time_zone: HARVEST_TZ, timeframe: tf };

    if (wantEntries) {
      // Keyset page: ORDER BY (event_date, created_at, id) DESC, LIMIT+1 to detect the next page.
      // Soft-delete predicates live in the JOIN ON; photos come via LATERAL json_agg; timeframe boundary
      // math is server-side in HARVEST_TZ.
      const rows = await sql`
        SELECT
          e.id AS event_id, e.event_type, e.event_date,
          to_char((e.event_date AT TIME ZONE ${HARVEST_TZ})::date, 'YYYY-MM-DD') AS day_key,
          e.plant_id, e.notes, e.project_id,
          -- V4-COMPOSEPOST-001: the compose surface clusters harvests into the evening BATCH Dave
          -- actually posts about, and event_date cannot support that — it is date-grained by
          -- construction (482 of 504 live rows sit at exactly 08:00 ET, a DST-safe date-at-noon
          -- encoding), so it cannot order two picks within a day. created_at can. created_by rides
          -- along because Jen is a real second logger, and an overlapping session must not merge
          -- into a batch that gets published in Dave's first person. Purely additive — no existing
          -- consumer reads either field, and both are NOT NULL on every row.
          e.created_at, e.created_by,
          pj.name AS project_name,
          gn.id AS gn_id, gn.display_name AS planting_name, gn.cultivar_id AS variety_id,
          cv.crop_type_slug AS crop_slug, cv.display_name AS variety_name,
          ct.display_name AS crop_name,
          h.id AS harvest_log_id, h.quantity, h.unit, h.quality_rating,
          -- V4-HARVWEIGHTREAD-001: the derived weight, additive. 395 of 397 live harvests carry one and
          -- this read model was the only surface that never selected it, so the Harvests page could
          -- not show a weight even though every row had one. Nullable by construction (an orphan
          -- harvest with no planting derives nothing), and the client renders that as the ratchet
          -- state rather than a zero — see src/lib/harvestWeight.js describeHarvestWeight.
          h.weight_grams, h.weight_estimated, h.weight_basis,
          COALESCE(ph.photos, '[]'::json) AS photos
        FROM event_log e
        LEFT JOIN plant_projects pj ON pj.id = e.project_id
        LEFT JOIN garden_node gn ON gn.id = e.plant_id AND gn.deleted_at IS NULL
        LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
        LEFT JOIN crop_types ct ON ct.slug = cv.crop_type_slug AND ct.deleted_at IS NULL
        LEFT JOIN harvest_log h ON h.event_id = e.id AND h.deleted_at IS NULL
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object('id', p.id, 'caption', p.caption, 'taken_at', p.taken_at) ORDER BY p.created_at) AS photos
          FROM photos p WHERE p.event_id = e.id AND p.deleted_at IS NULL
        ) ph ON true
        WHERE e.event_type IN ('harvest', 'first_harvest')
          AND e.deleted_at IS NULL
          AND (pj.created_by = ANY(${householdIds})
               OR (e.project_id IS NULL AND e.created_by = ANY(${householdIds})))
          AND (
            CASE ${tf.kind}
              WHEN 'all'   THEN true
              WHEN 'today'     THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date = (now() AT TIME ZONE ${HARVEST_TZ})::date
              WHEN 'yesterday' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date = ((now() AT TIME ZONE ${HARVEST_TZ})::date - 1)
              WHEN '7d'    THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= (now() AT TIME ZONE ${HARVEST_TZ})::date - INTERVAL '6 days'
              WHEN 'month' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= date_trunc('month', (now() AT TIME ZONE ${HARVEST_TZ})::date)
              WHEN 'season' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= make_date(${seasonYear}::int - 1, 11, 1)
                             AND (e.event_date AT TIME ZONE ${HARVEST_TZ})::date <  make_date(${seasonYear}::int, 11, 1)
              ELSE true
            END
          )
          AND (${crop}::text IS NULL OR cv.crop_type_slug = ${crop}::text)
          AND (${project}::uuid IS NULL OR e.project_id = ${project}::uuid)
          AND (${plant}::uuid IS NULL OR e.plant_id = ${plant}::uuid)
          AND (${plant}::uuid IS NOT NULL OR NOT EXISTS (
                SELECT 1 FROM public.garden_node gna
                WHERE gna.id = e.plant_id AND gna.archived_at IS NOT NULL
              ))
          AND (${plant}::uuid IS NOT NULL OR pj.archived_at IS NULL OR pj.deleted_at IS NOT NULL)
          AND (${createdSince}::timestamptz IS NULL OR e.created_at >= ${createdSince}::timestamptz)
          AND (
            ${curDate}::timestamptz IS NULL
            OR (
              -- V4-HARVLOGENTRYORDER-001 (BD-040). Two comparisons, one per cursor generation.
              -- A 3-part cursor matches the new (event_date, created_at, id) order key. A 2-part
              -- cursor (curCreated NULL) is one a client picked up before this deployed and is
              -- still paginating with; it keeps the OLD comparison for that one page rather than
              -- being rejected, which would throw a mid-scroll reader back to the top.
              CASE WHEN ${curCreated}::timestamptz IS NULL
                THEN (e.event_date, e.id) < (${curDate}::timestamptz, ${curId}::uuid)
                ELSE (e.event_date, e.created_at, e.id)
                       < (${curDate}::timestamptz, ${curCreated}::timestamptz, ${curId}::uuid)
              END
            )
          )
        -- Days newest-first, and WITHIN a day newest-ENTERED first. created_at, never event_date:
        -- a harvest backdated to 08-21 while standing in the garden on 08-24 belongs in the 08-21
        -- block (event_date groups it) but is the most recent thing Dave entered there, so it leads
        -- that block. And never id: event_log.id is a uuid, so the old id-DESC tiebreak randomised
        -- every day block. id survives only as the unique keyset tiebreaker.
        ORDER BY e.event_date DESC, e.created_at DESC, e.id DESC
        LIMIT ${PAGE_LIMIT + 1}
      `;
      const hasMore = rows.length > PAGE_LIMIT;
      const page = hasMore ? rows.slice(0, PAGE_LIMIT) : rows;
      out.entries = page.map(projectEntry);
      const last = page[page.length - 1];
      out.cursor = hasMore && last ? encodeCursor(last.event_date, last.created_at, last.event_id) : null;
    }

    if (wantAggregates) {
      // Same filter range as entries (NO cursor, NO limit): aggregates are always the full range.
      const aggRows = await sql`
        SELECT
          e.id AS event_id, e.event_type,
          to_char((e.event_date AT TIME ZONE ${HARVEST_TZ})::date, 'YYYY-MM-DD') AS day_key,
          e.plant_id, e.project_id,
          pj.name AS project_name,
          gn.id AS gn_id, gn.display_name AS planting_name, gn.cultivar_id AS variety_id,
          cv.crop_type_slug AS crop_slug, cv.display_name AS variety_name,
          ct.display_name AS crop_name,
          h.id AS harvest_log_id, h.quantity, h.unit,
          -- V4-HARVWEIGHTREAD-001, same addition as the entries SELECT above. Kept in lockstep on
          -- purpose: the two queries feed one page, and a weight present in one view and absent in
          -- the other is the shape that makes a total silently disagree with the rows under it.
          h.weight_grams, h.weight_estimated, h.weight_basis
        FROM event_log e
        LEFT JOIN plant_projects pj ON pj.id = e.project_id
        LEFT JOIN garden_node gn ON gn.id = e.plant_id AND gn.deleted_at IS NULL
        LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
        LEFT JOIN crop_types ct ON ct.slug = cv.crop_type_slug AND ct.deleted_at IS NULL
        LEFT JOIN harvest_log h ON h.event_id = e.id AND h.deleted_at IS NULL
        WHERE e.event_type IN ('harvest', 'first_harvest')
          AND e.deleted_at IS NULL
          AND (pj.created_by = ANY(${householdIds})
               OR (e.project_id IS NULL AND e.created_by = ANY(${householdIds})))
          AND (
            CASE ${tf.kind}
              WHEN 'all'   THEN true
              WHEN 'today'     THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date = (now() AT TIME ZONE ${HARVEST_TZ})::date
              WHEN 'yesterday' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date = ((now() AT TIME ZONE ${HARVEST_TZ})::date - 1)
              WHEN '7d'    THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= (now() AT TIME ZONE ${HARVEST_TZ})::date - INTERVAL '6 days'
              WHEN 'month' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= date_trunc('month', (now() AT TIME ZONE ${HARVEST_TZ})::date)
              WHEN 'season' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= make_date(${seasonYear}::int - 1, 11, 1)
                             AND (e.event_date AT TIME ZONE ${HARVEST_TZ})::date <  make_date(${seasonYear}::int, 11, 1)
              ELSE true
            END
          )
          AND (${crop}::text IS NULL OR cv.crop_type_slug = ${crop}::text)
          AND (${project}::uuid IS NULL OR e.project_id = ${project}::uuid)
          AND (${plant}::uuid IS NULL OR e.plant_id = ${plant}::uuid)
          AND (${plant}::uuid IS NOT NULL OR NOT EXISTS (
                SELECT 1 FROM public.garden_node gna
                WHERE gna.id = e.plant_id AND gna.archived_at IS NOT NULL
              ))
          AND (${plant}::uuid IS NOT NULL OR pj.archived_at IS NULL OR pj.deleted_at IS NOT NULL)
      `;
      out.aggregates = computeAggregates(aggRows);

      // WEIGHT TOTALS, summed in SQL rather than over aggRows in JS. (1) weight_grams is `numeric` and the
      // driver returns a string, so a JS reduce would be float arithmetic on parsed decimals; Postgres
      // sums numeric exactly and the ONE rounding happens at the ::float8 cast. (2) The provenance split
      // must be part of the same pass, or the parts stop adding up to the whole.
      //
      // The honesty rule: measured and estimated are NEVER collapsed into one unlabelled number. `grams`
      // is their sum (an estimate is the best available value for its row), but the caller always gets
      // the split and counts, so no surface can imply every gram was weighed.
      //
      // Two predicates mirror src/lib/harvestWeight.js EXACTLY; a divergence is a client/server
      // disagreement about a total:
      //   * present  = weight_grams > 0. formatGrams() treats <= 0 as missing: 0 is absent data, never
      //     a measurement.
      //   * measured = weight_estimated IS FALSE. Anything else (true, or an impossible NULL) counts as
      //     estimated: mislabelling a weighing as an estimate understates harmlessly, the reverse
      //     launders a guess into a fact.
      // GROUPING SETS gets all FOUR grains in ONE pass: grand total, per crop, per variety, per planting.
      // GROUPING() is required to read the result: the unattributed bucket and the grand total both come
      // back with a NULL crop_slug, and only the bits tell them apart. The merge key must be crop,
      // cultivar and planting, or each variety row overwrites its crop total (see applyWeights in
      // aggregate.js). gn.cultivar_id is the same column the aggregates SELECT aliases to variety_id, so
      // the two rowsets agree on the merge key by construction. ONE bit per NULL-bearing dimension, all
      // three carried on every row: a (crop, cultivar) row is indistinguishable from a (crop) row at
      // `Number(r.is_total) === 1`.
      const weightRows = await sql`
        SELECT
          cv.crop_type_slug AS crop_slug,
          gn.cultivar_id AS variety_id,
          gn.id AS gn_id,
          GROUPING(cv.crop_type_slug)::int AS is_total,
          GROUPING(gn.cultivar_id)::int AS varieties_rolled_up,
          GROUPING(gn.id)::int AS plantings_rolled_up,
          COALESCE(SUM(h.weight_grams) FILTER (
            WHERE h.weight_grams > 0 AND h.weight_estimated IS FALSE), 0)::float8 AS measured_grams,
          COALESCE(SUM(h.weight_grams) FILTER (
            WHERE h.weight_grams > 0 AND h.weight_estimated IS NOT FALSE), 0)::float8 AS estimated_grams,
          COUNT(*) FILTER (
            WHERE h.weight_grams > 0 AND h.weight_estimated IS FALSE)::int AS measured_count,
          COUNT(*) FILTER (
            WHERE h.weight_grams > 0 AND h.weight_estimated IS NOT FALSE)::int AS estimated_count,
          COUNT(*) FILTER (
            WHERE h.weight_grams IS NULL OR h.weight_grams <= 0)::int AS unweighed_count
        FROM event_log e
        LEFT JOIN plant_projects pj ON pj.id = e.project_id
        LEFT JOIN garden_node gn ON gn.id = e.plant_id AND gn.deleted_at IS NULL
        LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
        LEFT JOIN harvest_log h ON h.event_id = e.id AND h.deleted_at IS NULL
        WHERE e.event_type IN ('harvest', 'first_harvest')
          AND e.deleted_at IS NULL
          AND (pj.created_by = ANY(${householdIds})
               OR (e.project_id IS NULL AND e.created_by = ANY(${householdIds})))
          AND (
            CASE ${tf.kind}
              WHEN 'all'   THEN true
              WHEN 'today'     THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date = (now() AT TIME ZONE ${HARVEST_TZ})::date
              WHEN 'yesterday' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date = ((now() AT TIME ZONE ${HARVEST_TZ})::date - 1)
              WHEN '7d'    THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= (now() AT TIME ZONE ${HARVEST_TZ})::date - INTERVAL '6 days'
              WHEN 'month' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= date_trunc('month', (now() AT TIME ZONE ${HARVEST_TZ})::date)
              WHEN 'season' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= make_date(${seasonYear}::int - 1, 11, 1)
                             AND (e.event_date AT TIME ZONE ${HARVEST_TZ})::date <  make_date(${seasonYear}::int, 11, 1)
              ELSE true
            END
          )
          AND (${crop}::text IS NULL OR cv.crop_type_slug = ${crop}::text)
          AND (${project}::uuid IS NULL OR e.project_id = ${project}::uuid)
          AND (${plant}::uuid IS NULL OR e.plant_id = ${plant}::uuid)
          AND (${plant}::uuid IS NOT NULL OR NOT EXISTS (
                SELECT 1 FROM public.garden_node gna
                WHERE gna.id = e.plant_id AND gna.archived_at IS NOT NULL
              ))
          AND (${plant}::uuid IS NOT NULL OR pj.archived_at IS NULL OR pj.deleted_at IS NOT NULL)
        GROUP BY GROUPING SETS (
          (),
          (cv.crop_type_slug),
          (cv.crop_type_slug, gn.cultivar_id),
          (cv.crop_type_slug, gn.cultivar_id, gn.id)
        )
      `;
      // Merge + re-order in the pure helper so it is testable by calling it. ADDITIVE keys only
      // (varieties[].weight, first_pick[].weight): older clients ignore them, and the numbers they read
      // are unchanged because GROUPING SETS computes each set independently.
      applyWeights(out.aggregates, weightRows);

      // One photo ID per crop, for the planting computeAggregates named as that crop's most recent pick.
      // IDS ONLY (see the I7 note at the top): no presign, no S3 client, no photos-bucket env.
      //
      // A SEPARATE QUERY rather than a column on the aggregates SELECT: that rowset is one row per
      // harvest EVENT, and this question has ONE answer per crop, so joining photos there would pay many
      // times the lookups on the query that carries the archive anti-join and feeds every total. When
      // there are no winners the query does not run.
      //
      // The FALLBACK is the reason this is not a bare featured_photo_id read: a crop can have photos
      // only on its HARVEST EVENTS and none on the plant row, so the LATERAL reaches both attachment
      // points. `fph` is joined rather than read off gn so a featured pointer at a soft-deleted photo
      // falls through to the fallback instead of emitting an id that can only 404.
      //
      // `fph` RE-CHECKS MEMBERSHIP, because alive is only half of INV-HERO: the stored pointer survives
      // its photo being RE-PARENTED away (PhotoLibrary's full-replace PUT, return-to-inbox). Nothing is
      // deleted then, so `deleted_at IS NULL` cannot catch it. Without the check the crop rail keeps
      // rendering a photo that belongs to a different planting, and COALESCE never reaches the fallback.
      // The fleet-wide guard lambda/hero-read-derivation.test.js cannot see this file (its /(?:fp|ph)\.id/
      // shape does not match `fph`); the local guard is lambda/harvests/crop-hero.test.js.
      //
      // Membership is EVENT-INCLUSIVE: EventNew logs event photos with {project_id, event_id} and no
      // plant_id, so a plant_id-only check would demote every hero attached that way. `fe` is
      // deleted-filtered so the explicit arm and the fallback arm agree on what "attached to this
      // planting" means. Soft-deleted plantings never reach heroPlantIds (crop-hero.test.js, "ignores a
      // row whose planting is soft-deleted").
      const heroPlantIds = [...new Set((out.aggregates.crops ?? []).map((c) => c.hero_plant_id).filter(Boolean))];
      if (heroPlantIds.length > 0) {
        const heroRows = await sql`
          SELECT gn.id AS plant_id, COALESCE(fph.id, alt.id) AS photo_id
          FROM public.garden_node gn
          LEFT JOIN LATERAL (
            SELECT ph.id
            FROM photos ph
            LEFT JOIN event_log fe ON fe.id = ph.event_id AND fe.deleted_at IS NULL
            WHERE ph.id = gn.featured_photo_id
              AND ph.deleted_at IS NULL
              AND (ph.plant_id = gn.id OR fe.plant_id = gn.id)
          ) fph ON TRUE
          LEFT JOIN LATERAL (
            SELECT p.id
            FROM photos p
            LEFT JOIN event_log pe ON pe.id = p.event_id AND pe.deleted_at IS NULL
            WHERE p.deleted_at IS NULL AND (p.plant_id = gn.id OR pe.plant_id = gn.id)
            -- created_at, never taken_at: taken_at is 100% NULL on all 1094 live rows
            -- (src/lib/photoModel.js), so sorting on it would be sorting on nothing.
            ORDER BY p.created_at DESC, p.id DESC
            LIMIT 1
          ) alt ON true
          WHERE gn.id = ANY(${heroPlantIds}::uuid[])
        `;
        applyCropHeroPhotos(out.aggregates, heroRows);
      } else {
        applyCropHeroPhotos(out.aggregates, []);
      }
    }

    return resp(200, out);
  } catch (err) {
    console.error('harvests lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
