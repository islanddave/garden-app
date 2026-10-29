// new-file: new subject, lambda/rate-limit.js
// SEC-13b (OPS-SECREVIEW-001): the checkRateLimit master, and the request limits that call it in one it.each table.
// Trap: the stub never evaluates SQL, so the atomic count is proven on real Postgres in
// tests/integration/app-events.int.test.js (parallel boundary) and photos-intake.int.test.js (per-object cost).
import { describe, it, expect } from 'vitest';
import { checkRateLimit, GLOBAL_ACTOR, retryAfterSeconds, withRetryAfter } from './rate-limit.js';

function fakeSql(answer = () => [{ count: 1 }]) {
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ text: strings.join('?'), values });
    return answer();
  };
  sql.calls = calls;
  return sql;
}

describe('checkRateLimit (master)', () => {
  it.each([[''], [undefined], [null], [42]])('SEC-13b S2: actor %j is refused without a statement', async (actor) => {
    const sql = fakeSql();
    expect(await checkRateLimit(sql, actor, 'k.write', 10)).toBe(false);
    expect(sql.calls).toHaveLength(0);
  });

  it('SEC-13b: a cost larger than the limit is refused without a statement', async () => {
    const sql = fakeSql();
    expect(await checkRateLimit(sql, 'user_a', 'k.write', 4, 5)).toBe(false);
    expect(sql.calls).toHaveLength(0);
  });

  it.each([[0, 1], [1, 0], [1.5, 1], [5, -1], ['5', 1]])('limit %j with cost %j is a programming error (TypeError)', async (limit, cost) => {
    await expect(checkRateLimit(fakeSql(), 'user_a', 'k.write', limit, cost)).rejects.toThrow(TypeError);
  });

  it('a multi-object spend runs one upsert that adds the whole cost or nothing', async () => {
    const sql = fakeSql();
    expect(await checkRateLimit(sql, 'user_a', 'photos.upload', 2500, 3)).toBe(true);
    expect(sql.calls).toHaveLength(1);
    const [{ text, values }] = sql.calls;
    expect(text).toContain('INSERT INTO public.rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)');
    expect(text).toContain('ON CONFLICT (actor_clerk_sub, bucket_key, window_start)');
    expect(text).toContain('DO UPDATE SET count = public.rate_limit_buckets.count + EXCLUDED.count');
    expect(text).toContain('WHERE public.rate_limit_buckets.count + EXCLUDED.count <= ?');
    expect(values).toEqual(['user_a', 'photos.upload', 3, 2500]);
  });

  it('cost defaults to 1 and sends the single-unit upsert, binding [actor, key, limit]', async () => {
    const sql = fakeSql();
    await checkRateLimit(sql, 'user_a', 'tag.create', 60);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain('WHERE public.rate_limit_buckets.count < ?');
    expect(sql.calls[0].values).toEqual(['user_a', 'tag.create', 60]);
  });

  it('a returned row allows; no row (the guard refused the update) denies', async () => {
    expect(await checkRateLimit(fakeSql(() => [{ count: 7 }]), 'user_a', 'k', 10)).toBe(true);
    expect(await checkRateLimit(fakeSql(() => []), 'user_a', 'k', 10)).toBe(false);
  });

  it('a database error reaches the caller (each caller picks its fail mode)', async () => {
    const boom = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    await expect(checkRateLimit(fakeSql(() => { throw boom; }), 'user_a', 'k', 10)).rejects.toBe(boom);
  });

  it('the shared-bucket actor can never be a Clerk user id', () => {
    expect(GLOBAL_ACTOR).not.toMatch(/^user_/);
    expect(GLOBAL_ACTOR.length).toBeGreaterThan(0);
  });
});

describe('Retry-After', () => {
  const H = 3600 * 1000;
  it.each([
    [Date.UTC(2026, 9, 29, 19, 0, 0), 3600],
    [Date.UTC(2026, 9, 29, 19, 59, 59), 1],
    [Date.UTC(2026, 9, 29, 19, 30, 0) + 500, 1800],
  ])('retryAfterSeconds(%j) = %j (to the next hour window)', (now, secs) => {
    expect(retryAfterSeconds(now)).toBe(secs);
  });

  it('withRetryAfter adds the header and keeps status, body and the other headers', () => {
    const res = { statusCode: 429, headers: { 'Content-Type': 'application/json' }, body: '{"error":"x"}' };
    expect(withRetryAfter(res, 12)).toEqual({ ...res, headers: { 'Content-Type': 'application/json', 'Retry-After': '12' } });
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' });
    const secs = Number(withRetryAfter(res).headers['Retry-After']);
    expect(secs).toBeGreaterThanOrEqual(1);
    expect(secs).toBeLessThanOrEqual(H / 1000);
  });
});
