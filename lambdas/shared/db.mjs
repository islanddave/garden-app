// Neon database connection + per-query user_id setter
// All Lambdas import from here. Do not open connections elsewhere.

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,            // Lambda concurrency is low; keep pool small
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

/**
 * Run a query with the Clerk user ID injected as a Postgres session variable.
 * Lambda calls this for every authenticated request.
 *
 * The SET LOCAL ensures app.user_id only lives for the current transaction,
 * preventing any cross-request leakage in connection pool scenarios.
 *
 * @param {string} clerkUserId - e.g. "user_2abc123"
 * @param {string} sql - parameterized SQL string
 * @param {Array}  params - query parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function queryAs(clerkUserId, sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.user_id = $1`, [clerkUserId]);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a query with no user context (unauthenticated/public reads).
 * RLS policies must allow this (e.g. is_public = true checks).
 * Do NOT use for any write operation.
 */
export async function queryPublic(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

export { pool };
