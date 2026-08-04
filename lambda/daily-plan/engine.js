'use strict';
// Daily Plan Engine v3 — pure generator (DRG-TODAY-001). Adds SUBSTRATE-AWARE fertilization:
// holds feeding while the MG 3-6mo slow-release mix is active, then recommends a specific IN-INVENTORY
// amendment by crop+stage, sprayer-default for liquids, hard-well-water aware. Per-variety cadence,
// never-logged-aware, temp-aware, per-variety cold, strict per-user. No I/O; caller passes today/weather/cadence/fertModel.
const DAY = 86400000;
const HOT_F = 88;
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
  // CARE-CADENCE-001: prefer the DB-resolved per-cultivar/leaf profile (v_resolved_care) when seeded;
  // falls back to the bundled cadence-data-v2.json for any planting whose variety has no care_profile row.
  if(p && p.db_cadence && p.db_cadence._seeded) return {...p.db_cadence, _via:'db'};
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
function rainClass(p){ return p.covered ? 'none' : 'outdoor'; }    // covered/indoor => 'none'; everything else => 'outdoor'
function windowPrecip(hy){
  if(!hy || hy.recent_precip_in==null) return null;                 // missing precip -> no credit (uncertainty handled in hydrologyStatus)
  // BUG-TODAYWATER-001: this is D-2..D-1 ACTUALS + D0 FORECAST, not "D-2..D0 actuals" as this comment used
  // to claim. today_precip_in is Open-Meteo precipitation_sum[2] read at ~02:01 for a day that has not
  // started (index.js). So SOAK_CAP_IN has ALWAYS acted partly on a prediction — worth knowing before
  // reasoning about any gate that consumes this.
  return (hy.recent_precip_in||0) + (hy.today_precip_in||0);
}
// Returns { credit_days, wp, eff } when rain qualifies for credit, else null.
function rainCreditDays(cls, wi, hy){
  if(cls!=='outdoor') return null;                                  // covered/indoor never credited
  const wp = windowPrecip(hy); if(wp==null) return null;
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
const RAIN_TIER_IA   = { in_ground: 0.20, intermediate: 0.25, small_fast: 0.35 }; // inches (initial abstraction per tier)
const RAIN_TIER_HOLD = { in_ground: 3,    intermediate: 2,    small_fast: 1    }; // max credit days per tier; never raise small_fast
// Vessel -> tier. NULL/unknown/'other' fails safe to small_fast (least credit -> water it). Covers the full DB
// container_type CHECK vocab (14 values, verified prod 2026-07-08) + the generic 'pot' used in fixtures. Rigid pots
// (plastic/terracotta/ceramic/'pot') are small_fast: generic unknown-size pots dry fast; large rigid pots re-tag to trough.
const RAIN_VESSEL_TIER = {
  in_ground: 'in_ground',
  raised_bed: 'intermediate', trough: 'intermediate', whiskey_barrel: 'intermediate', window_box: 'intermediate',
  hanging_basket: 'small_fast', fabric_bag: 'small_fast', tray_cell: 'small_fast', soil_block: 'small_fast',
  solo_cup: 'small_fast', plastic_pot: 'small_fast', terracotta: 'small_fast', ceramic: 'small_fast',
  pot: 'small_fast', other: 'small_fast',
};
function rainTierFor(container_type){ return RAIN_VESSEL_TIER[(container_type||'').toLowerCase()] || 'small_fast'; }
// Max-days ceiling: clamps the watering interval before the due-check so a rain-credited planting still re-surfaces
// for a moisture check (anti suppression-inversion). tier x stage; +1 for drought-tolerant Mediterranean herbs,
// -1 for steady-moisture leafy/Solanaceae at flowering/fruiting (bolt / split / blossom-end-rot on swings), floor 1.
const RAIN_MAX_DAYS = {
  small_fast:   { seedling: 1, vegetative: 2, flowering: 2, fruiting: 1, mature: 2 },
  intermediate: { seedling: 2, vegetative: 3, flowering: 3, fruiting: 2, mature: 4 },
  in_ground:    { seedling: 2, vegetative: 4, flowering: 3, fruiting: 3, mature: 5 },
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
function rainCreditDaysTiered(tier, wi, hy){
  const ia = RAIN_TIER_IA[tier] ?? RAIN_TIER_IA.small_fast;
  const hold = RAIN_TIER_HOLD[tier] ?? RAIN_TIER_HOLD.small_fast;
  const wp = windowPrecip(hy); if(wp==null) return null;
  const eff = wp - ia;
  if(eff<=0) return null;
  return { credit_days: Math.min(hold, wi), wp: Math.round(wp*100)/100, eff: Math.round(eff*100)/100, tier }; }

// ── DRG-WXSATCAP-001 heavy-soak saturation cap (FLAG-INDEPENDENT; Dave-approved constants 2026-07-30) ──
// Over-watering already-saturated media (esp. fabric bags with no drying window) drives anoxia / root rot =
// NON-recoverable, so in the heavy-soak regime the safe error inverts to "skip". Applies to ALL outdoor vessels
// UNIFORMLY: rain depth saturates media regardless of vessel, and container_type is ~unpopulated so a
// vessel-agnostic gate is the only design robust to the dominant NULL case (NULL is outdoor -> suppressed ->
// fails safe). covered/indoor never got the rain -> exempt. Independent of CARE_RAIN_CREDIT_ENABLED so the
// eventual credit-ON flip cannot bypass it. Recovery is automatic as the 72h windowPrecip decays (no counter).
const SOAK_CAP_IN = 1.0;         // >= this over the 72h windowPrecip -> suppress outdoor watering
const SOAK_WET_FLOOR_IN = 0.5;   // "already moist" prerequisite for the incoming-rain trigger
const SOAK_FCST_QPF_IN = 0.5;    // incoming 24h amount that counts
const SOAK_FCST_POP_PCT = 60;    // min PoP for an incoming-rain skip
// BUG-TODAYWATER-001: a small vessel needs MUCH more gross rainfall than a bed before a skip is safe. A
// 5-gal fabric bag is a ~113 sq-in footprint and a mature canopy sheds water AWAY from it, so a 1" event
// delivers under half of one hand-watering — while the plant transpires 1.5-3 L/day. The cost asymmetry is
// roughly 50:1 against the bed case: a false skip on a bag aborts pepper/tomato flowers within 24h above
// 85F and locks in blossom-end-rot in fruit that ripen 2-3 weeks later (Ca is transpiration-delivered, so
// the damage is invisible when it is caused and irreversible when it shows). A false WATER on a bag costs
// nothing — it is free-draining by construction. Hence a deliberately high bar.
const SOAK_TODAY_SMALL_IN = 2.0; // today-forecast bar for small vessels (bags/pots/cells)
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
function todayQualifies(hy){
  if(!hy) return false;
  const q = hy.today_precip_in, pop = hy.today_pop;
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
  const soakBasis = todayAware ? (hy.recent_precip_in || 0) : wp;
  if(soakBasis >= SOAK_CAP_IN) return { wp: Math.round(soakBasis*100)/100, kind: 'soak' };
  const fq = hy && hy.tomorrow_precip_in, pop = hy && hy.tomorrow_pop;
  if(wp >= SOAK_WET_FLOOR_IN && fq!=null && fq >= SOAK_FCST_QPF_IN && (pop==null || pop >= SOAK_FCST_POP_PCT))
    return { wp: wpR, fq, pop, kind: 'incoming' };
  // TODAY. Ordered LAST so it can never pre-empt the two branches that act on water already in the media —
  // and evaluated against the raw forecast, NOT windowPrecip, so today is never counted twice (windowPrecip
  // already contains today_precip_in; using it here would let one 0.6" event satisfy both a "0.5 already
  // wet" floor and a "0.5 more coming" bar, silently halving SOAK_CAP_IN).
  if(todayAware && todayQualifies(hy)){
    const bar = (opts.smallVessel ? SOAK_TODAY_SMALL_IN : SOAK_FCST_QPF_IN);
    if(hy.today_precip_in >= bar)
      return { wp: wpR, fq: hy.today_precip_in, pop: hy.today_pop, kind: 'today' };
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
  const due = (dF!=null && c.fertilize_interval_days!=null && dF>=c.fertilize_interval_days);
  const heavy=isHeavyFeeder(c.crop);
  if(!(due || (heavy && ['flowering','fruiting'].includes(p.status)) || (phase==='needs_feed_24wk_plus'))) return null;
  if(isMedHerb(c.crop)) return null;            // Mediterranean herbs: never force-feed
  // pick amendment by crop/stage
  let rec;
  if(isAcidLover(c.crop)) rec={item:'acidic fertilizer (Holly-Tone — NOT in inventory; acquire)', apply:'top-dress; use rainwater', note:'acid-lover; hard well water raises pH'};
  else if(heavy || ['flowering','fruiting'].includes(p.status)) rec={item:am.fruiting_feed.item, apply:am.fruiting_feed.apply, alt:am.kelp.item+' (sprayer)'};
  else if(isLeafy(c.crop)) rec={item:am.veg_feed.item, apply:am.veg_feed.apply};
  else rec={item:am.castings.item, apply:am.castings.apply};
  return {id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:isHeavyFeeder(c.crop)&&false,status:p.status,weeks_since_pot:wk,phase,...rec};
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
  const pb=c.cold && c.cold.tender ? c.cold.protect_below_F : null;
  if(pb!=null && low<=pb) return {level:'protect', text:`tender tropical — bring in tonight (low ${low}°F ≤ ${pb}°F)`};
  return null;
}

// ── DRG-NOCALWATER-001 — dormancy/growth-cycle watering suppression ──
// Some care profiles (Lithops-class succulents) mark watering as NOT calendar-drivable: no_calendar_water:true
// and/or water_rule:'growth_gated'. Until this gate existed NOTHING read those signals, and the nightly plan
// issued interval watering for a summer-dormant Lithops (watering during dormancy rots it — the plant died).
// Sources checked IN ORDER: the resolved cadence `c` AND the raw DB profile p.db_cadence. The raw read is
// load-bearing, not belt-and-braces: resolveCadence only adopts db_cadence when `_seeded` is present, and the
// LIVE Lithops cultivar profile carries the signals WITHOUT `_seeded` — a c-only check would drop the signal
// through the exact fallback path that caused the original loss. no_calendar_water (explicit, stronger) wins
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

// DRG-WXFLAGSPLIT-001 F1: rainMaxDaysEnabled gates the max-days CEILING independently of rainCreditEnabled
// (which gates the tiered credit). Trailing param, default false -> every existing caller keeps flag-OFF
// behaviour and the plan stays byte-identical until an env flip.
function generatePlanForUser(plantings, cad, fm, today, weather, hydrology, rainCreditEnabled=false, rainMaxDaysEnabled=false, todayAwareEnabled=false){
  const water=[], fertilize=[], pest=[], cold=[], dormant=[], rainSkipped=[], waterSuppressed=[];
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
    if(p.status==='dormant' || c.dormant_skip){ dormant.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,note:c.dormant_skip?c.notes:'Dormant — skip routine care'}); continue; }
    // DRG-NOCALWATER-001: profile-declared calendar-watering suppression. Evaluated BEFORE any watering
    // computation and BEFORE any flag fork, so it binds identically with todayAware/rainCredit/rainMaxDays
    // on or off. Suppressed plantings get NO water_due/no_history/rain_skipped item — they land LOUDLY on
    // tasks.dormancy_suppressed (+ counts.dormancy_suppressed) with the rule + guidance, and still flow
    // through fert/pest/cold below (the signal governs watering only).
    const _wsup=waterSuppression(p,c);
    if(_wsup){
      waterSuppressed.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,rule:_wsup,
        moisture:(p.db_cadence&&p.db_cadence.soil_moisture_target)||c.soil_moisture_target||null,
        reason:_wsup==='no_calendar_water'
          ? 'Watering suppressed — profile: NO calendar watering; water only on plant signals, never by interval'
          : 'Watering suppressed — profile: growth-gated; water only during active growth, never by interval'});
    } else {
    // CARE-PROFILES-001: select inground or container cadence based on container_type.
    const inGround=likelyInGround(p,c);
    let wi=(inGround ? c.water_interval_days_inground : c.water_interval_days_container)
          ?? c.water_interval_days_container
          ?? cad.default.water_interval_days_container;
    if(hot && c.drought_tolerance==='low' && wi>1) wi=wi-1;
    // DRG-WXWATER-001 coarse-v1 (flag-ON only): clamp the interval to the substrate x stage ceiling so a
    // rain-credited planting still re-surfaces for a moisture check. Flag-OFF leaves wi exactly as computed above.
    // DRG-WXFLAGSPLIT-001 F1: the tier is needed by EITHER flag (credit uses it for IA/hold, the ceiling for the
    // clamp), so derive it when either is on; the clamp itself is now gated on rainMaxDaysEnabled ALONE. With both
    // OFF the tier stays null and wi is untouched -> byte-identical to pre-split.
    const _rainTier = (rainCreditEnabled || rainMaxDaysEnabled) ? rainTierFor(p.container_type) : null;
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
    // (rcls==='outdoor'); flag-ON derives exposed = !covered when rain_exposed is unset, honoring a stored
    // rain_exposed boolean as an explicit override. _creditClass/_iaShown collapse to the flag-OFF values when OFF.
    const _exposed = rainCreditEnabled ? (p.rain_exposed==null ? !p.covered : !!p.rain_exposed) : null;
    const _creditClass = rainCreditEnabled ? _exposed : (rcls==='outdoor');
    // DRG-WATERCREDIT-002 fix: key the fresh-transplant carve-out on a REAL transplant/potting event
    // (p.transplant_at), NOT substrate_start. substrate_start falls back to created_at (DB row-creation
    // date), so plantings entered into the app recently but established in the ground/pots long ago were
    // wrongly flagged "fresh" and denied rain credit (98/167 on 2026-06-23). transplant_at is NULL when no
    // potting_up/transplant/plant-out event exists -> treated as established -> rain credit applies.
    const freshTransplant=((daysBetween(today,p.transplant_at)??999)<=TRANSPLANT_CARVEOUT_DAYS) && isSmallVessel(p);
    // DRG-WATERCREDIT-004: outdoor fabric bags dry fast in heat -> withhold rain credit on hot days so they
    // still surface for watering. Outdoor-scoped (covered bags are never credited anyway, so no misleading note).
    const bagHeatGate=hotForBag && rcls==='outdoor' && ((p.container_type||'').toLowerCase()==='fabric_bag');
    const rc=(freshTransplant||bagHeatGate) ? null
      : (rainCreditEnabled
          ? (_exposed ? rainCreditDaysTiered(_rainTier, wi, hydrology) : null)
          : rainCreditDays(rcls, wi, hydrology));
    const effDays=(dW!=null&&rc)?dW-rc.credit_days:dW;
    // BUG-TODAYWATER-001 — the TODAY branch is SUBORDINATE to the fast-dry carve-outs; 'soak' and 'incoming'
    // keep outranking them. The distinction is what the gate is acting on: 'soak' means water is measurably
    // already IN the media, so overriding a heat gate is defensible. 'today' means water is merely PREDICTED,
    // and a forecast busts. Letting a prediction outrank bagHeatGate would skip a 5-gal fabric bag at 92F,
    // and outrank freshTransplant would skip a small root ball — both cost plants when the rain no-shows,
    // and both are exactly the cases those carve-outs were written to protect.
    const _satApplies = _sat && (_sat.kind !== 'today' || !(freshTransplant || bagHeatGate));
    if(dW!=null && dW>=wi && _satApplies){
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
        reason:`Skip — ${rc.wp}" rain over the last few days counts as watering`});
    } else if(dW!=null && dW>=wi){
      const wp=windowPrecip(hydrology);
      // flag-OFF: _iaShown===RAIN_IA.outdoor and _creditClass===(rcls==='outdoor') -> note is byte-identical.
      const _iaShown = rainCreditEnabled ? (RAIN_TIER_IA[_rainTier] ?? RAIN_TIER_IA.small_fast) : RAIN_IA.outdoor;
      const rain_note=freshTransplant
        ? 'Water — fresh transplant (no rain credit; small root ball dries fast)'
        : bagHeatGate
        ? `Water — fabric bag dries fast at ${high}°F (rain credit withheld on hot days)`
        : (_creditClass && rc==null && wp!=null && wp>0
            ? `Water — ${Math.round(wp*100)/100}" rain under the ${_iaShown}" soak-in threshold`
            : (rc ? `Water — ${rc.wp}" rain didn't cover the gap (last watered ${dW}d ago)` : null));
      water.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,days_since:dW,interval:wi,overdue_by:dW-wi,method:c.water_method,moisture:c.soil_moisture_target,never:false,rain_note});
    }
    else if(dW==null) water.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:inGround,days_since:null,interval:wi,overdue_by:null,method:c.water_method,moisture:c.soil_moisture_target,never:true});
    } // end DRG-NOCALWATER-001 watering guard (fert/pest/cold below run for suppressed plantings too)
    const fr=fertilizeRec(p,c,fm,today); if(fr) fertilize.push(fr);
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
  return {counts:{plantings:plantings.length,water_due:due.length,no_history:noHistory.length,fertilize:fertilize.length,pest:pest.length,cold:cold.length,dormant:dormant.length,rain_skipped:rainSkipped.length,dormancy_suppressed:waterSuppressed.length},
    substrate, tasks:{water_due:due,no_history:noHistory,fertilize,pest,cold,dormant,rain_skipped:rainSkipped,dormancy_suppressed:waterSuppressed}};
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

function generatePlan({plantings, cadence, fertModel, today, weather, hydrology, ownerFallback, rainCreditEnabled=false, rainMaxDaysEnabled=false, todayAwareEnabled=false}){
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
  for(const [u,rows] of byUser){ const up=generatePlanForUser(rows,cadence,fertModel,today,weather,hy,rainCreditEnabled,rainMaxDaysEnabled,todayAwareEnabled);
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
module.exports={generatePlan, PLAN_SCHEMA_VERSION, saturationSuppressed, todayQualifies, SOAK_TODAY_SMALL_IN, BAG_HEAT_GATE_F, generatePlanForUser, resolveCadence, coldFor, fertilizeRec, feedPhase, daysBetween, HOT_F, rainClass, rainCreditDays, windowPrecip, RAIN_IA, TRANSPLANT_CARVEOUT_DAYS, hydrologyStatus, computeCallout, isSmallVessel, vesselSizeSmall, waterSuppression,
  RAIN_TIER_IA, RAIN_TIER_HOLD, RAIN_VESSEL_TIER, rainTierFor, RAIN_MAX_DAYS, rainStageFor, rainMaxDays, rainCreditDaysTiered};
