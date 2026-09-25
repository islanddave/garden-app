// BUG-DAILYPLANCONNDROP-001 — an IDLE pool client losing its connection must not kill the run.
//
// THE DEFECT. garden-daily-plan died with `Uncaught Exception: Connection terminated unexpectedly` on
// 2026-09-19 21:00Z (65a0baa2) and 2026-09-20 12:00Z (f589d9ef), ~0.7 s after anchor-rederive-sweep, while
// the run sat between queries (the next thing a healthy run logs is station-fetched, ~4.5 s later). Neon
// closed the pooler WebSocket (code 1000); the bundled pg Client turned that into an error; pg-pool's
// idleListener stamped `err.client`, discarded the client (client.end() -> the `_ending:true` in the log)
// and re-emitted it as `pool.emit('error', err, client)`. index.js attached no 'error' listener to the pool,
// and EventEmitter.emit('error') with no listener THROWS — from a socket callback, so nothing could catch
// it and the runtime ended the invocation (Runtime.ExitError). Lambda's async retry re-ran it both times.
//
// THE INSTRUMENT. index.js cannot be imported here (it requires the AWS SDK and the neon driver at load;
// they live only in this Lambda's own package.json — see openmeteo-indices.test.js), so the REAL
// `exports.handler` source is compiled with its collaborators injected, the method
// fetchprecip-errorbody.test.js established. The pool is a bare EventEmitter ON PURPOSE: the property under
// test is exactly EventEmitter's — a pool 'error' with no listener throws, with one it does not.
// What this does NOT prove: that the driver reconnects afterwards (there is no driver here). That was
// reproduced locally against the real bundled driver (@neondatabase/serverless 0.10.4 + ws, a local
// wire-protocol server closing the idle connection with 1000): base index.js -> the same stack frames as
// prod and the same client state; fixed index.js -> one db-pool-idle-error line and the next query on a
// fresh connection. See the lane findings, lane-dailyplanconn-20260921.
//
// MUTATIONS (each verified RED, then restored byte-for-byte to GREEN):
//   M1 delete the pool.on('error', …) statement                   -> 'survives …' + 'logs … only' RED
//   M2 add `client: err.client` to the logged object              -> 'survives …' + 'logs … only' RED
//   M2b append the client's connectionString to `error` (same keys) -> 'logs … only' RED on the password check
//   M3 `throw e;` -> `return { ok: false, today, dryRun };`       -> 'still fails the invocation' RED
//   M4 attach the listener only after `await run(...)`            -> 'survives …' + 'logs … only' RED
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import h from './handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// Cut at the handler's own closing `};` at column 0. Checked (anchor + ceiling below) so a refactor fails
// LOUDLY here instead of compiling something vacuous.
const HANDLER = (() => {
  const start = SRC.indexOf('exports.handler = async (event) => {');
  if (start < 0) throw new Error('exports.handler not found in index.js');
  const tail = SRC.slice(start);
  const end = tail.indexOf('\n};\n');
  if (end < 0) throw new Error('exports.handler closing brace not found');
  return tail.slice(0, end + 4);
})();

const PW = 'npg_UNITTESTPASSWORD';
const DSN = `postgresql://neondb_owner:${PW}@ep-unit-test-pooler.example.invalid/neondb?sslmode=require`;

function harness(runImpl) {
  const pools = [];
  class FakePool extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.endCalls = 0; pools.push(this); }
    async end() { this.endCalls++; }
  }
  const out = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = vi.fn(runImpl);
  const compiled = new Function(
    'Pool', 'getSecrets', 'run', 'resolveInvokeOptions', 'todayET', 'hourET',
    'geocodeZip', 'fetchNWS', 'fetchPrecip', 'fetchRainForecast', 'fetchStation', 'publishAlert', 'console', 'process',
    `const exports = {};\n${HANDLER}\nreturn exports.handler;`,
  );
  const handler = compiled(
    FakePool, async () => ({ NEON_DATABASE_URL: DSN }), run, h.resolveInvokeOptions,
    () => '2026-09-19', () => 17, null, null, null, null, null, null, out, { env: { DRY_RUN: 'false' } },
  );
  return { handler, pools, out, run };
}

// What pg-pool's idleListener hands the pool's 'error' listeners: the Error, carrying the discarded client,
// whose config holds the DSN — the object the runtime serialised into CloudWatch both times.
const idleDrop = () => {
  const client = { _ending: true, _queryable: false, config: { connectionString: DSN } };
  return [Object.assign(new Error('Connection terminated unexpectedly'), { client }), client];
};
const allOutput = (out) => [...out.log.mock.calls, ...out.warn.mock.calls, ...out.error.mock.calls]
  .map((c) => c.map(String).join(' '));

describe('daily-plan handler: an idle pool client losing its connection (BUG-DAILYPLANCONNDROP-001)', () => {
  it('compiles the real handler (anchor + size ceiling)', () => {
    expect(HANDLER).toContain('new Pool({ connectionString: NEON_DATABASE_URL })');
    expect(HANDLER).toContain('await pool.end()');
    expect(HANDLER).toContain('await run(');
    expect(HANDLER.length).toBeLessThan(6000);
  });

  it('survives an idle drop while run() is between queries, logs it once, and the run completes', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { handler, pools, out, run } = harness(async () => { await gate; return { rows: 2, plans: [] }; });
    const p = handler({});
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(pools).toHaveLength(1);
    const pool = pools[0];
    expect(run.mock.calls[0][0].pg).toBe(pool);
    // The production failure, emitted from OUTSIDE run()'s call stack exactly as the socket callback did.
    expect(() => pool.emit('error', ...idleDrop())).not.toThrow();
    release();
    await expect(p).resolves.toEqual({ ok: true, today: '2026-09-19', dryRun: false, rows: 2 });
    expect(pool.endCalls).toBe(1);
    const warned = out.warn.mock.calls.map(([l]) => JSON.parse(l));
    expect(warned).toEqual([{ msg: 'db-pool-idle-error', error: 'Connection terminated unexpectedly', code: null, ms: expect.any(Number) }]);
    expect(out.error).not.toHaveBeenCalled();
  });

  it('logs the message and code only — never the client, whose config holds the DSN password', async () => {
    const { handler, out } = harness(async ({ pg }) => {
      const [err, client] = idleDrop();
      err.code = '57P01';
      pg.emit('error', err, client);
      return { rows: 0, plans: [] };
    });
    await expect(handler({})).resolves.toMatchObject({ ok: true, rows: 0 });
    expect(out.warn).toHaveBeenCalledTimes(1);
    const line = out.warn.mock.calls[0][0];
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(['code', 'error', 'ms', 'msg']);
    expect(JSON.parse(line)).toMatchObject({ msg: 'db-pool-idle-error', code: '57P01' });
    for (const text of allOutput(out)) {
      expect(text).not.toContain(PW);
      expect(text).not.toContain('connectionString');
    }
  });

  it('a query that fails still fails the invocation, so the async retry and garden-daily-plan-errors still fire', async () => {
    const { handler, pools, out } = harness(async ({ pg }) => {
      pg.emit('error', ...idleDrop());                          // the idle client dropped …
      throw new Error('Connection terminated unexpectedly');   // … and the next query failed as well
    });
    await expect(handler({})).rejects.toThrow('Connection terminated unexpectedly');
    expect(pools[0].endCalls).toBe(1);
    const errored = out.error.mock.calls.map(([l]) => JSON.parse(l));
    expect(errored).toEqual([{ msg: 'daily-plan ERROR', today: '2026-09-19', dryRun: false, error: 'Connection terminated unexpectedly' }]);
  });
});
