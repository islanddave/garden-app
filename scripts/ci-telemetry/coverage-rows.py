#!/usr/bin/env python3
"""The A3 trial's coverage comparison, as a command: two unit-pass logs of one commit, one per shape.

Run: python3 scripts/ci-telemetry/coverage-rows.py <build-and-test job log> <unit-utc-cov job log>
     (a job log: gh api repos/islanddave/garden-app/actions/jobs/<job id>/logs > file; a local `npm test` log reads
     the same)

ci.yml runs the unit suite jsdom-everything; ci-next.yml's unit legs run the DOM-free files in vitest's `node`
project (THE A3 TRIAL in .github/workflows/ci-next.yml). Neither workflow uploads a coverage artefact, so what the
two shapes covered exists only as the text table `vitest run --coverage` prints into each job's log. This reads
that table out of both logs and compares the DIRECTORY rows:

  - `All files` and `lambda/daily-plan` are left out. v8 does not measure lambda/daily-plan reproducibly in either
    shape (one tree, same shape: 2,646 to 2,747 of 3,381 branches), and the total carries that directory's noise.
  - every other directory row must be in both logs with the same % Funcs and % Lines. Statements and branches are
    not compared: outside lambda/daily-plan they moved by up to 4 and 8 between runs of one tree in one shape,
    while covered lines and covered functions were equal in 11 of 11.

Exit 0 and COVERAGE-SAME; exit 1 and COVERAGE-DIFFERS with each row that differs or is in one log only; exit 2 and
COVERAGE-UNREADABLE when a log does not hold exactly one coverage table this can read. A row that differs is a
finding to explain, never noise. Tested in scripts/test_coverage_rows.py.
"""
import re
import sys

EXCLUDED = ("All files", "lambda/daily-plan")
MIN_ROWS = 10  # compared rows a real table has had since before the trial (15 on 2026-09-29, 21 on 2026-10-07)
ANSI = re.compile(r"\x1b\[[0-9;]*m")
# One table row: a runner's timestamp or none, the reporter's indent (none for the total, one space for a directory,
# two for a file), the label, then % Stmts | % Branch | % Funcs | % Lines.
ROW = re.compile(r"^(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?( *)(\S[^|]*?) *\|"
                 r" *([\d.]+) *\| *([\d.]+) *\| *([\d.]+) *\| *([\d.]+) *\|")


class Unreadable(Exception):
    pass


def rows(text):
    """{directory label: (% Funcs, % Lines)} for every directory row of the one coverage table in `text`, the two
    EXCLUDED rows left out. Labels are the reporter's own, so a long path reads as it is printed (`...mponents/forms`)."""
    seen = {}
    for line in text.split("\n"):
        found = ROW.match(ANSI.sub("", line))
        if not found or len(found.group(1)) > 1:
            continue
        label = found.group(2)
        if label in seen:
            raise Unreadable("the row %r is there twice: two coverage tables, or two directories the reporter "
                             "shortened to one label" % label)
        seen[label] = (found.group(5), found.group(6))
    missing = [label for label in EXCLUDED if label not in seen]
    if missing:
        raise Unreadable("no row %s: no coverage table, or one whose labels are not printed as this expects"
                         % " / ".join(repr(label) for label in missing))
    out = {label: figures for label, figures in seen.items() if label not in EXCLUDED}
    if len(out) < MIN_ROWS:
        raise Unreadable("%d directory rows besides %s, want at least %d: the table is cut short"
                         % (len(out), " and ".join(EXCLUDED), MIN_ROWS))
    return out


def differing(serial, shadow):
    """Every label whose (% Funcs, % Lines) is not the same on both sides; a row in one log only is one of them."""
    return sorted(label for label in set(serial) | set(shadow) if serial.get(label) != shadow.get(label))


def _said(figures):
    return "no such row" if figures is None else "%% Funcs %s, %% Lines %s" % figures


def main(argv):
    if len(argv) != 3:
        print("usage: coverage-rows.py SERIAL_LOG SHADOW_LOG", file=sys.stderr)
        return 2
    sides = []
    for path in argv[1:]:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                sides.append(rows(fh.read()))
        except (OSError, Unreadable) as err:
            print("COVERAGE-UNREADABLE: %s: %s" % (path, err))
            return 2
    serial, shadow = sides
    bad = differing(serial, shadow)
    if bad:
        print("COVERAGE-DIFFERS: %d of %d directory rows outside %s" % (len(bad), len(set(serial) | set(shadow)),
                                                                        EXCLUDED[1]))
        for label in bad:
            print("  %s: serial %s; shadow %s" % (label, _said(serial.get(label)), _said(shadow.get(label))))
        return 1
    print("COVERAGE-SAME: %d directory rows outside %s, %% Funcs and %% Lines equal" % (len(serial), EXCLUDED[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
