// /api/members — PLANT-ASSIGN-001 household roster read. GET-only, Clerk-authed. Lists the app's users
// (Clerk is the identity source of truth — there is no DB roster table; profiles holds only some users) so
// the caretaker AssigneePicker can offer Dave/Jen. Mirrors the lambda/findings auth/secrets seam; NO Neon
// (no DB read). A normal Fn-URL lambda (auto-gets a Function URL + CORS from deploy-lambda.yml).
import { verifyToken, createClerkClient } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const SCHEMA_VERSION = 1;

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

// Best-effort human label from a Clerk user. Falls back through full name -> username -> email localpart -> id.
function displayName(u) {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (u.username) return u.username;
  const email = u.emailAddresses?.[0]?.emailAddress;
  if (email) return email.split('@')[0];
  return u.id;
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  const secrets = await getSecrets();

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  try {
    await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net'],
    });
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/members';
  if (method !== 'GET' || rawPath !== '/api/members') {
    return resp(405, { error: 'Method not allowed' });
  }

  try {
    const clerk = createClerkClient({ secretKey: secrets.CLERK_SECRET_KEY });
    const list = await clerk.users.getUserList({ limit: 50 });
    // v1 returns { data, totalCount }; tolerate an array too.
    const users = Array.isArray(list) ? list : (list?.data ?? []);
    const members = users
      .map((u) => ({
        id: u.id,
        display_name: displayName(u),
        email: u.emailAddresses?.[0]?.emailAddress ?? null,
      }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
    return resp(200, { schema_version: SCHEMA_VERSION, members });
  } catch (err) {
    console.error('members lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
