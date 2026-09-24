// search-seeds-cap.int.test.js — BUG-SEARCHSEEDCAP20-001 against a real Postgres.
//
// Header search files seed packets and saved lots under "Seeds", split client-side on `category` out of
// the one `inventory` list GET /api/search returns. That list ended in a single LIMIT 20 across every
// inventory category, so the Seeds group stopped at 20 and nothing said there were more: on prod
// 2026-09-24, q=pepper matched 94 live seed rows and showed 20. Dave chose to show every match.
//
// WHY THIS FILE EXISTS. lambda/dashboard/search.test.js drives the query builder through a mock sql that
// records text and never applies a LIMIT, so it can pin which branch carries which cap and nothing about
// what Postgres returns. This file runs the real handler composition (handleSearch, the function the
// dashboard Lambda routes /api/search to) on rows built to cross the old cap:
//   · 30 matching seed rows — 25 whose name starts with the word, five of them the household mate's so
//     they sit past the old cut AND need the household scope, plus five that match only through a
//     non-prefix name, brand, model, location or notes. Every one comes back.
//   · 25 matching non-seed rows. That group keeps its cap: the first 20, by the unchanged ordering.
//   · the ordering — name-prefix matches first, then name — across the whole list.
//   · a stranger's seed row and a soft-deleted seed row carrying the same word stay out. Both are named
//     to sort FIRST, so a leak lands at the head of the list rather than hiding in it.
//
// FIXTURES are this file's own `int-test-` namespaced users; teardown hard-deletes them (the test-data
// carve-out) and the global sweep catches anything a failed beforeAll leaves behind.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import { handleSearch } from '../../lambda/dashboard/handlers.js'

const RUN = testRunId()
const OWNER = `user_int_searchseeds_${RUN}`
const MATE = `user_int_searchseeds_mate_${RUN}`
const STRANGER = `user_int_searchseeds_stranger_${RUN}`
// The searched word: unique per run, and not a substring of the variety's name, so the only rows it
// can match are the ones below. Letters, digits and one hyphen — nothing likeEscape rewrites.
const WORD = `sq${RUN.slice('int-test-'.length)}`

const two = (n) => String(n).padStart(2, '0')
const PREFIX_SEEDS = Array.from({ length: 25 }, (_, i) => `${WORD} seed ${two(i + 1)}`)
const TOOLS = Array.from({ length: 25 }, (_, i) => `${WORD} tool ${two(i + 1)}`)
// Matched through something other than a name prefix, so each ranks after every prefix match — the
// first through the middle of its name, the rest through brand, model, location and notes, in that
// order. Names sort Aa..Ae in any collation.
const COLUMN_SEEDS = [`Aa middle of the name ${WORD}`, 'Ab brand', 'Ac model', 'Ad location', 'Ae notes']

let varietyId
let _hhEnv
let response

// handleSearch builds the whole /api/search body; one call serves every assertion below.
const search = async () => {
  if (!response) {
    const res = await handleSearch(directSql, OWNER, WORD)
    expect(res.statusCode, res.body).toBe(200)
    response = JSON.parse(res.body)
  }
  return response.results.inventory
}

beforeAll(async () => {
  // householdScope reads GARDEN_HOUSEHOLD_IDS at call time: OWNER + MATE are one household, STRANGER is
  // outside it. Saved and restored so this file does not leak into the shared worker env.
  _hhEnv = process.env.GARDEN_HOUSEHOLD_IDS
  process.env.GARDEN_HOUSEHOLD_IDS = `${OWNER},${MATE}`

  // chk_inventory_seed_requires_variety: every seed row needs a variety. The FK asks existence only.
  const v = await directSql`
    INSERT INTO plant_varieties (name, created_by) VALUES (${`int-searchseeds-variety-${RUN}`}, ${OWNER}) RETURNING id`
  varietyId = v[0].id

  // Name-prefix seed rows 01..25; 21..25 are the mate's.
  await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, unit, quantity_on_hand, variety_id)
    SELECT o.owner, o.owner, 'consumable', ${WORD} || ' seed ' || lpad(g::text, 2, '0'), 'seeds', 'packet', 1, ${varietyId}
    FROM generate_series(1, 25) AS g
    CROSS JOIN LATERAL (SELECT CASE WHEN g > 20 THEN ${MATE} ELSE ${OWNER} END AS owner) o`

  // One seed row per matched column that is not a name prefix.
  await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, unit, quantity_on_hand, variety_id,
                                 brand, model, location_text, notes)
    VALUES
      (${OWNER}, ${OWNER}, 'consumable', ${COLUMN_SEEDS[0]}, 'seeds', 'packet', 1, ${varietyId}, NULL, NULL, NULL, NULL),
      (${OWNER}, ${OWNER}, 'consumable', ${COLUMN_SEEDS[1]}, 'seeds', 'packet', 1, ${varietyId}, ${`${WORD} Seed Co`}, NULL, NULL, NULL),
      (${OWNER}, ${OWNER}, 'consumable', ${COLUMN_SEEDS[2]}, 'seeds', 'packet', 1, ${varietyId}, NULL, ${`${WORD}-M`}, NULL, NULL),
      (${OWNER}, ${OWNER}, 'consumable', ${COLUMN_SEEDS[3]}, 'seeds', 'packet', 1, ${varietyId}, NULL, NULL, ${`tin ${WORD}`}, NULL),
      (${OWNER}, ${OWNER}, 'consumable', ${COLUMN_SEEDS[4]}, 'seeds', 'packet', 1, ${varietyId}, NULL, NULL, NULL, ${`saved off the ${WORD} plant`})`

  // Name-prefix non-seed rows 01..25 (a durable needs only quantity).
  await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, quantity)
    SELECT ${OWNER}, ${OWNER}, 'durable', ${WORD} || ' tool ' || lpad(g::text, 2, '0'), 'tools', 1
    FROM generate_series(1, 25) AS g`

  // Must never appear: outside the household, and soft-deleted.
  await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, unit, quantity_on_hand, variety_id)
    VALUES (${STRANGER}, ${STRANGER}, 'consumable', ${`${WORD} seed 00 stranger`}, 'seeds', 'packet', 1, ${varietyId})`
  await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, unit, quantity_on_hand, variety_id, deleted_at)
    VALUES (${OWNER}, ${OWNER}, 'consumable', ${`${WORD} seed 00 deleted`}, 'seeds', 'packet', 1, ${varietyId}, NOW())`
})

afterAll(async () => {
  if (_hhEnv === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS
  else process.env.GARDEN_HOUSEHOLD_IDS = _hhEnv
  assertFixtureId(OWNER, MATE, STRANGER)
  await settle('search-seeds-cap', [
    () => directSql`DELETE FROM inventory_items WHERE created_by IN (${OWNER}, ${MATE}, ${STRANGER})`,
    () => directSql`DELETE FROM entity WHERE entity_type = 'cultivar' AND cultivar_ref_id IN (
                      SELECT id FROM plant_varieties WHERE created_by = ${OWNER})`,
    () => directSql`DELETE FROM plant_varieties WHERE created_by = ${OWNER}`,
  ])
})

describe('GET /api/search — every matching seed row comes back (BUG-SEARCHSEEDCAP20-001, real Postgres)', () => {
  it('fixture: 30 live matching seed rows across the household — more than the old cap of 20', async () => {
    const rows = await directSql`
      SELECT count(*) FILTER (WHERE created_by = ${OWNER})::int AS owner,
             count(*) FILTER (WHERE created_by = ${MATE})::int AS mate
      FROM inventory_items
      WHERE category = 'seeds' AND deleted_at IS NULL AND created_by IN (${OWNER}, ${MATE})`
    expect(rows[0]).toEqual({ owner: 25, mate: 5 })
    expect(PREFIX_SEEDS.length + COLUMN_SEEDS.length).toBeGreaterThan(20)
  })

  it('the Seeds group gets every matching seed row — the mate\'s, past the old cut, included', async () => {
    const seeds = (await search()).filter((r) => r.category === 'seeds').map((r) => r.name)
    expect(seeds.length, 'seed rows returned').toBe(30)
    expect(seeds).toEqual([...PREFIX_SEEDS, ...COLUMN_SEEDS])
  })

  it('other inventory keeps its cap of 20 — the first 20 by the unchanged order, no longer crowded out by seed', async () => {
    const others = (await search()).filter((r) => r.category !== 'seeds').map((r) => r.name)
    expect(others).toEqual(TOOLS.slice(0, 20))
  })

  it('ordering is unchanged across the whole list: name-prefix matches first, then name', async () => {
    const names = (await search()).map((r) => r.name)
    expect(names).toEqual([...PREFIX_SEEDS, ...TOOLS.slice(0, 20), ...COLUMN_SEEDS])
  })

  it('a stranger\'s seed row and a soft-deleted seed row stay out', async () => {
    const names = (await search()).map((r) => r.name)
    expect(names).not.toContain(`${WORD} seed 00 stranger`)
    expect(names).not.toContain(`${WORD} seed 00 deleted`)
  })

  it('rows keep the six fields the page reads — the ranking column does not leak into the response', async () => {
    for (const r of await search()) {
      expect(Object.keys(r).sort()).toEqual(['category', 'id', 'location_text', 'name', 'snippet', 'status'])
    }
  })
})
