// /api/harvests — V4-HARVESTVIEW-001 (Harvests page) READ MODEL. GET-only, Clerk-authed,
// HOUSEHOLD-scoped, soft-delete filtered. Retrospective record of "what you got": the Log feed
// (day-grouped entries) + Totals (live-computed aggregates). Mutates NOTHING (S1 is read-only).
//
// Mirrors lambda/daily-plan-read/index.js (auth/secrets/CORS/Function-URL handler seam) and
// lambda/preservation/index.js (the crop-key join garden_node.cultivar_id -> cultivar.crop_type_slug
// -> crop_types, and household scope via the project owner). Per-dir household.js copy (B2).
//
// CORRECTNESS INVARIANTS (live-Neon verified 2026-07-22 + coordinator schema correction 2026-07-23):
//   * Household scope anchors on event_log.project_id (NOT NULL) -> plant_projects.created_by. NEVER
//     on the nullable event_log.plant_id join (that would leak/partition on unattributed rows).
//   * Entry set = event_log rows with event_type IN ('harvest','first_harvest'), deleted_at IS NULL.
//   * LEFT JOIN harvest_log/garden_node/cultivar/crop_types with EVERY soft-delete predicate in the
//     JOIN ON clause, never WHERE — a WHERE placement re-inner-joins and silently drops the
//     quantity-less / orphan (no harvest_log row) events the design REQUIRES to render.
//   * plant_id + variety_id are nullable -> LEFT JOIN everything + an "Other" fallback bucket for
//     unattributed rows so Log and Totals always reconcile (quantities never silently vanish).
//   * Photos via LATERAL json_agg — a plain join fan-out multiplies event rows and corrupts the
//     (event_date,id) keyset page.
//   * day_key = YYYY-MM-DD in HARVEST_TZ, computed SERVER-SIDE so the client groups on the string
//     with zero timezone math.
//   * I7 photo thumbnails: this Lambda returns photo IDs only (no S3 presign, no S3_PHOTOS/PHOTO_CDN
//     env). The client resolves each thumbnail lazily against the EXISTING household-scoped
//     GET /api/photos/view-url/:id (the PutUpPhotoThumb precedent) — one canonical photo-URL path.
//     V4-HARVCROPPHOTO-001 adds a SECOND id-bearing field (aggregates.crops[].hero_photo_id) under
//     the same rule, and the rule is now load-bearing rather than incidental: 31 crop heroes measured
//     134 MB as originals against 5.6 MB as thumbs (live S3, 2026-08-24), so the tier the client
//     asks for is worth ~24x the payload. Reversing the decline — copying photo-access.js in and
//     granting the photos bucket — would let this response carry both derivative URLs and cost zero
//     extra round trips, which is exactly what it buys and why it stays Dave's call, not a lane's.
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { householdScope } from './household.js';
// Pure, DB-free helpers live in ./aggregate.js so they unit-test without this file's runtime deps
// (neon/clerk/aws — absent from root package.json under CI `npm ci`). See lambda/preservation/attribution.js.
import { parseTimeframe, encodeCursor, decodeCursor, projectEntry, computeAggregates, applyWeights, applyCropHeroPhotos } from './aggregate.js';
// V4-HARVSURFACE-001 — Today watch list + "not yet" dismissal. Same DB-free-pure / DB-touching split:
// watch.js holds the candidate logic, watch-route.js the SQL and request contract.
import {
  matchWatchRoute, handleWatchGet, handleDismissToggle, handleDismissalPost, handleDismissalUndo,
} from './watch-route.js';
// V4-READYTRAYIMPRESSION-001 — the weigh-in tray's impression beacon. Same prefix trick, same
// pure/DB split; separate module because it serves a different surface with a different model.
import { matchReadyImpressionRoute, handleReadyImpressionPost } from './ready-impression.js';
export { parseTimeframe, encodeCursor, decodeCursor, isoWeekStart, projectEntry, computeAggregates, shapeWeightRow, applyWeights, applyCropHeroPhotos } from './aggregate.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

// Season = grow-year Nov 1 - Oct 31; day bucketing + season boundaries share this ONE zone (design §4).
// The same constant the shipped harvest surfaces use (events lambda HARVEST_TZ) — not per-user in V1.
const HARVEST_TZ = 'America/New_York';
const PAGE_LIMIT = 50;

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate.
function resp(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) };
}

// BUG-HARVWEIGHTWIRE-001 (found reading slice 1 back, SHIPPED in v4.0.0). Slice 1 added
// weight_grams/weight_estimated/weight_basis to both SELECTs, but the wire projection is
// projectEntry() in aggregate.js — which predates the columns and lists its output fields
// EXPLICITLY. All three were fetched from Postgres and then dropped on the floor, so every row on
// the shipped Harvests log rendered the "no weight yet" ratchet copy no matter what the database
// held. A SELECT with no matching projection is invisible: nothing 500s, nothing logs, the page
// just quietly says the wrong thing. The fix belongs in projectEntry itself — see the comment there
// for why a wrapper at this call site would have widened the same gap instead of closing it.
//
// V4-HARVGRAIN-001: shapeWeightRow() and the weight merge moved to aggregate.js. This file cannot be
// imported under the root vitest run (neon/clerk/aws), so anything living here can only ever be
// guarded by a regex over its own source text — and the merge's failure mode is a Map key, which no
// regex can check. See the applyWeights header there.

// ── Handler ──────────────────────────────────────────────────────────────────────────────────────

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
      authorizedParties: ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net'],
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
  const rawPath = event.rawPath ?? '/api/harvests';

  // V4-HARVSURFACE-001 — the Today watch list rides this Lambda's EXISTING /api/harvests prefix.
  // src/lib/api.js routes by first-match PREFIX, so /api/harvests/watch resolves here with no new
  // Function URL, no repo variable, no deploy-lambda.yml matrix entry and no api.js edit. Matched
  // BEFORE the /api/harvests exact-path guard below, which would otherwise 405 every watch request.
  // V4-READYTRAYIMPRESSION-001 rides the same seam: its path is disjoint from every watch path, so
  // the two matchers can be tried in either order, and both feed the SAME ctx/JSON-body block below
  // rather than a second copy of it.
  const watchRoute = matchWatchRoute(method, rawPath) ?? matchReadyImpressionRoute(method, rawPath);
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
      sql: neon(secrets.NEON_DATABASE_URL),
      householdIds: householdScope(userId),
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
      else if (watchRoute.kind === 'ready_impression_post') out = await handleReadyImpressionPost(ctx);
      else out = await handleDismissalUndo(ctx, watchRoute.id);
      return resp(out.statusCode, out.body);
    } catch (err) {
      console.error('harvests watch route error', err);
      return resp(500, { error: 'Internal server error' });
    }
  }

  if (method !== 'GET' || rawPath !== '/api/harvests') {
    return resp(405, { error: 'Method not allowed' });
  }

  const qp = event.queryStringParameters ?? {};
  const tf = parseTimeframe(qp.timeframe);
  if (!tf) return resp(400, { error: 'timeframe must be one of: 7d, month, season:<year>, all' });
  const crop = qp.crop || null;
  const project = qp.project || null;
  // V4-HARVWEIGHTREAD-001 slice 2: ?plant=<uuid> scopes the read model to ONE planting, which is what
  // lets PlantingDetail's timeline show the same weight + provenance the Harvests log shows without a
  // second read model deriving weight its own way. GET /api/events (the timeline's source) never
  // joins harvest_log at all, so this endpoint is the only place that already knows a harvest's weight.
  // Nullable exactly like `project` above — same `IS NULL OR` shape, so an absent param is a no-op.
  const plant = qp.plant || null;
  // V4-COMPOSEPOST-002: ?created_since=<ISO> narrows ENTRIES ONLY to rows LOGGED since that instant.
  // Deliberately not applied to the aggregates or weight queries — the compose surface wants the last
  // few hours of logging activity for batch detection AND the full-season totals in the same response,
  // and the two windows are different by design (BUG-COMPOSETOTALS-001: reading season totals off a
  // 50-row entries page published a per-crop figure ~4x under the true one).
  //
  // It filters on created_at, NOT event_date, which is the point: a harvest logged tonight but dated
  // three days back sorts three days back under the event_date window and drops off the page, so the
  // composed post silently omits produce that was just picked. 6 of 504 live rows (1.19%) are
  // backdated. Cheap to support, and it is the only predicate that matches "what did I just log".
  const createdSince = qp.created_since || null;
  const seasonYear = tf.kind === 'season' ? tf.year : 0;

  const includeRaw = (qp.include ?? 'entries,aggregates').split(',').map((s) => s.trim()).filter(Boolean);
  const wantEntries = includeRaw.includes('entries');
  const wantAggregates = includeRaw.includes('aggregates');

  const cur = decodeCursor(qp.cursor);
  const curDate = cur ? cur.eventDate : null;
  // BD-040: null for a pre-deploy 2-part cursor, which the WHERE clause below branches on.
  const curCreated = cur ? (cur.createdAt ?? null) : null;
  const curId = cur ? cur.id : null;

  const sql = neon(secrets.NEON_DATABASE_URL);
  const householdIds = householdScope(userId);

  try {
    // V4-ARCHIVEHIDE-001 (L3). The three read models below (entries, aggregates, weight totals) join
    // garden_node with `deleted_at IS NULL` only, so harvests on ARCHIVED plantings were loaded and
    // rendered on the Harvests page. Measured on prod 2026-08-13: 4 of 595 live harvest events, and
    // 424 g of the weight totals, hang off the 19 archived plantings.
    //
    // AXIS: archived_at, NOT deleted_at — orthogonal columns (lambda/plants/index.js:269-281 archives
    // a row whose deleted_at is still NULL). Every existing deleted_at predicate is left untouched.
    //
    // WHY A `NOT EXISTS` IN THE WHERE AND NOT `AND gn.archived_at IS NULL` ON THE JOIN: the join is a
    // LEFT JOIN (orphan/plant-less harvests are legitimate rows and must survive), so a predicate in
    // its ON clause NULLs the gn columns and keeps the harvest — the row would still be counted in
    // every total, just anonymised. The anti-join drops it. `plant_id IS NULL` rows are unaffected:
    // NOT EXISTS over a NULL id is true.
    //
    // CARVED OUT when ?plant= names one planting. That request is PlantingDetail's own harvest list
    // (src/pages/PlantingDetail.jsx:234) and is the deliberate route to an archived planting, which
    // lambda/events/index.js:658-661 already establishes as the rule ("Deletion hides; archiving does
    // not"). No other caller sends ?plant= (useHarvests, useHarvestSnapshot, useHarvestFilterOptions,
    // HarvestExportSheet, ComposeHarvestBand and EventNew's season totals are all unscoped), so the
    // carve-out cannot re-open the aggregate leak.
    //
    // ⚠️ THIS CHANGES SEASON TOTALS by 424 g / 4 events. That is what "must not be loaded at all"
    // asks for, but R3 recon §2 DAVE-DECISION 1 reads it the other way ("keep harvest/weight
    // aggregates intact — they are season truth"). If Dave rules that archiving keeps the harvest
    // record, this predicate is the one to revert, and reverting it is a three-line change.
    const out = { time_zone: HARVEST_TZ, timeframe: tf };

    if (wantEntries) {
      // Keyset page: ORDER BY (event_date,id) DESC, LIMIT+1 to detect the next page. Soft-delete
      // predicates live in the JOIN ON (orphan/quantity-less events survive). Photos via LATERAL
      // json_agg (no keyset-corrupting fan-out). Timeframe boundary math is server-side in HARVEST_TZ.
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
        JOIN plant_projects pj ON pj.id = e.project_id
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
          AND pj.created_by = ANY(${householdIds})
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
      // Same filter range as entries (NO cursor, NO limit) — aggregates are always the full range.
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
        JOIN plant_projects pj ON pj.id = e.project_id
        LEFT JOIN garden_node gn ON gn.id = e.plant_id AND gn.deleted_at IS NULL
        LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
        LEFT JOIN crop_types ct ON ct.slug = cv.crop_type_slug AND ct.deleted_at IS NULL
        LEFT JOIN harvest_log h ON h.event_id = e.id AND h.deleted_at IS NULL
        WHERE e.event_type IN ('harvest', 'first_harvest')
          AND e.deleted_at IS NULL
          AND pj.created_by = ANY(${householdIds})
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
      `;
      out.aggregates = computeAggregates(aggRows);

      // V4-HARVWEIGHTREAD-001 slice 2 — WEIGHT TOTALS, summed in SQL rather than over aggRows in JS.
      // Two reasons, both load-bearing. (1) weight_grams is `numeric`; the driver returns it as a
      // string, so a JS reduce over ~400 rows is float arithmetic on parsed decimals and the season
      // total would not equal the same total computed anywhere else. Postgres sums numeric exactly
      // and the ONE rounding happens at the ::float8 cast. (2) The provenance split has to be part
      // of the same pass — measured and estimated grams summed independently in a second traversal
      // is how the parts stop adding up to the whole.
      //
      // The honesty rule, and it is the point of the query: measured and estimated are NEVER
      // collapsed into a single number with no label. `grams` is their sum (an estimate IS the best
      // available value for its row, so omitting it would understate the harvest), but the caller
      // always receives the split and the counts alongside, so no surface can print a total that
      // silently implies every gram of it was weighed.
      //
      // Two predicates mirror src/lib/harvestWeight.js EXACTLY, and a divergence here is a
      // client/server disagreement about a total:
      //   * present  = weight_grams > 0. formatGrams() treats <= 0 as missing, because a harvest
      //     that weighs nothing is not a harvest — 0 is always absent data, never a measurement.
      //   * measured = weight_estimated IS FALSE. Anything else (true, or a NULL that should not
      //     exist by construction) counts as estimated: labelling a real weighing as an estimate
      //     understates harmlessly, the reverse launders a guess into a fact.
      // GROUPING SETS gets all FOUR grains in ONE pass — grand total, per crop, per variety, per
      // planting. GROUPING() is required to read the result: the unattributed bucket
      // (crop_type_slug IS NULL) and the grand total both come back with a NULL crop_slug, and only
      // the bits tell them apart.
      //
      // V4-HARVGRAIN-001 added the variety and planting members. THE COST WAS NOT THE CLAUSE — it
      // was the merge, which keyed on crop alone and would have let each variety row overwrite its
      // crop total (see applyWeights in aggregate.js). No new join was needed: gn is already
      // LEFT JOINed for the archive anti-join, so gn.cultivar_id and gn.id were already in scope,
      // and gn.cultivar_id is the SAME column the aggregates SELECT aliases to variety_id — so the
      // two rowsets agree on the merge key by construction rather than by convention.
      //
      // ONE bit per NULL-bearing dimension, all three carried on every row. `is_total` alone cannot
      // do it: a (crop, cultivar) row also has is_total = 0 and a non-null crop_slug, so it is
      // structurally indistinguishable from a (crop) row at `Number(r.is_total) === 1`.
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
        JOIN plant_projects pj ON pj.id = e.project_id
        LEFT JOIN garden_node gn ON gn.id = e.plant_id AND gn.deleted_at IS NULL
        LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
        LEFT JOIN harvest_log h ON h.event_id = e.id AND h.deleted_at IS NULL
        WHERE e.event_type IN ('harvest', 'first_harvest')
          AND e.deleted_at IS NULL
          AND pj.created_by = ANY(${householdIds})
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
        GROUP BY GROUPING SETS (
          (),
          (cv.crop_type_slug),
          (cv.crop_type_slug, gn.cultivar_id),
          (cv.crop_type_slug, gn.cultivar_id, gn.id)
        )
      `;
      // Merge + re-order, in the pure helper so it is testable by calling it. ADDITIVE keys only —
      // varieties[].weight and first_pick[].weight are new fields on shapes that already shipped, so
      // an older client ignores them, and the crop/grand-total numbers it does read are unchanged
      // (GROUPING SETS computes each set independently: adding members cannot move an existing one).
      applyWeights(out.aggregates, weightRows);

      // V4-HARVCROPPHOTO-001 — one photo ID per crop, for the planting computeAggregates named as
      // that crop's most recent pick. IDS ONLY: the I7 note at the top of this file still holds, so
      // there is no presign, no S3 client and no photos-bucket env here. The client resolves each id
      // against the household-scoped GET /api/photos/view-url/:id (the PutUpPhotoThumb precedent).
      //
      // WHY A SEPARATE QUERY rather than a column on the aggregates SELECT: that rowset is one row
      // per harvest EVENT (874 live), and this question has ONE answer per crop (31 live). Joining
      // photos there would pay ~28x the lookups for the same answer, on the query that already
      // carries the archive anti-join and feeds every total on the page. Here the driving set is the
      // winners themselves, and when there are none the query does not run at all.
      //
      // The FALLBACK is the whole reason this is not a bare featured_photo_id read: 30 of 31 live
      // crops resolve through `fph`, and the 31st (blackberry) has four photos hanging off its
      // HARVEST EVENTS and none on the plant row, so a plant_id-only fallback would still miss it.
      // The LATERAL therefore reaches both attachment points. `fph` is joined rather than read off
      // gn directly so a featured pointer at a soft-deleted photo falls through to the fallback
      // instead of emitting an id that can only 404.
      //
      // BUG-HARVHEROMEMBER-001 — `fph` is a LATERAL, and it RE-CHECKS MEMBERSHIP, because alive is
      // only half of INV-HERO. The other half: the stored pointer survives its photo being RE-PARENTED
      // away (PhotoLibrary's full-replace PUT, and V4-PHOTOUNTAG-001's return-to-inbox). Nothing is
      // deleted in either case, so `deleted_at IS NULL` cannot catch it — only a membership re-check
      // can. Without this the crop rail keeps rendering a photo that now belongs to a different
      // planting, and the fallback below never gets a chance because COALESCE already had a non-null
      // id. The other eight hero reads in the fleet resolve this way and are held to it by
      // lambda/hero-read-derivation.test.js; this one is invisible to that guard (wrong file, and its
      // `fph` alias does not match the guard's /(?:fp|ph)\.id/ shape), which is how it shipped
      // half-implemented. See lambda/harvests/crop-hero.test.js for the local guard.
      //
      // Membership is EVENT-INCLUSIVE for the same reason it is on plants: EventNew logs event photos
      // with {project_id, event_id} and no plant_id, so a plant_id-only check would demote every hero
      // attached that way. `fe` is deleted-filtered so the explicit arm and the fallback arm below
      // agree on what "attached to this planting" means — otherwise a photo could be preferred as the
      // explicit hero while being unselectable as a fallback. Measured on prod 2026-08-31: filtered
      // and unfiltered both resolve 238 of 251 pointers, so the choice is free today and the
      // re-check demotes nothing reachable — the 13 it drops are all on SOFT-DELETED plantings, which
      // computeAggregates already excludes from heroPlantIds (crop-hero.test.js, "ignores a row whose
      // planting is soft-deleted").
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
