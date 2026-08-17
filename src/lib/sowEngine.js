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

export const FROST_ANCHORS = Object.freeze({
  lastSpringFrost: '05-20',
  firstFallFrost: '09-28',
  windowClosingDays: 10,
});

/** Days shaved off fall math for slowing autumn growth. */
export const FALL_SLOWDOWN_DAYS = 14;

/** Fall indoor-pass grace days by season (warm gets no fall pass). */
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

// Days past the fall frost anchor a cool-season DIRECT sowing may still be aimed at. Numerically
// equal to FALL_GRACE_DAYS above, but a different quantity — that one is the fall INDOOR pass's
// grace and is keyed by sow_season, not by hardiness. Do not collapse the two.
const FALL_GRACE_HARDY = 28;
const FALL_GRACE_COOL = 14;

/** Split direct_sow_timing into clauses on ';' and ' or ' (case-insensitive). */
export function splitClauses(timing) {
  if (!timing) return [];
  return String(timing)
    .split(';')
    .flatMap((part) => part.split(/\s+or\s+/i))
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
const WEEKS_BEFORE_LF_RE = /(\d+)(?:\s*[-–—]\s*(\d+))?\s*w(?:ee)?ks?\s+before\s+last\s+frost/i;
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
  } else if (/after\s+last\s+frost/i.test(c)) {
    info.cls = 'B';
    if ((m = c.match(WEEKS_AFTER_LF_RE))) {
      info.weeksMin = parseInt(m[1], 10);
      info.weeksMax = m[2] != null ? parseInt(m[2], 10) : parseInt(m[1], 10);
    }
  } else if (/as\s+soon\s+as\s+(?:the\s+)?soil\s+can\s+be\s+worked/i.test(c)) {
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
 * harvest goal:       cool hardy FF+28-dtm | warm FF-dtm-14 | cool_warm FF-dtm-7 | cool FF+14-dtm
 * establishment goal: FF-35 regardless of dtm — nothing is maturing this year.
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
  if (season === 'warm') return ctx.FF - (dtm + 14) * DAY_MS;
  if (season === 'cool_warm') return ctx.FF - (dtm + 7) * DAY_MS;
  if (season === 'cool') {
    const grace = FALL_HARDY_CROPS.has(candidate.crop_type_slug) ? FALL_GRACE_HARDY : FALL_GRACE_COOL;
    return ctx.FF + (grace - dtm) * DAY_MS;
  }
  return null;
}

function methodIncludesIndoor(method) {
  return method === 'start_indoors' || method === 'both' || method === 'indoors_only';
}

function buildDirectWindows(candidate, dtm, ctx, gated = false) {
  const clauses = splitClauses(candidate.direct_sow_timing).map(classifyClause);
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
      case 'C':
        open = ctx.LF - 42 * DAY_MS;
        if (latestSafe == null) { unknownClamp = true; continue; }
        close = latestSafe;
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

  return { windows, anyJ, neverTooLate, unknownClamp };
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
  //     maturity      = indoorStart + nursery + dtm   must be <=  FF + grace - FALL_SLOWDOWN_DAYS
  //     => indoorStart <= FF + grace - FALL_SLOWDOWN_DAYS - dtm - nursery
  // i.e. the corrected latest-start is the existing one shifted back by the nursery period.
  // Measured against live prod 2026-08-04: 14 fall brassica/lettuce windows the engine still showed
  // OPEN had in fact closed between 2026-06-23 and 2026-07-17. Telling the user to start fall
  // brassicas that cannot beat a Sep-28 frost is the failure this corrects.
  //
  // `wMax` (normalised above to start_indoor_weeks_max ?? _min) is the deliberate choice over wMin:
  // a LONGER nursery closes the window EARLIER, the conservative direction in a frost race.
  // from-sow and NULL (uncurated) shift by zero — byte-identical to the pre-basis behaviour, which
  // is what keeps this a provable no-op for direct-sow crops and for every uncurated crop type.
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
    const latest = ctx.FF + (grace - dtm - FALL_SLOWDOWN_DAYS - nurseryDays) * DAY_MS;
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
  const { windows: directWindows, anyJ, neverTooLate, unknownClamp } =
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
 * Bucket v_sow_candidates rows for a given day.
 * @param {Array<object>} candidates v_sow_candidates-shaped rows
 * @param {string} todayISO 'YYYY-MM-DD'; anchors resolve against its year
 * @param {object} [anchors] partial FROST_ANCHORS override
 * @returns {{start_indoors_now:[], direct_sow_now:[], sow_inside_anytime:[],
 *   sow_next_year:[], window_closing:[], hold:[], too_late:[], needs_profile:[], archived:[]}}
 */
export function bucketize(candidates, todayISO, anchors = {}) {
  const cfg = { ...FROST_ANCHORS, ...anchors };
  const today = isoToMs(todayISO);
  const year = new Date(today).getUTCFullYear();
  const ctx = {
    today,
    year,
    LF: anchorToMs(cfg.lastSpringFrost, year),
    FF: anchorToMs(cfg.firstFallFrost, year),
    closingDays: cfg.windowClosingDays,
    // mm-dd anchors kept on ctx so the gated-allium hold can rebuild windows against year+1.
    lastSpringFrost: cfg.lastSpringFrost,
    firstFallFrost: cfg.firstFallFrost,
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
    archived: [],
  };
  for (const candidate of candidates || []) {
    // bucketOne runs FIRST even for archived packets, and the bucket it chose rides along as
    // `archivedFrom`. Two reasons: the archived card keeps its real window label instead of going
    // blank, and un-archiving is a pure re-read — the entry it returns to is already computed, so
    // the two paths cannot drift into disagreeing about where a packet belongs.
    const { bucket, entry } = bucketOne(candidate, ctx);
    if (isArchivedForSeason(candidate, year)) {
      buckets.archived.push({ ...entry, archivedFrom: bucket });
    } else {
      buckets[bucket].push(entry);
    }
  }
  return buckets;
}
