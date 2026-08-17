// http-response.js — V4-APIGZIP-001 shared JSON responder with negotiated gzip.
//
// Lambda Function URLs do NOT compress for you. Measured live 2026-08-17 against the plants URL:
// a 28,251-byte JSON response requested WITH Accept-Encoding came back Content-Length: 28251, no
// Content-Encoding, Vary: Origin — while the SAME app's CloudFront asset returns content-encoding:
// gzip under identical request headers. The client was never the limitation; nothing on the
// Function-URL path was setting an encoding. Reconstructed from prod rows the same day, the
// /api/plants list body is 591,905 B and gzips to 113,259 B (5.23x, 80.9% off the wire).
//
// The Function-URL contract for a compressed body is exact and unforgiving: `body` must be a
// BASE64 STRING with isBase64Encoded: true. The service base64-decodes it and puts the raw bytes on
// the wire with its own Content-Length. Returning the gzip Buffer directly instead would be
// JSON-serialized by the runtime into {"type":"Buffer","data":[...]} and shipped as that literal.
//
// DEPLOY NOTE (mirrors household.js / photo-access.js): each Lambda is zipped from its OWN dir
// (deploy-lambda.yml: `cd lambda/<fn> && zip -r ../<fn>.zip .`), so a `../http-response.js` import
// is NOT packaged and the handler 502s at module load. An IDENTICAL copy lives in each adopting
// Lambda dir and is imported as `./http-response.js`; copies are kept byte-identical by
// lambda/http-response-copies-sync.test.js.
//
// node:zlib ONLY — no new runtime dependency. garden-daily-plan-read runs a 42.9% cold-start rate,
// so init weight is not free: a cold `import('node:zlib')` measures 0.85 ms locally against the
// hundreds of ms this Lambda already spends loading @aws-sdk/*, @clerk/backend and the neon driver.
import { gzipSync } from 'node:zlib';

// Below this many UTF-8 bytes the response is sent identity. Justification, measured on real bodies:
//   · gzip INFLATES the small JSON this API actually returns — {"error":"Unauthorized"} is 24 B in
//     and 44 B out; the longest 400 text is 59 B in, 74 B out. Every error path is in that class.
//   · the most a sub-1 KB body can save is a few hundred bytes — less than one 1460-byte TCP
//     segment and smaller than the response headers, so it cannot remove a round trip.
//   · it keeps every error/no-content path on the byte-identical pre-change code path, which is
//     what bounds the blast radius of turning this on for a live API.
// One real plant row is 1,099 B and compresses to 517 B, so the first thing ABOVE the threshold
// already pays for itself. Overridable per call (see minBytes) — the rollout tunes per route.
export const MIN_GZIP_BYTES = 1024;

// zlib's default. Measured on the 688,637 B two-URL plants body: L1 153,500 B / 2.5 ms,
// L4 132,813 B / 4.2 ms, L6 126,274 B / 5.4 ms, L9 124,953 B / 6.9 ms (local, per call). The knee is
// L4–L6; L9 buys 1,321 B for +28% CPU. Drop to L4 if CloudWatch Duration ever says this matters.
export const GZIP_LEVEL = 6;

// Accept-Encoding is what makes compression legal, and Origin is what the Function URL's own CORS
// layer varies on today (observed `Vary: Origin`). Emitting both means that whichever of the two
// wins if the service overwrites rather than appends, neither correctness property is lost.
const VARY = 'Accept-Encoding, Origin';

// RFC 9110 §12.5.3 q-value. A parameter list with no q is q=1; a malformed q ("q=bogus") is read
// leniently as q=1 rather than as a rejection, matching how origin servers generally treat it.
function qValue(params) {
  for (const p of params) {
    const [k, v] = p.split('=');
    if (k.trim().toLowerCase() === 'q') {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : 1;
    }
  }
  return 1;
}

// Does this Accept-Encoding permit gzip? Never assume — a body compressed for a client that did not
// offer it is broken content, not slow content, and that failure is silent at every layer above the
// socket. An explicit gzip token DECIDES (including `gzip;q=0`, which is a refusal); only in its
// absence does `*` apply. x-gzip is the RFC's deprecated alias for the same coding.
export function acceptsGzip(acceptEncoding) {
  if (typeof acceptEncoding !== 'string' || acceptEncoding === '') return false;
  let wildcard = false;
  for (const part of acceptEncoding.split(',')) {
    const [tokenRaw, ...params] = part.split(';');
    const token = tokenRaw.trim().toLowerCase();
    if (!token) continue;
    if (token === 'gzip' || token === 'x-gzip') return qValue(params) > 0;
    if (token === '*') wildcard = qValue(params) > 0;
  }
  return wildcard;
}

// Function URLs lowercase header names; the capitalized fallback mirrors the defensive
// `authorization ?? Authorization` read every handler in this repo already does.
export function readAcceptEncoding(event) {
  const headers = event?.headers ?? {};
  return headers['accept-encoding'] ?? headers['Accept-Encoding'] ?? '';
}

// The Function-URL response object. Shape is identical in both branches apart from
// Content-Encoding/isBase64Encoded, so a caller can never accidentally emit half a contract.
export function jsonResponse(statusCode, body, { acceptEncoding = '', headers = {}, minBytes = MIN_GZIP_BYTES } = {}) {
  const json = JSON.stringify(body) ?? '';
  const base = { 'Content-Type': 'application/json', ...headers, Vary: VARY };
  const identity = { statusCode, headers: base, body: json, isBase64Encoded: false };

  const rawBytes = Buffer.byteLength(json, 'utf8');
  if (rawBytes < minBytes || !acceptsGzip(acceptEncoding)) return identity;

  const gz = gzipSync(Buffer.from(json, 'utf8'), { level: GZIP_LEVEL });
  // Backstop for the case the threshold exists to avoid: incompressible input, where the deflate
  // envelope makes the "compressed" body the LARGER one. Sending it would be a pure loss.
  if (gz.length >= rawBytes) return identity;

  return {
    statusCode,
    headers: { ...base, 'Content-Encoding': 'gzip' },
    body: gz.toString('base64'),
    isBase64Encoded: true,
  };
}

// Per-invocation binding of the request's Accept-Encoding, so a handler keeps its existing
// resp(statusCode, body) call sites unchanged and no module-scope mutable state is introduced.
export function jsonResponder(event, headers = {}) {
  const acceptEncoding = readAcceptEncoding(event);
  return (statusCode, body) => jsonResponse(statusCode, body, { acceptEncoding, headers });
}
