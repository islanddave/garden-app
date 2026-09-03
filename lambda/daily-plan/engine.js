'use strict';
// Daily Plan Engine v3 — pure generator (DRG-TODAY-001). Adds SUBSTRATE-AWARE fertilization:
// holds feeding while the MG 3-6mo slow-release mix is active, then recommends a specific IN-INVENTORY
// amendment by crop+stage, sprayer-default for liquids, hard-well-water aware. Per-variety cadence,
// never-logged-aware, temp-aware, per-variety cold, strict per-user. No I/O; caller passes today/weather/cadence/fertModel.
const DAY = 86400000;
const HOT_F = 88;
// V4-WATERMATH-001 F2 — the Water Ledger fold (flag-gated: CARE_WATER_LEDGER_ENABLED, default OFF).
// engine requires ledger, NEVER the reverse; shared rain-IA constants are mirrored in ledgerParams
// and pinned equal by ledger.test.js.
const ledger = require('./ledger');
const LP = require('./ledgerParams');
// V4-TROPICALCOLD-001 — crop-type cold profiles (the bring-indoors fallback beneath the variety table).
const fc = require('./frostClass');
// V4-OVERWINTER-001 — overwintering as a care_profile ATTRIBUTE (never a plants.status value). Holds a
// planting out of the summer water/feed cadence and gives it a REDUCED-cadence moisture check instead;
// the window is a pure function of the date, so the exit needs no writer. See overwinter.js header.
const ow = require('./overwinter');
// DRG-WXPROB-001 — display gate for the nightly rain-AMOUNT callout (mirrors the Today widget). Presentation only.
const RAIN_POP_DISPLAY_THRESHOLD = 30; // percent
// DRG-WATERCREDIT-004: fabric grow bags have breathable sidewalls and dry top-to-bottom fast in heat, so a
// light/moderate rain that would credit a rigid pot or bed does NOT keep a fabric bag wet on a hot day. On
// days at/above this threshold we withhold rain credit for fabric_bag vessels (outdoor only) so a real
// watering isn't suppressed. Intentionally LOWER than HOT_F (88, the drought-cadence accelerator): bags lose
// moisture at more moderate heat than the cadence bump warrants. Scoped to fabric_bag; rigid/in-ground retain credit.
const BAG_HEAT_GATE_F = 85;
// DRG-WATERRECON-002: canonical version stamped into the stored daily_plan.items jsonb (by handler.js).
// The dashboard bar (lambda/dashboard/handlers.js) and the Today reader (lambda/daily-plan-read/index.js)
// assert this value and FAIL LOUD on mismatch — a silent field-rename/shape-drift would otherwise yield an
// empty/garbage watering verdict. Bump ONLY when the items task-array shape changes, in lockstep with both
// readers' PLAN_SCHEMA_VERSION literals (pinned by an anti-drift source test).
const PLAN_SCHEMA_VERSION = 1;
const PEPPER_TOMATO = /pepper|tomato|eggplant|tomatillo|chile|chili|capsicum|solanum/i;

function daysBetween(today, iso){ if(!iso) return null;
  const d0=new Date(iso.slice(0,10)+'T00:00:00Z').getTime(), t0=new Date(today.slice(0,10)+'T00:00:00Z').getTime();
  return Math.floor((t0-d0)/DAY); }
function weeksSince(today, iso){ const d=daysBetween(today,iso); return d==null?null:Math.floor(d/7); }

function resolveCadence(p, cad){
  // CARE-CADENCE-001 / BUG-SEEDEDGATE-001: prefer the DB-resolved per-cultivar/leaf profile
  // (v_resolved_care) when a scope actually CONTRIBUTED A CADENCE KEY; else the bundled
  // cadence-data-v2.json.
  //
  // PROVENANCE IS STRUCTURAL, NOT IN-PAYLOAD. The old test was an in-blob `_seeded` marker, and nine
  // researched cultivar profiles carry a DIFFERENT marker (_source: cowork_care_audit_20260709 on
  // eight, source: dave_confirmed on Collards), so their intervals were invisible and six live
  // plantings watered on bundled guesses while their own high-confidence numbers sat unread.
  //
  // p.cadence_scopes is v_resolved_care.cadence_scopes: the scopes that supplied a NON-NULL
  // water_interval_days{,_container,_inground}. 'system' is deliberately never in it — the house
  // 3-day constant is not evidence of knowledge — so [] means "nothing in the DB knows how often to
  // water this", the bundled fallback runs exactly as before, and that empty count IS the
  // DRG-CADENCEFLOOR-001 unresolved signal (103 of 249 active plantings on prod, 2026-08-07).
  //
  // WHY NOT "just delete the _seeded check": v_resolved_care merges system||cultivar||leaf with the
  // jsonb || operator — a SHALLOW, TOP-LEVEL, RIGHT-WINS merge. The system row carries
  // water_interval_days, and 146 of 159 cultivar rows express cadence under the DIFFERENT key names
  // *_container / *_inground, so the system value is never shadowed. Every resolved_profile
  // therefore carries a plausible 3-day interval whether or not anyone researched the plant, and a
  // system-only row is indistinguishable from a researched one without this signal.
  //
  // READS cadence_scopes, NEVER resolved_scopes. resolved_scopes says a row EXISTS. Verified on prod
  // 2026-08-07: Collards has resolved_scopes {system,cultivar} and cadence_scopes {} — its cultivar
  // profile carries container sizing and, by its own _scope_note, DELIBERATELY no watering keys. A
  // resolved_scopes predicate would adopt it, and because that merged profile has no *_container key
  // at all it would land on cad.default and move Collards 2d -> 3d against its author's written
  // intent: a regression shipped inside the fix. That one row is why there are two columns.
  //
  // FLAG: the _seeded arm below is the CARE_CADENCE_SCOPES_ENABLED=OFF path ONLY. handler.js nulls
  // the column on every row when the flag is off, so `cs` is not an array and the legacy marker test
  // runs -> byte-identical plan. Flag ON does not consult _seeded at all, which is safe because the
  // 150 seeded cultivar rows are a STRICT SUBSET of the 158 cadence-bearing ones (verified on prod:
  // zero seeded-but-not-bearing rows), so nothing resolving _via 'db' today stops doing so.
  //
  // Array.isArray is also the fail-safe if the driver ever hands text[] back as the raw '{cultivar}'
  // string: a non-array degrades to the flag-OFF answer, never to a wrong interval.
  const cs = p && p.cadence_scopes;
  const adopt = Array.isArray(cs) ? cs.length > 0
                                  : !!(p && p.db_cadence && p.db_cadence._seeded); // legacy; flag-OFF only
  if(p && p.db_cadence && adopt) return {...p.db_cadence, _via:'db'};
  const byV=cad.by_variety||{};
  const key=[p.variety, p.name].find(k=>k && byV[k]);
  if(key) return {...byV[key], _via:'variety:'+key};
  const gf=(cad.by_genus_fallback||{})[p.genus];
  if(gf) return {crop:p.genus, ...gf, _via:'genus:'+p.genus};
  return {crop:p.genus||'unknown', ...cad.default, _via:'default'};
}

// MG feed phase from weeks since potting into fresh mix.
function feedPhase(wk){
  if(wk==null) return 'unknown';
  if(wk<=2) return 'establishment_0_2wk';
  if(wk<=12) return 'mg_active_3_12wk';
  if(wk<=24) return 'mg_tapering_13_24wk';
  return 'needs_feed_24wk_plus';
}
function isAcidLover(crop){ return /blueberr|vaccinium/i.test(crop||''); }
function isMedHerb(crop){ return /oregano|rosemary|sage|thyme|tarragon|lavender/i.test(crop||''); }
function isHeavyFeeder(crop){ return /pepper|tomato|squash|melon|cucumber|broccoli|cabbage|eggplant|tomatillo/i.test(crop||''); }
function isLeafy(crop){ return /lettuce|spinach|arugula|chard|endive|basil|kale|parsley/i.test(crop||''); }
function isCucurbit(p,crop){ const t=((p.name||'')+' '+(p.variety||'')+' '+(crop||'')).toLowerCase();
  return /cucumis|citrullus|cucurbita|luffa|melothria|momordica/i.test(p.genus||'') || /squash|zucchini|cucumber|melon|loofah|gourd|cucamelon|zephyr/.test(t); }
function isLeek(p,crop){ return /leek/i.test(((p.name||'')+' '+(p.variety||'')+' '+(crop||'')).toLowerCase()); }
// Dave is the responsible party for cucurbits + leeks + in-ground (his explicit call) — these never default to Jen.
function ownerFor(p,c,fallback){ if(p.assignee_user_id) return p.assignee_user_id;
  if(isCucurbit(p,c&&c.crop)||isLeek(p,c&&c.crop)) return fallback; return fallback; }
function likelyInGround(p,c){
  // CARE-PROFILES-001: prefer explicit container_type when set; fall back to crop heuristic.
  if(p.container_type) return p.container_type==='in_ground'||p.container_type==='raised_bed';
  return isCucurbit(p,c&&c.crop)||isLeek(p,c&&c.crop);
}

// ── DRG-WATERCREDIT-001 — Path B-plus rain credit, V1 2-class (crucible verdict 2026-06-18; Dave 2026-06-21) ──
// Retire the global 0.3in cutoff. Subtract an initial-abstraction (first-wetting/runoff/canopy loss) then credit
// the remaining rain over the 2-3 day window the engine already reads (recent D-2..D0), capped at one cadence
// cycle. Stateless; manual watering resets naturally (dW from event_log); fresh transplants carved out.
// V1 KEYING = covered-vs-outdoor ONLY. bed-vs-container is NOT in the data (container_type ~unpopulated; a single
// location mixes beds + bags), so the per-class bed/container split is deferred to V1.1 once a per-planting vessel
// signal exists. 'covered' (under cover -> never credited) is supplied by the handler (location-derived, Dave-
// classified). Outdoor uses one conservative shared profile (higher soak-in threshold + short hold) — safe for the
// container/bag-dominant reality, and a light rain on a deep bed is correctly ~nothing anyway.
const RAIN_IA = { outdoor: 0.25 };   // initial abstraction, inches — single conservative outdoor profile (V1)
const RAIN_HOLD_DAYS = 1;            // short hold (days) for the shared outdoor default; bed full-cycle hold returns in V1.1
const TRANSPLANT_CARVEOUT_DAYS = 21; // fresh root ball dries fast even when the bed reads moist -> no rain credit
// DRG-WATERCREDIT-003 (vessel-aware carve-out, 2026-06-24): the fresh-transplant rain-credit denial applies ONLY to
// genuinely small root balls (cells, plugs, solo cups, <=4in / <=1qt pots) which dry top-to-bottom in hours so a light
// rain doesn't reliably reach the root zone. Established LARGE vessels (5-gal fabric bags, troughs, beds, in-ground,
// barrels) get normal rain credit even when recently transplanted -- a 3-week-old 5-gal bag is not a fresh root ball.
// Unknown/null vessel within the window FAILS SAFE to small (deny credit -> water it). Container vocab per the DB
// container_type CHECK; size is free-text (e.g. '5 gal','3 in','6x2 ft','0.5qt').
const SMALL_VESSEL_TYPES = new Set(['tray_cell','soil_block','solo_cup']);
const LARGE_VESSEL_TYPES = new Set(['in_ground','raised_bed','trough','whiskey_barrel','window_box','hanging_basket']);
function vesselSizeSmall(size){
  if(!size||typeof size!=='string') return null;                       // unknown -> caller decides
  const m=size.toLowerCase().match(/([\d.]+)\s*(inch|in\b|\"|quart|qt\b|gallon|gal\b|foot|feet|ft\b|cm\b|liter|l\b)/);
  if(!m) return null;
  const n=parseFloat(m[1]); if(!Number.isFinite(n)) return null;
  const u=m[2];
  if(u==='inch'||u.startsWith('in')||u==='\"') return n<=4;            // <=4in root ball = small
  if(u==='quart'||u.startsWith('qt')) return n<=1;                      // <=1qt = small
  if(u==='cm') return n<=10;                                            // ~4in
  if(u==='liter'||u==='l') return n<=1;                                 // <=1L ~ 1qt
  return false;                                                        // gallon/ft/foot/feet => established/large
}
function isSmallVessel(p){
  const t=((p&&p.container_type)||'').toLowerCase();
  if(SMALL_VESSEL_TYPES.has(t)) return true;
  if(LARGE_VESSEL_TYPES.has(t)) return false;
  const s=vesselSizeSmall(p&&p.container_size);
  if(s!=null) return s;
  return true;                                                         // unknown vessel in carve-out window -> fail safe (deny credit, water it)
}
// ── BUG-CADENCESIZE-001 — vessel floor under the watering interval (2026-08-18) ───────────────────
// The interval derivation below is size-blind: a 6x2 ft trough, a 15-gal whiskey barrel and a 5-gal
// fabric bag all take the cultivar's single `_container` number, because the data model has one number
// per cultivar and no way to condition it on the vessel. This raises a FLOOR for vessels whose reservoir
// makes a 24h cycle indefensible. Floor only, and capped at DAILY_FLOOR_DAYS: it can move wi 1->2 and
// nothing else, so the worst case it can cause is a one-day delay, never a multi-day one.
//
// NOT the `_inground` arm, which is the obvious-looking alternative. Measured against live prod
// 2026-08-18, the trough peppers' own `_inground` values are 3-5 — a 3-5x jump on August peppers, on
// vessels that still have a bottom. A bounded +1 is defensible from the notes; 1->5 is not.
//
// FABRIC BAGS ARE EXCLUDED AT EVERY SIZE, 10 and 20 gal included, and that is the deliberate departure
// from a plain gallon threshold. Their profile notes are authored for the bag the planting is actually
// in and still say daily: "10+ gal bags heavy daily", "1-1.5 gal daily in 10-15 gal bag June", and for
// the 20-gal Jet Star "1-2 gal am+pm in 85F+ ... check twice daily 85F+". A bag evaporates through every
// wall and air-prunes, which is why fabric already gets its own evaporative treatment in this engine
// (bagHeatGate) and its own per-day heat ramp in ledgerParams (FABRIC_BAG). Volume does not buy a bag a
// second day, and overriding 18 researched notes with a gallon constant would re-commit the very
// unresearched-constant defect this fix exists to remove.
//
// FAIL-SAFE — an unknown vessel never earns the floor, in either direction:
//   * Reservoir TYPES qualify on the type alone (their size is implied by the type, exactly as ledger's
//     SIZE_IMPLIED treats them), so a NULL/garbage `container_size` does not weaken them — nothing is
//     being inferred from an unknown there.
//   * Every other type must present a PARSED volume >= largeMinGal. NULL, absent, or unparseable leaves
//     wi exactly where today's engine puts it: still daily, still prompting. That is the same
//     err-toward-watering direction isSmallVessel and rainTierFor already take on an unknown vessel.
const DAILY_FLOOR_DAYS = 2;
// Deep soil masses. Deliberately NOT LARGE_VESSEL_TYPES: that set answers "is this a fresh small root
// ball?" for the transplant carve-out and so carries hanging_basket + window_box, which are fast-drying
// and must keep their daily cadence. in_ground/raised_bed normally take the `_inground` arm and never
// reach this floor; they are listed anyway so the rule is COMPLETE (no reservoir vessel can hold a 1-day
// cycle) rather than arbitrary, which also closes the documented `_inground`-absent fallthrough where a
// genus stub with no `_inground` key hands an in-ground bed its 1-day container number. Zero live rows
// take that path today.
const RESERVOIR_VESSEL_TYPES = new Set(['in_ground','raised_bed','trough','whiskey_barrel']);
// Rigid, non-breathing pots — they hold their water instead of wicking it out the sides, so a genuinely
// large one earns the floor. Gated on parsed volume, never on the type alone (most of these are small).
const RIGID_POT_TYPES = new Set(['ceramic','terracotta','plastic_pot','pot','other']);
// Returns the floor in days, or null for "leave the interval alone".
function dailyFloorFor(p){
  const ct=((p&&p.container_type)||'').toLowerCase();
  if(RESERVOIR_VESSEL_TYPES.has(ct)) return DAILY_FLOOR_DAYS;
  if(!RIGID_POT_TYPES.has(ct)) return null;                            // fabric_bag, tray class, unknown/NULL type
  const gal=ledger.parseContainerGal(p&&p.container_size);
  return (gal!=null && gal>=LP.SIZE_BUCKETS.largeMinGal) ? DAILY_FLOOR_DAYS : null;
}
// BUG-NOLOCOUTDOOR-001: reads the handler's resolved flag, NOT the raw `covered` boolean.
// Was `p.covered ? 'none' : 'outdoor'`, which is why a NULL tri-state could not be used directly:
// NULL is FALSY, so an unknown location would have taken the 'outdoor' branch — the very bug — while
// frostClass's `=== true` test would have handled the same NULL correctly. A tri-state whose
// correctness depends on which comparison a given consumer happened to write is a coin flip, so the
// handler resolves it into two plain booleans and each consumer reads its own.
// rain_exposed_resolved is `state IS FALSE`, so unknown => false => 'none' => never rain-credited.
function rainClass(p){ return p.rain_exposed_resolved ? 'outdoor' : 'none'; }
function windowPrecip(hy){
  if(!hy || hy.recent_precip_in==null) return null;                 // missing precip -> no credit (uncertainty handled in hydrologyStatus)
  // BUG-TODAYWATER-001: this is D-2..D-1 ACTUALS + D0, not "D-2..D0 actuals" as this comment used to claim.
  // BUG-RAINACTUAL-001 then changed what the D0 term MEANS: with a bound gauge, station.mergeStationHydrology
  // sets today_precip_in = today_observed_in + today_remaining_in — rain the WS-2902 has already MEASURED plus
  // the hourly forecast for the hours not yet elapsed — so by the 15:30 run it is essentially the gauge total.
  // With no station it is still Open-Meteo precipitation_sum[2] read at ~02:01 for a day that has not started
  // (index.js). So the D0 term is part-measured/part-predicted, in a ratio that moves through the day, and any
  // gate that must distinguish the two reads today_observed_in / today_remaining_in — never this sum.
  return (hy.recent_precip_in||0) + (hy.today_precip_in||0);
}
// BUG-RAINFORECASTCREDIT-001 — the precipitation basis RAIN CREDIT is allowed to spend.
//
// windowPrecip's own comment above states the rule this function exists to honour: the D0 term is
// today_observed_in + today_remaining_in, "part-measured/part-predicted, in a ratio that moves through
// the day", and "any gate that must distinguish the two reads today_observed_in / today_remaining_in --
// never this sum." Rain credit is the strongest such gate in the engine: it decides whether a live plant
// is skipped. It read the sum anyway, so a forecast that never arrived could retire a real watering.
//
// Measured 2026-08-23 on prod v4.45.0: 35 plantings skipped while only 0.09" had actually fallen -- 0.13"
// of the credited 0.22" was still forecast. Worse at the 02:00 run, where index.js reads Open-Meteo
// precipitation_sum[2] "for a day that has not started": there the D0 term is 100% prediction, and the
// 02:00 run is the one that builds the morning task list. So the DEFAULT daily experience was the fully
// forecast case, not the part-measured one.
//
// The shape is deliberately identical to saturationSuppressed's soakBasis (:458), which already solved
// this for the cap under BUG-TODAYWATER-001 -- actuals judge water in the media, forecast is judged
// separately with its own PoP bars. This makes the credit path consistent with the cap path rather than
// inventing a second vocabulary. today_observed_in is ABSENT with no bound station, so the term is 0
// there: no gauge => today contributes no credit, which is the fail-safe direction (canon 20260710 4.3:
// never suppress a baseline watering cue on unverified rain).
//
// Flag-gated default-OFF so an un-updated caller and every existing fixture stay byte-identical.
function creditPrecip(hy, measuredOnly){
  if(!hy || hy.recent_precip_in==null) return null;
  if(!measuredOnly) return windowPrecip(hy);
  return (hy.recent_precip_in||0) + (hy.today_observed_in||0);
}
// Returns { credit_days, wp, eff } when rain qualifies for credit, else null.
function rainCreditDays(cls, wi, hy, measuredOnly=false){
  if(cls!=='outdoor') return null;                                  // covered/indoor never credited
  const wp = creditPrecip(hy, measuredOnly); if(wp==null) return null;
  const eff = wp - RAIN_IA.outdoor;
  if(eff <= 0) return null;                                         // didn't clear first-wetting loss
  return { credit_days: Math.min(RAIN_HOLD_DAYS, wi), wp: Math.round(wp*100)/100, eff: Math.round(eff*100)/100 };  // cap at one cycle
}

// ── DRG-WXWATER-001 coarse-v1 — 3-substrate-tier rain model (flag-gated: CARE_RAIN_CREDIT_ENABLED, default OFF) ──
// Extends the single-outdoor DRG-WATERCREDIT-001 profile (RAIN_IA.outdoor 0.25 / RAIN_HOLD_DAYS 1) into three
// substrate tiers keyed on container_type: bigger reservoir => rain persists longer (higher hold) and clears a
// lower initial-abstraction; small fast-drying vessels => aggressive discount (short hold — a qualifying rain
// doesn't LAST in a fabric bag). NEW SYMBOLS ONLY: RAIN_IA / RAIN_HOLD_DAYS are left untouched so the flag-OFF
// path (and watercredit.test.js's RAIN_IA.in_ground===undefined assertion) stays byte-identical. Constants are the
// agronomy coarse-v1 values (W. MA cool-humid, clay-ish native soil); the flagged uncertain ones are soak-tunable
// (spec §6/§8 — err toward watering: raise IA, shorten hold, tighten ceiling; in_ground IA is the #1 tune target).
// BUG-RAINCREDITLIVEPATH-001: fabric_ground ports RAIN_DEPTH_TIER_OVERRIDE's bed-equivalence onto this LIVE
// flag-OFF-ledger path. Values equal in_ground deliberately (same intent as ledgerParams.RAIN_DEPTH.fabric_ground).
// small_fast is UNCHANGED and stays the strictest row + the NULL/unknown fallback (see the invariant at :197-208).
const RAIN_TIER_IA   = { in_ground: 0.20, intermediate: 0.25, small_fast: 0.35, fabric_ground: 0.20 }; // inches (initial abstraction per tier)
const RAIN_TIER_HOLD = { in_ground: 3,    intermediate: 2,    small_fast: 1,    fabric_ground: 3     }; // max credit days per tier; never raise small_fast
// Vessel -> tier. Covers the full DB container_type CHECK vocab (14 values, verified prod 2026-07-08) + the generic
// 'pot' used in fixtures. Rigid pots (plastic/terracotta/ceramic/'pot') are small_fast: generic unknown-size pots dry
// fast; large rigid pots re-tag to trough.
// FAIL-SAFE INVARIANT (both resolvers below): an unrecognized/NULL container_type must get the LEAST credit of any
// row in the table being keyed -> water it. That is a property of the TABLE, not of a tier name, and the two tables
// no longer agree on which row satisfies it:
//   RAIN_TIER_IA/HOLD + RAIN_MAX_DAYS (this file, live flag-OFF) -> small_fast is still strictest (highest IA 0.35,
//     lowest hold 1, tightest ceiling), so rainTierFor's 'small_fast' fallback remains CORRECT. Do not "fix" it.
//   RAIN_DEPTH (ledgerParams, F2) -> has its OWN explicit 'unknown' row, strictly stricter than every named tier.
//     rainDepthTierFor exists for that table and resolves unrecognized/NULL to 'unknown', never to a named tier.
//     (History: for a few hours on 2026-08-17 small_fast was flattened to the in_ground values there, which made
//     the shared 'small_fast' fallback hand unknown vessels bed-equivalent credit — the exact inversion of this
//     invariant. small_fast has since been restored; the separate resolver and the explicit unknown row stay,
//     because the failure was a NAMED ALIAS encoding one day's ordering, not the particular values.)
// Re-check this comment against BOTH tables whenever either is retuned.
// BUG-RAINCREDITLIVEPATH-001 (2026-08-18): the tables now BOTH carry a fabric_ground row, so the size-gated
// fabric_bag divergence is no longer RAIN_DEPTH-only. The fail-safe invariant is unaffected in either direction:
// fabric_ground is reachable ONLY from an explicitly-typed fabric_bag WITH a parsed size >= 3 gal, never from a
// fallback, and small_fast remains the strictest row of RAIN_TIER_IA/HOLD/RAIN_MAX_DAYS.
const RAIN_VESSEL_TIER = {
  in_ground: 'in_ground',
  raised_bed: 'intermediate', trough: 'intermediate', whiskey_barrel: 'intermediate', window_box: 'intermediate',
  hanging_basket: 'small_fast', fabric_bag: 'small_fast', tray_cell: 'small_fast', soil_block: 'small_fast',
  solo_cup: 'small_fast', plastic_pot: 'small_fast', terracotta: 'small_fast', ceramic: 'small_fast',
  pot: 'small_fast', other: 'small_fast',
};
const FABRIC_GROUND_MIN_GAL = 3;
// sizeGal is OPTIONAL and is vesselProfile().sizeGal (parsed gallons, or null). Omitted, null or unparseable ->
// the strict pre-existing row, so every pre-BUG-RAINCREDITLIVEPATH-001 caller and every unsized/unknown vessel
// keeps today's verdict. Only an explicitly-typed fabric_bag with a parsed size >= FABRIC_GROUND_MIN_GAL moves.
// Failing to parse a size therefore errs toward WATERING — the same direction vesselProfile.smallVessel takes.
function rainTierFor(container_type, sizeGal){
  const ct = (container_type||'').toLowerCase();
  const base = RAIN_VESSEL_TIER[ct] || 'small_fast';
  if(ct !== 'fabric_bag') return base;
  return (Number.isFinite(sizeGal) && sizeGal >= FABRIC_GROUND_MIN_GAL) ? 'fabric_ground' : base;
}
// F2/RAIN_DEPTH sibling of rainTierFor. Still kept separate: the two tables disagree on which row is the fail-safe
// (RAIN_DEPTH has an explicit 'unknown' row; RAIN_TIER_IA/HOLD does not), so the resolvers cannot share a fallback.
// Since BUG-RAINCREDITLIVEPATH-001 only ONE divergence remains, and it is the fallback:
//   1. unrecognized/NULL container_type -> 'unknown' instead of collapsing into 'small_fast' (small_fast IS still
//      the strictest IA/hold row, so rainTierFor's fallback stays correct; editing it would loosen live verdicts
//      for every NULL-container planting — ~22 in prod: IA 0.35->0.25, hold 1->2).
// FORMERLY divergence 2 — fabric_bag -> 'fabric_ground' above sizeGal >= FABRIC_GROUND_MIN_GAL — is now shared by
// both resolvers and is pinned as shared by ledger.test.js. The evidence for bed-equivalent retention is Dave's
// 5-10 gal bags: fabric on soil, mulched, clustered. A small bag has the fabric but not the buffer — one live
// fabric_bag is recorded as "3 in" (parses to 0.06 gal) — and an UNPARSEABLE size is treated the same as a small one.
const RAIN_DEPTH_TIER_OVERRIDE = { fabric_bag: 'fabric_ground' };
function rainDepthTierFor(container_type, sizeGal){
  const ct = (container_type || '').toLowerCase();
  const base = RAIN_VESSEL_TIER[ct];
  if (!base) return 'unknown';
  const override = RAIN_DEPTH_TIER_OVERRIDE[ct];
  if (!override) return base;
  return (Number.isFinite(sizeGal) && sizeGal >= FABRIC_GROUND_MIN_GAL) ? override : base;
}
// Max-days ceiling: clamps the watering interval before the due-check so a rain-credited planting still re-surfaces
// for a moisture check (anti suppression-inversion). tier x stage; +1 for drought-tolerant Mediterranean herbs,
// -1 for steady-moisture leafy/Solanaceae at flowering/fruiting (bolt / split / blossom-end-rot on swings), floor 1.
const RAIN_MAX_DAYS = {
  small_fast:   { seedling: 1, vegetative: 2, flowering: 2, fruiting: 1, mature: 2 },
  intermediate: { seedling: 2, vegetative: 3, flowering: 3, fruiting: 2, mature: 4 },
  in_ground:    { seedling: 2, vegetative: 4, flowering: 3, fruiting: 3, mature: 5 },
  // BUG-RAINCREDITLIVEPATH-001. Inert today (CARE_RAIN_MAXDAYS_ENABLED is absent from the live Lambda env), but
  // REQUIRED: without it, enabling that flag makes rainMaxDays read RAIN_MAX_DAYS.fabric_ground -> undefined for
  // every big bag. Mirrors in_ground, matching the tier's IA/hold.
  fabric_ground:{ seedling: 2, vegetative: 4, flowering: 3, fruiting: 3, mature: 5 },
};
function rainStageFor(status){ const s=(status||'').toLowerCase();
  if(s==='seedling'||s==='germinated'||s==='sown') return 'seedling';
  if(s==='vegetative') return 'vegetative';
  if(s==='flowering') return 'flowering';
  if(s==='fruiting'||s==='fruit_set') return 'fruiting';
  return 'mature'; }   // active/harvested/mature/unknown -> mature (loosest column, still capped)
function rainMaxDays(tier, status, crop){
  const stage=rainStageFor(status);
  const base=(RAIN_MAX_DAYS[tier]||RAIN_MAX_DAYS.small_fast)[stage];
  if(base==null) return null;
  const c=(crop||'').toLowerCase();
  let mod=0;
  if(isMedHerb(c)) mod=1;                                                                 // deep taproot, wilt-tolerant
  else if((isLeafy(c)||PEPPER_TOMATO.test(c)) && (stage==='flowering'||stage==='fruiting')) mod=-1; // steady-moisture crops
  return Math.max(1, base+mod); }
// Tiered rain credit — mirrors rainCreditDays but with per-tier IA + hold. Returns {credit_days,wp,eff,tier} or null.
function rainCreditDaysTiered(tier, wi, hy, measuredOnly=false){
  const ia = RAIN_TIER_IA[tier] ?? RAIN_TIER_IA.small_fast;
  const hold = RAIN_TIER_HOLD[tier] ?? RAIN_TIER_HOLD.small_fast;
  const wp = creditPrecip(hy, measuredOnly); if(wp==null) return null;
  const eff = wp - ia;
  if(eff<=0) return null;
  return { credit_days: Math.min(hold, wi), wp: Math.round(wp*100)/100, eff: Math.round(eff*100)/100, tier }; }

// BUG-HEATDEMOTETOTAL-001 — the >=85F fabric-bag rule was a DENIAL, not the demotion it was documented
// as. The call site read `(freshTransplant||bagHeatGate) ? null`, so an outdoor bag that had EARNED the
// full fabric_ground credit got zero at any rain depth. Measured on this engine, 5-gal bag / 0.5" window
// rain / wi=3, under the LIVE prod config (CARE_RAIN_CREDIT_ENABLED=true): 84F -> 3 credit-days,
// 85F -> 0, 90F -> 0. A 3-day cliff across 1°F, on a gridded tmax carrying +-2-3F of error.
// The demotion is a SCALAR on the earned credit, floored — both numbers named in ledgerParams
// (bagHeatSoftenFactor was declared for this path and, until now, read by nothing). The floor is what
// keeps this a demotion under a future retune; see the ledgerParams block for why that is structural
// rather than fussy. Returns the rc unchanged when nothing was earned — a gate that fires on no credit
// has nothing to withhold, and the caller's note must not claim otherwise.
// SEPARATE from the ledger path's rule: that one is ledger.demoteDepth's one-class walk, whose
// flip-time replacement is deliberately deferred by crucible verdict C5. Do not fold the two.
function bagHeatDemoteCredit(rc){
  if(!rc) return rc;
  const d=Math.max(LP.RAIN_DAY.bagHeatMinCreditDays, Math.floor(rc.credit_days*LP.RAIN_DAY.bagHeatSoftenFactor));
  return { ...rc, credit_days: d, bag_heat_from: rc.credit_days }; }

// ── DRG-WXSATCAP-001 heavy-soak saturation cap (FLAG-INDEPENDENT; Dave-approved constants 2026-07-30) ──
// Over-watering already-saturated media (esp. fabric bags with no drying window) drives anoxia / root rot =
// NON-recoverable, so in the heavy-soak regime the safe error inverts to "skip". Applies to ALL outdoor vessels
// UNIFORMLY: rain depth saturates media regardless of vessel, and container_type is ~unpopulated so a
// vessel-agnostic gate is the only design robust to the dominant NULL case (NULL is outdoor -> suppressed ->
// fails safe). covered/indoor never got the rain -> exempt. Independent of CARE_RAIN_CREDIT_ENABLED so the
// eventual credit-ON flip cannot bypass it. Recovery is automatic as the 72h windowPrecip decays (no counter).
// BUG-TODAYWATER-001 (2026-08-12) — these four moved OUT of this file. They are now required from
// wateringThresholds.json, which src/lib/wateringScale.js (the WeatherWidget headline on Today)
// imports from this same path. Until this change the widget owned a private, unharmonized copy —
// 0.8" with no probability gate at all — so on 2026-08-03 (0.98") and 2026-08-08 (0.99") the two
// models straddled the same number and Today printed "All set — no watering needed today." above a
// full watering list. The file lives in THIS directory because deploy-lambda.yml packages it with
// `zip -r .`, so the engine's copy ships with no workflow change; the client bundles it at build.
// Values are unchanged — this is a re-homing, not a retune. src/lib/wateringModelParity.test.js
// fails if either module reintroduces a literal.
const SOAK_THRESHOLDS = require('./wateringThresholds.json');
const SOAK_CAP_IN = SOAK_THRESHOLDS.SOAK_CAP_IN;                 // >= this over the 72h windowPrecip -> suppress outdoor watering
const SOAK_WET_FLOOR_IN = SOAK_THRESHOLDS.SOAK_WET_FLOOR_IN;     // "already moist" prerequisite for the incoming-rain trigger
const SOAK_FCST_QPF_IN = SOAK_THRESHOLDS.SOAK_FCST_QPF_IN;       // incoming 24h amount that counts
const SOAK_FCST_POP_PCT = SOAK_THRESHOLDS.SOAK_FCST_POP_PCT;     // min PoP for an incoming-rain skip
// BUG-SOAKBAR-001 (2026-08-12) — was 2.0", now DERIVED. The cost asymmetry below is real and unchanged;
// what was wrong is that 2.0" was picked to express it rather than computed, so it asserted that a small
// vessel needs 2" of rain to bank one day of water. It does not, and Dave's own observation says so:
// his containers are VERY happy on 0.075"/day, mulched, and he inspects them daily.
//
// DERIVATION (every input is either Dave-observed or already shipped in this file):
//   need    0.075"/day  — Dave-observed satisfaction figure for a mulched container.
//   loss    0.35"       — RAIN_TIER_IA.small_fast above: this engine's OWN initial abstraction for a
//                         small fast-drying vessel ("first-wetting/runoff/canopy loss"). It is LIVE in
//                         prod (CARE_RAIN_CREDIT_ENABLED=true), so this borrows a number already in
//                         force rather than inventing a second, disagreeing one. It is also where the
//                         "canopy sheds water away" physics is already priced in — counting that effect
//                         again here would be double-charging it.
//   => a container banks a full day only once rain clears 0.35 + 0.075 = 0.425".
//   haircut 0.47        — this branch acts on a FORECAST, not a gauge, which is the one thing that
//                         distinguishes it from the soak branch. Measured against 56 days of this
//                         season's own prior_runs, the worst realized/forecast ratio on a day that
//                         cleared the PoP gate was 0.47 (2026-06-22: 1.42" forecast, 0.67" delivered).
//   => 0.425 / 0.47 = 0.9043", rounded UP to 0.91" — a safety bar must round toward watering, and 0.90
//      actually banks 0.073" against a 0.075" need. Two decimals is the gauge's own resolution; more
//      would be false precision on a 4-sample haircut. At this bar even the season's worst bust leaves
//      the container its full day's water; at 0.70" that same bust delivers 0.33" and banks NOTHING.
//
// Only the WORST observed bust pushes the answer this high — the mean ratio (0.93) would put it at 0.46",
// under the 0.5" floor below. Designing to the worst case is deliberate: a false WATER on a free-draining
// vessel costs nothing, while a false SKIP above 85F aborts pepper/tomato flowers within 24h and locks in
// blossom-end-rot in fruit ripening 2-3 weeks later (Ca is transpiration-delivered, so the damage is
// invisible when caused and irreversible when it shows).
//
// FLOOR: todayQualifies() below already gates on `q >= SOAK_FCST_QPF_IN` (0.5"), so any value <= 0.5 makes
// this constant dead code and silently collapses containers onto the bed bar. The meaningful domain is
// strictly (0.5, inf). 0.91 is interior to the (0.74, 1.42] band in which season behaviour is identical, so
// the choice is robust to a haircut estimate anywhere in [0.30, 0.57] — the precision is not load-bearing.
//
// MEASURED BLAST RADIUS: none this season. Replaying all 56 nightly runs through saturationSuppressed,
// 2.0 -> 0.91 changes zero days, because soak/incoming claim the wet days first and only 4 days all season
// clear todayQualifies at all. See soakcontainer.test.js. That is the honest result: this constant is
// near-inert at ANY value above 0.74", and the reason the rule feels pointless is the PoP+0.5" gate and
// the branch ordering, NOT this number. Lowering it below 0.74" to force it to fire would be fitting to a
// single observed day (2026-07-07, 0.74") and would breach the derivation above.
const SOAK_TODAY_SMALL_IN = SOAK_THRESHOLDS.SOAK_TODAY_SMALL_IN; // today-forecast bar for small vessels (bags/pots/cells)
// Returns { wp, kind:'soak'|'incoming', fq?, pop? } when an outdoor planting must NOT be watered (media
// saturated, or wet with more rain imminent = no drying window), else null. Pure fn of hydrology + exposure.
// BUG-TODAYWATER-001 — "is meaningful rain forecast for TODAY?" Deliberately reuses SOAK_FCST_QPF_IN and
// SOAK_FCST_POP_PCT, the already-approved bar for "incoming rain counts as a reason to skip", so this
// introduces no new agronomic judgement — it applies an existing bar to a horizon that was never checked.
//
// FAIL-CLOSED ON A NULL PoP, unlike the tomorrow branch below (`pop==null ||`). That permissiveness is
// tolerable for tomorrow, where a missing probability still gets re-evaluated overnight before anyone acts.
// For TODAY it would mean suppressing every outdoor planting on an amount with no probability attached at
// all — and `fetchPrecip` sets today_pop:null whenever Open-Meteo omits it, so this is a real path, not a
// theoretical one. Unknown probability means a data problem, not a certainty; the engine's own convention
// elsewhere (isSmallVessel, rainTierFor) is that unknown fails safe toward WATERING.
//
// BUG-TODAYWATER-001 2nd pass — WHAT THIS GATES. A PoP is a probability that rain WILL fall; it is meaningless
// applied to rain that already HAS. Since BUG-RAINACTUAL-001 today_precip_in is measured + still-expected, so
// gating it whole made a fail-closed PoP veto water already in the ground. This now reads the still-expected
// part only; the measured part is judged by the soak cap, which is the branch that owns water in the media.
function todayForecastIn(hy){ return hy.today_remaining_in ?? hy.today_precip_in; }  // ?? not ||: a real 0 remaining must not fall back to the day total
function todayQualifies(hy){
  if(!hy) return false;
  const q = todayForecastIn(hy), pop = hy.today_pop;
  return q != null && q >= SOAK_FCST_QPF_IN && pop != null && pop >= SOAK_FCST_POP_PCT;
}

// `opts.todayAware` gates the new branch (CARE_TODAY_AWARE_ENABLED); `opts.smallVessel` raises the bar for
// bags/pots/cells per SOAK_TODAY_SMALL_IN. Both default off/false so an un-updated caller is byte-identical.
function saturationSuppressed(rcls, hy, opts){
  if(rcls!=='outdoor') return null;                                 // covered/indoor never got the rain
  const wp = windowPrecip(hy); if(wp==null) return null;
  const wpR = Math.round(wp*100)/100;
  const todayAware = !!(opts && opts.todayAware);
  // BUG-TODAYWATER-001 — DISJOINT TERMS. windowPrecip is `recent + today`, and `today` is a FORECAST, so
  // the soak cap has always been part-prediction. Left that way, any forecast >= SOAK_CAP_IN trips SOAK
  // before the today branch is reached — which would make the small-vessel bar below dead code AND let a
  // busted forecast suppress a fabric bag through the one branch that outranks the heat gate. So when
  // today-awareness is on, soak judges ACTUALS ONLY and the forecast is judged below, where it has its own
  // bars and is subordinate to the fast-dry carve-outs. Flag OFF keeps the original basis exactly, so the
  // shipped behaviour and every existing fixture are untouched until the flag is flipped.
  //
  // BUG-TODAYWATER-001 2nd pass — "ACTUALS" MUST INCLUDE TODAY'S GAUGE. recent_precip_in alone was right only
  // while the D0 term was purely a pre-dawn forecast; BUG-RAINACTUAL-001 made today_precip_in gauge-driven
  // (observed + unelapsed hourly), so reading recent alone dropped physically MEASURED rain out of the
  // saturation cap and then re-gated it behind a PoP — a category error that inverts the cap's whole purpose
  // (a 1.5" measured soak at 45% PoP watered 157 of Dave's plantings instead of 19). today_observed_in is
  // ABSENT with no bound station, so this term is 0 there and the flag-ON no-gauge path is unchanged.
  const soakBasis = todayAware ? ((hy.recent_precip_in || 0) + (hy.today_observed_in || 0)) : wp;
  if(soakBasis >= SOAK_CAP_IN) return { wp: Math.round(soakBasis*100)/100, kind: 'soak' };
  const fq = hy && hy.tomorrow_precip_in, pop = hy && hy.tomorrow_pop;
  // BUG-RAINFORECASTCREDIT-001 residual: the "already wet" prerequisite reads soakBasis, the same
  // MEASURED term the soak cap above judges — not windowPrecip. "Already wet" is a claim about water
  // in the media right now, and windowPrecip's D0 half is today's unelapsed hourly FORECAST, so the
  // old form let rain that has not fallen satisfy a wetness floor and then skip the planting on a
  // second forecast (tomorrow's). It also re-introduced, on this one line, exactly the double-count
  // the today branch below is written to avoid. Reports the basis it actually judged, as the soak
  // branch does — sat_wp is the forensic field for "did we skip on a forecast that busted?" and a
  // number no bar was applied to cannot answer it. todayAware OFF -> soakBasis === wp, so the
  // flag-OFF path (condition AND payload) is byte-identical.
  if(soakBasis >= SOAK_WET_FLOOR_IN && fq!=null && fq >= SOAK_FCST_QPF_IN && (pop==null || pop >= SOAK_FCST_POP_PCT))
    return { wp: Math.round(soakBasis*100)/100, fq, pop, kind: 'incoming' };
  // TODAY. Ordered LAST so it can never pre-empt the two branches that act on water already in the media —
  // and evaluated against the raw forecast, NOT windowPrecip, so today is never counted twice (windowPrecip
  // already contains today_precip_in; using it here would let one 0.6" event satisfy both a "0.5 already
  // wet" floor and a "0.5 more coming" bar, silently halving SOAK_CAP_IN).
  // BUG-TODAYWATER-001 2nd pass: judged against todayForecastIn — the STILL-EXPECTED part — so the gauge's
  // measured share is counted once, in soakBasis above, and never a second time here under a PoP. fq reports
  // the same number the bar was applied to; reporting the day total would make "did we skip on a forecast
  // that busted?" unanswerable, which is the one question this row exists to answer.
  if(todayAware && todayQualifies(hy)){
    const bar = (opts.smallVessel ? SOAK_TODAY_SMALL_IN : SOAK_FCST_QPF_IN);
    const tf = todayForecastIn(hy);
    if(tf >= bar)
      return { wp: wpR, fq: tf, pop: hy.today_pop, kind: 'today' };
  }
  return null;
}

// Returns a fertilize recommendation object IF one is warranted now, else null. Substrate-aware.
function fertilizeRec(p, c, fm, today){
  const wk=weeksSince(today, p.substrate_start);
  const phase=feedPhase(wk);
  const am=fm.amendments_in_inventory;
  // During establishment + MG-active: NO routine feed. (mix is feeding.)
  if(phase==='establishment_0_2wk' || phase==='mg_active_3_12wk' || phase==='unknown') return null;
  // Tapering / spent: feed heavy feeders, or anything past its cadence interval with a fert history.
  const dF=daysBetween(today,p.last_fert);
  const iv=(typeof c.fertilize_interval_days==='number')?c.fertilize_interval_days:null;
  // BUG-FEEDRECENCY-001 — RECENCY GATE, ahead of every qualifying branch below.
  //
  // `due` was only ever ONE of three ORed reasons to recommend a feed. The other two — a heavy feeder
  // in flower/fruit, and needs_feed_24wk_plus — carried NO recency check at all, so a planting that
  // matched either was recommended EVERY DAY regardless of when it was last fed. Measured live:
  // Armageddon (super hot pepper, fruiting, wk13) sat on the feed list 2026-08-22..25 with its last
  // feed 6-9 days old against a 17-day Capsicum interval, and re-appeared the morning after Dave fed
  // it. A card that returns the day after you act on it is the affordance-extinction pattern the
  // watering canon (V100 §"Pre-F2 interim snooze semantics") already forbids on the water arm.
  //
  // Gated on a KNOWN interval AND a KNOWN last feed, deliberately. dF==null means "never fed" and
  // still falls through to the branches below — that no-history case is exactly what they exist for,
  // and suppressing it would be the dangerous direction (silence about a plant that needs feeding).
  if(dF!=null && iv!=null && dF<iv) return null;
  const due = (dF!=null && iv!=null && dF>=iv);
  const heavy=isHeavyFeeder(c.crop);
  if(!(due || (heavy && ['flowering','fruiting'].includes(p.status)) || (phase==='needs_feed_24wk_plus'))) return null;
  if(isMedHerb(c.crop)) return null;            // Mediterranean herbs: never force-feed
  // pick amendment by crop/stage
  let rec;
  if(isAcidLover(c.crop)) rec={item:'acidic fertilizer (Holly-Tone — NOT in inventory; acquire)', apply:'top-dress; use rainwater', note:'acid-lover; hard well water raises pH'};
  else if(heavy || ['flowering','fruiting'].includes(p.status)) rec={item:am.fruiting_feed.item, apply:am.fruiting_feed.apply, alt:am.kelp.item+' (sprayer)'};
  else if(isLeafy(c.crop)) rec={item:am.veg_feed.item, apply:am.veg_feed.apply};
  else rec={item:am.castings.item, apply:am.castings.apply};
  // `interval` = this row's OWN feeding cadence, mirroring the water rows' `interval` (each row
  // carries the clock it is judged against). BUG-BACKDATEDFEED-001 needs it on the item: the read-time
  // check-off is cadence-aware for feeding, and daily-plan-read cannot re-resolve cadence itself.
  //
  // SPA safety — stated precisely, because the first version of this comment got the mechanism wrong
  // and a reviewer caught it. careNeeded.js consults `interval` at THREE sites, not two:
  //   :57  needReason  — inside `case 'water_due':`            → gated on need
  //   :90  needTier    — inside `if (need === 'water_due')`    → gated on need
  //   :128 buildCareNeeded — computed for EVERY need, feeding two uses:
  //          reasonRedundant → gated on need
  //          overdueBy       → NOT gated on need
  // So the "both consumers are gated" claim was false. The change is safe anyway, for two INDEPENDENT
  // reasons: (1) fertilizeRec emits no `overdue_by`, so overdueBy's `typeof … === 'number'` arm is
  // already false for a feed row and the `daily` term cannot change its result; (2) isDailyCadence is
  // `=== 1` and the minimum fertilize_interval_days in cadence-data-v2.json is 7 (distribution:
  // 7×5, 10, 14×98, 17, 18×2, 19, 20, 21×42, 28×11, 29, 30×39, 42×3, 45×4, 55, 60×5, 75, 90×4, 180).
  //
  // That redundancy is worth naming rather than enjoying: it makes a careNeeded test asserting
  // `overdueBy === null` VACUOUS — verified by mutation, the assertion stays green with the `daily`
  // term deleted. If you ever add a 1-day feed cadence, or widen isDailyCadence past `=== 1`, reason
  // (2) dies and only (1) is holding — so check overdueBy against a feed row that actually carries
  // `overdue_by` before assuming the suite would have told you.
  return {id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:isHeavyFeeder(c.crop)&&false,status:p.status,weeks_since_pot:wk,phase,interval:iv,...rec};
}

function coldFor(p, cad, low){
  if(low==null) return null;
  const c=resolveCadence(p,cad);
  if(PEPPER_TOMATO.test(c.crop||'') || PEPPER_TOMATO.test(p.name||'')){
    if(low<40) return {level:'bring_in', text:`bring inside tonight (low ${low}°F)`};
    if(low<45) return ['flowering','fruiting'].includes(p.status) ? {level:'optional', text:`optional: protect flowering plant (low ${low}°F)`} : null;
    return null;
  }
  if(/houseplant|succulent|cactus/i.test(c.crop||'')) return null;
  // V4-TROPICALCOLD-001 — already indoors? Then there is nothing to carry in, at any temperature.
  // `done` (doneEvents.js) only retires a task for the CALENDAR DAY, so without this the card returns
  // every night the low is under the threshold, all winter, for a plant already on the windowsill —
  // the nightly nag the 2026-08-07 band decision rejected. brought_inside/brought_outside are existing
  // logged event types and are a true toggle: the plant is indoors iff the LATER of the two is
  // brought_inside. Unknown (neither ever logged) means outdoors, which is the fail-safe direction —
  // it warns about a plant that is already in rather than staying silent about one that is out.
  if(broughtInside(p)) return null;
  // Cold-profile resolution, most specific first. Variety/genus/DB (`c.cold`) stays authoritative;
  // the crop-type table is the FALLBACK beneath it, never an override. Ginger, and every other
  // tropical with no hand-authored variety row, reaches a profile only via this second tier.
  const ct=c.cold ? null : fc.coldProfileForSlug(p.crop_type_slug);
  const prof=(c.cold && c.cold.tender) ? c.cold : (ct && ct.tender ? ct : null);
  const pb=prof ? prof.protect_below_F : null;
  if(pb!=null && low<=pb) return {level:'protect', text:`tender tropical — bring in tonight (low ${low}°F ≤ ${pb}°F)`};
  return null;
}

// True when the planting's most recent move event says it is indoors. Dates are 'YYYY-MM-DD' strings
// from the handler, so a lexicographic compare IS a chronological one.
function broughtInside(p){
  const in_=p && p.last_brought_inside, out=p && p.last_brought_outside;
  if(!in_) return false;
  return !out || in_>=out;
}

// ── DRG-NOCALWATER-001 — dormancy/growth-cycle watering suppression ──
// Some care profiles (Lithops-class succulents) mark watering as NOT calendar-drivable: no_calendar_water:true
// and/or water_rule:'growth_gated'. Until this gate existed NOTHING read those signals, and the nightly plan
// issued interval watering for a summer-dormant Lithops (watering during dormancy rots it — the plant died).
// Sources checked IN ORDER: the resolved cadence `c` AND the raw DB profile p.db_cadence. The raw read is
// load-bearing, not belt-and-braces: resolveCadence adopts db_cadence only when a scope CONTRIBUTED A CADENCE
// KEY (cadence_scopes; `_seeded` on the flag-OFF path), and a profile can declare suppression while carrying
// no watering interval at all — cadence_scopes = [] -> bundled fallback -> a c-only check would drop the
// signal through the exact path that caused the original loss. BUG-SEEDEDGATE-001 narrows which profiles are
// adopted but does NOT make this raw read dead: the Lithops class is exactly "signals present, cadence key
// absent". no_calendar_water (explicit, stronger) wins
// the label when both are set. Returns 'no_calendar_water' | 'growth_gated' | null.
// Suppression is LOUD, never silent: the caller routes the planting to counts.dormancy_suppressed +
// tasks.dormancy_suppressed with a per-item rule + reason, so a suppressed planting is distinguishable from a
// forgotten one. Watering ONLY — fert/pest/cold generation is untouched. The check sits in the shared
// pre-branch path of generatePlanForUser so it applies identically under EVERY flag combination
// (todayAware / rainCredit / rainMaxDays on or off) — a guard written inside one flag branch would be
// silently deleted when the flag flips (house flag-parity lesson).
function waterSuppression(p, c){
  const srcs=[c, p&&p.db_cadence];
  for(const s of srcs){ if(s && s.no_calendar_water===true) return 'no_calendar_water'; }
  for(const s of srcs){ if(s && s.water_rule==='growth_gated') return 'growth_gated'; }
  return null;
}

// ── V4-WATERMATH-001 F2 — per-planting ledger verdict (only reached when the flag is ON) ──────────
// Computes wi_eff (RETIRES the >=88F heat gate and the maxdays ceiling in-flag — canon legacy-term
// table: keeping them next to ET scaling double-counts heat; tray class hard-caps at 1 day), the
// drought-tolerant late-bias threshold, the fold, and server-side confidence. Returns the additive
// `ledger` payload key plus the INTEGER calendar-day fields the three verified readers depend on
// ((e->>'overdue_by')::int at dashboard handlers.js:433 throws 22P02 on any fraction — proven live).
function ledgerVerdictFor(p, c, wiBase, today, hydrology, lo){
  const vp = ledger.vesselProfile(p.container_type, p.container_size);
  const wiEff = vp.tray ? Math.min(wiBase, LP.TRAY_WI_CAP_DAYS) : wiBase;
  const thr = wiEff * (c.drought_tolerance === 'high' ? LP.DUE.droughtHighBias : 1);
  const exposure = ledger.exposureClass(p);
  const fold = ledger.foldLedger({
    wiEff, thr, events: lo.eventsByPlant[p.id] || [],
    weatherByDate: lo.weatherByDate, weatherRowCount: lo.weatherRowCount,
    todayStr: today, effNowMs: lo.effNowMs,
    todayEt0: hydrology ? (hydrology.today_et0_in ?? null) : null,
    todayTmax: hydrology ? (hydrology.today_tmax_f ?? null) : null,
    // BUG-F2RAINBASIS-001: today's rain for the fold's D0 day-credit. today_observed_in ONLY —
    // the identical term creditPrecip spends at the measured-basis line above, so the ledger and
    // the legacy chain now credit the same inches on the same day. Absent (no bound station) or
    // absent hydrology -> null -> no D0 credit, matching legacy's degrade-to-`recent`.
    todayPrecip: hydrology ? (hydrology.today_observed_in ?? null) : null,
    // RAIN_DEPTH key, not the IA/hold one. sizeGal gates the bed-equivalent fabric_ground row.
    exposure, vessel: vp, rainTier: rainDepthTierFor(p.container_type, vp.sizeGal),
    transplantAt: p.transplant_at || null,
  });
  const via = c._via || 'default';
  const confidence = ledger.computeConfidence({
    via, vesselKnown: vp.known,
    weatherOk: lo.weatherRowCount >= LP.CONFIDENCE.minWeatherRows && !!hydrology,
    snoozeCount: fold.snoozeCount, trayUnprofiled: vp.tray && via !== 'db',
  });
  return {
    due: fold.due, overdueBy: fold.overdueBy, wiEff,
    pub: { d: Math.round(fold.d * 100) / 100, due_at: new Date(fold.dueAtMs).toISOString(),
      wi_eff: wiEff, confidence, drivers: fold.drivers },
  };
}

// DRG-WXFLAGSPLIT-001 F1: rainMaxDaysEnabled gates the max-days CEILING independently of rainCreditEnabled
// (which gates the tiered credit). Trailing param, default false -> every existing caller keeps flag-OFF
// behaviour and the plan stays byte-identical until an env flip.
// V4-WATERMATH-001 F2: `ledgerOpts` (10th param, default null) carries the Water Ledger inputs from
// generatePlan — {enabled, eventsByPlant, weatherByDate, weatherRowCount, effNowMs}. Null/absent ->
// byte-identical legacy path; the fold requires BOTH the flag and a real event window (a failed
// event-window read degrades the whole run to flag-OFF, per the canon fail-to-today's-model rule).
function generatePlanForUser(plantings, cad, fm, today, weather, hydrology, rainCreditEnabled=false, rainMaxDaysEnabled=false, todayAwareEnabled=false, ledgerOpts=null, measuredCreditEnabled=false){
  const _ledgerOn = !!(ledgerOpts && ledgerOpts.enabled && ledgerOpts.eventsByPlant);
  const water=[], fertilize=[], pest=[], cold=[], dormant=[], rainSkipped=[], waterSuppressed=[], overwintering=[];
  let overwinterHeld=0, overwinterDeferred=0;
  const phaseCounts={};
  const low=weather?weather.tonightLow:null, high=weather?weather.highToday:null, hot=high!=null&&high>=HOT_F;
  const hotForBag=high!=null&&high>=BAG_HEAT_GATE_F;   // DRG-WATERCREDIT-004 fabric-bag heat-gate signal
  for(const p of plantings){
    // DRG-WATERSTAGE-001: skip plantings whose parent PROJECT is still in 'planning' — not yet physically
    // planted, so they must not generate watering (or any other) care tasks. Plantings carry no 'planning'
    // status of their own; the planning state lives on the parent project (passed through as p.project_status).
    if(p.project_status==='planning') continue;
    const c=resolveCadence(p, cad);
    if(c.exclude) continue;
    const ph=feedPhase(weeksSince(today,p.substrate_start)); phaseCounts[ph]=(phaseCounts[ph]||0)+1;
    // V4-DORMANTRESUME-001: `reason` discriminates the two unrelated causes this bucket merges.
    // 'status' = the planting carries status='dormant', which a human set and only a human clears —
    // resumable. 'profile' = the cadence flag (dormant_skip, Lithops only), which is care DATA, not
    // status: clearing a status it never had is meaningless and the flag exists because watering it
    // now rots it. Consumers previously had to compare the `note` string to tell them apart. Same
    // dormant_skip-wins precedence as `note`, so the two fields cannot disagree. Additive key;
    // PLAN_SCHEMA_VERSION deliberately NOT bumped (readers select named keys).
    if(p.status==='dormant' || c.dormant_skip){ dormant.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,reason:c.dormant_skip?'profile':'status',note:c.dormant_skip?c.notes:'Dormant — skip routine care'}); continue; }
    // DRG-NOCALWATER-001: profile-declared calendar-watering suppression. Evaluated BEFORE any watering
    // computation and BEFORE any flag fork, so it binds identically with todayAware/rainCredit/rainMaxDays
    // on or off. Suppressed plantings get NO water_due/no_history/rain_skipped item — they land LOUDLY on
    // tasks.dormancy_suppressed (+ counts.dormancy_suppressed) with the rule + guidance, and still flow
    // through fert/pest/cold below (the signal governs watering only).
    const _wsup=waterSuppression(p,c);
    // V4-OVERWINTER-001. Evaluated here, in the same shared pre-branch path as the suppression gate and
    // for the same reason: a guard written inside one flag fork is silently deleted when the flag flips.
    //
    // PRECEDENCE IS ENFORCED BY THE BRANCH ORDER BELOW, not by this line — waterSuppression WINS. A
    // no_calendar_water profile is the Lithops class, where an interval-driven prompt is what killed the
    // plant; overwintering's reduced check would re-introduce exactly that prompt at a longer period.
    // The `_wsup ?` here is a short-circuit only (skip the date maths we would discard anyway); deleting
    // it changes no behaviour, which is why the precedence guard in overwinter-engine.test.js mutates
    // the BRANCH ORDER rather than this expression.
    const _ow = _wsup ? null : ow.overwinterState(p, c, today);
    if(_wsup){
      waterSuppressed.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,rule:_wsup,
        moisture:(p.db_cadence&&p.db_cadence.soil_moisture_target)||c.soil_moisture_target||null,
        reason:_wsup==='no_calendar_water'
          ? 'Watering suppressed — profile: NO calendar watering; water only on plant signals, never by interval'
          : 'Watering suppressed — profile: growth-gated; water only during active growth, never by interval'});
    } else if(_ow && _ow.active){
      // HELD OUT of water_due / no_history / rain_skipped, and given a reduced-cadence MOISTURE CHECK —
      // NOT a skip. A cover sheds the rain that would have reached the bed and indoor heat dries a pot
      // faster than July does, so inheriting dormant's "skip routine care" is how an overwintered crop
      // dies of a dry freeze. The item asks Dave to feel the soil, never to water unconditionally.
      overwinterHeld++;
      const _wiOw = ow.checkIntervalFor(_ow, (likelyInGround(p,c) ? c.water_interval_days_inground : c.water_interval_days_container) ?? c.water_interval_days_container ?? cad.default.water_interval_days_container);
      // V4-OVERWINTERCARDNOISE-001 (1): _ow carries rain_counts, so a covered/indoor regime reads
      // last_hand_water and a logged rain no longer clears its check. Passing _ow is load-bearing —
      // dropping the second argument silently restores the rain credit for all three protected regimes.
      const _touch = ow.lastTouch(p,_ow);
      const _dOw = daysBetween(today,_touch);
      // dW==null (never watered, never checked) is DUE: an untouched pot through a winter is the case
      // most worth surfacing, and "no history" is not evidence of a damp medium.
      const _dueOw = _dOw==null || _dOw>=_wiOw;
      // V4-OVERWINTERCARDNOISE-001 (3): due is not the same as WORTH FIRING. field_hardy alone is
      // weather-gated (it is the only regime the weather can reach); the card SLIPS to the next
      // workable day rather than being cancelled, because nothing here writes to lastTouch.
      const _actOw = _dueOw && _ow.regime==='field_hardy' ? ow.fieldHardyActionable(weather,hydrology) : null;
      if(_dueOw && _actOw && !_actOw.actionable){ overwinterDeferred++; }
      else if(_dueOw){
        // V4-DRYDOWNCHANNELLING-001. The moisture TEST is regime-specific and `reason` is the ONLY place
        // the user reads one: `note` carries the full per-regime guidance but no surface renders it —
        // buildCareNeeded does not copy it onto the row — so a test stated only there is a test nobody
        // sees. protected_quiescent reads the pot's WEIGHT at both ends, not the top inch. The top inch
        // on a leafless pot is dry long before the core is (overwinter.js regime table), and on a peat
        // mix that has dried past its wetting agent a re-water runs down the shrinkage gap at the wall
        // and out the hole in seconds — it drains fast, reads as watered, and leaves the core dry.
        // "only until it feels heavier" is the stop condition a channelled watering cannot satisfy.
        const _testOw = _ow.regime==='protected_quiescent'
          ? 'lift the pot: water only if it feels light, and only until it feels heavier' : null;
        overwintering.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,
          regime:_ow.regime,interval:_wiOw,days_since:_dOw,overdue_by:_dOw==null?null:_dOw-_wiOw,
          never:_dOw==null,exit_due:false,harvestable:_ow.harvestable,window_until:_ow.until,
          moisture:(p.db_cadence&&p.db_cadence.soil_moisture_target)||c.soil_moisture_target||null,
          note:_ow.guidance,
          reason:_dOw==null
            ? `Overwintering — never checked; ${_testOw||'feel the soil, water only if dry below the top inch'}`
            : `Overwintering — soil check due (${_dOw}d since last water/check); ${_testOw||'water only if dry below the top inch'}`});
      }
    } else {
    // CARE-PROFILES-001: select inground or container cadence based on container_type.
    const inGround=likelyInGround(p,c);
    let wi=(inGround ? c.water_interval_days_inground : c.water_interval_days_container)
          ?? c.water_interval_days_container
          ?? cad.default.water_interval_days_container;
    // V4-WATERMATH-001 F2: the ledger fold consumes the PRE-heat-gate interval — the >=88F wi-=1
    // gate is RETIRED in-flag (continuous ET0 demand subsumes it; retaining it double-counts heat).
    const _wiBase = wi;
    // BUG-CADENCESIZE-001 vessel floor. Placed HERE, between _wiBase and the heat gate, for two reasons:
    //   * AFTER _wiBase, so the F2 ledger fold never sees it. The ledger already models vessel size
    //     continuously (vesselProfile sizeFactor + the fabric heat ramp); layering this coarse floor on
    //     top would double-count the same signal, and F2 must stay unaffected by this change.
    //   * BEFORE the heat gate, so a >=88F day still walks a low-drought-tolerance planting back down to
    //     1. Heat is exactly when a trough pepper does want daily water, and it means this change is a
    //     no-op on hot days and +1 day only on ordinary ones — the most conservative placement available.
    const _floor = dailyFloorFor(p);
    if(_floor!=null && wi<_floor) wi=_floor;
    if(hot && c.drought_tolerance==='low' && wi>1) wi=wi-1;
    // DRG-WXWATER-001 coarse-v1 (flag-ON only): clamp the interval to the substrate x stage ceiling so a
    // rain-credited planting still re-surfaces for a moisture check. Flag-OFF leaves wi exactly as computed above.
    // DRG-WXFLAGSPLIT-001 F1: the tier is needed by EITHER flag (credit uses it for IA/hold, the ceiling for the
    // clamp), so derive it when either is on; the clamp itself is now gated on rainMaxDaysEnabled ALONE. With both
    // OFF the tier stays null and wi is untouched -> byte-identical to pre-split.
    // BUG-RAINCREDITLIVEPATH-001: pass the parsed size so a >=3 gal fabric_bag resolves to 'fabric_ground'.
    // vesselProfile is a pure parse (ledger.js:109) already require'd at the top of this file, so no new import.
    const _rainTier = (rainCreditEnabled || rainMaxDaysEnabled)
      ? rainTierFor(p.container_type, ledger.vesselProfile(p.container_type, p.container_size).sizeGal) : null;
    if(rainMaxDaysEnabled){ const _cap=rainMaxDays(_rainTier, p.status, c.crop); if(_cap!=null && wi>_cap) wi=_cap; }
    const dW=daysBetween(today,p.last_water);
    // DRG-WATERCREDIT-001 Path B-plus: credit qualifying window rain against the cadence (per class), with a
    // fresh-transplant carve-out. A credited planting drops OUT of water_due (so counts.water_due is correct —
    // fixes the legacy defer-count bug) and lands on rain_skipped with a one-line reason string.
    const rcls=rainClass(p);
    // DRG-WXSATCAP-001: flag-independent heavy-soak cap (outer gate).
    // BUG-TODAYWATER-001: pass the vessel size so the TODAY branch can hold small vessels to a higher bar.
    const _sat=saturationSuppressed(rcls, hydrology, { todayAware: todayAwareEnabled, smallVessel: isSmallVessel(p) });
    // DRG-WXWATER-001 coarse-v1 (flag-ON only): exposure eligibility. Flag-OFF uses the location-derived class
    // (rcls==='outdoor'); flag-ON derives exposure from the location, honoring a stored rain_exposed
    // boolean as an explicit override. _creditClass/_iaShown collapse to the flag-OFF values when OFF.
    // NOTE: CARE_RAIN_CREDIT_ENABLED is "true" in live prod config — this branch is LIVE, not dormant.
    //
    // BUG-NOLOCOUTDOOR-001: was `!p.covered`, which made an un-located planting exposed=true and
    // rain-credited. Now reads the handler's resolved flag, so unknown => not exposed => keeps its
    // water. The rain_exposed override still wins and is now the CORRECT escape hatch for exactly
    // this case: "no location, but I know it is outdoors" is rain_exposed=true. (0/270 rows set it
    // today, so it is an escape hatch, not the fix.)
    const _exposed = rainCreditEnabled ? (p.rain_exposed==null ? !!p.rain_exposed_resolved : !!p.rain_exposed) : null;
    const _creditClass = rainCreditEnabled ? _exposed : (rcls==='outdoor');
    // DRG-WATERCREDIT-002 fix: key the fresh-transplant carve-out on a REAL transplant/potting event
    // (p.transplant_at), NOT substrate_start. substrate_start falls back to created_at (DB row-creation
    // date), so plantings entered into the app recently but established in the ground/pots long ago were
    // wrongly flagged "fresh" and denied rain credit (98/167 on 2026-06-23). transplant_at is NULL when no
    // potting_up/transplant/plant-out event exists -> treated as established -> rain credit applies.
    const freshTransplant=((daysBetween(today,p.transplant_at)??999)<=TRANSPLANT_CARVEOUT_DAYS) && isSmallVessel(p);
    // DRG-WATERCREDIT-004: outdoor fabric bags dry fast in heat -> cut rain credit on hot days so they
    // still surface for watering sooner. Outdoor-scoped (covered bags are never credited anyway, so no
    // misleading note). BUG-HEATDEMOTETOTAL-001: this used to zero the credit outright — it now scales
    // it through bagHeatDemoteCredit. The fresh-transplant carve-out is still a full denial, and stays
    // one: a small root ball is the case where "some credit" is exactly the wrong answer.
    const bagHeatGate=hotForBag && rcls==='outdoor' && ((p.container_type||'').toLowerCase()==='fabric_bag');
    const _rcEarned=freshTransplant ? null
      : (rainCreditEnabled
          ? (_exposed ? rainCreditDaysTiered(_rainTier, wi, hydrology, measuredCreditEnabled) : null)
          : rainCreditDays(rcls, wi, hydrology, measuredCreditEnabled));
    const rc=bagHeatGate ? bagHeatDemoteCredit(_rcEarned) : _rcEarned;
    const bagHeatCut=!!(rc && rc.bag_heat_from > rc.credit_days);
    const effDays=(dW!=null&&rc)?dW-rc.credit_days:dW;
    // BUG-TODAYWATER-001 — the TODAY branch is SUBORDINATE to the fast-dry carve-outs; 'soak' and 'incoming'
    // keep outranking them. The distinction is what the gate is acting on: 'soak' means water is measurably
    // already IN the media, so overriding a heat gate is defensible. 'today' means water is merely PREDICTED,
    // and a forecast busts. Letting a prediction outrank bagHeatGate would skip a 5-gal fabric bag at 92F,
    // and outrank freshTransplant would skip a small root ball — both cost plants when the rain no-shows,
    // and both are exactly the cases those carve-outs were written to protect.
    const _satApplies = _sat && (_sat.kind !== 'today' || !(freshTransplant || bagHeatGate));
    // ── V4-WATERMATH-001 F2 fork ──────────────────────────────────────────────────────────────────
    // Flag ON + watering history exists -> the continuous ledger replaces the dW>=wi chain below.
    // dW==null deliberately FALLS THROUGH to the legacy never:true push (canon: never-watered path
    // byte-identical). Rain day-credits, amount classes, snoozes and fractional time are all folded
    // into D, so the legacy 72h-credit rain_skipped branch has no in-flag analog: a rain-covered
    // planting simply is not due. The saturation cap is RETAINED and still SUPREME — unchanged
    // _satApplies (incl. the 'today'-subordinate-to-carve-outs rule), with its eligibility gate now
    // D >= dueThreshold instead of dW>=wi (canon legacy-term table, engine.js:455 note).
    const _lg = (_ledgerOn && dW!=null) ? ledgerVerdictFor(p, c, _wiBase, today, hydrology, ledgerOpts) : null;
    if(_lg){
      if(_lg.due && _satApplies){
        rainSkipped.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,
          days_since:dW,interval:_lg.wiEff,saturated:true,
          sat_kind:_sat.kind, sat_wp:_sat.wp,
          today_in:(hydrology&&hydrology.today_precip_in)??null, today_pop:(hydrology&&hydrology.today_pop)??null,
          reason: _sat.kind==='soak'
            ? `Skip — saturated (heavy soak, ${_sat.wp}" over the last few days; let it drain)`
            : _sat.kind==='today'
            ? `Skip — ${_sat.fq}" rain falling today${_sat.pop==null?'':' @ '+_sat.pop+'%'}`
            : `Skip — rain incoming on already-wet media (${_sat.fq}" forecast${_sat.pop==null?'':' @ '+_sat.pop+'%'}); let it drain`,
          ledger:_lg.pub});
      } else if(_lg.due){
        // PAYLOAD CONTRACT (canon Decision 10): days_since/overdue_by/interval stay INTEGER CALENDAR
        // values — the ledger's fractional precision rides ONLY in the additive `ledger` key.
        water.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,
          days_since:dW,interval:_lg.wiEff,overdue_by:_lg.overdueBy,method:c.water_method,moisture:c.soil_moisture_target,
          never:false,rain_note:null,ledger:_lg.pub});
      }
      // not due -> no row: day-credits/snoozes/amounts already spoke through D
    }
    else if(dW!=null && dW>=wi && _satApplies){
      // DRG-WXSATCAP-001: heavy-soak saturation cap OUTRANKS the tier decay + fast-dry discount + heat-gate.
      rainSkipped.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,
        days_since:dW,interval:wi,saturated:true,
        // BUG-TODAYWATER-001: structured decision inputs alongside the prose. Without these, "did we skip on
        // a forecast that busted?" is unanswerable after the fact — and that is the failure this change can
        // cause. Additive only; PLAN_SCHEMA_VERSION deliberately NOT bumped (the three readers pin the
        // literal and deploy in one unordered matrix wave, so a bump opens a mismatch window).
        sat_kind:_sat.kind, sat_wp:_sat.wp,
        today_in:(hydrology&&hydrology.today_precip_in)??null, today_pop:(hydrology&&hydrology.today_pop)??null,
        reason: _sat.kind==='soak'
          ? `Skip — saturated (heavy soak, ${_sat.wp}" over the last few days; let it drain)`
          : _sat.kind==='today'
          ? `Skip — ${_sat.fq}" rain falling today${_sat.pop==null?'':' @ '+_sat.pop+'%'}`
          : `Skip — rain incoming on already-wet media (${_sat.fq}" forecast${_sat.pop==null?'':' @ '+_sat.pop+'%'}); let it drain`});
    } else if(dW!=null && dW>=wi && rc && effDays<wi){
      rainSkipped.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,
        days_since:dW,interval:wi,credited_days:rc.credit_days,
        reason:bagHeatGate                                              // rc is non-null in this branch
          ? `Skip — ${rc.wp}" rain counts as watering (fabric bag dries fast at ${high}°F: ${rc.credit_days}d credit${bagHeatCut?`, cut from ${rc.bag_heat_from}d`:''})`
          : `Skip — ${rc.wp}" rain over the last few days counts as watering`});
    } else if(dW!=null && dW>=wi){
      // BUG-RAINFORECASTCREDIT-001 residual: the DECISION that landed us in this branch is
      // `rc == null`, and rc comes from creditPrecip(hydrology, measuredCreditEnabled). Quoting
      // windowPrecip here instead made the sentence and the verdict cite different numbers the
      // moment the measured flag went live — a literally false `Water — 0.38" rain under the 0.20"
      // soak-in threshold`, where 0.38 was the mixed sum and the 0.20 bar was applied to the
      // measured one. Same call, same args as the credit itself. measuredCreditEnabled=false ->
      // creditPrecip IS windowPrecip, so the flag-OFF note is byte-identical.
      const wp=creditPrecip(hydrology, measuredCreditEnabled);
      // flag-OFF: _iaShown===RAIN_IA.outdoor and _creditClass===(rcls==='outdoor') -> note is byte-identical.
      const _iaShown = rainCreditEnabled ? (RAIN_TIER_IA[_rainTier] ?? RAIN_TIER_IA.small_fast) : RAIN_IA.outdoor;
      // BUG-HEATDEMOTETOTAL-001: the bag branch now reports the credit that SURVIVED the gate, and only
      // fires when there was a credit at all. `bagHeatGate && rc==null` means the rain never cleared the
      // soak-in threshold in the first place — the old note called that "rain credit withheld on hot
      // days", naming a cause that did not apply; it now falls through to the threshold note, which does.
      // The `cut from` clause is conditional because the 2-class flag-OFF path has no room to demote: its
      // base credit already IS bagHeatMinCreditDays, so the gate fires and the number does not move.
      const rain_note=freshTransplant
        ? 'Water — fresh transplant (no rain credit; small root ball dries fast)'
        : (bagHeatGate && rc)
        ? `Water — fabric bag dries fast at ${high}°F: ${rc.wp}" rain credited at ${rc.credit_days}d${bagHeatCut?` (cut from ${rc.bag_heat_from}d)`:''}, still short (last watered ${dW}d ago)`
        : (_creditClass && rc==null && wp!=null && wp>0
            ? `Water — ${Math.round(wp*100)/100}" rain under the ${_iaShown}" soak-in threshold`
            : (rc ? `Water — ${rc.wp}" rain didn't cover the gap (last watered ${dW}d ago)` : null));
      water.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,days_since:dW,interval:wi,overdue_by:dW-wi,method:c.water_method,moisture:c.soil_moisture_target,never:false,rain_note});
    }
    else if(dW==null) water.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,days_since:null,interval:wi,overdue_by:null,method:c.water_method,moisture:c.soil_moisture_target,never:true});
    } // end DRG-NOCALWATER-001 watering guard (fert/pest/cold below run for suppressed plantings too)
    // V4-OVERWINTER-001 EXIT NOTICE. Bounded to EXIT_NOTICE_DAYS after the window closes and emitted
    // only for the two regimes where Dave physically moves the plant. Normal care has ALREADY resumed
    // by the time this fires (the window closing IS the exit), so this is a reminder to move the pot,
    // not a hold — and it goes quiet by itself, because an unbounded reminder is the one-way trap in
    // different clothing.
    if(_ow && _ow.exitDue){
      overwintering.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,
        regime:_ow.regime,interval:null,days_since:null,overdue_by:null,never:false,exit_due:true,
        harvestable:_ow.harvestable,window_until:_ow.until,moisture:null,note:_ow.guidance,
        reason:'Overwintering window has ended — move it back out and resume normal care, or extend the window'});
    }
    // V4-OVERWINTER-001: feeding is OFF for every overwintering regime. A quiescent root system cannot
    // take up what is applied, so it stays in the medium as salt; and a tunnel crop coasting at 9 hours
    // of daylight has no growth to feed. Uniform across the four regimes on purpose — one boolean, not
    // a fifth per-regime knob to get wrong. Pest and cold still run below: scale and spider mites are
    // the classic indoor-overwintering losses, and a protected plant still needs its cold card.
    const fr=(_ow && _ow.active) ? null : fertilizeRec(p,c,fm,today); if(fr) fertilize.push(fr);
    const pw=cad.pest_watch&&cad.pest_watch.cucurbit_beetle;
    if(pw&&pw.active){ const txt=((p.name||'')+' '+(p.variety||'')+' '+(c.crop||'')).toLowerCase();
      if((p.genus&&pw.genera.includes(p.genus))||pw.name_keywords.some(k=>txt.includes(k))) pest.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:likelyInGround(p,c),label:pw.label}); }
    const cd=coldFor(p,cad,low); if(cd) cold.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,...cd});
  }
  const ovk=a=>a.never?-1:(a.overdue_by??-1);
  const due=water.filter(w=>!w.never).sort((a,b)=>ovk(b)-ovk(a));
  const noHistory=water.filter(w=>w.never);
  // substrate feeding summary
  const feeding = (phaseCounts['establishment_0_2wk']||0)+(phaseCounts['mg_active_3_12wk']||0);
  const substrate={phase_counts:phaseCounts, feeding_now:feeding, fertilize_recs:fertilize.length,
    on_hold: fertilize.length===0,
    msg: fertilize.length===0
      ? `Feeding on HOLD — fresh MG slow-release mix is feeding all ${feeding} plantings (potted recently; mix feeds 3-6 months). Optional: kelp via sprayer for transplant establishment. Watch for Mg (Epsom) / blossom-end-rot (gypsum) symptoms.`
      : `${fertilize.length} planting(s) past the MG feed window — feed per recommendation.`,
    water_note: fm.water_quality && fm.water_quality.implications[0]};
  // DRG-NOCALWATER-001: dormancy_suppressed is ADDITIVE (new counts key + new tasks array); existing task
  // arrays keep their shape, so PLAN_SCHEMA_VERSION is deliberately NOT bumped (readers select named keys;
  // same precedent as BUG-TODAYWATER-001's additive keys). A zero count is itself information: it says the
  // suppression gate RAN and found nothing, distinguishing "no suppressed plantings" from "gate missing".
  // V4-OVERWINTER-001: `overwintering` (actionable rows: due soil checks + bounded exit notices) and
  // `overwinter_held` (the POPULATION inside an open window) are additive — named-key readers, so
  // PLAN_SCHEMA_VERSION is deliberately NOT bumped. Two numbers rather than one because they answer
  // different questions: a zero `overwintering` alongside a non-zero `overwinter_held` means "held out of
  // summer cadence, nothing due today", which is the normal winter state.
  //
  // SPREAD CONDITIONALLY, unlike dormancy_suppressed's unconditional zero. The keys are absent — not
  // present-and-zero — when nothing in the run overwinters, so the plan payload for today's garden is
  // BYTE-IDENTICAL to the pre-change engine and tests/parity stays green with no regenerated goldens.
  // That matters more here than the "a zero proves the gate ran" argument: a regenerated golden can hide
  // a silent revert of the very feature it is supposed to lock, and inertness-until-used is a stronger,
  // directly-testable property (overwinter-engine.test.js "is completely inert"). The same conditional
  // shape is already used for hydrology.today_observed_in a few lines below, for the same reason.
  const _owOn = overwinterHeld>0 || overwintering.length>0;
  return {counts:{plantings:plantings.length,water_due:due.length,no_history:noHistory.length,fertilize:fertilize.length,pest:pest.length,cold:cold.length,dormant:dormant.length,rain_skipped:rainSkipped.length,dormancy_suppressed:waterSuppressed.length,
      ...(_owOn?{overwintering:overwintering.length,overwinter_held:overwinterHeld,overwinter_deferred:overwinterDeferred}:{})},
    substrate, tasks:{water_due:due,no_history:noHistory,fertilize,pest,cold,dormant,rain_skipped:rainSkipped,dormancy_suppressed:waterSuppressed,
      ...(_owOn?{overwintering}:{})}};
}

// Compute the single weather callout (action only) from temp + hydrology. Priority order; null = no callout (no filler).
function computeCallout(weather, hy){
  const low=weather&&weather.tonightLow, high=weather&&weather.highToday;
  if(low!=null && low<40) return {icon:'freeze', text:`Freeze tonight (${low}°F) — cover or bring peppers & tomatoes in`};
  if(low!=null && low<45) return {icon:'cold', text:`Cool night (${low}°F) — protect flowering peppers/tomatoes`};
  if(high!=null && high>=88) return {icon:'heat', text:`Hot day (${high}°F) — deep-water thirsty crops, shade if wilting`};
  if(hy && hy.tomorrow_precip_in>=0.3 && (hy.tomorrow_pop==null || hy.tomorrow_pop>=50)){
    // DRG-WXPROB-001 — mirror the Today widget's probability-gated rain AMOUNT in this nightly snapshot
    // string. The GATE (whether the action callout fires) is unchanged — that's a watering decision. Only
    // the DISPLAYED amount is probability-weighted, and only when a PoP is known (>= the display threshold;
    // a null PoP keeps the raw figure). Presentation only — stored hydrology numbers + watering logic untouched.
    const _amt = (hy.tomorrow_pop!=null && hy.tomorrow_pop>=RAIN_POP_DISPLAY_THRESHOLD)
      ? Math.round((hy.tomorrow_precip_in*hy.tomorrow_pop/100 + Number.EPSILON)*100)/100
      : hy.tomorrow_precip_in;
    return {icon:'rain', text:`${_amt}" rain tomorrow — water containers today, let in-ground beds wait`};
  }
  if(hy && hy.recent_precip_in>=0.4)
    return {icon:'wet', text:`${hy.recent_precip_in}" fell recently — soil is wet, skip outdoor watering`};
  return null;
}
// Full-picture gate + uncertainty. The plan's precip figures are a FROZEN ~2AM snapshot; in showery/
// convective regimes the amount can move several-fold by midday, so the OLD 40-60%-PoP-only band missed
// the common high-PoP cases (e.g. 88% PoP with a trace or modest amount — DRG-WXROLL/bell). Flag the
// snapshot as volatile whenever rain is reasonably likely today or tomorrow, or when data is missing.
// METADATA ONLY — no watering recommendation reads this flag (presentation honesty for the Today widget;
// the conservative watering model is unchanged). DRG-WX Phase 2.
const SHOWERY_POP = 50;
function hydrologyStatus(hy){
  if(!hy || hy.recent_precip_in==null || hy.upcoming_precip_in==null)
    return {ok:false, uncertainty:{flag:true, reason:'precip data incomplete — watering advice assumes no rain credit'}};
  const tPop=hy.today_pop, mPop=hy.tomorrow_pop;
  const tIn=hy.today_precip_in??0, mIn=hy.tomorrow_precip_in??0;
  let reason=null;
  if(tPop!=null && tPop>=SHOWERY_POP)
    reason = tIn<0.1
      ? `rain likely today (${tPop}%) but little in the pre-dawn snapshot — the amount may climb`
      : `showery today (${tPop}% on ${tIn}") — a pre-dawn snapshot can shift by midday`;
  else if(mPop!=null && mPop>=SHOWERY_POP)
    reason = mIn<0.1
      ? `rain likely tomorrow (${mPop}%) but little in the pre-dawn snapshot — the amount may climb`
      : `showery tomorrow (${mPop}% on ${mIn}") — a pre-dawn snapshot can shift`;
  else if((tPop!=null && tPop>=40 && tIn>=0.1) || (mPop!=null && mPop>=40 && mIn>=0.1))
    reason = `rain amounts uncertain — pre-dawn estimate (today ${tPop==null?'?':tPop}% / tomorrow ${mPop==null?'?':mPop}%)`;
  return {ok:true, uncertainty: reason ? {flag:true, reason} : {flag:false}};
}

// V4-WATERMATH-001 F2: waterLedgerEnabled/weatherDaily/eventsByPlant/nowMs are the fold inputs the
// handler threads through (weatherDaily was already passed as the F1 seam; it is consumed now).
// All default to inert — an un-updated caller is byte-identical, and enabled-without-events stays
// legacy (the handler passes enabled=false when the event-window read fails).
function generatePlan({plantings, cadence, fertModel, today, weather, hydrology, ownerFallback, rainCreditEnabled=false, rainMaxDaysEnabled=false, todayAwareEnabled=false, waterLedgerEnabled=false, weatherDaily=null, eventsByPlant=null, nowMs=null, measuredCreditEnabled=false}){
  const ledgerOpts = (waterLedgerEnabled && eventsByPlant)
    ? ledger.buildLedgerOpts({ weatherDaily, eventsByPlant, today, nowMs })
    : null;
  const byUser=new Map();
  for(const p of plantings){ const c=resolveCadence(p,cadence); const u=ownerFor(p,c,ownerFallback)||'__UNASSIGNED__'; if(!byUser.has(u))byUser.set(u,[]); byUser.get(u).push(p); }
  const hy=hydrology||null; const callout=computeCallout(weather,hy); const hs=hydrologyStatus(hy);
  // BUG-TODAYWATER-001: `rain_coming` could not see rain arriving TODAY -- it read tomorrow only, so on
  // 2026-08-03 it reported false while 3.8" fell. Note this flag reaches NO engine gate (it is emitted at
  // the bottom of this function and consumed client-side), so this is an honesty fix, not the fix that
  // moves water_due -- that is the 'today' branch in saturationSuppressed. `rain_horizon` is additive and
  // exists because the two horizons imply OPPOSITE advice: rain tomorrow means water containers today and
  // let beds wait; rain today means beds can wait and containers may catch little or none.
  const _tomorrowComing = !!(hy && hy.tomorrow_precip_in>=0.3 && (hy.tomorrow_pop==null||hy.tomorrow_pop>=50));
  const _todayComing = todayQualifies(hy);
  const rainComing = _todayComing || _tomorrowComing;
  const rainHorizon = _todayComing ? 'today' : (_tomorrowComing ? 'tomorrow' : null);
  const users={};
  for(const [u,rows] of byUser){ const up=generatePlanForUser(rows,cadence,fertModel,today,weather,hy,rainCreditEnabled,rainMaxDaysEnabled,todayAwareEnabled,ledgerOpts,measuredCreditEnabled);
    users[u]=up; }
  return {date:today,
    weather: weather? {tonightLow:weather.tonightLow, highToday:weather.highToday, code:weather.code, short:weather.short, unit:weather.unit||'F', callout} : null,
    // BUG-RAINACTUAL-001 §3-1: today_observed_in / today_remaining_in ride along for observability — they are
    // what makes "was that 1.4" measured or predicted?" answerable from a stored row. Spread CONDITIONALLY so
    // a run with no bound station emits a byte-identical payload (the keys are absent, not null).
    hydrology: hy ? {recent_precip_in:hy.recent_precip_in, today_precip_in:hy.today_precip_in, today_pop:hy.today_pop, upcoming_precip_in:hy.upcoming_precip_in, tomorrow_precip_in:hy.tomorrow_precip_in, tomorrow_pop:hy.tomorrow_pop,
      ...(hy.today_observed_in!=null?{today_observed_in:hy.today_observed_in}:{}), ...(hy.today_remaining_in!=null?{today_remaining_in:hy.today_remaining_in}:{}),
      rain_coming:rainComing, rain_horizon:rainHorizon, status:hs} : {status:hs},
    hot:(weather&&weather.highToday>=HOT_F)||false, water_source:(fertModel.water_quality||{}).source||null, users};
}
module.exports={generatePlan, PLAN_SCHEMA_VERSION, saturationSuppressed, todayQualifies, SOAK_CAP_IN, SOAK_TODAY_SMALL_IN, BAG_HEAT_GATE_F, generatePlanForUser, resolveCadence, coldFor, fertilizeRec, feedPhase, daysBetween, HOT_F, rainClass, rainCreditDays, windowPrecip, RAIN_IA, TRANSPLANT_CARVEOUT_DAYS, hydrologyStatus, computeCallout, isSmallVessel, vesselSizeSmall, waterSuppression,
  RAIN_TIER_IA, RAIN_TIER_HOLD, RAIN_VESSEL_TIER, rainTierFor, rainDepthTierFor, RAIN_DEPTH_TIER_OVERRIDE,
  FABRIC_GROUND_MIN_GAL, RAIN_MAX_DAYS, rainStageFor, rainMaxDays, rainCreditDaysTiered, bagHeatDemoteCredit,
  dailyFloorFor, DAILY_FLOOR_DAYS, RESERVOIR_VESSEL_TYPES, RIGID_POT_TYPES,
  overwinter: ow};
