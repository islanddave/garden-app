// Shared, resettable state for the Lambda runtime stubs (see the sibling modules in this folder).
//
// WHY STUBS AND NOT MOCKS. The handlers import their AWS/Clerk/Neon deps at module scope, and those
// deps live in each Lambda's OWN package.json — they are not installed at the repo root, so the root
// vitest run cannot resolve them and therefore cannot import a handler at all. The consequence was
// that lambda/facebook-share/index.js — 433 lines that publish to a public Facebook Page — carried
// ZERO execution coverage. vitest.config.ts aliases those four specifiers here so the handler can be
// imported and actually run.
//
// A test drives behaviour by setting fields on `stubState` before importing/invoking the handler.
// Call `resetStubs()` in beforeEach or state leaks between tests.

export const stubState = {
  // Secrets Manager, keyed by SecretId so the two different secrets the handler fetches are
  // distinguishable (garden-app/secrets vs garden-app/facebook-page-token).
  secrets: {},
  // Clerk. Either a payload object to return, or an Error to throw.
  verifyTokenResult: null,
  verifyTokenCalls: [],
  // Neon. (strings, ...values) => rows. Default returns [] so a handler that queries does not crash.
  sqlHandler: () => [],
  sqlCalls: [],
  // S3 GetObject body bytes.
  s3Bytes: null,
  s3Calls: [],
};

export function resetStubs() {
  stubState.secrets = {
    'garden-app/secrets': { CLERK_SECRET_KEY: 'sk_stub', NEON_DATABASE_URL: 'postgres://stub/db' },
    'garden-app/facebook-page-token': {
      page_id: 'PAGE_STUB', page_token: 'TOKEN_STUB', app_id: 'APP_STUB', app_secret: 'SECRET_STUB',
    },
  };
  stubState.verifyTokenResult = null;
  stubState.verifyTokenCalls = [];
  stubState.sqlHandler = () => [];
  stubState.sqlCalls = [];
  stubState.s3Bytes = null;
  stubState.s3Calls = [];
}

resetStubs();
