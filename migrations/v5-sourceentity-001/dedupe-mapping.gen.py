#!/usr/bin/env python3
"""Generate dedupe-mapping.csv for V5-SOURCEENTITY-001.

The LEFT column is joined against the verbatim strings exported from live prod, and the script
HARD-FAILS on any spelling that is in one set and not the other. That is the point: a hand-typed
mapping whose left column has drifted from the data is worse than no mapping, because it looks
authoritative and silently omits rows.
"""
import csv, sys, pathlib

TSV = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])

# (parent_column, spelling) -> dict. Websites are filled ONLY where the URL is evidenced in prod
# data; nothing is filled from memory.
M = {}


def m(col, spelling, name, kind, locality, acq, conf, action, reason, residue="", site=""):
    M[(col, spelling)] = dict(
        proposed_source_name=name, proposed_kind=kind, proposed_locality=locality,
        proposed_acquired_from=acq, proposed_website=site, confidence=conf, action=action,
        reason=reason, residue_stays_in_free_text=residue)


P = "plants.source_ref"
I = "inventory_items.source"

# ── Amazon and the brands sold through it ────────────────────────────────────────────────────────
m(P, "Amazon", "Amazon", "retail", "", "", "high", "merge",
  "Same retailer as the 107 inventory rows; 9 places appear in both columns and this is one.",
  site="https://www.amazon.com")
m(I, "Amazon", "Amazon", "retail", "", "", "high", "new",
  "The single largest spelling (107 rows) across 11 item categories. Pure retailer, never a grower.",
  site="https://www.amazon.com")
m(I, "Amazon (GoveeLife)", "GoveeLife", "brand", "", "Amazon", "high", "split",
  "Brand-via-retailer, the same two-fact shape as the Gardener's Supply rows. metadata.retailer="
  "'Amazon' already says so on 10 rows.")
m(I, "Amazon (NaturesGoodGuys)", "NaturesGoodGuys", "brand", "", "Amazon", "high", "split",
  "Brand-via-retailer. Beneficial-insect supplier; the shop is Amazon.")
m(I, "Amazon (Toudura)", "Toudura", "brand", "", "Amazon", "high", "split",
  "Brand-via-retailer. Same shape as the other two Amazon parentheticals.")

# ── Botanical Interests: 5 spellings, and the brand/shop question Dave asked ──────────────────────
m(P, "Botanical Interests", "Botanical Interests", "seed_company", "", "", "high", "merge",
  "31 plants, source_type=seed_packet. Same company as the 4 inventory spellings.")
m(I, "Botanical Interests packet", "Botanical Interests", "seed_company", "", "", "high", "merge",
  "'packet' is the item format, not part of the vendor's name. metadata.vendor already reads "
  "'Botanical Interests' on all 9 rows.",
  residue="nothing - 'packet' is item-level and already implied by category='seeds'")
m(I, "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding",
  "Botanical Interests", "seed_company", "", "", "high", "merge",
  "89 rows. metadata.vendor='Botanical Interests' and metadata.origin='BI-order-2026-06-09' already "
  "carry both halves; the string is an intake note wearing a vendor's name.",
  residue="'captured 2026-06-10 as official seed->plant pipeline seeding' - an intake note with no "
          "column; keep it in source until it has one")
m(I, "Botanical Interests online order #350019 (confirmed 2026-07-08, received 2026-07-18); "
     "July 2026 intake.", "Botanical Interests", "seed_company", "", "", "high", "merge",
  "38 rows. metadata.vendor + metadata.origin='BI-order-350019-2026-07-18' already deduplicate this.",
  residue="order #350019, confirmed 2026-07-08, received 2026-07-18, 'July 2026 intake' - order "
          "number and dates have NO column in this migration and MUST stay")
m(I, "Botanical Interests (via Gardener’s Supply Company, Hadley MA (retail store))",
  "Botanical Interests", "seed_company", "", "Gardener’s Supply Company", "high", "split",
  "DAVE'S QUESTION, ANSWERED BY HIS OWN DATA: not one fact, two. All 8 rows already carry "
  "metadata.vendor='Botanical Interests' AND metadata.purchase_location='Gardener’s Supply "
  "Company, Hadley MA'. source_id=the brand, acquired_from_source_id=the shop. Merging them would "
  "erase either 'which seed company bred this' or 'which shop can I walk into'.")

# ── High Mowing: 4 spellings, incl. one already drifted inside metadata.vendor ────────────────────
m(P, "High Mowing Organic Seeds", "High Mowing Organic Seeds", "seed_company", "", "", "high",
  "merge", "Same company as the 3 inventory spellings.")
m(I, "High Mowing Organic Seeds", "High Mowing Organic Seeds", "seed_company", "", "", "high", "new",
  "The full legal name; adopted as canonical over the two shortenings.")
m(I, "High Mowing packet", "High Mowing Organic Seeds", "seed_company", "", "", "high", "merge",
  "PROOF THAT FREE TEXT CANNOT HOLD A VOCABULARY: these 2 rows carry metadata.vendor='High Mowing' "
  "while the row above carries 'High Mowing Organic Seeds'. The drift has already reached the JSON "
  "layer that was supposed to be the clean one.",
  residue="nothing")
m(I, "High Mowing Organic Seeds (via Gardener’s Supply Company, Hadley MA (retail store))",
  "High Mowing Organic Seeds", "seed_company", "", "Gardener’s Supply Company", "high", "split",
  "Same two-fact split as the Botanical Interests via-row; metadata.purchase_location confirms.")

# ── Seed Savers Exchange ─────────────────────────────────────────────────────────────────────────
m(P, "Seed Savers Exchange", "Seed Savers Exchange", "seed_company", "Decorah, IA", "", "high",
  "merge", "Same organisation as the 2 inventory spellings.")
m(I, "Seed Savers Exchange packet", "Seed Savers Exchange", "seed_company", "Decorah, IA", "",
  "high", "merge", "'packet' is the item format. metadata.vendor already reads the clean name.",
  residue="nothing")
m(I, "Seed Savers Exchange (via Gardener’s Supply Company, Hadley MA (retail store))",
  "Seed Savers Exchange", "seed_company", "Decorah, IA", "Gardener’s Supply Company", "high",
  "split", "Third instance of the same via-shop shape; metadata.purchase_location confirms.")

# ── The shop those three were bought at ──────────────────────────────────────────────────────────
# (no free-text spelling of its own - it only ever appears inside a parenthetical)

# ── Plant swaps ──────────────────────────────────────────────────────────────────────────────────
m(P, "Belchertown Plant Swap June", "Belchertown Plant Swap", "plant_swap", "Belchertown, MA", "",
  "high", "merge",
  "One event, three typings. All three plants rows fall in 2026-06-17..2026-07-09 and the month is "
  "in every spelling. Note the acquisition types DISAGREE across them (plant_swap / gift / "
  "nursery_transplant) - that axis is plants.source_type and is untouched.",
  residue="'June' - the event date; no column for it here")
m(P, "Belchertown Plant Swap June 2026", "Belchertown Plant Swap", "plant_swap", "Belchertown, MA",
  "", "high", "merge", "Same event as above, with the year spelled out.",
  residue="'June 2026'")
m(P, "Belchertown Plant swap June", "Belchertown Plant Swap", "plant_swap", "Belchertown, MA", "",
  "high", "merge", "Same event; differs from row 1 only in the case of one letter.",
  residue="'June'")
m(I, "Belchertown Plant Swap", "Belchertown Plant Swap", "plant_swap", "Belchertown, MA", "",
  "high", "merge", "Same event, reached from the inventory column - one of the 9 shared places.")
m(P, "Liz Young via Belchertown Plant Swap June", "Liz Young", "person", "", "Belchertown Plant Swap",
  "medium", "split",
  "TWO FACTS, same shape as the via-shop rows: a named person, met at a named event. Confidence is "
  "medium only because it is a single row and Dave may prefer to record just the swap.",
  residue="'June'")
m(I, "Magic Wings Inc (via Belchertown Plant Swap)", "Magic Wings", "organization",
  "South Deerfield, MA", "Belchertown Plant Swap", "high", "split",
  "Explicit 'via'. The row's own source_url is magicwings.com, so the originator is the "
  "conservatory and the swap is where it changed hands.", site="https://magicwings.com/")
m(I, "Free from Belchertown Plant Swap, June 2026 (originally Lake Valley Seed, item #233)",
  "Lake Valley Seed", "seed_company", "", "Belchertown Plant Swap", "high", "split",
  "The string says 'originally' outright, and metadata.vendor='Lake Valley Seed' confirms. The "
  "packet's maker and the place Dave got it are different facts.",
  residue="'Free', 'June 2026', 'item #233' - the item number has no column and MUST stay")
# DAVE RULED 2026-09-03, verbatim: "hatfield and hadley (not hatley) are separate places, the
# whatley swap/giving garden are the same thing (and different from hatfield and hatley)".
# So there are THREE distinct plant swaps, not one or two: Hatfield, Hadley, Whately.
m(P, "Hatfield Plant Swap", "Hatfield Plant Swap", "plant_swap", "Hatfield, MA", "", "high", "new",
  "DAVE RULED 2026-09-03: Hatfield and Hadley are separate places. Stands alone; NOT merged with "
  "the 2026-05-30 swap, which is Hadley. Reading (c) of the three put to him.")
m(P, "Hatley Plant Swap", "Hadley Plant Swap", "plant_swap", "Hadley, MA", "", "high", "rename",
  "DAVE RULED 2026-09-03: 'hadley (not hatley)'. Reading (b) of the three put to him - the stored "
  "spelling is a mistyping of Hadley, a real adjacent town, and the swap stays SEPARATE from "
  "Hatfield. The 2026-05-30 Cantaloupe came from Hadley.")
# MERGED on Dave's ruling. Both spellings resolve to ONE source carrying all 5 rows.
# NOTE the two open sub-questions surfaced to him and not yet answered: (1) which of the two names
# the merged source should carry - 'Plant Swap' is used here only because it holds 4 of the 5 rows,
# not because he chose it; (2) whether to correct the label to the town's real spelling, Whately.
# Neither is destructive and both are a rename away; the merge itself is what was irreversible.
m(P, "Whatley Plant Swap", "Whatley Plant Swap", "plant_swap", "Whately, MA", "", "high", "new",
  "DAVE RULED 2026-09-03: 'the whatley swap/giving garden are the same thing (and different from "
  "hatfield and hatley)'. This row is the merge TARGET - 4 of the 5 rows. Town is really Whately; "
  "the label correction is still unruled and is a separate, reversible call.")
m(P, "Whatley Giving Garden", "Whatley Plant Swap", "plant_swap", "Whately, MA", "", "high", "merge",
  "DAVE RULED 2026-09-03: same thing as 'Whatley Plant Swap' one day later. Merged into it. The "
  "giving-garden-vs-event distinction the design raised is not a real distinction here - it is one "
  "place Dave typed two ways.")

# ── Long River ───────────────────────────────────────────────────────────────────────────────────
m(P, "Long River Produce Market", "Long River Produce Market", "market", "Deerfield, MA", "",
  "high", "new", "26 rows, the second-largest plants spelling. Canonical.")
m(P, "Long River Market, Deerfield, MA, USA", "Long River Produce Market", "market",
  "Deerfield, MA", "", "high", "merge",
  "Same business with the address welded into the name - exactly the pattern Dave asked to stop. "
  "The town moves to source.locality.",
  residue="nothing - 'Deerfield, MA, USA' becomes source.locality")
m(P, "Long River", "Long River Produce Market", "market", "Deerfield, MA", "", "medium", "REVIEW",
  "Almost certainly the same market shortened. FLAGGED because this row's source_type is "
  "'volunteer', not 'rescued' like the other 27 - a volunteer seedling attributed to a shop is odd "
  "and may mean something else entirely (a place, a river, a plant that came up in a Long River "
  "purchase). One row, 2026-06-07, 'Romaine Roots'.")

# ── Greenfield: co-op vs market is the trap ──────────────────────────────────────────────────────
m(P, "Greenfield Co-op", "Greenfield Farmers Co-op", "market", "Greenfield, MA", "", "high",
  "merge", "Shortening of the row below; both source_type='rescued'. Also appears in inventory.")
m(I, "Greenfield Co-op", "Greenfield Farmers Co-op", "market", "Greenfield, MA", "", "high",
  "merge", "Same co-op reached from the inventory column - one of the 9 shared places.")
m(P, "Greenfield Farmers Co-op", "Greenfield Farmers Co-op", "market", "Greenfield, MA", "",
  "high", "new", "The fuller name; adopted as canonical.")
m(P, "Greenfield Farmers Market", "Greenfield Farmers Market", "market", "Greenfield, MA", "",
  "medium", "REVIEW",
  "*** DELIBERATELY NOT MERGED with the co-op, and Dave should confirm. *** A farmers market and a "
  "co-op store are different places that happen to share two words. This is precisely the kind of "
  "near-name a careless pass would fuse. Different source_type too (nursery_transplant vs rescued).")

# ── The Shawski / Skawski trio ───────────────────────────────────────────────────────────────────
m(P, "Shawski Farms", "Shawski Farms", "farm_stand", "", "", "high", "new",
  "Majority spelling (2 of 4 rows) adopted as the label. SEE THE SPELLING FLAG on 'Skawski Farms'.")
m(P, "Shawski Farm", "Shawski Farms", "farm_stand", "", "", "high", "merge",
  "Singular/plural of the same name; same day (2026-05-31), same source_type, same shopping trip.")
m(P, "Skawski Farms", "Shawski Farms", "farm_stand", "", "", "high", "merge",
  "MERGE IS HIGH CONFIDENCE - all three rows were created 2026-05-31 as one nursery_transplant "
  "trip. THE CANONICAL SPELLING IS NOT: 'Shawski' vs 'Skawski' is an h/k transposition and the "
  "majority is only 2-1. Dave should confirm which is the farm's actual name before this becomes "
  "the label on 4 plants.")

# ── Starview ─────────────────────────────────────────────────────────────────────────────────────
m(P, "Starview Gardens", "Starview Gardens", "nursery", "", "", "high", "new",
  "46 rows, the largest plants spelling. Canonical.")
m(P, "Starview", "Starview Gardens", "nursery", "", "", "high", "merge",
  "Same nursery, same source_type, same week (2026-06-07 / 2026-06-12). NOTE: match_key cannot "
  "catch this pair - an omitted word is invisible to any normalising unique index. It is caught by "
  "the picker, not by the schema.")

# ── Trust stands: four different honour-system stands, NOT one ───────────────────────────────────
m(P, "Hart Farm trust stand", "Hart Farm", "farm_stand", "", "", "high", "new",
  "'trust stand' is the KIND (honour-system), not part of the name - it moves to source.kind.",
  residue="nothing")
m(P, "Sunderland - trust stand", "Sunderland trust stand", "farm_stand", "Sunderland, MA", "",
  "medium", "REVIEW",
  "An UNNAMED stand identified only by its town. Kept separate from the other three stands - they "
  "are in different towns and are certainly different stands. Dave may know the farm's actual name.")
m(P, "Trust Stand Greenfield -Upper Road", "Trust stand, Upper Road", "farm_stand",
  "Greenfield, MA", "", "medium", "REVIEW",
  "Another unnamed stand, identified by town + road. Street detail moves to source.address "
  "('Upper Road'). Dave may know the farm's name.")
m(P, "Trust stand in Hadley", "Trust stand, Hadley", "farm_stand", "Hadley, MA", "", "medium",
  "REVIEW",
  "Third unnamed stand. NOT merged with the other two - three towns, three stands. Note this row's "
  "source_type is NULL, the only plants spelling besides the Long River address row with no type.")

# ── Nurseries, farms, garden centres ─────────────────────────────────────────────────────────────
m(P, "Chapley Gardens - 397 Greenfield Rd Deerfield MA", "Chapley Gardens", "nursery",
  "Deerfield, MA", "", "high", "new",
  "DAVE'S NAMED EXAMPLE. The address stops living in the name: 'Chapley Gardens' -> name, "
  "'397 Greenfield Rd' -> address, 'Deerfield, MA' -> locality.",
  residue="nothing - the whole string decomposes into three columns")
m(P, "The Warren Place Flower Farm", "The Warren Place Flower Farm", "nursery", "", "", "high",
  "new", "A flower farm selling transplants; source_type=nursery_transplant.")
m(P, "Bostrom Farms", "Bostrom Farms", "farm_stand", "", "", "medium", "new",
  "Two rows, 2026-07-26 and 2026-08-05, nursery_transplant. Classified farm_stand rather than "
  "nursery because the name is a farm - Dave may reclassify.")
m(P, "Nettlepoint Farm", "Nettlepoint Farm", "farm_stand", "", "", "medium", "new",
  "One row, source_type=gift. A farm that gave rather than sold; the gift is the transaction "
  "(plants.source_type) and the farm is the place.")
m(I, "Gardens at Mathews", "Gardens at Mathews", "nursery", "", "", "low", "REVIEW",
  "*** UNIDENTIFIED. *** One seeds row. Reads like a nursery or a private garden; could be a person's "
  "garden, a public garden, or a business. Kind is a guess and Dave should set it.")
m(P, "Class Grass Garden Canter", "Class Grass Garden Center", "nursery", "", "", "medium",
  "REVIEW",
  "PARTLY RULED 2026-09-03: Dave confirmed 'garden canter = garden center', so the second half is "
  "settled and applied. THE FIRST HALF IS NOT: 'Class Grass' was never put to him separately and is "
  "still an unverified transcription of the same voice entry that produced 'Canter'. A mishearing "
  "that corrupted one word of a name is not evidence the other words survived - and half-correcting "
  "a garbled name is how a wrong name acquires a false air of having been checked. Still REVIEW "
  "until he confirms the business name; one row, nothing blocked by waiting.")

# ── General retail ───────────────────────────────────────────────────────────────────────────────
m(P, "Home Depot", "Home Depot", "retail", "", "", "high", "merge",
  "Same retailer as the 15 inventory rows - one of the 9 shared places.")
m(I, "Home Depot", "Home Depot", "retail", "", "", "high", "new", "15 rows across 4 item categories.")
m(I, "Walmart", "Walmart", "retail", "", "", "high", "new", "9 rows, supplies only.")
m(I, "Best Buy", "Best Buy", "retail", "", "", "high", "new",
  "One row, category=other. Electronics, not garden - correctly a retail source all the same.")
m(P, "Big Y sale", "Big Y", "retail", "", "", "high", "new",
  "Regional supermarket. 'sale' is the circumstance of the purchase, not part of the name.",
  residue="'sale'")

# ── Brands not bought from directly ──────────────────────────────────────────────────────────────
m(P, "Bonnie", "Bonnie Plants", "brand", "", "Home Depot, Greenfield", "high", "split",
  "DAVE RULED 2026-09-03: 'bonnie is the supplier, and absolutely a note i want to keep, but i "
  "likely bought it from Home Depot in Greenfield, so two additional useful pieces of info.' This "
  "is the two-FK design working as intended - Bonnie Plants is the ORIGINATOR (source_id) and Home "
  "Depot Greenfield is the SHOP (acquired_from_source_id). NOTE HIS WORD 'LIKELY': the shop is his "
  "recollection, not a record, and must be stored as such rather than promoted to a fact - see the "
  "residue. Do not let a later pass read it back as evidenced.",
  residue="Dave's 'likely' - the Home Depot attribution is recalled, not recorded, and the "
          "uncertainty travels with it")

# ── Seed companies (mail order) ──────────────────────────────────────────────────────────────────
m(P, "Burpee", "Burpee", "seed_company", "", "", "high", "new",
  "4 rows. source_type is nursery_transplant, which is the ACQUISITION axis and untouched here.")
# NOTE the apostrophe: prod stores a STRAIGHT quote here, unlike the curly U+2019 in the three
# "Gardener’s Supply Company" strings. The join below hard-fails if this is typed wrong.
m(P, "Renee's Garden", "Renee's Garden", "seed_company", "", "", "high",
  "new", "2 rows, source_type=seed_packet.")
m(I, "Johnny's Selected Seeds", "Johnny's Selected Seeds", "seed_company", "Winslow, ME", "",
  "high", "new",
  "8 rows, each with its OWN source_url product page - proof that inventory_items.source_url is "
  "per-item and does not replace source.website_url.",
  site="https://www.johnnyseeds.com")
m(I, "Sandia Seed Company online order #152165; August 2026 intake.", "Sandia Seed Company",
  "seed_company", "", "", "high", "merge",
  "35 rows. Order number and intake month are welded into the identity; only the company name is "
  "the identity.",
  residue="order #152165, 'August 2026 intake' - NO column for either; must stay in source")
m(I, "Mary's Heirloom Seeds online order (HOMESTEAD discount); July 2026 intake. Received "
     "2026-07-17.", "Mary's Heirloom Seeds", "seed_company", "", "", "high", "merge",
  "36 rows. metadata.vendor='Mary's Heirloom Seeds' and metadata.origin='MHS-order-2026-07-17' "
  "already hold the clean name and the batch.",
  residue="'(HOMESTEAD discount)', 'July 2026 intake', 'Received 2026-07-17' - a discount code has "
          "no column anywhere and must stay")
m(I, "Gurney's Seed & Nursery Co.", "Gurney's Seed & Nursery Co.", "seed_company", "", "", "high",
  "new", "One row; metadata.vendor matches the string exactly.")
m(I, "Livingston packet", "Livingston Seed", "seed_company", "", "", "medium", "REVIEW",
  "metadata.vendor reads bare 'Livingston'. Expanding it to 'Livingston Seed' is an inference from "
  "the name - flagged rather than assumed.",
  residue="nothing")
m(I, "Hillfolk Seed Collective", "Hillfolk Seed Collective", "seed_company", "", "", "high", "new",
  "2 rows; metadata.vendor matches exactly. A small collective rather than a catalogue company, but "
  "the kind is the same.")

# ── Organizations ────────────────────────────────────────────────────────────────────────────────
m(I, "UMass Amherst Libraries - Common Seed Project", "UMass Amherst Libraries Common Seed Project",
  "organization", "Amherst, MA", "", "high", "new",
  "A library seed-lending programme, not a vendor. URL taken from the row's own source_url.",
  site="https://guides.library.umass.edu/commonseed")
m(I, "Massachusetts Flower Growers Association", "Massachusetts Flower Growers Association",
  "organization", "", "", "high", "new", "A trade association; one seeds row.")

# ── People ───────────────────────────────────────────────────────────────────────────────────────
m(P, "Imogen", "Imogen", "person", "", "", "high", "new",
  "3 rows, all source_type=gift. A first name with no surname - kept exactly as Dave wrote it.")
m(P, "Emma Daley 2026.06.13", "Emma Daley", "person", "", "", "high", "new",
  "The date is the day of the gift, not part of her name.",
  residue="'2026.06.13' - the gift date; no column for it here")
m(I, "Jen's uncle", "Jen's uncle", "person", "", "", "medium", "REVIEW",
  "A relationship, not a name. Kept verbatim rather than invented. Dave may want to name him, or to "
  "record this as a gift from Jen instead.")
m(P, "Jen from Four Phantoms", "Jen from Four Phantoms", "person", "", "", "low", "REVIEW",
  "*** DAVE MUST RULE, AND IT MAY BE TWO FACTS. *** 12 rows, the fourth-largest spelling. Reads as "
  "a person (Jen) associated with a place (Four Phantoms). If Four Phantoms is a farm or nursery, "
  "this should split into person + acquired_from exactly like the via-shop rows. It is ALSO unclear "
  "whether this Jen is Dave's partner. Left as ONE verbatim row so no wrong split is baked in.")
m(P, "Ojos de Luna", "Ojos de Luna", "person", "", "", "high", "new",
  "DAVE RULED 2026-09-03: 'ojos is a person, name her so' - a woman, recorded under this name. The "
  "design had `person` as a placeholder among four readings; it is now the answer. All 4 rows are "
  "gifts from her, which is consistent.")

# ── Own garden ───────────────────────────────────────────────────────────────────────────────────
m(I, "Home-saved (source not recorded)", "Own garden", "own_garden", "", "", "medium", "REVIEW",
  "Seed saved from Dave and Jen's own plants. NOTE THE OVERLAP: inventory_items.source_plant_id and "
  "source_kind='own_garden' (V4-SEEDLINK-001 / V4-SEEDORIGIN-001) are the PURPOSE-BUILT home for "
  "this, and are richer - they can name the parent plant. Dave should decide whether this row wants "
  "a source_id at all, or belongs entirely on those columns.",
  residue="'(source not recorded)' - the honest admission that the parent plant is unknown")

# ── Genuinely other ──────────────────────────────────────────────────────────────────────────────
m(I, "Panorama Tours, Austria (souvenir)", "Panorama Tours", "other", "Austria", "", "medium",
  "new", "A souvenir seed packet from a tour company. Not a garden source in any normal sense, "
         "which is what 'other' is for.",
  residue="'(souvenir)'")

# ── Emit ─────────────────────────────────────────────────────────────────────────────────────────
rows, seen = [], set()
with TSV.open(encoding="utf-8") as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line:
            continue
        col, n, hint, spelling = line.split("\t", 3)
        key = (col, spelling)
        seen.add(key)
        if key not in M:
            sys.exit(f"FAIL: prod spelling has no mapping entry: {key!r}")
        rows.append(dict(parent_column=col, spelling=spelling, rows_in_prod=n,
                         existing_type_or_category=hint, **M[key]))

missing = set(M) - seen
if missing:
    sys.exit(f"FAIL: mapping entries not present in prod (typo in the left column?): {missing!r}")

FIELDS = ["parent_column", "spelling", "rows_in_prod", "existing_type_or_category",
          "proposed_source_name", "proposed_kind", "proposed_locality", "proposed_acquired_from",
          "proposed_website", "confidence", "action", "reason", "residue_stays_in_free_text"]
rows.sort(key=lambda r: (r["proposed_source_name"].lower(), r["parent_column"], r["spelling"]))
with OUT.open("w", newline="", encoding="utf-8") as fh:
    w = csv.DictWriter(fh, fieldnames=FIELDS, quoting=csv.QUOTE_ALL, lineterminator="\n")
    w.writeheader()
    w.writerows(rows)

canon = sorted({r["proposed_source_name"] for r in rows})
flagged = [r for r in rows if r["confidence"] in ("low", "medium") or r["action"] == "REVIEW"]
print(f"OK  {len(rows)} spellings -> {len(canon)} canonical sources")
print(f"    actions: " + ", ".join(
    f"{a}={sum(1 for r in rows if r['action'] == a)}"
    for a in ("new", "merge", "split", "REVIEW")))
print(f"    confidence: " + ", ".join(
    f"{c}={sum(1 for r in rows if r['confidence'] == c)}" for c in ("high", "medium", "low")))
print(f"    needing Dave's ruling (REVIEW or non-high confidence): {len(flagged)}")
print(f"    kinds used: {sorted({r['proposed_kind'] for r in rows})}")
