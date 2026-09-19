#!/usr/bin/env python3
"""Tests for scripts/seed_label_ambiguity.py (BUG-SEEDCANDIDATEAMBIG-001).

No database. The grouping logic is pure, which is the point of separating it from the query --
the number this script reports has to be provable without prod, or it is a number nobody can check.

The fixture rows are the REAL prod distribution measured 2026-09-02 (NEON_DATABASE_URL, scope
picker): 260 rows, 233 distinct labels, 51 rows in 24 colliding groups, the two biggest being
Serrano x4 and Hot Portugal x3. An invented fixture would repeat nothing -- these repeat the exact
shape the script exists to count, including the fact that every real group is separated by `source`
and most also by `purchase_date`.

The one case NOT taken from prod is `test_distinguishing_facts_empty_when_nothing_differs`, and it
is flagged rather than dressed up: prod today has no pair where every recorded fact matches. The
branch still has to answer correctly the day one appears -- that is the pair no row design can
separate -- so it is tested with a synthetic input and labelled as one.
"""
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import seed_label_ambiguity as sla  # noqa: E402

REPO = Path(__file__).resolve().parent.parent


def row(rid, label, **facts):
    base = {'id': rid, 'label': label, 'name': label, 'variety_name': label,
            'source': None, 'quantity_on_hand': None, 'purchase_date': None,
            'seed_stage': None, 'status': 'active', 'created_by': 'u1'}
    base.update(facts)
    return base


# Real prod rows, trimmed to the two biggest groups plus two rows that collide with nothing.
PROD_SHAPE = [
    row('a1', 'Serrano', source='Fedco', purchase_date='2026-01-04', quantity_on_hand=1),
    row('a2', 'Serrano', source='Johnnys', purchase_date='2026-02-11', quantity_on_hand=2),
    row('a3', 'Serrano', source='Baker Creek', purchase_date='2026-02-11', quantity_on_hand=1),
    row('a4', 'Serrano', source='Fedco', purchase_date='2025-12-30', quantity_on_hand=3),
    row('b1', 'Hot Portugal', source='Fedco'),
    row('b2', 'Hot Portugal', source='Johnnys'),
    row('b3', 'Hot Portugal', source='Baker Creek'),
    row('c1', 'Pennsylvania Dutch Crookneck', source='Fedco'),
    row('d1', '1884', source='Johnnys'),
]


def test_counts_rows_in_colliding_groups_not_the_groups():
    """51-of-260 is a ROW count. 24 groups of two is a smaller problem than 24 groups of five, and
    reporting the group count would have called this a 24."""
    groups, ambiguous = sla.group_labels(PROD_SHAPE)
    assert ambiguous == 7            # 4 Serrano + 3 Hot Portugal
    assert len(groups) == 2
    assert [g['label'] for g in groups] == ['Serrano', 'Hot Portugal']   # biggest first
    assert groups[0]['ids'] == ['a1', 'a2', 'a3', 'a4']


def test_a_label_rendered_once_is_not_ambiguous():
    """The off-by-one that would double the number: a group of ONE is a row nobody can confuse."""
    groups, ambiguous = sla.group_labels([row('c1', 'Pennsylvania Dutch Crookneck')])
    assert groups == []
    assert ambiguous == 0


def test_zero_collisions_over_a_real_population_is_a_real_zero():
    """The redesign's criterion. Distinct labels over a NON-empty population must read 0 -- and the
    caller can tell this apart from an empty population because it also gets the row count."""
    rows = [row('x1', 'Serrano'), row('x2', 'Hot Portugal'), row('x3', '1884')]
    groups, ambiguous = sla.group_labels(rows)
    assert (groups, ambiguous) == ([], 0)
    assert len(rows) == 3            # the denominator the finding is meaningless without


def test_empty_labels_collide_with_each_other():
    """Two blank rows are exactly as indistinguishable as two identical ones, and a row with no
    label at all is its own defect. Excluding '' would have hidden both."""
    groups, ambiguous = sla.group_labels([row('e1', ''), row('e2', ''), row('e3', 'Serrano')])
    assert ambiguous == 2
    assert groups[0]['label'] == ''


def test_group_order_is_deterministic():
    """Two runs over the same data must print the same order, or a diff between runs is noise.
    Equal-sized groups tie-break alphabetically."""
    rows = [row('m1', 'Zebra'), row('m2', 'Zebra'), row('m3', 'Apple'), row('m4', 'Apple')]
    first, _ = sla.group_labels(rows)
    second, _ = sla.group_labels(list(reversed(rows)))
    assert [g['label'] for g in first] == ['Apple', 'Zebra']
    assert [g['label'] for g in second] == ['Apple', 'Zebra']


def test_distinguishing_facts_names_what_still_differs():
    """Every real group is separated by `source`; most are also separated by `purchase_date`. That
    is the difference between a collision a redesigned row could fix and one it could not."""
    serrano = [r for r in PROD_SHAPE if r['label'] == 'Serrano']
    assert sla.distinguishing_facts(serrano) == ['source', 'purchase_date', 'quantity_on_hand']
    portugal = [r for r in PROD_SHAPE if r['label'] == 'Hot Portugal']
    assert sla.distinguishing_facts(portugal) == ['source']


def test_distinguishing_facts_empty_when_nothing_differs():
    """SYNTHETIC, and flagged as such: prod has no such pair today. It is the case that matters most
    if one appears -- two rows identical in every recorded fact cannot be separated by row design at
    all, only by an ordinal or a merge, so the empty list must not be confused with 'not checked'."""
    twins = [row('t1', 'Serrano', source='Fedco', purchase_date='2026-01-04', quantity_on_hand=1),
             row('t2', 'Serrano', source='Fedco', purchase_date='2026-01-04', quantity_on_hand=1)]
    assert sla.distinguishing_facts(twins) == []


def test_label_expression_survives_an_empty_string_variety_name():
    """JS `variety_name || name` falls through on '' as well as null; a bare COALESCE would not, and
    would render a blank row while reporting a name. The NULLIFs are that difference."""
    sql = sla.build_sql('picker', None)
    assert "NULLIF(pv.display_name, '')" in sql
    assert "NULLIF(i.name, '')" in sql


def test_picker_scope_carries_the_client_side_filters():
    """The picker's population is not just `category='seeds'` -- SavedSeeds.jsx also requires
    status='active' and no seed stage. Measuring the wider set would over-report."""
    picker = sla.build_sql('picker', None)
    assert "i.status = 'active'" in picker
    assert 'seed_stage' in picker
    seeds = sla.build_sql('seeds', None)
    assert "i.status = 'active'" not in seeds
    assert 'seed_stage IS NULL' not in seeds


def test_household_clause_appears_only_when_scoped():
    assert 'created_by = ANY' not in sla.build_sql('picker', None)
    assert 'created_by = ANY' in sla.build_sql('picker', ['user_abc'])


def test_unknown_scope_raises_rather_than_returning_the_wrong_population():
    with pytest.raises(ValueError):
        sla.build_sql('everything', None)


# ── The instrument check itself ────────────────────────────────────────────────────────────────
# "0 ambiguous rows" and "0 rows examined" are the same number and opposite meanings. These pin the
# distinction, because it is the one that decides whether this script can ever be believed.

def test_empty_population_is_fatal_not_a_pass(monkeypatch, capsys):
    monkeypatch.setenv('NEON_DATABASE_URL', 'postgres://not-used-fetch-is-stubbed')
    monkeypatch.delenv('SEED_LABEL_CREATED_BY', raising=False)
    monkeypatch.setattr(sla, 'fetch_rows', lambda *a, **k: [])
    assert sla.main(['--max', '0']) == 2
    assert '0 rows examined' in capsys.readouterr().err


def test_unreachable_database_is_fatal_not_a_pass(monkeypatch):
    monkeypatch.setenv('NEON_DATABASE_URL', 'postgres://unreachable')
    monkeypatch.setattr(sla, 'fetch_rows', lambda *a, **k: None)
    assert sla.main(['--max', '0']) == 2


def test_missing_dsn_is_fatal_not_a_pass(monkeypatch):
    monkeypatch.delenv('NEON_DATABASE_URL', raising=False)
    assert sla.main([]) == 2


def test_over_threshold_exits_one_and_under_exits_zero(monkeypatch):
    monkeypatch.setenv('NEON_DATABASE_URL', 'postgres://not-used-fetch-is-stubbed')
    monkeypatch.delenv('SEED_LABEL_CREATED_BY', raising=False)
    monkeypatch.setattr(sla, 'fetch_rows', lambda *a, **k: PROD_SHAPE)
    assert sla.main(['--max', '0']) == 1     # 7 ambiguous rows in the fixture
    assert sla.main(['--max', '7']) == 0     # at the threshold, not over it
    assert sla.main(['--max', '99']) == 0


# ── My seeds (--surface myseeds, V5-SEEDSTAB-001) ───────────────────────────────────────────────────
# The row line is PORTED from src/components/seed/mySeedsModel.js, and a port is only worth the
# count it produces if it agrees with the real thing. So the fixture below is run through BOTH — the
# Python here and the JavaScript the page ships (test_parity_with_the_real_javascript) — and every
# title, second line and on-screen label must match. The fixture is built for coverage of the model's
# branches rather than taken from prod: each row names the branch it is there for. Two are synthetic
# on purpose and say so (the order-text-only vendor and the id-backstop collision).
#
# Rows are in the WIRE shape GET /api/inventory-items?category=seeds delivers: numerics as strings,
# timestamps as ISO-8601 UTC. NOW is noon Eastern on 2026-09-18.
NOW = datetime(2026, 9, 18, 16, 0, tzinfo=timezone.utc)
NOW_ISO = '2026-09-18T16:00:00.000Z'
YEAR = 2026
SOURCES = [{'id': 'src-fedco', 'name': 'Fedco Seeds'}, {'id': 'src-baker', 'name': 'Baker Creek Heirloom Seeds'},
           {'id': 'src-sandia', 'name': 'Sandia Seed Company'}, {'id': 'src-johnny', 'name': "Johnny's Selected Seeds"},
           {'id': 'src-coop', 'name': 'Greenfield Co-op'}, {'id': 'src-bare', 'name': 'Seeds'}]


def srow(rid, variety, **over):
    base = {'id': rid, 'name': f'{variety} packet' if variety else None, 'variety_name': variety,
            'seed_stage': None, 'stage_entered_at': None, 'source_plant_id': None, 'source_kind': None,
            'source_id': None, 'source': None, 'quantity_on_hand': '1.000', 'unit': 'packet', 'status': 'active',
            'purchase_date': None, 'year_harvested': None, 'seed_count': None, 'seed_weight_g': None,
            'seed_count_estimated': None, 'sow_archived_season': None}
    base.update(over)
    return base


BOUGHT_2026 = {'source_id': 'src-fedco', 'purchase_date': '2026-01-14T00:00:00.000Z'}
MYSEEDS = [
    # the identical pair and triple — what the ordinal exists for
    srow('s1', 'Serrano', **BOUGHT_2026, source="Order #4411 rec'd 1/14"),
    srow('s2', 'Serrano', **BOUGHT_2026, source="Order #4412 rec'd 1/14"),
    srow('h1', 'Hot Portugal', quantity_on_hand='2.000', source_id='src-baker', purchase_date='2025-12-30T00:00:00.000Z'),
    srow('h2', 'Hot Portugal', quantity_on_hand='2.000', source_id='src-baker', purchase_date='2025-12-30T00:00:00.000Z'),
    srow('h3', 'Hot Portugal', quantity_on_hand='2.000', source_id='src-baker', purchase_date='2025-12-30T00:00:00.000Z'),
    # formatQty is Math.round: half toward +Infinity, so 0.5 of a packet reads "1 packet"
    srow('q1', 'Clemson Spineless', quantity_on_hand='0.500', **BOUGHT_2026),
    srow('q2', 'Provider', quantity_on_hand='2.500', **BOUGHT_2026),
    srow('q3', 'Carolina Reaper', unit='each', quantity_on_hand='1.000'),
    srow('q4', 'Aji Lemon', unit='each', quantity_on_hand='25.000'),
    srow('q5', 'Dragon Tongue', unit='oz', quantity_on_hand='2.000'),
    srow('q6', 'Kentucky Wonder', unit=None),
    srow('q7', 'Tromboncino', quantity_on_hand=None, **BOUGHT_2026),
    srow('q8', 'Mystery Blend', quantity_on_hand='NaN'),
    # vendors come from the REGISTRY: an unregistered id prints nothing, and the order text never does
    srow('v1', 'Ancho', source_id='src-gone', purchase_date='2024-02-01T00:00:00.000Z'),
    srow('v2', 'Poblano', source="Order #9 rec'd 2/2 from Fedco"),   # SYNTHETIC: order text only
    # saved lots — chips, measures, provenance, age
    srow('l1', 'Cherokee Purple', name='Cherokee Purple — saved 2026', seed_stage='fermenting',
         stage_entered_at='2026-09-14T03:30:00.000Z', source_plant_id='pl-1'),        # 23:30 EDT Sep 13 = day 5
    srow('l2', 'Sungold', name='Sungold — saved 2026', seed_stage='fermenting',
         stage_entered_at='2026-09-18T12:00:00.000Z', source_plant_id='pl-2'),        # today
    srow('l3', 'Black Krim', name='Black Krim — saved 2026', seed_stage='fermenting', source_plant_id='pl-3'),
    srow('l4', 'Aji Charapita', name='Charapita jar', seed_stage='drying', stage_entered_at='2026-09-10T15:00:00.000Z',
         source_plant_id='pl-4', seed_count=121, seed_weight_g='1.600', seed_count_estimated=False),
    srow('l5', '1884', name='Porch jar', seed_stage='stored', source_kind='own_garden', year_harvested=2025,
         seed_count=185, seed_count_estimated=False),
    srow('l6', 'Datil', name='Saved seed 2025', seed_stage='stored', source_kind='farm_stand',
         seed_count=500, seed_count_estimated=True, seed_weight_g='0.099'),
    srow('l7', "Brandywine (Sudduth's Strain)", name="Brandywine (Sudduth's Strain) — saved 2025",
         seed_stage='stored', source_kind='own_garden', seed_weight_g='0.100', year_harvested=2025),
    srow('l8', 'Hollyhock', seed_stage='stored', source_kind='gift', seed_weight_g='9999999.990'),
    srow('l9', 'Moonflower', seed_stage='stored', source_kind='gift', seed_weight_g='28.350'),
    srow('l10', 'Lunaria', seed_stage='stored', source_kind='gift', seed_weight_g='0.000', seed_count=0,
         seed_count_estimated=False),
    # the unstarted save, both arms: nothing measured, and the legacy zero
    srow('u1', 'Tatume', name='Tatume — saved 2026', source_plant_id='pl-5'),
    srow('u2', 'Costata Romanesco', name='Costata Romanesco — saved 2026', source_plant_id='pl-6', quantity_on_hand='0.000'),
    # chips that are not stages
    srow('c1', 'Winter Density', **BOUGHT_2026, sow_archived_season=2026),
    srow('c2', 'Buttercrunch', **BOUGHT_2026, sow_archived_season='2026'),
    srow('c3', 'Salad Bowl', **BOUGHT_2026, sow_archived_season=2025),
    srow('c4', 'Sunrise Bumble Bee', **BOUGHT_2026, status='retired'),
    # titles
    srow('t1', None, name='Mystery seeds from the fair'),
    srow('t2', '  Green Zebra  ', **BOUGHT_2026),
    # used up: under Sowed previously, so on screen only when that section is open — and an identical
    # pair of them, which collides there and nowhere else
    srow('z1', 'Black Seeded Simpson', quantity_on_hand='0.000', **BOUGHT_2026),
    srow('z2', 'Black Seeded Simpson', quantity_on_hand='0.000', **BOUGHT_2026),
    # SYNTHETIC — the id backstop. y3's own line equals the ordinal y1 is handed (a status chip is the
    # one free-text part of the line that can spell it), so labelCandidates' second pass must append an
    # id to whichever of the two it meets second.
    srow('y1', 'Zinnia'),
    srow('y2', 'Zinnia'),
    srow('y3', 'Zinnia', status='1 of 2 with identical details'),
    # V5-SEEDCARDS-001 — the supplier's short name leads the line, and a pepper's heat rides in it.
    # Curated short forms, the trade-word rule, and the heat formatter's edges (a toFixed half-up tie
    # at 1,125,000; Math.round at 12,500; sweet; one-sided; a guess marked "est.").
    srow('p1', 'Carolina Reaper', source_id='src-sandia', scoville_min=1125000, scoville_max=2200000,
         scoville_source='vendor_catalog'),
    srow('p2', 'Habanero', source_id='src-johnny', scoville_min=12500, scoville_max=350000, scoville_source='inference'),
    srow('p3', 'California Wonder', source_id='src-coop', scoville_min=0, scoville_max=0, scoville_source='inference'),
    srow('p4', 'Sweet Banana', source_id='src-bare', scoville_min=0, scoville_max=500),
    srow('p5', 'Jalapeño', scoville_min=None, scoville_max=8000, quantity_on_hand='2.000'),
    srow('p6', 'Cayenne', scoville_min=1500, scoville_max=1500, scoville_source=None),
]

NODE_PARITY = r"""
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const { repo, rows, sources, now, year } = JSON.parse(readFileSync(0, 'utf8'))
const M = await import(pathToFileURL(`${repo}/src/components/seed/mySeedsModel.js`).href)
const S = await import(pathToFileURL(`${repo}/src/components/seed/seedLots.js`).href)
// MySeeds.jsx's own vendorOf and lineOf, verbatim in shape.
const byId = new Map(sources.map((s) => [String(s.id), s.name]))
const vendorOf = (i) => (i?.source_id != null ? byId.get(String(i.source_id)) ?? '' : '')
const at = new Date(now)
const lineOf = (i) => M.lineText(i, { vendorOf, now: at, year })
const main = rows.filter((i) => !M.isSowedPreviously(i))
const sowed = rows.filter(M.isSowedPreviously)
const screen = (list) => S.labelCandidates(list, lineOf, M.rowTitle).map((r) => ({ id: r.item.id, title: r.title, detail: r.detail }))
process.stdout.write(JSON.stringify({
  rows: rows.map((i) => ({ id: i.id, title: M.rowTitle(i), line: lineOf(i), sowed: M.isSowedPreviously(i) })),
  default: screen(main),
  sowed_open: screen([...main, ...sowed]),
}))
"""


def python_side(rows, sources):
    vendor_of = sla.vendor_resolver(sources)
    line_of = lambda r: sla.line_text(r, vendor_of, NOW, YEAR)  # noqa: E731
    main = [r for r in rows if not sla.is_sowed_previously(r)]
    sowed = [r for r in rows if sla.is_sowed_previously(r)]
    screen = lambda lst: [{'id': x['item']['id'], 'title': x['title'], 'detail': x['detail']}  # noqa: E731
                          for x in sla.label_candidates(lst, line_of, sla.row_title)]
    return {
        'rows': [{'id': r['id'], 'title': sla.row_title(r), 'line': line_of(r), 'sowed': sla.is_sowed_previously(r)}
                 for r in rows],
        'default': screen(main),
        'sowed_open': screen(main + sowed),
    }


def test_parity_with_the_real_javascript():
    """The whole point of the port: the page's JavaScript and this Python produce the SAME title,
    second line and on-screen label for every row. Skips ONLY when no `node` binary exists (the CI
    runner and the dev machine both have one); a skip here means the port was not checked."""
    node = shutil.which('node')
    if not node:
        pytest.skip('node is not on PATH — the port was NOT checked against mySeedsModel.js')
    payload = json.dumps({'repo': str(REPO), 'rows': MYSEEDS, 'sources': SOURCES, 'now': NOW_ISO, 'year': YEAR})
    proc = subprocess.run([node, '--input-type=module', '-e', NODE_PARITY], input=payload,
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    js = json.loads(proc.stdout)
    py = python_side(MYSEEDS, SOURCES)
    for js_row, py_row in zip(js['rows'], py['rows']):
        assert py_row == js_row, f"row {js_row['id']}: JS {js_row!r} != Python {py_row!r}"
    assert len(js['rows']) == len(py['rows']) == len(MYSEEDS)
    assert py['default'] == js['default']
    assert py['sowed_open'] == js['sowed_open']


def test_the_second_line_reads_as_the_model_builds_it():
    """Pinned without node, so the port is held even where the parity test cannot run."""
    by = {r['id']: r for r in MYSEEDS}
    v = sla.vendor_resolver(SOURCES)
    line = lambda rid: sla.line_text(by[rid], v, NOW, YEAR)  # noqa: E731
    assert line('s1') == 'Fedco · bought 2026'                    # vendor from the registry, short; "1 packet" is not printed
    assert line('v2') == ''                                       # the order text never prints
    assert line('v1') == 'bought 2024'                            # unregistered id: no vendor
    assert line('q1') == 'Fedco · bought 2026'                    # 0.5 rounds UP to 1, as Math.round — then says nothing
    assert line('q2') == 'Fedco · 3 packets · bought 2026'
    assert line('q3') == '1 seed' and line('q4') == '25 seeds' and line('q5') == '2 oz'
    assert line('q6') == '' and line('q7') == 'Fedco · bought 2026'
    assert line('l1') == 'Ferment · day 5 · Saved from my plant · harvested 2026'   # ET calendar days
    assert line('l2') == 'Ferment · today · Saved from my plant · harvested 2026'
    assert line('l3') == 'Ferment · Saved from my plant'
    assert line('l4') == 'Drying · 121 seeds · 1.6 g · Saved from my plant · harvested 2026'
    assert line('l5') == '185 seeds · Saved from my garden · harvested 2025'
    assert line('l6') == 'approx. 500 seeds · 99 mg · Saved · farm stand'
    assert line('l7') == '0.1 g · Saved from my garden · harvested 2025'
    assert line('l8') == '9999999.99 g · Saved · gift' and line('l9') == '28.35 g · Saved · gift'
    assert line('l10') == '0 seeds · 0 g · Saved · gift'                   # a counted zero DOES render
    assert line('u1') == 'Not started · Saved from my plant'
    assert line('u2') == 'Not started · Saved from my plant'
    assert line('c1') == 'Fedco · Archived for this season · bought 2026' and line('c2') == line('c1')
    assert 'Archived' not in line('c3')
    assert line('c4') == 'Fedco · Retired · bought 2026'
    # the supplier chip's label, then the heat
    assert line('p1') == 'Sandia · 1.13M–2.2M SHU'                # curated short form; toFixed's half-up tie
    assert line('p2') == "Johnny's · est. 13K–350K SHU"           # Math.round(12.5) is 13; a guess says so
    assert line('p3') == 'Greenfield · est. Sweet · 0 SHU'        # "Co-op": the trade-word rule
    assert line('p4') == 'Seeds · 0–500 SHU'                      # a name that is ALL trade words keeps itself
    assert line('p5') == '2 packets · 8K SHU' and line('p6') == '1.5K SHU'


def test_the_supplier_short_forms_match_the_javascript_palette():
    """SUPPLIER_SHORT is a copy of supplierPalette.js's curated `short`s. A supplier added or renamed
    there and not here changes the lines this script counts, so the two maps must be equal."""
    node = shutil.which('node')
    if not node:
        pytest.skip('node is not on PATH — the palette copy was NOT checked against supplierPalette.js')
    js = r"""
const M = await import(new URL(`file://${process.argv[1]}/src/lib/supplierPalette.js`).href)
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(M.SUPPLIER_COLORS).map(([k, v]) => [k, v.short]))))
"""
    proc = subprocess.run([node, '--input-type=module', '-e', js, str(REPO)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout) == sla.SUPPLIER_SHORT


def test_row_title_keeps_a_hand_typed_lot_name_and_drops_the_default():
    by = {r['id']: r for r in MYSEEDS}
    assert sla.row_title(by['l1']) == 'Cherokee Purple'            # "<variety> — saved <year>" is a default
    assert sla.row_title(by['l4']) == 'Charapita jar'              # a name somebody typed
    assert sla.row_title(by['l6']) == 'Datil'                      # "Saved seed <year>" is a default too
    assert sla.row_title(by['l7']) == "Brandywine (Sudduth's Strain)"   # regex metacharacters escaped
    assert sla.row_title(by['t1']) == 'Mystery seeds from the fair'     # no variety: the name
    assert sla.row_title(by['t2']) == 'Green Zebra'                     # trimmed
    assert sla.row_title(by['s1']) == 'Serrano'                         # a bought packet: always the variety


def test_used_up_packets_leave_the_default_screen_and_unstarted_saves_do_not():
    by = {r['id']: r for r in MYSEEDS}
    assert sla.is_sowed_previously(by['z1'])
    assert not sla.is_sowed_previously(by['u2'])      # qty 0 but saved and never started: not "sown"
    assert not sla.is_sowed_previously(by['l10'])     # a stored lot at 0 packets? no: qty is 1 jar
    assert not sla.is_sowed_previously(by['q7'])      # NULL is not zero


def test_collisions_before_and_after_the_ordinal():
    """BEFORE counts the rows the ordinal has to carry; AFTER must be zero. Serrano x2 + Hot Portugal
    x3 + the Zinnia pair collide on the default screen (7 rows, 3 groups); opening Sowed previously
    adds the used-up Black Seeded Simpson pair (9 rows, 4 groups). After labelCandidates, none."""
    s = sla.my_seeds_screens(MYSEEDS, sla.vendor_resolver(SOURCES), NOW, YEAR)
    assert s['sowed_previously'] == 2
    assert s['default']['on_screen'] == len(MYSEEDS) - 2
    assert (s['default']['before_rows'], len(s['default']['before_groups'])) == (7, 3)
    assert (s['sowed_open']['before_rows'], len(s['sowed_open']['before_groups'])) == (9, 4)
    assert s['default']['after_rows'] == 0
    assert s['sowed_open']['after_rows'] == 0


def test_the_id_backstop_fires_when_an_ordinal_meets_a_natural_line():
    """SYNTHETIC, and flagged: y3's own line IS the ordinal y1 is given. The second pass must tell them
    apart with the id — which is also why AFTER can only be non-zero when ids are not unique."""
    zinnias = [r for r in MYSEEDS if r['id'] in ('y1', 'y2', 'y3')]
    labels = sla.label_candidates(zinnias, lambda r: sla.line_text(r, None, NOW, YEAR), sla.row_title)
    details = [lab['detail'] for lab in labels]
    assert details[0] == '1 of 2 with identical details'
    assert details[1] == '2 of 2 with identical details'
    assert details[2] == '1 of 2 with identical details · #y3'


def test_ferment_days_are_eastern_calendar_days_not_24_hour_windows():
    """23:30 EDT on the 13th, read at noon on the 18th: day 5 in Eastern, where a UTC date would say 4."""
    assert sla.elapsed_days('2026-09-14T03:30:00.000Z', NOW) == 5
    assert sla.elapsed_days('2026-09-18T12:00:00.000Z', NOW) == 0
    assert sla.elapsed_days(None, NOW) is None
    assert sla.elapsed_days('not a date', NOW) is None


def test_formatters_match_the_js_edges():
    assert sla.format_qty('0.500') == '1' and sla.format_qty('2.500') == '3' and sla.format_qty('1.499') == '1'
    assert sla.format_qty(None) == '' and sla.format_qty('') == '' and sla.format_qty('NaN') == 'NaN'
    assert sla.format_seed_weight('0.100') == '0.1 g' and sla.format_seed_weight('0.099') == '99 mg'
    assert sla.format_seed_weight('0.000') == '0 g' and sla.format_seed_weight('10.000') == '10 g'
    assert sla.format_seed_weight('9999999.999') == '10000000 g'    # the widest STORED is not the widest SHOWN
    assert sla.seed_count_label(1, False) == '1 seed' and sla.seed_count_label('2147483647', True) == 'approx. 2147483647 seeds'
    assert sla._js_number('inf') != sla._js_number('inf')          # NaN in JS, whatever Python's float() says
    assert sla._js_number('1_000') != sla._js_number('1_000')


def test_to_wire_matches_what_the_page_receives():
    from decimal import Decimal
    from datetime import date
    import uuid
    w = sla.to_wire({'q': Decimal('1.000'), 't': datetime(2026, 9, 13, 23, 30, 5, 123456, tzinfo=timezone.utc),
                     'd': date(2026, 1, 14), 'u': uuid.UUID('12345678-1234-5678-1234-567812345678'), 'n': None})
    assert w == {'q': '1.000', 't': '2026-09-13T23:30:05.123Z', 'd': '2026-01-14T00:00:00.000Z',
                 'u': '12345678-1234-5678-1234-567812345678', 'n': None}


def test_myseeds_sql_is_the_list_endpoints_population():
    """Every live seeds row (the endpoint's own WHERE) with NO status or stage filter — a retired packet
    is on the page with a chip — and the stage-entered LATERAL, newest entry for the current stage."""
    sql = sla.build_myseeds_sql(None)
    assert "i.category = 'seeds'" in sql and 'i.deleted_at IS NULL' in sql
    assert "status = 'active'" not in sql
    assert 'ORDER BY sl.created_at DESC, sl.entered_at DESC, sl.id DESC' in sql
    assert 'created_by = ANY' not in sql and 'created_by = ANY' in sla.build_myseeds_sql(['user_abc'])
    assert 'deleted_at IS NULL' in sla.SOURCES_SQL


def test_myseeds_empty_population_is_fatal_not_a_pass(monkeypatch, capsys):
    monkeypatch.setenv('NEON_DATABASE_URL', 'postgres://not-used-fetch-is-stubbed')
    monkeypatch.delenv('SEED_LABEL_CREATED_BY', raising=False)
    monkeypatch.setattr(sla, 'fetch_myseeds', lambda *a, **k: ([], SOURCES))
    assert sla.main(['--surface', 'myseeds']) == 2
    assert '0 rows examined' in capsys.readouterr().err


def test_myseeds_unreachable_database_is_fatal_not_a_pass(monkeypatch):
    monkeypatch.setenv('NEON_DATABASE_URL', 'postgres://unreachable')
    monkeypatch.setattr(sla, 'fetch_myseeds', lambda *a, **k: None)
    assert sla.main(['--surface', 'myseeds']) == 2


def test_myseeds_reports_before_and_passes_on_zero_after(monkeypatch, capsys):
    monkeypatch.setenv('NEON_DATABASE_URL', 'postgres://not-used-fetch-is-stubbed')
    monkeypatch.delenv('SEED_LABEL_CREATED_BY', raising=False)
    monkeypatch.setattr(sla, 'fetch_myseeds', lambda *a, **k: (MYSEEDS, SOURCES))
    assert sla.main(['--surface', 'myseeds', '--max', '0']) == 0
    out = capsys.readouterr().out
    assert 'BEFORE the ordinal' in out and 'AFTER the ordinal  : 0 rows' in out


def test_myseeds_duplicate_ids_defeat_the_backstop_and_fail(monkeypatch):
    """SYNTHETIC, and flagged: the only way AFTER can be non-zero. The id is the backstop's one
    guaranteed-distinct fact, so rows that share an id can be handed the same label: here the
    backstopped line of the third row equals the fourth row's own line, both ending "#dup".
    inventory_items.id is a primary key, so prod cannot produce this — but a threshold that can
    never fire is not a threshold, so the exit-1 path is exercised on the one input that reaches it."""
    ordinal = '1 of 2 with identical details'
    rows = [srow('dup', 'Serrano'), srow('dup', 'Serrano'),
            srow('dup', 'Serrano', status=ordinal), srow('dup', 'Serrano', status=f'{ordinal} · #dup')]
    s = sla.my_seeds_screens(rows, sla.vendor_resolver(SOURCES), NOW, YEAR)
    assert s['default']['after_rows'] == 2
    monkeypatch.setenv('NEON_DATABASE_URL', 'postgres://not-used-fetch-is-stubbed')
    monkeypatch.delenv('SEED_LABEL_CREATED_BY', raising=False)
    monkeypatch.setattr(sla, 'fetch_myseeds', lambda *a, **k: (rows, SOURCES))
    assert sla.main(['--surface', 'myseeds', '--max', '0']) == 1
    assert sla.main(['--surface', 'myseeds', '--max', '2']) == 0
