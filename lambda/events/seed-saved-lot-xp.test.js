// V5-SEEDMULTIPARENT-001 release 2a — a seed_saved event's rewards are keyed on the JAR.
//
// Release 2's client writes one seed_saved event per parent planting of a saved-seed lot. Keyed on
// the event, a jar with N parents paid the flat grant N times and rolled N critters. The rule now
// (seedLotRewards.js, read at the two reward sites of POST /api/events):
//   • the flat grant's source_id is the LOT id when metadata.seed_lot_id is uuid-shaped, names a
//     live lot of the caller's household, and the event's planting is a LIVE seed_parent of it;
//     the grant is withheld when this person was already paid for an event carrying that lot id;
//   • the critter is rolled only when no OTHER seed_saved event carries that lot id, live or
//     soft-deleted;
//   • every other case is today's behaviour: the event id, and a roll.
//
// WHY THIS DRIVES THE HANDLER. The existing pins on these two sites read index.js as text, and
// `isRewardedEventType('seed_saved')` is true whether a jar pays once or N times, so the unit tier
// could not see this rule at all. These run the REAL handler over the Lambda runtime stubs
// (vitest.config.ts aliases) with a per-file neon mock, as loss-token-alias.test.js does.
//
// WHAT IS ASSERTED, AND WHAT IS NOT. The mock records SQL and runs none of it. A small in-memory
// model answers the reads the rule depends on (the lot, the link, the other events, the paid grants)
// and applies the grant's own bound values, so `xp_gained` per response and the bound source_id are
// real handler output for a given database state. It does NOT prove Postgres matches those rows, nor
// that the unique index holds under concurrent POSTs: that is tests/integration's job.
// The critter is asserted as a CALL to awardCritterServer, never as a row count: the roll is
// deterministic from the event id at about one in three, so "at most one critter in N events"
// passes most of the time against a handler that rolls every event.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import { readSeedLotId, resolveSeedLotRewards } from './seedLotRewards.js';

const rec = vi.hoisted(() => ({ sent: [], tx: 0, respond: () => [], award: null }));

vi.mock('@neondatabase/serverless', () => ({
  neon: () => {
    const text = (strings) => strings.reduce((acc, s, i) => acc + (i ? `$${i}` : '') + s, '');
    const sql = (strings, ...values) => {
      const q = { text: text(strings), values };
      Object.defineProperty(q, 'then', {
        enumerable: false,
        value: (ok, err) => {
          rec.sent.push({ text: q.text, values: q.values, tx: null });
          return Promise.resolve().then(() => rec.respond(q)).then(ok, err);
        },
      });
      return q;
    };
    sql.transaction = async (stmts) => {
      rec.tx += 1;
      const out = [];
      for (const q of stmts) {
        rec.sent.push({ text: q.text, values: q.values, tx: rec.tx });
        out.push(await rec.respond(q));
      }
      return out;
    };
    return sql;
  },
}));

// The real module, with the one export under test replaced by a spy. readUserPrefs/readSpeciesPrefs
// stay real: they are part of the path that leads to the call.
vi.mock('./critterAward.js', async (importOriginal) => {
  const real = await importOriginal();
  rec.award = vi.fn(async () => null);
  return { ...real, awardCritterServer: rec.award };
});

const { handler } = await import('./index.js');

const USER = 'user_stub_owner';
const MEMBER = 'user_stub_member';
const CONTAINER = 'c0c0c0c0-1111-4222-8333-444455556666';
const LOT = '10710710-aaaa-4bbb-8ccc-000000000001';
const OTHER_LOT = '10710710-aaaa-4bbb-8ccc-000000000002';
const PARENTS = [1, 2, 3, 4].map((n) => `a1a1a1a1-2222-4333-8444-00000000000${n}`);
const STRANGER_PLANT = 'a1a1a1a1-2222-4333-8444-0000000000ff';

// The database state the rule reads. Reset per test.
let db;
const freshDb = () => ({
  lots: new Set([LOT]),            // live lots of the caller's household
  links: new Set(PARENTS.map((p) => `${LOT}|${p}`)), // LIVE seed_parent links
  events: [],                      // { id, type, lot, deleted }
  xp: [],                          // { user, source }
  todaySum: 0,
  seq: 0,
  throwOn: null,                   // a RegExp: the statement that fails
});

const placeholder = (text, re) => { const m = text.match(re); return m ? Number(m[1]) - 1 : -1; };

function respond(user) {
  return ({ text, values }) => {
    if (db.throwOn && db.throwOn.test(text)) throw new Error('simulated read failure');
    if (/FROM public\.plants gn\s+LEFT JOIN public\.plant_projects pp/.test(text)) {
      return [{ id: values[0], name: 'Parent', project_id: CONTAINER }];
    }
    if (/SELECT id, name FROM public\.plant_projects/.test(text)) return [{ id: CONTAINER, name: 'Bed' }];
    if (/AS tz/.test(text)) return [{ tz: 'America/New_York' }];
    if (/INSERT INTO event_log/.test(text)) {
      db.seq += 1;
      const id = `e0e0e0e0-0000-4000-8000-${String(db.seq).padStart(12, '0')}`;
      const type = values.find((v) => v === 'seed_saved' || v === 'watering');
      const meta = values.find((v) => v && typeof v === 'object' && !Array.isArray(v)) ?? null;
      const plant = values.find((v) => PARENTS.includes(v) || v === STRANGER_PLANT) ?? null;
      const lot = typeof meta?.seed_lot_id === 'string' ? meta.seed_lot_id.toLowerCase() : null;
      db.events.push({ id, type, lot, deleted: false });
      return [{ id, event_type: type, plant_id: plant, metadata: meta, created_at: '2026-10-06T12:00:00Z' }];
    }
    if (/SELECT id, name FROM inventory_items/.test(text)) {
      return db.lots.has(String(values[0]).toLowerCase()) ? [{ id: String(values[0]).toLowerCase(), name: 'Jar' }] : [];
    }
    if (/seed_lot_parent_planting/.test(text)) {
      const lot = values[placeholder(text, /sl\.inventory_item_id = \$(\d+)::uuid/)];
      const plant = values[placeholder(text, /sl\.plant_id = \$(\d+)::uuid/)];
      const self = values[placeholder(text, /oe\.id <> \$(\d+)::uuid/)];
      const who = values[placeholder(text, /x\.user_id = \$(\d+)/)];
      return [{
        is_live_parent: db.links.has(`${lot}|${plant}`),
        // Deleted events count: the model does not look at `deleted` here, as the statement does not.
        other_event_exists: db.events.some((e) => e.type === 'seed_saved' && e.lot === lot && e.id !== self),
        xp_already_paid: db.xp.some((x) => x.user === who
          && db.events.some((e) => e.id === x.source && e.lot === lot)),
      }];
    }
    if (/flat_grant AS/.test(text)) {
      const source = values[placeholder(text, /'event_logged', \$(\d+)::uuid/)];
      const flags = [...text.matchAll(/AND \$(\d+)::boolean/g)].map((m) => values[Number(m[1]) - 1]);
      const cap = values[placeholder(text, /today_sum < \$(\d+)/)];
      const amount = values[placeholder(text, /SELECT \$\d+, \$(\d+), 'event_logged'/)];
      const conflict = db.xp.some((x) => x.user === user && x.source === source);
      const pays = db.todaySum < cap && flags.every((f) => f === true) && !conflict;
      if (pays) { db.xp.push({ user, source }); }
      const before = db.todaySum;
      if (pays) db.todaySum += amount;
      return [{ granted: pays ? amount : 0, today_total: before + (pays ? amount : 0), level_after_flat: 1 }];
    }
    return [];
  };
}

async function post(body, user = USER) {
  stubState.verifyTokenResult = { sub: user };
  rec.respond = respond(user);
  rec.sent = [];
  const res = await handler({
    requestContext: { http: { method: 'POST' } },
    rawPath: '/api/events',
    headers: { authorization: 'Bearer stub-token' },
    body: JSON.stringify(body),
  });
  const sent = rec.sent;
  const grant = sent.find((s) => /flat_grant AS/.test(s.text));
  return {
    status: res.statusCode,
    body: JSON.parse(res.body || '{}'),
    sent,
    eventId: db.events.at(-1)?.id,
    grantSource: grant ? grant.values[placeholder(grant.text, /'event_logged', \$(\d+)::uuid/)] : undefined,
    lotRead: sent.find((s) => /SELECT id, name FROM inventory_items/.test(s.text)),
    linkRead: sent.find((s) => /seed_lot_parent_planting/.test(s.text)),
  };
}

const seedSaved = (plant, metadata) => ({
  event_type: 'seed_saved', plant_id: plant, project_id: CONTAINER,
  ...(metadata === undefined ? {} : { metadata }),
});

beforeEach(() => {
  resetStubs();
  process.env.GARDEN_HOUSEHOLD_IDS = `${USER},${MEMBER}`;
  db = freshDb();
  rec.award.mockClear();
});

describe('the fixture reaches the reward sites at all', () => {
  it('a seed_saved POST answers 201 and sends the flat grant', async () => {
    const r = await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(201);
    expect(r.grantSource, 'the flat grant was never sent').toBeDefined();
    expect(r.eventId).toBeTruthy();
  });
});

describe('flat grant — bound to the jar when the lot check passes', () => {
  it('binds the LOT id as source_id, not the event id, and pays', async () => {
    const r = await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    expect(r.grantSource).toBe(LOT);
    expect(r.grantSource).not.toBe(r.eventId);
    expect(r.body.xp_gained).toBe(10);
  });

  it('N parents posted in turn pay once: xp_gained per response is [10, 0, 0, 0]', async () => {
    const gained = [];
    for (const p of PARENTS) {
      const r = await post(seedSaved(p, { seed_lot_id: LOT }));
      expect(r.status).toBe(201);
      expect(r.grantSource).toBe(LOT);
      gained.push(r.body.xp_gained);
    }
    expect(gained).toEqual([10, 0, 0, 0]);
    expect(db.xp).toEqual([{ user: USER, source: LOT }]);
    // The event rows still move by one per parent: accepted, and not this rule's business.
    expect(db.events).toHaveLength(PARENTS.length);
  });

  it('a second household member is paid once for the same jar: the key is (person, jar)', async () => {
    expect((await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }), USER)).body.xp_gained).toBe(10);
    const second = await post(seedSaved(PARENTS[1], { seed_lot_id: LOT }), MEMBER);
    expect(second.grantSource).toBe(LOT);
    expect(second.body.xp_gained).toBe(10);
    expect((await post(seedSaved(PARENTS[2], { seed_lot_id: LOT }), MEMBER)).body.xp_gained).toBe(0);
  });

  it('binds the id as the database spells it when the request sends it in capitals', async () => {
    const r = await post(seedSaved(PARENTS[0], { seed_lot_id: LOT.toUpperCase() }));
    expect(r.grantSource).toBe(LOT);
    expect(r.lotRead.values[0]).toBe(LOT);
  });

  it('at the daily cap nothing is granted and no row is written, whichever key is bound', async () => {
    db.todaySum = 300;
    const r = await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    expect(r.grantSource).toBe(LOT);
    expect(r.body.xp_gained).toBe(0);
    expect(r.body.daily_xp_remaining).toBe(0);
    expect(db.xp).toEqual([]);
  });
});

describe('flat grant — a jar saved before this release does not pay twice', () => {
  it('withholds the grant when this person holds an event-keyed grant for an event carrying the lot', async () => {
    // The pre-release shape: one seed_saved event for the jar, paid on its EVENT id.
    const OLD = 'e0e0e0e0-0000-4000-8000-0000000009a1';
    db.events.push({ id: OLD, type: 'seed_saved', lot: LOT, deleted: false });
    db.xp.push({ user: USER, source: OLD });
    const r = await post(seedSaved(PARENTS[1], { seed_lot_id: LOT }));
    expect(r.status).toBe(201);
    expect(r.grantSource).toBe(LOT);
    const grant = r.sent.find((s) => /flat_grant AS/.test(s.text));
    const flags = [...grant.text.matchAll(/AND \$(\d+)::boolean/g)].map((m) => grant.values[Number(m[1]) - 1]);
    expect(flags).toEqual([true, false]);
    expect(r.body.xp_gained).toBe(0);
    expect(db.xp).toHaveLength(1);
  });

  it('still withholds it when that earlier event has since been soft-deleted (no clawback, no re-pay)', async () => {
    const OLD = 'e0e0e0e0-0000-4000-8000-0000000009a2';
    db.events.push({ id: OLD, type: 'seed_saved', lot: LOT, deleted: true });
    db.xp.push({ user: USER, source: OLD });
    expect((await post(seedSaved(PARENTS[1], { seed_lot_id: LOT }))).body.xp_gained).toBe(0);
  });

  it('reads that as: this person, reason event_logged, an event carrying the lot id, deleted or not', async () => {
    const r = await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    const t = r.linkRead.text;
    expect(t).toMatch(/FROM xp_events x\s+JOIN event_log pe ON pe\.id = x\.source_id\s+WHERE x\.user_id = \$\d+\s+AND x\.reason = 'event_logged'\s+AND lower\(pe\.metadata->>'seed_lot_id'\) = \$\d+\s+\) AS xp_already_paid/);
    expect(t).not.toMatch(/pe\.deleted_at/);
    expect(r.linkRead.values[placeholder(t, /x\.user_id = \$(\d+)/)]).toBe(USER);
  });

  it('another member\'s earlier grant does not withhold this person\'s', async () => {
    const OLD = 'e0e0e0e0-0000-4000-8000-0000000009a3';
    db.events.push({ id: OLD, type: 'seed_saved', lot: LOT, deleted: false });
    db.xp.push({ user: MEMBER, source: OLD });
    expect((await post(seedSaved(PARENTS[1], { seed_lot_id: LOT }), USER)).body.xp_gained).toBe(10);
  });
});

describe('flat grant — every refusal arm binds the EVENT id, exactly as before', () => {
  const expectEventKeyed = (r) => {
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(201);
    expect(r.grantSource).toBe(r.eventId);
    expect(r.body.xp_gained).toBe(10);
    const grant = r.sent.find((s) => /flat_grant AS/.test(s.text));
    const flags = [...grant.text.matchAll(/AND \$(\d+)::boolean/g)].map((m) => grant.values[Number(m[1]) - 1]);
    expect(flags).toEqual([true, true]);
  };

  it('no metadata', async () => {
    const r = await post(seedSaved(PARENTS[0]));
    expectEventKeyed(r);
    expect(r.lotRead).toBeUndefined();
    expect(r.linkRead).toBeUndefined();
  });

  it('metadata without a seed_lot_id', async () => {
    const r = await post(seedSaved(PARENTS[0], { note: 'dry pods' }));
    expectEventKeyed(r);
    expect(r.lotRead).toBeUndefined();
  });

  for (const [label, bad] of [
    ['not uuid-shaped', 'not-a-uuid'],
    ['a uuid with a trailing statement', `${LOT}'; DROP TABLE xp_events; --`],
    ['a number', 42],
    ['an object', { id: LOT }],
    ['empty', ''],
  ]) {
    it(`a seed_lot_id that is ${label} never reaches a statement as a lot id`, async () => {
      const r = await post(seedSaved(PARENTS[0], { seed_lot_id: bad }));
      expectEventKeyed(r);
      expect(r.lotRead).toBeUndefined();
      expect(r.linkRead).toBeUndefined();
      // Bound exactly once, as the event row's own metadata, and nowhere as a scalar.
      expect(r.sent.filter((s) => !/INSERT INTO event_log/.test(s.text))
        .flatMap((s) => s.values)).not.toContain(bad);
    });
  }

  it('a lot that is foreign, absent or soft-deleted (the owned-lot read finds no row)', async () => {
    const r = await post(seedSaved(PARENTS[0], { seed_lot_id: OTHER_LOT }));
    expectEventKeyed(r);
    expect(r.lotRead, 'the lot was never checked').toBeTruthy();
    // The read that decides it: household, and live. One statement covers all three refusals.
    expect(r.lotRead.text).toMatch(/created_by = ANY\(\$\d+\)\s+AND deleted_at IS NULL/);
    expect(r.lotRead.values[1]).toEqual([USER, MEMBER]);
    expect(r.linkRead, 'the link was read for a lot the caller does not own').toBeUndefined();
  });

  it('a planting that is not a parent of that lot', async () => {
    const r = await post(seedSaved(STRANGER_PLANT, { seed_lot_id: LOT }));
    expectEventKeyed(r);
    expect(r.linkRead).toBeTruthy();
  });

  it('a planting whose link was retired (the link read is live-only, seed_parent only)', async () => {
    db.links.delete(`${LOT}|${PARENTS[0]}`);
    const r = await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    expectEventKeyed(r);
    expect(r.linkRead.text).toMatch(/FROM public\.seed_lot_parent_planting sl\s+WHERE sl\.inventory_item_id = \$\d+::uuid\s+AND sl\.plant_id = \$\d+::uuid\s+AND sl\.role = 'seed_parent'\s+AND sl\.deleted_at IS NULL/);
  });

  it('the lot read throws: the event is still written and paid on its own id', async () => {
    db.throwOn = /SELECT id, name FROM inventory_items/;
    expectEventKeyed(await post(seedSaved(PARENTS[0], { seed_lot_id: LOT })));
  });

  it('the link read throws: the same', async () => {
    db.throwOn = /seed_lot_parent_planting/;
    const r = await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    expectEventKeyed(r);
    expect(rec.award).toHaveBeenCalledTimes(1);
  });
});

describe('critter — one roll per jar, asserted as the CALL', () => {
  it('is called exactly once across N events posted in turn, for the first', async () => {
    const ids = [];
    for (const p of PARENTS) ids.push((await post(seedSaved(p, { seed_lot_id: LOT }))).eventId);
    expect(rec.award).toHaveBeenCalledTimes(1);
    expect(rec.award.mock.calls[0][0]).toMatchObject({
      userId: USER, eventId: ids[0], plantId: PARENTS[0], eventType: 'seed_saved',
    });
  });

  it('is not called again after the prior event was soft-deleted (remove, then re-add)', async () => {
    await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    expect(rec.award).toHaveBeenCalledTimes(1);
    db.events[0].deleted = true;
    const again = await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    expect(again.status).toBe(201);
    expect(rec.award).toHaveBeenCalledTimes(1);
  });

  it('reads "other event" with no live filter, by type, lot id and not-this-event', async () => {
    const r = await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    const t = r.linkRead.text;
    expect(t).toMatch(/FROM event_log oe\s+WHERE oe\.event_type = \$\d+\s+AND lower\(oe\.metadata->>'seed_lot_id'\) = \$\d+\s+AND oe\.id <> \$\d+::uuid\s+\) AS other_event_exists/);
    expect(t).not.toMatch(/oe\.deleted_at/);
    expect(r.linkRead.values[placeholder(t, /oe\.id <> \$(\d+)::uuid/)]).toBe(r.eventId);
    expect(r.linkRead.values[placeholder(t, /oe\.event_type = \$(\d+)/)]).toBe('seed_saved');
  });

  it('a different jar gets its own roll', async () => {
    db.lots.add(OTHER_LOT);
    db.links.add(`${OTHER_LOT}|${PARENTS[1]}`);
    await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    await post(seedSaved(PARENTS[1], { seed_lot_id: OTHER_LOT }));
    expect(rec.award).toHaveBeenCalledTimes(2);
  });

  it('every refused event rolls as it always did, even with other events on the lot', async () => {
    await post(seedSaved(PARENTS[0], { seed_lot_id: LOT }));
    await post(seedSaved(STRANGER_PLANT, { seed_lot_id: LOT }));   // not a parent
    await post(seedSaved(PARENTS[1], { seed_lot_id: 'nope' }));    // bad shape
    await post(seedSaved(PARENTS[2]));                             // no metadata
    expect(rec.award).toHaveBeenCalledTimes(4);
  });

  it('the smoke bypass still wins', async () => {
    await post(seedSaved(PARENTS[0], { seed_lot_id: LOT, _skip_critter_award: true }));
    expect(rec.award).not.toHaveBeenCalled();
  });
});

describe('every other event type is untouched', () => {
  it('a watering event naming a real lot and parent reads nothing and is event-keyed', async () => {
    const one = await post({ event_type: 'watering', plant_id: PARENTS[0], project_id: CONTAINER, metadata: { seed_lot_id: LOT } });
    const two = await post({ event_type: 'watering', plant_id: PARENTS[0], project_id: CONTAINER, metadata: { seed_lot_id: LOT } });
    for (const r of [one, two]) {
      expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(201);
      expect(r.lotRead).toBeUndefined();
      expect(r.linkRead).toBeUndefined();
      expect(r.grantSource).toBe(r.eventId);
      expect(r.body.xp_gained).toBe(10);
    }
    expect(rec.award).toHaveBeenCalledTimes(2);
  });
});

describe('seedLotRewards.js in isolation', () => {
  it('readSeedLotId accepts a uuid string only, and lowercases it', () => {
    expect(readSeedLotId({ seed_lot_id: LOT.toUpperCase() })).toBe(LOT);
    for (const m of [null, undefined, 'x', [], [{ seed_lot_id: LOT }], {}, { seed_lot_id: null },
      { seed_lot_id: 7 }, { seed_lot_id: ` ${LOT}` }, { seed_lot_id: `${LOT}\n` }]) {
      expect(readSeedLotId(m)).toBeNull();
    }
  });

  it('resolveSeedLotRewards never throws and never queries without a planting or an event id', async () => {
    const sql = vi.fn(() => { throw new Error('must not be reached'); });
    const base = { eventType: 'seed_saved', eventId: 'e0e0e0e0-0000-4000-8000-000000000001', plantId: PARENTS[0], metadata: { seed_lot_id: LOT }, userId: USER, householdIds: [USER] };
    expect(await resolveSeedLotRewards(sql, { ...base, plantId: null })).toBeNull();
    expect(await resolveSeedLotRewards(sql, { ...base, plantId: 'nope' })).toBeNull();
    expect(await resolveSeedLotRewards(sql, { ...base, eventId: null })).toBeNull();
    expect(sql).not.toHaveBeenCalled();
    // And with everything present, a sql that throws is swallowed.
    expect(await resolveSeedLotRewards(sql, base)).toBeNull();
    expect(sql).toHaveBeenCalledTimes(1);
  });
});
