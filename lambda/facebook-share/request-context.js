// MASTER of the HTTP sign-in kit. scripts/lambda-copies.json lists its byte copies, one per handler dir (a Lambda zip
// holds only its own folder). The order is the security property: OPTIONS, secrets, verifyToken + azp, the empty-sub
// 401, the household gate, and only then neon() and scope, so a refused caller costs no statement and no bucket.
// lambda/household-isolation.test.js and lambda/authz-write-fk.test.js run their per-handler checks on this text in
// every dir whose index.js calls requestContext(, so the three refusal lines keep the handlers' spelling. `//` comments
// only: those tests strip `//` comments, not block comments. Behaviour: lambda/request-context.test.js.
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { householdGate } from './household.js';

// The only allow-list in lambda/: lambda/site-constants.static.test.js fails on an origin literal or an
// authorizedParties value anywhere else. Pinned in lambda/request-context.test.js.
export const AUTHORIZED_PARTIES = Object.freeze(['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net']);

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
let _secrets = null;
let _secretsAt = 0;
// Cached for the container's life unless the handler passes secretsTtlMs.
async function getSecrets(ttlMs) {
  if (_secrets && (ttlMs === undefined || Date.now() - _secretsAt < ttlMs)) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  _secretsAt = Date.now();
  return _secrets;
}

// Clerk 1.x skips its azp check when a token has none, so the kit checks azp itself, by exact membership. A token with
// no azp passes only when a Clerk development instance issued it AND this Lambda holds a development key: the staging
// smoke mints through the Backend API, which sets no azp, and prod's live key makes that arm unreachable whatever a
// token claims. An azp of '' or null is refused, not read as absent.
const isDevKey = (secretKey) => String(secretKey).startsWith('sk_test_');
function devInstanceIssuer(iss) {
  try {
    const u = new URL(iss);
    return u.protocol === 'https:' && u.hostname.endsWith('.clerk.accounts.dev');
  } catch {
    return false;
  }
}
function azpAllowed(payload, secretKey) {
  if (AUTHORIZED_PARTIES.includes(payload.azp)) return true;
  return payload.azp === undefined && devInstanceIssuer(payload.iss) && isDevKey(secretKey);
}
function hostOf(iss) {
  try {
    return new URL(iss).hostname;
  } catch {
    return null;
  }
}

// Returns { response } for the handler to send as is, or the signed-in context. Every refusal goes through the
// handler's own `resp`, so it keeps that handler's headers. neon and scope are injected: members has no neon dependency,
// and out-of-scope handlers pass no scope. onSecretsError(err, { missing, keys }) answers a secrets failure and is never
// handed a secret value; without it the error is rethrown, as the handlers did.
export async function requestContext(event, { resp: respond, neon, scope, onSecretsError, requiredSecrets = [], secretsTtlMs, defaults = {} } = {}) {
  const resp = (statusCode, body) => ({ response: respond(statusCode, body) });
  if (event.requestContext?.http?.method === 'OPTIONS') return { response: { statusCode: 204, headers: {}, body: '' } };

  let secrets;
  try {
    secrets = await getSecrets(secretsTtlMs);
  } catch (err) {
    if (!onSecretsError) throw err;
    return { response: onSecretsError(err, { missing: null, keys: null }) };
  }
  const missing = requiredSecrets.filter((k) => !secrets[k]);
  if (missing.length) {
    const err = new Error(`missing required secrets: ${missing.join(', ')}`);
    if (!onSecretsError) throw err;
    return { response: onSecretsError(err, { missing, keys: Object.keys(secrets) }) };
  }

  // An absent header reaches Clerk as '' on purpose: the tokenless-request alarm's metric filters match Clerk's own
  // "Invalid JWT form" text, which is logged as is.
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let payload;
  try {
    payload = await verifyToken(token, { secretKey: secrets.CLERK_SECRET_KEY, authorizedParties: AUTHORIZED_PARTIES });
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }
  // Its own line, apart from Clerk's failures: the signature has verified, so the sub is safe to log, and the ship
  // check scans for this msg to tell a locked-out member from a stranger. The key goes in as a boolean only.
  if (!azpAllowed(payload, secrets.CLERK_SECRET_KEY)) {
    console.warn(JSON.stringify({
      msg: 'auth-azp-refused',
      userId: payload.sub,
      azp: payload.azp === undefined ? 'absent' : payload.azp,
      issHost: hostOf(payload.iss),
      devKey: isDevKey(secrets.CLERK_SECRET_KEY),
    }));
    return resp(401, { error: 'Unauthorized' });
  }
  const userId = payload.sub;
  // householdScope('') is [''] and `'' = ANY(ARRAY[''])` is true in Postgres, so an empty sub is refused here.
  if (!userId) return resp(401, { error: 'Unauthorized' });
  const gateRefusal = householdGate(userId);
  if (gateRefusal) return resp(gateRefusal.status, gateRefusal.body);

  const sql = neon ? neon(secrets.NEON_DATABASE_URL) : undefined;
  const householdIds = scope ? await scope(userId, { sql, event }) : undefined;
  // No path field: src/__tests__/clientRouteLambdaContract.test.js reads any rawPath name in a dir as that Lambda
  // routing on its path, and this file ships in every dir. Handlers keep their own path lines.
  return {
    response: null,
    secrets,
    userId,
    sql,
    householdIds,
    method: event.requestContext?.http?.method ?? defaults.method ?? 'GET',
    rawBody: event.body,
    query: event.queryStringParameters ?? {},
  };
}
