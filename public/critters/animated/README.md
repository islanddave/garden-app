# Animated critters (critters-v2) — 168 files

Animated SVG versions of every non-special roster critter, built 2026-06-17 (spec V100).

## What this is
Each file here is the **animated** counterpart of the static art one level up in `../{id}-{slug}.svg`.
Same filename, same art, same colors — with ambient looping motion added via SMIL
(`animateTransform` / `animate`). The technique mirrors the special-tier "Nugget" reference.

## Groups
- wild (C): 144
- legacy (L): 13
- cryptid (Y): 11

## Motion by family
- Songbirds / woodpeckers / corvids -> wing flap (+ blink)
- Owls -> slow blink + head tilt; raptors -> blink + head turn; bats -> wing-membrane flap
- Waterfowl / gamebirds / doves / nightjars -> gentle body/head bob (+ blink); ghost turkey -> spectral shimmer
- Bees / wasps / flies / dragonfly / hummingbird -> hover bob + fast wing buzz
- Butterflies / moths -> wing flutter (scale about body axis)
- Snakes / earthworm -> slither (body path-d morph) + tongue flick
- Frogs / toads -> throat puff + blink; salamanders -> breathe + tail sway; turtles -> head bob + blink
- Mammals -> gentle breathe + ear twitch (+ tail sway / blink)
- Firefly -> lantern glow; snail -> eyestalk sway; salmon -> fish sway; cryptids -> head bob / eerie eye-glow / float

## Status / next steps (NOT done here, by design)
- App still loads the STATIC files. Wiring the app to prefer these animated files (and to fall back to
  the static set on `prefers-reduced-motion: reduce`) is a separate, code-touching task for later.
- Reduced-motion strategy: serve the static reserve file; these animated SVGs intentionally carry no
  internal CSS media gating.

See `../../../../critter-animation-v2-spec.md` for the full build spec.
