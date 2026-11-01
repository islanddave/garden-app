'use strict';
// Daily Plan Engine — pure generator. Substrate-aware fertilization: holds feeding while the MG 3-6mo slow-release mix is
// active, then recommends a specific in-inventory amendment by crop+stage (sprayer-default for liquids, hard-well-water
// aware). Per-variety cadence, never-logged-aware, temp-aware, per-variety cold, strict per-user.
// No I/O; the caller passes today/weather/cadence/fertModel.
const DAY = 86400000;
const HOT_F = 88;
// Water Ledger fold (flag-gated: CARE_WATER_LEDGER_ENABLED, default OFF). engine requires ledger, NEVER the reverse;
// shared rain-IA constants are mirrored in ledgerParams and pinned equal by ledger.test.js.
const ledger = require('./ledger');
const LP = require('./ledgerParams');
// Crop-type cold profiles (the bring-indoors fallback beneath the variety table).
const fc = require('./frostClass');
// Overwintering is a care_profile ATTRIBUTE (never a plants.status value): it holds a planting out of the summer water/feed
// cadence and gives it a reduced-cadence moisture check. The window is a pure function of the date, so the exit needs no
// writer. See overwinter.js header.
const ow = require('./overwinter');
const lw = require('./leafWetness');
// The drought signal (consecutive days with no >=0.60in deep soak). Read on the dormancy_suppressed arm only, and INERT unless
// the handler threads a state in: with none, droughtNote returns null and the emitted row is byte-identical.
const dr = require('./droughtSignal');
// Fabric grow bags dry top-to-bottom fast in heat, so a light/moderate rain that would credit a rigid pot or bed does NOT keep
// a fabric bag wet on a hot day. At/above this threshold rain credit is withheld for fabric_bag vessels (outdoor only).
// Intentionally LOWER than HOT_F (the drought-cadence accelerator): bags lose moisture at more moderate heat.
const BAG_HEAT_GATE_F = 85;
// Version stamped into the stored daily_plan.items jsonb (by handler.js). The dashboard bar (lambda/dashboard/handlers.js) and
// the Today reader (lambda/daily-plan-read/index.js) assert it and FAIL LOUD on mismatch. Bump ONLY when the items task-array
// shape changes, in lockstep with both readers' PLAN_SCHEMA_VERSION literals (pinned by an anti-drift source test).
const PLAN_SCHEMA_VERSION = 1;

function daysBetween(today, iso){ if(!iso) return null;
  const d0=new Date(iso.slice(0,10)+'T00:00:00Z').getTime(), t0=new Date(today.slice(0,10)+'T00:00:00Z').getTime();
  return Math.floor((t0-d0)/DAY); }
function weeksSince(today, iso){ const d=daysBetween(today,iso); return d==null?null:Math.floor(d/7); }

function resolveCadence(p, cad){
  // Prefer the DB-resolved per-cultivar/leaf profile (v_resolved_care) when a scope actually CONTRIBUTED A CADENCE KEY; else
  // the bundled cadence-data-v2.json. seededgate.test.js guards this.
  //
  // Provenance is structural, not in-payload: p.cadence_scopes is v_resolved_care.cadence_scopes, the scopes that supplied a
  // NON-NULL water_interval_days{,_container,_inground}. 'system' is deliberately never in it (the house 3-day constant is not
  // evidence of knowledge), so [] means nothing in the DB knows how often to water this, the bundled fallback runs, and that
  // empty count IS the DRG-CADENCEFLOOR-001 unresolved signal.
  //
  // Why not "just delete the _seeded check": v_resolved_care merges system||cultivar||leaf with jsonb `||`, a SHALLOW,
  // right-wins merge, and most cultivar rows express cadence under the *_container / *_inground names, so the system value is
  // never shadowed. Every resolved_profile therefore carries a plausible 3-day interval whether or not anyone researched the plant.
  //
  // READ cadence_scopes, NEVER resolved_scopes: resolved_scopes says a row EXISTS. A cultivar row with container sizing and
  // deliberately no watering keys (Collards) would be adopted, land on cad.default and move 2d -> 3d against its author's intent.
  //
  // The _seeded arm below is the CARE_CADENCE_SCOPES_ENABLED=OFF path ONLY: handler.js nulls the column when the flag is off,
  // so `cs` is not an array and the legacy marker test runs -> byte-identical plan. Array.isArray is also the fail-safe if the
  // driver hands text[] back as the raw '{cultivar}' string: a non-array degrades to the flag-OFF answer, never to a wrong interval.
  const cs = p && p.cadence_scopes;
  const adopt = Array.isArray(cs) ? cs.length > 0
                                  : !!(p && p.db_cadence && p.db_cadence._seeded); // legacy; flag-OFF only
  // A NON-POSITIVE FEED INTERVAL IS A MISTAKE; THE PLANT'S OWN IS RESTORED HERE. Not "zero means never remind": that is
  // no_calendar_feed, which fertilizeRec reads first and which still wins. The view's shallow right-wins merge lets a cultivar 0
  // OVERWRITE the system row's 14, so the default is gone by the time the profile reaches the engine. What replaces it is the
  // first POSITIVE interval on the bundled ladder (bundledRungs: variety, genus, cad.default), not straight cad.default: the
  // bundle knows a Lithops feeds every 180 days. A rung whose interval is null is stepped over.
  // ONLY the interval is taken; every other key stays as adopted and _via stays 'db'. Done on the adopted profile only, because
  // that is the only path a merge can have clobbered. Scoped to a NUMBER that cannot be a cadence (<=0, NaN): absent or null
  // stays "nobody said", which fertilizeRec already treats as unknown. Here rather than in fertilizeRec so the emitted item's
  // `interval` carries the restored value and daily-plan-read/doneEvents.js prices the same clock the engine used.
  if(p && p.db_cadence && adopt){
    const iv=p.db_cadence.fertilize_interval_days;
    if(typeof iv==='number' && !(iv>0) && cad){
      const r=bundledRungs(p, cad).find(x=>typeof x.fertilize_interval_days==='number' && x.fertilize_interval_days>0);
      if(r) return {...p.db_cadence, fertilize_interval_days:r.fertilize_interval_days, _via:'db'};
    }
    return {...p.db_cadence, _via:'db'};
  }
  return bundledRungs(p, cad)[0];
}
// The bundled cadence-data-v2.json ladder for a planting, most specific first: variety (matched on p.variety, then p.name),
// genus, default. The default rung is always present, so [0] is the bundled resolution.
function bundledRungs(p, cad){
  const out=[];
  const byV=cad.by_variety||{};
  const key=[p.variety, p.name].find(k=>k && byV[k]);
  if(key) out.push({...byV[key], _via:'variety:'+key});
  const gf=(cad.by_genus_fallback||{})[p.genus];
  if(gf) out.push({crop:p.genus, ...gf, _via:'genus:'+p.genus});
  out.push({crop:p.genus||'unknown', ...cad.default, _via:'default'});
  return out;
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
// LEAKY BY CONSTRUCTION — KEPT, NOT WIDENED. `crop` is uncontrolled free text (a few hundred cultivar profiles carry ~150
// distinct crop strings), so this misses most live Mediterranean-herb plantings ("herb", "herb (Salvia officinalis)").
// Widening it to the name+variety surface (the isCucurbit/isLeek idiom below) was tried against every live planting and newly
// caught "Creme Sausage" (crop "tomato") on sau-SAGE, silently never-feeding a heavy feeder: a substring regex over free
// text buys a few fixes and an unbounded false-negative class. The real fix is DATA, per cultivar and explicit:
// no_calendar_feed:true (see feedSuppression). This stays as the legacy net for the rows it does catch.
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

// The planting's BASE watering interval, before the vessel floor, the heat gate and the caps. A profile may carry
// water_interval_days_indoor for a plant that summers outside and winters indoors; it is read only while the planting sits
// indoors ("indoors" is ledger.exposureClass === 'indoor'; an explicit rain_exposed override wins both ways). A non-positive or
// non-numeric indoor value is ignored, never read as "water every 0 days". A tray-class vessel (ledgerParams TRAY_TYPES)
// ignores it too: the key sits at cultivar scope, so an indoor sowing of the same variety would inherit an adult pot's 4-7 days.
// Shared by the ordinary branch and the overwinter check, so the ledger fold (_wiBase) and the overwinter base see the same
// number. v_resolved_care.cadence_scopes does NOT count this key: an indoor value alone does not make a profile "researched",
// so it must still carry a container/inground interval to resolve from the DB.
function baseWaterInterval(p, c, cad){
  const ind = c.water_interval_days_indoor;
  if(Number.isFinite(ind) && ind>0 && ledger.exposureClass(p)==='indoor'
     && !ledger.vesselProfile(p.container_type, p.container_size).tray) return ind;
  return (likelyInGround(p,c) ? c.water_interval_days_inground : c.water_interval_days_container)
    ?? c.water_interval_days_container
    ?? cad.default.water_interval_days_container;
}

// ── Solanaceous identity for the cold band: genus, then the controlled slug, NEVER free text. ──
// The old band predicate matched PEPPER_TOMATO against c.crop and p.name, both uncontrolled text, and each produced live
// false positives: /pepper/ is a substring of "Peppermint" (Mentha, hardy, outdoors; told to come inside below 40F), and
// free-text care-profile crop strings reading "pepper" matched an in-ground leek and an in-ground watermelon.
// WHY A STATED GENUS IS DECISIVE: a genus that is present and not in the set is a REFUSAL, not a miss. Falling through to the
// slug would make the stated field non-decisive, which is the property that makes this fixable at all. Absent genus is the only
// case the slug answers. The set is wider than the old regex on plants that belong in the band (NULL-genus rows whose names
// contain neither "pepper" nor "tomato") and narrower on plants that do not (no name or crop string can admit a Mentha or an Allium).
// NOT A REGEX. The defect is not that the pattern was too broad; it is that a NAME was used as an identity key. Tightening the
// pattern would leave the same class of bug one rename away.
const SOLANACEOUS_GENERA = new Set(['Capsicum', 'Solanum', 'Physalis']);
const SOLANACEOUS_SLUGS  = new Set(['pepper', 'tomato', 'eggplant', 'tomatillo']);
function isSolanaceous(p){
  if(p.genus) return SOLANACEOUS_GENERA.has(p.genus);
  return SOLANACEOUS_SLUGS.has(p.crop_type_slug || '');
}

// ── Path B-plus rain credit, V1 2-class ──
// Subtract an initial abstraction (first-wetting/runoff/canopy loss), then credit the remaining rain over the 2-3 day window the
// engine already reads (recent D-2..D0), capped at one cadence cycle. Stateless; manual watering resets naturally (dW from
// event_log); fresh transplants carved out. V1 keys on covered-vs-outdoor ONLY: bed-vs-container is not in the data (one
// location mixes beds and bags). 'covered' (under cover -> never credited) is supplied by the handler (location-derived).
// Outdoor uses one conservative shared profile (higher soak-in threshold + short hold).
const RAIN_IA = { outdoor: 0.25 };   // initial abstraction, inches — single conservative outdoor profile (V1)
const RAIN_HOLD_DAYS = 1;            // short hold (days) for the shared outdoor default; bed full-cycle hold returns in V1.1
const TRANSPLANT_CARVEOUT_DAYS = 21; // fresh root ball dries fast even when the bed reads moist -> no rain credit
// Vessel-aware carve-out: the fresh-transplant rain-credit denial applies ONLY to genuinely small root balls (cells, plugs, solo
// cups, <=4in / <=1qt pots), which dry top-to-bottom in hours. Established LARGE vessels (5-gal fabric bags, troughs, beds,
// in-ground, barrels) get normal rain credit even when recently transplanted. Unknown/null vessel within the window FAILS SAFE
// to small (deny credit -> water it). Container vocab per the DB container_type CHECK; size is free text ('5 gal','3 in','0.5qt').
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
// ── Vessel floor under the watering interval ──
// The interval derivation is size-blind: a 6x2 ft trough, a 15-gal whiskey barrel and a 5-gal fabric bag all take the
// cultivar's single `_container` number. This raises a FLOOR for vessels whose reservoir makes a 24h cycle indefensible. Floor
// only, capped at DAILY_FLOOR_DAYS: it can move wi 1->2 and nothing else, so the worst case is a one-day delay. Not the
// `_inground` arm: the trough peppers' own `_inground` values are 3-5, a jump on vessels that still have a bottom.
//
// FABRIC BAGS ARE EXCLUDED AT EVERY SIZE (a deliberate departure from a plain gallon threshold): their profile notes still say
// daily at 10 and 20 gal. A bag evaporates through every wall, which is why fabric gets its own evaporative treatment
// (bagHeatGate) and heat ramp (ledgerParams FABRIC_BAG). Volume does not buy a bag a second day.
//
// FAIL-SAFE — an unknown vessel never earns the floor:
//   * Reservoir TYPES qualify on the type alone (size implied, as ledger's SIZE_IMPLIED treats them), so a NULL/garbage
//     `container_size` does not weaken them.
//   * Every other type must present a PARSED volume >= largeMinGal. NULL, absent or unparseable leaves wi where it was: still
//     daily, still prompting (the same err-toward-watering direction as isSmallVessel and rainTierFor).
const DAILY_FLOOR_DAYS = 2;
// Deep soil masses. Deliberately NOT LARGE_VESSEL_TYPES, which answers "is this a fresh small root ball?" for the transplant
// carve-out and so carries hanging_basket + window_box (fast-drying; they keep a daily cadence). in_ground/raised_bed normally
// take the `_inground` arm; they are listed anyway so the rule is COMPLETE, which also closes the `_inground`-absent
// fallthrough where a genus stub hands an in-ground bed its 1-day container number.
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
// Reads the handler's resolved flag, NOT the raw `covered` boolean: NULL is FALSY, so `p.covered ? 'none' : 'outdoor'` would
// send an unknown location down the 'outdoor' branch, while frostClass's `=== true` handles the same NULL correctly. The
// handler resolves the tri-state into plain booleans and each consumer reads its own.
// rain_exposed_resolved is `state IS FALSE`, so unknown => false => 'none' => never rain-credited.
function rainClass(p){ return p.rain_exposed_resolved ? 'outdoor' : 'none'; }
function windowPrecip(hy){
  if(!hy || hy.recent_precip_in==null) return null;                 // missing precip -> no credit (uncertainty handled in hydrologyStatus)
  // D-2..D-1 ACTUALS + D0. The D0 term is part-measured/part-predicted: with a bound gauge, station.mergeStationHydrology sets
  // today_precip_in = today_observed_in + today_remaining_in; with no station it is Open-Meteo precipitation_sum[2] read before
  // the day starts. Any gate that must distinguish the two reads today_observed_in / today_remaining_in, never this sum.
  return (hy.recent_precip_in||0) + (hy.today_precip_in||0);
}
// The precipitation basis RAIN CREDIT is allowed to spend. windowPrecip's D0 term is part-measured/part-predicted, and rain
// credit is the strongest gate in the engine (it decides whether a live plant is skipped), so reading the sum let a forecast
// that never arrived retire a real watering; at the 02:00 run, which builds the morning task list, the D0 term is 100% prediction.
// The shape matches saturationSuppressed's soakBasis, which solved this for the cap: actuals judge water in the media, forecast
// is judged separately with its own PoP bars. today_observed_in is ABSENT with no bound station, so the term is 0 there: no
// gauge => today contributes no credit, the fail-safe direction (never suppress a baseline watering cue on unverified rain).
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

// ── 3-substrate-tier rain model (flag-gated: CARE_RAIN_CREDIT_ENABLED, default OFF) ──
// Extends the single-outdoor profile (RAIN_IA.outdoor 0.25 / RAIN_HOLD_DAYS 1) into three substrate tiers keyed on container_type:
// bigger reservoir => rain persists longer (higher hold) and clears a lower initial abstraction; small fast-drying vessels =>
// aggressive discount (short hold). NEW SYMBOLS ONLY: RAIN_IA / RAIN_HOLD_DAYS are left untouched so the flag-OFF path (and
// watercredit.test.js's RAIN_IA.in_ground===undefined assertion) stays byte-identical. The uncertain values are soak-tunable
// (err toward watering: raise IA, shorten hold; in_ground IA is the #1 tune target).
// fabric_ground ports RAIN_DEPTH_TIER_OVERRIDE's bed-equivalence onto this live flag-OFF-ledger path; its values equal in_ground
// deliberately (same intent as ledgerParams.RAIN_DEPTH.fabric_ground).
// small_fast IA is 0.17, from Dave's observation that a plain quarter inch must bank a day for a rigid pot (need 0.075"/day,
// so 0.25 - 0.17 = 0.08 >= 0.075; rounded DOWN to the gauge's two-decimal resolution, since 0.18 leaves 0.07 and misses).
// HOLD stays 1: a quarter inch COUNTS for a rigid pot, it does not last longer.
// This INVERTS the ordering the tier table was built on: small_fast is now the LOWEST bar, below a 5-gal bag (0.20), the ground
// (0.20) and a raised bed (0.25). For THIS row the quantity is the rain depth that observably SATISFIES the vessel, not an
// estimate of what it loses; the reservoir physics lives in HOLD (pot 1 day, bag and ground 3, bed 2). Do not "restore" the
// ordering by raising this without new observation.
//
// The explicit, DERIVED 'unknown' row makes that safe: rainTierFor resolves an unrecognized/NULL container_type to it, and it
// must get the LEAST credit of any tier (max IA, min hold, min per-stage ceiling). Deriving it from the named tiers, rather than
// assuming small_fast is strictest, lets any tier be retuned on its own agronomy; a lowered small_fast IA would otherwise give
// unknown vessels better-than-bed credit. Same shape as ledgerParams.RAIN_DEPTH. The _NAMED tables are the tunable surface; the
// exported tables carry the derived row and are what callers key. 'unknown' is unreachable from any container_type string
// (RAIN_VESSEL_TIER has no such value).
const RAIN_TIER_IA_NAMED   = { in_ground: 0.20, intermediate: 0.25, small_fast: 0.17, fabric_ground: 0.20 }; // inches (initial abstraction per tier)
const RAIN_TIER_HOLD_NAMED = { in_ground: 3,    intermediate: 2,    small_fast: 1,    fabric_ground: 3     }; // max credit days per tier
const RAIN_TIER_IA   = { ...RAIN_TIER_IA_NAMED,   unknown: Math.max(...Object.values(RAIN_TIER_IA_NAMED)) };
const RAIN_TIER_HOLD = { ...RAIN_TIER_HOLD_NAMED, unknown: Math.min(...Object.values(RAIN_TIER_HOLD_NAMED)) };
// Vessel -> tier. Covers the full DB container_type CHECK vocab (14 values, verified prod 2026-07-08) + the generic
// 'pot' used in fixtures. Rigid pots (plastic/terracotta/ceramic/'pot') are small_fast: generic unknown-size pots dry
// fast; large rigid pots re-tag to trough.
// FAIL-SAFE INVARIANT (both resolvers below): an unrecognized/NULL container_type must get the LEAST credit of any row in the
// table being keyed -> water it. That is a property of the TABLE, not of a tier name, and neither table depends on a tier name:
//   RAIN_TIER_IA/HOLD + RAIN_MAX_DAYS (this file, live flag-OFF) -> the derived 'unknown' row (max IA, min hold, min per-stage
//     ceiling across the named tiers); rainTierFor resolves unrecognized/NULL to it.
//   RAIN_DEPTH (ledgerParams, F2) -> its OWN explicit 'unknown' row, strictly stricter than every named tier; rainDepthTierFor
//     resolves unrecognized/NULL to 'unknown', never to a named tier.
//   The failure to avoid is a NAMED ALIAS encoding one day's ordering (a shared 'small_fast' fallback once handed unknown vessels
//   bed-equivalent credit), so the separate resolver and the explicit unknown row stay.
// Re-check this comment against BOTH tables whenever either is retuned.
// Both tables carry a fabric_ground row, reachable ONLY from an explicitly-typed fabric_bag WITH a parsed size >= 3 gal, never
// from a fallback, so the fail-safe invariant is unaffected.
const RAIN_VESSEL_TIER = {
  in_ground: 'in_ground',
  raised_bed: 'intermediate', trough: 'intermediate', whiskey_barrel: 'intermediate', window_box: 'intermediate',
  hanging_basket: 'small_fast', fabric_bag: 'small_fast', tray_cell: 'small_fast', soil_block: 'small_fast',
  solo_cup: 'small_fast', plastic_pot: 'small_fast', terracotta: 'small_fast', ceramic: 'small_fast',
  pot: 'small_fast', other: 'small_fast',
};
const FABRIC_GROUND_MIN_GAL = 3;
// sizeGal is OPTIONAL and is vesselProfile().sizeGal (parsed gallons, or null). Omitted, null or unparseable -> the strict row, so
// every unsized/unknown vessel keeps today's verdict; only an explicitly-typed fabric_bag with a parsed size >= FABRIC_GROUND_MIN_GAL
// moves. Failing to parse a size therefore errs toward WATERING — the direction vesselProfile.smallVessel takes.
function rainTierFor(container_type, sizeGal){
  const ct = (container_type||'').toLowerCase();
  // The fallback is the derived 'unknown' row, so it stays strictest by construction however the named tiers are retuned.
  const base = RAIN_VESSEL_TIER[ct] || 'unknown';
  if(ct !== 'fabric_bag') return base;
  return (Number.isFinite(sizeGal) && sizeGal >= FABRIC_GROUND_MIN_GAL) ? 'fabric_ground' : base;
}
// F2/RAIN_DEPTH sibling of rainTierFor, kept separate because RAIN_DEPTH has its own explicit 'unknown' row: unrecognized/NULL
// container_type -> 'unknown' here. fabric_bag -> 'fabric_ground' above sizeGal >= FABRIC_GROUND_MIN_GAL is shared by both resolvers
// and pinned as shared by ledger.test.js. The evidence for bed-equivalent retention is 5-10 gal bags (fabric on soil, mulched,
// clustered); a small bag has the fabric but not the buffer, and an UNPARSEABLE size is treated the same as a small one.
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
const RAIN_MAX_DAYS_NAMED = {
  small_fast:   { seedling: 1, vegetative: 2, flowering: 2, fruiting: 1, mature: 2 },
  intermediate: { seedling: 2, vegetative: 3, flowering: 3, fruiting: 2, mature: 4 },
  in_ground:    { seedling: 2, vegetative: 4, flowering: 3, fruiting: 3, mature: 5 },
  // Inert while CARE_RAIN_MAXDAYS_ENABLED is off, but REQUIRED: without it, enabling that flag makes rainMaxDays read
  // RAIN_MAX_DAYS.fabric_ground -> undefined for every big bag. Mirrors in_ground, matching the tier's IA/hold.
  fabric_ground:{ seedling: 2, vegetative: 4, flowering: 3, fruiting: 3, mature: 5 },
};
// The third table rainTierFor's fallback keys, so it needs the same derived 'unknown' row or that tier reads undefined here.
// Per-stage MIN across the named tiers = the tightest ceiling at every stage, so an unknown vessel re-surfaces for a moisture check
// soonest. Derived per stage, not copied from small_fast: copying would re-create the named-alias coupling.
const RAIN_MAX_DAYS_STAGES = ['seedling','vegetative','flowering','fruiting','mature'];
const RAIN_MAX_DAYS = {
  ...RAIN_MAX_DAYS_NAMED,
  unknown: Object.fromEntries(RAIN_MAX_DAYS_STAGES.map((s) =>
    [s, Math.min(...Object.values(RAIN_MAX_DAYS_NAMED).map((t) => t[s]))])),
};
function rainStageFor(status){ const s=(status||'').toLowerCase();
  if(s==='seedling'||s==='germinated'||s==='sown') return 'seedling';
  if(s==='vegetative') return 'vegetative';
  if(s==='flowering') return 'flowering';
  if(s==='fruiting'||s==='fruit_set') return 'fruiting';
  return 'mature'; }   // active/harvested/mature/unknown -> mature (loosest column, still capped)
// The Solanaceae half of the -1 arm keys on isSolanaceous(p), the SAME predicate as coldFor's band (genus when stated, else the
// controlled slug, never free text), so the two identities cannot disagree. `p` is a trailing param so the 3-arg calls keep working;
// omitted, there is no identity and the arm stays off. isSolanaceous also admits potato (Solanum) and every Physalis; wanted for
// potato, where even moisture from tuber initiation through bulking prevents growth cracks and hollow heart.
// Inert unless CARE_RAIN_MAXDAYS_ENABLED is on (the one caller, generatePlanForUser's ceiling clamp, is gated on it;
// scripts/lambda-config-expected.json declares it null). isLeafy and isMedHerb below are still free text, and a med-herb crop
// string still pre-empts this arm.
function rainMaxDays(tier, status, crop, p){
  const stage=rainStageFor(status);
  const base=(RAIN_MAX_DAYS[tier]||RAIN_MAX_DAYS.unknown)[stage];
  if(base==null) return null;
  const c=(crop||'').toLowerCase();
  let mod=0;
  if(isMedHerb(c)) mod=1;                                                                 // deep taproot, wilt-tolerant
  else if((isLeafy(c)||(!!p&&isSolanaceous(p))) && (stage==='flowering'||stage==='fruiting')) mod=-1; // steady-moisture crops
  return Math.max(1, base+mod); }
// Tiered rain credit — mirrors rainCreditDays but with per-tier IA + hold. Returns {credit_days,wp,eff,tier} or null.
function rainCreditDaysTiered(tier, wi, hy, measuredOnly=false){
  const ia = RAIN_TIER_IA[tier] ?? RAIN_TIER_IA.unknown;
  const hold = RAIN_TIER_HOLD[tier] ?? RAIN_TIER_HOLD.unknown;
  const wp = creditPrecip(hy, measuredOnly); if(wp==null) return null;
  const eff = wp - ia;
  if(eff<=0) return null;
  return { credit_days: Math.min(hold, wi), wp: Math.round(wp*100)/100, eff: Math.round(eff*100)/100, tier }; }

// The >=85F fabric-bag rule is a DEMOTION, not a denial: a bag that EARNED the full fabric_ground credit must not drop to zero at
// any rain depth (a denial made a 3-day cliff across 1°F, on a gridded tmax carrying +-2-3F of error). The demotion is a SCALAR on
// the earned credit, floored — both numbers named in ledgerParams; the floor is what keeps this a demotion under a future retune.
// Returns the rc unchanged when nothing was earned: a gate that fires on no credit has nothing to withhold, and the caller's note
// must not claim otherwise.
// SEPARATE from the ledger path's rule (ledger.demoteDepth's one-class walk, whose replacement is deliberately deferred by crucible
// verdict C5). Do not fold the two.
function bagHeatDemoteCredit(rc){
  if(!rc) return rc;
  const d=Math.max(LP.RAIN_DAY.bagHeatMinCreditDays, Math.floor(rc.credit_days*LP.RAIN_DAY.bagHeatSoftenFactor));
  return { ...rc, credit_days: d, bag_heat_from: rc.credit_days }; }

// ── Heavy-soak saturation cap (FLAG-INDEPENDENT) ──
// Over-watering already-saturated media (esp. fabric bags with no drying window) drives anoxia / root rot = NON-recoverable, so in
// the heavy-soak regime the safe error inverts to "skip". Applies to ALL outdoor vessels UNIFORMLY: rain depth saturates media
// regardless of vessel, and container_type is sparsely populated, so a vessel-agnostic gate is the only design robust to the dominant
// NULL case (NULL is outdoor -> suppressed -> fails safe). covered/indoor never got the rain -> exempt. Independent of
// CARE_RAIN_CREDIT_ENABLED so the credit-ON flip cannot bypass it. Recovery is automatic as the 72h windowPrecip decays.
// The thresholds below live in wateringThresholds.json, shared with src/lib/wateringScale.js (the WeatherWidget headline on Today),
// so the two models cannot straddle one number and print "All set" above a full watering list. The file lives in THIS directory
// because deploy-lambda.yml packages it with `zip -r .`; the client bundles it at build. src/lib/wateringModelParity.test.js fails
// if either module reintroduces a literal.
const SOAK_THRESHOLDS = require('./wateringThresholds.json');
const SOAK_CAP_IN = SOAK_THRESHOLDS.SOAK_CAP_IN;                 // >= this over the 72h windowPrecip -> suppress outdoor watering
const SOAK_WET_FLOOR_IN = SOAK_THRESHOLDS.SOAK_WET_FLOOR_IN;     // "already moist" prerequisite for the incoming-rain trigger
const SOAK_FCST_QPF_IN = SOAK_THRESHOLDS.SOAK_FCST_QPF_IN;       // incoming 24h amount that counts
const SOAK_FCST_POP_PCT = SOAK_THRESHOLDS.SOAK_FCST_POP_PCT;     // min PoP for an incoming-rain skip
// DERIVED, not picked: the bar for acting on a FORECAST for a small vessel, written as arithmetic so it can be re-checked.
//   need    0.075"/day  — Dave-observed satisfaction figure for a mulched container.
//   loss    0.17"       — RAIN_TIER_IA.small_fast above: this engine's own initial abstraction for a small fast-drying vessel
//                         (live under CARE_RAIN_CREDIT_ENABLED). It already prices the "canopy sheds water" physics; counting
//                         that effect again here would double-charge it.
//   => a container banks a full day only once rain clears 0.17 + 0.075 = 0.245".
//   haircut 0.47        — this branch acts on a FORECAST, not a gauge. The worst realized/forecast ratio on a day that cleared
//                         the PoP gate over 56 days of prior_runs was 0.47 (1.42" forecast, 0.67" delivered).
//   => 0.245 / 0.47 = 0.5213", rounded UP to 0.53": a safety bar must round toward watering (0.52 banks 0.0744" against a 0.075"
//      need). Two decimals is the gauge's resolution; more would be false precision on a 4-sample haircut.
// Decision on record: lowering the loss term (0.35 -> 0.17) moved this bar from 0.91" to 0.53", a real widening of FORECAST-based
// suppression for containers ("skip the pots, rain is coming"), the one direction the cost asymmetry below argues against. If a
// busted forecast ever dries a pot, THIS is the line to revisit; the honest fix is to decouple the two terms (a gauge reading is a
// fact, a forecast is a guess), not to re-raise the measured-credit IA, which answers a different question.
// soakcontainer.test.js executes the derivation, so the constant cannot drift from its inputs, and its "stays strictly above the
// qualifying gate" assertion keeps it from collapsing into dead code.
//
// Designing to the worst bust is deliberate: a false WATER on a free-draining vessel costs nothing, while a false SKIP above 85F
// aborts pepper/tomato flowers within 24h and locks in blossom-end-rot 2-3 weeks later (Ca is transpiration-delivered, so the damage
// is invisible when caused and irreversible when it shows).
//
// FLOOR: todayQualifies() gates on `q >= SOAK_FCST_QPF_IN` (0.5"), so any value <= 0.5 makes this constant dead code and silently
// collapses containers onto the bed bar. The meaningful domain is strictly (0.5, inf). It is near-inert at any value above ~0.74"
// because of the PoP+0.5" gate and the branch ordering; lowering it to force it to fire would be fitting to a single observed day.
const SOAK_TODAY_SMALL_IN = SOAK_THRESHOLDS.SOAK_TODAY_SMALL_IN; // today-forecast bar for small vessels (bags/pots/cells)
const SOON_QPF_IN = SOAK_THRESHOLDS.SOON_QPF_IN;                 // near-term (next few hours) amount that counts — 'soon' branch
// The sat_kinds that rest on a FORECAST rather than on measured water. Membership decides subordination to
// the carve-outs in _satApplies (freshTransplant, youngBed, newTransplant, vesselHeatGate). A new forecast branch that
// forgets to enrol here silently gains the right to starve a fresh transplant, so this is the one place to add it.
const FORECAST_SAT_KINDS = new Set(['today', 'incoming_dry', 'soon']);

// ONE reason string per sat_kind, in one place. It is the user's only explanation for why a thirsty plant was skipped, so an unknown
// kind must degrade to a truthful generic rather than assert the opposite reason (an inline ternary whose trailing `else` assumed
// 'incoming' would have printed "rain incoming on already-wet media" over a DRY deferral).
const popSuffix = (pop) => (pop == null ? '' : ` @ ${pop}%`);
function satReason(sat){
  switch(sat && sat.kind){
    case 'soak':
      return `Skip — saturated (heavy soak, ${sat.wp}" over the last few days; let it drain)`;
    case 'today':
      return `Skip — ${sat.fq}" rain falling today${popSuffix(sat.pop)}`;
    case 'incoming':
      return `Skip — rain incoming on already-wet media (${sat.fq}" forecast${popSuffix(sat.pop)}); let it drain`;
    case 'incoming_dry':
      return `Skip — ${sat.fq}" rain expected tomorrow${popSuffix(sat.pop)}; waiting for it beats watering twice`;
    case 'soon':
      return `Skip — ${sat.fq}" rain expected within a few hours${popSuffix(sat.pop)}`;
    default:
      return `Skip — rain expected${popSuffix(sat && sat.pop)}`;
  }
}
// Returns { wp, kind:'soak'|'incoming'|..., fq?, pop? } when an outdoor planting must NOT be watered (media saturated, or wet with more
// rain imminent = no drying window), else null. Pure fn of hydrology + exposure.
// The 'today' branch asks "is meaningful rain forecast for TODAY?" with the already-approved SOAK_FCST_QPF_IN / SOAK_FCST_POP_PCT bar,
// so it applies an existing bar to a horizon rather than adding a new agronomic judgement.
//
// FAIL-CLOSED ON A NULL PoP, unlike the tomorrow branch below (`pop==null ||`). A missing tomorrow probability is re-evaluated
// overnight before anyone acts; for TODAY it would suppress every outdoor planting on an amount with no probability attached
// (fetchPrecip sets today_pop:null whenever Open-Meteo omits it), and the engine's convention (isSmallVessel, rainTierFor) is that
// unknown fails safe toward WATERING.
//
// WHAT THIS GATES: a PoP is a probability that rain WILL fall; it is meaningless applied to rain that already HAS. today_precip_in is
// measured + still-expected, so gating it whole let a fail-closed PoP veto water already in the ground. This reads the still-expected
// part only (todayForecastIn); the measured part is judged by the soak cap, which owns water in the media.
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
  // Both default FALSE, so an un-updated caller — and every existing fixture and parity golden — is byte-identical.
  const deferDry = !!(opts && opts.deferDry);
  const soonAware = !!(opts && opts.soonAware);
  // DISJOINT TERMS. windowPrecip is `recent + today`, and `today` is a FORECAST, so the soak cap is part-prediction. Left that way, any
  // forecast >= SOAK_CAP_IN trips SOAK before the today branch is reached, making the small-vessel bar dead code and letting a busted
  // forecast suppress a fabric bag through the one branch that outranks the heat gate. So with today-awareness on, soak judges ACTUALS
  // ONLY and the forecast is judged below, with its own bars, subordinate to the fast-dry carve-outs. Flag OFF keeps the original basis.
  // "ACTUALS" MUST INCLUDE TODAY'S GAUGE: today_precip_in is gauge-driven (observed + unelapsed hourly), so reading recent alone dropped
  // physically MEASURED rain out of the cap and re-gated it behind a PoP, inverting the cap's purpose. today_observed_in is ABSENT with
  // no bound station, so this term is 0 there and the flag-ON no-gauge path is unchanged.
  const soakBasis = todayAware ? ((hy.recent_precip_in || 0) + (hy.today_observed_in || 0)) : wp;
  if(soakBasis >= SOAK_CAP_IN) return { wp: Math.round(soakBasis*100)/100, kind: 'soak' };
  const fq = hy && hy.tomorrow_precip_in, pop = hy && hy.tomorrow_pop;
  // The "already wet" prerequisite reads soakBasis, the same MEASURED term the soak cap judges, not windowPrecip: "already wet" is a
  // claim about water in the media right now, and windowPrecip's D0 half is today's unelapsed hourly FORECAST, so the old form let
  // rain that has not fallen satisfy the wetness floor and then skip on a second forecast (tomorrow's). It reports the basis it
  // actually judged: sat_wp is the forensic field for "did we skip on a forecast that busted?". todayAware OFF -> soakBasis === wp,
  // so the flag-OFF path (condition AND payload) is byte-identical.
  if(soakBasis >= SOAK_WET_FLOOR_IN && fq!=null && fq >= SOAK_FCST_QPF_IN && (pop==null || pop >= SOAK_FCST_POP_PCT))
    return { wp: Math.round(soakBasis*100)/100, fq, pop, kind: 'incoming' };
  // TODAY. Ordered LAST so it can never pre-empt the two branches that act on water already in the media, and evaluated against the
  // raw forecast, NOT windowPrecip, so today is never counted twice (one 0.6" event would otherwise satisfy both the "0.5 already
  // wet" floor and the "0.5 more coming" bar, silently halving SOAK_CAP_IN). Judged against todayForecastIn, the STILL-EXPECTED
  // part, so the gauge's measured share is counted once, in soakBasis; fq reports the number the bar was applied to.
  if(todayAware && todayQualifies(hy)){
    const bar = (opts.smallVessel ? SOAK_TODAY_SMALL_IN : SOAK_FCST_QPF_IN);
    const tf = todayForecastIn(hy);
    if(tf >= bar)
      return { wp: wpR, fq: tf, pop: hy.today_pop, kind: 'today' };
  }
  // ── 'incoming_dry' — the same judgement as 'incoming' without its wetness precondition ──
  // "Should we give a moderate soak today when we expect an inch tomorrow?" 'incoming' declines to fire for a DRY planting (its
  // `soakBasis >= SOAK_WET_FLOOR_IN` prerequisite), which is exactly that scenario, so this applies the same bars without the
  // precondition: not a new agronomic bar.
  //
  // THE BARS ARE DELIBERATELY UNCHANGED at SOAK_FCST_QPF_IN / SOAK_FCST_POP_PCT. Backtested over 85 days of stored plans, 0.50"/60%
  // fired 9 times with zero busts and 0.75"/80% fired 4 times, also zero busts: no evidence for a stricter constant. Caveat: 9 firings
  // over one summer is thin and PoP calibration shifts by season; revisit with a full year.
  //
  // TWO THINGS DO CHANGE for the dry case, because they are wrong here rather than merely permissive:
  //  1. FAIL CLOSED ON A NULL PoP. 'incoming' accepts `pop==null` because an already-wet planting can wait for the overnight
  //     re-evaluation; a DRY planting cannot, so a missing probability must not defer it. Follows todayQualifies and the engine's
  //     convention that unknown fails safe toward WATERING.
  //  2. SUBORDINATE TO THE FAST-DRY CARVE-OUTS (see _satApplies): like 'today', this yields to freshTransplant and bagHeatGate. A
  //     forecast busts; a fresh transplant in a hot fabric bag does not get a second chance.
  //
  // Flag-gated, OFF by default (the shape CARE_TODAY_AWARE_ENABLED and CARE_RAIN_CREDIT_ENABLED used). Reports its own basis in `wp`
  // and carries a DISTINCT sat_kind, so "did we skip on a forecast that busted?" stays answerable and it is never confused with the
  // wet-media branch in the stored payload.
  if(deferDry && fq!=null && fq >= SOAK_FCST_QPF_IN && pop!=null && pop >= SOAK_FCST_POP_PCT)
    return { wp: Math.round(soakBasis*100)/100, fq, pop, kind: 'incoming_dry' };
  // ── 'soon' — "in the next few hours, is it going to give us another quarter inch?" ──
  // Ordered LAST because it is the narrowest claim: it only fires on what the other branches missed. The rest-of-day sum the 'today'
  // branch judges cannot answer this at 07:00; today_next_in is the same hourly grid bounded to the next few hours
  // (station.NEAR_TERM_WINDOW_H), so a concentrated imminent shower clears this bar and a day of scattered maybes does not.
  // SOON_QPF_IN is 0.25: it clears every per-tier initial abstraction in RAIN_TIER_IA (0.17-0.25), so a quarter inch does something
  // for every vessel rather than wetting the surface.
  // This is the LOWEST-RISK forecast branch though the bar looks loose: the horizon is ~3 hours and the plan regenerates HOURLY, so a
  // bust is corrected within the hour with most of the watering day still ahead; at three runs a day it would be indefensible.
  // today_pop is a DAILY maximum probability, so it is only a sanity floor on the day being rainy at all.
  if(soonAware){
    const soon = hy && hy.today_next_in, tPop = hy && hy.today_pop;
    if(soon!=null && soon >= SOON_QPF_IN && tPop!=null && tPop >= SOAK_FCST_POP_PCT)
      return { wp: wpR, fq: soon, pop: tPop, kind: 'soon' };
  }
  return null;
}

// Returns a fertilize recommendation object IF one is warranted now, else null. Substrate-aware.
function fertilizeRec(p, c, fm, today){
  // Profile-declared never-feed, FIRST, ahead of the phase gate. NO INTERVAL VALUE CAN EXPRESS "NEVER FEED": `never` (below) cards any
  // planting with no feed history whatever `iv` says, and the recency gate only holds a card down once a feed exists, so the largest
  // interval anyone can write still produces the first card.
  // WHY THE KEY, not an omitted interval: v_resolved_care merges system||cultivar||leaf with jsonb `||` (shallow, right-wins) and the
  // system row carries fertilize_interval_days:14, so a cultivar row that OMITS the key silently INHERITS 14. Only a key that is READ
  // can refuse.
  // Mirrors the no_calendar_water arm (feedSuppression, below waterSuppression). AHEAD of the phase gate deliberately: never-feed is a
  // property of the plant, not of its substrate age, and a guard sitting behind a gate that already returns null for the plantings it
  // protects is a guard no test can see fail.
  if(feedSuppression(p,c)) return null;
  const wk=weeksSince(today, p.substrate_start);
  const phase=feedPhase(wk);
  const am=fm.amendments_in_inventory;
  // During establishment + MG-active: NO routine feed. (mix is feeding.)
  if(phase==='establishment_0_2wk' || phase==='mg_active_3_12wk' || phase==='unknown') return null;
  // Tapering / spent: feed heavy feeders, or anything past its cadence interval with a fert history.
  const dF=daysBetween(today,p.last_fert);
  // A NON-POSITIVE INTERVAL IS NOT A CADENCE — it is normalized to null (unknown), never carried. fertilize_interval_days:0 read as "feed
  // every day": the recency gate below needs dF<0 and can never fire, and `due` (dF>=0) is true the moment the plant is fed at all, so
  // the card returns every morning. The engine does NOT read 0 as "no calendar feeding": an overloaded numeric sentinel is what made this
  // ambiguous, and no_calendar_feed now says it in words. This also agrees with the downstream reader, daily-plan-read/doneEvents.js,
  // which refuses to price a cadence it cannot use (`if (!(iv > 0)) return false;`).
  // NaN falls out for free (typeof NaN === 'number', NaN > 0 is false).
  // On the plan path resolveCadence restores the default before `c` gets here, so this is the backstop for a `c` built any other way.
  const _ivRaw=(typeof c.fertilize_interval_days==='number')?c.fertilize_interval_days:null;
  const iv=(_ivRaw!=null && _ivRaw>0)?_ivRaw:null;
  // RECENCY GATE, ahead of every qualifying branch below. `due` is only ONE of three ORed reasons to recommend a feed: a heavy feeder in
  // flower/fruit and needs_feed_24wk_plus carry no recency check, so a planting matching either would be recommended EVERY DAY
  // regardless of when it was last fed. A card that returns the day after you act on it is the affordance-extinction pattern the
  // watering canon (V100 §"Pre-F2 interim snooze semantics") already forbids on the water arm.
  // Gated on a KNOWN interval AND a KNOWN last feed, deliberately: dF==null means "never fed" and still falls through, because
  // suppressing that case would be the dangerous direction (silence about a plant that needs feeding).
  if(dF!=null && iv!=null && dF<iv) return null;
  const due = (dF!=null && iv!=null && dF>=iv);
  // "Never fed" is a qualifying reason in its OWN right. The recency gate above lets dF==null fall through, but every other disjunct below
  // is unsatisfiable for a never-fed planting that is not a heavy feeder in flower or fruit: `due` needs a last-feed date by construction,
  // and needs_feed_24wk_plus needs 24 weeks of substrate history that may not exist yet. Silence about a plant that has never been fed is
  // the dangerous direction.
  // Scoped by what has already run above: anything reaching this line cleared the phase gate, so it is in mg_tapering_13_24wk or beyond,
  // past the window in which the mix is doing the feeding (fertilization-model.json marks it `feed: begin_light`). It cannot become a
  // nag: the card clears on the CADENCE axis (feed's axis, not water's day axis), so once a feed is logged dF stops being null, `never`
  // goes false, and the recency gate holds the card down for the next `iv` days.
  const never = (dF==null);
  const heavy=isHeavyFeeder(c.crop);
  if(!(due || never || (heavy && ['flowering','fruiting'].includes(p.status)) || (phase==='needs_feed_24wk_plus'))) return null;
  if(isMedHerb(c.crop)) return null;            // Mediterranean herbs: never force-feed (leaky; see isMedHerb)
  // pick amendment by crop/stage
  let rec;
  if(isAcidLover(c.crop)) rec={item:'acidic fertilizer (Holly-Tone — NOT in inventory; acquire)', apply:'top-dress; use rainwater', note:'acid-lover; hard well water raises pH'};
  else if(heavy || ['flowering','fruiting'].includes(p.status)) rec={item:am.fruiting_feed.item, apply:am.fruiting_feed.apply, alt:am.kelp.item+' (sprayer)'};
  else if(isLeafy(c.crop)) rec={item:am.veg_feed.item, apply:am.veg_feed.apply};
  else rec={item:am.castings.item, apply:am.castings.apply};
  // `interval` = this row's OWN feeding cadence, mirroring the water rows' `interval` (each row carries the clock it is judged against).
  // The read-time check-off is cadence-aware for feeding, and daily-plan-read cannot re-resolve cadence itself.
  //
  // SPA safety: careNeeded.js consults `interval` at three sites: needReason and needTier (both gated on need) and buildCareNeeded, which
  // computes it for EVERY need and feeds reasonRedundant (gated) and overdueBy (NOT gated). The change is safe for two INDEPENDENT
  // reasons: (1) fertilizeRec emits no `overdue_by`, so overdueBy's `typeof … === 'number'` arm is already false for a feed row; (2)
  // isDailyCadence is `=== 1` and the minimum fertilize_interval_days in cadence-data-v2.json is 7.
  // Trap: that redundancy makes a careNeeded test asserting `overdueBy === null` VACUOUS (verified by mutation). If you add a 1-day feed
  // cadence, or widen isDailyCadence past `=== 1`, reason (2) dies and only (1) holds, so check overdueBy against a feed row that
  // actually carries `overdue_by` first.
  // `never` on the item for the same reason the water rows carry one: an overdue card and a never-fed card are the same shape and mean
  // different things, and only the engine can tell them apart. Additive key, so PLAN_SCHEMA_VERSION is deliberately NOT bumped (readers
  // select named keys; doneEvents.fedWithinInterval reads only `id` and `interval`).
  return {id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:isHeavyFeeder(c.crop)&&false,status:p.status,weeks_since_pot:wk,phase,interval:iv,never,...rec};
}

function coldFor(p, cad, low, frostAlertEnabled=false, frostCoverage=null){
  if(low==null) return null;
  const c=resolveCadence(p,cad);
  // The already-indoors check is HOISTED above the solanaceous band: below it, a planting the band caught could never be silenced by doing
  // the one thing its card asked (a Peppermint with brought_inside logged still returned bring_in at 38F while a profile-path plant
  // returned null). Hoisting can only SUPPRESS a card, never create one, and it covers both paths identically.
  if(broughtInside(p)) return null;
  // A planting whose location is HEATED is already where every level of this card would send it. `heated_resolved` is locations.heated off
  // the planting's location, else its project's (handler.js), and is deliberately NOT `covered`: the Stable is covered and UNHEATED and
  // holds more live plantings than the House, so a covered test would silence the population this card exists for.
  // Strict `=== true`: absent or NULL (un-located planting, older caller) means NOT heated, which fails toward a card.
  if(p.heated_resolved===true) return null;
  // "Bring it inside" cannot be done to a plant in the ground, so an in-ground planting relies on the frost ALERT, which counts in-ground
  // plantings and tells Dave to cover them. Only the two BRING-IN levels are dropped; `optional` can be done in the ground.
  // Only while that alert can SEND: with FROST_ALERT_ENABLED off (the F6 kill switch, handler.js) nothing publishes, so dropping the card
  // would leave an in-ground tender planting with no cold message on either channel. The handler passes its flag in; absent means OFF,
  // which fails toward a card. Deliberately NOT gated on frost season: the frost alert publishes all year, so a season gate would put the
  // unactionable card back beside it.
  // And only when the alert actually NAMES this planting for this forecast: a class-only check also dropped the card on nights the alert
  // stayed silent (NWS 39F with Open-Meteo D1 42F trips neither tier). frostCoverage is frostEval.frostCoverage over the handler's OWN frost
  // decision for this Space and run, so it cannot drift from the email. The card drops only when the planting reads 'named', or
  // 'above_band' (the low is above its crop's frost band, where the alert is silent by design and the 41-50F in-ground gap is accepted).
  // 'unnamed', no entry (hardy by class, heated, not in the exposure) and no coverage at all (an older caller, or the handler could not
  // evaluate) all keep the card.
  const _cov=frostCoverage&&typeof frostCoverage.get==='function' ? frostCoverage.get(p.id) : undefined;
  const _inGroundAlerted=frostAlertEnabled===true&&likelyInGround(p,c)&&(_cov==='named'||_cov==='above_band');
  if(isSolanaceous(p)){
    if(low<40) return _inGroundAlerted ? null : {level:'bring_in', text:`bring inside tonight (low ${low}°F)`};
    if(low<45) return ['flowering','fruiting'].includes(p.status) ? {level:'optional', text:`optional: protect flowering plant (low ${low}°F)`} : null;
    return null;
  }
  // No free-text `/houseplant|succulent|cactus/i.test(c.crop)` early return here, deliberately: it discarded the protect_below_F thresholds
  // the crop-type table (COLD_BY_CROP_TYPE) was written for, so houseplants with an explicit threshold returned null at EVERY temperature.
  // It also keyed on `crop`, uncontrolled free text, so the SAME crop_type_slug got opposite protection on wording alone (`Neon Pothos`
  // protected, `Pothos` never). Not re-expressed on crop_type_slug either: the resolution below already returns null for every planting
  // with no protect_below_F, so a slug-keyed restatement would be the redundant second guard that frostClass argues against (mutate
  // either and the other holds, so no test can watch one fail).
  // The nightly-nag mitigation is the broughtInside check at the TOP of this function. `done` (doneEvents.js) only retires a task for the
  // CALENDAR DAY, so without it the card returns every night the low is under the threshold, all winter, for a plant already on the
  // windowsill. brought_inside/brought_outside are a true toggle: the plant is indoors iff the LATER of the two is brought_inside. Unknown
  // (neither ever logged) means outdoors, the fail-safe direction: it warns about a plant that is already in rather than staying silent
  // about one that is out.
  // Cold-profile resolution, most specific first. Variety/genus/DB (`c.cold`) stays authoritative;
  // the crop-type table is the FALLBACK beneath it, never an override. Ginger, and every other
  // tropical with no hand-authored variety row, reaches a profile only via this second tier.
  const ct=c.cold ? null : fc.coldProfileForSlug(p.crop_type_slug);
  const prof=(c.cold && c.cold.tender) ? c.cold : (ct && ct.tender ? ct : null);
  const pb=prof ? prof.protect_below_F : null;
  if(pb!=null && low<=pb) return _inGroundAlerted ? null : {level:'protect', text:`tender tropical — bring in tonight (low ${low}°F ≤ ${pb}°F)`};
  return null;
}

// True when the planting's most recent move event says it is indoors. Dates are 'YYYY-MM-DD' strings
// from the handler, so a lexicographic compare IS a chronological one.
function broughtInside(p){
  const in_=p && p.last_brought_inside, out=p && p.last_brought_outside;
  if(!in_) return false;
  return !out || in_>=out;
}

// ── Dormancy/growth-cycle watering suppression ──
// Some care profiles (Lithops-class succulents) mark watering as NOT calendar-drivable: no_calendar_water:true and/or
// water_rule:'growth_gated'. Without this gate nothing read those signals and the plan issued interval watering for a summer-dormant
// Lithops (watering during dormancy rots it).
// Sources checked IN ORDER: the resolved cadence `c` AND the raw DB profile p.db_cadence. The raw read is load-bearing: resolveCadence
// adopts db_cadence only when a scope CONTRIBUTED A CADENCE KEY, and a profile can declare suppression while carrying no watering interval
// at all (the Lithops class: signals present, cadence key absent), so a c-only check would drop the signal. no_calendar_water (explicit,
// stronger) wins the label when both are set. Returns 'no_calendar_water' | 'growth_gated' | null.
// Suppression is LOUD, never silent: the caller routes the planting to counts.dormancy_suppressed + tasks.dormancy_suppressed with a
// per-item rule + reason, so a suppressed planting is distinguishable from a forgotten one. Watering ONLY — fert/pest/cold generation is
// untouched. The check sits in the shared pre-branch path of generatePlanForUser so it applies identically under EVERY flag combination:
// a guard written inside one flag branch would be silently deleted when the flag flips.
function waterSuppression(p, c){
  const srcs=[c, p&&p.db_cadence];
  for(const s of srcs){ if(s && s.no_calendar_water===true) return 'no_calendar_water'; }
  for(const s of srcs){ if(s && s.water_rule==='growth_gated') return 'growth_gated'; }
  return null;
}

// ── Profile-declared feeding suppression ──
// The feed-arm twin of waterSuppression, deliberately its exact shape. `no_calendar_feed:true` in a care_profile means "this plant is never
// fed on a calendar" — the only way to say so, because the merge that builds the profile cannot express a refusal as a number (see
// fertilizeRec). care_profile.profile is unconstrained jsonb, so the key needs no migration. One rule, one label -> 'no_calendar_feed' | null.
//
// THE TWO-SOURCE READ IS LOAD-BEARING, same exposure as the water arm: resolveCadence adopts db_cadence only when a scope contributed a WATER
// cadence key, so a profile that declares no_calendar_feed with no watering interval falls to the bundled JSON, and checking `c` alone would
// drop the signal. Read `c` first so a leaf-scope override still wins where one exists.
// `===true` (not truthiness): the string "yes" is a typo, not a refusal, and silently never-feeding a plant on a typo is the dangerous direction.
function feedSuppression(p, c){
  const srcs=[c, p&&p.db_cadence];
  for(const s of srcs){ if(s && s.no_calendar_feed===true) return 'no_calendar_feed'; }
  return null;
}

// ── Per-planting ledger verdict (only reached when the flag is ON) ──
// Computes wi_eff (RETIRES the >=88F heat gate and the maxdays ceiling in-flag: keeping them next to ET scaling double-counts heat; tray class
// hard-caps at 1 day), the drought-tolerant late-bias threshold, the fold, and server-side confidence. Returns the additive `ledger` payload key
// plus the INTEGER calendar-day fields the three readers depend on ((e->>'overdue_by')::int at dashboard handlers.js throws 22P02 on any fraction).
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
    // Today's rain for the fold's D0 day-credit: today_observed_in ONLY, the identical term creditPrecip spends at the measured-basis line, so the
    // ledger and the legacy chain credit the same inches on the same day. Absent (no bound station or hydrology) -> null -> no D0 credit, matching
    // legacy's degrade-to-`recent`.
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

// rainMaxDaysEnabled gates the max-days CEILING independently of rainCreditEnabled (which gates the tiered credit). Trailing param, default false
// -> every existing caller keeps flag-OFF behaviour and the plan stays byte-identical until an env flip.
// `ledgerOpts` (10th param, default null) carries the Water Ledger inputs from generatePlan — {enabled, eventsByPlant, weatherByDate, weatherRowCount,
// effNowMs}. Null/absent -> byte-identical legacy path; the fold requires BOTH the flag and a real event window (a failed event-window read degrades
// the whole run to flag-OFF, per the canon fail-to-today's-model rule).
// `satOpts` is an OBJECT, not two more positionals: this list is already twelve deep and every caller passes them by position, so more booleans
// would be one transposition away from silently arming a suppression branch. Defaults to {} so every existing caller is byte-identical.
function generatePlanForUser(plantings, cad, fm, today, weather, hydrology, rainCreditEnabled=false, rainMaxDaysEnabled=false, todayAwareEnabled=false, ledgerOpts=null, measuredCreditEnabled=false, droughtState=null, satOpts={}, frostAlertEnabled=false, frostCoverage=null){
  const _ledgerOn = !!(ledgerOpts && ledgerOpts.enabled && ledgerOpts.eventsByPlant);
  const water=[], fertilize=[], pest=[], cold=[], dormant=[], rainSkipped=[], waterSuppressed=[], overwintering=[], feedSuppressed=[];
  let overwinterHeld=0, overwinterDeferred=0;
  const phaseCounts={};
  const low=weather?weather.tonightLow:null, high=weather?weather.highToday:null, hot=high!=null&&high>=HOT_F;
  const hotForBag=high!=null&&high>=BAG_HEAT_GATE_F;   // fabric-bag heat-gate signal
  for(const p of plantings){
    // Skip plantings whose parent PROJECT is still in 'planning': not yet physically planted, so they must not generate care tasks. The planning
    // state lives on the parent project (p.project_status), not on the planting.
    if(p.project_status==='planning') continue;
    const c=resolveCadence(p, cad);
    if(c.exclude) continue;
    const ph=feedPhase(weeksSince(today,p.substrate_start)); phaseCounts[ph]=(phaseCounts[ph]||0)+1;
    // `reason` discriminates the two unrelated causes this bucket merges: 'status' = status='dormant', which a human set and only a human clears
    // (resumable); 'profile' = the cadence flag (dormant_skip, Lithops only), which is care DATA, not status: clearing a status it never had is
    // meaningless, and watering it now rots it. Same dormant_skip-wins precedence as `note`. Additive key; PLAN_SCHEMA_VERSION deliberately NOT
    // bumped (readers select named keys).
    if(p.status==='dormant' || c.dormant_skip){ dormant.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,reason:c.dormant_skip?'profile':'status',note:c.dormant_skip?c.notes:'Dormant — skip routine care'}); continue; }
    // Profile-declared calendar-watering suppression. Evaluated BEFORE any watering computation and BEFORE any flag fork, so it binds identically
    // under every flag combination. Suppressed plantings get NO water_due/no_history/rain_skipped item — they land LOUDLY on
    // tasks.dormancy_suppressed (+ counts.dormancy_suppressed) with the rule + guidance, and still flow through fert/pest/cold below.
    const _wsup=waterSuppression(p,c);
    // Overwinter state, in the same shared pre-branch path as the suppression gate and for the same reason: a guard written inside one flag fork is
    // silently deleted when the flag flips.
    //
    // PRECEDENCE IS ENFORCED BY THE BRANCH ORDER BELOW, not by this line — waterSuppression WINS. A no_calendar_water profile is the Lithops class,
    // where an interval-driven prompt is what killed the plant; overwintering's reduced check would re-introduce exactly that prompt at a longer
    // period. The `if(!_wsup)` is a short-circuit only (skip date maths we would discard); deleting it changes no behaviour, which is why the
    // precedence guard in overwinter-engine.test.js mutates the BRANCH ORDER rather than this expression.
    //
    // A throw here must not end the run for every Space: it degrades this planting only, to the DEFAULT window (stored from/until ignored). _ow is
    // never nulled on a throw: null means "not overwintering", which would hand a dormant plant fertilize and water rows. If even the default window
    // throws, the planting is skipped for tonight rather than mis-carded, and that skip logs at ERROR so the Lambda error-log alarm path still sees a
    // run that dropped cards.
    let _ow = null;
    if(!_wsup){
      try { _ow = ow.overwinterState(p, c, today); }
      catch(e){
        console.warn(JSON.stringify({ msg: 'overwinter-state-throw', planting: p.id, error: e?.message }));
        try { _ow = ow.overwinterState(p, c, today, undefined, { defaultWindow: true }); }
        catch(e2){
          console.error(JSON.stringify({ msg: 'overwinter-state-throw', planting: p.id, fallback: true, error: e2?.message }));
          continue;
        }
      }
      if(_ow && _ow.bad_dates) console.warn(JSON.stringify({ msg: 'overwinter-bad-date', planting: p.id, fields: _ow.bad_dates }));
    }
    if(_wsup){
      // The drought signal rides HERE, appended to the reason and mirrored as a structured key. It does NOT amend the suppression rule (water only on
      // plant signals, never by interval): a long absence of any root-zone-wetting rain IS a plant signal, which this profile class had no way to
      // receive. No branch reads it, so a suppressed planting is never routed to water_due by weather alone.
      // Both keys are ADDITIVE on an existing row -> PLAN_SCHEMA_VERSION deliberately NOT bumped (every reader selects named keys; a bump nulls the
      // plan in three reader Lambdas with no regeneration path).
      const _dnote = dr.droughtNote(droughtState);
      waterSuppressed.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,rule:_wsup,
        moisture:(p.db_cadence&&p.db_cadence.soil_moisture_target)||c.soil_moisture_target||null,
        reason:(_wsup==='no_calendar_water'
          ? 'Watering suppressed — profile: NO calendar watering; water only on plant signals, never by interval'
          : 'Watering suppressed — profile: growth-gated; water only during active growth, never by interval')
          + (_dnote ? ` — ${_dnote}` : ''),
        ...(_dnote ? {drought:{dry_days:droughtState.dryDays, deep_soak_in:droughtState.deepSoakIn,
          last_deep_soak:droughtState.lastDeepSoakDate, truncated:droughtState.truncated}} : {})});
    } else if(_ow && _ow.active){
      // HELD OUT of water_due / no_history / rain_skipped, and given a reduced-cadence MOISTURE CHECK — NOT a skip. A cover sheds the rain that would
      // have reached the bed and indoor heat dries a pot faster than July does, so inheriting dormant's "skip routine care" is how an overwintered
      // crop dies of a dry freeze. The item asks Dave to feel the soil, never to water unconditionally.
      overwinterHeld++;
      const _wiOw = ow.checkIntervalFor(_ow, baseWaterInterval(p, c, cad));
      // _ow carries rain_counts, so a covered/indoor regime reads last_hand_water and a logged rain no longer clears its check. Passing _ow is
      // load-bearing — dropping the second argument silently restores the rain credit for all three protected regimes.
      const _touch = ow.lastTouch(p,_ow);
      const _dOw = daysBetween(today,_touch);
      // dW==null (never watered, never checked) is DUE: an untouched pot through a winter is the case
      // most worth surfacing, and "no history" is not evidence of a damp medium.
      const _dueOw = _dOw==null || _dOw>=_wiOw;
      // Due is not the same as WORTH FIRING: field_hardy alone is weather-gated (the only regime the weather can reach); the card SLIPS to the next
      // workable day rather than being cancelled, because nothing here writes to lastTouch.
      const _actOw = _dueOw && _ow.regime==='field_hardy' ? ow.fieldHardyActionable(weather,hydrology) : null;
      if(_dueOw && _actOw && !_actOw.actionable){ overwinterDeferred++; }
      else if(_dueOw){
        // The moisture TEST is regime-specific and `reason` is the ONLY place the user reads one (`note` carries the full guidance but no surface renders
        // it). protected_quiescent reads the pot's WEIGHT at both ends, not the top inch: the top inch on a leafless pot is dry long before the core is
        // (overwinter.js regime table), and on a peat mix dried past its wetting agent a re-water runs down the shrinkage gap and out the hole, reads as
        // watered, and leaves the core dry. "only until it feels heavier" is the stop condition a channelled watering cannot satisfy.
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
    const inGround=likelyInGround(p,c);
    let wi=baseWaterInterval(p, c, cad);
    // The ledger fold consumes the PRE-heat-gate interval: the >=88F wi-=1 gate is RETIRED in-flag (continuous ET0 demand subsumes it).
    const _wiBase = wi;
    // Vessel floor. Placed HERE, between _wiBase and the heat gate: AFTER _wiBase so the ledger fold never sees it (the ledger already models vessel
    // size continuously; layering this coarse floor on top would double-count), and BEFORE the heat gate so a >=88F day still walks a
    // low-drought-tolerance planting back down to 1 (heat is when a trough pepper wants daily water). That makes it a no-op on hot days and +1 day
    // only on ordinary ones, the most conservative placement available.
    const _floor = dailyFloorFor(p);
    if(_floor!=null && wi<_floor) wi=_floor;
    if(hot && c.drought_tolerance==='low' && wi>1) wi=wi-1;
    // Flag-ON only: clamp the interval to the substrate x stage ceiling so a rain-credited planting still re-surfaces for a moisture check. Flag-OFF
    // leaves wi as computed above. The tier is needed by EITHER flag (credit uses it for IA/hold, the ceiling for the clamp), so derive it when either
    // is on; the clamp itself is gated on rainMaxDaysEnabled ALONE. With both OFF the tier stays null and wi is untouched.
    // Pass the parsed size so a >=3 gal fabric_bag resolves to 'fabric_ground' (vesselProfile is a pure parse, already required above).
    const _rainTier = (rainCreditEnabled || rainMaxDaysEnabled)
      ? rainTierFor(p.container_type, ledger.vesselProfile(p.container_type, p.container_size).sizeGal) : null;
    if(rainMaxDaysEnabled){ const _cap=rainMaxDays(_rainTier, p.status, c.crop, p); if(_cap!=null && wi>_cap) wi=_cap; }
    const dW=daysBetween(today,p.last_water);
    // Path B-plus: credit qualifying window rain against the cadence (per class), with a fresh-transplant carve-out. A credited planting drops OUT of
    // water_due (so counts.water_due is correct) and lands on rain_skipped with a one-line reason string.
    const rcls=rainClass(p);
    // Flag-independent heavy-soak cap (outer gate). The vessel size lets the TODAY branch hold small vessels to a higher bar.
    // satOpts.deferDryBeds arms the 'incoming_dry' branch for IN-GROUND plantings only: a bed presents its whole area to the sky, so a forecast
    // half-inch reaches it, while a bag's top catches too little of it (the widget's container exemption), so containers keep watering. A YOUNG bed
    // keeps its water too, via youngBed in _satApplies below, which covers every forecast kind and which no arming flag can switch off.
    const _bedDefer = !!satOpts.deferDryBeds && inGround;
    const _sat=saturationSuppressed(rcls, hydrology, { todayAware: todayAwareEnabled, smallVessel: isSmallVessel(p), deferDry: !!satOpts.deferDry || _bedDefer, soonAware: !!satOpts.soonAware });
    // Flag-ON only: exposure eligibility. Flag-OFF uses the location-derived class (rcls==='outdoor'); flag-ON derives exposure from the location,
    // honoring a stored rain_exposed boolean as an explicit override. _creditClass collapses to the flag-OFF value when OFF.
    // NOTE: CARE_RAIN_CREDIT_ENABLED is "true" in live prod config — this branch is LIVE, not dormant.
    //
    // Reads the handler's resolved flag, not `!p.covered` (which made an un-located planting exposed and rain-credited): unknown => not exposed => keeps
    // its water. The rain_exposed override still wins and is the escape hatch for "no location, but I know it is outdoors".
    const _exposed = rainCreditEnabled ? (p.rain_exposed==null ? !!p.rain_exposed_resolved : !!p.rain_exposed) : null;
    const _creditClass = rainCreditEnabled ? _exposed : (rcls==='outdoor');
    // Key the fresh-transplant carve-out on a REAL transplant/potting event (p.transplant_at), NOT substrate_start: substrate_start falls back to
    // created_at (DB row-creation date), so plantings entered into the app recently but established long ago were wrongly flagged "fresh" and denied
    // rain credit. transplant_at is NULL when no potting_up/transplant/plant-out event exists -> treated as established.
    const freshTransplant=((daysBetween(today,p.transplant_at)??999)<=TRANSPLANT_CARVEOUT_DAYS) && isSmallVessel(p);
    // Outdoor fabric bags dry fast in heat -> scale rain credit down on hot days (bagHeatDemoteCredit) so they still surface for watering sooner.
    // Outdoor-scoped (covered bags are never credited anyway, so no misleading note). The fresh-transplant carve-out is still a full denial: a small
    // root ball is the case where "some credit" is exactly the wrong answer.
    const bagHeatGate=hotForBag && rcls==='outdoor' && ((p.container_type||'').toLowerCase()==='fabric_bag');
    const _rcEarned=freshTransplant ? null
      : (rainCreditEnabled
          ? (_exposed ? rainCreditDaysTiered(_rainTier, wi, hydrology, measuredCreditEnabled) : null)
          : rainCreditDays(rcls, wi, hydrology, measuredCreditEnabled));
    const rc=bagHeatGate ? bagHeatDemoteCredit(_rcEarned) : _rcEarned;
    const bagHeatCut=!!(rc && rc.bag_heat_from > rc.credit_days);
    const effDays=(dW!=null&&rc)?dW-rc.credit_days:dW;
    // The forecast-based suppressions are SUBORDINATE to the fast-dry carve-outs; 'soak' and 'incoming' keep outranking them. A forecast busts;
    // measured water in the media does not. 'soak' and 'incoming' both require water already measured in the media, so overriding a heat gate is
    // defensible; letting a prediction outrank bagHeatGate would skip a 5-gal fabric bag at 92F, and outrank freshTransplant would skip a small root
    // ball, both costing plants when the rain no-shows.
    //
    // 'incoming_dry' and 'soon' join 'today' here rather than 'incoming', though 'incoming_dry' relaxes 'incoming': what made 'incoming' safe to leave
    // unsubordinated was its already-wet prerequisite, which is precisely the clause 'incoming_dry' drops.
    //
    // Three more plantings a busted forecast costs, exempt from every FORECAST kind and from nothing else:
    //  * youngBed — an in-ground planting within TRANSPLANT_CARVEOUT_DAYS of going into the bed (a transplant's root ball is still the size of its
    //    pot; a seedbed's top half inch dries inside one summer day, and a dry day during germination is stand loss). Aged from the transplant date,
    //    else from the sow date (p.sow_at): a planting started indoors and set out later is as old as its transplant. freshTransplant is small-vessel
    //    only, so it never covered a bed. An UNDECLARED vessel (container_type NULL) counts as sown in place too: likelyInGround guesses from the
    //    crop, so a carrot or lettuce row sown four days ago would otherwise be held. Unknown fails toward watering. A DECLARED vessel that is not a
    //    bed is unchanged.
    //  * newTransplant — a planting within TRANSPLANT_CARVEOUT_DAYS of its transplant or potting-up, in ANY vessel: the root ball is the size of the
    //    pot it left however big the one it went into. Transplant date only. Unlike freshTransplant it denies no MEASURED rain credit.
    //  * vesselHeatGate — at BAG_HEAT_GATE_F and above, every vessel that is not in the ground (rigid pot, basket, trough, barrel as well as fabric
    //    bag): none has soil below to draw on. It contains bagHeatGate, which stays fabric-only above because it also demotes MEASURED rain credit.
    //    No rcls test: _sat is null unless outdoor.
    const youngBed = (inGround || !p.container_type) && ((daysBetween(today, p.transplant_at ?? p.sow_at) ?? 999) <= TRANSPLANT_CARVEOUT_DAYS);
    const newTransplant = (daysBetween(today, p.transplant_at) ?? 999) <= TRANSPLANT_CARVEOUT_DAYS;
    const vesselHeatGate = hotForBag && !inGround;
    const _satApplies = _sat && (!FORECAST_SAT_KINDS.has(_sat.kind) || !(freshTransplant || youngBed || newTransplant || vesselHeatGate));
    // ── Water Ledger fork ──
    // Flag ON + watering history exists -> the continuous ledger replaces the dW>=wi chain below. dW==null deliberately FALLS THROUGH to the legacy
    // never:true push (never-watered path byte-identical). Rain day-credits, amount classes, snoozes and fractional time are all folded into D, so the
    // legacy 72h-credit rain_skipped branch has no in-flag analog: a rain-covered planting simply is not due. The saturation cap is RETAINED and still
    // SUPREME — unchanged _satApplies (incl. the 'today'-subordinate-to-carve-outs rule), with its eligibility gate now D >= dueThreshold instead of dW>=wi.
    const _lg = (_ledgerOn && dW!=null) ? ledgerVerdictFor(p, c, _wiBase, today, hydrology, ledgerOpts) : null;
    if(_lg){
      if(_lg.due && _satApplies){
        rainSkipped.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,
          days_since:dW,interval:_lg.wiEff,saturated:true,
          sat_kind:_sat.kind, sat_wp:_sat.wp,
          today_in:(hydrology&&hydrology.today_precip_in)??null, today_pop:(hydrology&&hydrology.today_pop)??null,
          reason: satReason(_sat),
          ledger:_lg.pub});
      } else if(_lg.due){
        // PAYLOAD CONTRACT: days_since/overdue_by/interval stay INTEGER CALENDAR values — the ledger's fractional precision rides ONLY in the additive
        // `ledger` key.
        water.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,
          days_since:dW,interval:_lg.wiEff,overdue_by:_lg.overdueBy,method:c.water_method,moisture:c.soil_moisture_target,
          never:false,rain_note:null,ledger:_lg.pub});
      }
      // not due -> no row: day-credits/snoozes/amounts already spoke through D
    }
    else if(dW!=null && dW>=wi && _satApplies){
      // The heavy-soak saturation cap OUTRANKS the tier decay + fast-dry discount + heat-gate.
      rainSkipped.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,
        days_since:dW,interval:wi,saturated:true,
        // Structured decision inputs alongside the prose: without them "did we skip on a forecast that busted?" is unanswerable after the fact.
        // Additive only; PLAN_SCHEMA_VERSION deliberately NOT bumped (the three readers pin the literal and deploy in one unordered matrix wave, so
        // a bump opens a mismatch window).
        sat_kind:_sat.kind, sat_wp:_sat.wp,
        today_in:(hydrology&&hydrology.today_precip_in)??null, today_pop:(hydrology&&hydrology.today_pop)??null,
        reason: satReason(_sat)});
    } else if(dW!=null && dW>=wi && rc && effDays<wi){
      rainSkipped.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,
        days_since:dW,interval:wi,credited_days:rc.credit_days,
        reason:bagHeatGate                                              // rc is non-null in this branch
          ? `Skip — ${rc.wp}" rain counts as watering (fabric bag dries fast at ${high}°F: ${rc.credit_days}d credit${bagHeatCut?`, cut from ${rc.bag_heat_from}d`:''})`
          : `Skip — ${rc.wp}" rain over the last few days counts as watering`});
    } else if(dW!=null && dW>=wi){
      // The DECISION that landed us in this branch is `rc == null`, and rc comes from creditPrecip(hydrology, measuredCreditEnabled). Quoting
      // windowPrecip here instead made the sentence and the verdict cite different numbers once the measured flag went live (a false `Water — 0.38"
      // rain under the 0.20" soak-in threshold`, where 0.38 was the mixed sum and the bar applied to the measured one). Same call, same args as the
      // credit itself; with measuredCreditEnabled=false creditPrecip IS windowPrecip, so the flag-OFF note is byte-identical.
      const wp=creditPrecip(hydrology, measuredCreditEnabled);
      // flag-OFF: _iaShown===RAIN_IA.outdoor and _creditClass===(rcls==='outdoor') -> note is byte-identical.
      const _iaShown = rainCreditEnabled ? (RAIN_TIER_IA[_rainTier] ?? RAIN_TIER_IA.unknown) : RAIN_IA.outdoor;
      // The bag branch reports the credit that SURVIVED the gate, and only fires when there was a credit at all: `bagHeatGate && rc==null` means the
      // rain never cleared the soak-in threshold, so it falls through to the threshold note, which names the real cause. The `cut from` clause is
      // conditional because the 2-class flag-OFF path has no room to demote: its base credit already IS bagHeatMinCreditDays.
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
    } // end watering guard (fert/pest/cold below run for suppressed plantings too)
    // OVERWINTER EXIT NOTICE. Bounded to EXIT_NOTICE_DAYS after the window closes and emitted only for the two regimes where Dave physically moves the
    // plant. Normal care has ALREADY resumed by then (the window closing IS the exit), so this is a reminder to move the pot, not a hold — and it goes
    // quiet by itself, because an unbounded reminder is the one-way trap in different clothing.
    if(_ow && _ow.exitDue){
      overwintering.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,
        regime:_ow.regime,interval:null,days_since:null,overdue_by:null,never:false,exit_due:true,
        harvestable:_ow.harvestable,window_until:_ow.until,moisture:null,note:_ow.guidance,
        reason:'Overwintering window has ended — move it back out and resume normal care, or extend the window'});
    }
    // Feeding is OFF for every overwintering regime. A quiescent root system cannot take up what is applied, so it stays in the medium as salt; a tunnel
    // crop coasting at 9 hours of daylight has no growth to feed. Uniform across the four regimes on purpose — one boolean, not a fifth per-regime knob
    // to get wrong. Pest and cold still run below: scale and spider mites are the classic indoor-overwintering losses, and a protected plant still needs
    // its cold card.
    // Feed suppression is LOUD, never silent: a plant nobody ever feeds should be distinguishable from one everybody forgot. REPORTING ONLY: the
    // suppression itself happens once, inside fertilizeRec, and this line does NOT also skip the call. That is deliberate anti-redundancy — two guards on
    // one decision means mutating either leaves the other holding and no test watches a guard fail. Here, breaking feedSuppression breaks the bucket AND
    // releases the card; breaking the guard inside fertilizeRec puts the planting in BOTH lists, which is visibly wrong.
    // Reported regardless of overwintering (which stops feeding for its own, temporary reason) because this is a POPULATION, like dormancy_suppressed:
    // every planting whose profile refuses calendar feeding, not just the ones that would have been carded today.
    const _fsup=feedSuppression(p,c);
    if(_fsup) feedSuppressed.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,rule:_fsup,
      reason:'Feeding suppressed — profile: NO calendar feeding; feed only on plant signals, never by interval'});
    const fr=(_ow && _ow.active) ? null : fertilizeRec(p,c,fm,today); if(fr) fertilize.push(fr);
    const pw=cad.pest_watch&&cad.pest_watch.cucurbit_beetle;
    if(pw&&pw.active){ const txt=((p.name||'')+' '+(p.variety||'')+' '+(c.crop||'')).toLowerCase();
      if((p.genus&&pw.genera.includes(p.genus))||pw.name_keywords.some(k=>txt.includes(k))) pest.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:likelyInGround(p,c),label:pw.label}); }
    const cd=coldFor(p,cad,low,frostAlertEnabled,frostCoverage); if(cd) cold.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,...cd});
  }
  const ovk=a=>a.never?-1:(a.overdue_by??-1);
  const due=water.filter(w=>!w.never).sort((a,b)=>ovk(b)-ovk(a));
  const noHistory=water.filter(w=>w.never);
  const feeding = (phaseCounts['establishment_0_2wk']||0)+(phaseCounts['mg_active_3_12wk']||0);
  const substrate={phase_counts:phaseCounts, feeding_now:feeding, fertilize_recs:fertilize.length,
    on_hold: fertilize.length===0,
    msg: fertilize.length===0
      ? `Feeding on HOLD — fresh MG slow-release mix is feeding all ${feeding} plantings (potted recently; mix feeds 3-6 months). Optional: kelp via sprayer for transplant establishment. Watch for Mg (Epsom) / blossom-end-rot (gypsum) symptoms.`
      : `${fertilize.length} planting(s) past the MG feed window — feed per recommendation.`,
    water_note: fm.water_quality && fm.water_quality.implications[0]};
  // dormancy_suppressed is ADDITIVE (new counts key + new tasks array); existing task arrays keep their shape, so PLAN_SCHEMA_VERSION is deliberately NOT
  // bumped (readers select named keys). A zero count is itself information: the suppression gate RAN and found nothing, distinguishing "no suppressed
  // plantings" from "gate missing".
  // `overwintering` (actionable rows: due soil checks + bounded exit notices) and `overwinter_held` (the POPULATION inside an open window) are additive
  // too. Two numbers because they answer different questions: a zero `overwintering` alongside a non-zero `overwinter_held` means "held out of summer
  // cadence, nothing due today", the normal winter state.
  //
  // overwintering and feed_suppressed SPREAD CONDITIONALLY, unlike dormancy_suppressed's unconditional zero: the keys are absent, not present-and-zero,
  // when nothing in the run overwinters or is suppressed, so today's plan payload is BYTE-IDENTICAL to the pre-change engine and tests/parity stays green
  // with no regenerated goldens. That matters more than "a zero proves the gate ran": a regenerated golden can hide a silent revert of the very feature it
  // locks, and inertness-until-used is a stronger, directly-testable property (overwinter-engine.test.js "is completely inert"; neverfeed.test.js "the
  // key set is inert"). The same conditional shape is used for hydrology.today_observed_in below.
  const _owOn = overwinterHeld>0 || overwintering.length>0;
  const _fsOn = feedSuppressed.length>0;
  return {counts:{plantings:plantings.length,water_due:due.length,no_history:noHistory.length,fertilize:fertilize.length,pest:pest.length,cold:cold.length,dormant:dormant.length,rain_skipped:rainSkipped.length,dormancy_suppressed:waterSuppressed.length,
      ...(_owOn?{overwintering:overwintering.length,overwinter_held:overwinterHeld,overwinter_deferred:overwinterDeferred}:{}),
      ...(_fsOn?{feed_suppressed:feedSuppressed.length}:{})},
    substrate, tasks:{water_due:due,no_history:noHistory,fertilize,pest,cold,dormant,rain_skipped:rainSkipped,dormancy_suppressed:waterSuppressed,
      ...(_owOn?{overwintering}:{}),
      ...(_fsOn?{feed_suppressed:feedSuppressed}:{})}};
}

// The rain callout's own gate. It tells Dave "let in-ground beds wait", so it must fire exactly when the engine lets DRY beds wait: the 'incoming_dry'
// bars (0.50"/60%, a null PoP fails closed, and no deferral at all when windowPrecip is unknown — saturationSuppressed bails there). The old gate was a
// private 0.30"/50% (null PoP allowed) with no derivation; it produced a forecast-driven false hold and told Dave to let beds wait while the list below it
// watered them. `bedsWait` false keeps the old gate byte-for-byte, so every caller that has not armed a dry deferral (and every parity golden) is unchanged.
function rainCalloutFires(hy, bedsWait){
  if(!hy) return false;
  if(!bedsWait) return hy.tomorrow_precip_in>=0.3 && (hy.tomorrow_pop==null || hy.tomorrow_pop>=50);
  return windowPrecip(hy)!=null
    && hy.tomorrow_precip_in!=null && hy.tomorrow_precip_in>=SOAK_FCST_QPF_IN
    && hy.tomorrow_pop!=null && hy.tomorrow_pop>=SOAK_FCST_POP_PCT;
}

// Which words a cold-side callout takes, from the PLAN DATE's month and day ('YYYY-MM-DD', the garden's local date the plan is for; read as text, so no
// clock or time zone enters). The same 47°F means opposite things in May (young transplants are out) and September (the season is ending): 'spring' is
// May 1..Aug 14, 'fall' is Aug 15..Oct 31, and null is Nov 1..Apr 30 or no usable date. COPIED in src/lib/tonightLow.js cueSeason (the bundle cannot
// import this module); its PARITY sweep in src/__tests__/tonightLow.test.js holds the two together on every boundary day.
function calloutSeason(planDate){
  const m = typeof planDate==='string' ? /^\d{4}-(\d{2})-(\d{2})/.exec(planDate) : null;
  if(!m) return null;
  const mo=Number(m[1]), d=Number(m[2]);
  if(mo<1 || mo>12 || d<1 || d>31) return null;
  const md=mo*100+d;
  if(md>=501 && md<=814) return 'spring';
  if(md>=815 && md<=1031) return 'fall';
  return null;
}

// Compute the single weather callout (action only) from temp + hydrology. Priority order; null = no callout (no filler).
// planDate picks the season words (calloutSeason). Without one the cold line keeps its all-year words and the 45-50°F `cool` line stays silent.
// `cool` is a sixth icon: src/lib/weatherCue.js CUE_FORM and lambda/daily-plan-read/cue-impression.js CUES must name it, or Today renders nothing on such
// a night.
function computeCallout(weather, hy, bedsWait=false, planDate=null){
  const low=weather&&weather.tonightLow, high=weather&&weather.highToday;
  const season=calloutSeason(planDate);
  if(low!=null && low<40) return {icon:'freeze', text:`Freeze tonight (${low}°F) — cover or bring peppers & tomatoes in`};
  if(low!=null && low<45) return {icon:'cold', text: season==='fall'
    ? `Cold night (${low}°F) — pick coloring peppers & tomatoes`
    : `Cold night (${low}°F) — protect flowering peppers/tomatoes`};
  if(low!=null && low<50 && season) return {icon:'cool', text: season==='fall'
    ? `Cool night (${low}°F) — pick coloring peppers & tomatoes`
    : `Cool night (${low}°F) — cover young peppers, basil & cukes`};
  if(high!=null && high>=88) return {icon:'heat', text:`Hot day (${high}°F) — deep-water thirsty crops, shade if wilting`};
  if(rainCalloutFires(hy, bedsWait)){
    // Mirrors the Today widget, which prints the amount and the chance side by side instead of their product. The GATE is unchanged — whether this fires
    // is a watering decision. A null PoP prints the amount alone. The text before ' — ' is what weatherCue.buildCueLine keeps, so the chance travels with
    // it. Two decimals, as the card prints it, so the two lines stacked on Today show the same figure.
    const _pop = hy.tomorrow_pop!=null ? ` (${hy.tomorrow_pop}% chance)` : '';
    return {icon:'rain', text:`${hy.tomorrow_precip_in.toFixed(2)}" rain tomorrow${_pop} — water containers today, let in-ground beds wait`};
  }
  if(hy && hy.recent_precip_in>=0.4)
    return {icon:'wet', text:`${hy.recent_precip_in}" fell recently — soil is wet, skip outdoor watering`};
  return null;
}
// Full-picture gate + uncertainty. In showery/convective regimes the amount can move several-fold within hours, so a PoP-only band missed the common
// high-PoP cases (e.g. 88% PoP with a trace or modest amount). Flag the figures as volatile whenever rain is reasonably likely today or tomorrow, or
// when data is missing. The copy says "latest" rather than naming a generation time: the plan regenerates hourly, so the figures are at most ~an hour
// old, yet a showery regime shifts whatever time you read it.
// METADATA ONLY — no watering recommendation reads this flag (presentation honesty for the Today widget).
const SHOWERY_POP = 50;
// "assumes no rain credit" is true only while recent_precip_in is null (windowPrecip/creditPrecip return null, so nothing is credited). With a bound gauge
// and no forecast, recent is the gauge's and still credits, so that case says so instead.
function hydrologyStatus(hy){
  if(!hy || hy.recent_precip_in==null || hy.upcoming_precip_in==null)
    return {ok:false, uncertainty:{flag:true, reason: (hy && hy.recent_precip_in!=null)
      ? 'precip data incomplete — watering advice still credits recent rain'
      : 'precip data incomplete — watering advice assumes no rain credit'}};
  // The tomorrow half reads the DISPLACED best_match pair when the five-model forecast replaced it (rainForecast.applyRainForecast keeps it as
  // bm_tomorrow_*). SHOWERY_POP 50 was set against best_match's max-hourly PoP; the five-model share clears 50 on ~45% of summer days against ~11%, which
  // would put the gold banner on Today every other day — the "wallpaper" failure WeatherCueLine.jsx names. The banner is metadata that no watering
  // decision reads, so it keeps its calibrated trigger until someone re-derives one for the new quantity.
  const tPop=hy.today_pop, mPop=('bm_tomorrow_pop' in hy) ? hy.bm_tomorrow_pop : hy.tomorrow_pop;
  const tIn=hy.today_precip_in??0, mIn=(('bm_tomorrow_precip_in' in hy) ? hy.bm_tomorrow_precip_in : hy.tomorrow_precip_in)??0;
  let reason=null;
  if(tPop!=null && tPop>=SHOWERY_POP)
    reason = tIn<0.1
      ? `rain likely today (${tPop}%) but little in the latest forecast — the amount may climb`
      : `showery today (${tPop}% on ${tIn}") — showery amounts shift through the day`;
  else if(mPop!=null && mPop>=SHOWERY_POP)
    reason = mIn<0.1
      ? `rain likely tomorrow (${mPop}%) but little in the latest forecast — the amount may climb`
      : `showery tomorrow (${mPop}% on ${mIn}") — the amount can still shift`;
  else if((tPop!=null && tPop>=40 && tIn>=0.1) || (mPop!=null && mPop>=40 && mIn>=0.1))
    reason = `rain amounts uncertain — latest estimate (today ${tPop==null?'?':tPop}% / tomorrow ${mPop==null?'?':mPop}%)`;
  return {ok:true, uncertainty: reason ? {flag:true, reason} : {flag:false}};
}

// waterLedgerEnabled/weatherDaily/eventsByPlant/nowMs are the fold inputs the handler threads through. All default to inert — an un-updated caller is
// byte-identical, and enabled-without-events stays legacy (the handler passes enabled=false when the event-window read fails).
// frostCoverage is frostEval.frostCoverage over the handler's frost decision for this Space (a Map keyed by planting id, shared by every user in the
// Space); see coldFor. Default null keeps every in-ground card, so a caller that supplies the flag but no coverage gets cards, not silence.
function generatePlan({plantings, cadence, fertModel, today, weather, hydrology, ownerFallback, rainCreditEnabled=false, rainMaxDaysEnabled=false, todayAwareEnabled=false, waterLedgerEnabled=false, weatherDaily=null, eventsByPlant=null, nowMs=null, measuredCreditEnabled=false, droughtState=null, deferDryEnabled=false, soonAwareEnabled=false, frostAlertEnabled=false, frostCoverage=null, deferDryBedsEnabled=false}){
  const ledgerOpts = (waterLedgerEnabled && eventsByPlant)
    ? ledger.buildLedgerOpts({ weatherDaily, eventsByPlant, today, nowMs })
    : null;
  const byUser=new Map();
  for(const p of plantings){ const c=resolveCadence(p,cadence); const u=ownerFor(p,c,ownerFallback)||'__UNASSIGNED__'; if(!byUser.has(u))byUser.set(u,[]); byUser.get(u).push(p); }
  const hy=hydrology||null; const callout=computeCallout(weather,hy,deferDryEnabled||deferDryBedsEnabled,today); const hs=hydrologyStatus(hy);
  // `rain_coming` must see rain arriving TODAY, not tomorrow only. This flag reaches NO engine gate (it is consumed client-side), so it is an honesty fix;
  // the fix that moves water_due is the 'today' branch in saturationSuppressed. `rain_horizon` is additive because the two horizons imply OPPOSITE advice:
  // rain tomorrow means water containers today and let beds wait; rain today means beds can wait and containers may catch little or none.
  const _tomorrowComing = !!(hy && hy.tomorrow_precip_in>=0.3 && (hy.tomorrow_pop==null||hy.tomorrow_pop>=50));
  const _todayComing = todayQualifies(hy);
  const rainComing = _todayComing || _tomorrowComing;
  const rainHorizon = _todayComing ? 'today' : (_tomorrowComing ? 'tomorrow' : null);
  const users={};
  for(const [u,rows] of byUser){ const up=generatePlanForUser(rows,cadence,fertModel,today,weather,hy,rainCreditEnabled,rainMaxDaysEnabled,todayAwareEnabled,ledgerOpts,measuredCreditEnabled,droughtState,{deferDry:deferDryEnabled,deferDryBeds:deferDryBedsEnabled,soonAware:soonAwareEnabled},frostAlertEnabled,frostCoverage);
    users[u]=up; }
  const lwOut=(hy && Array.isArray(hy.wetness_window)) ? lw.assessLeafWetness(hy.wetness_window, today) : null;
  return {date:today,
    weather: weather? {tonightLow:weather.tonightLow, highToday:weather.highToday, code:weather.code, short:weather.short, unit:weather.unit||'F', callout} : null,
    // today_observed_in / today_remaining_in ride along for observability: they make "was that 1.4" measured or predicted?" answerable from a stored row.
    // Spread CONDITIONALLY so a run with no bound station emits a byte-identical payload (the keys are absent, not null).
    hydrology: hy ? {recent_precip_in:hy.recent_precip_in, today_precip_in:hy.today_precip_in, today_pop:hy.today_pop, upcoming_precip_in:hy.upcoming_precip_in, tomorrow_precip_in:hy.tomorrow_precip_in, tomorrow_pop:hy.tomorrow_pop,
      ...(hy.today_observed_in!=null?{today_observed_in:hy.today_observed_in}:{}), ...(hy.today_remaining_in!=null?{today_remaining_in:hy.today_remaining_in}:{}),
      // D2 for Today's following-day line, the fallback when the card's live overlay is absent. Display only. Spread on the key's PRESENCE, so a hydrology
      // without it — every parity fixture — emits a byte-identical payload.
      ...('day2_precip_in' in hy ? {day2_precip_in:hy.day2_precip_in, day2_pop:hy.day2_pop??null, day2_date:hy.day2_date??null} : {}),
      // Which method made the day-ahead figures, and the best_match pair it displaced (the shadow series for re-scoring). Present only when the five-model
      // forecast ran.
      ...(hy.forecast_source!=null ? {forecast_source:hy.forecast_source, bm_tomorrow_precip_in:hy.bm_tomorrow_precip_in??null, bm_tomorrow_pop:hy.bm_tomorrow_pop??null} : {}),
      // The second model's (Open-Meteo best_match) D1..D3 lows and their ET dates, verbatim as fetchPrecip fetched them THIS run and the advisory tier read
      // them (handler.frostForSpace). An advisory entry in alerts_sent is a send-time snapshot that no later run refreshes, so without this Today cannot tell
      // "the second model still says 38" from "it now says 45" (src/lib/frostAlertLine.js retires the stale one). Only while the frost alert is on
      // (alerts_sent, the only consumer, exists only then) and only when the fetch supplied them: a flag-off row and every parity fixture stay byte-identical.
      ...(frostAlertEnabled && Array.isArray(hy.forecast_lows) ? {forecast_lows:hy.forecast_lows, forecast_dates:Array.isArray(hy.forecast_dates)?hy.forecast_dates:null} : {}),
      rain_coming:rainComing, rain_horizon:rainHorizon, status:hs} : {status:hs},
    // SPREAD CONDITIONALLY, not an always-present null: a new always-present key changes EVERY stored payload and reddens every committed parity golden
    // (the G-PARITY gate caught the first cut). Same house pattern as `today_observed_in` above. The cost: an ABSENT key cannot distinguish "no wet days"
    // from "the cue was deleted"; that detectability is bought back in the suite (the Today mount case reddens if the element goes, and the engine case
    // reddens if the key stops appearing when a qualifying window IS supplied). PLAN_SCHEMA_VERSION stays unbumped: readers select named keys, and a bump
    // nulls the plan in three reader Lambdas with no regeneration path.
    ...(lwOut ? { leaf_wetness: lwOut } : {}),
    hot:(weather&&weather.highToday>=HOT_F)||false, water_source:(fertModel.water_quality||{}).source||null, users};
}
module.exports={generatePlan, calloutSeason, PLAN_SCHEMA_VERSION, saturationSuppressed, todayQualifies, satReason, FORECAST_SAT_KINDS, SOON_QPF_IN, SOAK_CAP_IN, SOAK_TODAY_SMALL_IN, BAG_HEAT_GATE_F, generatePlanForUser, resolveCadence, coldFor, fertilizeRec, feedPhase, daysBetween, HOT_F, rainClass, rainCreditDays, windowPrecip, RAIN_IA, TRANSPLANT_CARVEOUT_DAYS, hydrologyStatus, computeCallout, isSmallVessel, vesselSizeSmall, waterSuppression, feedSuppression, isMedHerb,
  RAIN_TIER_IA, RAIN_TIER_HOLD, RAIN_VESSEL_TIER, rainTierFor, rainDepthTierFor, RAIN_DEPTH_TIER_OVERRIDE,
  FABRIC_GROUND_MIN_GAL, RAIN_MAX_DAYS, rainStageFor, rainMaxDays, rainCreditDaysTiered, bagHeatDemoteCredit,
  dailyFloorFor, DAILY_FLOOR_DAYS, RESERVOIR_VESSEL_TYPES, RIGID_POT_TYPES, baseWaterInterval,
  overwinter: ow, drought: dr, leafWetness: lw};
