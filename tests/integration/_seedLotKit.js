// tests/integration/_seedLotKit.js — what the seed-lot and named-mix integration files of release 2a
// (V5-VARIETYBLEND-001, V5-SEEDMULTIPARENT-001 2a) share. Not a test file: nothing here asserts.
//
// TWO THINGS.
//
// 1. THE VARIETY FIXTURE the parent rules read. A rule about a jar's parents is a rule about their
//    VARIETIES — which crop each is recorded under, whether it is itself a mix, whether it is still
//    live — so every file that drives those rules needs the same small catalogue: two crops, three
//    cultivars of the first (two make a mix, the third joins a mix of a mix), one of the second, two
//    with no crop recorded (NULL is one value of its own), and one soft-deleted (it still counts as a
//    planting's variety). seedVarietyFixture() writes it under a caller's run id, so the global sweep
//    in _cleanup.js reaches every row by the `int-test-` marker in created_by, name or slug.
//
// 2. A SECOND REAL SESSION. The handlers reach Neon over HTTP, one request per statement or per
//    transaction, so a test cannot hold one of their transactions open — but psql can hold a row, and
//    pg_blocking_pids() then shows the handler's statement stuck behind it. Nothing sleeps and hopes.
//    twoSessions() is seed-lot-parents.int.test.js's own harness (release 1, lane T1), lifted so the
//    new files do not each carry a copy; that file keeps the original and is not refactored here.
//    Read its header for why a request that is meant to WAIT must go out through onOwnConnection():
//    on Node 22+ every HTTP query a process sends shares one connection to Neon, and a stuck handler
//    request would stall the very poll that is watching it.
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, spawnSync } from 'node:child_process'
import https from 'node:https'
import { neonConfig } from '@neondatabase/serverless'
import { directSql } from './_harness.js'

export const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

// The ONE way an id reaches psql's SQL text (psql has no parameters on stdin).
export const lit = (id) => {
  if (!UUID_RE.test(String(id))) throw new Error(`refusing to put "${id}" into SQL text: not a uuid`)
  return `'${id}'::uuid`
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// 1. The variety fixture
// ───────────────────────────────────────────────────────────────────────────────────────────────────
export const varietyName = (tag, key, run) => `${tag}-variety-${key}-${run}`

// crop: which of the fixture's two crops, or null for "no crop recorded".
export const VARIETY_SHAPES = Object.freeze({
  a1: { crop: 'a', rank: 'cultivar', breeding_system: 'landrace', breeding_source: 'grower_record' },
  a2: { crop: 'a', rank: 'cultivar' },
  a3: { crop: 'a', rank: 'cultivar' },
  b: { crop: 'b', rank: 'cultivar' },
  n1: { crop: null, rank: null },
  n2: { crop: null, rank: null },
  gone: { crop: 'a', rank: 'cultivar', deleted: true },
})

/**
 * Two crops and the seven varieties above, created by `user`.
 * Returns { crops: {a, b}, v: {key: id}, names: {key: name}, facts(key) } — facts(key) is the five
 * variety keys of a source_plants element for a planting of that variety, or all-null for facts(null).
 */
export async function seedVarietyFixture({ run, user, tag }) {
  const crops = { a: `${tag}-crop-a-${run}`, b: `${tag}-crop-b-${run}` }
  for (const [k, slug] of Object.entries(crops)) {
    // eslint-disable-next-line no-await-in-loop
    await directSql`
      INSERT INTO crop_types (slug, display_name, default_unit)
      VALUES (${slug}, ${`${tag} crop ${k} ${run}`}, 'count')`
  }
  const v = {}
  const names = {}
  for (const [key, shape] of Object.entries(VARIETY_SHAPES)) {
    names[key] = varietyName(tag, key, run)
    // eslint-disable-next-line no-await-in-loop
    const [row] = await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug, variety_rank,
                                   breeding_system, breeding_source, deleted_at)
      VALUES (${names[key]}, ${user}, ${shape.crop ? crops[shape.crop] : null}, ${shape.rank ?? null},
              ${shape.breeding_system ?? null}, ${shape.breeding_source ?? null},
              CASE WHEN ${shape.deleted === true}::boolean THEN now() END)
      RETURNING id`
    v[key] = row.id
  }
  const facts = (key) => {
    if (key == null) {
      return { variety_id: null, variety_name: null, breeding_system: null, variety_rank: null, crop_slug: null }
    }
    const shape = VARIETY_SHAPES[key]
    return {
      variety_id: v[key],
      variety_name: names[key],
      breeding_system: shape.breeding_system ?? null,
      variety_rank: shape.rank ?? null,
      crop_slug: shape.crop ? crops[shape.crop] : null,
    }
  }
  return { crops, v, names, facts }
}

/**
 * Teardown thunks for everything a seed-lot / mix file can leave under `ids` (testRunId() users the
 * caller has already put through assertFixtureId), children first. Hand them to settle(): each is
 * attempted whatever the one before it did, and the global sweep takes what is left.
 *
 * The orders that matter, all RESTRICT: a link row before its lot and its planting; a component row
 * before both of its varieties; an entity_tag row before its variety (the BEFORE DELETE guard raises
 * 23503 otherwise — a mix is tagged by the varieties Lambda's post-commit derive).
 * care_profile has no key to its variety, so nothing forces it; it is removed so a fork is not left
 * with a profile row for a mix that no longer exists.
 */
export function seedMixTeardown(ids, crops = {}) {
  const slugs = Object.values(crops)
  return [
    () => directSql`
      DELETE FROM seed_lot_parent_planting
       WHERE created_by = ANY(${ids})
          OR inventory_item_id IN (SELECT id FROM inventory_items WHERE created_by = ANY(${ids}))
          OR plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM xp_events WHERE user_id = ANY(${ids})`,
    () => directSql`DELETE FROM user_stats WHERE user_id = ANY(${ids})`,
    () => directSql`DELETE FROM critter_state WHERE created_by = ANY(${ids}) OR plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM event_log WHERE created_by = ANY(${ids}) OR plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM inventory_items WHERE created_by = ANY(${ids})`,
    () => directSql`DELETE FROM entity WHERE planting_ref_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM plants WHERE created_by = ANY(${ids})`,
    () => directSql`
      DELETE FROM variety_blend_component
       WHERE created_by = ANY(${ids})
          OR blend_variety_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${ids}))
          OR component_variety_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${ids}))`,
    () => directSql`
      DELETE FROM care_profile
       WHERE scope = 'cultivar'
         AND scope_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM entity_tag WHERE entity_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM entity WHERE cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ANY(${ids}))`,
    () => directSql`DELETE FROM plant_varieties WHERE created_by = ANY(${ids})`,
    () => (slugs.length ? directSql`DELETE FROM crop_types WHERE slug = ANY(${slugs})` : Promise.resolve()),
    () => directSql`DELETE FROM audit_events WHERE actor_clerk_sub = ANY(${ids})`,
    () => directSql`DELETE FROM rate_limit_buckets WHERE actor_clerk_sub = ANY(${ids})`,
    () => directSql`DELETE FROM event_batches WHERE created_by = ANY(${ids})`,
  ]
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Two real connections
// ───────────────────────────────────────────────────────────────────────────────────────────────────
export const HAS_PSQL = spawnSync('psql', ['--version'], { encoding: 'utf8' }).status === 0

// The connection is handed to psql through PG* variables: never on its command line, never printed.
function pgEnv() {
  const u = new URL(process.env.INT_DATABASE_URL)
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ''),
    PGSSLMODE: u.searchParams.get('sslmode') ?? 'require',
    PGCONNECT_TIMEOUT: '20',
  }
  const binding = u.searchParams.get('channel_binding')
  if (binding) env.PGCHANNELBINDING = binding
  return env
}

function viaAgent(agent, target, init) {
  return new Promise((resolve, reject) => {
    const t = new URL(target)
    const req = https.request({
      host: t.hostname, port: t.port || 443, path: `${t.pathname}${t.search}`,
      method: init.method, headers: init.headers, agent,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

/**
 * One per test FILE (it installs the driver's fetch hook for that file's worker). Call closeAll() in
 * afterAll.
 *   openSession(label)        a psql child = one session = one transaction the test controls.
 *                             run(sql) returns when psql has finished the statements; pid(); end(finalSql).
 *   onOwnConnection(request)  run one handler call on a connection of its own, so the rest of the
 *                             test is not queued behind it while it waits.
 *   waitBlockedBy(pid, what)  resolves with the backend pid waiting on a lock `pid` holds.
 *   inOrder(holdSql, first, second, label)
 *                             two handler requests on one row in a KNOWN order: a psql session runs
 *                             `holdSql` (a locking SELECT) and keeps the row; `first` is sent and shown
 *                             waiting behind that session; `second` is sent and shown waiting behind
 *                             the FIRST; then the session commits. Resolves with [first, second].
 */
export function twoSessions() {
  const sessions = new Set()
  const agents = new Set()
  const connection = new AsyncLocalStorage()
  const fetchBefore = neonConfig.fetchFunction
  neonConfig.fetchFunction = (target, init) => {
    const agent = connection.getStore()
    if (agent) return viaAgent(agent, target, init)
    return (fetchBefore ?? globalThis.fetch)(target, init)
  }

  function openSession(label) {
    const child = spawn('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { env: pgEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let exit = null
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const closed = new Promise((res) => { child.on('close', (code) => { exit = code ?? -1; res(exit) }) })
    let n = 0
    const session = {
      async run(sqlText, { timeoutMs = 20000 } = {}) {
        n += 1
        const mark = `--kit-done-${n}--`
        const from = out.length
        child.stdin.write(`${sqlText}\n\\echo ${mark}\n`)
        const started = Date.now()
        while (!out.slice(from).includes(mark)) {
          if (exit !== null) throw new Error(`psql session "${label}" ended (exit ${exit}): ${err.trim()}`)
          if (Date.now() - started > timeoutMs) throw new Error(`psql session "${label}" gave no answer in ${timeoutMs} ms: ${err.trim()}`)
          // eslint-disable-next-line no-await-in-loop
          await sleep(20)
        }
        return out.slice(from).split('\n').map((s) => s.trim()).filter((s) => s && s !== mark)
      },
      async pid() { return Number((await session.run('SELECT pg_backend_pid();'))[0]) },
      async end(finalSql = 'ROLLBACK;') {
        if (exit === null) child.stdin.end(`${finalSql}\n\\q\n`)
        await closed
        sessions.delete(session)
        return { code: exit, err: err.trim() }
      },
      kill() { if (exit === null) child.kill('SIGKILL') },
    }
    sessions.add(session)
    return session
  }

  function onOwnConnection(request) {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 })
    agents.add(agent)
    return connection.run(agent, request)
  }

  // A poll that gets no answer at all means this process's queries are queued behind the very
  // request being watched: that request was not sent through onOwnConnection().
  async function waitBlockedBy(pid, what, { timeoutMs = 25000 } = {}) {
    const started = Date.now()
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await Promise.race([
        directSql`
          SELECT a.pid FROM pg_stat_activity a
           WHERE a.pid <> pg_backend_pid() AND ${pid}::int = ANY(pg_blocking_pids(a.pid))`,
        sleep(8000).then(() => null),
      ])
      if (rows === null) throw new Error(`the poll for "${what}" got no answer in 8 s: it is queued behind the request it is watching (was that request sent with onOwnConnection?)`)
      if (rows.length) return rows[0].pid
      if (Date.now() - started > timeoutMs) throw new Error(`nothing became blocked behind backend ${pid} (${what}) in ${timeoutMs} ms`)
      // eslint-disable-next-line no-await-in-loop
      await sleep(60)
    }
  }

  async function inOrder(holdSql, first, second, label) {
    const holder = openSession(`holds the row (${label})`)
    try {
      const holderPid = await holder.pid()
      await holder.run(`BEGIN; ${holdSql}`)
      const a = onOwnConnection(first)
      const firstPid = await waitBlockedBy(holderPid, `${label}: the first request, at the held row`)
      const b = onOwnConnection(second)
      await waitBlockedBy(firstPid, `${label}: the second request, behind the first`)
      await holder.end('COMMIT;')
      return await Promise.all([a, b])
    } finally {
      await holder.end()
    }
  }

  function closeAll() {
    for (const s of sessions) s.kill()
    for (const a of agents) a.destroy()
    neonConfig.fetchFunction = fetchBefore
  }

  return { openSession, onOwnConnection, waitBlockedBy, inOrder, closeAll }
}
