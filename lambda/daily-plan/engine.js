'use strict';
// Daily Plan Engine v3 — pure generator (DRG-TODAY-001). Adds SUBSTRATE-AWARE fertilization:
// holds feeding while the MG 3-6mo slow-release mix is active, then recommends a specific IN-INVENTORY
// amendment by crop+stage, sprayer-default for liquids, hard-well-water aware. Per-variety cadence,
// never-logged-aware, temp-aware, per-variety cold, strict per-user. No I/O; caller passes today/weather/cadence/fertModel.
const DAY = 86400000;
const HOT_F = 88;
const PEPPER_TOMATO = /pepper|tomato|eggplant|tomatillo|chile|chili|capsicum|solanum/i;

function daysBetween(today, iso){ if(!iso) return null;
  const d0=new Date(iso.slice(0,10)+'T00:00:00Z').getTime(), t0=new Date(today.slice(0,10)+'T00:00:00Z').getTime();
  return Math.floor((t0-d0)/DAY); }
function weeksSince(today, iso){ const d=daysBetween(today,iso); return d==null?null:Math.floor(d/7); }

function resolveCadence(p, cad){
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
function likelyInGround(p,c){ return isCucurbit(p,c&&c.crop)||isLeek(p,c&&c.crop); }

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

function generatePlanForUser(plantings, cad, fm, today, weather){
  const water=[], fertilize=[], pest=[], cold=[], dormant=[];
  const phaseCounts={};
  const low=weather?weather.tonightLow:null, high=weather?weather.highToday:null, hot=high!=null&&high>=HOT_F;
  for(const p of plantings){
    const c=resolveCadence(p, cad);
    if(c.exclude) continue;
    const ph=feedPhase(weeksSince(today,p.substrate_start)); phaseCounts[ph]=(phaseCounts[ph]||0)+1;
    if(c.dormant_skip){ dormant.push({id:p.id,name:p.name,crop:c.crop,note:c.notes}); continue; }
    let wi=c.water_interval_days_container ?? cad.default.water_interval_days_container;
    if(hot && c.drought_tolerance==='low' && wi>1) wi=wi-1;
    const dW=daysBetween(today,p.last_water);
    if(dW!=null && dW>=wi) water.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:likelyInGround(p,c),days_since:dW,interval:wi,overdue_by:dW-wi,method:c.water_method,moisture:c.soil_moisture_target,never:false});
    else if(dW==null) water.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:likelyInGround(p,c),days_since:null,interval:wi,overdue_by:null,method:c.water_method,moisture:c.soil_moisture_target,never:true});
    const fr=fertilizeRec(p,c,fm,today); if(fr) fertilize.push(fr);
    const pw=cad.pest_watch&&cad.pest_watch.cucurbit_beetle;
    if(pw&&pw.active){ const txt=((p.name||'')+' '+(p.variety||'')+' '+(c.crop||'')).toLowerCase();
      if((p.genus&&pw.genera.includes(p.genus))||pw.name_keywords.some(k=>txt.includes(k))) pest.push({id:p.id,name:p.name,crop:c.crop,project:p.project,project_id:p.project_id,in_ground:likelyInGround(p,c),label:pw.label}); }
    const cd=coldFor(p,cad,low); if(cd) cold.push({id:p.id,name:p.name,crop:c.crop,...cd});
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
  return {counts:{plantings:plantings.length,water_due:due.length,no_history:noHistory.length,fertilize:fertilize.length,pest:pest.length,cold:cold.length,dormant:dormant.length},
    substrate, tasks:{water_due:due,no_history:noHistory,fertilize,pest,cold,dormant}};
}

// Compute the single weather callout (action only) from temp + hydrology. Priority order; null = no callout (no filler).
function computeCallout(weather, hy){
  const low=weather&&weather.tonightLow, high=weather&&weather.highToday;
  if(low!=null && low<40) return {icon:'freeze', text:`Freeze tonight (${low}°F) — cover or bring peppers & tomatoes in`};
  if(low!=null && low<45) return {icon:'cold', text:`Cool night (${low}°F) — protect flowering peppers/tomatoes`};
  if(high!=null && high>=88) return {icon:'heat', text:`Hot day (${high}°F) — deep-water thirsty crops, shade if wilting`};
  if(hy && hy.tomorrow_precip_in>=0.3 && (hy.tomorrow_pop==null || hy.tomorrow_pop>=50))
    return {icon:'rain', text:`${hy.tomorrow_precip_in}" rain tomorrow — water containers today, let in-ground beds wait`};
  if(hy && hy.recent_precip_in>=0.4)
    return {icon:'wet', text:`${hy.recent_precip_in}" fell recently — soil is wet, skip outdoor watering`};
  return null;
}
// Full-picture gate + uncertainty: flag when a significant precip event is also uncertain, or data is missing.
function hydrologyStatus(hy){
  if(!hy || hy.recent_precip_in==null || hy.upcoming_precip_in==null)
    return {ok:false, uncertainty:{flag:true, reason:'precip data incomplete — watering advice assumes no rain credit'}};
  const u = (hy.tomorrow_precip_in>=0.3 && hy.tomorrow_pop!=null && hy.tomorrow_pop>=40 && hy.tomorrow_pop<=60)
    ? {flag:true, reason:`rain tomorrow uncertain (${hy.tomorrow_pop}% on ${hy.tomorrow_precip_in}")`} : {flag:false};
  return {ok:true, uncertainty:u};
}

function generatePlan({plantings, cadence, fertModel, today, weather, hydrology, ownerFallback}){
  const byUser=new Map();
  for(const p of plantings){ const c=resolveCadence(p,cadence); const u=ownerFor(p,c,ownerFallback)||'__UNASSIGNED__'; if(!byUser.has(u))byUser.set(u,[]); byUser.get(u).push(p); }
  const hy=hydrology||null; const callout=computeCallout(weather,hy); const hs=hydrologyStatus(hy);
  const rainComing = !!(hy && hy.tomorrow_precip_in>=0.3 && (hy.tomorrow_pop==null||hy.tomorrow_pop>=50));
  const users={};
  for(const [u,rows] of byUser){ const up=generatePlanForUser(rows,cadence,fertModel,today,weather);
    if(rainComing) for(const w of up.tasks.water_due){ if(w.in_ground){ w.defer_for_rain=true; } }
    up.tasks.water_due.sort((a,b)=> (a.defer_for_rain?1:0)-(b.defer_for_rain?1:0));
    users[u]=up; }
  return {date:today,
    weather: weather? {tonightLow:weather.tonightLow, highToday:weather.highToday, code:weather.code, short:weather.short, unit:weather.unit||'F', callout} : null,
    hydrology: hy ? {recent_precip_in:hy.recent_precip_in, upcoming_precip_in:hy.upcoming_precip_in, tomorrow_precip_in:hy.tomorrow_precip_in, tomorrow_pop:hy.tomorrow_pop, rain_coming:rainComing, status:hs} : {status:hs},
    hot:(weather&&weather.highToday>=HOT_F)||false, water_source:(fertModel.water_quality||{}).source||null, users};
}
module.exports={generatePlan, generatePlanForUser, resolveCadence, coldFor, fertilizeRec, feedPhase, daysBetween, HOT_F};
