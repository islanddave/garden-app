// V4-APIGZIP-001 — each Lambda is zipped from its own dir, so http-response.js is copied per-dir and
// imported as ./http-response.js. These copies MUST stay byte-identical to the canonical
// lambda/http-response.js: a drifted copy silently diverges the content negotiation per surface,
// and the failure mode of getting negotiation wrong is a body the client cannot decode.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Staged rollout: plants is the proof case (largest measured payload). Add a dir here in the same
// commit that adds its copy — the enumeration guard below is what makes that non-optional.
const DIRS = ['plants'];

describe('http-response.js per-Lambda copies stay in sync with canonical', () => {
  const canonical = readFileSync(join(here, 'http-response.js'), 'utf8');
  for (const d of DIRS) {
    it(`${d}/http-response.js === canonical lambda/http-response.js`, () => {
      const copy = readFileSync(join(here, d, 'http-response.js'), 'utf8');
      expect(copy).toBe(canonical);
    });
  }

  // Coverage floor, mirroring photo-access-copies-sync.test.js. A hand-maintained DIRS fails OPEN:
  // a dir that starts shipping a copy produces no test at all, and its drift stays invisible in a
  // green suite. Turns red on the mutation `cp lambda/http-response.js lambda/tags/` — a copy in an
  // unlisted dir.
  it('DIRS enumerates EVERY dir that ships an http-response.js copy', () => {
    const onDisk = readdirSync(here, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((d) => existsSync(join(here, d, 'http-response.js')))
      .sort();
    expect(onDisk).toEqual([...DIRS].sort());
  });
});
