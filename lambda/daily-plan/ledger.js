'use strict';
// V4-WATERMATH-001 F2 — the per-planting Water Ledger fold (canon
// watering-cadence-math-design-V100-20260812.md Part 2). Pure: no I/O, no env reads, no engine.js
// require (engine requires THIS module; the shared rain-IA constants are mirrored in ledgerParams
// and pinned equal by test). Every tuned number comes from ./ledgerParams.
//
// THE MODEL. Replace `dW >= wi` with a continuous depletion score D in CADENCE-DAYS, recomputed
// STATELESSLY per run from the 30-day event window:
//   demand(day) = NORM x clamp(ET0(day)/ET0_REF_PEAK, 0.5, 2.0) x vesselFactor(day) x stageFactor(day)
//   due  <=>  D >= dueThreshold = wi_eff x (drought high ? 1.15 : 1.0)
// Today's model is the DEGENERATE CASE (all factors 1.0, all amounts Normal) and every data gap
// falls back to it — never to NaN (canon Decision 3; clamp(NaN) is unreachable by construction).
//
// FOLD DETERMINISM (canon Decision 15): ONE merged timeline — event_log rows at their timestamps,
// gauge-rain day-credits positioned at 23:59 ET of their qualifying day, demand accruing
// continuously between positions — ordered by (timestamp, type-priority: watering/rain ->
// moisture_check -> rain-day-credit, id). All ages are FRACTIONAL days on the epoch-ms timeline
// (ET civil days only bucket demand attribution); date-only backdated events sit at 12:00 ET.

const P = require('./ledgerParams');

const DAY = 86400000;
const ET_TZ = 'America/New_York';

// ── ET civil-time helpers ────────────────────────────────────────────────────────────────────────
// Epoch-ms based, DST-correct via Intl (pinned by the DST fixtures in ledger.test.js). No fixed
// UTC-offset arithmetic anywhere: ET is UTC-4 or UTC-5 depending on the date.
const _fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function etParts(ms) {
  const p = {};
  for (const x of _fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, msOfDay: ((+p.hour) * 3600 + (+p.minute) * 60 + (+p.second)) * 1000 };
}
const _midCache = new Map();
// Epoch ms of 00:00 ET on the given civil date. Midnight always exists in ET (transitions happen at
// 02:00), and its UTC offset is one of exactly two values; probe both and keep the one that renders
// back as 00:00 of the same date.
function etMidnightMs(dateStr) {
  let v = _midCache.get(dateStr);
  if (v != null) return v;
  const utcMid = Date.parse(dateStr + 'T00:00:00Z');
  v = utcMid + 5 * 3600000; // EST fallback (unreachable in practice — one probe below always matches)
  for (const offH of [4, 5]) {
    const cand = utcMid + offH * 3600000;
    const p = etParts(cand);
    if (p.date === dateStr && p.msOfDay === 0) { v = cand; break; }
  }
  _midCache.set(dateStr, v);
  return v;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Calendar days between two 'YYYY-MM-DD' labels (b - a), pure UTC date math like engine.daysBetween.
function calDays(a, b) { return Math.floor((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY); }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ramp = (v, lo, hi) => (v == null ? 0 : clamp((v - lo) / (hi - lo), 0, 1));
const num = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }; // neon numeric -> string
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

// ── container_size parse table (canon Part 5) ────────────────────────────────────────────────────
// gal as-is; qt/4; L/3.785; oz/128; inch-diameter -> nursery-pot volume lookup; ft-dims -> bed/large;
// unparseable or ambiguous -> null (unsized bucket + LOW driver). "gall" (live typo) matches gal\w*.
const INCH_GAL = [[4, 0.125], [5, 0.25], [6, 0.5], [7, 0.75], [8, 1], [10, 3], [12, 5], [14, 7], [16, 10], [18, 15]];
function inchDiameterGal(d) {
  if (!Number.isFinite(d) || d <= 0) return null;
  let g = 0.06; // < 4in: cell/plug scale
  for (const [din, gal] of INCH_GAL) if (d >= din) g = gal;
  return g;
}
function parseContainerGal(size) {
  if (!size || typeof size !== 'string') return null;
  const s = size.toLowerCase().trim();
  // NxM ft / ' bed dimensions -> large (a bed is not a drained vessel; any value >= largeMinGal works)
  if (/\d\s*(x|by)\s*[\d.]+\s*(ft|f(oo|ee)t|')/.test(s)) return P.SIZE_BUCKETS.bedGal;
  const m = s.match(/([\d.]+)\s*(gal\w*|quarts?|qts?|litres?|liters?|l|oz|ounces?|inch(es)?|in|"|cm|f(oo|ee)?t|ft|')(?![a-z])/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2];
  if (u.startsWith('gal')) return n;
  if (u.startsWith('quart') || u.startsWith('qt')) return n / 4;
  if (u.startsWith('litre') || u.startsWith('liter') || u === 'l') return n / 3.785;
  if (u === 'oz' || u.startsWith('ounce')) return n / 128;
  if (u === 'cm') return inchDiameterGal(n / 2.54);
  if (u.startsWith('inch') || u === 'in' || u === '"') return inchDiameterGal(n);
  if (u === 'ft' || u === 'foot' || u === 'feet' || u === "'") return P.SIZE_BUCKETS.bedGal;
  return null;
}
function sizeBucket(gal) {
  if (gal == null) return { bucket: 'unsized', factor: P.SIZE_BUCKETS.unsizedFactor, unsized: true };
  if (gal <= P.SIZE_BUCKETS.smallMaxGal) return { bucket: 'small', factor: P.SIZE_BUCKETS.smallFactor, unsized: false };
  if (gal >= P.SIZE_BUCKETS.largeMinGal) return { bucket: 'large', factor: P.SIZE_BUCKETS.largeFactor, unsized: false };
  return { bucket: 'mid', factor: P.SIZE_BUCKETS.midFactor, unsized: false };
}

// ── Vessel profile (static per planting; the fabric heat ramp is per-day inside demandFor) ───────
const IN_GROUND_CLASS = new Set(['in_ground', 'raised_bed']);
// Types whose size is implied by the type itself (vesselKnown does not demand a parsed size for them).
const SIZE_IMPLIED = new Set(['in_ground', 'raised_bed', 'trough', 'whiskey_barrel', 'window_box',
  'tray_cell', 'soil_block', 'solo_cup']);
function vesselProfile(container_type, container_size) {
  const ct = (container_type || '').toLowerCase();
  const tray = P.TRAY_TYPES.includes(ct);
  const isFabric = ct === 'fabric_bag';
  const inGroundClass = IN_GROUND_CLASS.has(ct);
  const sizeGal = parseContainerGal(container_size);
  const sb = sizeBucket(sizeGal);
  const classFactor = isFabric ? null // per-day (heat ramp)
    : (ct ? (P.VESSEL_CLASS_FACTOR[ct] ?? P.VESSEL_UNKNOWN_FACTOR) : P.VESSEL_UNKNOWN_FACTOR);
  // Deep-soak banking eligibility: in-ground class OR >= largeMinGal container (canon Decision 4).
  const banks = inGroundClass || (sizeGal != null && sizeGal >= P.SIZE_BUCKETS.largeMinGal);
  // Small-vessel semantics mirror engine.isSmallVessel's fail-safe direction: tray class small;
  // in-ground/intermediate large; otherwise by parsed volume with UNKNOWN -> small (deny credit).
  const smallVessel = tray ? true
    : (inGroundClass || ['trough', 'whiskey_barrel', 'window_box', 'hanging_basket'].includes(ct)) ? false
    : (sizeGal == null ? true : sizeGal <= 0.25);
  const known = !!ct && (SIZE_IMPLIED.has(ct) || sizeGal != null);
  return { ct, tray, isFabric, inGroundClass, sizeGal, sizeBucket: sb.bucket,
    sizeFactor: sb.factor, unsized: sb.unsized, classFactor, banks, smallVessel, known };
}

// ── Exposure (canon Decision 5: three-way split; engine doctrine: read ONLY resolved flags) ──────
//   outdoor          ET0-scaled demand + rain day-credits
//   covered(-outdoor) FULL ET0-scaled demand, rain-exempt (also the UNKNOWN case: erring toward
//                     prompting is the safe direction for both halves of the split)
//   indoor           flat 1.0 demand ("indoor demand modeling deferred"); the current cov tri-state's
//                     TRUE set (Stable/House/shelf/rack/tray) is verified indoor, not covered-outdoor
function exposureClass(p) {
  if (p && p.rain_exposed === true) return 'outdoor';   // explicit per-planting override, both directions
  if (p && p.rain_exposed === false) return 'covered';
  if (p && p.rain_exposed_resolved === true) return 'outdoor';
  if (p && (p.frost_covered_resolved === true || p.loc_cover_state === true)) return 'indoor';
  return 'covered';
}

// ── Confidence (canon Part 2 tier table; server-computed so every surface agrees) ────────────────
function computeConfidence({ via, vesselKnown, weatherOk, snoozeCount, trayUnprofiled }) {
  let tier;
  if (trayUnprofiled) tier = 'LOW';                               // unprofiled tray class is LOW outright
  else if (via === 'db') {                                        // researched cadence (cadence_scopes non-empty)
    const missing = (vesselKnown ? 0 : 1) + (weatherOk ? 0 : 1);
    tier = missing === 0 ? 'HIGH' : (missing === 1 ? 'MEDIUM' : 'LOW'); // HIGH provenance missing one input -> MEDIUM
  } else if (typeof via === 'string' && via.startsWith('variety:')) {
    tier = (vesselKnown && weatherOk) ? 'MEDIUM' : 'LOW';         // bundled per-variety WITH known vessel
  } else tier = 'LOW';                                            // genus fallback / 3-day default
  // Override-rate demotion — the one signal measuring verdict ACCURACY rather than input provenance.
  if ((snoozeCount || 0) >= P.CONFIDENCE.overrideDemoteCount) tier = tier === 'HIGH' ? 'MEDIUM' : 'LOW';
  return tier;
}

// ── The fold ─────────────────────────────────────────────────────────────────────────────────────
// ctx = {
//   wiEff, thr,                       cadence-days (thr may be fractional; wiEff is an integer)
//   events: [{id, t, type, depth}],   window events for THIS planting (t = epoch ms)
//   weatherByDate, weatherRowCount,   from buildLedgerOpts (numerics coerced)
//   todayStr, effNowMs,               plan day + clamped now-instant
//   todayEt0, todayTmax,              live D0 forecast values (hydrology.today_et0_in / today_tmax_f)
//   exposure,                         'outdoor' | 'covered' | 'indoor'
//   vessel,                           vesselProfile() result
//   rainTier,                         engine rainDepthTierFor(container_type, vessel.sizeGal) —
//                                     RAIN_DEPTH key. NOT rainTierFor: unknown must resolve
//                                     'unknown' (not 'small_fast'), and a >=3-gal fabric_bag must
//                                     resolve 'fabric_ground' (not 'small_fast')
//   transplantAt,                     'YYYY-MM-DD' | null
// }
const PRIO = { watering: 0, rain: 0, moisture_check: 1, day_credit: 2 };

// ── DRG-RAINDEPTH-001 depth mapping ──────────────────────────────────────────────────────────────
// Ordered weakest->strongest; demotion walks left and falls off the end to null (= no credit).
const DEPTH_ORDER = ['light', 'normal', 'deep'];
// Measured daily precip -> depth class for one substrate tier. Lower bounds, strongest wins.
// Non-positive/non-finite precip earns nothing (a null row is filtered by the caller).
function rainDepthClass(tier, precipIn) {
  const t = P.RAIN_DEPTH[tier] ?? P.RAIN_DEPTH.unknown;   // strictest row: err toward watering
  if (!Number.isFinite(precipIn) || precipIn <= 0) return null;
  if (precipIn >= t.deep) return 'deep';
  if (precipIn >= t.normal) return 'normal';
  if (precipIn >= t.light) return 'light';
  return null;                                                     // trace: below the light floor
}
// One-class demotion (the bag-heat rule). 'light' demotes to null, not to a zero-value class —
// which, on the live record, is the ONLY branch that has ever executed: all 7 hot (tmax>=85F)
// crediting days in the 90-day prod window are Light, so 7 of 7 observed firings were total credit
// denial. KEPT AS-IS by crucible verdict D2/C5; the flip-time replacement (P_eff = max(0, P - 0.08")
// when tmax >= bagHeatSoftenF) and the reasoning for deferring it are recorded on RAIN_DAY in
// ledgerParams.js. Do not change this function's behaviour without reading that block.
function demoteDepth(depth) {
  const i = DEPTH_ORDER.indexOf(depth);
  return i <= 0 ? null : DEPTH_ORDER[i - 1];
}
function foldLedger(ctx) {
  const { wiEff, thr, events = [], weatherByDate = {}, weatherRowCount = 0,
    todayStr, effNowMs, todayEt0 = null, todayTmax = null,
    exposure, vessel, rainTier, transplantAt = null } = ctx;

  const spaceDegenerate = weatherRowCount < P.CONFIDENCE.minWeatherRows;
  let weatherMissDays = 0;
  const drv = { ratioToday: null, vesselToday: null, stageToday: null };

  // demand for one ET civil day, in cadence-days per calendar day. Degenerate branches fail to
  // TODAY'S MODEL (1.0), never NaN (canon Decision 3).
  function demandFor(dayStr) {
    if (spaceDegenerate) return 1.0;               // <7 rows: new/backfill-less Space -> flat 1.0 + LOW driver
    if (exposure === 'indoor') return 1.0;         // indoor demand modeling deferred (canon Decision 5)
    const row = weatherByDate[dayStr] || null;
    const isToday = dayStr === todayStr;
    const et0 = row ? row.et0_in : (isToday ? todayEt0 : null); // D0 has no settled row by design; live forecast covers it
    const tmax = row ? row.tmax_f : (isToday ? todayTmax : null);
    // ONE site-wide denominator, never a per-period one (BUG-ETNOAMPLITUDE-001: a per-month
    // reference is a self-reference and cancels the season — see the ledgerParams block).
    let ratio;
    if (et0 == null) { ratio = 1.0; if (!row && !isToday) weatherMissDays++; }   // missing day -> degenerate ratio
    else ratio = clamp(et0 / P.ET0_REF_PEAK, P.DEMAND_CLAMP.min, P.DEMAND_CLAMP.max);
    const vf = (vessel.isFabric
      ? P.FABRIC_BAG.base + P.FABRIC_BAG.rampGain * ramp(tmax, P.FABRIC_BAG.rampLoF, P.FABRIC_BAG.rampHiF)
      : vessel.classFactor) * vessel.sizeFactor;
    const est = transplantAt != null && (() => { const d = calDays(transplantAt, dayStr); return d >= 0 && d < P.STAGE.establishmentDays; })();
    const sf = est ? P.STAGE.establishmentFactor : 1.0;
    if (isToday) { drv.ratioToday = ratio; drv.vesselToday = vf; drv.stageToday = sf; }
    return P.GLOBAL_NORMALIZATION * ratio * vf * sf;
  }

  const windowStartStr = addDays(todayStr, -P.WINDOW_DAYS);
  const windowStartMs = etMidnightMs(windowStartStr);

  // Timeline items. Events: reposition exact-ET-midnight timestamps to 12:00 ET (date-only backdated
  // rows carry no real clock time); drop anything outside [windowStart, effNow].
  const items = [];
  let snoozeCount = 0;
  for (const e of events) {
    if (!e || !Number.isFinite(e.t)) continue;
    const p = etParts(e.t);
    const t = p.msOfDay === 0 ? etMidnightMs(p.date) + 12 * 3600000 : e.t;
    if (t < windowStartMs || t > effNowMs) continue;
    if (e.type === 'moisture_check') snoozeCount++;
    items.push({ t, prio: PRIO[e.type] ?? 0, id: String(e.id), type: e.type, depth: e.depth || null });
  }
  // Gauge/forecast rain day-credits: once per qualifying settled day, at 23:59 ET, outdoor only,
  // transplant carve-out honored per-day. DRG-RAINDEPTH-001: the day's MEASURED precip maps to a
  // depth class (per substrate tier) and the credit is that class's watering arithmetic — not a
  // tier-keyed number of days. bag>=85F demotes one class (a bag in heat does not hold the rain).
  if (exposure === 'outdoor' && !spaceDegenerate) {
    for (let d = windowStartStr; d < todayStr; d = addDays(d, 1)) {
      const row = weatherByDate[d];
      if (!row || row.precip_in == null) continue;
      let depth = rainDepthClass(rainTier, row.precip_in);
      if (depth == null) continue;                                  // trace: under the tier's light floor
      const carved = vessel.smallVessel && transplantAt != null
        && calDays(transplantAt, d) >= 0 && calDays(transplantAt, d) <= P.TRANSPLANT_CARVEOUT_DAYS;
      if (carved) continue;                                         // fresh small root ball: no credit
      if (vessel.isFabric && row.tmax_f != null && row.tmax_f >= P.RAIN_DAY.bagHeatSoftenF) {
        depth = demoteDepth(depth);
        if (depth == null) continue;                                // demoted off the bottom
      }
      const t = etMidnightMs(d) + DAY - 60000;                      // 23:59 ET of the qualifying day
      if (t < windowStartMs || t > effNowMs) continue;
      items.push({ t, prio: PRIO.day_credit, id: d, type: 'day_credit', depth });
    }
  }
  items.sort((a, b) => (a.t - b.t) || (a.prio - b.prio) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Walk. D starts at wi at the window start (canon: "No anchor but waterings exist -> window-start
  // D0 = wi"); any Normal/Deep/rain event inside the window re-bases D through its own op, so for an
  // anchored history the start value only reaches the verdict through the partial-rewet hedges —
  // which is exactly what the hedges are for (a long-dry profile at the latest watering).
  let D = wiEff;
  let t = windowStartMs;
  const accrueTo = (tEnd) => {
    while (t < tEnd) {
      const day = etParts(t).date;
      const segEnd = Math.min(tEnd, etMidnightMs(addDays(day, 1)));
      D += demandFor(day) * (segEnd - t) / DAY;
      t = segEnd;
    }
  };
  // Depth arithmetic, shared by waterings and (DRG-RAINDEPTH-001) rain — one implementation so the
  // two can never drift. allowBank is the ONE asymmetry: a manual Deep may bank below 0 on a
  // banking vessel, rain may NOT. Rain banking would forfeit canon's resurfacing guarantee (the
  // structural property that retired the maxdays ceiling), and a wet week must never be able to
  // push a planting past its own cadence. Deep rain therefore still outranks Normal — it resets
  // flat to 0 and clears the long-dry hedges — it just cannot go negative.
  const applyDepth = (Dcur, depth, allowBank) => {
    if (depth === 'deep') {
      return (allowBank && vessel.banks)
        ? Math.max(Math.min(Dcur, 0) - P.BANK.deepBankWi * wiEff, -P.BANK.bankFloorWi * wiEff)
        : 0;                                                         // container Deep: full reset, clears hedges
    }
    if (depth === 'light') return Math.max(0, Dcur - P.LIGHT_CREDIT_WI * wiEff);
    if (Dcur > P.HEDGE.longDryWi * wiEff) {                          // Normal on a long-dry profile: partial rewet
      return vessel.inGroundClass
        ? Math.min(Dcur - wiEff, P.HEDGE.inGroundCapWi * wiEff)
        : P.HEDGE.containerResetWi * wiEff;
    }
    return 0;
  };
  for (const it of items) {
    accrueTo(it.t);
    if (it.type === 'watering') {
      const depth = it.depth === 'deep' ? 'deep' : it.depth === 'light' ? 'light' : 'normal'; // absent/unknown = normal
      D = applyDepth(D, depth, true);
    } else if (it.type === 'rain') {
      // A rain event with NO depth is a MANUAL log — Dave watching it pour and calling these
      // watered — and keeps canon Decision 12 full-reset semantics. A depth-carrying rain event is
      // gauge-written (metadata.water_depth_source='rain_gauge') and folds like a watering.
      D = it.depth ? applyDepth(D, it.depth, false) : 0;
    } else if (it.type === 'moisture_check') {
      D = Math.min(D, Math.max(0, thr - Math.max(P.SNOOZE.minFloorWi * wiEff, demandFor(etParts(it.t).date))));
    } else if (it.type === 'day_credit') {
      D = applyDepth(D, it.depth, false);                            // never banks negative (see applyDepth)
    }
  }
  accrueTo(effNowMs);

  // Verdict + integer-calendar derivations (canon payload contract). demandToday > 0 always
  // (clamp floor x min factors), so the divisions cannot blow up.
  const demandToday = demandFor(todayStr);
  const due = D >= thr;
  const overdueBy = due ? Math.max(0, Math.floor((D - thr) / demandToday)) : null;
  const dueAtMs = due
    ? effNowMs - ((D - thr) / demandToday) * DAY
    : effNowMs + ((thr - D) / demandToday) * DAY;

  const drivers = [
    { factor: 'demand_today', value: r2(demandToday) },
    ...(drv.ratioToday != null ? [{ factor: 'et0_ratio', value: r2(drv.ratioToday) }] : []),
    ...(drv.vesselToday != null ? [{ factor: 'vessel', value: r2(drv.vesselToday) }] : []),
    ...(drv.stageToday != null && drv.stageToday !== 1 ? [{ factor: 'stage', value: drv.stageToday }] : []),
    { factor: 'exposure', value: exposure },
    ...(vessel.unsized ? [{ factor: 'unsized', value: true }] : []),
    ...(spaceDegenerate ? [{ factor: 'weather_degraded', value: true }] : []),
    ...(weatherMissDays > 0 ? [{ factor: 'weather_missing_days', value: weatherMissDays }] : []),
    ...(snoozeCount > 0 ? [{ factor: 'snoozes_30d', value: snoozeCount }] : []),
  ];

  return { d: D, thr, wiEff, due, overdueBy, dueAtMs, demandToday, snoozeCount, spaceDegenerate, drivers };
}

// ── Engine-facing option bag (one per generatePlan call/space) ───────────────────────────────────
// Coerces weather_daily numerics (the neon driver returns numeric columns as STRINGS on real
// Postgres; mock-sql fixtures pass numbers — both must fold identically) and clamps the run instant
// into the plan day: a `--today <past>` replay pins to end-of-day, a live run keeps its real clock.
function buildLedgerOpts({ weatherDaily = null, eventsByPlant = null, today, nowMs = null }) {
  const weatherByDate = {};
  let n = 0;
  for (const r of (Array.isArray(weatherDaily) ? weatherDaily : [])) {
    if (!r || typeof r.date !== 'string') continue;
    weatherByDate[r.date.slice(0, 10)] = {
      et0_in: num(r.et0_in), tmax_f: num(r.tmax_f), tmin_f: num(r.tmin_f), precip_in: num(r.precip_in),
    };
    n++;
  }
  const dayStart = etMidnightMs(today);
  const dayEnd = etMidnightMs(addDays(today, 1));
  const raw = nowMs == null ? dayStart + 2 * 3600000 : nowMs;   // default = the 02:00 nightly slot
  const effNowMs = clamp(raw, dayStart, dayEnd);
  return { enabled: true, eventsByPlant: eventsByPlant || {}, weatherByDate, weatherRowCount: n, effNowMs };
}

module.exports = {
  foldLedger, buildLedgerOpts, computeConfidence, exposureClass, vesselProfile,
  parseContainerGal, sizeBucket, inchDiameterGal,
  rainDepthClass, demoteDepth,
  etParts, etMidnightMs, addDays, calDays,
};
