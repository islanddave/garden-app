// new-file: lambda/request-context.js is a new module (the D2 sign-in kit); no existing file tests it
// The sign-in kit every HTTP handler calls first (D2, SEC-21, SEC-60): allow-list, azp, empty sub, gate, then context.
// Its order is also held per handler by lambda/household-isolation.test.js and lambda/authz-write-fk.test.js.
// Trap: the kit caches secrets in module scope, so every case loads the kit and the stubs into a fresh registry.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const MEMBER = 'user_kit_member';
const MATE = 'user_kit_mate';
const STRANGER = 'user_kit_stranger';
const PROD = 'https://garden.futureishere.net';
const CDN = 'https://dg6mmjhepoyt9.cloudfront.net';
const DEV_ISS = 'https://clean-mole-12.clerk.accounts.dev';
const PROD_ISS = 'https://clerk.garden.futureishere.net';
const DEV_KEY = 'sk_test_kitfixture';
const LIVE_KEY = 'sk_live_kitfixture';
const DB = 'postgres://kit/db';
const SQL = Symbol('sql');

let kit;
let stub;
let send;
let warn;
let error;

async function load({ key = LIVE_KEY, secrets } = {}) {
  vi.resetModules();
  ({ stubState: stub } = await import('./_test-stubs/state.js'));
  (await import('./_test-stubs/householdDefault.js')).setHouseholdDefault(false);
  stub.azpDefault = false;
  stub.secrets['garden-app/secrets'] = secrets ?? { CLERK_SECRET_KEY: key, NEON_DATABASE_URL: DB };
  send = vi.spyOn((await import('@aws-sdk/client-secrets-manager')).SecretsManagerClient.prototype, 'send');
  kit = await import('./request-context.js');
}

const resp = (statusCode, body) => ({ statusCode, headers: { 'X-From': 'handler' }, body: JSON.stringify(body) });
const event = (over = {}) => ({
  requestContext: { http: { method: 'GET' } },
  rawPath: '/api/kit',
  headers: { authorization: 'Bearer kit' },
  ...over,
});
function wired() {
  const calls = { neon: [], scope: [] };
  const opts = {
    resp,
    neon: (url) => { calls.neon.push(url); return SQL; },
    scope: (userId, ctx) => { calls.scope.push([userId, ctx]); return [userId, MATE]; },
  };
  return { calls, opts };
}
const logged = (spy, msg) => spy.mock.calls
  .map((c) => { try { return JSON.parse(c[0]); } catch { return null; } })
  .filter((o) => o?.msg === msg);

beforeEach(() => {
  vi.stubEnv('GARDEN_HOUSEHOLD_IDS', `${MEMBER},${MATE}`);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('request-context: the allow-list (SEC-21)', () => {
  it('AUTHORIZED_PARTIES is exactly the two production origins, frozen', async () => {
    await load();
    // PIN: an added origin widens who may present a token; security review
    expect(kit.AUTHORIZED_PARTIES).toEqual([PROD, CDN]);
    expect(Object.isFrozen(kit.AUTHORIZED_PARTIES)).toBe(true);
  });

  it('verifyToken gets the Lambda\'s own Clerk key and that allow-list', async () => {
    await load({ key: LIVE_KEY });
    stub.verifyTokenResult = { sub: MEMBER, azp: PROD };
    await kit.requestContext(event(), wired().opts);
    expect(stub.verifyTokenCalls).toEqual([{ token: 'kit', opts: { secretKey: LIVE_KEY, authorizedParties: kit.AUTHORIZED_PARTIES } }]);
  });
});

describe('request-context: azp (Clerk 1.x skips its check when a token has none)', () => {
  it.each([PROD, CDN])('admits a token whose azp is %s', async (azp) => {
    await load();
    stub.verifyTokenResult = { sub: MEMBER, azp };
    const ctx = await kit.requestContext(event(), wired().opts);
    expect(ctx.response).toBeNull();
    expect(ctx.userId).toBe(MEMBER);
  });

  const REFUSED = [
    ['a foreign azp', { azp: 'https://evil.example' }],
    ['a superstring of a production origin', { azp: 'https://garden.futureishere.net.evil' }],
    ['the staging origin', { azp: 'https://staging.garden.futureishere.net' }],
    ['no azp and no issuer', {}],
    ['no azp and a production-shaped issuer', { iss: PROD_ISS }],
    ['no azp and a dev-looking host under another domain', { iss: 'https://x.clerk.accounts.dev.evil.com' }],
    ['no azp and an http dev issuer', { iss: 'http://x.clerk.accounts.dev' }],
    ['no azp and a malformed issuer', { iss: 'not a url' }],
    ['azp empty, from a dev issuer', { azp: '', iss: DEV_ISS }],
    ['azp null, from a dev issuer', { azp: null, iss: DEV_ISS }],
  ];
  const KEYS = [['a live key', LIVE_KEY], ['a dev key', DEV_KEY]];
  const CASES = KEYS.flatMap(([keyName, key]) => REFUSED.map(([name, claims]) => [name, keyName, key, claims]));

  it.each(CASES)('refuses %s under %s: 401 before the gate, neon and scope', async (_name, _keyName, key, claims) => {
    await load({ key });
    stub.verifyTokenResult = { sub: MEMBER, ...claims };
    const { calls, opts } = wired();
    const ctx = await kit.requestContext(event(), opts);
    expect(ctx).toEqual({ response: resp(401, { error: 'Unauthorized' }) });
    expect(logged(warn, 'household-membership-denied')).toEqual([]);
    expect(calls).toEqual({ neon: [], scope: [] });
  });

  it('admits no azp from a Clerk development instance when this Lambda holds a dev key (the staging smoke)', async () => {
    await load({ key: DEV_KEY });
    stub.verifyTokenResult = { sub: MEMBER, iss: DEV_ISS };
    const ctx = await kit.requestContext(event(), wired().opts);
    expect(ctx.response).toBeNull();
    expect(ctx.userId).toBe(MEMBER);
  });

  it('refuses no azp from a Clerk development instance when this Lambda holds a live key', async () => {
    await load({ key: LIVE_KEY });
    stub.verifyTokenResult = { sub: MEMBER, iss: DEV_ISS };
    const ctx = await kit.requestContext(event(), wired().opts);
    expect(ctx).toEqual({ response: resp(401, { error: 'Unauthorized' }) });
  });

  it('an azp refusal logs its own line with the verified sub, never Clerk\'s failure line or the key', async () => {
    await load({ key: LIVE_KEY });
    stub.verifyTokenResult = { sub: MEMBER, iss: PROD_ISS };
    await kit.requestContext(event(), wired().opts);
    expect(warn.mock.calls.map((c) => JSON.parse(c[0]))).toEqual([
      { msg: 'auth-azp-refused', userId: MEMBER, azp: 'absent', issHost: 'clerk.garden.futureishere.net', devKey: false },
    ]);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(LIVE_KEY);
  });
});

describe('request-context: sign-in failures', () => {
  // The tokenless-request alarm's metric filters match Clerk's own "Invalid JWT form" text, so an absent header must
  // reach Clerk as '' and its message must be logged as is.
  it.each([['an empty headers object', {}], ['no headers at all', undefined]])('%s reaches verifyToken as an empty token and logs Clerk\'s message verbatim', async (_name, headers) => {
    await load();
    stub.verifyTokenResult = new Error('Invalid JWT form. A JWT consists of three parts separated by dots.');
    const ctx = await kit.requestContext(event({ headers }), wired().opts);
    expect(ctx).toEqual({ response: resp(401, { error: 'Unauthorized' }) });
    expect(stub.verifyTokenCalls.map((c) => c.token)).toEqual(['']);
    expect(error.mock.calls).toEqual([['verifyToken failed:', 'Invalid JWT form. A JWT consists of three parts separated by dots.']]);
  });

  it('reads a capitalised Authorization header and strips any case of the Bearer prefix', async () => {
    await load();
    stub.verifyTokenResult = { sub: MEMBER, azp: PROD };
    await kit.requestContext(event({ headers: { Authorization: 'bearer abc.def.ghi' } }), wired().opts);
    expect(stub.verifyTokenCalls.map((c) => c.token)).toEqual(['abc.def.ghi']);
  });

  it('a token Clerk rejects is 401 before the gate, neon and scope', async () => {
    await load();
    stub.verifyTokenResult = new Error('JWT is expired');
    const { calls, opts } = wired();
    expect(await kit.requestContext(event(), opts)).toEqual({ response: resp(401, { error: 'Unauthorized' }) });
    expect(logged(warn, 'household-membership-denied')).toEqual([]);
    expect(calls).toEqual({ neon: [], scope: [] });
  });

  // householdScope('') is [''] and `'' = ANY(ARRAY[''])` is true in Postgres: the empty sub must stop here.
  it.each([['an empty subject', ''], ['no subject', undefined]])('SEC-60: %s with a valid azp is 401 before the gate, neon and scope', async (_name, sub) => {
    await load();
    stub.verifyTokenResult = { sub, azp: PROD };
    const { calls, opts } = wired();
    expect(await kit.requestContext(event(), opts)).toEqual({ response: resp(401, { error: 'Unauthorized' }) });
    expect(warn).not.toHaveBeenCalled();
    expect(calls).toEqual({ neon: [], scope: [] });
  });
});

describe('request-context: the household gate', () => {
  it('a verified non-member gets the generic 403 through the handler\'s resp; neither neon nor scope is called', async () => {
    await load();
    stub.verifyTokenResult = { sub: STRANGER, azp: PROD };
    const { calls, opts } = wired();
    expect(await kit.requestContext(event(), opts)).toEqual({ response: resp(403, { error: 'Forbidden' }) });
    expect(logged(warn, 'household-membership-denied')).toEqual([{ msg: 'household-membership-denied', userId: STRANGER, reason: 'non-member' }]);
    expect(calls).toEqual({ neon: [], scope: [] });
  });

  it('an unset list refuses even a member (fails closed)', async () => {
    delete process.env.GARDEN_HOUSEHOLD_IDS;
    await load();
    stub.verifyTokenResult = { sub: MEMBER, azp: PROD };
    const { calls, opts } = wired();
    expect(await kit.requestContext(event(), opts)).toEqual({ response: resp(403, { error: 'Forbidden' }) });
    expect(logged(warn, 'household-membership-denied').map((o) => o.reason)).toEqual(['env-missing']);
    expect(calls).toEqual({ neon: [], scope: [] });
  });
});

describe('request-context: the signed-in context', () => {
  it('OPTIONS answers 204 before secrets and Clerk', async () => {
    await load();
    const ctx = await kit.requestContext(event({ requestContext: { http: { method: 'OPTIONS' } } }), wired().opts);
    expect(ctx).toEqual({ response: { statusCode: 204, headers: {}, body: '' } });
    expect(send).not.toHaveBeenCalled();
    expect(stub.verifyTokenCalls).toEqual([]);
  });

  it('a member gets the secrets, the sub, neon on the database URL, the scope and the route fields; the body is not parsed', async () => {
    await load();
    stub.verifyTokenResult = { sub: MEMBER, azp: PROD };
    const { calls, opts } = wired();
    const ev = event({ requestContext: { http: { method: 'POST' } }, body: '{not json', queryStringParameters: { a: '1' } });
    const ctx = await kit.requestContext(ev, opts);
    expect(ctx).toEqual({
      response: null,
      secrets: { CLERK_SECRET_KEY: LIVE_KEY, NEON_DATABASE_URL: DB },
      userId: MEMBER,
      sql: SQL,
      householdIds: [MEMBER, MATE],
      method: 'POST',
      rawBody: '{not json',
      query: { a: '1' },
    });
    expect(calls.neon).toEqual([DB]);
    expect(calls.scope).toEqual([[MEMBER, { sql: SQL, event: ev }]]);
  });

  it('without neon or scope the context has neither; the method falls back to the handler\'s default', async () => {
    await load();
    stub.verifyTokenResult = { sub: MEMBER, azp: PROD };
    const ctx = await kit.requestContext({ headers: { authorization: 'Bearer kit' } }, { resp, defaults: { method: 'POST' } });
    expect(ctx).toMatchObject({ response: null, userId: MEMBER, sql: undefined, householdIds: undefined, method: 'POST', query: {} });
    const bare = await kit.requestContext({ headers: { authorization: 'Bearer kit' } }, { resp });
    expect(bare.method).toBe('GET');
  });
});

describe('request-context: secrets', () => {
  it('a failed fetch is rethrown when the handler passes no onSecretsError', async () => {
    await load();
    delete stub.secrets['garden-app/secrets'];
    await expect(kit.requestContext(event(), wired().opts)).rejects.toThrow(/no secret configured/);
    expect(stub.verifyTokenCalls).toEqual([]);
  });

  it('onSecretsError answers a failed fetch, and is handed no secret values', async () => {
    await load();
    delete stub.secrets['garden-app/secrets'];
    const onSecretsError = vi.fn(() => resp(503, { error: 'Service unavailable' }));
    const ctx = await kit.requestContext(event(), { ...wired().opts, onSecretsError });
    expect(ctx).toEqual({ response: resp(503, { error: 'Service unavailable' }) });
    expect(onSecretsError.mock.calls[0][1]).toEqual({ missing: null, keys: null });
    expect(stub.verifyTokenCalls).toEqual([]);
  });

  it('a missing required secret goes to onSecretsError with the missing and present names only', async () => {
    await load({ secrets: { CLERK_SECRET_KEY: LIVE_KEY } });
    const onSecretsError = vi.fn(() => resp(500, { error: 'Server configuration error' }));
    const ctx = await kit.requestContext(event(), { ...wired().opts, onSecretsError, requiredSecrets: ['CLERK_SECRET_KEY', 'NEON_DATABASE_URL'] });
    expect(ctx).toEqual({ response: resp(500, { error: 'Server configuration error' }) });
    expect(onSecretsError.mock.calls[0][1]).toEqual({ missing: ['NEON_DATABASE_URL'], keys: ['CLERK_SECRET_KEY'] });
    expect(JSON.stringify(onSecretsError.mock.calls)).not.toContain(LIVE_KEY);
    expect(stub.verifyTokenCalls).toEqual([]);
  });

  it('a missing required secret throws when the handler passes no onSecretsError', async () => {
    await load({ secrets: { CLERK_SECRET_KEY: LIVE_KEY } });
    await expect(kit.requestContext(event(), { ...wired().opts, requiredSecrets: ['NEON_DATABASE_URL'] })).rejects.toThrow(/missing required secrets/);
  });

  it('secrets are fetched once for the container\'s life by default', async () => {
    await load();
    stub.verifyTokenResult = { sub: MEMBER, azp: PROD };
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await kit.requestContext(event(), wired().opts);
    now.mockReturnValue(1_000_000 + 24 * 60 * 60 * 1000);
    await kit.requestContext(event(), wired().opts);
    expect(send).toHaveBeenCalledTimes(1);
  });

  // photos and facebook-share pass 5 minutes so a rotated secret does not strand a warm container.
  it('secretsTtlMs refetches once the cached secrets are older than it, and not before', async () => {
    await load();
    stub.verifyTokenResult = { sub: MEMBER, azp: PROD };
    const opts = { ...wired().opts, secretsTtlMs: 5 * 60 * 1000 };
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await kit.requestContext(event(), opts);
    now.mockReturnValue(1_000_000 + 5 * 60 * 1000 - 1);
    await kit.requestContext(event(), opts);
    expect(send).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + 5 * 60 * 1000);
    await kit.requestContext(event(), opts);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
