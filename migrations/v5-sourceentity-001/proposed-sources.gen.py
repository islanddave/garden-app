#!/usr/bin/env python3
"""Emit proposed-sources.csv — the CATALOGUE implied by dedupe-mapping.csv.

dedupe-mapping.csv answers "where does each of the 73 strings go". This answers "what rows would
therefore exist in public.source", which is the other half Dave has to approve: it is the list of
labels that will appear in the picker forever after.

Sources reached ONLY as an acquired_from (a shop named inside a parenthetical, never on its own)
have no spelling of their own and would otherwise be invisible in the mapping. They are added here
explicitly and marked, because they are real rows the backfill must create.
"""
import csv, sys, pathlib, collections

SRC = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])

# Canonical sources that appear ONLY as a proposed_acquired_from. name -> (kind, locality, site,
# notes_seed, why).
IMPLIED = {
    "Gardener’s Supply Company": (
        "garden_center", "Hadley, MA", "",
        "Retail store. Stocks Botanical Interests, Seed Savers Exchange and High Mowing packets - "
        "12 seed lots so far are branded goods bought here rather than mail-ordered.",
        "Named only inside three '(via ...)' parentheticals and in metadata.purchase_location on 12 "
        "rows; it has no free-text spelling of its own, so the mapping alone would never create it. "
        "This is the row that makes Dave's brand-vs-shop question answerable."),

    # ADDED 2026-09-04. This dict existed to catch exactly this case and caught only one of the two:
    # the backfill generator's invariant check (every proposed_acquired_from must exist in the
    # catalogue) hard-failed on it. Without that check the 12 "Jen from Four Phantoms" plants would
    # have silently kept a NULL acquired_from_source_id while everything reported success — the shop
    # half of a split quietly dropped, which is the exact loss the two-FK design exists to prevent.
    # Facts are Dave-confirmed 2026-09-03 (recorded in the mapping's reason for that spelling): Four
    # Phantoms is Four Phantoms Brewing Company, 301 Wells St, Greenfield MA, and the Jen named is a
    # CO-OWNER of the brewery — not Dave's partner Jen.
    # kind 'organization', not 'retail' or 'market': it is a brewery, not a place he shops for
    # plants. It is where he met the person, which is what acquired_from means.
    "Four Phantoms Brewing Company": (
        "organization", "Greenfield, MA", "",
        "Brewery at 301 Wells St. Not a plant source in its own right - it is where Dave met Jen, a "
        "co-owner, who gave him 12 plants. The venue half of a person-met-at-a-place split.",
        "Named only as the acquired_from of 'Jen from Four Phantoms' (12 rows); it has no free-text "
        "spelling of its own, so the mapping alone would never create it. Dave confirmed the "
        "identity and the co-owner relationship on 2026-09-03."),
}

rows = list(csv.DictReader(SRC.open(encoding="utf-8")))
by_name = collections.OrderedDict()

# How many prod rows would point at each source as acquired_from_source_id (the SHOP half of a
# split). Counted separately from rows_affected, which is the source_id half - a source that is only
# ever a shop would otherwise read as "0 rows" and look ignorable.
acq = collections.Counter()
for r in rows:
    if r["proposed_acquired_from"]:
        acq[r["proposed_acquired_from"]] += int(r["rows_in_prod"])

for r in rows:
    n = r["proposed_source_name"]
    e = by_name.setdefault(n, dict(
        proposed_source_name=n, proposed_kind=r["proposed_kind"],
        proposed_locality=r["proposed_locality"], proposed_address="",
        proposed_website=r["proposed_website"], notes_seed="",
        rows_affected=0, spellings_merged=0, spelling_examples=[],
        confidence=r["confidence"], needs_dave=False, why=""))
    e["rows_affected"] += int(r["rows_in_prod"])
    e["spellings_merged"] += 1
    e["spelling_examples"].append(r["spelling"])
    if r["proposed_website"] and not e["proposed_website"]:
        e["proposed_website"] = r["proposed_website"]
    if r["proposed_locality"] and not e["proposed_locality"]:
        e["proposed_locality"] = r["proposed_locality"]
    order = {"high": 0, "medium": 1, "low": 2}
    if order[r["confidence"]] > order[e["confidence"]]:
        e["confidence"] = r["confidence"]
    if r["action"] == "REVIEW" or r["confidence"] != "high":
        e["needs_dave"] = True
        if not e["why"]:
            e["why"] = r["reason"]

# Dave's named example: the address that must stop living in the name.
if "Chapley Gardens" in by_name:
    by_name["Chapley Gardens"]["proposed_address"] = "397 Greenfield Rd"
if "Trust stand, Upper Road" in by_name:
    by_name["Trust stand, Upper Road"]["proposed_address"] = "Upper Road"

for n, (kind, loc, site, notes, why) in IMPLIED.items():
    by_name[n] = dict(proposed_source_name=n, proposed_kind=kind, proposed_locality=loc,
                      proposed_address="", proposed_website=site, notes_seed=notes,
                      rows_affected=0, spellings_merged=0,
                      spelling_examples=["(no spelling of its own)"],
                      confidence="high", needs_dave=True, why=why)

for n, e in by_name.items():
    e["rows_as_acquired_from"] = acq.get(n, 0)

FIELDS = ["proposed_source_name", "proposed_kind", "proposed_locality", "proposed_address",
          "proposed_website", "notes_seed", "rows_affected", "rows_as_acquired_from",
          "spellings_merged", "spelling_examples", "confidence", "needs_dave", "why"]
out = sorted(by_name.values(),
             key=lambda e: (-(e["rows_affected"] + e["rows_as_acquired_from"]),
                            e["proposed_source_name"].lower()))
with OUT.open("w", newline="", encoding="utf-8") as fh:
    w = csv.DictWriter(fh, fieldnames=FIELDS, quoting=csv.QUOTE_ALL, lineterminator="\n")
    w.writeheader()
    for e in out:
        e = dict(e)
        e["spelling_examples"] = " | ".join(e["spelling_examples"])
        e["needs_dave"] = "YES" if e["needs_dave"] else ""
        w.writerow(e)

print(f"OK  {len(out)} proposed source rows "
      f"({len(out) - len(IMPLIED)} from spellings + {len(IMPLIED)} implied by a split)")
print(f"    needing Dave: {sum(1 for e in out if e['needs_dave'])}")
print(f"    with a website: {sum(1 for e in out if e['proposed_website'])} "
      f"(only URLs evidenced in prod data - none inferred)")
kinds = collections.Counter(e["proposed_kind"] for e in out)
print("    kind distribution: " + ", ".join(f"{k}={v}" for k, v in sorted(kinds.items())))
