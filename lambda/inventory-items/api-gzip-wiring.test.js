// V5-SEEDCARDS-001 — /api/inventory-items adopts the negotiated-gzip responder (V4-APIGZIP-001).
// The seed list grew a packet photo per row (a presigned view + thumb URL each, ~1.3 KB apiece with
// the Lambda's session token), so on ~330 seed rows the identity body roughly doubles. Gzip is what
// keeps that off the phone's wire: the repeated token and field names compress away. Mirrors
// lambda/plants/api-gzip-wiring.test.js; the responder's own behaviour is pinned in
// lambda/http-response.test.js and the per-dir copy's bytes in http-response-copies-sync.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const decomment = (s) => s.split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)--\s.*$/, '$1'))
  .join('\n');

const SRC = decomment(readFileSync(resolve(__dirname, 'index.js'), 'utf8'));

describe('/api/inventory-items responds through the shared negotiated-gzip responder', () => {
  it('imports jsonResponder from ./http-response.js — the per-dir copy, never ../', () => {
    expect(SRC).toMatch(/import \{ jsonResponder \} from '\.\/http-response\.js';/);
    expect(SRC).not.toMatch(/from '\.\.\/http-response\.js'/);
  });

  it('binds resp per invocation from the event, so Accept-Encoding is THIS request\'s', () => {
    expect(SRC).toMatch(/const resp = jsonResponder\(event, CORS\);/);
  });

  it('no module-level resp() survives to bypass negotiation', () => {
    expect(SRC).not.toMatch(/^function resp\(/m);
    expect(SRC).not.toMatch(/body: JSON\.stringify\(body\)/);
  });

  it('the list GET — the payload this exists for — returns through resp', () => {
    expect(SRC).toMatch(/return resp\(200, listRows\);/);
  });

  it('resp is bound inside the handler before its first use, including the OPTIONS short-circuit', () => {
    // The first use is searched from the START of the handler, not from the binding: searching after
    // the binding can never find a use that comes before it (a binding moved below the auth block
    // passes that way while every 401 path throws in the temporal dead zone — QA mutant L15).
    const handlerAt = SRC.indexOf('export const handler');
    const bind = SRC.indexOf('const resp = jsonResponder(event, CORS);');
    const use = /\bresp\(/g;
    use.lastIndex = handlerAt;
    const firstUse = use.exec(SRC)?.index ?? -1;
    expect(bind, 'jsonResponder binding must exist').toBeGreaterThan(-1);
    expect(firstUse, 'the handler never calls resp(').toBeGreaterThan(-1);
    expect(bind).toBeLessThan(firstUse);
    expect(bind).toBeGreaterThan(handlerAt);
  });
});
