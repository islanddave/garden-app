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

function buildDirectWindows(candidate, dtm, ctx) {
  const clauses = splitClauses(candidate.direct_sow_timing).map(classifyClause);
  // Class K: zone-conditional — keep the 5b/6a clause, drop mild-climate ones.
  const hasZoneClause = clauses.some((cl) => cl.zone5b6a);
  const kept = hasZoneClause ? clauses.filter((cl) => !cl.mildClimates) : clauses;

  const latestSafe = latestSafeMs(candidate, dtm, ctx);
  const windows = [];
  let anyJ = false;
  let neverTooLate = false;
  const deferredD = [];

  for (const cl of kept) {
    let open = null;
    let close = null;
    let clamp = true;
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
          pushDirect(windows, cl, anchorToMs(o, ctx.year), anchorToMs(c2, ctx.year), latestSafe, true, ctx);
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
        open = anchorToMs('06-01', ctx.year);
        close = anchorToMs('08-15', ctx.year);
        clamp = false;
        break;
      case 'J':
        anyJ = true;
        continue;
      case 'L': // self-sows — ignore
      default:
        continue;
    }
    pushDirect(windows, cl, open, close, latestSafe, clamp, ctx);
  }

  // Class D (succession): open from the earliest other direct window (else
  // LF-42d) until latest_safe. Skipped when latest_safe is uncomputable.
  for (const cl of deferredD) {
    if (latestSafe == null) continue;
    const opens = windows.map((w) => w.open);
    const open = opens.length ? Math.min(...opens) : ctx.LF - 42 * DAY_MS;
    pushDirect(windows, cl, open, latestSafe, latestSafe, true, ctx);
  }

  return { windows, anyJ, neverTooLate };
}

function pushDirect(windows, cl, open, close, latestSafe, clamp, ctx) {
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
  });
}

function buildIndoorWindows(candidate, dtm, ctx) {
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
  const indoorWindows = buildIndoorWindows(candidate, dtm, ctx);
  const { windows: directWindows, anyJ, neverTooLate } =
    buildDirectWindows(candidate, dtm, ctx);
  const all = [...indoorWindows, ...directWindows];

  const isOpen = (w) => w.open <= ctx.today && ctx.today <= w.close;
  const openIndoor = indoorWindows.filter(isOpen);
  const openDirect = directWindows.filter(isOpen);

  if (openIndoor.length || openDirect.length) {
    const primary = openIndoor.length ? openIndoor : openDirect;
    const action = openIndoor.length ? 'start_indoors' : 'direct_sow';
    const close = Math.max(...primary.map((w) => w.close));
    const daysLeft = Math.round((close - ctx.today) / DAY_MS);
    let windowLabel = `${actionPhrase(action)} through ${labelDate(close)}`;
    if (openIndoor.length && openDirect.length) windowLabel += ' · also direct-sowable';
    const soil = primary.find((w) => w.soilTempF != null);
    if (soil) windowLabel += ` · soil ≥${soil.soilTempF}°F`;
    const bucket = daysLeft <= ctx.closingDays
      ? 'window_closing'
      : (action === 'start_indoors' ? 'start_indoors_now' : 'direct_sow_now');
    return { bucket, entry: { candidate, action, daysLeft, windowLabel } };
  }

  // Indoor-only / class J overlay: always sowable inside when no actionable
  // outdoor/indoor-calendar window is open.
  if (candidate.start_method === 'indoors_only' || anyJ) {
    return {
      bucket: 'sow_inside_anytime',
      entry: { candidate, action: 'sow_inside', windowLabel: 'Grow indoors year-round' },
    };
  }

  const future = all.filter((w) => w.open > ctx.today).sort((a, b) => a.open - b.open);
  if (future.length) {
    const next = future[0];
    return {
      bucket: 'hold',
      entry: {
        candidate,
        action: next.action,
        reopensOn: msToISO(next.open),
        windowLabel: `Opens ${labelDate(next.open)} · ${actionPhrase(next.action).toLowerCase()}`,
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
        windowLabel: `Opens ${labelDate(open)} · direct sow`,
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
 *   window_closing:[], hold:[], too_late:[], needs_profile:[]}}
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
  };
  const buckets = {
    start_indoors_now: [],
    direct_sow_now: [],
    sow_inside_anytime: [],
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
