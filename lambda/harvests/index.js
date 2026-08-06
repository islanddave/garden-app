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
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { householdScope } from './household.js';
// Pure, DB-free helpers live in ./aggregate.js so they unit-test without this file's runtime deps
// (neon/clerk/aws — absent from root package.json under CI `npm ci`). See lambda/preservation/attribution.js.
import { parseTimeframe, encodeCursor, decodeCursor, projectEntry, computeAggregates } from './aggregate.js';
export { parseTimeframe, encodeCursor, decodeCursor, isoWeekStart, projectEntry, computeAggregates } from './aggregate.js';

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
  if (method !== 'GET' || rawPath !== '/api/harvests') {
    return resp(405, { error: 'Method not allowed' });
  }

  const qp = event.queryStringParameters ?? {};
  const tf = parseTimeframe(qp.timeframe);
  if (!tf) return resp(400, { error: 'timeframe must be one of: 7d, month, season:<year>, all' });
  const crop = qp.crop || null;
  const project = qp.project || null;
  const seasonYear = tf.kind === 'season' ? tf.year : 0;

  const includeRaw = (qp.include ?? 'entries,aggregates').split(',').map((s) => s.trim()).filter(Boolean);
  const wantEntries = includeRaw.includes('entries');
  const wantAggregates = includeRaw.includes('aggregates');

  const cur = decodeCursor(qp.cursor);
  const curDate = cur ? cur.eventDate : null;
  const curId = cur ? cur.id : null;

  const sql = neon(secrets.NEON_DATABASE_URL);
  const householdIds = householdScope(userId);

  try {
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
              WHEN '7d'    THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= (now() AT TIME ZONE ${HARVEST_TZ})::date - INTERVAL '6 days'
              WHEN 'month' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= date_trunc('month', (now() AT TIME ZONE ${HARVEST_TZ})::date)
              WHEN 'season' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= make_date(${seasonYear}::int - 1, 11, 1)
                             AND (e.event_date AT TIME ZONE ${HARVEST_TZ})::date <  make_date(${seasonYear}::int, 11, 1)
              ELSE true
            END
          )
          AND (${crop}::text IS NULL OR cv.crop_type_slug = ${crop}::text)
          AND (${project}::uuid IS NULL OR e.project_id = ${project}::uuid)
          AND (${curDate}::timestamptz IS NULL OR (e.event_date, e.id) < (${curDate}::timestamptz, ${curId}::uuid))
        ORDER BY e.event_date DESC, e.id DESC
        LIMIT ${PAGE_LIMIT + 1}
      `;
      const hasMore = rows.length > PAGE_LIMIT;
      const page = hasMore ? rows.slice(0, PAGE_LIMIT) : rows;
      out.entries = page.map(projectEntry);
      const last = page[page.length - 1];
      out.cursor = hasMore && last ? encodeCursor(last.event_date, last.event_id) : null;
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
              WHEN '7d'    THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= (now() AT TIME ZONE ${HARVEST_TZ})::date - INTERVAL '6 days'
              WHEN 'month' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= date_trunc('month', (now() AT TIME ZONE ${HARVEST_TZ})::date)
              WHEN 'season' THEN (e.event_date AT TIME ZONE ${HARVEST_TZ})::date >= make_date(${seasonYear}::int - 1, 11, 1)
                             AND (e.event_date AT TIME ZONE ${HARVEST_TZ})::date <  make_date(${seasonYear}::int, 11, 1)
              ELSE true
            END
          )
          AND (${crop}::text IS NULL OR cv.crop_type_slug = ${crop}::text)
          AND (${project}::uuid IS NULL OR e.project_id = ${project}::uuid)
      `;
      out.aggregates = computeAggregates(aggRows);
    }

    return resp(200, out);
  } catch (err) {
    console.error('harvests lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
