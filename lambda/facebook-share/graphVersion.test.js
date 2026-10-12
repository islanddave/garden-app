// The Graph API version is pinned in three places that deploy separately: the Facebook module, the
// Instagram module and the daily token watcher (a shell script on a GitHub runner). Nothing else in
// the suite reds when one moves without the others, or when the env override or the Instagram
// fallback (D8) stops working: every other test builds its URLs from the imported constant.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT = 'v25.0';

async function load(env) {
  vi.resetModules();
  vi.stubEnv('FB_GRAPH_VERSION', env.fb ?? '');
  vi.stubEnv('IG_GRAPH_VERSION', env.ig ?? '');
  const g = await import('./graph.js');
  const i = await import('./instagram.js');
  return { fb: g.GRAPH_VERSION, ig: i.IG_GRAPH_VERSION, feed: g.feedUrl('1'), media: i.igMediaUrl('2') };
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('Graph API version pins', () => {
  it('both modules default to the same supported version', async () => {
    const v = await load({});
    expect(v.fb).toBe(DEFAULT);
    expect(v.ig).toBe(DEFAULT);
    expect(v.feed).toBe(`https://graph.facebook.com/${DEFAULT}/1/feed`);
    expect(v.media).toBe(`https://graph.facebook.com/${DEFAULT}/2/media`);
  });

  it('FB_GRAPH_VERSION moves Facebook, and Instagram follows only while it has no pin of its own', async () => {
    const v = await load({ fb: 'v98.0' });
    expect(v.fb).toBe('v98.0');
    expect(v.ig).toBe('v98.0');
    expect(v.feed).toContain('/v98.0/');
  });

  it('IG_GRAPH_VERSION alone moves Instagram and leaves Facebook on the default', async () => {
    const v = await load({ ig: 'v97.0' });
    expect(v.fb).toBe(DEFAULT);
    expect(v.ig).toBe('v97.0');
    expect(v.media).toContain('/v97.0/');
  });

  it('with both set, each module reads its own', async () => {
    const v = await load({ fb: 'v98.0', ig: 'v97.0' });
    expect(v.fb).toBe('v98.0');
    expect(v.ig).toBe('v97.0');
  });

  it('the token watcher defaults to the same version as the Lambda', () => {
    const sh = readFileSync(join(here, '..', '..', 'scripts', 'meta-token-check.sh'), 'utf8');
    const m = sh.match(/^GRAPH_VERSION="\$\{FB_GRAPH_VERSION:-(v\d+\.\d+)\}"$/m);
    expect(m, 'meta-token-check.sh no longer declares GRAPH_VERSION in the expected form').not.toBeNull();
    expect(m[1]).toBe(DEFAULT);
  });
});
