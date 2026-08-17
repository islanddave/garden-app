// V4-APIGZIP-001 — EXECUTABLE tests for the negotiated-gzip responder.
//
// Unlike the handler modules in this tree, http-response.js imports node:zlib and NOTHING else, so
// it is importable from repo root and this tier can assert real behavior instead of source text:
// every case below actually gunzips the emitted body and compares it to the input.
//
// The four things that can break a live API here, in the order they bite:
//   1. compressing for a client that never offered gzip — broken content, silent above the socket
//   2. emitting the wrong Function-URL envelope (a Buffer body, or base64 without isBase64Encoded)
//   3. compressing a body too small to benefit, where gzip is a net LOSS
//   4. dropping Vary, which is what lets a shared cache hand a gzipped body to a client that
//      cannot decode it
import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { acceptsGzip, readAcceptEncoding, jsonResponse, jsonResponder, MIN_GZIP_BYTES } from './http-response.js';

// A body comfortably over the threshold and shaped like the real thing: the /api/plants list.
const bigBody = Array.from({ length: 40 }, (_, i) => ({
  id: `4f1a${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`,
  name: `Cherokee Purple ${i}`,
  status: 'growing',
  notes: 'Overwintered under row cover; transplanted after the last frost date.',
  variety_ref: { name: 'Cherokee Purple', genus: 'Solanum', species: 'lycopersicum', days_to_maturity_min: 72 },
}));
const bigJson = JSON.stringify(bigBody);

describe('acceptsGzip — only compress when the client actually asked', () => {
  it('accepts the encodings a browser really sends', () => {
    expect(acceptsGzip('gzip, deflate, br')).toBe(true);
    expect(acceptsGzip('gzip, deflate, br, zstd')).toBe(true);
    expect(acceptsGzip('gzip')).toBe(true);
  });

  it('refuses when gzip is absent from the offer', () => {
    // The header exists but names other codings. Compressing here is the broken-content failure.
    expect(acceptsGzip('br')).toBe(false);
    expect(acceptsGzip('deflate, br, zstd')).toBe(false);
    expect(acceptsGzip('identity')).toBe(false);
  });

  it('refuses an absent, empty or non-string header', () => {
    expect(acceptsGzip('')).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip(null)).toBe(false);
  });

  it('honours q=0 as the refusal it is', () => {
    // `gzip;q=0` is a client explicitly telling us NOT to gzip. Treating the token as presence-only
    // is the classic parser bug, and it reads as acceptance of exactly the wrong thing.
    expect(acceptsGzip('gzip;q=0')).toBe(false);
    expect(acceptsGzip('gzip;q=0.000')).toBe(false);
    expect(acceptsGzip('gzip;q=0.001')).toBe(true);
    expect(acceptsGzip('deflate, gzip;q=0')).toBe(false);
  });

  it('applies the wildcard only when gzip is not named explicitly', () => {
    expect(acceptsGzip('*')).toBe(true);
    expect(acceptsGzip('*;q=0')).toBe(false);
    // explicit token DECIDES in both directions, whichever side of the wildcard it sits on
    expect(acceptsGzip('*;q=0, gzip')).toBe(true);
    expect(acceptsGzip('gzip;q=0, *')).toBe(false);
  });

  it('tolerates case and whitespace, and the x-gzip alias', () => {
    expect(acceptsGzip('GZIP')).toBe(true);
    expect(acceptsGzip('  gzip ;  q = 0.5 ')).toBe(true);
    expect(acceptsGzip('x-gzip')).toBe(true);
    expect(acceptsGzip('x-gzip;q=0')).toBe(false);
  });
});

describe('readAcceptEncoding — Function URL header lookup', () => {
  it('reads the lowercased name the service actually sends, and the capitalized fallback', () => {
    expect(readAcceptEncoding({ headers: { 'accept-encoding': 'gzip' } })).toBe('gzip');
    expect(readAcceptEncoding({ headers: { 'Accept-Encoding': 'gzip' } })).toBe('gzip');
  });

  it('is empty — not undefined — when the header or the event is missing', () => {
    // Fail-closed: no header means no compression, never a crash and never an assumption.
    expect(readAcceptEncoding({ headers: {} })).toBe('');
    expect(readAcceptEncoding({})).toBe('');
    expect(readAcceptEncoding(undefined)).toBe('');
  });
});

describe('jsonResponse — the compressed branch', () => {
  const res = jsonResponse(200, bigBody, { acceptEncoding: 'gzip, deflate, br' });

  it('returns the exact Function-URL envelope: base64 STRING body + isBase64Encoded', () => {
    // A Buffer body would be JSON-serialized by the runtime into {"type":"Buffer","data":[…]} and
    // shipped as that literal; base64 without the flag ships the base64 text as the body.
    expect(Object.keys(res).sort()).toEqual(['body', 'headers', 'isBase64Encoded', 'statusCode']);
    expect(res.isBase64Encoded).toBe(true);
    expect(typeof res.body).toBe('string');
    expect(Buffer.isBuffer(res.body)).toBe(false);
    expect(res.body).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('the decoded body is real gzip that round-trips to the identical JSON', () => {
    const bytes = Buffer.from(res.body, 'base64');
    expect(bytes[0]).toBe(0x1f); // gzip magic — not deflate, not zlib-wrapped
    expect(bytes[1]).toBe(0x8b);
    expect(gunzipSync(bytes).toString('utf8')).toBe(bigJson);
    expect(JSON.parse(gunzipSync(bytes).toString('utf8'))).toEqual(bigBody);
  });

  it('declares Content-Encoding: gzip and keeps the JSON content type', () => {
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(res.headers['Content-Type']).toBe('application/json');
  });

  it('is materially smaller than the identity body it replaces', () => {
    expect(Buffer.from(res.body, 'base64').length).toBeLessThan(Buffer.byteLength(bigJson, 'utf8') / 2);
  });

  it('never sets Content-Length — the service computes it from the DECODED bytes', () => {
    // A handler-set length would describe the base64 payload, not the wire body.
    expect(Object.keys(res.headers).map((k) => k.toLowerCase())).not.toContain('content-length');
  });
});

describe('jsonResponse — the identity branch', () => {
  it('sends plain JSON when the client did not offer gzip', () => {
    const res = jsonResponse(200, bigBody, { acceptEncoding: 'br, deflate' });
    expect(res.isBase64Encoded).toBe(false);
    expect(res.body).toBe(bigJson);
    expect(res.headers['Content-Encoding']).toBeUndefined();
  });

  it('sends plain JSON when there is no Accept-Encoding at all', () => {
    const res = jsonResponse(200, bigBody, {});
    expect(res.isBase64Encoded).toBe(false);
    expect(res.body).toBe(bigJson);
    expect(res.headers['Content-Encoding']).toBeUndefined();
  });

  it('leaves a below-threshold body uncompressed even when gzip is offered', () => {
    // The error shape every route returns: 24 B in, 44 B out under gzip. Compressing it is a loss.
    const small = { error: 'Unauthorized' };
    expect(Buffer.byteLength(JSON.stringify(small), 'utf8')).toBeLessThan(MIN_GZIP_BYTES);
    const res = jsonResponse(401, small, { acceptEncoding: 'gzip' });
    expect(res.isBase64Encoded).toBe(false);
    expect(res.body).toBe('{"error":"Unauthorized"}');
    expect(res.headers['Content-Encoding']).toBeUndefined();
  });

  it('the threshold is an exclusive floor at exactly MIN_GZIP_BYTES', () => {
    // Pins the boundary itself: one byte under stays identity, exactly at the floor compresses.
    const pad = (n) => 'x'.repeat(n - Buffer.byteLength(JSON.stringify({ n: '' }), 'utf8'));
    const under = jsonResponse(200, { n: pad(MIN_GZIP_BYTES - 1) }, { acceptEncoding: 'gzip' });
    const at = jsonResponse(200, { n: pad(MIN_GZIP_BYTES) }, { acceptEncoding: 'gzip' });
    expect(under.isBase64Encoded).toBe(false);
    expect(at.isBase64Encoded).toBe(true);
  });

  it('refuses a "compressed" body that came out LARGER than the input', () => {
    // Reachable only by lowering the floor, which is exactly what the floor exists to prevent —
    // so the backstop is proven here rather than left as a branch nothing can ever execute.
    const res = jsonResponse(401, { error: 'Unauthorized' }, { acceptEncoding: 'gzip', minBytes: 1 });
    expect(res.isBase64Encoded).toBe(false);
    expect(res.body).toBe('{"error":"Unauthorized"}');
  });

  it('an undefined body is an empty string, not the literal "undefined"', () => {
    expect(jsonResponse(204, undefined, { acceptEncoding: 'gzip' }).body).toBe('');
  });
});

describe('jsonResponse — Vary', () => {
  it('varies on Accept-Encoding AND Origin on BOTH branches', () => {
    // Both, always: a compressed response with no Vary is what lets a shared cache serve gzip to a
    // client that cannot decode it, and Origin is what the Function URL CORS layer varies on today
    // (observed `Vary: Origin`) — dropping it would be a CORS regression.
    const gz = jsonResponse(200, bigBody, { acceptEncoding: 'gzip' });
    const id = jsonResponse(200, bigBody, { acceptEncoding: 'br' });
    expect(gz.headers.Vary).toBe('Accept-Encoding, Origin');
    expect(id.headers.Vary).toBe('Accept-Encoding, Origin');
  });
});

describe('jsonResponder — per-invocation binding', () => {
  it('binds THIS request\'s Accept-Encoding, so resp(status, body) call sites need no edit', () => {
    const respGzip = jsonResponder({ headers: { 'accept-encoding': 'gzip, deflate, br' } }, {});
    const respPlain = jsonResponder({ headers: {} }, {});
    expect(respGzip(200, bigBody).isBase64Encoded).toBe(true);
    expect(respPlain(200, bigBody).isBase64Encoded).toBe(false);
  });

  it('merges the caller\'s own headers into both branches', () => {
    const resp = jsonResponder({ headers: { 'accept-encoding': 'gzip' } }, { 'X-Trace': 'abc' });
    expect(resp(200, bigBody).headers['X-Trace']).toBe('abc');
    expect(resp(400, { error: 'nope' }).headers['X-Trace']).toBe('abc');
  });

  it('two invocations of the same module do not leak encoding state into each other', () => {
    // The reason resp is a per-invocation closure rather than module-scope mutable state.
    const a = jsonResponder({ headers: { 'accept-encoding': 'gzip' } }, {});
    const b = jsonResponder({ headers: { 'accept-encoding': 'identity' } }, {});
    expect(a(200, bigBody).isBase64Encoded).toBe(true);
    expect(b(200, bigBody).isBase64Encoded).toBe(false);
    expect(a(200, bigBody).isBase64Encoded).toBe(true);
  });
});
