// http-response.js — V4-APIGZIP-001 shared JSON responder with negotiated gzip.
//
// Lambda Function URLs do NOT compress for you: nothing on the Function-URL path sets a
// Content-Encoding, so a large JSON body goes out identity unless the handler gzips it.
//
// The Function-URL contract for a compressed body is exact and unforgiving: `body` must be a
// BASE64 STRING with isBase64Encoded: true. The service base64-decodes it and puts the raw bytes on
// the wire with its own Content-Length. Returning the gzip Buffer directly instead would be
// JSON-serialized by the runtime into {"type":"Buffer","data":[...]} and shipped as that literal.
//
// DEPLOY NOTE (mirrors household.js / photo-access.js): a Lambda zip holds only its own dir, so a
// `../http-response.js` import 502s at module load. An IDENTICAL copy lives in each adopting Lambda dir,
// imported as `./http-response.js`, held byte-identical by lambda/http-response-copies-sync.test.js.
//
// node:zlib ONLY — no new runtime dependency; cold-start weight is not free.
import { gzipSync } from 'node:zlib';

// Below this many UTF-8 bytes the response is sent identity:
//   · gzip INFLATES the small JSON this API returns ({"error":"Unauthorized"} is 24 B in, 44 B out),
//     and every error path is in that class.
//   · a sub-1 KB body saves less than one TCP segment, so it cannot remove a round trip.
//   · it keeps every error/no-content path on the uncompressed code path, which bounds the blast radius.
// Overridable per call (see minBytes) — the rollout tunes per route.
export const MIN_GZIP_BYTES = 1024;

// zlib's default. The size/CPU knee is L4–L6 and L9 buys little more for +28% CPU. Drop to L4 if
// CloudWatch Duration ever says this matters.
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

// OPS-GZIPHEADERPROOF-001 — the negotiation outcome, as ONE structured CloudWatch line per invocation.
// No other route can show whether gzip took effect:
//   - An UNAUTHENTICATED probe sees a 401 body far under MIN_GZIP_BYTES, which is identity by design.
//   - The BROWSER cannot show it: the PWA's Service Worker intercepts every request, so
//     PerformanceResourceTiming reports a 1.00 ratio whatever was sent.
//   - The design FAILS SAFE, so an inert deploy and a working one look identical from outside.
// `ae` is the raw Accept-Encoding, a transport preference with nothing user-identifying; it is truncated
// so a long junk header cannot inflate log spend.
function logNegotiation(acceptEncoding, encoded) {
  try {
    console.log(JSON.stringify({
      tag: 'api-gzip',
      gzip: encoded,
      ae: String(acceptEncoding).slice(0, 64),
    }));
  } catch { /* logging must never be able to fail a response */ }
}

// Per-invocation binding of the request's Accept-Encoding, so a handler keeps its existing
// resp(statusCode, body) call sites unchanged and no module-scope mutable state is introduced.
export function jsonResponder(event, headers = {}) {
  const acceptEncoding = readAcceptEncoding(event);
  return (statusCode, body) => {
    const res = jsonResponse(statusCode, body, { acceptEncoding, headers });
    // Read the OUTCOME off the response rather than re-deriving it: re-running acceptsGzip here
    // would log what the negotiation SHOULD have done, which is exactly the class of claim this
    // line exists to stop trusting. isBase64Encoded is set only on the gzip branch.
    logNegotiation(acceptEncoding, res.isBase64Encoded === true);
    return res;
  };
}
