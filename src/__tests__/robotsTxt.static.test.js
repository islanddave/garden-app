// Static guard for public/robots.txt.
//
// The defect this prevents is silent by construction: CloudFront on this distribution maps
// 403/404 -> 200 /index.html, so if this file is ever deleted, `GET /robots.txt` goes back to
// returning the SPA shell with HTTP 200 and content-type text/html — which crawlers read as
// "no directives". There is no error, no 404, and nothing in a smoke test that looks wrong.
// Measured on prod before the file existed: 3,162 bytes of text/html, byte-identical to the
// response for a nonexistent path.
//
// Vite copies public/ verbatim into dist/, and deploy.yml syncs dist/ to S3, so the presence of
// this file in public/ is the whole mechanism.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROBOTS = resolve(__dirname, '../../public/robots.txt');

describe('public/robots.txt', () => {
  it('exists — a missing file silently serves the SPA shell as robots.txt', () => {
    expect(existsSync(ROBOTS), 'public/robots.txt is missing; /robots.txt will 200 with HTML').toBe(true);
  });

  it('carries a directive, not just comments', () => {
    // A file of only comments is served correctly and means nothing — the same failure class as
    // a guard that cannot fail. Assert on decommented content.
    const live = readFileSync(ROBOTS, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#') && l.trim())
      .join('\n');
    expect(live).toMatch(/^User-agent:\s*\*/m);
    expect(live).toMatch(/^Disallow:\s*\//m);
  });

  it('disallows the whole host — relaxing this is a deliberate change, not a drive-by', () => {
    const live = readFileSync(ROBOTS, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#') && l.trim())
      .join('\n');
    // If this assertion is what is failing for you: the operator app is intentionally
    // unindexed while gardensatmathews.garden is the public surface. Changing it is fine —
    // change it on purpose, and update the public-site runbook's Phase 3 step at the same time.
    expect(live).not.toMatch(/^Allow:/m);
    expect(live.match(/^Disallow:\s*\/\s*$/m), 'expected a bare `Disallow: /`').toBeTruthy();
  });
});
