// batchSideEffects.js — BUG-BATCHSIDEEFFECTS-001.
//
// THE DEFECT THIS EXISTS TO FIX
// POST /api/events/batch ran its transaction and then called exactly ONE side effect,
// awardCrittersForBatch. The single-event path performs six post-transaction effects. So
// user_stats, the streak, achievements, flat XP and app_events telemetry were silently skipped —
// for 9,695 of 12,025 live events (80.6%, measured on prod 2026-08-04). "Log all" is the normal
// way the garden gets logged, and it paid nothing. That, not the direct-write drift (1.5% of the
// gap) and not the XP cap alone, is why the reward loop reads as dead.
//
// ── DESIGN DECISION 1: the reward grain is the LOGGING ACTION, not the row ────────────────────
// A 157-planting batch grants ONE flat XP award, ONE telemetry row, ONE achievement evaluation —
// exactly what a single-event POST grants. This is not a judgement call made here; it is the
// grain already binding on this path:
//   • critterAward.js awardCrittersForBatch: "SINGLE roll per batch (Dave directive 2026-05-30:
//     'one logging action = one shot at the reward')". Flat XP now follows the critter precedent
//     rather than inventing a second, contradictory grain in the same function.
//   • reward-ux-guideline-V102 §3, carried verbatim from V101 and still BINDING:
//     "single roll per logging action / batch coalescing".
// Measured consequences of the alternative (per-EVENT grant), prod 2026-08-04:
//   • XP-eligible population 2,330 -> 12,025 (5.2x). Per-ACTION it is 2,330 -> 2,630 (+13%).
//   • 50 batches of 105-157 items hold 6,490 events; per-event they would mint 64,900 XP off 50
//     taps — 17x the user's entire lifetime XP (3,790) — while 10 individual logs earn 100.
//     That inverts effort against reward: the bulk path is ONE tap.
//   • the daily cap would then bind on 84-92% of days at ANY value up to 1,000 XP, i.e. it would
//     re-create the exact defect part 2 of this change is fixing.
// VOLUME IS STILL RECOGNISED, just in the other channel: step 3 evaluates achievements against
// event_log counts, and step 2 now makes user_stats.total_events see batch rows, so a
// 157-planting watering DOES advance water_keeper/the_hundred/five_hundred. That is
// V102's "milestones vs daily-incentive separation" working as designed — per-action daily XP,
// per-event milestones.
//
// ── DESIGN DECISION 2: post-transaction, mirroring the single path's 7-in / 6-out split ───────
// Every effect here runs AFTER sql.transaction() commits, each in its own try/catch, each
// non-fatal — byte-for-byte the same posture as index.js Steps 3a/3b/4/5. Reasons, unchanged from
// that path: (a) reward accounting is DERIVED data and must never roll back the user's 157 logged
// waterings; (b) post-tx is what makes each effect independently retriable, which is what makes
// the self-healing property below possible. The in-transaction set (event_batches, event_log,
// entity_memory x2, the three status/germination UPDATEs) is untouched.
//
// ── DESIGN DECISION 3: idempotent by construction, and therefore self-healing ─────────────────
// This function is called from BOTH the fresh-batch path and the idempotency fast-path (same-key
// re-hit). That is deliberate. Today a re-hit returns early and gets no side effects at all, so a
// Lambda that dies between COMMIT and the critter hook LOSES that batch's rewards permanently.
// Running the same idempotent function on both paths converges instead: a retry completes whatever
// the first attempt missed and re-applies nothing.
// What a retry does, effect by effect — this is the part most likely to be got wrong, so it is
// enumerated rather than asserted:
//   critters      no-op. UNIQUE INDEX critter_state(source_event_id) WHERE deleted_at IS NULL +
//                 ON CONFLICT DO NOTHING; the chosen event is deterministic (lowest id) so the
//                 retry rolls the identical seed. incrementSightingTally only fires on a row that
//                 was actually inserted, so the tally cannot double either.
//   user_stats    no-op. total_events / current_streak / last_active_date are written as ABSOLUTE
//                 recomputed values, not increments. Writing the same value twice is a no-op by
//                 definition. This replaces the blind `total_events + 1` that produced the 2,003
//                 vs 11,993 gap in the first place.
//   achievements  no-op. NOT EXISTS candidate filter + ON CONFLICT (user_id, achievement_id) DO
//                 NOTHING; the XP grant CTE only reads rows the same statement actually inserted.
//   flat XP       no-op — and this one needed a schema change to be true. xp_events had NO
//                 uniqueness on source_id, so a blind INSERT was the one genuinely non-idempotent
//                 effect. migrations/v4-eventsource-001/0c adds
//                 UNIQUE (user_id, reason, source_id) WHERE source_id IS NOT NULL, and the grant
//                 below is keyed on the BATCH id and carries ON CONFLICT DO NOTHING. Belt and
//                 braces: lambda/xp-reconcile heals user_stats.xp from SUM(xp_events.amount), so
//                 the ledger is canonical and a skipped cache bump self-corrects.
//   telemetry     no-op. Guarded by NOT EXISTS on metadata->>'batch_id'.
// THE RESIDUAL, STATED HONESTLY: a retry that arrives with a DIFFERENT idempotency_key is not a
// retry — it writes a new batch of new events, and rewarding it again is correct.
//
// ── DESIGN DECISION 4: O(1) in batch size ────────────────────────────────────────────────────
// Five round trips regardless of whether the batch holds 1 planting or 500. The batch endpoint
// exists because logging many plantings at once is a real workflow, and nothing here reintroduces
// per-row work. A per-event XP model would have been O(N) INSERTs — a third argument against it.

import { computeStreak, STREAK_GRACE_DAYS } from './streak.js';
// V4-WATERMATH-001 F0 — the zero-reward partition. Imported from the generated vocabulary so the
// batch recompute and the single-event recompute cannot drift on WHICH types are excluded.
import { NON_REWARD_EVENT_TYPES } from './eventTypes.generated.js';
import { awardCrittersForBatch } from './critterAward.js';

// Deterministic pick of the event a batch-level effect is attributed to (achievement
// trigger_event_id). Lowest id, matching awardCrittersForBatch's selection rule exactly so a
// retry attributes to the same row.
function anchorEventId(events) {
  const ids = (events ?? []).map((e) => e?.id).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return ids.length ? ids[0] : null;
}

export async function applyBatchSideEffects({
  sql,
  userId,
  userTz,
  batchId,
  eventType,
  events,             // [{ id, plant_id, created_at, metadata }] — the batch's event_log rows
  itemCount,
  tzOffsetMin = 0,
  dailyXpCap,
  flatXpPerAction,
}) {
  const out = {
    newly_earned_achievements: [],
    updated_streak: null,
    total_events: null,
    xp_gained: 0,
    daily_xp_remaining: dailyXpCap,
    // BUG-XPPROGRESSION-001 — mirrors the single path's response contract. Null means "unknown"
    // (Step 2 threw), never level 0.
    level: null,
    leveled_up: false,
  };
  const eventId = anchorEventId(events);
  // The action's FINAL level, threaded through Steps 3 and 4 — both of which move XP. Every
  // assignment is a value trg_user_stats_level wrote; NO level is ever computed in this file.
  // That is the point of the trigger: this function stays a reward orchestrator and never becomes
  // a second copy of the curve, which is how the batch path diverged from the single path in the
  // first place (BUG-BATCHSIDEEFFECTS-001).
  let levelBefore = null;
  let levelAfter = null;

  // ── Step 1: critters (pre-existing behaviour, now also reached on an idempotent re-hit) ──────
  try {
    // BUG-CRITTERNONREWARD-001 — `eventType` is the batch's single type (batches are homogeneous),
    // and it is threaded through so the critter grant obeys the same NON_REWARD_EVENT_TYPES
    // partition Step 2 below already applies to total_events and the streak. Defence-in-depth
    // today (moisture_check is in BATCH_EXCLUDED_TYPES, so a batch cannot create one) — the point
    // is that lifting that exclusion cannot silently re-open the grant.
    await awardCrittersForBatch({
      sql, userId, events, householdId: userId, tzOffsetMin, eventType,
    });
  } catch (critterErr) {
    console.warn('critter batch hook failed (non-fatal):', critterErr?.message ?? String(critterErr));
  }

  // ── Step 2: user_stats streak + total_events ────────────────────────────────────────────────
  // Mirrors index.js Step 3a with ONE deliberate difference: total_events is the recomputed live
  // count, not `+ 1`. The streak was already recomputed from DISTINCT activity days and so was
  // already idempotent; total_events was the only incrementing column and the only one that drifted.
  // The count deliberately has NO event_date ceiling (unlike the streak's day list, which excludes
  // future-dated rows from the streak math): total_events means "live event_log rows this user
  // created", which is what the integrity job and the event_count achievements both mean by it.
  try {
    const actRows = await sql`
      WITH z AS (SELECT ${userTz}::text AS tz)
      SELECT
        to_char((NOW() AT TIME ZONE (SELECT tz FROM z))::date, 'YYYY-MM-DD') AS today,
        (SELECT count(*)::int FROM event_log e
          WHERE e.created_by = ${userId} AND e.deleted_at IS NULL
            -- V4-WATERMATH-001 F0 — MUST mirror index.js Step 3a exactly. moisture_check is in
            -- BATCH_EXCLUDED_TYPES so a batch can never CREATE one, but this is a recompute over
            -- the user's whole history: without the filter, moisture_checks logged on the single
            -- path would be silently absorbed into total_events by the next batch, and the two
            -- write paths would disagree about the same number.
            AND NOT (e.event_type = ANY(${NON_REWARD_EVENT_TYPES}::text[]))) AS live_events,
        COALESCE((
          SELECT json_agg(d ORDER BY d DESC) FROM (
            SELECT DISTINCT (e.event_date AT TIME ZONE (SELECT tz FROM z))::date AS d
            FROM event_log e
            WHERE e.created_by = ${userId}
              AND e.deleted_at IS NULL
              AND NOT (e.event_type = ANY(${NON_REWARD_EVENT_TYPES}::text[]))
              AND (e.event_date AT TIME ZONE (SELECT tz FROM z))::date
                  <= (NOW() AT TIME ZONE (SELECT tz FROM z))::date
          ) days
        ), '[]'::json) AS days
    `;
    const todayStr = actRows[0]?.today ?? null;
    const liveEvents = actRows[0]?.live_events ?? null;
    const activityDays = (actRows[0]?.days ?? []).map((d) => String(d).slice(0, 10));
    const { current, longest } = computeStreak(activityDays, todayStr, STREAK_GRACE_DAYS);
    const latestDay = activityDays.length ? activityDays[0] : todayStr;

    const statsRows = await sql`
      INSERT INTO user_stats (user_id, total_events, last_active_date, current_streak, longest_streak)
      VALUES (${userId}, ${liveEvents}, ${latestDay}::date, ${current}, ${longest})
      ON CONFLICT (user_id) DO UPDATE SET
        total_events     = ${liveEvents},
        current_streak   = ${current},
        longest_streak   = GREATEST(user_stats.longest_streak, ${longest}),
        last_active_date = ${latestDay}::date,
        updated_at       = NOW()
      RETURNING current_streak, total_events, level
    `;
    if (statsRows.length) {
      out.updated_streak = statsRows[0].current_streak;
      out.total_events   = statsRows[0].total_events;
      // Read back, never computed. This upsert touches no XP column, but the trigger runs on it
      // anyway, so it is a free and current reading of the level BEFORE this batch's grants.
      levelBefore = statsRows[0].level;
      levelAfter  = statsRows[0].level;
    }
  } catch (statsErr) {
    console.warn('batch user_stats/streak upsert failed (non-fatal)', statsErr.message);
  }

  // ── Step 3: flat XP grant, ONE per logging action, against the daily cap ────────────────────
  // BUG-XPPROGRESSION-001 — THIS BLOCK MOVED (it was Step 4, after the achievement evaluation that
  // is now Step 4). Same reorder, same reason, as the single path: level is derived from xp, so a
  // WHEN level branch evaluated BEFORE this grant would judge the user against their XP as of
  // before the action they just took, and level_5 / level_9 would fire one logging action late.
  // The batch path is where that matters MOST: a batch IS the whole session for the bulk workflow
  // ("log all" over 157 plantings is one tap), so "one action late" can mean the next gardening
  // day, or never. Verified no data dependency in either direction — this grant reads only
  // (user, tz, today event_logged sum) and the cap filters reason = event_logged, so achievement
  // XP has never counted toward it (F16) and still does not.
  // source_id = the BATCH id, not an event id. That is what makes the grant idempotent under the
  // new UNIQUE (user_id, reason, source_id) index: the same batch can only ever hold one
  // 'event_logged' grant, no matter how many times this function runs.
  let flatGranted = 0;
  let flatTodayTotal = 0;
  try {
    const rows = await sql`
      WITH today_xp AS (
        SELECT COALESCE(SUM(amount), 0)::int AS today_sum
        FROM xp_events
        WHERE user_id = ${userId}
          AND reason = 'event_logged'
          AND (created_at AT TIME ZONE ${userTz})::date = (NOW() AT TIME ZONE ${userTz})::date
      ),
      flat_grant AS (
        INSERT INTO xp_events (user_id, amount, reason, source_id)
        SELECT ${userId}, ${flatXpPerAction}, 'event_logged', ${batchId}::uuid
        FROM today_xp
        WHERE today_sum < ${dailyXpCap}
        ON CONFLICT (user_id, reason, source_id) WHERE source_id IS NOT NULL DO NOTHING
        RETURNING amount
      ),
      stats AS (
        UPDATE user_stats
          SET xp = user_stats.xp + COALESCE((SELECT amount FROM flat_grant), 0),
              updated_at = NOW()
        WHERE user_id = ${userId}
        -- level is deliberately absent from this SET list: trg_user_stats_level derives it from the
        -- NEW xp in this same statement, so it comes back already-correct and this file never holds
        -- a second copy of the curve.
        RETURNING xp, level
      )
      SELECT
        COALESCE((SELECT amount FROM flat_grant), 0)::int AS granted,
        ((SELECT today_sum FROM today_xp) + COALESCE((SELECT amount FROM flat_grant), 0))::int AS today_total,
        (SELECT level FROM stats) AS level_after_flat
    `;
    if (rows.length) {
      flatGranted    = rows[0].granted;
      flatTodayTotal = rows[0].today_total;
      out.daily_xp_remaining = Math.max(0, dailyXpCap - flatTodayTotal);
      if (rows[0].level_after_flat != null) levelAfter = rows[0].level_after_flat;
    }
  } catch (xpErr) {
    console.warn('batch flat XP grant failed (non-fatal)', xpErr.message);
  }

  // ── Step 4: achievement evaluation ──────────────────────────────────────────────────────────
  // BUG-XPPROGRESSION-001 — was Step 3; now runs after the flat grant (see Step 3 header above),
  // so the level branch reads a post-grant level.
  // Byte-for-byte the single path's evaluator (index.js Step 3b), with the batch's anchor event as
  // trigger_event_id. Evaluated ONCE per batch, not per row — but its INPUTS are per-event counts
  // read straight from event_log, so a 157-planting watering advances water_keeper by 157. That is
  // the milestone channel doing the volume recognition that the daily-XP channel deliberately does
  // not. F16 still holds: achievement XP is UNCAPPED, only event_logged XP is capped.
  try {
    if (out.updated_streak != null && eventId) {
      const streakVal = out.updated_streak;
      const totalVal  = out.total_events;
      // Post-flat-grant level, read from user_stats — never computed here. Falls back to Step 2's
      // readback if the flat grant failed or was capped out.
      const levelVal  = levelAfter;
      const earnedRows = await sql`
        WITH today_in_tz AS (
          SELECT (NOW() AT TIME ZONE ${userTz})::date AS today_date,
                 EXTRACT(HOUR FROM (NOW() AT TIME ZONE ${userTz}))::int AS hour_in_tz
        ),
        event_counts AS (
          SELECT
            COUNT(*) FILTER (WHERE event_type = ${eventType})::int AS type_events,
            COUNT(*) FILTER (
              WHERE (event_date AT TIME ZONE ${userTz})::date = (SELECT today_date FROM today_in_tz)
            )::int AS today_events
          FROM event_log
          WHERE created_by = ${userId} AND deleted_at IS NULL
            -- V4-WATERMATH-001 F0 — mirrors index.js Step 3c.
            AND NOT (event_type = ANY(${NON_REWARD_EVENT_TYPES}::text[]))
        ),
        candidates AS (
          SELECT a.id, a.xp_reward
          FROM achievements a, event_counts ec, today_in_tz t
          WHERE a.is_active = true
            AND NOT EXISTS (
              SELECT 1 FROM user_achievements ua
              WHERE ua.user_id = ${userId} AND ua.achievement_id = a.id
            )
            AND CASE a.trigger_type
              WHEN 'streak'           THEN ${streakVal}::int >= (a.trigger_value->>'days')::int
              WHEN 'event_count'      THEN ${totalVal}::int  >= (a.trigger_value->>'count')::int
              -- BUG-XPPROGRESSION-001. Must stay byte-identical to index.js Step 3c's CASE — these
              -- two copies diverging is the failure mode event-source.test.js exists to catch.
              -- Unlocks level_5 / level_9, zero-earner since 2026-04-21.
              WHEN 'level'            THEN ${levelVal}::int   >= (a.trigger_value->>'level')::int
              WHEN 'event_type_count' THEN
                (a.trigger_value->>'type') = ${eventType}
                AND ec.type_events >= (a.trigger_value->>'count')::int
                AND NOT (a.trigger_value ? 'has_private_notes')
              WHEN 'time_of_day'      THEN
                (a.trigger_value ? 'hour_gte' AND t.hour_in_tz >= (a.trigger_value->>'hour_gte')::int)
                OR
                (a.trigger_value ? 'hour_lt'  AND t.hour_in_tz <  (a.trigger_value->>'hour_lt')::int)
              WHEN 'multi_per_day'    THEN ec.today_events >= (a.trigger_value->>'count')::int
              ELSE false
            END
        ),
        inserted AS (
          INSERT INTO user_achievements (user_id, achievement_id, trigger_event_id)
          SELECT ${userId}, c.id, ${eventId}::uuid FROM candidates c
          ON CONFLICT (user_id, achievement_id) DO NOTHING
          RETURNING achievement_id
        ),
        xp_grants AS (
          INSERT INTO xp_events (user_id, amount, reason, source_id)
          SELECT ${userId}, a.xp_reward, 'achievement_earned', i.achievement_id
          FROM inserted i JOIN achievements a ON a.id = i.achievement_id
          ON CONFLICT (user_id, reason, source_id) WHERE source_id IS NOT NULL DO NOTHING
          RETURNING amount, source_id
        ),
        stats_xp AS (
          UPDATE user_stats
            SET xp = user_stats.xp + COALESCE((SELECT SUM(amount) FROM xp_grants), 0),
                updated_at = NOW()
          WHERE user_id = ${userId}
            AND EXISTS (SELECT 1 FROM xp_grants)
          -- Achievement XP can itself cross a level boundary; returning the trigger-derived level
          -- lets out.level report the FINAL level of the batch rather than the mid-batch one.
          RETURNING xp, level
        )
        SELECT COALESCE(
          (SELECT json_agg(
             json_build_object('slug', a.slug, 'name', a.name, 'emoji', a.emoji, 'xp_reward', a.xp_reward)
             ORDER BY a.sort_order
           )
           FROM xp_grants xg JOIN achievements a ON a.id = xg.source_id),
          '[]'::json
        ) AS newly_earned,
        (SELECT level FROM stats_xp) AS level_after_achievements
      `;
      if (earnedRows.length) {
        out.newly_earned_achievements = earnedRows[0].newly_earned ?? [];
        // NULL when no achievement XP was granted (stats_xp is guarded on EXISTS) — the
        // post-flat-grant level is then already final.
        if (earnedRows[0].level_after_achievements != null) {
          levelAfter = earnedRows[0].level_after_achievements;
        }
      }
    }
  } catch (achErr) {
    console.warn('batch achievement eval failed (non-fatal)', achErr.message);
  }

  // ── Step 5: app_events telemetry ────────────────────────────────────────────────────────────
  // One 'log_entry_created' row per BATCH, carrying batch_id + item_count. Two notes that matter
  // to anyone reading the series later:
  //   (a) `log_entry_created` now counts LOGGING ACTIONS rather than single events. That is the
  //       correct denominator for the daily-cap readout (packet item 3), which is measured in
  //       cap-eligible grants — but it IS a break in the series' meaning at this deploy.
  //   (b) metadata deliberately carries batch_id and NOT event_id, so the 0b provenance backfill's
  //       'app' rule (keyed on metadata->>'event_id') and its 'app_batch' rule stay disjoint.
  // `daily_xp_capped` remains the ONLY measurement of forfeited XP anywhere in the schema — which
  // is precisely why app_events must not be dropped before this is re-instrumented.
  try {
    const telemetryEvents = [{
      name: 'log_entry_created',
      metadata: { event_type: eventType, batch_id: batchId, item_count: itemCount },
    }];
    if (flatGranted === 0 && flatTodayTotal >= dailyXpCap) {
      telemetryEvents.push({
        name: 'daily_xp_capped',
        metadata: { batch_id: batchId, item_count: itemCount, today_total: flatTodayTotal },
      });
    }
    for (const t of telemetryEvents) {
      await sql`
        INSERT INTO app_events (user_clerk_sub, event_name, event_source, metadata)
        SELECT ${userId}, ${t.name}, 'lambda', ${t.metadata}
        WHERE NOT EXISTS (
          SELECT 1 FROM app_events a
          WHERE a.event_name = ${t.name} AND a.metadata->>'batch_id' = ${batchId}
        )
      `;
    }
  } catch (telErr) {
    console.warn('batch app_events telemetry failed (non-fatal)', telErr.message);
  }

  const xpFromAchievements = out.newly_earned_achievements.reduce((s, a) => s + (a.xp_reward ?? 0), 0);
  out.xp_gained = flatGranted + xpFromAchievements;
  // BUG-XPPROGRESSION-001 — two READINGS of user_stats.level compared, never a recomputation.
  // IDEMPOTENT UNDER RETRY, which the fast-path caller depends on: on a re-hit the flat grant and
  // the achievement grants both no-op (ON CONFLICT DO NOTHING), so levelBefore and levelAfter are
  // read as the SAME already-final level and leveled_up correctly reports false. A retry cannot
  // re-announce a level-up, and — because level is an absolute function of xp rather than an
  // increment — it cannot inflate the level either.
  out.level = levelAfter;
  out.leveled_up = levelAfter != null && levelBefore != null && levelAfter > levelBefore;
  return out;
}
