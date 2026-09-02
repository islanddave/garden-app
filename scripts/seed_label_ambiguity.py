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

EXIT CODES (house convention, cf. gate_runner.py / check-staging-drift.py)
  0  ran; the ambiguous-row count is at or below --max
  1  ran; the count EXCEEDS --max  (this is what makes it gate-able later)
  2  could not run -- missing DSN, psycopg absent, database unreachable, or an EMPTY population.
     Never a silent pass: unmeasured is UNKNOWN, not zero.

USAGE
  NEON_DATABASE_URL=... python3 scripts/seed_label_ambiguity.py
  NEON_DATABASE_URL=... python3 scripts/seed_label_ambiguity.py --max 0 --json
  NEON_STAGING_URL=...  python3 scripts/seed_label_ambiguity.py --env staging --scope seeds
"""
import argparse
import json
import os
import sys
from collections import Counter, defaultdict

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


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--env', choices=('prod', 'staging'), default='prod',
                    help='which database (reads NEON_DATABASE_URL / NEON_STAGING_URL)')
    ap.add_argument('--scope', choices=('picker', 'seeds'), default='picker',
                    help="picker = what the candidate list offers (untracked + active); "
                         "seeds = every live seeds row")
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
