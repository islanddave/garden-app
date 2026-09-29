// stats-kit/palette — every colour the Season stats page draws with, as CSS custom properties.
//
// Charts and cards reference `var(--gs-*)` only; the page root sets the values (statsThemeVars). The
// light set is the app's own P tokens where one exists, and the approved round-1/round-2 chart hues
// (_mainsync13_20260928/T-stats/gen/page.css) for the chart-only colours P has no name for (heat
// bands, crop and care-kind hues). The dark set is the same design's dark palette.
//
// The app has no dark theme today (nothing in src reads prefers-color-scheme or sets a theme), so the
// page picks dark only when <html data-theme="dark"> is set — inert until the app grows a theme
// switch, and then these charts follow it without a second pass. Going dark on prefers-color-scheme
// alone would paint one dark page inside a light app.
import { P } from '../constants.js'

export const STATS_LIGHT = {
  '--gs-page': P.cream,
  '--gs-card': P.white,
  '--gs-well': P.photoPlaceholder,
  '--gs-hair': P.border,
  '--gs-grid': '#e6dfd3',
  '--gs-ink': P.dark,
  '--gs-ink-2': P.mid,
  '--gs-ink-3': P.light,
  '--gs-title': P.green,
  '--gs-link': P.green,
  '--gs-sage': '#4f7042',
  '--gs-gold': P.gold,
  '--gs-rust': '#973f20',
  '--gs-water': P.blue,
  '--gs-temp': '#d3c29d',
  '--gs-gone': '#bdb3a0',
  '--gs-h0': '#6aa56f', '--gs-h1': '#e3b23c', '--gs-h2': '#de8a2e',
  '--gs-h3': '#c9522b', '--gs-h4': '#9e2a22', '--gs-h5': '#5e1a14',
  '--gs-tomato': '#b0305a', '--gs-pepper': '#e07020', '--gs-veg': '#3d8b3d',
  '--gs-fruit': '#6a4fb0', '--gs-herb': '#c9a227', '--gs-flower': '#d65da0',
  '--gs-indoor': '#2f78c4', '--gs-none': '#b9b1a2',
  '--gs-t-water': '#3f7fb5', '--gs-t-feed': '#8a6a48', '--gs-t-pests': '#973f20',
  '--gs-t-starts': '#3e8e5e', '--gs-t-upkeep': '#6f8a78', '--gs-t-checkins': '#7a5c8e',
}

export const STATS_DARK = {
  '--gs-page': '#14150f',
  '--gs-card': '#1e1f18',
  '--gs-well': '#17180f',
  '--gs-hair': '#3a3b30',
  '--gs-grid': '#2c2d24',
  '--gs-ink': '#ece7d8',
  '--gs-ink-2': '#c2bba8',
  '--gs-ink-3': '#958f80',
  '--gs-title': '#8db07c',
  '--gs-link': '#8db07c',
  '--gs-sage': '#8db07c',
  '--gs-gold': '#d9b25a',
  '--gs-rust': '#d9744e',
  '--gs-water': '#6fa3d6',
  '--gs-temp': '#6a624b',
  '--gs-gone': '#5a5b4d',
  '--gs-h0': '#7dbf84', '--gs-h1': '#e9c35a', '--gs-h2': '#e8994a',
  '--gs-h3': '#e26d3e', '--gs-h4': '#d64a36', '--gs-h5': '#9c2a3c',
  '--gs-tomato': '#b93a73', '--gs-pepper': '#d9762e', '--gs-veg': '#4e9e4e',
  '--gs-fruit': '#8a70e0', '--gs-herb': '#ae8a2a', '--gs-flower': '#d86e92',
  '--gs-indoor': '#4a8edb', '--gs-none': '#6b665a',
  '--gs-t-water': '#6fa3d6', '--gs-t-feed': '#b08a62', '--gs-t-pests': '#d9744e',
  '--gs-t-starts': '#5fbf85', '--gs-t-upkeep': '#8fae98', '--gs-t-checkins': '#a78bd0',
}

export const v = (name) => `var(--gs-${name})`

export const BAND_COLOR = { sweet: v('h0'), mild: v('h1'), medium: v('h2'), hot: v('h3'), very_hot: v('h4'), superhot: v('h5') }
export const SOURCE_GROUP_COLOR = {
  nursery: v('veg'), seed: v('herb'), rescued: v('fruit'), gift: v('flower'), other: v('indoor'), none: v('none'),
}
export const careColor = (kind) => v(`t-${kind}`)

export function currentStatsTheme(doc = typeof document !== 'undefined' ? document : null) {
  return doc?.documentElement?.dataset?.theme === 'dark' ? 'dark' : 'light'
}

export function statsThemeVars(theme = currentStatsTheme()) {
  return theme === 'dark' ? STATS_DARK : STATS_LIGHT
}
