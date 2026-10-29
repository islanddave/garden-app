// new-file: no sample-event test existed for photocdn-derivative (internal-invoke only, no Function URL)
// Pins today's replies to the backfill driver's invoke event (OPS-CODEREVIEW-001 C6). sharp and blurhash are
// not installed at the repo root, so both are module mocks here; S3 is mocked in this file (not the shared
// stub) because the reply depends on GetObject's ETag. Trap: DERIVATIVES_BUCKET is read at module load, so
// the unset case re-imports the module.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const h = vi.hoisted(() => ({
  gets: [], puts: [], getFails: false, putFails: false, etag: '"abc123"',
  sharpCalls: [], toBufferFails: false, blurhashFails: false,
}));

vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: class { constructor(input) { this.input = input; this.op = 'get'; } },
  PutObjectCommand: class { constructor(input) { this.input = input; this.op = 'put'; } },
  S3Client: class {
    async send(cmd) {
      if (cmd.op === 'get') {
        h.gets.push(cmd.input);
        if (h.getFails) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { ETag: h.etag, Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
      }
      h.puts.push(cmd.input);
      if (h.putFails) throw new Error('AccessDenied');
      return {};
    }
  },
}));

vi.mock('sharp', () => {
  const chain = (input) => {
    const ops = [];
    h.sharpCalls.push({ input, ops });
    const c = {
      resize: (...a) => { ops.push(['resize', ...a]); return c; },
      webp: (...a) => { ops.push(['webp', ...a]); return c; },
      png: () => { ops.push(['png']); return c; },
      ensureAlpha: () => { ops.push(['ensureAlpha']); return c; },
      raw: () => { ops.push(['raw']); return c; },
      toBuffer: async (opts) => {
        if (opts?.resolveWithObject) {
          if (h.blurhashFails) throw new Error('raster failed');
          return { data: Buffer.alloc(2 * 2 * 4), info: { width: 2, height: 2 } };
        }
        if (h.toBufferFails && ops.some((o) => o[0] === 'webp')) throw new Error('unsupported image format');
        return Buffer.from('WEBPBYTES');
      },
    };
    return c;
  };
  chain.format = { heif: { input: { buffer: true } } };
  chain.versions = { vips: '8.stub' };
  return { default: chain };
});

vi.mock('blurhash', () => ({ encode: vi.fn(() => 'LBHASH') }));

process.env.DERIVATIVES_BUCKET = 'garden-photo-derivatives-test';
const { handler } = await import('./index.mjs');

const invoke = (rawPath) => handler({ rawPath });
const KEY = 'plants/p1/IMG 1.jpg';
const THUMB = `/d/thumb/abc123/${encodeURIComponent(KEY)}.webp`;

beforeEach(() => {
  Object.assign(h, { gets: [], puts: [], getFails: false, putFails: false, etag: '"abc123"',
    sharpCalls: [], toBufferFails: false, blurhashFails: false });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { delete process.env.DERIVATIVES_BUCKET; });

describe('photocdn-derivative — invoke events', () => {
  it('self-test path answers the health probe JSON', async () => {
    const r = await invoke('/d/__selftest__');
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(r.body)).toEqual({
      sharp_ok: true, blurhash_ok: true, heif_input: true, vips: '8.stub', arch: process.arch,
    });
    expect(h.gets).toEqual([]);
  });

  it.each([
    ['/d/full/abc123/plants/a.jpg.webp'],
    ['/d/thumb/not-hex!/plants/a.jpg.webp'],
    ['/d/thumb/abc123/plants/a.jpg'],
    ['/o/plants/a.jpg'],
    [''],
  ])('%j -> 404 Not found, S3 untouched', async (path) => {
    const r = await invoke(path);
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'Not found' });
    expect(h.gets).toEqual([]);
  });

  it('a key that climbs with .. is refused before S3', async () => {
    const r = await invoke('/d/thumb/abc123/plants/../secrets/a.jpg.webp');
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'Not found' });
    expect(h.gets).toEqual([]);
  });

  it('a missing original -> 404 Original not found', async () => {
    h.getFails = true;
    const r = await invoke(THUMB);
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'Original not found' });
    expect(h.puts).toEqual([]);
  });

  it('thumb, current etag: reads the decoded key, persists, replies base64 webp with the blurhash', async () => {
    const r = await invoke(THUMB);
    expect(h.gets).toEqual([{ Bucket: 'garden-photos-prod', Key: KEY }]);
    expect(h.sharpCalls[0].ops).toEqual([['resize', 96, 96, { fit: 'cover' }], ['webp', { quality: 70 }]]);
    expect(h.puts).toEqual([{
      Bucket: 'garden-photo-derivatives-test', Key: THUMB.slice(1), Body: Buffer.from('WEBPBYTES'),
      ContentType: 'image/webp', CacheControl: 'public, max-age=31536000, immutable',
    }]);
    expect(r).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable', 'x-blurhash': 'LBHASH' },
      body: Buffer.from('WEBPBYTES').toString('base64'),
      isBase64Encoded: true,
    });
  });

  it('card: width-480 resize, no blurhash header', async () => {
    const r = await invoke(`/d/card/abc123/${KEY}.webp`);
    expect(h.sharpCalls[0].ops).toEqual([['resize', { width: 480, withoutEnlargement: true }], ['webp', { quality: 75 }]]);
    expect(h.sharpCalls).toHaveLength(1);
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual({ 'content-type': 'image/webp', 'cache-control': 'public, max-age=31536000, immutable' });
    expect(h.puts).toHaveLength(1);
  });

  it('stale etag: serves from the current original, writes nothing, no-store', async () => {
    h.etag = '"fff999"';
    const r = await invoke(THUMB);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(h.puts).toEqual([]);
  });

  it('a multipart etag (-N suffix) matches verbatim', async () => {
    h.etag = '"abc123-2"';
    const r = await invoke(`/d/thumb/abc123-2/${KEY}.webp`);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(h.puts).toHaveLength(1);
  });

  it('a generation failure -> 500 Generation failed, nothing persisted', async () => {
    h.toBufferFails = true;
    const r = await invoke(THUMB);
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: 'Generation failed' });
    expect(h.puts).toEqual([]);
  });

  it('a blurhash failure is non-fatal: 200 without the header', async () => {
    h.blurhashFails = true;
    const r = await invoke(THUMB);
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-blurhash']).toBeUndefined();
    expect(h.puts).toHaveLength(1);
  });

  it('a persist failure still serves the derivative', async () => {
    h.putFails = true;
    const r = await invoke(THUMB);
    expect(r.statusCode).toBe(200);
    expect(r.isBase64Encoded).toBe(true);
  });

  it('with DERIVATIVES_BUCKET unset at load, nothing is persisted even on a current etag', async () => {
    delete process.env.DERIVATIVES_BUCKET;
    vi.resetModules();
    const fresh = await import('./index.mjs');
    const r = await fresh.handler({ rawPath: THUMB });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(h.puts).toEqual([]);
  });
});
