// Hourly buckets in public.rate_limit_buckets. Canonical; byte copies are listed in scripts/lambda-copies.json
// (node scripts/gen-lambda-copies.mjs --check). Tests: lambda/rate-limit.test.js; the atomic count on real
// Postgres: tests/integration/app-events.int.test.js and photos-intake.int.test.js.

// A Clerk user id is always user_…, so a shared bucket can never collide with a person's.
export const GLOBAL_ACTOR = '__global__';

// One statement either way, so it is atomic: concurrent calls serialize on the bucket row and none can push count
// past limit (a SELECT-then-INSERT could). Spends `cost` units or none; a request that does not fit leaves the
// count unchanged. A missing or empty actor is refused without a statement, so losing the sub never shares or skips
// a bucket. Throws on a database error: each caller decides how it fails.
// cost 1 sends the statement every caller always has, binding [actor, key, limit] (varieties source-routes and
// blend-route tests pin those values); only a multi-object spend uses the EXCLUDED.count form.
export async function checkRateLimit(sql, actor, bucketKey, limit, cost = 1) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(cost) || cost < 1) {
    throw new TypeError(`checkRateLimit: limit and cost must be positive integers (${limit}, ${cost})`);
  }
  if (typeof actor !== 'string' || actor === '' || cost > limit) return false;
  const rows = cost === 1
    ? await sql`
    INSERT INTO public.rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)
    VALUES (${actor}, ${bucketKey}, date_trunc('hour', NOW()), 1)
    ON CONFLICT (actor_clerk_sub, bucket_key, window_start)
    DO UPDATE SET count = public.rate_limit_buckets.count + 1
    WHERE public.rate_limit_buckets.count < ${limit}
    RETURNING count
  `
    : await sql`
    INSERT INTO public.rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)
    VALUES (${actor}, ${bucketKey}, date_trunc('hour', NOW()), ${cost})
    ON CONFLICT (actor_clerk_sub, bucket_key, window_start)
    DO UPDATE SET count = public.rate_limit_buckets.count + EXCLUDED.count
    WHERE public.rate_limit_buckets.count + EXCLUDED.count <= ${limit}
    RETURNING count
  `;
  return rows.length > 0;
}

// Seconds until the current window closes (window_start is date_trunc('hour', NOW()); Neon runs in UTC). 1..3600.
export function retryAfterSeconds(now = Date.now()) {
  return 3600 - (Math.floor(now / 1000) % 3600);
}

// Adds Retry-After to any handler's { statusCode, headers, body } response.
export function withRetryAfter(res, seconds = retryAfterSeconds()) {
  return { ...res, headers: { ...res.headers, 'Retry-After': String(seconds) } };
}
