// /api/findings — DRG Care Knowledge Engine V1 read model (slice 6).
// GET-only, Clerk-authed, household-scoped, compute-on-read. Reads existing data (flagged-issue
// events + their planting + canonical entity), assembles raw findings (assemble.js), and runs each
// through the pure engine (engine/) to emit the full §2 findings contract. Mutates nothing.
//
// V1 emits Knowledge-room findings only (Garden=0 per C2; Critters deferred). The handler is the
// thin glue; all product logic is in the unit-tested pure modules (assemble.js + engine/).
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { householdScope } from './household.js';
import { assembleIssueFindings } from './assemble.js';
import { composeFinding } from './engine/index.js';
import { SCHEMA_VERSION } from './engine/config.js';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

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

const ISSUE_WINDOW_DAYS = 30; // resolved issues older than this drop out of the read model.
const MAX_FINDINGS = 200;

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

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/findings';
  if (method !== 'GET' || rawPath !== '/api/findings') {
    return resp(405, { error: 'Method not allowed' });
  }

  const sql = neon(secrets.NEON_DATABASE_URL);
  const householdIds = householdScope(userId);

  try {
    // Flagged-issue events for the household's (non-deleted) plantings, joined to the canonical
    // entity registry for entity_id. Open issues always; resolved ones only within the window.
    const rows = await sql`
      SELECT
        e.id               AS event_id,
        e.plant_id         AS plant_id,
        ent.id             AS entity_id,
        p.display_name     AS plant_name,
        pp.display_name    AS project_name,
        e.event_type       AS event_type,
        e.severity         AS severity,
        e.event_date       AS event_date,
        e.resolved_at      AS resolved_at
      FROM event_log e
      JOIN public.garden_node p ON p.id = e.plant_id AND p.deleted_at IS NULL
      JOIN public.container pp  ON pp.id = p.container_id AND pp.deleted_at IS NULL
      LEFT JOIN entity ent      ON ent.entity_type = 'planting'
                                AND ent.planting_ref_id = e.plant_id
                                AND ent.deleted_at IS NULL
      WHERE e.deleted_at IS NULL
        AND e.flagged_as_issue = true
        AND pp.created_by = ANY(${householdIds})
        AND (e.resolved_at IS NULL OR e.resolved_at > NOW() - (${ISSUE_WINDOW_DAYS} || ' days')::interval)
      ORDER BY e.event_date DESC
      LIMIT ${MAX_FINDINGS}
    `;

    const now = Date.now();
    const findings = assembleIssueFindings(rows).map((rawFinding) => composeFinding(rawFinding, now));

    return resp(200, {
      schema_version: SCHEMA_VERSION,
      generated_at: new Date(now).toISOString(),
      count: findings.length,
      findings,
    });
  } catch (err) {
    console.error('findings lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
