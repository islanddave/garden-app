// src/lib/sowEngine.js — DRG-SOWNOW-001 bucketing engine (horticulture-panel
// FINAL rules). Pure ESM, zero dependencies, UTC-safe date math.
//
// bucketize(candidates, todayISO, anchors?) sorts v_sow_candidates rows into
// action buckets for the /sow page. Numeric candidate fields may arrive as
// strings (neon driver) — everything is Number()-coerced here.

// V4-MATURITYBASIS-001 Slice C — the DTM basis vocabulary is single-sourced from the maturity
// engine rather than re-declared here. A local copy of the two CHECK-constrained strings would be
// one more thing that can silently drift from the DB.
// Slice D update: plantingMaturity.js is no longer import-free — it now pulls maturityCalibration.js.
// That module is itself zero-dependency, so the graph stays acyclic
// (sowEngine -> plantingMaturity -> maturityCalibration) and still costs nothing at runtime. Keep
// maturityCalibration.js dependency-free or this note stops being true.
import { DTM_BASIS_TRANSPLANT } from './plantingMaturity.js';

// ── The two frost anchors, and which question each one answers ───────────────────
// BUG-FROSTANCHORWRONG-001. There are TWO quantities here and there always were; until now only one
// of them had a name, so every consumer that wanted the other one silently took this one.
//
//   FROST_ANCHORS.firstFallFrost ('09-28')  = a CONSERVATIVE SOWING-SAFETY MARGIN.
//   OBSERVED_FIRST_FALL_FROST               = the MEASURED frost distribution at this site.
//
// They are 17 days apart at the median and that gap is deliberate, not error: '09-28' is the date
// past which a sowing decision should stop assuming it has a season, and being early on a sowing
// decision costs one forfeited sowing while being late costs the whole planting. Nothing about it is
// a claim that frost arrives on 09-28.
//
// BUG-FROSTANCHORERA5-001 SHRANK THAT GAP FROM 31 TO 17 AND INVALIDATED ONE SENTENCE THAT USED TO
// SIT HERE. The old text said frost "never has" occurred as early as 09-28, in 11 years. That was
// true of ERA5 and is FALSE of the station record: 1 of the 11 seasons (2020, 09-21) had its first
// <=32F night before the margin. The margin is NOT re-derived here and stays at '09-28' — it is a
// margin, not a measurement, its job is to sit ahead of frost rather than on it, and it still does
// so in 10 of 11 seasons (the 34-season composite puts p10 at 09-20). Moving it is a separate
// decision with its own consumers, and it would be the two-anchor conflation this block exists to
// prevent to load the correction into it. What DID have to change is the justification: sowEngine
// .test.js now pins the margin's exposure (seasons earlier than it) as a number, so the day it
// stops being conservative enough nobody has to notice it in prose.
//
// THE RULE: a consumer asking "is it too late to START something that frost will kill?" takes
// FROST_ANCHORS. A consumer asking "when will frost actually happen?" takes
// OBSERVED_FIRST_FALL_FROST. Consuming the margin as a date compounds two conservatisms and the
// result is wrong-early by a month with no line of code that says so — which is how
// storageDeadlines.json shipped a 09-25 sweet-potato lift deadline (reverted 1.2.0, see that file's
// `frost_anchor_warning`) and how the fall-hardy grace below spent a month it did not have.
export const FROST_ANCHORS = Object.freeze({
  lastSpringFrost: '05-20',
  firstFallFrost: '09-28',
  windowClosingDays: 10,
});

// The measured first-fall-frost distribution at THIS site. Same measurement, same field names and
// same executable `query` as src/data/storageDeadlines.json's sweet_potato `measured_basis` — the two
// are pinned deep-equal in sowEngine.test.js so one site cannot end up with two frost records. The
// stats are not literals-by-assertion either: the same test recomputes earliest/median/latest FROM
// `first_frost_by_year` and fails if a stat is edited without the data behind it.
//
// This is a DISTRIBUTION, not a date. `medianMonthDay` is the central estimate a consumer should aim
// at; `earliestMonthDay` is the backstop for a year nobody watched the forecast; `latestMonthDay`
// bounds the tail. None of the three is a forecast, and the forecast path
// (lambda/daily-plan/frostClass.js) beats all of them when it exists.
//
// ── BUG-FROSTANCHORERA5-001: THE INSTRUMENT WAS WRONG, NOT THE RECORDING ────────────
// Every value below was replaced on 2026-09-03. The previous block was ERA5 reanalysis presented as
// a site measurement, and it was reproduced byte-for-byte from its own stated query — the recording
// was honest. The INSTRUMENT is what failed: ERA5-Land misses ~62% of real frost nights here and
// runs ~+8F warm on sub-32F minima, because a ~9km grid cell cannot hold a radiational frost. Its
// median came out 10-29 against a station median of 10-15.
//
// WHY 10-15 AND NOT 10-10 — read this before "fixing" one to match the other. Both numbers are
// right; they answer different questions. 10-15 is the 3-station composite over the SAME 11 seasons
// (2015-2025) the ERA5 block used, so replacing one with the other changes exactly one variable —
// the instrument — and makes the 14-day correction attributable. 10-10 is the same composite over 34
// seasons (1991-2025); it is equally defensible, it is what the site knowledge library carries, and
// the 5 days between them are a real warming signal plus a window choice that nobody had argued for.
// The full 19-day gap from the ERA5 figure decomposes as 14 days instrument + 5 days window. This
// constant corrects ONLY the instrument. Dave's call, 2026-09-02. If the window is ever widened to
// 34 seasons that is a separate, deliberate decision — not a reconciliation of two numbers that
// disagree, because they do not disagree.
//
// A COINCIDENCE OF QUANTITIES, NOT A CONFIRMATION. The independently measured temperature growth
// stop for hardy greens at this site also lands ~Oct 15. That is two routes to the same date and it
// is why ~10-15 is well supported, but neither measured the other and nothing here should be read as
// though one did: FFobs on the hardy branch is used as a GROWTH-STOP PROXY, while this constant is a
// FROST MEDIAN. They are different quantities that happen to share a value this year.
//
// `latestMonthDay` MOVED 11-08 -> 10-31 AND THAT ONE HAS A FROZEN COPY. migrations/v4-anchorbase-001
// /0b-backfill.sql is applied and hardcodes '11-08' — deliberately NOT updated, see
// lambda/anchor-plausibility-frost.test.js for why the pin there is now historical rather than live.
export const OBSERVED_FIRST_FALL_FROST = Object.freeze({
  medianMonthDay: '10-15',
  earliestMonthDay: '09-21',
  latestMonthDay: '10-31',
  measured_basis: Object.freeze({
    what: 'First fall night at or below 32F at this site — the event that ends a frost-tender crop.',
    query: 'GET https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries&stations=USC00190120,USC00193229,USC00194154&dataTypes=TMIN&startDate=2015-01-01&endDate=2025-12-31&format=json&units=standard — then, per station per year, the first date on or after Jul 1 with TMIN <= 32; then per year the MEDIAN across whichever stations passed QC. QC runs before any statistic: drop a season with fewer than 70 of the 76 days Sep 1 - Nov 15 (coverage), and drop a TMIN 15F or more below BOTH neighbouring days (spike). The three stations stand in for the site at latitude=42.5087 longitude=-72.6471 — they are 8.1 to 16.3 km away, so this is a composite, not an on-site reading.',
    source: 'NOAA GHCN-Daily 3-station composite, TMIN: USC00190120 Amherst (44 m, 16.3 km), USC00193229 Greenfield #3 (40 m, 8.1 km), USC00194154 Leverett #2 (96 m, 11.8 km). 3 stations per season except 2018 (n=2 — Leverett dropped by coverage QC).',
    source_url: 'https://www.ncei.noaa.gov/access/services/data/v1',
    years: 11,
    first_frost_earliest_month_day: '09-21',
    first_frost_median_month_day: '10-15',
    first_frost_latest_month_day: '10-31',
    first_frost_by_year: Object.freeze({
      2015: '10-16', 2016: '10-11', 2017: '10-17', 2018: '10-19',
      2019: '10-05', 2020: '09-21', 2021: '10-24', 2022: '10-09',
      2023: '10-31', 2024: '10-15', 2025: '10-10',
    }),
    september_bounds: "The left tail DOES reach September: 2020 first-frosted on 09-21, 1 season in 11. This REPLACES the ERA5 block's claim that it does not — that claim was the instrument, not the site, and it is what let 09-25 be called impossible. It is still a thin tail (1 of 11, and the next earliest is 10-05, a fortnight later), so a September frost is a live possibility to watch a forecast for rather than a date to plan against.",
    instrument_limits: 'A station composite, not an on-site reading. All three stations are valley-floor or basin positions and the site is a drained shoulder, which is worth ~0-2 days on a MEDIAN (the quantity set here) though ~+8.5 days on a mean — do not bank the mean. n=11 is noisy: order statistics 5/6/7 are 10-11, 10-15, 10-16, so one revised season moves this several days. That noise is deliberately NOT absorbed as safety margin here — FROST_ANCHORS.firstFallFrost is the constant that carries conservatism, and loading more into a measured value is the two-anchor conflation BUG-FROSTANCHORWRONG-001 exists to prevent.',
    reproduced_by: 'BUG-FROSTANCHORERA5-001 (2026-09-03). Two crucible seats reproduced the station composite independently and matched row for row; a third reproduced the superseded ERA5 figure byte-for-byte from its own query, which is how the failure was localised to the instrument. The era-matched median was self-corrected mid-panel from 10-16 to 10-15 after a leap-year bug in the first pass.',
  }),
});

/** Days shaved off fall math for slowing autumn growth. */
export const FALL_SLOWDOWN_DAYS = 14;

/**
 * BUG-SOWHARDYANCHOR-001 — what actually ends a FALL_HARDY_CROPS sowing.
 *
 * NOT a frost date. A hardy slug is by definition "unharmed or improved by frost", so first frost
 * cannot be the event that ends it — latestSafeMs said exactly that in its own comment and then
 * anchored to first frost anyway. The real limit is the 10-hour daylength ("Persephone") wall, below
 * which cool-season growth effectively stops: a crop that is MATURE by then holds in the field and
 * can be picked through winter; one that is not, sits undersized until spring.
 *
 * DAVE DECISION 2026-09-02, asked in plain terms and answered "daylength, with a margin".
 *
 * THE MARGIN IS ZERO AT THE ANCHOR, AND THAT IS DELIBERATE — the target IS the wall. No new constant
 * is introduced here, which is the whole point: a fabricated margin is what produced the retired
 * FALL_GRACE_HARDY = 28 (its own comment records it as COPIED from FALL_GRACE_DAYS.cool, never
 * derived, and "right" only because it cancelled an anchor 31 days early). Dave has never tried a
 * late-season hardy harvest here, so there is no site experience to calibrate a margin from and one
 * is not being guessed. The slow-growth allowance rides on the DTM via FALL_SLOWDOWN_DAYS — that
 * constant's DOCUMENTED job ("corrects the DTM for shortening days, NOT the anchor"), and already
 * how the fall indoor pass spends it.
 *
 * RESTATED, NOT IMPORTED: src/lib may not import a Lambda, so this duplicates
 * lambda/daily-plan/overwinter.js's persephoneDates(SITE_LAT). sowEngine.test.js pins the two in
 * lockstep — the same pattern the frost basis and watch.js's restated anchor already use. The value
 * is solar, so it does not drift year to year (11-07 for 2025/2026/2027). Note the pre-existing
 * comments in this file cite 11-09; the function returns 11-07 and the test binds to the FUNCTION.
 *
 * REVISIT after a season of on-site observation — this is a model, not a measurement.
 */
export const HARDY_GROWTH_STOP_MONTH_DAY = '11-07';

/** Fall indoor-pass grace days by season (warm gets no fall pass).
 * V4-FALLINDOORHARDY-001 NARROWED WHAT `cool` MEANS HERE without changing its value. The fall indoor
 * pass now routes FALL_HARDY_CROPS onto ctx.FFobs with NO grace, so `cool` is consumed only by
 * cool-season crops that frost KILLS. 28 days past the sowing-safety margin (= Oct 26) was defensible
 * while the bucket held kale and lettuce alongside them; for the tender remainder alone it is loose,
 * and the honest value is probably FALL_GRACE_COOL's 14, matching the direct-sow branch. NOT changed
 * here: that is a calibration decision with no measurement behind it either way, and this item is the
 * anchor re-key. Filed rather than guessed.
 *
 * BUG-FROSTANCHORERA5-001 SHARPENED THAT, WITHOUT CHANGING THE VALUE. Oct 26 used to sit 3 days
 * BEFORE the (ERA5) median first frost, so "loose" was the whole complaint. Against the corrected
 * median it sits 11 days AFTER it — this arm aims a FROST-KILLED crop's maturity past the date frost
 * typically arrives. Still not changed here, for the same reason as before and one more: this item is
 * a measurement correction, and retuning a calibration constant inside it would make the two
 * unattributable. It is now a real defect rather than looseness, and it wants its own decision.
 */
export const FALL_GRACE_DAYS = Object.freeze({ cool: 28, cool_warm: 14 });

// ── Allium viability gate (V4-SOWNOW-PHOTOPERIOD-001) ────────────────────────────
// Bulb-forming alliums are SPRING-ESTABLISHMENT crops: a summer sowing cannot size a bulb before
// frost, and a seedling that overwintered would vernalize and bolt instead of bulbing. Both failure
// modes point the same way, so these are held for spring rather than offered in July.
//
// POLARITY IS DELIBERATE AND CORRECTNESS-CRITICAL — gate UNLESS confirmed bunching, never "gate if
// confirmed bulbing". growth_habit is free-text prose and the affirmative bulbing patterns miss the
// real rows: on 2026-07-24 all five bulbing onion sow-candidates in prod (Flat of Italy, Monastrell,
// Red Amposta, Yellow Granex PRR, Yellow Sweet Spanish Utah) carry prose that matches no bulbing
// pattern, while the one bunching onion (Tokyo Long White) matches 'non-bulbing' cleanly. An
// affirmative predicate would have shipped the reported bug unfixed.
//
// garlic is deliberately NOT gated: it is fall-planted and needs vernalization, so a spring-only
// gate would be horticulturally wrong. It is not a seed sow-candidate in prod today, and if garlic
// seed is ever added its 240-270d maturity math buckets it correctly without this gate.
const GATED_ALLIUM_SLUGS = new Set(['onion', 'shallot']);

// Bunching/non-bulbing exclusion. Narrow by design: this is the only half of alliumType()
// (lambda/varieties/crop-derive.js) the engine needs, kept local so src/lib stays dependency-free
// instead of becoming a third synced copy of that module. sowEngine.test.js pins this predicate
// against the real prod prose corpus so the two cannot silently diverge.
const BUNCHING_HABIT_RE = /non[-_ ]?bulbing|bunching|scallions?/gi;

// A bunching token sitting inside a negation or comparison describes what the variety is NOT:
// "not a bunching type", "unlike a scallion", "pulled young as a scallion", "(non-bunching)".
// That phrasing is stock seed-catalog copy for BULB onions, so counting it as a bunching signal
// fails the gate OPEN — the exact prose-matching failure this gate exists to correct, pointed the
// other way. growth_habit is free text (varieties API validates only `typeof === 'string'`), so an
// enrichment rewrite could otherwise delete a variety's gate with no signal.
//
// Bounded to the same clause and ~30 chars back. 'as' is included deliberately even though it also
// appears in genuine bunching prose ("grown as an annual scallion"): a variety whose ONLY signal is
// that phrasing gates conservatively and keeps its "Sow anyway" override, whereas omitting 'as'
// lets "harvest thinnings as scallions" un-gate a true bulb onion. Fail-safe wins.
const NEGATED_BEFORE_RE = /\b(?:not|non|no|never|unlike|rather|than|instead|versus|vs|as)\b[^.;]{0,30}$/i;

/** True when prose carries at least one bunching signal that is NOT negated or comparative. */
function hasUnqualifiedBunchingSignal(prose) {
  const re = new RegExp(BUNCHING_HABIT_RE.source, 'gi');
  let m;
  while ((m = re.exec(prose)) !== null) {
    const before = prose.slice(Math.max(0, m.index - 30), m.index);
    if (!NEGATED_BEFORE_RE.test(before)) return true;
  }
  return false;
}

const GATE_REASONS = Object.freeze({
  onion: 'Bulb onions need a spring start — a summer sowing will not size a bulb before frost. Start indoors in late winter.',
  shallot: 'Shallots need a spring start — a summer sowing will not size bulbs before frost. Start indoors in late winter.',
});

/**
 * True when the candidate is a bulb-forming allium that must not be offered outside spring.
 * Fails SAFE on an absent growth_habit column (engine deployed ahead of the view-widen): no prose
 * means not-confirmed-bunching, so the candidate is still gated. It never fails open.
 */
export function isSpringEstablishmentAllium(candidate) {
  if (!GATED_ALLIUM_SLUGS.has(candidate?.crop_type_slug)) return false;
  return !hasUnqualifiedBunchingSignal(String(candidate?.growth_habit ?? ''));
}

const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isoToMs(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function anchorToMs(mmdd, year) {
  const [m, d] = String(mmdd).split('-').map(Number);
  return Date.UTC(year, m - 1, d);
}

function msToISO(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function labelDate(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** labelDate, plus the year when it is not the year being bucketed (a hold can reopen months out). */
function labelDateAcrossYears(ms, ctxYear) {
  const d = new Date(ms);
  const base = labelDate(ms);
  return d.getUTCFullYear() === ctxYear ? base : `${base}, ${d.getUTCFullYear()}`;
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── Fall hardiness (V4-HARDYSET-001) ─────────────────────────────────────────────
// Which cool-season crops earn the +14d fall grace (latest-safe FF+28-dtm instead of FF+14-dtm),
// decided by crop_type_slug instead of by packet prose.
//
// REPLACES `HARDY_RE = /frost.?tolerant|improves? (in flavor )?after (light )?frost/i` tested against
// sow_notes. That regex had ZERO false positives — the branch requires sow_season='cool' and all 82
// pepper candidates are 'warm' or NULL, so a warm packet could never reach it — but it was a lottery
// on the seedsman's copywriter. Measured against live v_sow_candidates 2026-08-17: 10 of 64 cool
// candidates matched, catching radish (24d, moderately hardy) while missing spinach, every lettuce,
// Vates and Redbor kale, mustard, arugula, chard and leek, several of which stand harder frost than
// anything it caught. Two packets of the SAME SPECIES disagreed — Lacinato kale read "through Aug 25"
// while Vates kale read too_late (Aug 13), on prose alone.
//
// THE RULE THE SET ENCODES: the harvested organ (leaf, root, stem, bud) keeps standing — or improves
// — through repeated fall frost, so growth past the frost anchor is still a harvest. That is the same
// question lambda/daily-plan/frostClass.js's `hardy` band already answers ("unharmed or improved by
// frost, NEVER alerted"), so this is its edible subset rather than a second hardiness vocabulary;
// sowEngine.test.js pins the subset relation so the two cannot drift. Deliberately COPIED, not
// imported: src/lib stays free of lambda/ (the rule BUNCHING_HABIT_RE follows above), and the band is
// wider than this anyway — it also covers roses, hostas and fruit trees, which have no sow window.
//
// Removed from that band on purpose, by class:
//   onion, shallot        — bulbers, already held for spring by isSpringEstablishmentAllium. A fall
//                           grace on a crop that must not be fall-sown is a contradiction.
//   pea                   — the vine takes frost, the PODS do not, and the pods are the harvest. The
//                           packets say "10-12 wks before first fall frost" (~Jul 15) themselves.
//   rat_tail_radish       — warm-season, and its harvest is the seed pod, not the root.
//   sage/thyme/oregano/   — perennial crowns. A fall sowing of these is establishment, and sowGoal
//   mint/tarragon/          routes them to the establishment clamp before the cool branch is reached.
//   asparagus/strawberry/
//   the woody fruit
//
// mache, claytonia, tatsoi and mizuna belong here the day those crop_types exist (they do not yet —
// DATA-WINTERGREENS-001). Band them in frostClass first, or the subset guard will say so.
export const FALL_HARDY_CROPS = new Set([
  'arugula', 'beet', 'bok_choy', 'broccoli', 'brussels_sprouts', 'bunching_onion', 'cabbage',
  'carrot', 'celery', 'chard', 'chervil', 'chives', 'cilantro', 'collard', 'endive', 'garlic',
  'kale', 'kohlrabi', 'leek', 'lettuce', 'mustard', 'parsley', 'parsnip', 'radicchio', 'radish',
  'spinach', 'turnip',
]);

// Days past the SOWING-SAFETY anchor a cool-season but NOT frost-hardy direct sowing may be aimed
// at. Numerically equal to FALL_GRACE_DAYS.cool_warm above, but a different quantity — that one is
// the fall INDOOR pass's grace and is keyed by sow_season, not by hardiness. Do not collapse them.
//
// BUG-FROSTANCHORWRONG-001 removed this constant's hardy sibling (`FALL_GRACE_HARDY = 28`) rather
// than re-pointing it. Its own comment recorded that it was COPIED from FALL_GRACE_DAYS.cool, never
// derived, and the copy only looked right because it was cancelling an anchor that sat 31 days early:
// FROST_ANCHORS + 28 = Oct 26, which is a plausible latest-maturity date reached by adding a made-up
// number to a number that means something else. Carrying the 28 onto the measured anchor would aim a
// hardy sowing past the site's own 10-hour Persephone wall (2026-11-09, computed independently in
// lambda/daily-plan/overwinter.js), i.e. at growth that cannot happen — Nov 26 under the ERA5 median
// this argument was first written against, Nov 12 under BUG-FROSTANCHORERA5-001's corrected one. The
// correction narrows the margin of the argument and does not touch its direction. The hardy branch
// consumes OBSERVED_FIRST_FALL_FROST.medianMonthDay with NO grace, which is bounded below by the
// measurement and above by that wall; sowEngine.test.js asserts both bounds.
const FALL_GRACE_COOL = 14;

/** Split direct_sow_timing into clauses on ';' and ' or ' (case-insensitive). */
/**
 * BUG-SOWCLAUSEPARENSPLIT-001 — split on a separator only at PAREN DEPTH ZERO.
 *
 * THE DEFECT, measured on live prod rather than imagined. Packet prose puts qualifying detail in
 * parentheses and that detail contains separators:
 *
 *   Quincy: "Direct sow after all frost once soil is reliably warm (optimal 75-95F; never below
 *            55-60F). Zone 5b: late May to mid-June."
 *
 * A bare `.split(';')` cuts inside the parenthetical and yields two fragments, neither of which is a
 * sentence: `…reliably warm (optimal 75-95F` and `never below 55-60F). Zone 5b: late May to
 * mid-June`. classifyClause returns null for both, they are dropped SILENTLY, and a live variety
 * ends up with no parsed sow window at all — from a semicolon, not from anything about the crop.
 *
 * Depth-aware for ` or ` too, and for the same reason: "(spring or fall)" is one qualifier, not two
 * clauses. Nesting is counted rather than flagged, so `((a; b); c)` behaves; an UNBALANCED prose
 * paren cannot make the scanner lose a separator forever because depth is clamped at 0 — a stray
 * `)` returns to top level rather than going negative and swallowing the rest of the string.
 *
 * This is the same class of bug as splitting SQL on a bare `;` — a separator that is only a
 * separator outside its quoting context.
 */
export function splitClauses(timing) {
  if (!timing) return [];
  const src = String(timing);
  const parts = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[') { depth++; buf += ch; continue; }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (depth === 0) {
      if (ch === ';') { parts.push(buf); buf = ''; continue; }
      // ` or ` — whitespace-delimited on both sides, matching the previous /\s+or\s+/i split, so
      // "colorful" and "or" as part of a word are untouched.
      const m = /^\s+or\s+/i.exec(src.slice(i));
      if (m) { parts.push(buf); buf = ''; i += m[0].length - 1; continue; }
    }
    buf += ch;
  }
  parts.push(buf);
  return parts
    .map((part) => part.trim().replace(/^[,.]+|[,.]+$/g, '').trim())
    .filter(Boolean);
}

// Class F fall/summer month tokens (checked in order; matched text consumed).
const MONTH_TOKENS = [
  [/late\s+summer/i, '08-01', '09-10'],
  [/mid.?summer/i, '07-01', '07-31'],
  [/late\s+june/i, '06-20', '06-30'],
  [/early\s+july/i, '07-01', '07-10'],
  [/late\s+july/i, '07-20', '07-31'],
  [/late\s+aug(?:ust)?\b/i, '08-15', '08-31'],
  [/aug(?:ust)?\s*[-–—]\s*sep(?:t(?:ember)?)?\b/i, '08-01', '09-15'],
  [/\baug(?:ust)?\b/i, '08-01', '08-31'],
];

const WEEKS_BEFORE_FF_RE = /(\d+)\s*[-–—]\s*(\d+)\s*w(?:ee)?ks?\s+before\s+first(?:\s+fall)?\s+frost/i;
// `before <filler> last frost`: packet copy interposes a qualifier between "before" and the anchor and
// the clause was dropped ENTIRELY over it — Dill 'Bouquet' writes "1-2 weeks before AVERAGE last frost"
// and Javelin "2-3 wks before TO AROUND last frost". Both name their own week count; both scored cls
// null and rendered no window. The filler set is CLOSED (to/around/average/approximately/the), not a
// `\w+{0,2}` wildcard: a wildcard would also swallow a negation or a different anchor's adjective and
// silently attach the week count to the wrong date. VERIFIED, not asserted: the real classifier was run
// over all 198 live prod clauses before and after (scripts/snapshot-clause-classes.mjs, pointed at a
// git-show copy of the pre-change engine so both sides use one harness). Exactly 11 clauses moved,
// every one NULL -> a class; ZERO moved between existing classes, which was the actual risk of widening
// a mid-chain branch above D and F. Unclassified went 19 -> 8.
const WEEKS_BEFORE_LF_RE = /(\d+)(?:\s*[-–—]\s*(\d+))?\s*w(?:ee)?ks?\s+before\s+(?:to\s+)?(?:around\s+|approximately\s+)?(?:the\s+)?(?:average\s+)?last\s+frost/i;
const WEEKS_AFTER_LF_RE = /(\d+)(?:\s*[-–—]\s*(\d+))?\s*w(?:ee)?ks?\s+after\s+last\s+frost/i;
const SOIL_TEMP_RE = /(?:[≥>]=?\s*)?(\d{2,3})(?:\s*[-–—]\s*\d{2,3})?\s*°\s*F/;

/**
 * Classify one direct-sow-timing clause (classes A–L).
 * Returns { cls, clause, weeksMin?, weeksMax?, soilTempF?, zone5b6a,
 * mildClimates, monthWindows? }. cls is null for unclassifiable clauses.
 */
export function classifyClause(clause) {
  const c = String(clause);
  const info = {
    cls: null,
    clause: c,
    zone5b6a: /zone\s*5b|5b\s*[-–—/]\s*6a/i.test(c),
    mildClimates: /mild\s+climates?/i.test(c),
  };
  const temp = c.match(SOIL_TEMP_RE);
  if (temp) info.soilTempF = parseInt(temp[1], 10);

  let m;
  if (/self.?(?:sows?|seeds?)/i.test(c)) {
    info.cls = 'L';
  } else if (/(?:grow\s+)?indoors\s+year.?round/i.test(c)) {
    info.cls = 'J';
  // `fall[-\s]sow`: packet copy uses both "fall sow" and the hyphenated "fall-sow". Matching only
  // the spaced form silently dropped Edelweiss, whose clause carries the class-G phrase verbatim
  // ("...or fall-sow for spring germination") and differs by one character. Widening the SEPARATOR
  // only — the required "for (early) spring germination|bloom" tail is deliberately unchanged, so a
  // clause that merely mentions fall-sowing as an ALTERNATE to a spring primary (Althaea) still
  // does not become a fall-only recommendation.
  } else if (/fall[-\s]sow\s+for\s+(?:early\s+)?spring\s+(?:germination|bloom)/i.test(c)) {
    info.cls = 'G';
  } else if (/summer\s+for\s+next.?year\s+bloom|blooming\s+next\s+spring/i.test(c)) {
    info.cls = 'H';
  } else if ((m = c.match(WEEKS_BEFORE_FF_RE))) {
    info.cls = 'E';
    info.weeksMin = parseInt(m[1], 10);
    info.weeksMax = parseInt(m[2], 10);
  } else if ((m = c.match(WEEKS_BEFORE_LF_RE))) {
    info.cls = 'A';
    info.weeksMin = parseInt(m[1], 10);
    info.weeksMax = m[2] != null ? parseInt(m[2], 10) : parseInt(m[1], 10);
  // `after all frost` / `after all danger of frost has passed` are the same instruction as `after last
  // frost` said in plainer words, and both live clauses carrying them ALSO name the date in their own
  // parenthetical — Common Milkweed "(late May in zone 5b/6a)", Quincy "Zone 5b: late May to mid-June" —
  // and were dropped anyway. Kept as a separate alternation rather than loosening `last`: matching a bare
  // /after\s+.*frost/ would also capture "after FIRST frost", which is the opposite end of the season.
  } else if (/after\s+last\s+frost/i.test(c) || /after\s+all\s+(?:danger\s+of\s+)?frost/i.test(c)) {
    info.cls = 'B';
    if ((m = c.match(WEEKS_AFTER_LF_RE))) {
      info.weeksMin = parseInt(m[1], 10);
      info.weeksMax = m[2] != null ? parseInt(m[2], 10) : parseInt(m[1], 10);
    }
  // Class C widened on two fronts, both measured against live prose:
  //   (1) `soil IS WORKABLE` — the same instruction as `soil CAN BE WORKED`, differing by wording only
  //       (Althaea, Red Mustard). Pure phrasing loss.
  //   (2) bare `early spring` with no month and no frost anchor (both columbines, Hummingbird Haven,
  //       Edelweiss, Column Blend). DAVE'S CALL 2026-09-02: "early spring when soil is cold" IS the
  //       earliest-workable-soil window, not a narrower one — every packet carrying the phrase here is
  //       cold-tolerant or cold-REQUIRING seed (columbine and edelweiss need cold soil to germinate), so
  //       the earliest workable date is horticulturally correct for them rather than merely convenient.
  //       Recorded as a decision, not a guess: without it the engine would have to invent a date range.
  // Position matters and is unchanged: C sits BELOW A/B/E/G/H/J/L, so a clause that also carries a week
  // count or a frost anchor still classes on that stronger signal — "early spring, 2 wks before last
  // frost" stays A. It sits ABOVE D and F, so verify by snapshot rather than by reading: widening a
  // middle-of-chain branch can steal clauses from every branch below it.
  } else if (/as\s+soon\s+as\s+(?:the\s+)?soil\s+(?:can\s+be\s+worked|is\s+workable)/i.test(c)
             || /\bearly\s+spring\b/i.test(c)) {
    info.cls = 'C';
  } else if (/succession/i.test(c)) {
    info.cls = 'D';
  } else {
    const windows = [];
    let rest = c;
    for (const [re, open, close] of MONTH_TOKENS) {
      if (re.test(rest)) {
        windows.push([open, close]);
        rest = rest.replace(re, ' ');
      }
    }
    if (windows.length) {
      info.cls = 'F';
      info.monthWindows = windows;
    } else if (/\bfall\s+(?:crop|harvest)\b/i.test(c)) {
      // Class M — BUG-SOWFALLCROPCLAUSE-001. A clause that names a fall crop/harvest with NO month
      // token and no frost anchor: "also good as a fall crop", "…for a fall harvest". Dave's call
      // 2026-09-02 was to count back from first frost by the variety's days-to-maturity rather than
      // invent a calendar window — and latestSafeMs ALREADY IS that count-back, so class M needs no
      // new math, no new anchor and no new constant. It only needs a name.
      //
      // PLACEMENT IS THE WHOLE FIX AND IT IS LOAD-BEARING. This sits at the BOTTOM of the chain, as
      // the `else` of the class-F month-token loop, so it fires ONLY when nothing else matched.
      // MEASURED, both ways: here it moves exactly 2 clauses, NULL -> M, with zero clauses moving
      // between existing classes. The intuitive placement — a sibling `else if` up beside class E,
      // where the other frost-relative patterns live — STEALS 20 correctly-classified clauses and
      // reds 4 pinned tests, because "fall crop" appears inside prose that class D, E and F already
      // read correctly ("late summer for fall crop" is class F and must stay class F). Do not
      // promote this branch up the chain.
      info.cls = 'M';
    }
  }
  return info;
}

function soilTempFloor(soilTempF, year) {
  if (soilTempF == null) return null;
  if (soilTempF >= 65) return anchorToMs('06-10', year); // >=65-70F -> Jun 10
  if (soilTempF >= 60) return anchorToMs('06-01', year); // >=60F -> not before Jun 1
  return null; // cooler temps are advisory only
}

// BUG-SOWNONANNUAL-001 constants. Establishment arithmetic, derived not asserted:
// root growth continues past first frost until soil drops below ~43F, ~35 days after FF here; a
// rosette needs ~8 weeks of ACTIVE growth to reach the crown mass that resists March frost heave
// (which kills more first-winter perennials in Franklin County than cold does) and, for the
// vernalization-requiring biennials, to be large enough to actually bolt in year 2. October growth
// is worth well under half of July growth, hence the existing FALL_SLOWDOWN_DAYS discount.
//   FF + 35 - 56 - 14  ==  FF - 35d  ==  Aug 24 when FF = Sep 28.
// Sanity check: class H's existing Aug 15 close is independently derived and agrees within 9 days.
const ESTABLISH_DAYS = 56;
const FALL_GROWTH_TAIL = 35;
// A "days to maturity" over this on a NON-annual is days-to-BLOOM across a winter, not days to a
// harvest — the year-2 bloomers in the catalog carry dtm=300. Using it as a season-length clamp is
// a category error that produces close dates in the previous November.
const DTM_NOT_A_MATURITY = 200;

// FALLBACK ONLY as of BUG-SOWFIRSTYEAR-001. The authoritative answer now lives in
// crop_types.first_year_harvest, exposed on v_sow_candidates, and sowGoal consults it FIRST. This
// set survives for the rows where that column is still NULL (unknown) — most of the catalog, by
// design, since only unambiguous slugs were seeded. Prefer fixing the DATA over extending this list:
// a value here needs a deploy, a value in the column does not.
const FIRST_YEAR_HARVEST_CROPS = new Set([
  'brussels_sprouts', 'carrot', 'beet', 'chard', 'parsley', 'parsnip', 'celery', 'celeriac',
  'kale', 'turnip', 'rutabaga', 'salsify', 'fennel', 'leek', 'onion', 'cabbage',
]);
const HARVEST_TEXT_RE = /for\s+(?:a\s+)?(?:fall|summer|winter|spring)?\s*harvest|first[-\s]year\s+harvest/i;

/**
 * What is this sowing FOR? The season-length question is not "is it an annual" but "is the payoff
 * a harvest this season, or an overwintering crown". A Brussels sprout is biennial and you eat it
 * in year 1; a hollyhock is biennial and the payoff is next June. They need opposite clamps.
 */
export function sowGoal(candidate, dtm) {
  const effective = candidate.grown_as ?? candidate.lifecycle;
  if (effective === 'annual') return 'harvest';

  // BUG-SOWFIRSTYEAR-001: crop_types.first_year_harvest is authoritative when it has an opinion.
  // It sits ABOVE the dtm heuristic because it is a recorded fact and dtm is a proxy — a crop
  // explicitly marked first-year should not be re-litigated by its maturity figure.
  // Strict true/false checks, never truthiness: NULL means UNKNOWN and must fall through to the
  // heuristics below, not be read as false.
  if (candidate.first_year_harvest === true) return 'harvest';
  if (candidate.first_year_harvest === false) return 'establishment';

  if (dtm == null || dtm > DTM_NOT_A_MATURITY) return 'establishment';
  if (FIRST_YEAR_HARVEST_CROPS.has(candidate.crop_type_slug)) return 'harvest';
  if (HARVEST_TEXT_RE.test(candidate.direct_sow_timing || '')) return 'harvest';
  if (HARVEST_TEXT_RE.test(candidate.sow_notes || '')) return 'harvest';
  return 'establishment';
}

/**
 * latest-safe direct-sow close date (ms), or null when it is genuinely UNKNOWN.
 * harvest goal:       cool hardy FFobs-dtm | warm FF-dtm-14 | cool_warm FF-dtm-7 | cool FF+14-dtm
 * establishment goal: FF-35 regardless of dtm — nothing is maturing this year.
 *
 * FFobs is the MEASURED anchor and appears on exactly one branch; every other branch takes the
 * sowing-safety margin FF. See the two-anchor note at FROST_ANCHORS for which question each answers.
 * The establishment clamp deliberately stays on FF: its FALL_GROWTH_TAIL=35 was derived against the
 * margin (FF-35 = Aug 24) and is independently cross-checked by class H's Aug 15 close, so moving
 * the anchor under it without re-deriving the 35 would break a validated absolute date.
 *
 * BUG-SOWNONANNUAL-001: this used to `return null` for every non-annual, which left class-B windows
 * with NO season-length clamp so they closed at the raw ctx.FF — four cards read "Direct sow through
 * Sep 28" for biennials that will not flower until next year.
 * DO NOT "fix" that by deleting the lifecycle check. Hollyhock (dtm=300) would then take the
 * cool_warm branch to FF-307 = Nov 25 of the PREVIOUS year, open > close, and pushDirect's
 * annihilation guard would make the card VANISH SILENTLY — a worse bug than the wrong date, and it
 * takes marshmallow and blackberry lily with it.
 */
function latestSafeMs(candidate, dtm, ctx) {
  // Establishment does not consult dtm, so this must sit ABOVE the null guard or a null-dtm
  // perennial keeps its missing clamp. V4-HARDYSET-001 also moved it ABOVE the hardy branch, which
  // used to run first: on an establishment crop dtm is a days-to-BLOOM figure, so a grace computed
  // from it is a date derived from a number that is not a maturity (a hypothetical cool biennial
  // radicchio would have closed Jun 25 instead of Aug 24 — tighter, and for a nonsense reason).
  // Nothing live crossed that ordering under the prose test; a crop-type set is wider, so the order
  // is now load-bearing rather than incidental.
  if (sowGoal(candidate, dtm) === 'establishment') {
    return ctx.FF + (FALL_GROWTH_TAIL - ESTABLISH_DAYS - FALL_SLOWDOWN_DAYS) * DAY_MS;
  }
  if (dtm == null) return null; // genuinely unknown — must NOT be fabricated into a date
  const season = candidate.sow_season;
  // warm / cool_warm / cool-not-hardy all ask the SAME question — "will frost kill this before it
  // finishes?" — so all three keep ctx.FF, the sowing-safety margin. Wrong-early forfeits one
  // sowing; wrong-late loses the planting. That asymmetry is what the margin is for.
  if (season === 'warm') return ctx.FF - (dtm + 14) * DAY_MS;
  if (season === 'cool_warm') return ctx.FF - (dtm + 7) * DAY_MS;
  if (season === 'cool') {
    // BUG-FROSTANCHORWRONG-001. A FALL_HARDY_CROPS slug is by definition "unharmed or improved by
    // frost" (frostClass.js's hardy band — this set is its edible subset), so first frost is not the
    // thing that ends it and the safety margin has no job here. The question this branch actually
    // asks is "when does frost arrive", which is a measurement, so it consumes ctx.FFobs.
    // BUG-SOWHARDYANCHOR-001 — anchor moved FFobs -> GS (see HARDY_GROWTH_STOP_MONTH_DAY). The
    // sentence above already argued frost is not what ends a hardy crop; this stops contradicting it.
    // FALL_SLOWDOWN_DAYS IS NEW ON THIS BRANCH and is a defect fix in its own right: the fall INDOOR
    // pass has always spent it on the identical crop set, so the same packet's DTM was
    // slowdown-corrected on one path and raw on the other. Both hardy paths now aim maturity at GS and
    // differ ONLY by the nursery period, which is the whole of their real difference.
    if (FALL_HARDY_CROPS.has(candidate.crop_type_slug)) {
      return ctx.GS - (dtm + FALL_SLOWDOWN_DAYS) * DAY_MS;
    }
    return ctx.FF + (FALL_GRACE_COOL - dtm) * DAY_MS;
  }
  return null;
}

function methodIncludesIndoor(method) {
  return method === 'start_indoors' || method === 'both' || method === 'indoors_only';
}

function buildDirectWindows(candidate, dtm, ctx, gated = false) {
  const clauses = splitClauses(candidate.direct_sow_timing).map(classifyClause);
  // BUG-SOWPROSEUNREAD-001 — the packet SAID something about timing and we understood none of it.
  //
  // Measured on the ORIGINAL clause list rather than on `kept` below, and the distinction is the
  // whole point: `kept` is narrowed on purpose (the gated-allium filter drops classes deliberately),
  // and a deliberate drop is knowledge, not ignorance. This flag is only ever set when the
  // CLASSIFIER failed — every clause the packet carries came back `cls: null`.
  //
  // Live prod, 2026-09-02: 114 varieties carry direct-sow prose and NINE are read this way — Quincy,
  // Javelin, Common Milkweed, Long Island Improved, Red Mustard, Zebrune, Yellow Granex PRR,
  // Althaea officinalis, Column Blend. See bucketOne's exit for what it is used for.
  const unreadableProse = clauses.length > 0 && clauses.every((cl) => cl.cls == null);
  // Class K: zone-conditional — keep the 5b/6a clause, drop mild-climate ones.
  const hasZoneClause = clauses.some((cl) => cl.zone5b6a);
  let kept = hasZoneClause ? clauses.filter((cl) => !cl.mildClimates) : clauses;

  // Gated alliums keep ONLY their class-A spring window. The dropped clauses are exactly the paths
  // that surfaced a bulb onion in July: class C ("as soon as soil can be worked") runs open all the
  // way to latest_safe in August, and B/D/E/F/G/H open summer or fall windows a bulbing allium
  // cannot use. Dropping G/H here is also what enforces B1-over-A precedence — a gated bulber can
  // never surface a next-year window.
  if (gated) kept = kept.filter((cl) => cl.cls === 'A');

  const latestSafe = latestSafeMs(candidate, dtm, ctx);
  // Every establishment-class sow pays off next season, without exception — that is what makes it a
  // class. Tag the horizon so these route to the existing sow_next_year bucket, which already
  // labels them correctly, instead of sitting under a this-season heading.
  const establishing = sowGoal(candidate, dtm) === 'establishment';
  const windows = [];
  let anyJ = false;
  let neverTooLate = false;
  // Set when a clause was DROPPED because its season-length clamp is unknown (annual, no dtm).
  // bucketOne uses it to say "I don't know" instead of "too late" — see the note at case 'B'.
  let unknownClamp = false;
  const deferredD = [];

  for (const cl of kept) {
    let open = null;
    let close = null;
    let clamp = true;
    let horizon = establishing ? 'next_year' : 'this_season';
    switch (cl.cls) {
      case 'A':
        open = ctx.LF - cl.weeksMax * 7 * DAY_MS;
        close = ctx.LF - cl.weeksMin * 7 * DAY_MS;
        break;
      case 'B':
        open = ctx.LF + (cl.weeksMin ?? 0) * 7 * DAY_MS;
        // BUG-SOWNONANNUAL-001: was `latestSafe ?? ctx.FF`, which FABRICATED a close date out of
        // the frost anchor whenever the clamp was unknown — that fallback, not the lifecycle
        // check, is what actually printed "Direct sow through Sep 28". After the latestSafeMs
        // rewrite, null here means an annual with no dtm: genuinely unknown, so emit no window
        // rather than a confident wrong one.
        if (latestSafe == null) { unknownClamp = true; continue; }
        close = latestSafe;
        break;
      case 'M':
        // Class M takes class B's exact shape for a reason: the question "when is it too late to sow
        // this for a fall crop" is already answered by latestSafeMs, which counts back from the
        // frost anchor (or growth-stop, for a hardy slug) by dtm. So the CLOSE is that clamp,
        // unchanged, and the same null guard applies — a clause the engine cannot clamp emits no
        // window rather than a confident wrong one.
        //
        // THE OPEN IS THE ONE THING DAVE'S DECISION DID NOT SPECIFY. It names the latest sow date
        // and is silent on the earliest. 28 days is the fall INDOOR pass's existing lead (:836) —
        // reused rather than invented. The tempting alternative, class D's "open from the earliest
        // other window", was measured and REJECTED: for Red Mustard it yields Apr 8 – Aug 7, one
        // season-long band overlapping its own class-C spring window, which re-creates the exact
        // symptom BUG-SOWCLASSC-001 was filed to remove.
        if (latestSafe == null) { unknownClamp = true; continue; }
        open = latestSafe - 28 * DAY_MS;
        close = latestSafe;
        break;
      case 'C':
        // "As soon as the soil can be worked" — an EARLY-SPRING instruction, not a season-long
        // licence. BUG-SOWCLASSC-001: this used to close at `latestSafe`, the last date a sowing
        // could still beat frost to a harvest, which is a completely different question and is
        // months later. The visible symptom was spinach, peas and every other soil-workable cool
        // annual still advertising a direct-sow window in August and September — the engine saying
        // "you can still sow this" about a crop whose actual instruction expired in April.
        //
        // Closes at LF + 14d (Dave, 2026-09-01). Not LF exactly: peas and spinach are genuinely
        // sown right up to and a little past the last frost, so a hard cut at the frost date would
        // clip a sowing he would really make in a late-frost year. Not a fixed calendar date
        // either — that discards the year-to-year frost variation this engine anchors on
        // everywhere else.
        //
        // FALL SOWING IS NOT LOST HERE. Autumn crops are carried by their own clause classes
        // (B's post-frost window, F's explicit month windows, G's Sep 15 – Nov 15 overwinter
        // window). Class C never was the fall path; it only looked like one because its close date
        // was wrong.
        open = ctx.LF - 42 * DAY_MS;
        close = ctx.LF + 14 * DAY_MS;
        // No `latestSafe == null` bail any more, and that is a deliberate improvement rather than
        // a dropped guard: the guard existed only because `close` WAS latestSafe and would have
        // been null. The close is now derived from the frost anchor, which is always available, so
        // a cool annual with no days-to-maturity gets its real spring window instead of vanishing
        // into unknownClamp. pushDirect still clamps down to latestSafe when that is EARLIER
        // (:555), which is the only case where maturity should shorten a spring window.
        break;
      case 'D':
        deferredD.push(cl);
        continue;
      case 'E':
        open = ctx.FF - cl.weeksMax * 7 * DAY_MS;
        close = ctx.FF - cl.weeksMin * 7 * DAY_MS;
        break;
      case 'F':
        for (const [o, c2] of cl.monthWindows) {
          pushDirect(windows, cl, anchorToMs(o, ctx.year), anchorToMs(c2, ctx.year), latestSafe, true, ctx, 'this_season');
        }
        continue;
      case 'G': {
        // Fixed Sep 15 – Nov 15; hold before; NEVER too_late (rolls to next year).
        neverTooLate = true;
        let gOpen = anchorToMs('09-15', ctx.year);
        let gClose = anchorToMs('11-15', ctx.year);
        if (gClose < ctx.today) {
          gOpen = anchorToMs('09-15', ctx.year + 1);
          gClose = anchorToMs('11-15', ctx.year + 1);
        }
        open = gOpen;
        close = gClose;
        clamp = false;
        break;
      }
      case 'H':
        // Summer-sown for NEXT year's bloom — real, actionable, but not a this-season crop.
        open = anchorToMs('06-01', ctx.year);
        close = anchorToMs('08-15', ctx.year);
        clamp = false;
        horizon = 'next_year';
        break;
      case 'J':
        anyJ = true;
        continue;
      case 'L': // self-sows — ignore
      default:
        continue;
    }
    pushDirect(windows, cl, open, close, latestSafe, clamp, ctx, horizon);
  }

  // Class D (succession): open from the earliest other direct window (else
  // LF-42d) until latest_safe. Skipped when latest_safe is uncomputable.
  for (const cl of deferredD) {
    if (latestSafe == null) continue;
    const opens = windows.map((w) => w.open);
    const open = opens.length ? Math.min(...opens) : ctx.LF - 42 * DAY_MS;
    pushDirect(windows, cl, open, latestSafe, latestSafe, true, ctx, 'this_season');
  }

  return { windows, anyJ, neverTooLate, unknownClamp, unreadableProse };
}

function pushDirect(windows, cl, open, close, latestSafe, clamp, ctx, horizon = 'this_season') {
  // Class I soil-temp modifier clamps the open date, never extends the close.
  const floor = soilTempFloor(cl.soilTempF, ctx.year);
  if (floor != null && floor > open) open = floor;
  if (clamp && latestSafe != null && latestSafe < close) close = latestSafe;
  if (open > close) return; // annihilated window
  windows.push({
    open,
    close,
    action: 'direct_sow',
    cls: cl.cls,
    soilTempF: cl.soilTempF ?? null,
    horizon,
  });
}

function buildIndoorWindows(candidate, dtm, ctx, gated = false) {
  const windows = [];
  if (!methodIncludesIndoor(candidate.start_method)) return windows;
  let wMin = num(candidate.start_indoor_weeks_min);
  let wMax = num(candidate.start_indoor_weeks_max);
  wMin = wMin ?? wMax;
  wMax = wMax ?? wMin;
  if (wMax != null) {
    windows.push({
      open: ctx.LF - wMax * 7 * DAY_MS,
      close: ctx.LF - wMin * 7 * DAY_MS,
      action: 'start_indoors',
      cls: 'spring_indoor',
    });
  }
  // Gated alliums get NO fall indoor pass — it exists to squeeze in a fall crop, which a bulbing
  // allium cannot do. This is the second of the two windows that leaked Flat of Italy into July.
  if (gated) return windows;

  // Fall indoor pass: cool|cool_warm only; dtm null -> skip fall math.
  //
  // V4-MATURITYBASIS-001 Slice C — BASIS-AWARE.
  // `latest` is the last date seed may be STARTED INDOORS. Subtracting dtm straight off the frost
  // anchor assumes days_to_maturity counts from that indoor sow. For a crop whose catalogue DTM is
  // quoted FROM TRANSPLANT that is wrong by the entire nursery period (4–6 weeks across the live
  // fall candidates), because maturity is reached `nursery` days later than the math assumes:
  //     maturity      = indoorStart + nursery + dtm   must be <=  deadline - FALL_SLOWDOWN_DAYS
  //     => indoorStart <= deadline - FALL_SLOWDOWN_DAYS - dtm - nursery
  // i.e. the corrected latest-start is the existing one shifted back by the nursery period. The
  // `deadline` term is what V4-FALLINDOORHARDY-001 below splits in two (FF + grace, or FFobs); the
  // nursery shift is identical either way, which is why that split leaves this derivation intact.
  // Measured against live prod 2026-08-04: 14 fall brassica/lettuce windows the engine still showed
  // OPEN had in fact closed between 2026-06-23 and 2026-07-17. Telling the user to start fall
  // brassicas that cannot beat a Sep-28 frost is the failure this corrects.
  //
  // `wMax` (normalised above to start_indoor_weeks_max ?? _min) is the deliberate choice over wMin:
  // a LONGER nursery closes the window EARLIER, the conservative direction in a frost race.
  // from-sow and NULL (uncurated) shift by zero — byte-identical to the pre-basis behaviour, which
  // is what keeps this a provable no-op for direct-sow crops and for every uncurated crop type.
  // V4-FALLINDOORHARDY-001 — the follow-up BUG-FROSTANCHORWRONG-001 filed. This pass used to be keyed
  // by sow_season ALONE, so its `cool` bucket held kale (which stands frost) and the cool-but-tender
  // crops together on one anchor. It is now keyed by hardiness FIRST, exactly as latestSafeMs's cool
  // branch is: a FALL_HARDY_CROPS slug is "unharmed or improved by frost", so frost is not the event
  // that ends it and the sowing-safety margin has no job — the question is when frost ARRIVES, which
  // is a measurement (ctx.FFobs). Everything else keeps ctx.FF.
  //
  // THE GRACE GOES WITH THE ANCHOR, and dropping it is the point rather than an omission. `grace` on
  // the hardy arm was the SAME fabricated 28 that BUG-FROSTANCHORWRONG-001 deleted from the direct
  // branch (FALL_GRACE_HARDY was copied FROM FALL_GRACE_DAYS.cool); it looked right only because it
  // was cancelling an anchor 31 days early. Carrying it onto FFobs would aim maturity at Nov 26,
  // past the site's own 10-hour wall. So the hardy arm is FFobs - dtm - slowdown - nursery, which
  // moves the latest indoor start +3 days — the identical delta the direct branch took, from the
  // identical cause.
  //
  // SCOPED TO `cool`, not to the whole hardy set: latestSafeMs routes cool_warm to a strictly TIGHTER
  // margin (FF - dtm - 7) regardless of hardiness, and widening it here would make the indoor pass
  // more permissive than the direct one for the same packet. 4 live cool_warm candidates carry a
  // hardy slug (3 of them with an indoor method); they keep the margin.
  //
  // FALL_SLOWDOWN_DAYS STAYS ON BOTH ARMS. It corrects the DTM for shortening days, not the anchor
  // for frost — a different quantity from the grace, and hardiness says nothing about it.
  const grace = FALL_GRACE_DAYS[candidate.sow_season];
  if (grace != null && dtm != null) {
    const fromTransplant = candidate.dtm_basis === DTM_BASIS_TRANSPLANT;
    // A from-transplant crop with NO nursery estimate has an uncomputable latest-start. Emitting
    // the uncorrected date would be a confidently wrong OPEN in exactly the race this pass exists
    // to stop, so emit nothing instead — the same rule latestSafeMs applies to a null dtm
    // ("genuinely unknown — must NOT be fabricated into a date"). Unreachable in prod today:
    // all 28 fall-eligible from-transplant candidates carry indoor weeks (checked 2026-08-04).
    if (fromTransplant && wMax == null) return windows;
    const nurseryDays = fromTransplant ? wMax * 7 : 0;
    // The V4-MATURITYBASIS-001 nursery term is subtracted IDENTICALLY on both arms and is unchanged
    // by this item: it shifts `latest` back by the nursery period whichever anchor `latest` is
    // measured from. Re-deriving it gets EASIER, not harder — the 20 from-transplant hardy cool
    // candidates it most affects now sit on the measured anchor, so a refit measures the nursery gap
    // instead of absorbing 31 days of anchor error into it.
    const fallHardy = candidate.sow_season === 'cool' && FALL_HARDY_CROPS.has(candidate.crop_type_slug);
    // BUG-SOWHARDYANCHOR-001 — anchor moved FFobs -> GS, matching latestSafeMs's hardy branch. The
    // FALL_SLOWDOWN_DAYS and nursery terms are UNCHANGED; only the anchor moves, so this arm and the
    // direct one now derive from one statement (mature by growth-stop) instead of two.
    const latest = fallHardy
      ? ctx.GS - (dtm + FALL_SLOWDOWN_DAYS + nurseryDays) * DAY_MS
      : ctx.FF + (grace - dtm - FALL_SLOWDOWN_DAYS - nurseryDays) * DAY_MS;
    windows.push({
      open: latest - 28 * DAY_MS,
      close: latest,
      action: 'start_indoors',
      cls: 'fall_indoor',
    });
  }
  return windows;
}

function actionPhrase(action) {
  return action === 'start_indoors' ? 'Start indoors' : 'Direct sow';
}

function bucketOne(candidate, ctx) {
  if (!candidate.start_method && !candidate.direct_sow_timing) {
    return {
      bucket: 'needs_profile',
      entry: { candidate, action: null, windowLabel: 'No sow profile yet' },
    };
  }

  const dtm = num(candidate.days_to_maturity_max) ?? num(candidate.days_to_maturity_min);
  const gated = isSpringEstablishmentAllium(candidate);
  const gateFields = gated
    ? { gated: true, gateReason: GATE_REASONS[candidate.crop_type_slug] ?? GATE_REASONS.onion }
    : null;
  const indoorWindows = buildIndoorWindows(candidate, dtm, ctx, gated);
  const { windows: directWindows, anyJ, neverTooLate, unknownClamp, unreadableProse } =
    buildDirectWindows(candidate, dtm, ctx, gated);
  const all = [...indoorWindows, ...directWindows];

  // BUG-SOWNONANNUAL-001: `unknownClamp` is carried down to the too_late exit at the bottom of this
  // function rather than being handled here, because a packet can have OTHER windows (a closed
  // indoor pass) that make `all` non-empty while its DIRECT window is still unknown.

  const isOpen = (w) => w.open <= ctx.today && ctx.today <= w.close;
  // Horizon partition runs BEFORE any close/daysLeft/label math, so a next-year window can never
  // mislabel a this-season card. Indoor windows are always this-season.
  const isThisSeason = (w) => (w.horizon ?? 'this_season') === 'this_season';
  const openIndoor = indoorWindows.filter(isOpen);
  const openDirect = directWindows.filter((w) => isOpen(w) && isThisSeason(w));
  const openNextYear = directWindows.filter((w) => isOpen(w) && !isThisSeason(w));

  if (openIndoor.length || openDirect.length) {
    const primary = openIndoor.length ? openIndoor : openDirect;
    const action = openIndoor.length ? 'start_indoors' : 'direct_sow';
    const close = Math.max(...primary.map((w) => w.close));
    const daysLeft = Math.round((close - ctx.today) / DAY_MS);
    let windowLabel = `${actionPhrase(action)} through ${labelDate(close)}`;
    if (openIndoor.length && openDirect.length) windowLabel += ' · also direct-sowable';
    // The horizon partition routes this card by its this-season window, so an open next-year
    // window would otherwise vanish from the page entirely. Keep it visible as a hint.
    if (openNextYear.length) windowLabel += ' · also sowable now for next year';
    const soil = primary.find((w) => w.soilTempF != null);
    if (soil) windowLabel += ` · soil ≥${soil.soilTempF}°F`;
    const bucket = daysLeft <= ctx.closingDays
      ? 'window_closing'
      : (action === 'start_indoors' ? 'start_indoors_now' : 'direct_sow_now');
    return { bucket, entry: { candidate, action, daysLeft, windowLabel } };
  }

  // A — next-year horizon. Only reachable when NO this-season window is open, so this never
  // outranks a live this-season sowing. Gated alliums cannot land here (B1 drops their G/H clauses).
  // Deliberately NOT escalated to `window_closing` near the close: that bucket is labelled as
  // this-season work, and mislabelling the horizon is worse than a muted heading. Urgency still
  // reaches the user — the card carries the same red "N days left" badge.
  if (openNextYear.length) {
    const close = Math.max(...openNextYear.map((w) => w.close));
    const daysLeft = Math.round((close - ctx.today) / DAY_MS);
    return {
      bucket: 'sow_next_year',
      entry: {
        candidate,
        action: 'direct_sow',
        daysLeft,
        // "· flowers next year" until 2026-08-17. The bucket is a HORIZON partition, not a flower
        // section — its members are whatever sowGoal() calls establishment, and that already covers
        // biennial vegetables and (once an overwintering goal exists) hardy greens carried under
        // cover for a spring cut. sowGoal cannot tell a hollyhock from an overwintered kale, so the
        // phrase must be true of both rather than derived: what they share is WHEN the sowing pays
        // off, which is the one thing this bucket actually knows.
        windowLabel: `Direct sow through ${labelDate(close)} · pays off next spring`,
      },
    };
  }

  // Indoor-only / class J overlay: always sowable inside when no actionable
  // outdoor/indoor-calendar window is open. Gated alliums are EXCLUDED — this branch returns an
  // actionable bucket, so without the guard an `indoors_only` bulb onion would still be offered
  // in July, straight past the gate. (`anyJ` cannot fire for a gated candidate: gating filters
  // clauses to class A, so no class-J clause survives. The `start_method` half is the real hole.)
  if ((candidate.start_method === 'indoors_only' && !gated) || anyJ) {
    return {
      bucket: 'sow_inside_anytime',
      entry: { candidate, action: 'sow_inside', windowLabel: 'Grow indoors year-round' },
    };
  }

  // Ordinary hold: a window is still ahead THIS year, so nothing is being suppressed — deliberately
  // NO gateFields here. Attaching them made a gated onion in March read "a summer sowing will not
  // size a bulb… start indoors in late winter" next to a direct-sow window opening in 27 days.
  // gateReason means "the gate removed something", and it must appear only when that is true.
  const future = all.filter((w) => w.open > ctx.today).sort((a, b) => a.open - b.open);
  if (future.length) {
    const next = future[0];
    return {
      bucket: 'hold',
      entry: {
        candidate,
        action: next.action,
        reopensOn: msToISO(next.open),
        windowLabel: `Opens ${labelDateAcrossYears(next.open, ctx.year)} · ${actionPhrase(next.action).toLowerCase()}`,
      },
    };
  }

  // Gated allium past its spring window: rebuild its windows against NEXT year's anchors so it lands
  // in `hold` (future-actionable, reopening at the indoor start) instead of `too_late` (a dead end).
  // Rebuilt rather than +365d-shifted so the roll stays correct across leap years.
  if (gated) {
    const nextCtx = {
      ...ctx,
      year: ctx.year + 1,
      LF: anchorToMs(ctx.lastSpringFrost, ctx.year + 1),
      FF: anchorToMs(ctx.firstFallFrost, ctx.year + 1),
      FFobs: anchorToMs(ctx.observedFirstFallFrost, ctx.year + 1),
    };
    const rolled = [
      ...buildIndoorWindows(candidate, dtm, nextCtx, true),
      ...buildDirectWindows(candidate, dtm, nextCtx, true).windows,
    ].sort((a, b) => a.open - b.open);
    if (rolled.length) {
      const next = rolled[0];
      return {
        bucket: 'hold',
        entry: {
          candidate,
          action: next.action,
          reopensOn: msToISO(next.open),
          ...gateFields,
          windowLabel: `Opens ${labelDateAcrossYears(next.open, ctx.year)} · ${actionPhrase(next.action).toLowerCase()}`,
        },
      };
    }
    // Nothing rebuildable (no class-A clause AND no indoor weeks — e.g. a C-only onion profile).
    // Still `hold`, never `too_late`: too_late is a collapsed dead end with no reason line and no
    // "Sow anyway" override, so a gated card landing there would be silently suppressed with no
    // explanation and no recourse — the one outcome the gate's design explicitly forbids.
    return {
      bucket: 'hold',
      entry: {
        candidate,
        action: null,
        ...gateFields,
        windowLabel: 'Held until its spring window',
      },
    };
  }

  // Class G guarantees a future window (rolls to next year), so a G candidate
  // never lands here; belt-and-suspenders in case of custom anchors.
  if (neverTooLate) {
    const open = anchorToMs('09-15', ctx.year + 1);
    return {
      bucket: 'hold',
      entry: {
        candidate,
        action: 'direct_sow',
        reopensOn: msToISO(open),
        windowLabel: `Opens ${labelDateAcrossYears(open, ctx.year)} · direct sow`,
      },
    };
  }

  // BUG-SOWNONANNUAL-001. Do not trade one confident-wrong claim for another. These packets used to
  // read "Direct sow through Sep 28" — a date fabricated from the frost anchor by `latestSafe ??
  // ctx.FF`. Removing that fallback correctly stops the lie, but letting them fall through to
  // too_late asserts "Sowing window passed for 2026", which we also do not know: their direct-sow
  // clause was DROPPED for want of a days-to-maturity, so the window we cannot compute might well
  // still be open. Five live packets hit this, four of them with a merely-closed INDOOR pass making
  // `all` non-empty — French marigold among them, which direct-sown in late July still blooms
  // before frost in 5b. NULL means UNKNOWN, and UNKNOWN must never fire as fact in EITHER
  // direction. needs_profile is the bucket that says so and names the fix.
  if (unknownClamp) {
    return {
      bucket: 'needs_profile',
      entry: { candidate, action: null, windowLabel: 'Add days to maturity to place this' },
    };
  }

  // BUG-SOWPROSEUNREAD-001 — the SAME rule as unknownClamp above, applied to the other way this
  // engine can be ignorant. There the clause was understood and its clamp was missing; here the
  // clause was never understood at all, and falling through asserts "Sowing window passed" about
  // timing nobody read.
  //
  // MEASURED, and it is not a near-miss: Quincy's packet says "Zone 5b: late May to mid-June" and
  // this exit filed it under "Too late this year" on every date tested across the whole season —
  // 1 March included. A claim that is wrong in March is not a timing verdict, it is a fallthrough
  // wearing one. Nine live varieties sit here.
  //
  // Placed AFTER unknownClamp deliberately: that branch names a specific, actionable fix ("add days
  // to maturity"), and a packet can be in both states. The more specific instruction wins.
  //
  // The label does not pretend to a verdict and does not blame the packet — the prose is usually
  // perfectly clear to a human, which is why SowNow renders it verbatim underneath (`sow-prose`).
  if (unreadableProse) {
    return {
      bucket: 'needs_profile',
      entry: { candidate, action: null, windowLabel: "Couldn't read this packet's sow timing" },
    };
  }

  return {
    bucket: 'too_late',
    entry: { candidate, action: null, windowLabel: `Sowing window passed for ${ctx.year}` },
  };
}

/**
 * V4-SOWARCHIVE-001. Is this packet archived out of the ACTIVE buckets for `year`?
 *
 * Expiry is a property of this read, not of a job: the stamp is a season, so once `year` moves on
 * the equality stops holding and the packet returns to its normal bucket by itself. Nothing has to
 * run on 1 Jan, and nothing stays hidden because a cron failed.
 *
 * Number()-coerced because view columns can arrive as strings from the neon driver (same defence
 * depthSpacingLine already applies to sow_depth_in). An unparseable or absent stamp is NOT archived
 * — the safe direction, since the failure it guards against is a packet silently vanishing from the
 * list. That also makes the pre-migration view (no such column -> undefined) behave exactly as today.
 */
export function isArchivedForSeason(candidate, year) {
  const raw = candidate?.sow_archived_season;
  if (raw == null || raw === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n === year;
}

/**
 * V4-SEEDZEROVIEW-001. Is this packet used up — nothing left to sow?
 *
 * Dave: "I want to keep zero counts in our records, viewable as 'sowed previously' so i can review,
 * but I don't want a real 'reorder if...' logic in here. Won't use it, just need to know what I've
 * had, how much I have now, and all the details even if zero — zero counts can be filtered out of
 * sow now and other used surfaces, but a view/filter of them would be useful." So this DIVERTS a
 * depleted packet exactly as isArchivedForSeason does. There is deliberately no threshold, no
 * reorder quantity and no restock cue, and nothing here deletes, retires or re-decides a packet:
 * the row keeps arriving from v_sow_candidates with every column intact, which is what makes the
 * review section possible at all.
 *
 * Filtering lives HERE and not in the view or the route, for two independent reasons. The rows are
 * needed client-side for the review section. And five gates across three migrations pin
 * v_sow_candidates's rowcount to its unfiltered base join (v4-sowfirstyear-001 gates.yml:28,:73;
 * v4-sowarchive-001 :37,:114; v4-maturitybasis-001 :116) — none carries `continuous:`, which
 * defaults TRUE, so a server-side predicate would go red on prod AND staging on the next
 * migrations/** push.
 *
 * NULL IS SOWABLE, AND THAT IS THE WHOLE DECISION HERE. quantity_on_hand is nullable with no column
 * default, so NULL means "not tracked" — which is NOT "used up". This deliberately differs from
 * InventoryDetail.jsx:253's `Number(item.quantity_on_hand ?? 0) > 0`, which collapses NULL into
 * "hide". That collapse is right there — a plant-from-THIS-packet CTA needs stock actually in hand —
 * and wrong here, on a PLANNING surface, where hiding an uncounted packet is the wrong-late
 * direction: it forfeits a sowing silently, and sowEngine's own asymmetry note applies (wrong-early
 * forfeits one sowing; wrong-late loses the planting). Zero seed rows are NULL today (measured on
 * prod 2026-08-28: 259 candidates — 257 positive, 1 fractional at 0.5, 1 zero, 0 NULL), so the
 * difference is currently unobservable, which is exactly why it is pinned by test rather than left
 * for the first NULL packet to settle it silently.
 *
 * Number()-coerced for the neon driver's string numerics, same as isArchivedForSeason. Absent,
 * empty or unparseable reads as NOT depleted — the safe direction, since the failure being guarded
 * against is a packet vanishing off the working list. Note the `== null || === ''` guard is
 * load-bearing rather than defensive tidiness: Number(null) and Number('') are both 0, so without it
 * every untracked packet would read as depleted.
 */
export function isDepleted(candidate) {
  const raw = candidate?.quantity_on_hand;
  if (raw == null || raw === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n <= 0;
}

/**
 * The seed_stage values that mean the lot is not seed yet. The DB vocabulary is
 * `fermenting | drying | stored | NULL` (inventory_items_seed_stage_check, migrations/
 * v4-seedsaveflow-001/0a-ddl.sql:42-55); `stored` is terminal and IS sowable, so this is that
 * vocabulary minus its endpoint rather than a set invented here.
 */
export const IN_PROCESS_STAGES = Object.freeze(['fermenting', 'drying']);

/**
 * V4-SEEDSAVEFLOW-001 (BD-071). Is this lot still being PROCESSED — seed that physically is not yet
 * seed anyone can sow?
 *
 * THE FILED DEFECT, measured rather than reasoned: v_sow_candidates selects on
 * `category='seeds' AND deleted_at IS NULL AND status='active'` plus a live variety_id and says
 * nothing about seed_stage. A lot inserted at `seed_stage='fermenting'` — wet tomato seed sitting in
 * its own pulp in a jar — came straight back out of the view on a real Neon branch (2026-09-02) and
 * was offered by Sow Now identically to a finished packet. The same gap runs the other way:
 * advancing a lot to `stored` granted it nothing, because sowability was fixed by those four
 * columns before the lot was ever staged. That is the "→ a SOWABLE seed inventory item" link BD-071
 * asks for, and it did not exist.
 *
 * DIVERTS rather than filters, exactly as isDepleted and isArchivedForSeason do, and here it is
 * Dave's explicit call: an in-process lot STAYS on /sow, marked with the stage it is in. He wants to
 * keep seeing that the seed exists and is coming while being unable to mis-sow it. The row keeps
 * arriving from the view with every column intact; bucketize moves it to `in_process` and the card
 * names the stage.
 *
 * Filtering lives HERE and not in the view for the hard reason isDepleted records above: five
 * continuous gates across three migrations pin v_sow_candidates's rowcount to its unfiltered base
 * join, so a server-side predicate reds prod AND staging on the next migrations/** push. The
 * companion migration APPENDS seed_stage/seed_process to the projection — a column append, which
 * those gates do not measure.
 *
 * NULL IS SOWABLE — same conclusion as isDepleted's NULL decision, reached from the opposite
 * direction. There NULL was RARE ("nobody counted this"; 0 of 259 prod candidates) and the argument
 * had to be made on cost asymmetry alone. Here NULL is the NORMAL state: seed_stage is nullable with
 * no default and is only ever set on a lot somebody deliberately tracked, so every packet ever bought
 * is NULL — measured 2026-09-03, 313 of 316 live seed lots. NULL means "never tracked", which is not
 * "unfinished", and treating it as in-process would divert the entire sow list into "not ready yet",
 * the wrong-late direction at full scale.
 *
 * CORRECTED 2026-09-03 (BUG-SEEDSTAGEHEADSHIP-001). This paragraph used to say seed_stage "is written
 * only by POST /seed-stage" and called that structural. It is not true and had not been true since
 * V4-SEEDHISTORY-001: there are THREE writers — the /seed-stage CTE (lambda/inventory-items/index.js
 * :447-466), the wide PUT's presence-guarded arm (:858-860, which InventoryDetail's stage control
 * drives), and the create INSERT (:1075-1090). Only the first appends to seed_lot_stage_log. The
 * CONCLUSION above survives — a bought packet is still never staged by any of the three — but the
 * ground it stood on did not, and an assumption that lives in a comment is invisible to CI when a
 * second writer arrives. Stated as a measurement now rather than as an architectural guarantee.
 *
 * seed_process (`wet | dry`) is deliberately NOT read: it says HOW a lot is being processed, never
 * WHETHER it still is. Stage alone decides. Trimmed/lower-cased before the membership test and
 * anything unrecognized reads as NOT in process — the same safe direction both neighbours take, and
 * it is what makes the pre-migration view (no such column -> undefined) behave exactly as today.
 */
export function isInProcess(candidate) {
  const raw = candidate?.seed_stage;
  if (raw == null || raw === '') return false;
  return IN_PROCESS_STAGES.includes(String(raw).trim().toLowerCase());
}

/**
 * BUG-SEEDZEROSOWABLE-001 — a lot you saved yourself and have not started processing.
 *
 * THE DEFECT, and it fires at the moment of saving. "Save seed" creates the lot at
 * quantity_on_hand 0 (the seed is wet and uncounted; the CHECK refuses NULL for a consumable) and
 * the process control defaults to "Not yet — just save the lot", which writes no seed_stage on
 * purpose so that no false ferment lands in seed_lot_stage_log. So the row is (qty 0, stage NULL):
 * isInProcess is false, isDepleted(0) is TRUE, and Sow Now files a lot saved five seconds ago under
 * "Sowed previously — none of these left". It has not been sown. It is being made.
 *
 * Dave 2026-09-02, choosing between three options: it belongs in "Still in process", marked "Not
 * started yet". Which is what the row actually says — the user told the app the process has not
 * begun, and that stays true however the count later moves.
 *
 * WHY IT NEEDS source_plant_id AND WHY THAT COST A MIGRATION. "stage NULL and qty 0" is NOT unique
 * to a just-saved lot: a purchased packet used down to zero is byte-identical on the row, and all
 * 260 live seed packets have seed_stage NULL because only home-saved lots are ever staged. Measured
 * on prod 2026-09-02, exactly one active row was (stage NULL, qty 0) and it was an empty bought
 * packet — one row today, but the population grows on both sides from here. source_plant_id is the
 * fact that separates them, SaveSeedSheet sends it on every create, and v4-sowprovenance-001 appends
 * it to v_sow_candidates for this. `own_garden` is the second arm for the lot whose origin is
 * recorded on the lot page afterwards rather than at creation, which source_plant_id does not reach.
 *
 * GATED ON isDepleted, so this only ever re-homes a lot that would otherwise read as empty. A saved
 * lot with a real count is sowable and belongs in its timing bucket, untouched.
 *
 * READS PROVENANCE, WHICH isInProcess DELIBERATELY DOES NOT — the two are separate functions for
 * that reason rather than one widened predicate. isInProcess answers "is this seed physically not
 * seed yet", from seed_stage alone; this answers "did its owner make it and never start", which is
 * a different question with a different consequence downstream: SowNow withholds `Sow anyway` for
 * the first and keeps it for the second (an unstarted lot may be perfectly dry — nobody said
 * otherwise — whereas a fermenting one is in a jar of pulp).
 *
 * Absent columns read as false, so this is inert on an environment where the view has not been
 * widened: the lot falls back to `sowed_previously`, which is the pre-fix behaviour rather than a
 * new failure. That is what makes the migration and the code independently deployable.
 */
export function isUnstartedSave(candidate) {
  const fromPlant = candidate?.source_plant_id;
  const kind = candidate?.source_kind;
  const ownSeed = (fromPlant != null && fromPlant !== '')
    || (kind != null && String(kind).trim().toLowerCase() === 'own_garden');
  if (!ownSeed) return false;
  const stage = candidate?.seed_stage;
  // Any stage at all means the process was started — including `stored`, where a 0 is now an
  // explicitly answered count (SavedSeeds.jsx parseCountInput) and depletion is the right reading.
  if (stage != null && stage !== '') return false;
  return isDepleted(candidate);
}

/**
 * Bucket v_sow_candidates rows for a given day.
 * @param {Array<object>} candidates v_sow_candidates-shaped rows
 * @param {string} todayISO 'YYYY-MM-DD'; anchors resolve against its year
 * @param {object} [anchors] partial FROST_ANCHORS override
 * @returns {{start_indoors_now:[], direct_sow_now:[], sow_inside_anytime:[],
 *   sow_next_year:[], window_closing:[], hold:[], too_late:[], needs_profile:[],
 *   sowed_previously:[], archived:[], in_process:[]}}
 */
export function bucketize(candidates, todayISO, anchors = {}) {
  const cfg = {
    ...FROST_ANCHORS,
    observedFirstFallFrost: OBSERVED_FIRST_FALL_FROST.medianMonthDay,
    hardyGrowthStop: HARDY_GROWTH_STOP_MONTH_DAY,
    ...anchors,
  };
  const today = isoToMs(todayISO);
  const year = new Date(today).getUTCFullYear();
  const ctx = {
    today,
    year,
    LF: anchorToMs(cfg.lastSpringFrost, year),
    FF: anchorToMs(cfg.firstFallFrost, year),
    // The MEASURED anchor, carried alongside FF rather than replacing it — see the two-anchor note
    // at FROST_ANCHORS. Overridable on the same `anchors` argument so a test (or a second site) can
    // move it, and so an override of `firstFallFrost` provably does NOT move the hardy branch.
    FFobs: anchorToMs(cfg.observedFirstFallFrost, year),
    // BUG-SOWHARDYANCHOR-001 — the growth-stop anchor the two FALL_HARDY_CROPS branches consume.
    // A THIRD anchor deliberately, not a replacement: FF answers "will frost kill this", FFobs
    // answers "when does frost arrive", and GS answers "when does growth stop" — the only one of the
    // three that bounds a crop frost does not kill. Overridable on the same `anchors` argument, so a
    // test can prove an override of either frost anchor does NOT move the hardy branches.
    GS: anchorToMs(cfg.hardyGrowthStop, year),
    closingDays: cfg.windowClosingDays,
    // mm-dd anchors kept on ctx so the gated-allium hold can rebuild windows against year+1.
    lastSpringFrost: cfg.lastSpringFrost,
    firstFallFrost: cfg.firstFallFrost,
    observedFirstFallFrost: cfg.observedFirstFallFrost,
    hardyGrowthStop: cfg.hardyGrowthStop,
  };
  // EVERY bucket key bucketOne can return MUST appear here — `buckets[bucket].push(entry)` below
  // throws on a missing key, which propagates out of the SowNow useMemo and white-screens /sow.
  const buckets = {
    start_indoors_now: [],
    direct_sow_now: [],
    sow_inside_anytime: [],
    sow_next_year: [],
    window_closing: [],
    hold: [],
    too_late: [],
    needs_profile: [],
    // V4-SEEDZEROVIEW-001 (10th) and archived (9th) are DIVERT targets, not verdicts — bucketOne
    // never returns either. They are seeded here for the same reason as the rest: a missing key
    // makes the push below throw. `in_process` (11th, V4-SEEDSAVEFLOW-001) is the third of them.
    sowed_previously: [],
    archived: [],
    in_process: [],
  };
  for (const candidate of candidates || []) {
    // bucketOne runs FIRST even for archived packets, and the bucket it chose rides along as
    // `archivedFrom`. Two reasons: the archived card keeps its real window label instead of going
    // blank, and un-archiving is a pure re-read — the entry it returns to is already computed, so
    // the two paths cannot drift into disagreeing about where a packet belongs.
    const { bucket, entry } = bucketOne(candidate, ctx);
    // V4-SEEDZEROVIEW-001 — same divert-don't-re-decide shape, and it composes with archive rather
    // than racing it: depletion decides the packet's HOME bucket, archive then diverts it out of
    // that home. So a packet that is both reads "From: Sowed previously" and, un-archived, returns
    // to the review section instead of to a working list it has no seed for. Doing it the other way
    // round would make an un-archive re-offer an empty packet.
    //
    // V4-SEEDSAVEFLOW-001 — the third divert, and it is resolved AHEAD of depletion rather than
    // beside it. A lot still fermenting has no meaningful count yet (the number is taken when the
    // seed is dry and packeted), so a wet lot at 0/NULL diverted to `sowed_previously` would assert
    // a sowing that never happened — it has not been sown, it is being made. The physical state of
    // the seed wins; depletion decides among the rest; archive still diverts out of whichever home
    // those two chose. Written as a chain rather than a nested ternary because each arm now has to
    // stamp its own provenance key, which is what the card reads back as "From: …".
    //
    // BUG-SEEDZEROSOWABLE-001 adds a SECOND arm to that same divert, ahead of depletion for the
    // identical reason: a lot its owner saved and has not started processing is not a packet that
    // was sown, it is one that is being made. It carries `unstartedSave` so the card can label it
    // "Not started yet" rather than naming a stage it does not have, and so SowNow can keep the
    // `Sow anyway` override that a genuinely fermenting lot is denied.
    let home = bucket;
    let homeEntry = entry;
    if (isInProcess(candidate)) {
      home = 'in_process';
      homeEntry = { ...entry, inProcessFrom: bucket };
    } else if (isUnstartedSave(candidate)) {
      home = 'in_process';
      homeEntry = { ...entry, inProcessFrom: bucket, unstartedSave: true };
    } else if (isDepleted(candidate)) {
      home = 'sowed_previously';
      homeEntry = { ...entry, depletedFrom: bucket };
    }
    if (isArchivedForSeason(candidate, year)) {
      buckets.archived.push({ ...homeEntry, archivedFrom: home });
    } else {
      buckets[home].push(homeEntry);
    }
  }
  return buckets;
}
