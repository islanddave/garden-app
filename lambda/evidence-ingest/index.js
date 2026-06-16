// /api/evidence — DRG-ENGINE-003 evidence-ingest write path (slice 7). POST-only, Clerk-authed.
// ADDITIVE + DORMANT: shipped-but-unwired in V1 (no frontend route / Function-URL consumer yet).
// Validates the payload (validate.js) AND the entity_id against the live `entity` registry, then
// writes exactly ONE append-only evidence row. Rejects unknown entities (404) + schema mismatch (400).
// Append-only: the handler issues one INSERT and never UPDATE/DELETE (soft-delete is via the table's
// deleted_at, used by future admin/restore paths — Soft-Delete-Only Rule).
// HOUSEHOLD NOTE (V1.1, at wire time): add household-scoped write authz (only accept evidence for
// entities in the requester's household). V1 attributes created_by=<clerk sub> + validates registry
// existence only — sufficient for the shipped-but-unwired slice-7 contract.
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { validateEvidenceInput } from './validate.js';

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

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

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

  const method = event.requestContext?.http?.method ?? 'POST';
  const rawPath = event.rawPath ?? '/api/evidence';
  if (method !== 'POST' || rawPath !== '/api/evidence') return resp(405, { error: 'Method not allowed' });

  let body;
  try { body = event.body ? JSON.parse(event.body) : null; }
  catch { return resp(400, { error: 'Invalid JSON body' }); }

  const v = validateEvidenceInput(body);
  if (!v.ok) return resp(v.status, { error: v.error });

  const sql = neon(secrets.NEON_DATABASE_URL);
  try {
    // Registry validation (C-risk #4): the evidence MUST point at a live canonical entity.
    const ent = await sql`SELECT id FROM public.entity WHERE id = ${v.value.entity_id}::uuid AND deleted_at IS NULL`;
    if (ent.length === 0) return resp(404, { error: 'Unknown entity_id' });

    const rows = await sql`
      INSERT INTO public.evidence
        (entity_id, schema_version, tier, axis, polarity, finding_type, observed_at, note, photo_ref, source, created_by)
      VALUES
        (${v.value.entity_id}::uuid, ${v.value.schema_version}, ${v.value.tier}, ${v.value.axis}, ${v.value.polarity},
         ${v.value.finding_type}, ${v.value.observed_at}::timestamptz, ${v.value.note}, ${v.value.photo_ref}, ${v.value.source}, ${userId})
      RETURNING id, entity_id, schema_version, created_at
    `;
    return resp(201, { evidence: rows[0] });
  } catch (err) {
    console.error('evidence-ingest lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
