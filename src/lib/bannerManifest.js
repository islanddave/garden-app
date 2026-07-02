// V4-APPBANNER-001 — curated header-banner pool. Provenance keys back to Photos/photo-index.json
// (gardening-docs repo). Assets are pre-graded band crops (peach wash + desaturate + luminance
// normalize, 1800x198 WebP <=80KB) produced + gated by scripts/banner_contrast.py — re-run it after
// ANY pool change. Seasonal pools fill at season-boundary re-curation passes; a season with no
// photos falls back to the full pool (pickBanner). V4-PHOTOFIRSTCLASS-001 supersedes this bundle.
import goldenHourRow from '../assets/banners/golden-hour-row.webp'
import meadowFence from '../assets/banners/meadow-fence.webp'
import indoorRack from '../assets/banners/indoor-rack.webp'
import beetBags from '../assets/banners/beet-bags.webp'
import tomatoPallet from '../assets/banners/tomato-pallet.webp'

export const BANNERS = [
  { id: 'golden-hour-row', src: goldenHourRow, season: 'summer', position: 'center',
    source: 'Plants/IMG20260603185114.jpg', captured: '2026-06-03',
    note: 'Evening light down the grow-bag row along the driveway edge' },
  { id: 'meadow-fence', src: meadowFence, season: 'summer', position: 'center',
    source: 'Plants/IMG20260601193549.jpg', captured: '2026-06-01',
    note: 'Meadow, split-rail fence and the young tree, woods behind' },
  { id: 'indoor-rack', src: indoorRack, season: 'winter', position: 'center',
    source: 'Plants/IMG20260531204757.jpg', captured: '2026-05-31',
    note: 'The indoor grow-light rack, red cups under the lights (winter-bridge shot)' },
  { id: 'beet-bags', src: beetBags, season: 'summer', position: 'center',
    source: 'Plants/IMG20260604140154.jpg', captured: '2026-06-04',
    note: 'Beet bags — red stems and green mass' },
  { id: 'tomato-pallet', src: tomatoPallet, season: 'summer', position: 'center',
    source: 'Plants/IMG20260602152057.jpg', captured: '2026-06-02',
    note: 'Tomatoes in grow bags on the pallet, marigold front-left' },
]
