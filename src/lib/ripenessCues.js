// V4-RIPECUE-001 — researched harvest ripeness cues, resolved for a planting's variety_ref.
//
// WHY THIS EXISTS. The 2026-08-04 harvest-window crucible
// (`harvest-window-crucible-V100-20260804.md`) killed the maturity-window section on measurement —
// window calibration was 11.8%, 30 of 34 tested plantings were picked BEFORE their window opened,
// median 22 days early — and named ripeness cues on CropCard as the substitute with the highest
// reach: 100% of plantings versus 6% for cues gated behind that section (§7.6, decision D3). This
// module is that substitute. It answers the question Dave actually asked — "is full yellow ripe on
// a Pick-N-Pop, does it go on to orange, should I leave it green?" — instead of predicting a date.
//
// WHY IT IS A CODE MODULE AND NOT A COLUMN. The crucible's Slice 1 sketched
// `crop_types.ripeness_cue` + a `cultivar.ripeness_cue` override, reusing the LEFT JOIN already at
// `lambda/plants/index.js:189`. That remains the right END state and this file is shaped to lift
// into it unchanged (see EXPORT SHAPE below). It is deliberately NOT how the first slice ships:
//   - A new column is fresh DDL, and `integration-test.yml` branches off staging WITHOUT applying
//     migrations, so the migration must land on staging BEFORE the dev push or CI fails against a
//     schema that has no such column (crucible §7.5). That is a cross-lane sequencing dependency.
//   - Cue text is static reference content, not user data. It has no per-user state, never changes
//     as a result of anything the app does, and wants to be reviewed in a diff. The repo already
//     treats harvest reference content this way in `harvest-attributes-v1.json`.
//   - Reverting is deleting one import rather than reversing DDL over authored prose that `0r`
//     cannot recover.
//
// SOURCING RULE — the reason half this file is blank. Every cue below was read off the cited page.
// A crop with no citable source gets NO ENTRY and renders NOTHING. That is the designed outcome,
// not an omission: the crucible's own guidance is that a confidently wrong cue at cultivar grain is
// worse than no cue, "because Dave will trust it against his own eyes" (§9 Slice 1). Do not fill a
// gap here from general knowledge, and do not let an agent generate entries unsourced (D4).
//
// TWO GRAINS, and the split is load-bearing (crucible §7.4 D4):
//   by_crop_type -> the MECHANIC. Crop-level, stable, colour-AGNOSTIC. "Full size, firm, snaps off."
//   by_cultivar  -> the TARGET STATE. Cultivar-level and sparse. "Full canary yellow; never reddens."
// Crop-level colour claims are actively wrong for this garden and are banned from by_crop_type:
// 16 of 41 live tomato cultivars do not ripen red (Cherokee Green ripens green; Black Krim keeps
// green shoulders), and among peppers Shishito and Cubanelle are picked green on purpose while
// Sweet Chocolate ripens brown and Chinese 5-Color passes through five colours. "Wait for red"
// tells Dave to leave a ripe Cherokee Green on the vine until it rots.
//
// EXPORT SHAPE — mirrors the eventual DB rows so the lift is mechanical:
//   { cue, source, source_url, confidence, asserted_on, caveat? }
// `confidence`:
//   'high'   — the cited page states the cue directly, near-verbatim.
//   'medium' — the page states the substance, but the cue condenses/paraphrases it, or the source
//              is weaker than an extension factsheet, or authorities conflict elsewhere on the crop.
//   'low'    — the cue is DERIVED from the source rather than stated by it. A 'low' entry MUST
//              carry a `caveat`, which renders on screen. A test enforces that, because the whole
//              point is that the reader can see the difference between "the extension service says
//              this" and "we worked this out". Silently ranking a derivation alongside a quotation
//              is exactly the flattening this field exists to prevent.
// `caveat` is optional at any tier and renders verbatim under the cue when present.

const DAY = '2026-08-04'

// ── MECHANIC, crop-level, colour-agnostic ───────────────────────────────────────────────────────
export const CUES_BY_CROP_TYPE = {
  pepper: {
    cue: 'Pick at full size while firm and glossy — the fruit breaks off easily when mature, and you never have to wait for red.',
    source: 'University of Illinois Extension / UMN Extension',
    source_url: 'https://extension.illinois.edu/gardening/peppers',
    confidence: 'high',
    asserted_on: DAY,
  },
  tomato: {
    cue: 'Pick once about 90% of its ripe colour has developed and the skin gives slightly under a gentle press — still firm, not soft.',
    source: 'Penn State Extension / Illinois Extension',
    source_url: 'https://extension.psu.edu/is-this-tomato-ready-to-harvest',
    confidence: 'high',
    asserted_on: DAY,
  },

  // ── SQUASH IS TWO CROPS HERE, and the source agrees ──────────────────────────────────────────
  // The research came back as ONE `squash` row whose cue read both ways ("summer squash should
  // pierce easily, winter squash is ready when it resists"). This database splits them: `squash` is
  // display_name 'Summer Squash' (harvest_habit 'repeat') and `winter_squash` is 'Winter Squash'
  // ('single') — two rows, opposite harvest logic. Shipping the dual-reading cue under `squash`
  // would put half a sentence about a different crop on every zucchini. Verified at the source
  // before splitting: the UGA table carries them as two distinct entries, "Rind can be penetrated
  // with thumbnail" (summer) and "Rind difficult to penetrate with thumbnail" (winter). So this is
  // the source's own split restored, not a rewrite. Live today: 2 summer squash, 0 winter squash.
  squash: {
    cue: 'Press a thumbnail into the rind — it should pierce easily. A rind that resists has gone over and turned tough.',
    source: 'UGA Extension — When to Harvest Vegetables',
    source_url: 'https://fieldreport.caes.uga.edu/publications/C935/',
    confidence: 'high',
    asserted_on: DAY,
  },
  winter_squash: {
    cue: 'Ready when the rind is hard enough to resist a thumbnail — a rind you can still pierce is not cured for storage.',
    source: 'UGA Extension — When to Harvest Vegetables',
    source_url: 'https://fieldreport.caes.uga.edu/publications/C935/',
    confidence: 'high',
    asserted_on: DAY,
  },

  // ── WINEBERRY — the weakest entry in the file, and deliberately marked as such ────────────────
  // This is the plant behind the harvest-band bug the crucible diagnosed (a `dormant` bramble
  // ranked #1 at a 10.5x overdue ratio), so it matters that the cue not overstate itself.
  // NEITHER source gives a harvest instruction. Both are botanical descriptions:
  //   NC State: "the fruit is enclosed in its calyx until just before it is ripe"
  //   UMD:      "like garden raspberries, the fruit has a hollow core when picked"
  // The cue is a DERIVATION from those two facts — calyx opens as it ripens, and it releases from
  // its receptacle the way a raspberry does. That derivation is sound and it matches the shipped
  // red_raspberry cue, but it is still a derivation, which is why this is the only 'low' entry and
  // why the caveat renders on screen rather than sitting in this comment.
  wineberry: {
    cue: 'The berry stays sealed in its bristly calyx until just before ripe — once the calyx has peeled back, a ripe one should slip off with a light tug.',
    source: 'NC State Extension Plant Toolbox / UMD Extension',
    source_url: 'https://plants.ces.ncsu.edu/plants/rubus-phoenicolasius/',
    confidence: 'low',
    caveat: 'Derived from botanical descriptions — neither source gives an actual harvest instruction.',
    asserted_on: DAY,
  },

  basil: {
    cue: 'Wait until the plant is 6-10 inches high, then clip stems just above the second set of leaves from the bottom.',
    source: 'UC Master Gardeners, Placer County (UC ANR)',
    source_url: 'https://ucanr.edu/site/uc-master-gardeners-placer-county/article/maximizing-your-basil-harvest',
    confidence: 'high',
    asserted_on: DAY,
  },
  oregano: {
    cue: 'Begin cutting stem tips just before the plant flowers, leaving 4 to 6 pairs of leaves on the plant.',
    source: 'University of Illinois Extension — Herbs: Oregano',
    source_url: 'https://extension.illinois.edu/herbs/oregano',
    confidence: 'high',
    asserted_on: DAY,
  },
  tarragon: {
    cue: 'Snip individual leaves or stem tips as needed, and pinch off any flower buds that form to keep leaf flavor strong.',
    source: 'UC Master Gardener Program of Sonoma County',
    source_url: 'https://ucanr.edu/site/mg-sonoma/tarragon',
    confidence: 'high',
    asserted_on: DAY,
  },
  parsley: {
    cue: 'Snip whole outer leaf stalks off close to the ground rather than cutting leaf tops, leaving the center to regrow.',
    source: 'UMN Extension — Growing parsley',
    source_url: 'https://extension.umn.edu/vegetables/growing-parsley',
    confidence: 'high',
    asserted_on: DAY,
  },
  dill: {
    cue: 'Cut leaves any time once the plant is a few inches high, up until a seed stalk begins to form.',
    source: 'Wisconsin Horticulture (UW–Madison Extension)',
    source_url: 'https://hort.extension.wisc.edu/articles/dill-anethum-graveolens/',
    confidence: 'high',
    asserted_on: DAY,
  },
  chives: {
    cue: 'Once leaves are about 6 inches long, cut firm green ones with no yellow or wilted tips about 2 inches above the base.',
    source: 'Wisconsin Horticulture (UW–Madison Extension)',
    source_url: 'https://hort.extension.wisc.edu/articles/chives-allium-schoenoprasum/',
    confidence: 'high',
    asserted_on: DAY,
  },
  sage: {
    cue: 'Cut stems when the plant is just starting to flower.',
    source: 'Iowa State Extension — Growing, Harvesting, and Drying Herbs',
    source_url: 'https://yardandgarden.extension.iastate.edu/how-to/growing-harvesting-and-drying-herbs',
    confidence: 'high',
    asserted_on: DAY,
  },
  mint: {
    cue: 'Cut stems just as the first flowers begin to appear.',
    source: 'University of Illinois Extension — Herbs: Mint',
    source_url: 'https://extension.illinois.edu/herbs/mint',
    confidence: 'high',
    asserted_on: DAY,
  },
  thyme: {
    cue: 'Cut leafy stems any time in the season, but best just before the plant starts to flower.',
    source: 'University of Illinois Extension — Herbs: Thyme',
    source_url: 'https://extension.illinois.edu/herbs/thyme',
    confidence: 'high',
    asserted_on: DAY,
  },
  rosemary: {
    cue: 'Cut the young, tender green stem tips, never taking more than one-third of the plant at once.',
    source: 'Iowa State Extension — Growing, Harvesting, and Drying Herbs',
    source_url: 'https://yardandgarden.extension.iastate.edu/how-to/growing-harvesting-and-drying-herbs',
    confidence: 'high',
    asserted_on: DAY,
  },
  bay: {
    cue: 'Pick the larger, older, fully expanded leaves rather than soft new growth — they carry the strongest flavor.',
    source: 'University of Illinois Extension — Herbs: Bay Laurel',
    source_url: 'https://extension.illinois.edu/herbs/bay-laurel',
    confidence: 'high',
    asserted_on: DAY,
  },
  lemon_verbena: {
    cue: 'Pinch off the newest leaf tips any time before the plant sets flowers, when flavor is best.',
    source: 'UC Marin Master Gardeners',
    source_url: 'https://ucanr.edu/site/uc-marin-master-gardeners/document/lemon-verbena',
    confidence: 'high',
    asserted_on: DAY,
  },
  lemongrass: {
    cue: 'Push an outside stalk aside and cut it at ground level once its base is about half an inch thick.',
    source: 'Wisconsin Horticulture (UW–Madison Extension)',
    source_url: 'https://hort.extension.wisc.edu/articles/lemongrass/',
    confidence: 'high',
    asserted_on: DAY,
  },
  lettuce: {
    cue: 'Cut leaf types once plants are 5 to 6 inches tall; cut heading types once the leaves overlap into a firm head.',
    source: 'Clemson HGIC — Lettuce',
    source_url: 'https://hgic.clemson.edu/factsheet/lettuce/',
    confidence: 'high',
    asserted_on: DAY,
  },
  kale: {
    cue: 'Pick the big outer leaves once they reach usable size and let the center keep growing.',
    source: 'NC State Extension — Kale',
    source_url: 'https://content.ces.ncsu.edu/kale',
    confidence: 'medium',
    asserted_on: DAY,
  },
  collard: {
    cue: 'Pick clusters of lower leaves before they get full-sized, tough and woody, working up the stalk over time.',
    source: 'Illinois Extension — Collard',
    source_url: 'https://extension.illinois.edu/gardening/collard',
    confidence: 'medium',
    asserted_on: DAY,
  },
  arugula: {
    cue: 'Pick leaves as soon as they are a couple of inches long, harvesting often so plants don’t run to seed.',
    source: 'Wisconsin Horticulture (UW–Madison Extension)',
    source_url: 'https://hort.extension.wisc.edu/articles/arugula/',
    confidence: 'high',
    asserted_on: DAY,
  },
  endive: {
    cue: 'Cut the head once it has reached full size, is well formed, and feels firm to a gentle squeeze.',
    source: 'Utah State University Extension',
    source_url: 'https://extension.usu.edu/vegetableguide/leafy-greens/harvest-storage.php',
    confidence: 'high',
    asserted_on: DAY,
  },
  radicchio: {
    cue: 'Harvest once the head is full-sized, well formed, and firm to a gentle squeeze rather than loose.',
    source: 'Utah State University Extension',
    source_url: 'https://extension.usu.edu/vegetableguide/leafy-greens/harvest-storage.php',
    confidence: 'high',
    asserted_on: DAY,
  },
  cabbage: {
    cue: 'Squeeze the head and cut it once it feels solid and firm at the size normal for its variety.',
    source: 'Clemson HGIC — Harvesting Vegetables',
    source_url: 'https://hgic.clemson.edu/factsheet/harvesting-vegetables/',
    confidence: 'high',
    asserted_on: DAY,
  },
  broccoli: {
    cue: 'Cut the main head while the flower buds are still tight, before any bud has begun to open.',
    source: 'UMN Extension — Growing broccoli',
    source_url: 'https://extension.umn.edu/vegetables/growing-broccoli',
    confidence: 'high',
    asserted_on: DAY,
  },
  kohlrabi: {
    cue: 'Pull when the swollen stem is 2 to 3 inches across; larger bulbs turn tough and woody.',
    source: 'Clemson HGIC — Harvesting Vegetables',
    source_url: 'https://hgic.clemson.edu/factsheet/harvesting-vegetables/',
    confidence: 'high',
    asserted_on: DAY,
  },
  carrot: {
    cue: 'Scrape soil off the crown and pull when the root shoulder is about three-quarters to one inch across.',
    source: 'Clemson HGIC — Harvesting Vegetables',
    source_url: 'https://hgic.clemson.edu/factsheet/harvesting-vegetables/',
    confidence: 'high',
    asserted_on: DAY,
  },
  beet: {
    cue: 'Pull roots at about 1½ to 2 inches across; beets left past 2 inches go woody.',
    source: 'Clemson HGIC — Harvesting Vegetables',
    source_url: 'https://hgic.clemson.edu/factsheet/harvesting-vegetables/',
    confidence: 'high',
    asserted_on: DAY,
  },
  potato: {
    cue: 'Dig after the vines have died back, and rub a tuber — mature skin will not slip off under your thumb.',
    source: 'UMN Extension — Growing potatoes',
    source_url: 'https://extension.umn.edu/vegetables/growing-potatoes',
    confidence: 'high',
    asserted_on: DAY,
  },
  sweet_potato: {
    cue: 'Cut the vines and dig once about 30% of the roots are over 3½ inches across, and always before frost.',
    source: 'Clemson HGIC — Sweet Potato',
    source_url: 'https://hgic.clemson.edu/factsheet/sweet-potato/',
    confidence: 'high',
    asserted_on: DAY,
  },
  onion: {
    cue: 'Pull when about three-fourths of the tops have fallen over on their own.',
    source: 'Clemson HGIC — Harvesting Vegetables',
    source_url: 'https://hgic.clemson.edu/factsheet/harvesting-vegetables/',
    confidence: 'high',
    asserted_on: DAY,
  },
  shallot: {
    cue: 'Lift bulbs for storage only after the plant tops have fallen over on their own.',
    source: 'Utah State University Extension',
    source_url: 'https://extension.usu.edu/yardandgarden/research/shallots-in-the-garden',
    confidence: 'high',
    asserted_on: DAY,
  },
  garlic: {
    cue: 'Lift when the lower leaves have browned but half or slightly more than half of the upper leaves are still green.',
    source: 'UMN Extension — Growing garlic',
    source_url: 'https://extension.umn.edu/vegetables/growing-garlic',
    confidence: 'high',
    asserted_on: DAY,
  },
  leek: {
    cue: 'Lift when the shaft has thickened past about an inch across (½–¾ inch for small varieties) and feels firm.',
    source: 'UMN Extension — Growing leeks',
    source_url: 'https://extension.umn.edu/vegetables/growing-leeks',
    confidence: 'high',
    asserted_on: DAY,
  },
  bunching_onion: {
    cue: 'Pull green onions when the tops are 6 to 8 inches tall and before any flower stalk forms.',
    source: 'Clemson HGIC — Harvesting Vegetables',
    source_url: 'https://hgic.clemson.edu/factsheet/harvesting-vegetables/',
    confidence: 'high',
    asserted_on: DAY,
  },
  bean: {
    cue: 'Pick pods before the seeds inside show their shape and make the pod bulge — bulging pods are fibrous.',
    source: 'UMN Extension — Growing beans',
    source_url: 'https://extension.umn.edu/vegetables/growing-beans',
    confidence: 'high',
    asserted_on: DAY,
  },
  okra: {
    cue: 'Pick pods at 2 to 3 inches long while still tender; larger pods turn tough and fibrous.',
    source: 'Clemson HGIC — How to Grow Okra',
    source_url: 'https://hgic.clemson.edu/factsheet/how-to-grow-okra-in-south-carolina-including-planting-dates-watering-fertilizing-ratooning-pest-management-and-harvesting-tips-for-healthy-pod-production/',
    confidence: 'high',
    asserted_on: DAY,
  },
  cucumber: {
    cue: 'Pick while the fruit is still firm and slim, before it grows over-large with big hard seeds inside.',
    source: 'UMN Extension — Growing cucumbers',
    source_url: 'https://extension.umn.edu/vegetables/growing-cucumbers',
    confidence: 'high',
    asserted_on: DAY,
  },
  cucamelon: {
    cue: 'Pick while the fruits are still under an inch long and grape-sized; anything bigger turns seedy.',
    source: 'UGA Extension (Cherokee County)',
    source_url: 'https://site.extension.uga.edu/cherokee/?p=103',
    confidence: 'medium',
    asserted_on: DAY,
  },
  eggplant: {
    cue: 'Pick while the skin is still high-gloss; once the surface dulls the fruit is over-mature.',
    source: 'UMN Extension — Harvesting and storing home garden vegetables',
    source_url: 'https://extension.umn.edu/planting-and-growing-guides/harvesting-and-storing-home-garden-vegetables',
    confidence: 'medium',
    asserted_on: DAY,
  },
  asparagus: {
    cue: 'Cut or snap spears at 6 to 8 inches tall, before the tips begin to separate and open.',
    source: 'Clemson HGIC — Harvesting Vegetables',
    source_url: 'https://hgic.clemson.edu/factsheet/harvesting-vegetables/',
    confidence: 'high',
    asserted_on: DAY,
  },
  tomatillo: {
    cue: 'Pick once the fruit has completely filled its papery husk and the husk has begun to dry and split open.',
    source: 'SDSU Extension',
    source_url: 'https://extension.sdstate.edu/tomatillos-harvest-and-storage',
    confidence: 'high',
    asserted_on: DAY,
  },
  bitter_melon: {
    cue: 'Pick while the fruit is still immature and firm; once it softens and bursts open at the bottom it is past use.',
    source: 'UC Master Gardeners of Santa Clara County (UC ANR)',
    source_url: 'https://ucanr.edu/site/uc-master-gardeners-santa-clara-county/bitter-melon',
    confidence: 'high',
    asserted_on: DAY,
  },
  melon: {
    cue: 'Pick when the skin netting turns coarse and rough and the fruit breaks free of the vine with a slight twist.',
    source: 'UMN Extension — Growing melons',
    source_url: 'https://extension.umn.edu/fruit/growing-melons-home-garden',
    confidence: 'high',
    asserted_on: DAY,
  },
  watermelon: {
    cue: 'Pick when the tendril nearest the fruit has dried, the belly patch turns from greenish-white to cream, and the rind dulls.',
    source: 'Iowa State Extension Yard and Garden',
    source_url: 'https://yardandgarden.extension.iastate.edu/faq/how-do-i-know-when-watermelon-ready-harvest',
    confidence: 'high',
    asserted_on: DAY,
  },
  strawberry: {
    cue: 'Pick only when no pale unripe patch remains anywhere on the berry, including the shoulders up under the cap.',
    source: 'UMN Extension — Harvesting strawberries',
    source_url: 'https://extension.umn.edu/strawberry-farming/harvesting-strawberries',
    confidence: 'high',
    asserted_on: DAY,
  },
  blackberry: {
    cue: 'Pick when the berry has lost its glossy shine and turned slightly dull; still-shiny fruit is under-ripe.',
    source: 'Clemson HGIC — Blackberry',
    source_url: 'https://hgic.clemson.edu/factsheet/blackberry/',
    confidence: 'high',
    asserted_on: DAY,
  },
  red_raspberry: {
    cue: 'Pick when the berry slips off with a light tug, leaving its pale core behind on the plant.',
    source: 'Iowa State Extension — Harvesting and Storing Small Fruit',
    source_url: 'https://yardandgarden.extension.iastate.edu/how-to/harvesting-and-storing-small-fruit',
    confidence: 'high',
    asserted_on: DAY,
  },
  blueberry: {
    cue: 'Leave berries on the bush one to three days after they colour up fully, with no reddish tinge left, before picking.',
    source: 'UMaine Extension Bulletin #2253',
    source_url: 'https://extension.umaine.edu/publications/2253e/',
    confidence: 'high',
    asserted_on: DAY,
  },
  peach: {
    cue: 'Pick when the background colour has changed away from green and the fruit separates easily from the twig.',
    source: 'Illinois Extension — Fruit Harvesting and Storage',
    source_url: 'https://extension.illinois.edu/fruit-trees/fruit-harvesting-and-storage',
    confidence: 'high',
    asserted_on: DAY,
  },
  nasturtium: {
    cue: 'Pick the youngest leaves and freshly opened blooms the day you’ll use them; older leaves and flowers turn bitter.',
    source: 'UMN Extension',
    source_url: 'https://extension.umn.edu/news/writers-guild-article-nasturtiums',
    confidence: 'medium',
    asserted_on: DAY,
  },
}

// ── TARGET STATE, cultivar-level, sparse ────────────────────────────────────────────────────────
// Populated only where the ripe appearance is NON-OBVIOUS and getting it wrong changes what Dave
// does. An ordinary red slicer gets no entry — the crop mechanic above already covers it.
export const CUES_BY_CULTIVAR = {
  // Dave's own question, and the reason this slice exists: "for a Pick-N-Pop yellow pepper — is
  // full yellow ripe? does it go on to orange? should it be left green?"
  // SOURCED: the All-America Selections registry entry for this exact cultivar (2025 AAS Winner)
  // states "Fruit Color (Harvest): Yellow" and describes "bright, canary yellow-colored" fruit.
  // That settles half the question — yellow IS the harvest stage, so it is not unripe and should
  // NOT be left green.
  // DELIBERATELY NOT ASSERTED: that it will never advance to orange or red. No page consulted says
  // so. The crucible reasoned it from Capsicum pigment genetics and flagged the cultivar-level
  // confirmation as missing (§7.4), and a sibling listing rates "Orange and Red" as separate
  // varieties in the same Pick-N-Pop series — suggestive, not a statement. So the cue says what the
  // source says and stops. Answering "does it go orange?" with a confident guess is the exact
  // failure this file is built to prevent.
  picknpopyellow: {
    cue: 'Pick at bright canary yellow — that is this variety’s stated harvest colour, so yellow means ripe, not unripe.',
    source: 'All-America Selections (2025 Winner listing)',
    source_url: 'https://all-americaselections.org/product/pepper-pick-n-pop/',
    confidence: 'high',
    asserted_on: DAY,
  },

  // ── PEPPERS where the crop mechanic alone would mislead ──────────────────────────────────────
  // Live record is 'Shishito (Burpee)'; the vendor parenthetical is stripped by cueKeyNoParen.
  // The crop rule ("full size, firm, you needn't wait for red") is not enough here — a shishito is
  // picked GREEN on purpose. It also corrects widespread folklore: red shishito is commonly said to
  // turn hot, and Johnny's says the opposite — "no heat" at either stage. From the listing: "Pick
  // the first peppers promptly when they reach full size to encourage further fruit set"; 60 days
  // green / 80 days red ripe; "In Asia, the fruits are always cooked green, but they may also be
  // used red."
  shishito: {
    cue: 'Pick green at full size — that is the intended stage, and picking the first ones promptly keeps it setting. Left on it reddens and stays mild.',
    source: 'Johnny’s Selected Seeds',
    source_url: 'https://www.johnnyseeds.com/vegetables/peppers/sweet-peppers/shishito-organic-shishito-pepper-seed-4227G.html',
    confidence: 'high',
    asserted_on: DAY,
  },

  // Brown is the RIPE state, which reads as spoiled to anyone who hasn't grown one.
  sweetchocolate: {
    cue: 'Ripe is chocolate-brown skin over dark red flesh — brown means ripe here, not spoiled.',
    source: 'John Scheepers Kitchen Garden Seeds',
    source_url: 'https://www.kitchengardenseeds.com/sweet-chocolate-pepper.html',
    confidence: 'high',
    asserted_on: DAY,
  },

  // The one cultivar where every colour on the plant at once is correct, not a ripeness spread.
  chinese5color: {
    cue: 'Runs purple → cream → yellow → orange → red on one plant; red is fully ripe and hottest, and the earlier colours are edible too.',
    source: 'John Scheepers Kitchen Garden Seeds',
    source_url: 'https://www.kitchengardenseeds.com/chile-pepper-chinese-5-color.html',
    confidence: 'high',
    asserted_on: DAY,
  },

  // Live record is 'Bulgarian Carrot (Shipka)' — keyed on the full normalized name.
  // The source states the RIPE colour and deliberately says nothing about a green→orange
  // progression, so neither does this cue.
  bulgariancarrotshipka: {
    cue: 'Ripe is bright orange on a 3–4 in carrot-shaped pod.',
    source: 'Experimental Farm Network',
    source_url: 'https://store.experimentalfarmnetwork.org/products/bulgarian-carrot-shipka-hot-pepper',
    confidence: 'medium',
    asserted_on: DAY,
  },

  // ── TOMATOES that never turn red, or whose "unripe" look is actually ripe ────────────────────
  // The highest-value entries in the file: each one corrects an intuition rather than confirming
  // it, which is what Dave asked for with the Pick-N-Pop example. "Wait for red" on any of these
  // means leaving ripe fruit on the vine until it rots.
  cherokeegreen: {
    cue: 'Ripens GREEN with an amber blush at the blossom end — it never turns red, and that blush is the tell.',
    source: 'Pinetree Garden Seeds',
    source_url: 'https://www.superseeds.com/products/cherokee-green-organic-tomato',
    confidence: 'high',
    asserted_on: DAY,
  },

  blackkrim: {
    cue: 'Dark brown-green shoulders are NORMAL, not unripe — it ripens blossom-end upward to a deep brown-red.',
    source: 'Johnny’s Selected Seeds',
    source_url: 'https://www.johnnyseeds.com/vegetables/tomatoes/heirloom-tomatoes/black-krim-organic-tomato-seed-3814G.html',
    confidence: 'high',
    asserted_on: DAY,
  },

  // Hue is unsettled between deep gold and orange across vendors — only Johnny's was actually
  // fetched. The ACTIONABLE half (it is emphatically not red) is solid either way, so the cue
  // asserts that and hedges the shade. Confidence is medium for exactly that reason.
  yellowbrandywine: {
    cue: 'Ripens deep gold to orange and never red — Johnny’s calls it “an orange version of Brandywine”.',
    source: 'Johnny’s Selected Seeds',
    source_url: 'https://www.johnnyseeds.com/vegetables/tomatoes/heirloom-tomatoes/yellow-brandywine-organic-tomato-seed-714.html',
    confidence: 'medium',
    asserted_on: DAY,
  },

  speckledroman: {
    cue: 'Ripe is bright red with golden streaks — the stripes are the variety, not a sign it is still unripe.',
    source: 'Johnny’s Selected Seeds',
    source_url: 'https://www.johnnyseeds.com/vegetables/tomatoes/paste-tomatoes/speckled-roman-organic-tomato-seed-3816G.html',
    confidence: 'high',
    asserted_on: DAY,
  },

  sunsugar: {
    cue: 'Ripe is orange, not red — holding out for red only overripens it.',
    source: 'Tomato Growers Supply',
    source_url: 'https://tomatogrowers.com/products/sun-sugar-ft-hybrid',
    confidence: 'high',
    asserted_on: DAY,
  },
}

/** Key normalizer: case/punctuation-insensitive, and vendor parentheticals are dropped. */
export function cueKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}
function cueKeyNoParen(name) {
  return cueKey(String(name ?? '').replace(/\([^)]*\)/g, ' '))
}

/**
 * Resolve the cues for a planting's variety_ref.
 * Returns { target, mechanic } — either may be null, and BOTH null is the normal, correct outcome
 * for an unsourced crop and for every ornamental/houseplant (nothing is ever harvested from them).
 * The two are returned separately rather than merged because they answer different questions and
 * the caller renders the target state first.
 */
export function resolveRipenessCues(varietyRef) {
  const v = varietyRef || {}
  const mechanic = CUES_BY_CROP_TYPE[v.crop_type_slug] ?? null
  const target = CUES_BY_CULTIVAR[cueKey(v.name)]
    ?? CUES_BY_CULTIVAR[cueKeyNoParen(v.name)]
    ?? null
  return { target, mechanic }
}
