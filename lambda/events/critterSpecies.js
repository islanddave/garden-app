// Critter species pool — full earnable catalog (V102, 2026-06-01).
// Owner-override (L-102, Dave directive): ALL ~168 defined critters are earnable. The prior
// MVP namespace contract (ids 1-8 = MVP pool, 100+ = V3 roster) is RETIRED — there is now ONE
// unified pool keyed by integer species_id 1-168 (255 still reserved as the smoke sentinel,
// out of pool range). species_id 1-8 PRESERVE their original MVP meaning (robin=1 … hummingbird=8)
// so existing critter_state rows keep their critter.
//
// Source of truth: src/data/critters-roster.json (168 entries; this pool is GENERATED from it and
// kept identical in BOTH src/lib/critterSpecies.js and lambda/events/critterSpecies.js — a parity
// test enforces equality). To regenerate after roster changes, re-run the V102 generator
// (preserves the 8 MVP ids by sprite, assigns 9.. in roster order). The species_id -> roster id
// bridge is sprite_filename -> "C0NN"/"L0NN"/"Y0NN" (src/lib/critterCollection.js); roster.json is
// unchanged and carries no species_id.
//
// Reward model (V102, reward-ux-guideline-V102): VARIABLE-RATIO kept — pickSpecies returns null for
// ~52.5% of seeds (no critter this event), preserving the ~0.475 overall award rate. LIGHT TIERS by
// roster group: wild=common (weight 3), legacy=uncommon (weight 2), cryptid=rare (weight 1). All
// fully earnable; exotics stay rarer-but-reachable. base_probability per entry = base_weight /
// 469 (sum of weights) * 0.475 (target award rate). NO rarity UI (invisible mechanism).
// base_weight retained for back-compat callers; pickSpecies reads base_probability.

export const SPECIES_POOL = Object.freeze([
  Object.freeze({ species_id: 1, name: "American Robin", slug: "american-robin", group: "wild", tier: "common", sprite_filename: "C013-american-robin.svg", aria_announce_name: "an American robin", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 2, name: "Honeybee", slug: "honeybee", group: "wild", tier: "common", sprite_filename: "C001-honeybee.svg", aria_announce_name: "a honeybee", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 3, name: "Blue Jay", slug: "blue-jay", group: "wild", tier: "common", sprite_filename: "C050-blue-jay.svg", aria_announce_name: "a blue jay", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 4, name: "American Goldfinch", slug: "american-goldfinch", group: "wild", tier: "common", sprite_filename: "C029-american-goldfinch.svg", aria_announce_name: "an American goldfinch", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 5, name: "Mourning Dove", slug: "mourning-dove", group: "wild", tier: "common", sprite_filename: "C049-mourning-dove.svg", aria_announce_name: "a mourning dove", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 6, name: "Black Capped Chickadee", slug: "black-capped-chickadee", group: "wild", tier: "common", sprite_filename: "C012-black-capped-chickadee.svg", aria_announce_name: "a chickadee", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 7, name: "Northern Cardinal", slug: "northern-cardinal", group: "wild", tier: "common", sprite_filename: "C011-northern-cardinal.svg", aria_announce_name: "a cardinal", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 8, name: "Ruby Throated Hummingbird", slug: "ruby-throated-hummingbird", group: "wild", tier: "common", sprite_filename: "C007-ruby-throated-hummingbird.svg", aria_announce_name: "a hummingbird", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 9, name: "Monarch Butterfly", slug: "monarch-butterfly", group: "wild", tier: "common", sprite_filename: "C002-monarch-butterfly.svg", aria_announce_name: "a monarch butterfly", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 10, name: "Convergent Ladybug", slug: "convergent-ladybug", group: "wild", tier: "common", sprite_filename: "C003-convergent-ladybug.svg", aria_announce_name: "a convergent ladybug", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 11, name: "Big Dipper Firefly", slug: "big-dipper-firefly", group: "wild", tier: "common", sprite_filename: "C004-big-dipper-firefly.svg", aria_announce_name: "a big dipper firefly", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 12, name: "Green Lacewing", slug: "green-lacewing", group: "wild", tier: "common", sprite_filename: "C005-green-lacewing.svg", aria_announce_name: "a green lacewing", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 13, name: "Common Earthworm", slug: "common-earthworm", group: "wild", tier: "common", sprite_filename: "C006-common-earthworm.svg", aria_announce_name: "a common earthworm", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 14, name: "Common Green Darner", slug: "common-green-darner", group: "wild", tier: "common", sprite_filename: "C008-common-green-darner.svg", aria_announce_name: "a common green darner", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 15, name: "Eastern Tiger Swallowtail", slug: "eastern-tiger-swallowtail", group: "wild", tier: "common", sprite_filename: "C009-eastern-tiger-swallowtail.svg", aria_announce_name: "an eastern tiger swallowtail", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 16, name: "Eastern Cottontail", slug: "eastern-cottontail", group: "wild", tier: "common", sprite_filename: "C010-eastern-cottontail.svg", aria_announce_name: "an eastern cottontail", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 17, name: "Eastern Bluebird", slug: "eastern-bluebird", group: "wild", tier: "common", sprite_filename: "C014-eastern-bluebird.svg", aria_announce_name: "an eastern bluebird", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 18, name: "Eastern Chipmunk", slug: "eastern-chipmunk", group: "wild", tier: "common", sprite_filename: "C015-eastern-chipmunk.svg", aria_announce_name: "an eastern chipmunk", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 19, name: "Red Squirrel", slug: "red-squirrel", group: "wild", tier: "common", sprite_filename: "C016-red-squirrel.svg", aria_announce_name: "a red squirrel", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 20, name: "Gray Treefrog", slug: "gray-treefrog", group: "wild", tier: "common", sprite_filename: "C017-gray-treefrog.svg", aria_announce_name: "a gray treefrog", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 21, name: "Eastern Garter Snake", slug: "eastern-garter-snake", group: "wild", tier: "common", sprite_filename: "C018-eastern-garter-snake.svg", aria_announce_name: "an eastern garter snake", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 22, name: "White Tailed Deer", slug: "white-tailed-deer", group: "wild", tier: "common", sprite_filename: "C019-white-tailed-deer.svg", aria_announce_name: "a white tailed deer", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 23, name: "Red Fox", slug: "red-fox", group: "wild", tier: "common", sprite_filename: "C020-red-fox.svg", aria_announce_name: "a red fox", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 24, name: "Woodchuck", slug: "woodchuck", group: "wild", tier: "common", sprite_filename: "C022-woodchuck.svg", aria_announce_name: "a woodchuck", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 25, name: "Northern Raccoon", slug: "northern-raccoon", group: "wild", tier: "common", sprite_filename: "C023-northern-raccoon.svg", aria_announce_name: "a northern raccoon", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 26, name: "Barred Owl", slug: "barred-owl", group: "wild", tier: "common", sprite_filename: "C024-barred-owl.svg", aria_announce_name: "a barred owl", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 27, name: "Black Bear", slug: "black-bear", group: "wild", tier: "common", sprite_filename: "C027-black-bear.svg", aria_announce_name: "a black bear", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 28, name: "Bobcat", slug: "bobcat", group: "wild", tier: "common", sprite_filename: "C028-bobcat.svg", aria_announce_name: "a bobcat", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 29, name: "Downy Woodpecker", slug: "downy-woodpecker", group: "wild", tier: "common", sprite_filename: "C030-downy-woodpecker.svg", aria_announce_name: "a downy woodpecker", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 30, name: "Mallard", slug: "mallard", group: "wild", tier: "common", sprite_filename: "C031-mallard.svg", aria_announce_name: "a mallard", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 31, name: "Polyphemus Moth", slug: "polyphemus-moth", group: "wild", tier: "common", sprite_filename: "C039-polyphemus-moth.svg", aria_announce_name: "a polyphemus moth", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 32, name: "Giant Panda", slug: "giant-panda", group: "wild", tier: "common", sprite_filename: "C040-giant-panda.svg", aria_announce_name: "a giant panda", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 33, name: "American Flamingo", slug: "american-flamingo", group: "wild", tier: "common", sprite_filename: "C041-american-flamingo.svg", aria_announce_name: "an american flamingo", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 34, name: "Galapagos Tortoise", slug: "galapagos-tortoise", group: "wild", tier: "common", sprite_filename: "C042-galapagos-tortoise.svg", aria_announce_name: "a galapagos tortoise", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 35, name: "Resplendent Quetzal", slug: "resplendent-quetzal", group: "wild", tier: "common", sprite_filename: "C043-resplendent-quetzal.svg", aria_announce_name: "a resplendent quetzal", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 36, name: "Bengal Tiger", slug: "bengal-tiger", group: "wild", tier: "common", sprite_filename: "C044-bengal-tiger.svg", aria_announce_name: "a bengal tiger", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 37, name: "Snow Leopard", slug: "snow-leopard", group: "wild", tier: "common", sprite_filename: "C045-snow-leopard.svg", aria_announce_name: "a snow leopard", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 38, name: "Tufted Titmouse", slug: "tufted-titmouse", group: "wild", tier: "common", sprite_filename: "C046-tufted-titmouse.svg", aria_announce_name: "a tufted titmouse", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 39, name: "American Crow", slug: "american-crow", group: "wild", tier: "common", sprite_filename: "C047-american-crow.svg", aria_announce_name: "an american crow", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 40, name: "Red Bellied Woodpecker", slug: "red-bellied-woodpecker", group: "wild", tier: "common", sprite_filename: "C048-red-bellied-woodpecker.svg", aria_announce_name: "a red bellied woodpecker", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 41, name: "White Breasted Nuthatch", slug: "white-breasted-nuthatch", group: "wild", tier: "common", sprite_filename: "C051-white-breasted-nuthatch.svg", aria_announce_name: "a white breasted nuthatch", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 42, name: "Eastern Gray Squirrel", slug: "eastern-gray-squirrel", group: "wild", tier: "common", sprite_filename: "C052-eastern-gray-squirrel.svg", aria_announce_name: "an eastern gray squirrel", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 43, name: "Striped Skunk", slug: "striped-skunk", group: "wild", tier: "common", sprite_filename: "C053-striped-skunk.svg", aria_announce_name: "a striped skunk", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 44, name: "American Green Frog", slug: "american-green-frog", group: "wild", tier: "common", sprite_filename: "C054-american-green-frog.svg", aria_announce_name: "an american green frog", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 45, name: "American Toad", slug: "american-toad", group: "wild", tier: "common", sprite_filename: "C055-american-toad.svg", aria_announce_name: "an american toad", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 46, name: "Redback Salamander", slug: "redback-salamander", group: "wild", tier: "common", sprite_filename: "C056-redback-salamander.svg", aria_announce_name: "a redback salamander", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 47, name: "Wild Turkey", slug: "wild-turkey", group: "wild", tier: "common", sprite_filename: "C057-wild-turkey.svg", aria_announce_name: "a wild turkey", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 48, name: "Common Raven", slug: "common-raven", group: "wild", tier: "common", sprite_filename: "C058-common-raven.svg", aria_announce_name: "a common raven", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 49, name: "American Woodcock", slug: "american-woodcock", group: "wild", tier: "common", sprite_filename: "C059-american-woodcock.svg", aria_announce_name: "an american woodcock", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 50, name: "Dark Eyed Junco", slug: "dark-eyed-junco", group: "wild", tier: "common", sprite_filename: "C060-dark-eyed-junco.svg", aria_announce_name: "a dark eyed junco", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 51, name: "Hairy Woodpecker", slug: "hairy-woodpecker", group: "wild", tier: "common", sprite_filename: "C061-hairy-woodpecker.svg", aria_announce_name: "a hairy woodpecker", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 52, name: "Yellow Bellied Sapsucker", slug: "yellow-bellied-sapsucker", group: "wild", tier: "common", sprite_filename: "C062-yellow-bellied-sapsucker.svg", aria_announce_name: "a yellow bellied sapsucker", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 53, name: "Pileated Woodpecker", slug: "pileated-woodpecker", group: "wild", tier: "common", sprite_filename: "C063-pileated-woodpecker.svg", aria_announce_name: "a pileated woodpecker", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 54, name: "Virginia Opossum", slug: "virginia-opossum", group: "wild", tier: "common", sprite_filename: "C064-virginia-opossum.svg", aria_announce_name: "a virginia opossum", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 55, name: "Big Brown Bat", slug: "big-brown-bat", group: "wild", tier: "common", sprite_filename: "C065-big-brown-bat.svg", aria_announce_name: "a big brown bat", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 56, name: "Hairy Tailed Mole", slug: "hairy-tailed-mole", group: "wild", tier: "common", sprite_filename: "C066-hairy-tailed-mole.svg", aria_announce_name: "a hairy tailed mole", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 57, name: "North American Porcupine", slug: "north-american-porcupine", group: "wild", tier: "common", sprite_filename: "C067-north-american-porcupine.svg", aria_announce_name: "a north american porcupine", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 58, name: "Deer Mouse", slug: "deer-mouse", group: "wild", tier: "common", sprite_filename: "C068-deer-mouse.svg", aria_announce_name: "a deer mouse", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 59, name: "Meadow Vole", slug: "meadow-vole", group: "wild", tier: "common", sprite_filename: "C069-meadow-vole.svg", aria_announce_name: "a meadow vole", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 60, name: "Common Snapping Turtle", slug: "common-snapping-turtle", group: "wild", tier: "common", sprite_filename: "C070-common-snapping-turtle.svg", aria_announce_name: "a common snapping turtle", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 61, name: "Spring Peeper", slug: "spring-peeper", group: "wild", tier: "common", sprite_filename: "C071-spring-peeper.svg", aria_announce_name: "a spring peeper", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 62, name: "Eastern Milk Snake", slug: "eastern-milk-snake", group: "wild", tier: "common", sprite_filename: "C072-eastern-milk-snake.svg", aria_announce_name: "an eastern milk snake", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 63, name: "Northern Water Snake", slug: "northern-water-snake", group: "wild", tier: "common", sprite_filename: "C073-northern-water-snake.svg", aria_announce_name: "a northern water snake", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 64, name: "Canada Goose", slug: "canada-goose", group: "wild", tier: "common", sprite_filename: "C074-canada-goose.svg", aria_announce_name: "a canada goose", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 65, name: "Great Horned Owl", slug: "great-horned-owl", group: "wild", tier: "common", sprite_filename: "C075-great-horned-owl.svg", aria_announce_name: "a great horned owl", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 66, name: "Indigo Bunting", slug: "indigo-bunting", group: "wild", tier: "common", sprite_filename: "C076-indigo-bunting.svg", aria_announce_name: "an indigo bunting", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 67, name: "Scarlet Tanager", slug: "scarlet-tanager", group: "wild", tier: "common", sprite_filename: "C077-scarlet-tanager.svg", aria_announce_name: "a scarlet tanager", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 68, name: "Cedar Waxwing", slug: "cedar-waxwing", group: "wild", tier: "common", sprite_filename: "C078-cedar-waxwing.svg", aria_announce_name: "a cedar waxwing", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 69, name: "Baltimore Oriole", slug: "baltimore-oriole", group: "wild", tier: "common", sprite_filename: "C079-baltimore-oriole.svg", aria_announce_name: "a baltimore oriole", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 70, name: "American Kestrel", slug: "american-kestrel", group: "wild", tier: "common", sprite_filename: "C080-american-kestrel.svg", aria_announce_name: "an american kestrel", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 71, name: "Peregrine Falcon", slug: "peregrine-falcon", group: "wild", tier: "common", sprite_filename: "C081-peregrine-falcon.svg", aria_announce_name: "a peregrine falcon", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 72, name: "Coopers Hawk", slug: "coopers-hawk", group: "wild", tier: "common", sprite_filename: "C082-coopers-hawk.svg", aria_announce_name: "a coopers hawk", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 73, name: "Ring Necked Duck", slug: "ring-necked-duck", group: "wild", tier: "common", sprite_filename: "C083-ring-necked-duck.svg", aria_announce_name: "a ring necked duck", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 74, name: "Willow Flycatcher", slug: "willow-flycatcher", group: "wild", tier: "common", sprite_filename: "C084-willow-flycatcher.svg", aria_announce_name: "a willow flycatcher", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 75, name: "Ruffed Grouse", slug: "ruffed-grouse", group: "wild", tier: "common", sprite_filename: "C085-ruffed-grouse.svg", aria_announce_name: "a ruffed grouse", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 76, name: "Yellow Billed Cuckoo", slug: "yellow-billed-cuckoo", group: "wild", tier: "common", sprite_filename: "C086-yellow-billed-cuckoo.svg", aria_announce_name: "a yellow billed cuckoo", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 77, name: "Ovenbird", slug: "ovenbird", group: "wild", tier: "common", sprite_filename: "C087-ovenbird.svg", aria_announce_name: "an ovenbird", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 78, name: "Eastern Racer", slug: "eastern-racer", group: "wild", tier: "common", sprite_filename: "C088-eastern-racer.svg", aria_announce_name: "an eastern racer", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 79, name: "Bald Eagle", slug: "bald-eagle", group: "wild", tier: "common", sprite_filename: "C089-bald-eagle.svg", aria_announce_name: "a bald eagle", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 80, name: "Gray Fox", slug: "gray-fox", group: "wild", tier: "common", sprite_filename: "C090-gray-fox.svg", aria_announce_name: "a gray fox", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 81, name: "North American Beaver", slug: "north-american-beaver", group: "wild", tier: "common", sprite_filename: "C091-north-american-beaver.svg", aria_announce_name: "a north american beaver", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 82, name: "American Mink", slug: "american-mink", group: "wild", tier: "common", sprite_filename: "C092-american-mink.svg", aria_announce_name: "an american mink", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 83, name: "Long Tailed Weasel", slug: "long-tailed-weasel", group: "wild", tier: "common", sprite_filename: "C093-long-tailed-weasel.svg", aria_announce_name: "a long tailed weasel", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 84, name: "Little Brown Bat", slug: "little-brown-bat", group: "wild", tier: "common", sprite_filename: "C094-little-brown-bat.svg", aria_announce_name: "a little brown bat", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 85, name: "Summer Tanager", slug: "summer-tanager", group: "wild", tier: "common", sprite_filename: "C095-summer-tanager.svg", aria_announce_name: "a summer tanager", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 86, name: "Yellow Bellied Flycatcher", slug: "yellow-bellied-flycatcher", group: "wild", tier: "common", sprite_filename: "C096-yellow-bellied-flycatcher.svg", aria_announce_name: "a yellow bellied flycatcher", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 87, name: "Cerulean Warbler", slug: "cerulean-warbler", group: "wild", tier: "common", sprite_filename: "C097-cerulean-warbler.svg", aria_announce_name: "a cerulean warbler", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 88, name: "Common Nighthawk", slug: "common-nighthawk", group: "wild", tier: "common", sprite_filename: "C098-common-nighthawk.svg", aria_announce_name: "a common nighthawk", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 89, name: "Red Headed Woodpecker", slug: "red-headed-woodpecker", group: "wild", tier: "common", sprite_filename: "C099-red-headed-woodpecker.svg", aria_announce_name: "a red headed woodpecker", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 90, name: "Grasshopper Sparrow", slug: "grasshopper-sparrow", group: "wild", tier: "common", sprite_filename: "C100-grasshopper-sparrow.svg", aria_announce_name: "a grasshopper sparrow", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 91, name: "Black Billed Cuckoo", slug: "black-billed-cuckoo", group: "wild", tier: "common", sprite_filename: "C101-black-billed-cuckoo.svg", aria_announce_name: "a black billed cuckoo", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 92, name: "Orange Crowned Warbler", slug: "orange-crowned-warbler", group: "wild", tier: "common", sprite_filename: "C102-orange-crowned-warbler.svg", aria_announce_name: "an orange crowned warbler", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 93, name: "Merlin", slug: "merlin", group: "wild", tier: "common", sprite_filename: "C103-merlin.svg", aria_announce_name: "a merlin", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 94, name: "Purple Martin", slug: "purple-martin", group: "wild", tier: "common", sprite_filename: "C104-purple-martin.svg", aria_announce_name: "a purple martin", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 95, name: "Orchard Oriole", slug: "orchard-oriole", group: "wild", tier: "common", sprite_filename: "C105-orchard-oriole.svg", aria_announce_name: "an orchard oriole", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 96, name: "Moose", slug: "moose", group: "wild", tier: "common", sprite_filename: "C106-moose.svg", aria_announce_name: "a moose", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 97, name: "Fisher", slug: "fisher", group: "wild", tier: "common", sprite_filename: "C107-fisher.svg", aria_announce_name: "a fisher", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 98, name: "American Ermine", slug: "american-ermine", group: "wild", tier: "common", sprite_filename: "C108-american-ermine.svg", aria_announce_name: "an american ermine", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 99, name: "Eastern Red Bat", slug: "eastern-red-bat", group: "wild", tier: "common", sprite_filename: "C109-eastern-red-bat.svg", aria_announce_name: "an eastern red bat", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 100, name: "Snowshoe Hare", slug: "snowshoe-hare", group: "wild", tier: "common", sprite_filename: "C110-snowshoe-hare.svg", aria_announce_name: "a snowshoe hare", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 101, name: "Star Nosed Mole", slug: "star-nosed-mole", group: "wild", tier: "common", sprite_filename: "C111-star-nosed-mole.svg", aria_announce_name: "a star nosed mole", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 102, name: "Eastern Wood Pewee", slug: "eastern-wood-pewee", group: "wild", tier: "common", sprite_filename: "C112-eastern-wood-pewee.svg", aria_announce_name: "an eastern wood pewee", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 103, name: "Eastern Phoebe", slug: "eastern-phoebe", group: "wild", tier: "common", sprite_filename: "C113-eastern-phoebe.svg", aria_announce_name: "an eastern phoebe", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 104, name: "Veery", slug: "veery", group: "wild", tier: "common", sprite_filename: "C114-veery.svg", aria_announce_name: "a veery", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 105, name: "Hermit Thrush", slug: "hermit-thrush", group: "wild", tier: "common", sprite_filename: "C115-hermit-thrush.svg", aria_announce_name: "a hermit thrush", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 106, name: "Northern Parula", slug: "northern-parula", group: "wild", tier: "common", sprite_filename: "C116-northern-parula.svg", aria_announce_name: "a northern parula", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 107, name: "Blue Headed Vireo", slug: "blue-headed-vireo", group: "wild", tier: "common", sprite_filename: "C117-blue-headed-vireo.svg", aria_announce_name: "a blue headed vireo", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 108, name: "Eastern Screech Owl", slug: "eastern-screech-owl", group: "wild", tier: "common", sprite_filename: "C118-eastern-screech-owl.svg", aria_announce_name: "an eastern screech owl", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 109, name: "Red Shouldered Hawk", slug: "red-shouldered-hawk", group: "wild", tier: "common", sprite_filename: "C119-red-shouldered-hawk.svg", aria_announce_name: "a red shouldered hawk", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 110, name: "Wood Frog", slug: "wood-frog", group: "wild", tier: "common", sprite_filename: "C120-wood-frog.svg", aria_announce_name: "a wood frog", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 111, name: "Red Eft", slug: "red-eft", group: "wild", tier: "common", sprite_filename: "C121-red-eft.svg", aria_announce_name: "a red eft", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 112, name: "Pickerel Frog", slug: "pickerel-frog", group: "wild", tier: "common", sprite_filename: "C122-pickerel-frog.svg", aria_announce_name: "a pickerel frog", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 113, name: "Black Throated Blue Warbler", slug: "black-throated-blue-warbler", group: "wild", tier: "common", sprite_filename: "C123-black-throated-blue-warbler.svg", aria_announce_name: "a black throated blue warbler", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 114, name: "Northern Saw Whet Owl", slug: "northern-saw-whet-owl", group: "wild", tier: "common", sprite_filename: "C124-northern-saw-whet-owl.svg", aria_announce_name: "a northern saw whet owl", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 115, name: "Whip Poor Will", slug: "whip-poor-will", group: "wild", tier: "common", sprite_filename: "C125-whip-poor-will.svg", aria_announce_name: "a whip poor will", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 116, name: "Wood Turtle", slug: "wood-turtle", group: "wild", tier: "common", sprite_filename: "C126-wood-turtle.svg", aria_announce_name: "a wood turtle", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 117, name: "Smooth Green Snake", slug: "smooth-green-snake", group: "wild", tier: "common", sprite_filename: "C127-smooth-green-snake.svg", aria_announce_name: "a smooth green snake", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 118, name: "Spotted Salamander", slug: "spotted-salamander", group: "wild", tier: "common", sprite_filename: "C128-spotted-salamander.svg", aria_announce_name: "a spotted salamander", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 119, name: "Southern Flying Squirrel", slug: "southern-flying-squirrel", group: "wild", tier: "common", sprite_filename: "C129-southern-flying-squirrel.svg", aria_announce_name: "a southern flying squirrel", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 120, name: "Luna Moth", slug: "luna-moth", group: "wild", tier: "common", sprite_filename: "C130-luna-moth.svg", aria_announce_name: "a luna moth", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 121, name: "Cecropia Moth", slug: "cecropia-moth", group: "wild", tier: "common", sprite_filename: "C131-cecropia-moth.svg", aria_announce_name: "a cecropia moth", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 122, name: "Wheel Bug", slug: "wheel-bug", group: "wild", tier: "common", sprite_filename: "C132-wheel-bug.svg", aria_announce_name: "a wheel bug", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 123, name: "Bobolink", slug: "bobolink", group: "wild", tier: "common", sprite_filename: "C133-bobolink.svg", aria_announce_name: "a bobolink", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 124, name: "Eastern Meadowlark", slug: "eastern-meadowlark", group: "wild", tier: "common", sprite_filename: "C134-eastern-meadowlark.svg", aria_announce_name: "an eastern meadowlark", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 125, name: "Golden Winged Warbler", slug: "golden-winged-warbler", group: "wild", tier: "common", sprite_filename: "C135-golden-winged-warbler.svg", aria_announce_name: "a golden winged warbler", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 126, name: "Northern Goshawk", slug: "northern-goshawk", group: "wild", tier: "common", sprite_filename: "C136-northern-goshawk.svg", aria_announce_name: "a northern goshawk", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 127, name: "Olive Sided Flycatcher", slug: "olive-sided-flycatcher", group: "wild", tier: "common", sprite_filename: "C137-olive-sided-flycatcher.svg", aria_announce_name: "an olive sided flycatcher", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 128, name: "Northern Long Eared Bat", slug: "northern-long-eared-bat", group: "wild", tier: "common", sprite_filename: "C138-northern-long-eared-bat.svg", aria_announce_name: "a northern long eared bat", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 129, name: "Tricolored Bat", slug: "tricolored-bat", group: "wild", tier: "common", sprite_filename: "C139-tricolored-bat.svg", aria_announce_name: "a tricolored bat", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 130, name: "New England Cottontail", slug: "new-england-cottontail", group: "wild", tier: "common", sprite_filename: "C140-new-england-cottontail.svg", aria_announce_name: "a new england cottontail", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 131, name: "Blandings Turtle", slug: "blandings-turtle", group: "wild", tier: "common", sprite_filename: "C141-blandings-turtle.svg", aria_announce_name: "a blandings turtle", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 132, name: "Marbled Salamander", slug: "marbled-salamander", group: "wild", tier: "common", sprite_filename: "C142-marbled-salamander.svg", aria_announce_name: "a marbled salamander", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 133, name: "Rusty Patched Bumblebee", slug: "rusty-patched-bumblebee", group: "wild", tier: "common", sprite_filename: "C143-rusty-patched-bumblebee.svg", aria_announce_name: "a rusty patched bumblebee", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 134, name: "Puritan Tiger Beetle", slug: "puritan-tiger-beetle", group: "wild", tier: "common", sprite_filename: "C144-puritan-tiger-beetle.svg", aria_announce_name: "a puritan tiger beetle", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 135, name: "Frosted Elfin", slug: "frosted-elfin", group: "wild", tier: "common", sprite_filename: "C145-frosted-elfin.svg", aria_announce_name: "a frosted elfin", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 136, name: "Common Eastern Bumblebee", slug: "common-eastern-bumblebee", group: "wild", tier: "common", sprite_filename: "C146-common-eastern-bumblebee.svg", aria_announce_name: "a common eastern bumblebee", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 137, name: "Eastern Carpenter Bee", slug: "eastern-carpenter-bee", group: "wild", tier: "common", sprite_filename: "C147-eastern-carpenter-bee.svg", aria_announce_name: "an eastern carpenter bee", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 138, name: "Paper Wasp", slug: "paper-wasp", group: "wild", tier: "common", sprite_filename: "C148-paper-wasp.svg", aria_announce_name: "a paper wasp", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 139, name: "Hover Fly", slug: "hover-fly", group: "wild", tier: "common", sprite_filename: "C149-hover-fly.svg", aria_announce_name: "a hover fly", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 140, name: "Bald Faced Hornet", slug: "bald-faced-hornet", group: "wild", tier: "common", sprite_filename: "C150-bald-faced-hornet.svg", aria_announce_name: "a bald faced hornet", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 141, name: "Mud Dauber Wasp", slug: "mud-dauber-wasp", group: "wild", tier: "common", sprite_filename: "C151-mud-dauber-wasp.svg", aria_announce_name: "a mud dauber wasp", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 142, name: "Great Golden Digger Wasp", slug: "great-golden-digger-wasp", group: "wild", tier: "common", sprite_filename: "C152-great-golden-digger-wasp.svg", aria_announce_name: "a great golden digger wasp", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 143, name: "Leafcutter Bee", slug: "leafcutter-bee", group: "wild", tier: "common", sprite_filename: "C153-leafcutter-bee.svg", aria_announce_name: "a leafcutter bee", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 144, name: "Garden Snail", slug: "garden-snail", group: "wild", tier: "common", sprite_filename: "C154-garden-snail.svg", aria_announce_name: "a garden snail", base_weight: 3, base_probability: 0.00303838 }),
  Object.freeze({ species_id: 145, name: "American Marten", slug: "american-marten", group: "legacy", tier: "uncommon", sprite_filename: "L001-american-marten.svg", aria_announce_name: "an american marten", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 146, name: "Eastern Wolf", slug: "eastern-wolf", group: "legacy", tier: "uncommon", sprite_filename: "L002-eastern-wolf.svg", aria_announce_name: "an eastern wolf", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 147, name: "Passenger Pigeon", slug: "passenger-pigeon", group: "legacy", tier: "uncommon", sprite_filename: "L003-passenger-pigeon.svg", aria_announce_name: "a passenger pigeon", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 148, name: "Heath Hen", slug: "heath-hen", group: "legacy", tier: "uncommon", sprite_filename: "L004-heath-hen.svg", aria_announce_name: "a heath hen", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 149, name: "Eastern Wild Turkey Ghost", slug: "eastern-wild-turkey-ghost", group: "legacy", tier: "uncommon", sprite_filename: "L005-eastern-wild-turkey-ghost.svg", aria_announce_name: "an eastern wild turkey ghost", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 150, name: "Eastern Elk", slug: "eastern-elk", group: "legacy", tier: "uncommon", sprite_filename: "L006-eastern-elk.svg", aria_announce_name: "an eastern elk", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 151, name: "Woodland Caribou", slug: "woodland-caribou", group: "legacy", tier: "uncommon", sprite_filename: "L007-woodland-caribou.svg", aria_announce_name: "a woodland caribou", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 152, name: "Wild Atlantic Salmon", slug: "wild-atlantic-salmon", group: "legacy", tier: "uncommon", sprite_filename: "L008-wild-atlantic-salmon.svg", aria_announce_name: "a wild atlantic salmon", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 153, name: "Sea Mink", slug: "sea-mink", group: "legacy", tier: "uncommon", sprite_filename: "L009-sea-mink.svg", aria_announce_name: "a sea mink", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 154, name: "Great Auk", slug: "great-auk", group: "legacy", tier: "uncommon", sprite_filename: "L010-great-auk.svg", aria_announce_name: "a great auk", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 155, name: "Labrador Duck", slug: "labrador-duck", group: "legacy", tier: "uncommon", sprite_filename: "L011-labrador-duck.svg", aria_announce_name: "a labrador duck", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 156, name: "Eskimo Curlew", slug: "eskimo-curlew", group: "legacy", tier: "uncommon", sprite_filename: "L012-eskimo-curlew.svg", aria_announce_name: "an eskimo curlew", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 157, name: "Carolina Parakeet", slug: "carolina-parakeet", group: "legacy", tier: "uncommon", sprite_filename: "L013-carolina-parakeet.svg", aria_announce_name: "a carolina parakeet", base_weight: 2, base_probability: 0.00202559 }),
  Object.freeze({ species_id: 158, name: "Eastern Cougar", slug: "eastern-cougar", group: "cryptid", tier: "rare", sprite_filename: "Y001-eastern-cougar.svg", aria_announce_name: "an eastern cougar", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 159, name: "Melanistic Bobcat", slug: "melanistic-bobcat", group: "cryptid", tier: "rare", sprite_filename: "Y002-melanistic-bobcat.svg", aria_announce_name: "a melanistic bobcat", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 160, name: "Wolverine", slug: "wolverine", group: "cryptid", tier: "rare", sprite_filename: "Y003-wolverine.svg", aria_announce_name: "a wolverine", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 161, name: "White Squirrel", slug: "white-squirrel", group: "cryptid", tier: "rare", sprite_filename: "Y004-white-squirrel.svg", aria_announce_name: "a white squirrel", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 162, name: "Lake Monster Champ", slug: "lake-monster-champ", group: "cryptid", tier: "rare", sprite_filename: "Y005-lake-monster-champ.svg", aria_announce_name: "a lake monster champ", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 163, name: "Pukwudgie", slug: "pukwudgie", group: "cryptid", tier: "rare", sprite_filename: "Y006-pukwudgie.svg", aria_announce_name: "a pukwudgie", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 164, name: "Dover Demon", slug: "dover-demon", group: "cryptid", tier: "rare", sprite_filename: "Y007-dover-demon.svg", aria_announce_name: "a dover demon", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 165, name: "Glawackus", slug: "glawackus", group: "cryptid", tier: "rare", sprite_filename: "Y008-glawackus.svg", aria_announce_name: "a glawackus", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 166, name: "Gloucester Sea Serpent", slug: "gloucester-sea-serpent", group: "cryptid", tier: "rare", sprite_filename: "Y009-gloucester-sea-serpent.svg", aria_announce_name: "a gloucester sea serpent", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 167, name: "Pioneer Valley Visitor", slug: "pioneer-valley-visitor", group: "cryptid", tier: "rare", sprite_filename: "Y010-pioneer-valley-visitor.svg", aria_announce_name: "a pioneer valley visitor", base_weight: 1, base_probability: 0.00101279 }),
  Object.freeze({ species_id: 168, name: "Memphre", slug: "memphre", group: "cryptid", tier: "rare", sprite_filename: "Y011-memphre.svg", aria_announce_name: "a memphre", base_weight: 1, base_probability: 0.00101279 }),
])

// Convenience subsets — computed once at module load.
export const BASELINE_RESIDENTS = Object.freeze(SPECIES_POOL.filter(s => s.tier === 'baseline'))
export const EARNED_POOL = Object.freeze(SPECIES_POOL.filter(s => s.tier !== 'baseline'))
export const BY_ID = Object.freeze(Object.fromEntries(SPECIES_POOL.map(s => [s.species_id, s])))

// Smoke-test sentinel (per revision §2.6). Out-of-pool; NEVER use in real flows.
export const SMOKE_SENTINEL_SPECIES_ID = 255

// Sum of base_probability across earned pool — informational; useful in tests / docs.
// Note: real total at award-time may differ once prefs/multipliers are applied.
export const TOTAL_BASE_PROBABILITY = EARNED_POOL.reduce((a, s) => a + (s.base_probability ?? 0), 0)

// ─── pickSpecies ─────────────────────────────────────────────────────────────
// Deterministic, pure. Given the same (seed, prefs, opts) tuple, returns the same result.
//
// Inputs:
//   seed  — string — typically `${source_event_id}|${event_log.created_at}|${householdId}`.
//   prefs — { [species_id]: weight } — from critter_species_prefs PATCH'd rows (D-INV-1).
//           Missing species_ids default to 1.0. Weight 2.0 = love, 0.5 = meh (per §3.29).
//   opts  — { speciesMultipliers?: { [species_id]: number } } — future season/milestone
//           multipliers. Each multiplier modulates base_probability (cap effective total
//           at 1.0). Today: pass {} or omit; V4 blocker will source from DB/config.
//
// Output: species_id in [1, 8] (earned pool only — V101 retired baselines), OR null = "no critter awarded this event."
//   The null path is intentional (variable-ratio reward — Dave directive 2026-05-30).
//
// Algorithm:
//   1) Per-species effective_prob = base_probability × prefs_weight × multiplier.
//   2) total = sum(effective_probs), clamped to 1.0 to defend against runaway multipliers.
//   3) r = FNV-1a hash of seed → uniform in [0, 1).
//   4) If r >= total → return null (no critter this time).
//   5) Else: walk cumulative distribution, return first species whose cumulative reaches r.

export function pickSpecies(seed, prefs = {}, opts = {}) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('pickSpecies: seed must be a non-empty string')
  }
  const speciesMultipliers = opts && opts.speciesMultipliers ? opts.speciesMultipliers : {}
  const probabilities = EARNED_POOL.map(s => {
    const pref = (prefs && Number.isFinite(prefs[s.species_id]) && prefs[s.species_id] > 0)
      ? prefs[s.species_id]
      : 1.0
    const mult = (Number.isFinite(speciesMultipliers[s.species_id]) && speciesMultipliers[s.species_id] >= 0)
      ? speciesMultipliers[s.species_id]
      : 1.0
    const base = Number.isFinite(s.base_probability) ? s.base_probability : 0
    return base * pref * mult
  })
  const total = probabilities.reduce((a, b) => a + b, 0)
  const totalClamped = Math.min(Math.max(total, 0), 1.0)
  const r = fnv1aUniform(seed)
  if (r >= totalClamped) return null  // no critter for this event (variable-ratio gate)
  let cum = 0
  for (let i = 0; i < EARNED_POOL.length; i++) {
    cum += probabilities[i]
    if (r < cum) return EARNED_POOL[i].species_id
  }
  return EARNED_POOL[EARNED_POOL.length - 1].species_id  // numeric edge (r ≈ totalClamped)
}

// pickCopyVariant — deterministic seed → integer in [0, poolSize) for Stage 1 variant selection.
// Pool size is the count of variants in the Stage 1 single-action set (default 10 per packet).
// Pure JS; identical on Node + browser. (Unchanged from pre-probabilistic refactor.)
export function pickCopyVariant(seed, poolSize) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('pickCopyVariant: seed must be a non-empty string')
  }
  if (!Number.isInteger(poolSize) || poolSize <= 0) {
    throw new Error('pickCopyVariant: poolSize must be a positive integer')
  }
  // Use a different hash domain so copy-variant index doesn't trivially correlate with species.
  const r = fnv1aUniform(seed + '|copy')
  return Math.floor(r * poolSize)
}

// FNV-1a 32-bit hash → uniform in [0, 1). Pure JS, no deps, identical on Node + browser.
function fnv1aUniform(s) {
  let h = 0x811c9dc5 // 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 0x100000000
}
