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
  // S3 staging lifecycle for the Instagram path: PutObject inputs, DeleteObject inputs, and the
  // presign requests. Kept separate from s3Calls so a test can assert "every staged key was swept"
  // directly rather than by filtering one interleaved log.
  s3Puts: [],
  s3Deletes: [],
  s3DeleteThrows: false,
  // VersionId PutObject hands back. Non-null by default because the real bucket is versioned;
  // null emulates an unversioned bucket.
  s3PutVersionId: 'VER-STUB-1',
  // Emulates the exec role's actual permissions today: s3:DeleteObject yes, DeleteObjectVersion no.
  s3DeleteVersionDenied: false,
  presigns: [],
  // CloudFront signed-URL requests (photo-access.js's PHOTO_CDN_ENABLED path).
  cdnSigns: [],
};

export function resetStubs() {
  stubState.secrets = {
    'garden-app/secrets': { CLERK_SECRET_KEY: 'sk_stub', NEON_DATABASE_URL: 'postgres://stub/db' },
    // ig_user_id is present by DEFAULT so the Instagram path is exercisable. index.js caches this
    // secret in module scope for 5 minutes, so a test that needs it ABSENT (the ig_not_configured
    // branch) cannot simply delete it here — the first getFbSecret() of the file wins for the whole
    // file. That case therefore lives in its own test file, which gets its own module registry.
    'garden-app/facebook-page-token': {
      page_id: 'PAGE_STUB', page_token: 'TOKEN_STUB', app_id: 'APP_STUB', app_secret: 'SECRET_STUB',
      ig_user_id: 'IGUSER_STUB',
    },
  };
  stubState.verifyTokenResult = null;
  stubState.verifyTokenCalls = [];
  stubState.sqlHandler = () => [];
  stubState.sqlCalls = [];
  stubState.s3Bytes = null;
  stubState.s3Calls = [];
  stubState.s3Puts = [];
  stubState.s3Deletes = [];
  stubState.s3DeleteThrows = false;
  stubState.s3PutVersionId = 'VER-STUB-1';
  stubState.s3DeleteVersionDenied = false;
  stubState.presigns = [];
  stubState.cdnSigns = [];
}

resetStubs();
