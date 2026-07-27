// BUG-PHOTOUPLOADHANG-001 — putWithProgress: the stall watchdog is the whole point. A PUT whose
// bytes stop moving must FAIL (the old bare fetch sat on a dead socket forever); a PUT whose
// bytes keep moving must be left alone no matter how slow.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { putWithProgress, PUT_STALL_MS, PUT_MAX_MS } from '../lib/uploadPut.js';

class FakeXHR {
  static instances = [];
  constructor() {
    FakeXHR.instances.push(this);
    this.status = 0;
    this.aborted = false;
    this.headers = {};
    this._l = {};
    this._ul = {};
    this.upload = {
      addEventListener: (ev, fn) => { (this._ul[ev] ||= []).push(fn); },
    };
  }
  addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send(body) { this.body = body; }
  abort() { this.aborted = true; (this._l.abort || []).forEach(f => f({})); }
  fireProgress(loaded, total) { (this._ul.progress || []).forEach(f => f({ lengthComputable: true, loaded, total })); }
  fireLoad(status) { this.status = status; (this._l.load || []).forEach(f => f({})); }
  fireError() { (this._l.error || []).forEach(f => f({})); }
}

beforeEach(() => { FakeXHR.instances = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const opts = (extra = {}) => ({ XHR: FakeXHR, ...extra });

describe('putWithProgress (BUG-PHOTOUPLOADHANG-001)', () => {
  it('resolves on 2xx and sends method/headers/body correctly', async () => {
    const p = putWithProgress('https://s3/u', 'BODY', 'image/jpeg', opts());
    const xhr = FakeXHR.instances[0];
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://s3/u');
    expect(xhr.headers['Content-Type']).toBe('image/jpeg');
    expect(xhr.body).toBe('BODY');
    xhr.fireLoad(200);
    await expect(p).resolves.toEqual({ ok: true, status: 200 });
  });

  it('rejects on non-2xx status', async () => {
    const p = putWithProgress('https://s3/u', 'B', 'image/jpeg', opts());
    FakeXHR.instances[0].fireLoad(403);
    await expect(p).rejects.toThrow(/403/);
  });

  it('rejects on network error', async () => {
    const p = putWithProgress('https://s3/u', 'B', 'image/jpeg', opts());
    FakeXHR.instances[0].fireError();
    await expect(p).rejects.toThrow(/network error/);
  });

  it('STALL: no progress for PUT_STALL_MS aborts with a stall error', async () => {
    const p = putWithProgress('https://s3/u', 'B', 'image/jpeg', opts());
    vi.advanceTimersByTime(PUT_STALL_MS + 10);
    await expect(p).rejects.toThrow(/stalled/i);
    expect(FakeXHR.instances[0].aborted).toBe(true);
  });

  it('progress RESETS the stall watchdog — a slow-but-moving upload survives past PUT_STALL_MS', async () => {
    const p = putWithProgress('https://s3/u', 'B', 'image/jpeg', opts());
    const xhr = FakeXHR.instances[0];
    // keep bytes moving every 20s for 2 minutes — well past a single stall window
    for (let i = 1; i <= 6; i++) {
      vi.advanceTimersByTime(20_000);
      xhr.fireProgress(i * 10, 100);
    }
    expect(xhr.aborted).toBe(false);
    xhr.fireLoad(200);
    await expect(p).resolves.toEqual({ ok: true, status: 200 });
  });

  it('CEILING: even a moving upload cannot exceed PUT_MAX_MS', async () => {
    const p = putWithProgress('https://s3/u', 'B', 'image/jpeg', opts());
    const xhr = FakeXHR.instances[0];
    const steps = Math.ceil(PUT_MAX_MS / 20_000) + 1;
    let rejected = null;
    p.catch((e) => { rejected = e; });
    for (let i = 1; i <= steps; i++) {
      vi.advanceTimersByTime(20_000);
      xhr.fireProgress(i, steps + 1);
      await Promise.resolve();
    }
    expect(rejected).toBeTruthy();
    expect(String(rejected.message)).toMatch(/timed out/i);
    expect(xhr.aborted).toBe(true);
  });

  it('reports integer percentages via onProgress', async () => {
    const seen = [];
    const p = putWithProgress('https://s3/u', 'B', 'image/jpeg', opts({ onProgress: (n) => seen.push(n) }));
    const xhr = FakeXHR.instances[0];
    xhr.fireProgress(333, 1000);
    xhr.fireProgress(1000, 1000);
    xhr.fireLoad(200);
    await p;
    expect(seen).toEqual([33, 100]);
  });

  it('late events after settle are inert (no double-settle, no throw)', async () => {
    const p = putWithProgress('https://s3/u', 'B', 'image/jpeg', opts());
    const xhr = FakeXHR.instances[0];
    xhr.fireLoad(200);
    await p;
    expect(() => { xhr.fireError(); xhr.fireProgress(1, 2); xhr.abort(); }).not.toThrow();
  });
});
