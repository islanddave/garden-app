'use strict';
// V4-OVERWINTER-001 — overwintering as an ORTHOGONAL CARE ATTRIBUTE, not a plants.status value.
//
// WHY NOT A STATUS (crucible verdict 2026-08-17, CONFLICT F): `status` is single-valued and already
// conflates three taxa (developmental stage / terminal outcome / process state). Overwintering is a
// FOURTH, and it is not mutually exclusive with the first: an overwintered kale is simultaneously
// `vegetative` AND overwintering. Writing 'overwintering' into status destroys the developmental
// value at write time and it is unrecoverable — `plants` has no status_changed_at and no prior-value
// column among its 53 columns. A CHECK value with live rows also cannot be re-narrowed, and 18 SQL
// NOT-IN predicates across the Lambdas all default to "include in watering", so the status form is a
// one-way schema door whose default failure direction is "water the plant you just protected".
//
// WHERE IT LIVES INSTEAD: the `care_profile` seam that already exists and was unused for this.
// care_profile.scope is an enum (system | cultivar | leaf) — verified live via pg_enum — and the
// handler already threads the merged profile through as p.db_cadence + the resolved cadence `c`.
// engine.js's dormant branch already proves a care-profile flag can drive care with ZERO status
// involvement (`c.dormant_skip`). A jsonb key is deletable and a leaf row is droppable, so this
// design can be wrong once and recovered; an enum value with live rows cannot.
//
// WHY NOT dormant_skip ITSELF: dormant skips routine care ENTIRELY. Overwintered crops still lose
// water — a low tunnel sheds the rain that would otherwise reach the bed, indoor heat dries a pot
// faster than July does, and a dry freeze kills more overwintered plants than cold does. So this
// module produces a REDUCED-CADENCE MOISTURE CHECK, never a skip and never an unconditional "water
// it": the emitted task asks Dave to feel the soil and water only if it is dry below the top inch.
// That framing is what makes the intervals below safe in both directions — checking never rots a
// quiescent rhizome (the Lithops/DRG-NOCALWATER-001 death mode), and never-checking is what kills a
// tunnel crop in a January dry spell.
//
// THE ADOPTION GATE (the trap this module is written around): resolveCadence adopts p.db_cadence
// ONLY when p.cadence_scopes is non-empty, and v_resolved_care populates cadence_scopes EXCLUSIVELY
// from water_interval_days{,_container,_inground} (verified in the live view definition). A leaf
// profile that carries only an `overwintering` key therefore contributes nothing to cadence_scopes,
// falls through to the bundled cadence-data-v2.json, and a `c`-only read would silently lose the
// override. So `readAttr` reads BOTH `c` AND the raw p.db_cadence — the same load-bearing double
// read waterSuppression() uses, for the same reason.

const DAY = 86400000;

// Site latitude. Mirrors station.js DEFAULT_STATIONS[0].lat (42.5089, Conway MA) — duplicated as a
// plain constant rather than imported because the window dates must not move if the weather-station
// config is edited or overridden by AWN_STATIONS_JSON. The daylength wall is a property of the
// GARDEN, not of the rain gauge.
const SITE_LAT = 42.5089;

// The Persephone threshold. Below ~10 hours of daylight, cool-season growth effectively stops: a crop
// that is not already near size will not gain any, and its water demand collapses with its growth
// rate. This is the physical event overwintering is organised around, and it is a pure function of
// latitude — which is what lets the exit below be automatic instead of a status somebody has to
// remember to clear.
const PERSEPHONE_HOURS = 10;

// Days of grace after `until` before a MANUAL-exit regime stops being reminded. Bounded on purpose:
// an unbounded reminder is just the one-way trap wearing a different hat.
const EXIT_NOTICE_DAYS = 14;

// V4-OVERWINTERCARDNOISE-001 (3) — the two conditions under which a field_hardy card cannot be acted
// on, so firing it only spends the user's attention. Both are deliberately coarse and both fail OPEN.
//
// FREEZE_F: you cannot water ground that is frozen through the whole day. The daily high, not the
// overnight low, is the right test — a 22F night that reaches 40F by noon IS a workable day, and it is
// exactly the "thaw day" the protected_productive guidance already tells Dave to wait for.
const FREEZE_F = 32;
// FIELD_HARDY_WET_IN: field_hardy is the ONE regime rain reaches, so measured precipitation is a real
// answer to the check, not a coincidence. Inherited from the engine's own "soil is wet, skip outdoor
// watering" callout bar rather than invented here — a plant with near-zero winter transpiration needs
// less than an active summer bed, so re-using the summer number is the conservative direction (it
// suppresses LESS often than a winter-specific bar would).
const FIELD_HARDY_WET_IN = 0.4;

// Extra days the two manual-exit regimes hold past the daylength return. Dave physically moves those
// plants (fig out of the garage, ginger off the windowsill), and resuming full summer cadence on a
// still-quiescent potted plant is the rot direction. Four weeks past the light return puts the
// default at 2027-03-03 here, by which time both are pushing growth.
const MANUAL_EXIT_LAG_DAYS = 28;

// ── The four regimes (crucible: horticulture seat won the COUNT; two is not enough) ────────────────
// check_interval_days is a CHECK cadence, not a watering cadence — see the module header.
//
//  protected_productive  low tunnel / cold frame kale, spinach, mache. Alive, photosynthesising and
//                        harvestable. The cover SHEDS RAIN, so this is the one regime where natural
//                        precipitation reaches the plant LESS than in summer. 14d: two weeks is short
//                        enough to catch a bed drying under cover before the crop checks, long enough
//                        that it is not a nag through a frozen fortnight.
//  protected_quiescent   fig / fuchsia / pelargonium in a cold garage or cellar. Leafless, near-zero
//                        transpiration, and wet + cold is the rot mode that kills these. 30d matches
//                        the standard "barely damp, roughly monthly" overwintering guidance and is
//                        the LONGEST interval here for exactly that reason.
//                        V4-OVERWINTERCARDNOISE-001 (2): the guidance used to state TWO set-points —
//                        "keep the medium BARELY damp" AND "water only if the medium is dry well
//                        below the surface" — which are different moisture states, and a gardener
//                        standing in a cold garage cannot act on both. Collapsed to ONE rule, and the
//                        one that can actually be executed in the dark on a leafless pot: LIFT IT.
//                        Weight integrates the whole root ball; a finger reads the top inch only, and
//                        on a quiescent pot the top inch is dry long before the core is.
//  field_hardy           garlic, unprotected mache, established perennials. Rain and snowmelt supply
//                        nearly everything. NOT a skip: a snowless dry cold snap desiccates crowns and
//                        heaves shallow roots, which is a real and locally common loss mode. 21d is
//                        the compromise — enough to surface a dry December, sparse enough to stay
//                        quiet in a normal one. The TRIGGER is gated separately — see
//                        fieldHardyActionable below.
//  tender_indoors        ginger, tropicals held above their chilling floor indoors. Heated indoor air
//                        plus a pot with no rain at all: the FASTEST-drying of the four despite being
//                        the least active, so it gets the SHORTEST interval, 7d. It is the only one of
//                        the four whose environment is HARSHER THAN SUMMER — heated air at winter
//                        indoor humidity works out to roughly 1.43x the vapour-pressure deficit of a
//                        Conway summer outdoors — and it is also the plant class whose failure is the
//                        fastest and the least reversible: a rhizome that dries through does not come
//                        back the way a wilted kale does. Two panel seats reached "10d is too long"
//                        independently (2026-08-18); 7d is the adjudicated value.
//                        7d is a PROMPT, not a guarantee. A 4-inch pot can run dry well inside a week,
//                        and vessel size is not an input to this model — the interval is set by regime
//                        alone, so a small pot still needs judgement between checks.
//                        Dormant's cold-and-dry track would kill this regime outright, which is the
//                        sharpest argument against folding overwintering into dormant_skip.
const OVERWINTER_REGIMES = {
  protected_productive: { check_interval_days: 14, protected: true,  harvestable: true,  auto_exit: true,
    guidance: 'Under cover — the cover sheds rain, so check the soil on a thaw day and water only if it is dry below the top inch. Vent on a sunny day above freezing. Harvest at midday, never at dawn while the leaves are frozen.' },
  protected_quiescent:  { check_interval_days: 30, protected: true,  harvestable: false, auto_exit: false,
    guidance: 'Cold and quiescent — one rule: LIFT THE POT. Water only if it feels light, and then only enough to take the lightness off; wet plus cold is what rots these. Keep it dark and cold; do not feed.' },
  field_hardy:          { check_interval_days: 21, protected: false, harvestable: false, auto_exit: true,
    guidance: 'Hardy in the ground — rain and snowmelt do the work. Check only during a snowless dry cold snap: desiccation and frost heave, not cold, are what take these. Do not feed until spring.' },
  tender_indoors:       { check_interval_days: 7,  protected: true,  harvestable: false, auto_exit: false,
    guidance: 'Held indoors above its chilling floor — reduced but NEVER bone dry. Check the top inch; water when it is dry, less than in summer. Watch for scale and spider mites. Do not feed while it is resting.' },
};

// An unrecognised regime string resolves HERE rather than throwing or silently disabling the
// attribute. protected_productive is the fail-safe choice: it is the SHORTEST-interval regime that
// still applies to an outdoor planting, so an unknown value can only ever check MORE often than the
// author intended, never less. Silence would be the harm direction.
const DEFAULT_REGIME = 'protected_productive';

// ── Daylength ─────────────────────────────────────────────────────────────────────────────────────
// Standard solar-declination model (Cooper 1969 declination + the sunrise hour-angle equation) with
// the -0.833 deg refraction/semidiameter correction, i.e. the sunrise-to-sunset definition, matching
// how published "10-hour day" tables are computed. Accurate to a few minutes at this latitude, which
// is well inside the one-day resolution the window needs.
function dayOfYear(dateStr) {
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00Z');
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / DAY);
}
function daylengthHours(lat, dateStr) {
  const n = dayOfYear(dateStr);
  const decl = 0.409105 * Math.sin((2 * Math.PI / 365) * n - 1.39);   // radians
  const phi = lat * Math.PI / 180;
  const cosH = (Math.cos(1.585340) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl)); // cos(90.833 deg)
  if (cosH >= 1) return 0;    // polar night
  if (cosH <= -1) return 24;  // midnight sun
  return 24 * Math.acos(cosH) / Math.PI;
}

function isoOf(year, dayIdx) {
  return new Date(Date.UTC(year, 0, dayIdx)).toISOString().slice(0, 10);
}

// The two dates the Persephone period closes on and reopens on in a given calendar year, scanned day
// by day rather than solved analytically — 365 evaluations of a closed form, once per plan run, and
// it stays correct if PERSEPHONE_HOURS or the latitude changes.
function persephoneDates(lat, year, hours = PERSEPHONE_HOURS) {
  let closes = null, opens = null;
  let prev = daylengthHours(lat, isoOf(year, 1));
  for (let i = 2; i <= 366; i++) {
    const iso = isoOf(year, i);
    if (new Date(iso + 'T00:00:00Z').getUTCFullYear() !== year) break;
    const cur = daylengthHours(lat, iso);
    if (prev >= hours && cur < hours) closes = iso;
    if (prev < hours && cur >= hours) opens = iso;
    prev = cur;
  }
  return { closes, opens };
}

// ── Attribute resolution ──────────────────────────────────────────────────────────────────────────
// Reads BOTH the resolved cadence and the RAW db profile — see the adoption-gate note in the header.
// `c` is preferred so a resolved leaf profile wins over a stale cultivar one when both carry the key.
function readAttr(p, c) {
  for (const s of [c, p && p.db_cadence]) {
    if (s && s.overwintering != null && s.overwintering !== false) return s.overwintering;
  }
  return null;
}

// Accepts either the shorthand `true` or an object. Returns null when the attribute is absent, so
// every planting in the garden today (zero leaf-scope care_profile rows on prod) is untouched.
function overwinterProfile(p, c) {
  const raw = readAttr(p, c);
  if (raw == null) return null;
  const o = (typeof raw === 'object') ? raw : {};
  const named = typeof o.regime === 'string' ? o.regime : null;
  const known = named != null && Object.prototype.hasOwnProperty.call(OVERWINTER_REGIMES, named);
  const regime = known ? named : DEFAULT_REGIME;
  const spec = OVERWINTER_REGIMES[regime];
  return {
    regime,
    unknown_regime: named != null && !known ? named : null,
    check_interval_days: spec.check_interval_days,
    auto_exit: spec.auto_exit,
    harvestable: spec.harvestable,
    // V4-OVERWINTERCARDNOISE-001 (1). Derived from `protected` rather than stored per regime, because
    // it IS the same fact: a low tunnel, a cold garage and a windowsill are all places rain does not
    // land. Read by lastTouch — see the note there for why this is a correctness fix and not a tidy-up.
    rain_counts: !spec.protected,
    guidance: typeof o.note === 'string' && o.note ? o.note : spec.guidance,
    from: typeof o.from === 'string' ? o.from.slice(-5) : null,   // 'MM-DD' or the tail of an ISO date
    until: typeof o.until === 'string' ? o.until.slice(-5) : null,
  };
}

function mmdd(iso) { return iso.slice(5, 10); }
function addDays(iso, n) { return new Date(new Date(iso + 'T00:00:00Z').getTime() + n * DAY).toISOString().slice(0, 10); }

// True when `md` falls inside [from, until) on the MM-DD circle. The overwinter window WRAPS the new
// year (Nov -> Feb), so a plain string compare is wrong in exactly the months this feature exists for.
function inWrappedWindow(md, from, until) {
  return from <= until ? (md >= from && md < until) : (md >= from || md < until);
}

// The full per-planting verdict for one plan date.
//
// Returns null when the planting has no overwintering attribute at all — the overwhelmingly common
// case, and the reason this whole module is byte-identical-inert until a leaf profile is written.
//
// { active }   the window is open: the planting is HELD OUT of the normal water/fert buckets and gets
//              a reduced-cadence moisture check instead.
// { exitDue }  the window has closed within the last EXIT_NOTICE_DAYS and the regime needs a physical
//              move. Normal care has ALREADY resumed at this point; this is a reminder, not a hold.
//
// THE EXIT IS THE PASSAGE OF TIME. Nothing has to write anything for a planting to leave
// overwintering: the window is re-evaluated from `today` on every nightly run, so when it closes the
// planting simply returns to its normal cadence. That is deliberate — `dormant` became a one-way trap
// precisely because the only writer of plants.status is a human tapping a form, and no automation
// ever clears it. A date window has no writer to forget.
function overwinterState(p, c, today, lat = SITE_LAT) {
  const prof = overwinterProfile(p, c);
  if (!prof) return null;
  const year = Number(today.slice(0, 4));
  const ps = persephoneDates(lat, year);
  const defFrom = ps.closes ? mmdd(ps.closes) : '11-09';
  // Auto-exit regimes end at the light return. Manual-exit regimes hold MANUAL_EXIT_LAG_DAYS longer,
  // because resuming summer cadence on a plant still sitting in a cold garage is the rot direction.
  const defUntilIso = ps.opens ? (prof.auto_exit ? ps.opens : addDays(ps.opens, MANUAL_EXIT_LAG_DAYS)) : null;
  const defUntil = defUntilIso ? mmdd(defUntilIso) : '02-03';
  const from = prof.from || defFrom;
  const until = prof.until || defUntil;
  const md = mmdd(today);
  const active = inWrappedWindow(md, from, until);
  let exitDue = false;
  if (!active && !prof.auto_exit) {
    // Bounded reminder: only in the EXIT_NOTICE_DAYS immediately after `until`, then silence.
    const endIso = today.slice(0, 4) + '-' + until;
    const graceEnd = mmdd(addDays(endIso, EXIT_NOTICE_DAYS));
    exitDue = inWrappedWindow(md, until, graceEnd);
  }
  return { ...prof, from, until, active, exitDue };
}

// Days since the planting was last watered OR last had its soil checked. A moisture_check MUST count
// here: an overwintering check that a damp pot cannot satisfy re-cards every night forever, which is
// the nag-extinction pattern V4-TROPICALCOLD-001 solved for the bring-indoors card by threading
// last_brought_inside through the same way. Both inputs are 'YYYY-MM-DD' UTC strings from the
// handler, so a lexicographic max IS a chronological one.
//
// V4-OVERWINTERCARDNOISE-001 (1) — RAIN ONLY COUNTS WHERE RAIN REACHES THE PLANT. handler.js's
// `last_water` is max(event_date) over event_type IN ('watering','rain'), so before this a logged rain
// event cleared the check card for a low tunnel, a cold garage and a windowsill alike — the three
// places whose defining property is that rain does NOT land there. A cover shedding rain is the entire
// reason protected_productive exists (module header), so crediting rain to it inverted the feature: the
// wetter the week, the longer a covered bed went unchecked. `last_hand_water` is the same subquery
// narrowed to event_type='watering', and the protected regimes read that instead.
//
// FAIL-OPEN: if last_hand_water is absent (an older handler, or a caller that does not select it) a
// protected planting whose only touch was rain reads as never-touched and CARDS. Losing a plant is
// worse than one extra card, so the missing-data direction is "ask", not "assume damp".
function lastTouch(p, state) {
  const rainCounts = !state || state.rain_counts !== false;
  const w = p && (rainCounts ? p.last_water : p.last_hand_water);
  const m = p && p.last_moisture_check;
  if (!w) return m || null;
  if (!m) return w;
  return m > w ? m : w;
}

// V4-OVERWINTERCARDNOISE-001 (3) — is a field_hardy check WORTH FIRING TODAY?
//
// The trigger was unconditional: every field_hardy planting carded every 21 days from Nov 7 to Feb 3
// regardless of the weather, which the 0818 crucible measured at roughly 109 non-actionable cards per
// winter. That is the alert-fatigue path — a card the user learns to dismiss trains them to dismiss the
// one that matters. The regime's OWN guidance already names the condition ("check only during a
// snowless dry cold snap"); this makes the trigger obey it with the signals the plan run actually has.
//
// NOT A SKIP AND NOT A RESET. A deferred check writes nothing, so `lastTouch` is untouched and the card
// re-appears in full on the first workable day. The check SLIPS; it is never cancelled.
//
// WHAT THIS CANNOT SEE: snow cover is not in the plan's weather payload at all, and hydrology carries
// only D-2+D-1 actual precipitation, so a wet fortnight followed by two dry days still reads as dry.
// Both gaps make this gate suppress LESS than it should, never more. The separate charge that the whole
// Nov-Feb WINDOW is aimed at the wrong months belongs to V4-FIELDHARDYWINDOW-001 and is not touched here.
//
// Returns { actionable, blocked_by } — blocked_by names WHICH condition held, so a plan run can be
// explained without re-deriving it.
function fieldHardyActionable(weather, hydrology) {
  const high = weather && weather.highToday;
  if (high != null && high < FREEZE_F) return { actionable: false, blocked_by: 'frozen' };
  // Measured only. today_precip_in is gauge-driven since BUG-RAINACTUAL-001, but a FORECAST must never
  // satisfy a check — "it is supposed to rain" is not water in the ground.
  const wet = hydrology
    ? (hydrology.recent_precip_in || 0) + (hydrology.today_observed_in ?? hydrology.today_precip_in ?? 0)
    : null;
  if (wet != null && wet >= FIELD_HARDY_WET_IN) return { actionable: false, blocked_by: 'recent_precip' };
  return { actionable: true, blocked_by: null };
}

// The reduced cadence, as an interval in days.
//
// MONOTONE BY CONSTRUCTION: max(base, regime). Overwintering can only ever LENGTHEN the interval,
// never shorten it — so a plant whose growing-season profile already says "every 30 days" is not
// pulled forward to 14 by being put under a tunnel. That property is what makes "reduced" a
// guarantee rather than a hope, and it is asserted directly in overwinter.test.js.
function checkIntervalFor(state, baseIntervalDays) {
  const base = Number.isFinite(baseIntervalDays) ? baseIntervalDays : 0;
  return Math.max(base, state.check_interval_days);
}

module.exports = {
  OVERWINTER_REGIMES, DEFAULT_REGIME, SITE_LAT, PERSEPHONE_HOURS, EXIT_NOTICE_DAYS, MANUAL_EXIT_LAG_DAYS,
  FREEZE_F, FIELD_HARDY_WET_IN,
  daylengthHours, persephoneDates, overwinterProfile, overwinterState, checkIntervalFor, lastTouch,
  fieldHardyActionable, inWrappedWindow,
};
