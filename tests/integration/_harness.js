// tests/integration/_harness.js — shared harness for real-Postgres integration tests.
// INT_DATABASE_URL (ephemeral Neon branch URI) must be set before import.
// Mocks ONLY AWS SecretsManager + Clerk verifyToken; the SQL layer is REAL.
// directSql() = read-back assertions that prove DB state (not handler echo).
import { neon } from '@neondatabase/serverless'
import { vi } from 'vitest'

const DB_URL = process.env.INT_DATABASE_URL
if (!DB_URL) throw new Error('INT_DATABASE_URL is required for integration tests')

export const directSql = neon(DB_URL)

let _testUserId = 'test-user-integration-harness'
export function setTestUserId(id) { _testUserId = id }
export function getTestUserId() { return _testUserId }

// getSecrets() in handlers does: JSON.parse((await sm.send(cmd)).SecretString).
// So the stubbed client's send() returns { SecretString: '<json>' } with the
// ephemeral DB URL + a stub Clerk key (verifyToken is itself stubbed below).
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    GetSecretValueCommand: class { constructor(a) { this.input = a } },
    SecretsManagerClient: class {
      send() {
        return Promise.resolve({
          SecretString: JSON.stringify({
            NEON_DATABASE_URL: process.env.INT_DATABASE_URL,
            CLERK_SECRET_KEY: 'stub-not-validated',
          }),
        })
      }
    },
  }
})

// Stub Clerk verifyToken — returns { sub: <testUserId> } without a network call.
vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn().mockImplementation(() => Promise.resolve({ sub: _testUserId })),
}))

export function makeEvent({ method = 'GET', path = '/api/events', body = null, userId = _testUserId } = {}) {
  // Emulate the AWS Function URL v2 payload: rawPath carries NO query string; the query is
  // split out into rawQueryString + queryStringParameters (absent when empty, per AWS). Handlers
  // that read event.queryStringParameters?.x (e.g. harvests timeframe/include/cursor) need this;
  // handlers that only match rawPath are unaffected (a no-query path is unchanged). The prior
  // version left the full query glued onto rawPath, so a handler with a strict rawPath equality
  // guard 405'd every request and query params never reached the handler at all.
  const qIdx = path.indexOf('?')
  const rawPath = qIdx >= 0 ? path.slice(0, qIdx) : path
  const rawQueryString = qIdx >= 0 ? path.slice(qIdx + 1) : ''
  let queryStringParameters
  if (rawQueryString) {
    queryStringParameters = {}
    for (const [k, v] of new URLSearchParams(rawQueryString)) queryStringParameters[k] = v
  }
  return {
    requestContext: { http: { method } },
    rawPath,
    rawQueryString,
    queryStringParameters,
    headers: { authorization: `Bearer stub-token-for-${userId}` },
    body: body ? JSON.stringify(body) : null,
  }
}

export async function callHandler(handler, { method, path, body, userId } = {}) {
  const result = await handler(makeEvent({ method, path, body, userId }))
  return {
    status: result.statusCode,
    body: result.body ? JSON.parse(result.body) : null,
    raw: result,
  }
}

export function testRunId() {
  return `int-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}
