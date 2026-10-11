// Execution coverage for GET /api/share/facebook/health and for the generic Graph-error log line.
//
// WHY THIS EXISTS (OPS-FBDATAACCESSEXPIRY-001, design W3 + W4). The Page token carries two clocks.
// `expires_at` is 0 and stays 0. `data_access_expires_at` is the app's access to the granting user's
// data, 90 days from their last authorization, and when it lapses Meta keeps reporting
// `is_valid: true`. health() fetched that number from debug_token and projected only `expires_at`,
// so the one in-app probe would have answered `healthy: true` straight through the outage. Nothing
// executed health() before this file.
//
// The second half pins the log line on the `facebook_error` branch: when the lapse arrives, the
// fields classifyGraphError drops (type, error_subcode, fbtrace_id, error_user_msg) are the only
// thing that says what kind of permissions error it was.
//
// Graph I/O is intercepted at global fetch — the handler's only network surface.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import { dataAccessStatus } from './graph.js';

const ADMIN = 'user_admin_stub';
process.env.S3_PHOTOS_BUCKET = 'garden-photos-stub';
const { handler } = await import('./index.js');

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const okJson = (json) => ({ ok: true, status: 200, json: async () => json });
const errJson = (status, json) => ({ ok: false, status, json: async () => json });
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body || '{}') });
const healthReq = () => ({
  requestContext: { http: { method: 'GET' } },
  rawPath: '/api/share/facebook/health',
  headers: { authorization: 'Bearer stub' },
});
const SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'];
const debugToken = (over) => okJson({ data: { is_valid: true, expires_at: 0, scopes: SCOPES, ...over } });

let fetchMock;
beforeEach(() => {
  resetStubs();
  stubState.verifyTokenResult = { sub: ADMIN };
  process.env.ADMIN_CLERK_SUBS = ADMIN;
  process.env.FB_SHARE_ENABLED = '1';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('dataAccessStatus', () => {
  const NOW = 1_800_000_000;
  it('reports days remaining to one decimal while the grant is live', () => {
    expect(dataAccessStatus(NOW + 48 * DAY, NOW)).toEqual({
      data_access_expires_at: NOW + 48 * DAY, data_access_days_remaining: 48, data_access_lapsed: false,
    });
    expect(dataAccessStatus(NOW + 1.25 * DAY, NOW).data_access_days_remaining).toBe(1.3);
  });
  it('is lapsed at and after the expiry second, with a negative remainder', () => {
    expect(dataAccessStatus(NOW, NOW).data_access_lapsed).toBe(true);
    const past = dataAccessStatus(NOW - 2 * DAY, NOW);
    expect(past.data_access_lapsed).toBe(true);
    expect(past.data_access_days_remaining).toBe(-2);
  });
  it('treats 0, absent and non-numeric as no clock reported: not lapsed, no day count', () => {
    for (const v of [0, undefined, null, 'soon', NaN, -5]) {
      expect(dataAccessStatus(v, NOW)).toEqual({
        data_access_expires_at: 0, data_access_days_remaining: null, data_access_lapsed: false,
      });
    }
  });
});

describe('GET /api/share/facebook/health', () => {
  it('reports the data-access clock beside the token clock while both are good', async () => {
    const at = nowSec() + 48 * DAY;
    fetchMock.mockResolvedValueOnce(debugToken({ data_access_expires_at: at }));
    const { status, body } = parse(await handler(healthReq()));
    expect(status).toBe(200);
    expect(body.healthy).toBe(true);
    expect(body.is_valid).toBe(true);
    expect(body.expires_at).toBe(0);
    expect(body.data_access_expires_at).toBe(at);
    expect(body.data_access_days_remaining).toBeCloseTo(48, 0);
    expect(body.data_access_lapsed).toBe(false);
    expect(body.scopes).toEqual(SCOPES);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/debug_token?input_token=TOKEN_STUB');
  });

  // The regression this file is for. Meta's answer after a lapse: is_valid true, expires_at 0.
  it('is NOT healthy once data access has lapsed, even though is_valid is still true', async () => {
    fetchMock.mockResolvedValueOnce(debugToken({ data_access_expires_at: nowSec() - DAY }));
    const { status, body } = parse(await handler(healthReq()));
    expect(status).toBe(200);
    expect(body.is_valid).toBe(true);
    expect(body.data_access_lapsed).toBe(true);
    expect(body.data_access_days_remaining).toBeLessThan(0);
    expect(body.healthy).toBe(false);
  });

  it('stays healthy when Meta reports no data-access clock at all', async () => {
    fetchMock.mockResolvedValueOnce(debugToken({}));
    const { body } = parse(await handler(healthReq()));
    expect(body.healthy).toBe(true);
    expect(body.data_access_expires_at).toBe(0);
    expect(body.data_access_days_remaining).toBeNull();
  });

  it('is not healthy on an invalid token, whatever the data-access clock says', async () => {
    fetchMock.mockResolvedValueOnce(debugToken({ is_valid: false, data_access_expires_at: nowSec() + 48 * DAY }));
    const { body } = parse(await handler(healthReq()));
    expect(body.is_valid).toBe(false);
    expect(body.healthy).toBe(false);
  });

  it('is not healthy when debug_token itself errors', async () => {
    fetchMock.mockResolvedValueOnce(errJson(400, { error: { code: 190, message: 'bad app token' } }));
    const { status, body } = parse(await handler(healthReq()));
    expect(status).toBe(200);
    expect(body.healthy).toBe(false);
    expect(body.detail.code).toBe(190);
  });
});

describe('generic Graph error branch logs the full error body', () => {
  const bytes = (...x) => Uint8Array.from(x.flat());
  const seg = (m, p) => [0xFF, m, ((p.length + 2) >> 8) & 0xFF, (p.length + 2) & 0xFF, ...p];
  const GOOD_JPEG = bytes([0xFF, 0xD8], seg(0xE0, [0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    [0xFF, 0xDA, 0x00, 0x08, 1, 0, 0, 0, 0, 0], [1, 2, 3, 4], [0xFF, 0xD9]);
  const PHOTO = '11111111-1111-4111-8111-111111111111';
  const GRAPH_BODY = {
    error: {
      message: '(#200) Requires pages_manage_posts permission', type: 'OAuthException', code: 200,
      error_subcode: 2069007, error_user_title: 'Data access expired',
      error_user_msg: 'Re-authorize the app to continue.', fbtrace_id: 'TRACE_STUB_123',
    },
  };

  it('writes type, subcode, user message and trace id, and returns the same 502 as before', async () => {
    stubState.s3Bytes = GOOD_JPEG;
    stubState.sqlHandler = (text) => (/FROM\s+photos/i.test(text)
      ? [{ id: PHOTO, storage_path: `photos/${PHOTO}.jpg`, planting_name: 'Tie-Dye Tomato', variety_name: 'Tie-Dye', crop_name: 'Tomato', event_type: 'harvest' }]
      : []);
    fetchMock.mockResolvedValue(errJson(403, GRAPH_BODY));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { status, body } = parse(await handler({
      requestContext: { http: { method: 'POST' } },
      rawPath: '/api/share/facebook',
      headers: { authorization: 'Bearer stub' },
      body: JSON.stringify({ photo_ids: [PHOTO], caption: 'x', client_request_id: '22222222-2222-4222-8222-222222222222' }),
    }));

    expect(status).toBe(502);
    expect(body).toEqual({ error: 'facebook_error', message: GRAPH_BODY.error.message, code: 200 });

    const line = errSpy.mock.calls.find((c) => c[0] === 'Graph error:');
    expect(line, 'the generic branch must log').toBeTruthy();
    expect(typeof line[1]).toBe('string');
    const logged = JSON.parse(line[1]);
    expect(logged.httpStatus).toBe(403);
    expect(logged.code).toBe(200);
    expect(logged.subcode).toBe(2069007);
    expect(logged.body).toEqual(GRAPH_BODY);
    expect(line[1]).not.toContain('TOKEN_STUB');
    expect(line[1]).not.toContain('SECRET_STUB');
  });
});
