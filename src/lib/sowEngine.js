// src/lib/sowEngine.js — bucketing engine for the /sow page. Pure ESM, zero dependencies, UTC-safe
// date math.
//
// bucketize(candidates, todayISO, anchors?) sorts v_sow_candidates rows into action buckets. Numeric
// candidate fields may arrive as strings (neon driver), so everything is Number()-coerced here.

// The DTM basis vocabulary is single-sourced from the maturity engine: a local copy of the two
// CHECK-constrained strings could silently drift from the DB. The import graph must stay acyclic
// (sowEngine -> plantingMaturity -> maturityCalibration), so keep maturityCalibration.js
// dependency-free.
import { DTM_BASIS_TRANSPLANT } from './plantingMaturity.js';

// ── The two frost anchors, and which question each one answers ───────────────────
//   FROST_ANCHORS.firstFallFrost ('09-28')  = a CONSERVATIVE SOWING-SAFETY MARGIN.
//   OBSERVED_FIRST_FALL_FROST               = the MEASURED frost distribution at this site.
//
// They are 17 days apart at the median and that gap is deliberate: '09-28' is the date past which a
// sowing decision should stop assuming it has a season, and being early costs one forfeited sowing
// while being late costs the whole planting. It is not a claim that frost arrives on 09-28 (1 of the 11
// measured seasons had its first <=32F night earlier). Do not re-derive the margin from the
// measurement: loading the correction into it is the two-anchor conflation this block exists to
// prevent. sowEngine.test.js pins the margin's exposure (seasons earlier than it) as a number.
//
// THE RULE: a consumer asking "is it too late to START something that frost will kill?" takes
// FROST_ANCHORS. A consumer asking "when will frost actually happen?" takes
// OBSERVED_FIRST_FALL_FROST. Consuming the margin as a date compounds two conservatisms and comes out
// wrong-early by a month with no line of code that says so (storageDeadlines.json's
// `frost_anchor_warning` records one such case).
export const FROST_ANCHORS = Object.freeze({
  lastSpringFrost: '05-20',
  firstFallFrost: '09-28',
  windowClosingDays: 10,
});

// The measured first-fall-frost distribution at THIS site. Same measurement, field names and
// executable `query` as src/data/storageDeadlines.json's sweet_potato `measured_basis`; sowEngine.test.js
// pins the two deep-equal so one site cannot carry two frost records, and recomputes
// earliest/median/latest from `first_frost_by_year` so a stat edited without its data fails.
//
// This is a DISTRIBUTION, not a date. `medianMonthDay` is the central estimate to aim at;
// `earliestMonthDay` is the backstop for a year nobody watched the forecast; `latestMonthDay` bounds
// the tail. None is a forecast, and the forecast path (lambda/daily-plan/frostClass.js) beats all of
// them when it exists.
//
// The source is a station composite, not reanalysis: a ~9km reanalysis grid cell misses most real
// radiational frost nights and runs warm on sub-32F minima.
//
// WHY 10-15 AND NOT 10-10: read this before "fixing" one to match the other. Both are right and
// answer different questions. 10-15 is the 3-station composite over 11 seasons (2015-2025); 10-10 is
// the same composite over 34 seasons (1991-2025). Widening the window is a separate, deliberate
// decision, not a reconciliation of two numbers that disagree.
//
// `latestMonthDay` has a frozen copy: migrations/v4-anchorbase-001/0b-backfill.sql is applied and
// hardcodes the older latest ('11-08'). Do not update it; lambda/anchor-plausibility-frost.test.js
// says why its pin there is historical rather than live.
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
 * What ends a FALL_HARDY_CROPS sowing. NOT a frost date: a hardy slug is by definition "unharmed or
 * improved by frost", so first frost cannot end it. The real limit is the 10-hour daylength
 * ("Persephone") wall, below which cool-season growth effectively stops: a crop that is MATURE by then
 * holds in the field and can be picked through winter; one that is not sits undersized until spring.
 *
 * The margin is ZERO at the anchor on purpose: the target IS the wall, and no new constant is
 * introduced (a margin with no site experience behind it would be a guess). The slow-growth allowance
 * rides on the DTM via FALL_SLOWDOWN_DAYS, which is how the fall indoor pass already spends it.
 *
 * RESTATED, NOT IMPORTED: src/lib may not import a Lambda, so this duplicates
 * lambda/daily-plan/overwinter.js's persephoneDates(SITE_LAT); sowEngine.test.js pins the two in
 * lockstep. The value is solar, so it does not drift year to year. This is a model, not a
 * measurement: revisit after a season of on-site observation.
 */
export const HARDY_GROWTH_STOP_MONTH_DAY = '11-07';

/**
 * Fall indoor-pass grace days by season (warm gets no fall pass). FALL_HARDY_CROPS take the
 * growth-stop anchor with no grace, so `cool` applies only to cool-season crops that frost KILLS.
 * 28 days past the sowing-safety margin (Oct 26) is loose for them: it falls 11 days AFTER the median
 * first frost, aiming a frost-killed crop's maturity past the date frost typically arrives. The honest
 * value is probably FALL_GRACE_COOL's 14, matching the direct-sow branch; changing it is a calibration
 * decision with no measurement behind it yet.
 */
export const FALL_GRACE_DAYS = Object.freeze({ cool: 28, cool_warm: 14 });

// ── Allium viability gate ─────────────────────────────────────────────────────────
// Bulb-forming alliums are SPRING-ESTABLISHMENT crops: a summer sowing cannot size a bulb before
// frost, and a seedling that overwintered would vernalize and bolt instead of bulbing. Both failure
// modes point the same way, so these are held for spring rather than offered in July.
//
// POLARITY IS DELIBERATE AND CORRECTNESS-CRITICAL: gate UNLESS confirmed bunching, never "gate if
// confirmed bulbing". growth_habit is free-text prose and the affirmative bulbing patterns miss real
// bulbing rows (their prose matches no bulbing pattern), while bunching onions match 'non-bulbing'
// cleanly. An affirmative predicate would leave bulbing onions ungated.
//
// garlic is deliberately NOT gated: it is fall-planted and needs vernalization, so a spring-only gate
// would be horticulturally wrong. Its 240-270d maturity math buckets it correctly without the gate.
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

// ── Fall hardiness ───────────────────────────────────────────────────────────────
// Which cool-season crops are anchored to growth-stop rather than to the sowing-safety margin, decided
// by crop_type_slug instead of packet prose. Prose matching was a lottery on the seedsman's
// copywriter: it caught radish while missing spinach, lettuce, kale, mustard, arugula, chard and leek,
// and two packets of the SAME SPECIES disagreed.
//
// THE RULE THE SET ENCODES: the harvested organ (leaf, root, stem, bud) keeps standing, or improves,
// through repeated fall frost, so growth past the frost anchor is still a harvest. That is the
// question lambda/daily-plan/frostClass.js's `hardy` band already answers ("unharmed or improved by
// frost, NEVER alerted"), so this is its edible subset rather than a second hardiness vocabulary;
// sowEngine.test.js pins the subset relation. Deliberately COPIED, not imported: src/lib stays free of
// lambda/ (the rule BUNCHING_HABIT_RE follows above), and the band is wider than this anyway (roses,
// hostas and fruit trees have no sow window).
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
// The subset guard is one-directional (FALL_HARDY_CROPS ⊆ band): it catches a slug added HERE without
// a band and is silent about a slug banded THERE and never added here. The exact-membership pin in
// sowEngine.test.js is what makes such an omission visible; prose does not fail a build.
//
// mache, claytonia, tatsoi and mizuna are members because frostClass.js bands them `hardy`; they are
// the overwintering greens whose purpose is standing through hard frost.
export const FALL_HARDY_CROPS = new Set([
  'arugula', 'beet', 'bok_choy', 'broccoli', 'brussels_sprouts', 'bunching_onion', 'cabbage',
  'carrot', 'celery', 'chard', 'chervil', 'chives', 'cilantro', 'claytonia', 'collard', 'endive',
  'garlic', 'kale', 'kohlrabi', 'leek', 'lettuce', 'mache', 'mizuna', 'mustard', 'parsley',
  'parsnip', 'radicchio', 'radish', 'spinach', 'tatsoi', 'turnip',
]);

// Days past the SOWING-SAFETY anchor a cool-season but NOT frost-hardy direct sowing may be aimed
// at. Numerically equal to FALL_GRACE_DAYS.cool_warm above, but a different quantity: that one is
// the fall INDOOR pass's grace and is keyed by sow_season, not by hardiness. Do not collapse them.
//
// There is deliberately no hardy sibling. A hardy grace on the safety margin (FF + 28 = Oct 26) adds
// a made-up number to a number that means something else, and would aim a hardy sowing past the
// site's 10-hour Persephone wall (lambda/daily-plan/overwinter.js), i.e. at growth that cannot
// happen. The hardy branch aims at the growth-stop anchor with no grace.
const FALL_GRACE_COOL = 14;

/**
 * Split direct_sow_timing into clauses on ';' and ' or ' (case-insensitive), only at PAREN DEPTH ZERO.
 *
 * Packet prose puts qualifying detail in parentheses and that detail contains separators:
 *
 *   Quincy: "Direct sow after all frost once soil is reliably warm (optimal 75-95F; never below
 *            55-60F). Zone 5b: late May to mid-June."
 *
 * A bare `.split(';')` cuts inside the parenthetical into two fragments, neither a sentence.
 * classifyClause returns null for both, they are dropped SILENTLY, and the variety ends up with no
 * parsed sow window at all, from a semicolon rather than anything about the crop.
 *
 * Depth-aware for ` or ` too: "(spring or fall)" is one qualifier, not two clauses. Nesting is
 * counted, so `((a; b); c)` behaves, and depth is clamped at 0 so a stray `)` returns to top level
 * instead of swallowing the rest of the string. Same class of bug as splitting SQL on a bare `;`.
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
// `before <filler> last frost`: packet copy interposes a qualifier between "before" and the anchor
// ("1-2 weeks before AVERAGE last frost", "2-3 wks before TO AROUND last frost"). The filler set is
// CLOSED (to/around/average/approximately/the), not a `\w+{0,2}` wildcard: a wildcard would also
// swallow a negation or a different anchor's adjective and silently attach the week count to the
// wrong date. Widening a mid-chain branch above D and F can steal clauses from the branches below it,
// so verify with scripts/snapshot-clause-classes.mjs (classifies the live clauses at a git-show copy
// of the old engine and at the working tree) rather than by reading.
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
  // `fall[-\s]sow`: packet copy uses both "fall sow" and the hyphenated "fall-sow". Only the SEPARATOR
  // is widened; the required "for (early) spring germination|bloom" tail is unchanged, so a clause that
  // merely mentions fall-sowing as an ALTERNATE to a spring primary does not become a fall-only
  // recommendation.
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
  // frost` said in plainer words. A separate alternation rather than loosening `last`: a bare
  // /after\s+.*frost/ would also capture "after FIRST frost", the opposite end of the season.
  } else if (/after\s+last\s+frost/i.test(c) || /after\s+all\s+(?:danger\s+of\s+)?frost/i.test(c)) {
    info.cls = 'B';
    if ((m = c.match(WEEKS_AFTER_LF_RE))) {
      info.weeksMin = parseInt(m[1], 10);
      info.weeksMax = m[2] != null ? parseInt(m[2], 10) : parseInt(m[1], 10);
    }
  // Class C: `soil can be worked` / `soil is workable`, or bare `early spring` with no month and no
  // frost anchor. "Early spring when soil is cold" IS the earliest-workable-soil window, not a narrower
  // one: every packet carrying the phrase is cold-tolerant or cold-REQUIRING seed (columbine, edelweiss),
  // so the earliest workable date is right for them rather than merely convenient.
  // Position matters: C sits BELOW A/B/E/G/H/J/L, so a clause that also carries a week count or a frost
  // anchor still classes on that stronger signal ("early spring, 2 wks before last frost" stays A). It
  // sits ABOVE D and F, so verify a change by snapshot: widening a middle-of-chain branch can steal
  // clauses from every branch below it.
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
      // Class M: a clause that names a fall crop/harvest with NO month token and no frost anchor
      // ("also good as a fall crop", "...for a fall harvest"). It counts back from first frost by the
      // variety's days-to-maturity, which latestSafeMs ALREADY IS, so class M needs no new math,
      // anchor or constant.
      //
      // PLACEMENT IS LOAD-BEARING: this is the `else` of the class-F month-token loop, so it fires ONLY
      // when nothing else matched. As a sibling `else if` up beside class E, where the other
      // frost-relative patterns live, it steals correctly classified clauses and reds pinned tests
      // ("late summer for fall crop" is class F and must stay class F). Do not promote this branch up
      // the chain.
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

// Establishment arithmetic, derived not asserted: root growth continues past first frost until soil
// drops below ~43F, ~35 days after FF here; a rosette needs ~8 weeks of ACTIVE growth to reach the
// crown mass that resists March frost heave (which kills more first-winter perennials in Franklin
// County than cold does) and, for vernalization-requiring biennials, to be large enough to bolt in
// year 2. October growth is worth well under half of July growth, hence the FALL_SLOWDOWN_DAYS
// discount.
//   FF + 35 - 56 - 14  ==  FF - 35d  ==  Aug 24 when FF = Sep 28.
// Cross-check: class H's Aug 15 close is independently derived and agrees within 9 days.
const ESTABLISH_DAYS = 56;
const FALL_GROWTH_TAIL = 35;
// A "days to maturity" over this on a NON-annual is days-to-BLOOM across a winter, not days to a
// harvest — the year-2 bloomers in the catalog carry dtm=300. Using it as a season-length clamp is
// a category error that produces close dates in the previous November.
const DTM_NOT_A_MATURITY = 200;

// FALLBACK ONLY. crop_types.first_year_harvest (exposed on v_sow_candidates) is the authoritative
// answer and sowGoal consults it FIRST; this set covers rows where that column is NULL (unknown).
// Prefer fixing the DATA over extending this list: a value here needs a deploy, a value in the column
// does not.
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

  // crop_types.first_year_harvest is authoritative when it has an opinion. It sits ABOVE the dtm
  // heuristic because it is a recorded fact and dtm is a proxy. Strict true/false checks, never
  // truthiness: NULL means UNKNOWN and must fall through to the heuristics below, not be read as false.
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
 * harvest goal:       cool hardy GS-dtm-slowdown | warm FF-dtm-14 | cool_warm FF-dtm-7 | cool FF+14-dtm
 * establishment goal: FF-35 regardless of dtm — nothing is maturing this year.
 *
 * GS (growth-stop) appears on exactly one branch, cool + FALL_HARDY_CROPS; every other branch takes
 * the sowing-safety margin FF. See the two-anchor note at FROST_ANCHORS for which question each
 * answers. The establishment clamp deliberately stays on FF: its FALL_GROWTH_TAIL=35 was derived
 * against the margin (FF-35 = Aug 24) and is cross-checked by class H's Aug 15 close, so moving the
 * anchor under it without re-deriving the 35 would break a validated absolute date.
 *
 * DO NOT "fix" a non-annual by deleting the lifecycle check. Hollyhock (dtm=300) would take the
 * cool_warm branch to FF-307 = Nov 25 of the PREVIOUS year, open > close, and pushDirect's
 * annihilation guard would make the card VANISH SILENTLY, a worse bug than the wrong date. Without
 * the establishment clamp, class-B windows for biennials would close at the raw ctx.FF.
 */
function latestSafeMs(candidate, dtm, ctx) {
  // Establishment does not consult dtm, so this must sit ABOVE the null guard or a null-dtm perennial
  // loses its clamp. It also sits ABOVE the hardy branch: on an establishment crop dtm is a
  // days-to-BLOOM figure, so a grace computed from it is a date derived from a number that is not a
  // maturity. The order is load-bearing.
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
    // A FALL_HARDY_CROPS slug is by definition "unharmed or improved by frost" (frostClass.js's hardy
    // band; this set is its edible subset), so first frost does not end it and the safety margin has no
    // job here. Maturity is aimed at the growth-stop anchor GS (see HARDY_GROWTH_STOP_MONTH_DAY).
    // FALL_SLOWDOWN_DAYS applies here exactly as on the fall indoor pass for the same crop set, so a
    // packet's DTM is slowdown-corrected on both paths; the two hardy paths differ ONLY by the nursery
    // period.
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
  // True when the packet SAID something about timing and the CLASSIFIER understood none of it (every
  // clause is `cls: null`). Measured on the ORIGINAL clause list rather than on `kept` below: `kept` is
  // narrowed on purpose (the gated-allium filter drops classes deliberately), and a deliberate drop is
  // knowledge, not ignorance. See bucketOne's exit for what it is used for.
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
        // A null clamp means an annual with no dtm: genuinely unknown, so emit no window rather than a
        // confident wrong one. Never fall back to `latestSafe ?? ctx.FF`: that fabricates a close date
        // from the frost anchor and printed "Direct sow through Sep 28" for biennials.
        if (latestSafe == null) { unknownClamp = true; continue; }
        close = latestSafe;
        break;
      case 'M':
        // Class M takes class B's exact shape: "when is it too late to sow this for a fall crop" is
        // already answered by latestSafeMs, which counts back from the frost anchor (or growth-stop, for
        // a hardy slug) by dtm. So the CLOSE is that clamp, unchanged, with the same null guard (a
        // clause the engine cannot clamp emits no window rather than a confident wrong one).
        //
        // The OPEN is the one thing the product rule does not specify: it names the latest sow date and
        // is silent on the earliest. 28 days is the fall INDOOR pass's existing lead, reused rather than
        // invented. Opening from the earliest other window (class D's rule) was measured and rejected: for
        // Red Mustard it yields one season-long band overlapping its own class-C spring window, the
        // symptom class C's close exists to prevent.
        if (latestSafe == null) { unknownClamp = true; continue; }
        open = latestSafe - 28 * DAY_MS;
        close = latestSafe;
        break;
      case 'C':
        // "As soon as the soil can be worked" is an EARLY-SPRING instruction, not a season-long
        // licence. Closing at `latestSafe` (the last date a sowing could still beat frost to a harvest)
        // is a different question and months later: spinach and peas would advertise a direct-sow window
        // in August about a crop whose actual instruction expired in April.
        //
        // Closes at LF + 14d. Not LF exactly: peas and spinach are sown right up to and a little past the
        // last frost, so a hard cut would clip a sowing really made in a late-frost year. Not a fixed
        // calendar date either, which discards the year-to-year frost variation this engine anchors on.
        //
        // Fall sowing is NOT lost here: autumn crops are carried by their own classes (B's post-frost
        // window, F's explicit month windows, G's Sep 15 – Nov 15 overwinter window).
        open = ctx.LF - 42 * DAY_MS;
        close = ctx.LF + 14 * DAY_MS;
        // No `latestSafe == null` bail: the close derives from the frost anchor, which is always
        // available, so a cool annual with no days-to-maturity gets its real spring window instead of
        // vanishing into unknownClamp. pushDirect still clamps down to latestSafe when that is EARLIER,
        // the only case where maturity should shorten a spring window.
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

// A single-number indoor lead is a POINT, and a point is not a window. A packet that says "start 8
// weeks before last frost" arrives as start_indoor_weeks_min = max = 8 (parseRange turns a lone number
// into an equal pair), so the spring window [LF - max, LF - min] has open == close: actionable on ONE
// day a year and already `window_closing` at daysLeft 0 on it. The vendor numbers are faithful, so the
// engine gives a lone number a tolerance rather than the data being rewritten.
//
// ±1 WEEK, CENTRED. The width matches what vendors write when they commit to a range (179 of the 199
// range-publishing candidate varieties say exactly two weeks). CENTRED is the judgement call: where a
// single-number crop has range-publishing neighbours they lean LONG, but centred keeps the vendor's own
// date inside its window with a week of slack (a floor reading makes it the LAST day), and LF is a
// frost margin, not a planting date: packets say to transplant tender crops AFTER it, so N weeks before
// LF already delivers an older transplant than N weeks at planting, and a window leaning earlier would
// compound that (the Biquinho and Black Krim golden fixtures in sowEngine.test.js). soilTempFloor is NOT
// evidence for this: it clamps only a direct-sow clause that names a soil temperature. N-1 is floored
// at 0 so "start indoors" never lands after last frost.
//
// SPRING WINDOW ONLY. wMin/wMax keep the vendor's number, because the fall pass below reads wMax as
// the nursery LENGTH, a physical duration rather than scheduling slop; widening it would pull every
// from-transplant fall start a week earlier. A real range, a one-week one included, is never touched.
const SINGLE_INDOOR_LEAD_TOLERANCE_WEEKS = 1;

function buildIndoorWindows(candidate, dtm, ctx, gated = false) {
  const windows = [];
  if (!methodIncludesIndoor(candidate.start_method)) return windows;
  let wMin = num(candidate.start_indoor_weeks_min);
  let wMax = num(candidate.start_indoor_weeks_max);
  wMin = wMin ?? wMax;
  wMax = wMax ?? wMin;
  if (wMax != null) {
    const single = wMin === wMax;
    const openWeeks = single ? wMax + SINGLE_INDOOR_LEAD_TOLERANCE_WEEKS : wMax;
    const closeWeeks = single ? Math.max(0, wMin - SINGLE_INDOOR_LEAD_TOLERANCE_WEEKS) : wMin;
    windows.push({
      open: ctx.LF - openWeeks * 7 * DAY_MS,
      close: ctx.LF - closeWeeks * 7 * DAY_MS,
      action: 'start_indoors',
      cls: 'spring_indoor',
    });
  }
  // Gated alliums get NO fall indoor pass: it exists to squeeze in a fall crop, which a bulbing allium
  // cannot do.
  if (gated) return windows;

  // Fall indoor pass: cool|cool_warm only; dtm null -> skip fall math.
  //
  // `latest` is the last date seed may be STARTED INDOORS. Subtracting dtm straight off the frost
  // anchor assumes days_to_maturity counts from that indoor sow. For a crop whose catalogue DTM is
  // quoted FROM TRANSPLANT that is wrong by the entire nursery period (4–6 weeks across the live fall
  // candidates), because maturity is reached `nursery` days later than the math assumes:
  //     maturity      = indoorStart + nursery + dtm   must be <=  deadline - FALL_SLOWDOWN_DAYS
  //     => indoorStart <= deadline - FALL_SLOWDOWN_DAYS - dtm - nursery
  // from-sow and NULL (uncurated) shift by zero, so direct-sow crops and uncurated crop types are
  // unaffected.
  //
  // `wMax` (normalised above to start_indoor_weeks_max ?? _min) is the deliberate choice over wMin: a
  // LONGER nursery closes the window EARLIER, the conservative direction in a frost race. It is the
  // VENDOR's number, never the widened spring window of the single-lead tolerance: that tolerance is
  // slop on a date and a nursery is a duration. sowEngine.test.js pins the separation.
  //
  // The `deadline` is keyed by hardiness FIRST, exactly as latestSafeMs's cool branch is: a
  // FALL_HARDY_CROPS slug is "unharmed or improved by frost", so frost does not end it and the
  // sowing-safety margin has no job; it aims maturity at ctx.GS. Everything else keeps ctx.FF + grace.
  //
  // THE GRACE GOES WITH THE ANCHOR: the hardy arm takes no grace, because a copied 28 would aim
  // maturity past the site's own 10-hour wall. So the hardy arm is GS - dtm - slowdown - nursery.
  //
  // SCOPED TO `cool`, not to the whole hardy set: latestSafeMs routes cool_warm to a strictly TIGHTER
  // margin (FF - dtm - 7) regardless of hardiness, and widening it here would make the indoor pass more
  // permissive than the direct one for the same packet.
  //
  // FALL_SLOWDOWN_DAYS STAYS ON BOTH ARMS. It corrects the DTM for shortening days, not the anchor for
  // frost: a different quantity from the grace, and hardiness says nothing about it.
  const grace = FALL_GRACE_DAYS[candidate.sow_season];
  if (grace != null && dtm != null) {
    const fromTransplant = candidate.dtm_basis === DTM_BASIS_TRANSPLANT;
    // A from-transplant crop with NO nursery estimate has an uncomputable latest-start. Emitting the
    // uncorrected date would be a confidently wrong OPEN in exactly the race this pass exists to stop,
    // so emit nothing instead, the same rule latestSafeMs applies to a null dtm.
    if (fromTransplant && wMax == null) return windows;
    const nurseryDays = fromTransplant ? wMax * 7 : 0;
    // The nursery term is subtracted IDENTICALLY on both arms: it shifts `latest` back by the nursery
    // period whichever anchor `latest` is measured from.
    const fallHardy = candidate.sow_season === 'cool' && FALL_HARDY_CROPS.has(candidate.crop_type_slug);
    // The hardy arm aims at GS, matching latestSafeMs's hardy branch, so both derive from one statement
    // (mature by growth-stop). Only the anchor differs between the arms; the FALL_SLOWDOWN_DAYS and
    // nursery terms are shared.
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

  // `unknownClamp` is carried down to the too_late exit at the bottom of this function rather than
  // handled here, because a packet can have OTHER windows (a closed indoor pass) that make `all`
  // non-empty while its DIRECT window is still unknown.

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
        // The bucket is a HORIZON partition, not a flower section: its members are whatever sowGoal()
        // calls establishment, which covers biennial vegetables and hardy greens carried under cover
        // for a spring cut. sowGoal cannot tell a hollyhock from an overwintered kale, so the phrase
        // must be true of both: what they share is WHEN the sowing pays off.
        windowLabel: `Direct sow through ${labelDate(close)} · pays off next spring`,
      },
    };
  }

  // Indoor-only / class J overlay: always sowable inside when no actionable outdoor/indoor-calendar
  // window is open. Gated alliums are EXCLUDED: this branch returns an actionable bucket, so without
  // the guard an `indoors_only` bulb onion would still be offered in July, straight past the gate.
  // (`anyJ` cannot fire for a gated candidate: gating filters clauses to class A. The `start_method`
  // half is the real hole.)
  if ((candidate.start_method === 'indoors_only' && !gated) || anyJ) {
    return {
      bucket: 'sow_inside_anytime',
      entry: { candidate, action: 'sow_inside', windowLabel: 'Grow indoors year-round' },
    };
  }

  // Ordinary hold: a window is still ahead THIS year, so nothing is being suppressed. Deliberately NO
  // gateFields here: gateReason means "the gate removed something" and must appear only when that is
  // true, or a gated onion in March would read "a summer sowing will not size a bulb" next to a
  // direct-sow window opening soon.
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

  // A direct-sow clause DROPPED for want of a days-to-maturity (unknownClamp) must not fall through to
  // too_late: "Sowing window passed" asserts something we do not know, since the window we cannot
  // compute might still be open (often with a merely-closed INDOOR pass making `all` non-empty).
  // NULL means UNKNOWN, and UNKNOWN must never fire as fact in EITHER direction. needs_profile is the
  // bucket that says so and names the fix.
  if (unknownClamp) {
    return {
      bucket: 'needs_profile',
      entry: { candidate, action: null, windowLabel: 'Add days to maturity to place this' },
    };
  }

  // The SAME rule as unknownClamp above, for the other way this engine can be ignorant. There the
  // clause was understood and its clamp was missing; here the clause was never understood at all, and
  // falling through would assert "Sowing window passed" about timing nobody read. That claim is wrong
  // on every date tested across the whole season, 1 March included: a fallthrough wearing a verdict.
  //
  // Placed AFTER unknownClamp deliberately: that branch names a specific, actionable fix ("add days to
  // maturity"), and a packet can be in both states. The more specific instruction wins.
  //
  // The label does not pretend to a verdict and does not blame the packet: the prose is usually
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
 * Is this packet archived out of the ACTIVE buckets for `year`?
 *
 * Expiry is a property of this read, not of a job: the stamp is a season, so once `year` moves on the
 * equality stops holding and the packet returns to its normal bucket by itself. Nothing has to run on
 * 1 Jan, and nothing stays hidden because a cron failed.
 *
 * Number()-coerced because view columns can arrive as strings from the neon driver (same defence
 * depthSpacingLine applies to sow_depth_in). An unparseable or absent stamp is NOT archived: the safe
 * direction, since the failure it guards against is a packet silently vanishing from the list. That
 * also makes the pre-migration view (no such column -> undefined) behave as before.
 */
export function isArchivedForSeason(candidate, year) {
  const raw = candidate?.sow_archived_season;
  if (raw == null || raw === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n === year;
}

/**
 * Is this packet used up, nothing left to sow?
 *
 * DIVERTS a depleted packet exactly as isArchivedForSeason does. Zero counts stay viewable as "sowed
 * previously" for review; there is deliberately no threshold, reorder quantity or restock cue, and
 * nothing here deletes, retires or re-decides a packet. The row keeps arriving from v_sow_candidates
 * with every column intact, which is what makes the review section possible at all.
 *
 * Filtering lives HERE and not in the view or the route. The rows are needed client-side for the
 * review section, and migration gates pin v_sow_candidates's rowcount to its unfiltered base join (none
 * carries `continuous:`, which defaults TRUE), so a server-side predicate would go red on prod AND
 * staging on the next migrations/** push.
 *
 * NULL IS SOWABLE, AND THAT IS THE WHOLE DECISION HERE. quantity_on_hand is nullable with no column
 * default, so NULL means "not tracked", which is NOT "used up". This deliberately differs from
 * InventoryDetail.jsx's `Number(item.quantity_on_hand ?? 0) > 0`, which collapses NULL into "hide":
 * right there (a plant-from-THIS-packet CTA needs stock actually in hand) and wrong on a PLANNING
 * surface, where hiding an uncounted packet is the wrong-late direction and forfeits a sowing
 * silently (wrong-early forfeits one sowing; wrong-late loses the planting). The difference is pinned
 * by test rather than left for the first NULL packet to settle it silently.
 *
 * Number()-coerced for the neon driver's string numerics. Absent, empty or unparseable reads as NOT
 * depleted, the safe direction. The `== null || === ''` guard is load-bearing: Number(null) and
 * Number('') are both 0, so without it every untracked packet would read as depleted.
 */
export function isDepleted(candidate) {
  const raw = candidate?.quantity_on_hand;
  if (raw == null || raw === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n <= 0;
}

/**
/**
 * The seed_stage values that mean the lot is not seed yet. The DB vocabulary is
 * `fermenting | drying | stored | NULL` (inventory_items_seed_stage_check, migrations/
 * v4-seedsaveflow-001/0a-ddl.sql); `stored` is terminal and IS sowable, so this is that
 * vocabulary minus its endpoint rather than a set invented here.
 */
export const IN_PROCESS_STAGES = Object.freeze(['fermenting', 'drying']);

/**
 * Is this lot still being PROCESSED, seed that physically is not yet seed anyone can sow?
 *
 * v_sow_candidates selects on `category='seeds' AND deleted_at IS NULL AND status='active'` plus a
 * live variety_id and says nothing about seed_stage, so a lot at `seed_stage='fermenting'` (wet
 * tomato seed in its own pulp) would be offered by Sow Now identically to a finished packet. The same
 * gap runs the other way: advancing a lot to `stored` would grant it nothing.
 *
 * DIVERTS rather than filters, exactly as isDepleted and isArchivedForSeason do: an in-process lot
 * STAYS on /sow, marked with the stage it is in, so the user sees that the seed exists and is coming
 * while being unable to mis-sow it. The row keeps arriving from the view with every column intact;
 * bucketize moves it to `in_process` and the card names the stage.
 *
 * Filtering lives HERE and not in the view for the reason isDepleted records above (the rowcount
 * gates). The companion migration APPENDS seed_stage/seed_process to the projection, a column append
 * those gates do not measure.
 *
 * NULL IS SOWABLE, the same conclusion as isDepleted from the opposite direction. There NULL was RARE
 * and the argument rested on cost asymmetry alone. Here NULL is the NORMAL state: seed_stage is
 * nullable with no default and only ever set on a lot somebody deliberately tracked, so every bought
 * packet is NULL. NULL means "never tracked", not "unfinished", and treating it as in-process would
 * divert the entire sow list into "not ready yet", the wrong-late direction at full scale.
 *
 * That holds because seed_stage has a single writer: lambda/inventory-items/seed-stage-one-writer.test.js
 * counts the statements that assign it, and a second writer reds the build.
 *
 * seed_process (`wet | dry`) is deliberately NOT read: it says HOW a lot is being processed, never
 * WHETHER it still is. Stage alone decides. Trimmed/lower-cased before the membership test, and
 * anything unrecognized reads as NOT in process, the same safe direction both neighbours take; that
 * is also what makes the pre-migration view (no such column -> undefined) behave as before.
 */
export function isInProcess(candidate) {
  const raw = candidate?.seed_stage;
  if (raw == null || raw === '') return false;
  return IN_PROCESS_STAGES.includes(String(raw).trim().toLowerCase());
}

/**
 * A lot you saved yourself and have not started processing.
 *
 * "Save seed" creates the lot with nothing counted (the seed is wet and uncounted) and the process
 * control defaults to "Not yet — just save the lot", which writes no seed_stage on purpose so that no
 * false ferment lands in seed_lot_stage_log. So the row is (nothing recorded, stage NULL): isInProcess
 * is false, and without this a zero-count lot reads as depleted, so Sow Now would file a lot saved five
 * seconds ago under "Sowed previously — none of these left". It has not been sown; it is being made.
 * It belongs in "Still in process", marked "Not started yet".
 *
 * WHY IT NEEDS source_plant_id: "stage NULL and nothing recorded" is NOT unique to a just-saved lot. A
 * purchased packet used down to zero is byte-identical on the row, and every bought packet has
 * seed_stage NULL because only home-saved lots are ever staged. source_plant_id (appended to
 * v_sow_candidates by v4-sowprovenance-001, and sent by SaveSeedSheet on every create) is the fact
 * that separates them. `own_garden` is the second arm for the lot whose origin is recorded on the lot
 * page afterwards, which source_plant_id does not reach.
 *
 * Only a lot with nothing recorded is re-homed here; a saved lot with a real count is sowable and
 * belongs in its timing bucket, untouched.
 *
 * READS PROVENANCE, WHICH isInProcess DELIBERATELY DOES NOT. The two are separate functions for that
 * reason rather than one widened predicate: isInProcess asks "is this seed physically not seed yet"
 * from seed_stage alone; this asks "did its owner make it and never start", which has a different
 * consequence downstream. SowNow withholds `Sow anyway` for the first and keeps it for the second (an
 * unstarted lot may be perfectly dry, whereas a fermenting one is in a jar of pulp).
 *
 * Absent columns read as false, so this is inert on an environment where the view has not been
 * widened: the lot falls back to `sowed_previously`. That keeps the migration and the code
 * independently deployable.
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
  // The "nothing recorded yet" signal lives in two columns. Newer saves create the lot at
  // quantity_on_hand 1 (one JAR) and keep the count in `seed_count`, so isDepleted alone would return
  // false for every new save and the divert this function exists to perform would silently stop
  // firing: a jar of wet fermenting seed offered by Sow Now as though it were a finished packet.
  // Test fixtures for this must match the shape SaveSeedSheet actually creates; hand-built rows cannot
  // see a writer regression.
  //
  // Legacy arm kept FIRST and unchanged: a lot created before that change still carries the old shape,
  // and `qty <= 0` remains the honest reading of it.
  if (isDepleted(candidate)) return true;
  // The un-widened-view guard, which preserves the independent-deployability property above.
  // `seed_count` absent from the row object is NOT the same as present-and-null: on an environment
  // whose v_sow_candidates predates the column append, every key read is `undefined` and a naive
  // `== null` test would flip every own-seed unstaged lot to "unstarted", the opposite of the inert
  // fallback. Absent columns must read as "cannot tell", i.e. false.
  const hasMeasureCols = candidate != null
    && (Object.prototype.hasOwnProperty.call(candidate, 'seed_count')
      || Object.prototype.hasOwnProperty.call(candidate, 'seed_weight_g'));
  if (!hasMeasureCols) return false;
  // Nothing measured at all (neither counted nor weighed) is what "saved it and never started" looks
  // like. A lot with EITHER a count or a weight belongs in its timing bucket. `=== ''` matters
  // alongside `== null` for the same reason as in isDepleted: the neon driver returns numerics as
  // strings and an empty string must not read as a recorded zero.
  const blank = (v) => v == null || v === '';
  return blank(candidate.seed_count) && blank(candidate.seed_weight_g);
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
    // The MEASURED anchor, carried alongside FF rather than replacing it (see the two-anchor note at
    // FROST_ANCHORS). Overridable on the same `anchors` argument so a test or a second site can move it.
    FFobs: anchorToMs(cfg.observedFirstFallFrost, year),
    // The growth-stop anchor the two FALL_HARDY_CROPS branches consume. A THIRD anchor deliberately:
    // FF answers "will frost kill this", FFobs answers "when does frost arrive", and GS answers "when
    // does growth stop", the only one of the three that bounds a crop frost does not kill. Overridable
    // on the same `anchors` argument, so a test can prove an override of either frost anchor does NOT
    // move the hardy branches.
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
    // `sowed_previously` and `archived` are DIVERT targets, not verdicts: bucketOne never returns
    // either. They are seeded here for the same reason as the rest (a missing key makes the push below
    // throw). `in_process` is the third divert target.
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
    // The diverts compose rather than race. Depletion decides the packet's HOME bucket and archive then
    // diverts it out of that home, so a packet that is both reads "From: Sowed previously" and,
    // un-archived, returns to the review section instead of to a working list it has no seed for. The
    // other order would make an un-archive re-offer an empty packet.
    //
    // In-process is resolved AHEAD of depletion: a lot still fermenting has no meaningful count yet
    // (the number is taken when the seed is dry and packeted), so a wet lot at 0/NULL diverted to
    // `sowed_previously` would assert a sowing that never happened. The physical state of the seed
    // wins; depletion decides among the rest; archive still diverts out of whichever home those chose.
    // Written as a chain rather than a nested ternary because each arm stamps its own provenance key,
    // which the card reads back as "From: ...".
    //
    // The unstarted-save arm sits in the same place for the same reason. It carries `unstartedSave` so
    // the card can label it "Not started yet" rather than naming a stage it does not have, and so
    // SowNow can keep the `Sow anyway` override that a genuinely fermenting lot is denied.
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
