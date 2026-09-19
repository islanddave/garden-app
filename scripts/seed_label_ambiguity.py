#!/usr/bin/env python3
"""Byte-identical labels in the saved-seeds candidate picker (BUG-SEEDCANDIDATEAMBIG-001).

WHAT IT MEASURES
----------------
The picker on /seeds/saved renders one line per untracked packet, and that line is
`variety_name || name` -- where `variety_name` is `pv.display_name` from `public.cultivar`, joined
in by GET /api/inventory-items (lambda/inventory-items/index.js). Nothing else distinguishes two
rows. So any two packets of one cultivar render a BYTE-IDENTICAL row, and picking the wrong one is
not a mistake the user can see themselves make -- the two options are the same string.

A crucible seat computed this by hand against prod (51 of 260 rows, across 24 groups) and wrote
"script it". Nobody did, so the number could not be re-measured, could not be watched, and could not
be shown to have moved. This is that script. The redesign's criterion is that the count reaches 0.

WHY IT IS NOT A CI GATE, AND MUST NOT BECOME ONE AS IT STANDS
-------------------------------------------------------------
The count is a property of the DATA, not of the code. CI has no prod database and never will, so
wiring this into ci.yml would produce either a skipped step or a step that measures an empty
schema -- and an empty population scores a perfect zero, which is the exact vacuous pass this
repo's layout-gate directory exists to refuse. Run it by hand, or on a schedule with a read-only
DSN in the environment.

Its CI-able sibling is the RENDER-level uniqueness assertion in the vitest suite: that one proves
the page cannot render two identical rows *given* colliding data, which is a property of the code
and travels with it. The two are complements, not substitutes -- neither one implies the other.

THE INSTRUMENT CHECK
--------------------
"0 ambiguous rows" and "0 rows examined" are the same number and opposite meanings, and the second
one is what a wrong DSN, a mis-scoped household filter, a renamed column or an empty branch
database all look like. So an empty population is a FATAL (exit 2), never a pass. Every run prints
the population it measured before it prints the finding, so a number is never reported without the
denominator it came from.

CREDENTIALS
-----------
Read from the environment only, never accepted on the command line (L-067), following
scripts/gate_runner.py's resolve_url(): NEON_DATABASE_URL for prod, NEON_STAGING_URL for staging.
The connection is opened read_only, so PostgreSQL itself rejects any write.

MY SEEDS (--surface myseeds, V5-SEEDSTAB-001)
---------------------------------------------
The Seeds page's My seeds view renders every live seed row as a title plus a second line -- state
chips, then how much, where from, how old -- and each row carries a quantity STEPPER, so two rows
that read alike let a thumb write to the wrong lot. The page makes them unique with labelCandidates
(src/components/seed/seedLots.js): an ordinal ("1 of 2 with identical details") on every row whose
rendered title + second line collide, and the row id as the last resort. This surface reports how
many rows collide BEFORE that ordinal -- how much the ordinal is carrying -- and how many AFTER it,
which must be 0. Both are computed over what the page puts ON SCREEN: every row except those under
the collapsed "Sowed previously" section, and again with that section open.

The line is PORTED from src/components/seed/mySeedsModel.js, not approximated -- see the port block
below -- and test_seed_label_ambiguity.py runs the REAL JavaScript on a shared fixture and fails on
any disagreement, so an edit to the model that is not mirrored here reds the suite rather than
silently skewing the count. The vendor comes from the source REGISTRY (public.source via source_id),
never the free-text `source` column, exactly as the page resolves it. --max bounds the AFTER count.

EXIT CODES (house convention, cf. gate_runner.py / check-staging-drift.py)
  0  ran; the ambiguous-row count is at or below --max
  1  ran; the count EXCEEDS --max  (this is what makes it gate-able later)
  2  could not run -- missing DSN, psycopg absent, database unreachable, or an EMPTY population.
     Never a silent pass: unmeasured is UNKNOWN, not zero.

USAGE
  NEON_DATABASE_URL=... python3 scripts/seed_label_ambiguity.py
  NEON_DATABASE_URL=... python3 scripts/seed_label_ambiguity.py --max 0 --json
  NEON_STAGING_URL=...  python3 scripts/seed_label_ambiguity.py --env staging --scope seeds
  NEON_DATABASE_URL=... python3 scripts/seed_label_ambiguity.py --surface myseeds
"""
import argparse
import json
import math
import os
import re
import sys
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo

# The picker's population, expressed as SQL. Three predicates, each with a source:
#   category='seeds' + deleted_at IS NULL  -- the list endpoint's own WHERE clause
#   status='active'                        -- the client's `untracked` filter (SavedSeeds.jsx)
#   seed_stage not in the three stages     -- the same filter's other half; a staged lot is a CARD,
#                                             not a candidate, so it is never in the picker
# The label expression mirrors JS `variety_name || name` exactly. `||` is falsy-tolerant in JS, so
# an EMPTY STRING falls through to the next term where SQL's COALESCE alone would not -- hence the
# NULLIFs. Getting this wrong in the lenient direction would UNDER-report collisions.
LABEL_EXPR = "COALESCE(NULLIF(pv.display_name, ''), NULLIF(i.name, ''), '')"

SEED_STAGES = ('fermenting', 'drying', 'stored')

ROW_SQL = """
SELECT i.id::text                       AS id,
       {label}                          AS label,
       i.name                           AS name,
       pv.display_name                  AS variety_name,
       i.source                         AS source,
       i.quantity_on_hand               AS quantity_on_hand,
       i.purchase_date::text            AS purchase_date,
       i.seed_stage                     AS seed_stage,
       i.status                         AS status,
       i.created_by                     AS created_by
  FROM public.inventory_items i
  LEFT JOIN public.cultivar pv ON pv.id = i.variety_id
 WHERE i.category = 'seeds'
   AND i.deleted_at IS NULL
   {scope}
   {household}
 ORDER BY label, i.id
"""

SCOPE_PICKER = """
   AND i.status = 'active'
   AND (i.seed_stage IS NULL OR i.seed_stage <> ALL(%(stages)s))
"""


def build_sql(scope, household_ids):
    """Compose the row query. Kept separate from execution so a test can read it without a DB."""
    if scope not in ('picker', 'seeds'):
        raise ValueError(f"unknown scope {scope!r}")
    return ROW_SQL.format(
        label=LABEL_EXPR,
        scope=SCOPE_PICKER if scope == 'picker' else '',
        household='AND i.created_by = ANY(%(household)s)' if household_ids else '',
    )


def group_labels(rows):
    """Group rows by the string the picker actually renders.

    Returns (groups, ambiguous_rows) where `groups` is a list of
    {'label', 'count', 'ids'} for every label rendered by MORE THAN ONE row, biggest first, and
    `ambiguous_rows` is the total number of rows sitting in one of those groups -- i.e. the number
    of rows a user cannot tell apart. That total, not the group count, is the criterion: 24 groups
    is a smaller problem than 24 groups of five.

    A row whose label is the EMPTY STRING is its own kind of defect -- it renders a blank line --
    and is counted as ambiguous whenever more than one exists, for the same reason: two blank lines
    are indistinguishable from each other.

    Pure: no database, no environment, no I/O. This is the half a unit test can prove.
    """
    counts = Counter(r['label'] for r in rows)
    by_label = defaultdict(list)
    for r in rows:
        by_label[r['label']].append(r['id'])
    groups = [
        {'label': label, 'count': n, 'ids': by_label[label]}
        for label, n in counts.items() if n > 1
    ]
    # Biggest first, then alphabetical: the worst collision is the one to read first, and the tie
    # order has to be stable or two runs of the same data print in different orders.
    groups.sort(key=lambda g: (-g['count'], g['label']))
    ambiguous_rows = sum(g['count'] for g in groups)
    return groups, ambiguous_rows


def distinguishing_facts(rows_in_group):
    """What, if anything, still separates rows that render the same label.

    Reported so a reader can tell a fixable collision (different vendor, different purchase date --
    the row could SAY so) from a genuinely identical pair (nothing on the record differs, so no
    amount of row design separates them and the answer has to be an ordinal or a merge).
    """
    facts = []
    for key in ('source', 'purchase_date', 'quantity_on_hand'):
        seen = {str(r.get(key)) for r in rows_in_group}
        if len(seen) > 1:
            facts.append(key)
    return facts


def resolve_url(env):
    """Environment only. A database URL is never accepted on the command line (L-067)."""
    var = 'NEON_DATABASE_URL' if env == 'prod' else 'NEON_STAGING_URL'
    url = os.environ.get(var)
    if not url:
        print(f"\nFATAL: {var} is not set (needed for --env {env}).", file=sys.stderr)
        print("  The ambiguous-label count is UNKNOWN, not zero.", file=sys.stderr)
        print("  Never pass a database URL on the command line (L-067).", file=sys.stderr)
        return None, var
    return url, var


def fetch_rows(url, scope, household_ids):
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError:
        print("\nFATAL: psycopg (v3) is not installed.", file=sys.stderr)
        print("  Fix: pip install 'psycopg[binary]'", file=sys.stderr)
        return None
    params = {'stages': list(SEED_STAGES)}
    if household_ids:
        params['household'] = household_ids
    try:
        with psycopg.connect(url) as conn:
            conn.read_only = True          # layer 2: the server rejects any write
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(build_sql(scope, household_ids), params)
                return cur.fetchall()
    except Exception as exc:
        # An unreachable database is UNKNOWN, never "no collisions".
        print(f"\nFATAL: could not read the seed rows: {type(exc).__name__}: {exc}", file=sys.stderr)
        return None


# ── My seeds (V5-SEEDSTAB-001) — the row line, ported ─────────────────────────────────────────────
# Function for function from src/components/seed/mySeedsModel.js and what it imports (seedLots.js,
# sowEngine.js, format.js, harvestSummary.js's etDay), JS coercions included: Number(), Math.round's
# half-toward-+Infinity, toFixed's half-up on the exact binary value, `== null || === ''` blanks,
# String(n) === '1' plurals, calendar days in Eastern. A port that is merely close counts a different
# set of collisions, so the parity test in test_seed_label_ambiguity.py runs the real JS on a shared
# fixture and compares every title, line and label.
#
# Rows are handled in the WIRE SHAPE the page receives from GET /api/inventory-items?category=seeds
# (to_wire): timestamps as ISO-8601 UTC strings, numerics as strings, uuids as text. The ports then
# see the values the JS sees, not psycopg's Decimals and datetimes.
ET = ZoneInfo('America/New_York')
IN_PROCESS_STAGES = ('fermenting', 'drying')
# JS String.prototype.trim()'s set: WhiteSpace + LineTerminator. Python's strip() differs at the edges
# (it strips \x1c-\x1f, keeps ﻿).
_JS_WS = '\t\n\x0b\x0c\r \xa0                　﻿'


def _js_trim(s):
    return s.strip(_JS_WS)


def _js_str(v):
    """String(v ?? '')."""
    return '' if v is None else str(v)


def _blank(v):
    """`v == null || v === ''` — the model's test for "nothing recorded"."""
    return v is None or v == ''


def _js_truthy(v):
    if v is None or v is False:
        return False
    if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
        return not (v == 0 or v != v)
    if isinstance(v, str):
        return v != ''
    return True


def _js_number(v):
    """JS Number(v) for the shapes these columns carry. Number(null) is 0; a string that is not a
    JS numeric literal is NaN — including the 'inf'/'nan'/'1_000' spellings Python's float() takes."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float, Decimal)):
        return float(v)
    s = _js_trim(str(v))
    if s == '':
        return 0.0
    if re.fullmatch(r'[+-]?Infinity', s):
        return -math.inf if s.startswith('-') else math.inf
    if re.fullmatch(r'0[xX][0-9a-fA-F]+', s):
        return float(int(s, 16))
    if re.search(r'(?i)inf|nan|_', s):
        return math.nan
    try:
        return float(s)
    except ValueError:
        return math.nan


def _finite(x):
    return not (math.isnan(x) or math.isinf(x))


def _js_round(x):
    """Math.round: half toward +Infinity (Python's round() is half-to-even)."""
    return math.floor(x + 0.5)


def format_qty(n):
    """format.js formatQty."""
    if _blank(n):
        return ''
    num = _js_number(n)
    if not _finite(num):
        return str(n)
    return str(_js_round(num))


def format_seed_weight(g):
    """format.js formatSeedWeight: grams to two places (trailing zeros stripped) from a decigram up
    and at zero; milligrams below."""
    if _blank(g):
        return ''
    num = _js_number(g)
    if not _finite(num):
        return str(g)
    if num >= 0.1 or num <= 0:
        # toFixed(2): half-up on the EXACT binary value, which Decimal(float) is. -0 prints as 0.
        fixed = str(Decimal(num if num != 0 else 0.0).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))
        return re.sub(r'\.?0+$', '', fixed, count=1) + ' g'
    return f'{_js_round(num * 1000)} mg'


def seed_count_label(n, estimated):
    """seedLots.js seedCountLabel."""
    if _blank(n):
        return ''
    c = _js_number(n)
    if not _finite(c):
        return ''
    shown = format_qty(c)
    counted = f"{shown} {'seed' if shown == '1' else 'seeds'}"
    return f'approx. {counted}' if _js_truthy(estimated) else counted


def lot_measure(i):
    """seedLots.js lotMeasure: count and/or weight, never the container count."""
    parts = [seed_count_label(i.get('seed_count'), i.get('seed_count_estimated')),
             format_seed_weight(i.get('seed_weight_g'))]
    return ' · '.join(p for p in parts if p)


def is_saved_lot(i):
    """seedLots.js isSavedLot."""
    if not i:
        return False
    if not _blank(i.get('source_plant_id')):
        return True
    if not _blank(i.get('source_kind')):
        return True
    return not _blank(i.get('seed_stage'))


def is_in_process(c):
    """sowEngine.js isInProcess."""
    raw = c.get('seed_stage')
    if _blank(raw):
        return False
    return _js_trim(str(raw)).lower() in IN_PROCESS_STAGES


def is_depleted(c):
    """sowEngine.js isDepleted — NULL is sowable, not used up."""
    raw = c.get('quantity_on_hand')
    if _blank(raw):
        return False
    n = _js_number(raw)
    return _finite(n) and n <= 0


def is_unstarted_save(c):
    """sowEngine.js isUnstartedSave, both arms, including the absent-column guard."""
    from_plant, kind = c.get('source_plant_id'), c.get('source_kind')
    own_seed = (not _blank(from_plant)) or (kind is not None and _js_trim(str(kind)).lower() == 'own_garden')
    if not own_seed:
        return False
    if not _blank(c.get('seed_stage')):
        return False
    if is_depleted(c):
        return True
    if 'seed_count' not in c and 'seed_weight_g' not in c:
        return False
    return _blank(c.get('seed_count')) and _blank(c.get('seed_weight_g'))


def is_archived_for_season(c, year):
    """sowEngine.js isArchivedForSeason."""
    raw = c.get('sow_archived_season')
    if _blank(raw):
        return False
    n = _js_number(raw)
    return _finite(n) and n == year


def is_sowed_previously(i):
    """mySeedsModel.js isSowedPreviously — the rows My seeds files under the collapsed section."""
    return is_depleted(i) and not is_in_process(i) and not is_unstarted_save(i)


def row_title(i):
    """mySeedsModel.js rowTitle: the variety, unless a saved lot carries a hand-typed name."""
    variety = _js_trim(_js_str(i.get('variety_name')))
    name = _js_trim(_js_str(i.get('name')))
    if not variety:
        return name
    if not is_saved_lot(i) or not name:
        return variety
    is_default = (re.fullmatch(re.escape(variety) + ' — saved [0-9]{4}', name)
                  or re.fullmatch('Saved seed [0-9]{4}', name))
    return variety if is_default else name


def how_much(i):
    """mySeedsModel.js howMuch."""
    if is_saved_lot(i):
        return lot_measure(i)
    qty = format_qty(i.get('quantity_on_hand'))
    if qty == '':
        return ''
    unit = _js_trim(_js_str(i.get('unit')))
    if unit in ('packet', ''):
        return f"{qty} {'packet' if qty == '1' else 'packets'}"
    if unit == 'each':
        return f"{qty} {'seed' if qty == '1' else 'seeds'}"
    return f'{qty} {unit}'


def where_from(i, vendor_of):
    """mySeedsModel.js whereFrom — the vendor from the REGISTRY, never the `source` column."""
    if not _blank(i.get('source_plant_id')):
        return 'Saved from my plant'
    kind = _js_trim(_js_str(i.get('source_kind')))
    if kind == 'own_garden':
        return 'Saved from my garden'
    if kind:
        return 'Saved · ' + kind.replace('_', ' ')
    if is_saved_lot(i):
        return 'Saved'
    return _js_trim(_js_str(vendor_of(i))) if vendor_of else ''


def _js_year(v):
    """Number(String(v ?? '').slice(0, 4)) when it is an integer year past 1900, else None."""
    y = _js_number(_js_str(v)[:4])
    return int(y) if _finite(y) and y == math.floor(y) and y > 1900 else None


def age_of(i):
    """mySeedsModel.js ageOf: (year, kind) or None."""
    y = _js_number(i.get('year_harvested'))
    if _finite(y) and y == math.floor(y) and y > 1900:
        return int(y), 'harvested'
    if is_in_process(i):
        sy = _js_year(i.get('stage_entered_at'))
        if sy is not None:
            return sy, 'harvested'
    py = _js_year(i.get('purchase_date'))
    if py is not None:
        return py, 'bought'
    return None


def how_old(i):
    a = age_of(i)
    return f'{a[1]} {a[0]}' if a else ''


def et_day(value):
    """harvestSummary.js etDay: the calendar date in Eastern, 'YYYY-MM-DD'. A date-only string is
    already a day and passes through; a timestamp with no offset is read as the phone's local time."""
    if _blank(value):
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, date):
        return value.isoformat()
    else:
        s = str(value)
        if re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', s):
            return s
        try:
            dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ET)
    return dt.astimezone(ET).date().isoformat()


def elapsed_days(iso, now):
    """seedLots.js elapsedDays: whole CALENDAR days in Eastern, None when absent or unparseable."""
    if not iso:
        return None
    frm, to = et_day(iso), et_day(now)
    if not frm or not to:
        return None
    return (date.fromisoformat(to) - date.fromisoformat(frm)).days


def state_chips(i, now, year):
    """mySeedsModel.js stateChips — the LABELS, in the engine's order."""
    chips = []
    if is_in_process(i):
        if _js_trim(str(i.get('seed_stage'))).lower() == 'fermenting':
            d = elapsed_days(i.get('stage_entered_at'), now)
            chips.append('Fermenting' if d is None else 'Fermenting · today' if d <= 0 else f'Fermenting · day {d}')
        else:
            chips.append('Drying')
    elif is_unstarted_save(i):
        chips.append('Not started')
    if is_archived_for_season(i, year):
        chips.append('Archived for this season')
    status = _js_str(i.get('status') if i.get('status') is not None else 'active')
    if status != 'active':
        chips.append(status[:1].upper() + status[1:])
    return chips


def line_text(i, vendor_of, now, year):
    """mySeedsModel.js lineText: the second line as one string — what row uniqueness is computed over."""
    facts = [f for f in (how_much(i), where_from(i, vendor_of), how_old(i)) if f]
    return ' · '.join(state_chips(i, now, year) + facts)


def label_candidates(rows, facts, title):
    """seedLots.js labelCandidates: an ordinal on every colliding (title, line), then the row id as
    the last resort. Returns [{'item', 'title', 'detail'}] in input order."""
    base = [(r, title(r), facts(r)) for r in rows]
    size = Counter(f'{t}\n{f}' for _, t, f in base)
    nth = Counter()
    labelled = []
    for r, t, f in base:
        k = f'{t}\n{f}'
        total = size[k]
        if total < 2:
            labelled.append((r, t, f))
            continue
        nth[k] += 1
        ordinal = f'{nth[k]} of {total} with identical details'
        labelled.append((r, t, f'{f} · {ordinal}' if f else ordinal))
    used, out = set(), []
    for r, t, d in labelled:
        full = f'{t}\n{d}'
        if full not in used:
            used.add(full)
            out.append({'item': r, 'title': t, 'detail': d})
            continue
        tail = '#' + _js_str(r.get('id'))
        out.append({'item': r, 'title': t, 'detail': f'{d} · {tail}' if d else tail})
    return out


def vendor_resolver(sources):
    """MySeeds.jsx vendorOf: source_id -> the registry row's name, '' when unregistered."""
    by_id = {str(s['id']): s['name'] for s in sources or []}
    return lambda i: by_id.get(str(i['source_id']), '') if i.get('source_id') is not None else ''


def my_seeds_screens(rows, vendor_of, now, year):
    """The two things My seeds can have on screen with no search or chip active — Sowed previously
    collapsed (the default) and open — each with its collisions BEFORE and AFTER labelCandidates.

    COUNTS DO NOT DEPEND ON ROW ORDER, which is why this does not re-derive the page's sort: a
    collision is a property of the multiset of rendered lines, and the ordinal hands every member of a
    group a distinct "k of n" whatever order it meets them in. Only the NUMBERING follows the order.
    """
    line_of = lambda r: line_text(r, vendor_of, now, year)  # noqa: E731
    main = [r for r in rows if not is_sowed_previously(r)]
    sowed = [r for r in rows if is_sowed_previously(r)]
    out = {}
    for name, on_screen in (('default', main), ('sowed_open', main + sowed)):
        before, before_rows = group_labels(
            [{'id': r['id'], 'label': f'{row_title(r)}\n{line_of(r)}'} for r in on_screen])
        labels = label_candidates(on_screen, line_of, row_title)
        after, after_rows = group_labels(
            [{'id': lab['item']['id'], 'label': f"{lab['title']}\n{lab['detail']}"} for lab in labels])
        out[name] = {'on_screen': len(on_screen), 'before_rows': before_rows, 'before_groups': before,
                     'after_rows': after_rows, 'after_groups': after}
    out['sowed_previously'] = len(sowed)
    return out


# The My seeds population is GET /api/inventory-items?category=seeds exactly
# (lambda/inventory-items/index.js): every live seeds row — NO status or stage filter, a retired packet
# is on the page with a status chip — plus the three projections the list adds. stage_entered_at is the
# same LATERAL, newest log entry for the CURRENT stage by created_at; no COALESCE to updated_at.
MYSEEDS_SQL = """
SELECT i.id::text                AS id,
       i.name                    AS name,
       pv.display_name           AS variety_name,
       i.seed_stage              AS seed_stage,
       se.entered_at             AS stage_entered_at,
       i.source_plant_id::text   AS source_plant_id,
       i.source_kind             AS source_kind,
       i.source_id::text         AS source_id,
       i.quantity_on_hand        AS quantity_on_hand,
       i.unit                    AS unit,
       i.status                  AS status,
       i.purchase_date           AS purchase_date,
       i.year_harvested          AS year_harvested,
       i.seed_count              AS seed_count,
       i.seed_weight_g           AS seed_weight_g,
       i.seed_count_estimated    AS seed_count_estimated,
       i.sow_archived_season     AS sow_archived_season,
       i.created_by              AS created_by
  FROM public.inventory_items i
  LEFT JOIN public.cultivar pv ON pv.id = i.variety_id
  LEFT JOIN LATERAL (
         SELECT sl.entered_at
           FROM public.seed_lot_stage_log sl
          WHERE i.seed_stage IS NOT NULL
            AND sl.inventory_item_id = i.id
            AND sl.stage = i.seed_stage
          ORDER BY sl.created_at DESC, sl.entered_at DESC, sl.id DESC
          LIMIT 1
       ) se ON TRUE
 WHERE i.category = 'seeds'
   AND i.deleted_at IS NULL
   {household}
 ORDER BY i.created_at DESC
"""

# GET /api/varieties/sources: global, not household-scoped (lambda/varieties/index.js).
SOURCES_SQL = "SELECT id::text AS id, name FROM public.source WHERE deleted_at IS NULL ORDER BY name ASC"


def build_myseeds_sql(household_ids):
    return MYSEEDS_SQL.format(household='AND i.created_by = ANY(%(household)s)' if household_ids else '')


def _iso_utc(dt):
    """A timestamp as JSON.stringify(new Date(...)) writes it: UTC, milliseconds, 'Z'."""
    u = dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return u.strftime('%Y-%m-%dT%H:%M:%S.') + f'{u.microsecond // 1000:03d}Z'


def to_wire(row):
    """A psycopg row in the shape the page receives: timestamps and dates as ISO strings, numerics as
    their text (the neon driver returns numeric as a string, e.g. '1.000'), uuids as text."""
    out = {}
    for k, v in row.items():
        if isinstance(v, datetime):
            out[k] = _iso_utc(v)
        elif isinstance(v, date):
            out[k] = f'{v.isoformat()}T00:00:00.000Z'
        elif isinstance(v, (Decimal, uuid.UUID)):
            out[k] = str(v)
        else:
            out[k] = v
    return out


def fetch_myseeds(url, household_ids):
    """(rows, sources) over one read-only connection, or None when it cannot be read."""
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError:
        print("\nFATAL: psycopg (v3) is not installed.", file=sys.stderr)
        print("  Fix: pip install 'psycopg[binary]'", file=sys.stderr)
        return None
    params = {'household': household_ids} if household_ids else {}
    try:
        with psycopg.connect(url) as conn:
            conn.read_only = True          # layer 2: the server rejects any write
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(build_myseeds_sql(household_ids), params)
                rows = cur.fetchall()
                cur.execute(SOURCES_SQL)
                sources = cur.fetchall()
        return [to_wire(r) for r in rows], [to_wire(s) for s in sources]
    except Exception as exc:
        print(f"\nFATAL: could not read the seed rows: {type(exc).__name__}: {exc}", file=sys.stderr)
        return None


def run_myseeds(args, url, var, household_ids):
    fetched = fetch_myseeds(url, household_ids)
    if fetched is None:
        return 2
    rows, sources = fetched
    if not rows:
        print(f"\nFATAL: 0 rows examined ({var}, surface=myseeds"
              f"{', household=' + ','.join(household_ids) if household_ids else ''}).", file=sys.stderr)
        print("  An empty population scores a perfect zero. That is not a pass -- it means this "
              "measured nothing.", file=sys.stderr)
        return 2

    # The phone's clock: chips read "Fermenting · day N" in Eastern calendar days, and the archive chip
    # is this Eastern year's season — so the line, and the collisions, are as of this run.
    now = datetime.now(timezone.utc)
    year = now.astimezone(ET).year
    screens = my_seeds_screens(rows, vendor_resolver(sources), now, year)
    over = max(screens['default']['after_rows'], screens['sowed_open']['after_rows'])

    if args.json:
        print(json.dumps({
            'env': args.env, 'source_var': var, 'surface': 'myseeds', 'household': household_ids,
            'as_of': _iso_utc(now), 'rows_examined': len(rows), 'sources_registry': len(sources),
            'sowed_previously': screens['sowed_previously'], 'threshold': args.max,
            'screens': {k: screens[k] for k in ('default', 'sowed_open')},
        }, indent=2, default=str))
    else:
        print(f"\nMy seeds row labels — {args.env} ({var}), surface=myseeds"
              f"{', household=' + ','.join(household_ids) if household_ids else ', household=ALL'}"
              f", as of {now.astimezone(ET):%Y-%m-%d %H:%M} ET")
        print(f"  rows examined     : {len(rows)}  (source registry: {len(sources)} vendors)")
        for key, label in (('default', 'Sowed previously collapsed (the default)'),
                           ('sowed_open', 'Sowed previously open')):
            s = screens[key]
            print(f"  on screen, {label}: {s['on_screen']} rows")
            print(f"    BEFORE the ordinal : {s['before_rows']} rows in {len(s['before_groups'])} group(s) "
                  f"render an identical title + second line")
            print(f"    AFTER the ordinal  : {s['after_rows']} rows")
        groups = screens['sowed_open']['before_groups']
        if groups:
            print(f"\n  The colliding lines before the ordinal ({min(len(groups), args.limit_groups)} of "
                  f"{len(groups)} shown, biggest first, Sowed previously open):")
            for g in groups[:args.limit_groups]:
                print(f"      {g['count']}x  {g['label'].replace(chr(10), '  |  ')}")

    if over > args.max:
        print(f"\nFAIL: {over} rows still render a title + line another row renders AFTER the ordinal "
              f"(threshold {args.max}) — the id backstop only holds while ids are unique.", file=sys.stderr)
        return 1
    print(f"\nPASS: {over} ambiguous row(s) after the ordinal, at or below the threshold of {args.max}.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--env', choices=('prod', 'staging'), default='prod',
                    help='which database (reads NEON_DATABASE_URL / NEON_STAGING_URL)')
    ap.add_argument('--surface', choices=('picker', 'myseeds'), default='picker',
                    help="picker = the Saved seeds candidate picker's one-line labels; "
                         "myseeds = My seeds' title + second line, before and after the on-screen ordinal")
    ap.add_argument('--scope', choices=('picker', 'seeds'), default='picker',
                    help="picker = what the candidate list offers (untracked + active); "
                         "seeds = every live seeds row (--surface picker only)")
    ap.add_argument('--max', type=int, default=0, metavar='N',
                    help='exit 1 when more than N rows sit in an ambiguous group (default 0)')
    ap.add_argument('--json', action='store_true', help='emit the finding as JSON on stdout')
    ap.add_argument('--limit-groups', type=int, default=40, metavar='N',
                    help='how many groups to print in the human listing (default 40)')
    args = ap.parse_args(argv)

    url, var = resolve_url(args.env)
    if not url:
        return 2

    # Household scoping is optional and comes from the environment, not the command line, for the
    # same reason the DSN does. Unset means EVERY non-deleted seeds row in the database, which on
    # this single-household deployment is exactly what the picker shows -- stated out loud rather
    # than assumed, because on any other deployment it would not be.
    raw = os.environ.get('SEED_LABEL_CREATED_BY', '').strip()
    household_ids = [x.strip() for x in raw.split(',') if x.strip()] or None

    if args.surface == 'myseeds':
        return run_myseeds(args, url, var, household_ids)

    rows = fetch_rows(url, args.scope, household_ids)
    if rows is None:
        return 2

    # THE INSTRUMENT CHECK. "0 ambiguous" and "0 examined" are the same number and opposite
    # meanings; the second is what a wrong DSN, an empty branch, a mis-scoped household filter or a
    # renamed column all look like. Refuse to report a finding over an empty population.
    if not rows:
        print(f"\nFATAL: 0 rows examined ({var}, scope={args.scope}"
              f"{', household=' + ','.join(household_ids) if household_ids else ''}).",
              file=sys.stderr)
        print("  An empty population scores a perfect zero. That is not a pass -- it means this "
              "measured nothing.", file=sys.stderr)
        print("  Check the DSN points at a database with seed rows, and that the scope/household "
              "filter is not excluding everything.", file=sys.stderr)
        return 2

    groups, ambiguous_rows = group_labels(rows)
    by_id = {r['id']: r for r in rows}

    payload = {
        'env': args.env, 'source_var': var, 'scope': args.scope,
        'household': household_ids,
        'rows_examined': len(rows),
        'distinct_labels': len({r['label'] for r in rows}),
        'ambiguous_rows': ambiguous_rows,
        'ambiguous_groups': len(groups),
        'threshold': args.max,
        'groups': [
            {**g, 'still_differ_by': distinguishing_facts([by_id[i] for i in g['ids']])}
            for g in groups
        ],
    }

    if args.json:
        print(json.dumps(payload, indent=2, default=str))
    else:
        print(f"\nSaved-seeds candidate labels — {args.env} ({var}), scope={args.scope}"
              f"{', household=' + ','.join(household_ids) if household_ids else ', household=ALL'}")
        print(f"  rows examined     : {payload['rows_examined']}")
        print(f"  distinct labels   : {payload['distinct_labels']}")
        print(f"  AMBIGUOUS ROWS    : {ambiguous_rows}  "
              f"(in {len(groups)} group(s) that render a byte-identical line)")
        if groups:
            print(f"\n  The colliding labels ({min(len(groups), args.limit_groups)} of {len(groups)} shown, biggest first):")
            for g in groups[:args.limit_groups]:
                differ = distinguishing_facts([by_id[i] for i in g['ids']])
                tail = (' — still differ by ' + ', '.join(differ)) if differ else \
                       ' — NOTHING on the record differs'
                label = g['label'] if g['label'] else '(empty label — renders a blank row)'
                print(f"      {g['count']}x  {label}{tail}")
            if len(groups) > args.limit_groups:
                print(f"      … and {len(groups) - args.limit_groups} more (use --json for all)")

    if ambiguous_rows > args.max:
        print(f"\nFAIL: {ambiguous_rows} rows render a label another row also renders "
              f"(threshold {args.max}).", file=sys.stderr)
        return 1
    print(f"\nPASS: {ambiguous_rows} ambiguous row(s), at or below the threshold of {args.max}.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
