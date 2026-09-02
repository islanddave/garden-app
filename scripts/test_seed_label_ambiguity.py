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
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import seed_label_ambiguity as sla  # noqa: E402


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
