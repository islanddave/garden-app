// src/lib/sowEngine.js — DRG-SOWNOW-001 bucketing engine (horticulture-panel
// FINAL rules). Pure ESM, zero dependencies, UTC-safe date math.
//
// bucketize(candidates, todayISO, anchors?) sorts v_sow_candidates rows into
// action buckets for the /sow page. Numeric candidate fields may arrive as
// strings (neon driver) — everything is Number()-coerced here.

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

const HARDY_RE = /frost.?tolerant|improves?\s+(?:in\s+flavor\s+)?after\s+(?:light\s+)?frost/i;

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
  } else if (/fall\s+sow\s+for\s+(?:early\s+)?spring\s+(?:germination|bloom)/i.test(c)) {
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

/**
 * latest-safe direct-sow close date (ms) or null when the table has no row:
 * cool hardy FF+28-dtm | warm annual FF-dtm-14 | cool_warm annual FF-dtm-7 |
 * cool annual FF+14-dtm. Effective lifecycle key = grown_as ?? lifecycle.
 */
function latestSafeMs(candidate, dtm, ctx) {
  if (dtm == null) return null;
  const season = candidate.sow_season;
  const notes = candidate.sow_notes || '';
  if (season === 'cool' && HARDY_RE.test(notes)) return ctx.FF + (28 - dtm) * DAY_MS;
  const effective = candidate.grown_as ?? candidate.lifecycle;
  if (effective !== 'annual') return null;
  if (season === 'warm') return ctx.FF - (dtm + 14) * DAY_MS;
  if (season === 'cool_warm') return ctx.FF - (dtm + 7) * DAY_MS;
  if (season === 'cool') return ctx.FF + (14 - dtm) * DAY_MS;
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
  const windows = [];
  let anyJ = false;
  let neverTooLate = false;
  const deferredD = [];

  for (const cl of kept) {
    let open = null;
    let close = null;
    let clamp = true;
    let horizon = 'this_season';
    switch (cl.cls) {
      case 'A':
        open = ctx.LF - cl.weeksMax * 7 * DAY_MS;
        close = ctx.LF - cl.weeksMin * 7 * DAY_MS;
        break;
      case 'B':
        open = ctx.LF + (cl.weeksMin ?? 0) * 7 * DAY_MS;
        close = latestSafe ?? ctx.FF;
        break;
      case 'C':
        open = ctx.LF - 42 * DAY_MS;
        close = latestSafe ?? ctx.LF;
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

  return { windows, anyJ, neverTooLate };
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
  const grace = FALL_GRACE_DAYS[candidate.sow_season];
  if (grace != null && dtm != null) {
    const latest = ctx.FF + (grace - dtm - FALL_SLOWDOWN_DAYS) * DAY_MS;
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
  const { windows: directWindows, anyJ, neverTooLate } =
    buildDirectWindows(candidate, dtm, ctx, gated);
  const all = [...indoorWindows, ...directWindows];

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
        windowLabel: `Direct sow through ${labelDate(close)} · flowers next year`,
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

  return {
    bucket: 'too_late',
    entry: { candidate, action: null, windowLabel: `Sowing window passed for ${ctx.year}` },
  };
}

/**
 * Bucket v_sow_candidates rows for a given day.
 * @param {Array<object>} candidates v_sow_candidates-shaped rows
 * @param {string} todayISO 'YYYY-MM-DD'; anchors resolve against its year
 * @param {object} [anchors] partial FROST_ANCHORS override
 * @returns {{start_indoors_now:[], direct_sow_now:[], sow_inside_anytime:[],
 *   sow_next_year:[], window_closing:[], hold:[], too_late:[], needs_profile:[]}}
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
  };
  for (const candidate of candidates || []) {
    const { bucket, entry } = bucketOne(candidate, ctx);
    buckets[bucket].push(entry);
  }
  return buckets;
}
