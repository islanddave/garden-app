/**
 * src/__tests__/auth.test.ts
 * Auth path unit tests — validates Clerk key validation logic.
 *
 * These tests exercise pure functions; no network calls, no Clerk SDK instantiation.
 * As auth logic moves into testable utility modules (src/lib/auth.ts etc.),
 * add tests here. Keep Lambda-reachable auth tests in tests/smoke/run-smoke.sh.
 */

import { describe, it, expect } from 'vitest';

// ── Clerk key validation ──────────────────────────────────────────────────────
// Extracted from the logic in deploy.yml's "Validate env vars" step.
// Mirrors the gate condition: pk_live_* required in prod; pk_test_* in dev/staging.

const isValidClerkKey = (key: string | undefined | null): boolean => {
  if (!key || key.trim() === '') return false;
  return key.startsWith('pk_test_') || key.startsWith('pk_live_');
};

const isProdClerkKey = (key: string): boolean => key.startsWith('pk_live_');
const isStagingClerkKey = (key: string): boolean => key.startsWith('pk_test_');

describe('Clerk publishable key validation', () => {
  it('rejects empty string', () => expect(isValidClerkKey('')).toBe(false));
  it('rejects null', () => expect(isValidClerkKey(null)).toBe(false));
  it('rejects undefined', () => expect(isValidClerkKey(undefined)).toBe(false));
  it('rejects whitespace-only', () => expect(isValidClerkKey('   ')).toBe(false));
  it('rejects arbitrary string', () => expect(isValidClerkKey('not_a_clerk_key')).toBe(false));
  it('rejects sk_ (wrong key type)', () => expect(isValidClerkKey('sk_test_abc')).toBe(false));

  it('accepts pk_test_ prefix', () => expect(isValidClerkKey('pk_test_abc123')).toBe(true));
  it('accepts pk_live_ prefix', () => expect(isValidClerkKey('pk_live_abc123')).toBe(true));
  it('accepts staging key from env', () =>
    expect(isValidClerkKey('pk_test_ZWxlY3RyaWMtaGF3ay04Ny5jbGVyay5hY2NvdW50cy5kZXYk')).toBe(true));
});

describe('Clerk key environment discrimination', () => {
  it('correctly identifies prod key', () => {
    expect(isProdClerkKey('pk_live_abc123')).toBe(true);
    expect(isProdClerkKey('pk_test_abc123')).toBe(false);
  });

  it('correctly identifies staging/dev key', () => {
    expect(isStagingClerkKey('pk_test_abc123')).toBe(true);
    expect(isStagingClerkKey('pk_live_abc123')).toBe(false);
  });

  it('staging key must not be used in prod (deploy gate logic)', () => {
    const stagingKey = 'pk_test_ZWxlY3RyaWMtaGF3ay04Ny5jbGVyay5hY2NvdW50cy5kZXYk';
    expect(isProdClerkKey(stagingKey)).toBe(false);
  });
});

// ── Lambda URL validation ─────────────────────────────────────────────────────
const isValidLambdaUrl = (url: string | undefined): boolean => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.lambda-url.us-east-1.on.aws');
  } catch {
    return false;
  }
};

describe('Lambda URL validation', () => {
  it('accepts valid Lambda Function URL', () =>
    expect(isValidLambdaUrl('https://abc123.lambda-url.us-east-1.on.aws/')).toBe(true));

  it('rejects http (not https)', () =>
    expect(isValidLambdaUrl('http://abc123.lambda-url.us-east-1.on.aws/')).toBe(false));

  it('rejects non-Lambda URL', () =>
    expect(isValidLambdaUrl('https://example.com/api')).toBe(false));

  it('rejects empty string', () =>
    expect(isValidLambdaUrl('')).toBe(false));

  it('rejects undefined', () =>
    expect(isValidLambdaUrl(undefined)).toBe(false));

  it('validates staging Lambda URLs from env', () => {
    const stagingUrls = [
      'https://mjozckiuondhvmsa7eulvuld3m0rptdh.lambda-url.us-east-1.on.aws/',
      'https://fhgmxvrp2mefmzybhhwiptb2j40abfrw.lambda-url.us-east-1.on.aws/',
    ];
    stagingUrls.forEach(url => expect(isValidLambdaUrl(url)).toBe(true));
  });
});
