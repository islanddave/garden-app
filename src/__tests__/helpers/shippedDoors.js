// V5-NAVCUSTOM-001 — THE DOOR CENSUS, LITERAL. Every navigating door the tab bar and the More sheet had
// at dev ff1e03ea5b185294acd9f0f7553717c7ec30e7d6 (v4.146.0, before per-person bars and pins), read off
// that commit's src/components/BottomNav.jsx (15 <SheetRowLink> More rows; SEEDS_PATH = '/seeds') and
// src/lib/navConfig.js (the four non-FAB tabs) by hand. Deliberately NOT derived from MORE_ROWS or
// TAB_REGISTRY: QA MINOR-3 found that an oracle built from the registry loses a door together with the
// row, so a retired row went unnoticed. Removing a door from this file is a decision, made in the open.
//
// Not doors: the ＋ slot (a button that opens the create sheet) and, in field mode, the mic → /field,
// which BottomNav.navConfig.test.jsx pins on its own.
export const SHIPPED_TAB_HREFS = ['/today', '/garden', '/harvests', '/put-up']

// In the sheet's shipped order (SPACE_PHOTOS_ENABLED on, CATCH_UP_EDITOR_SHIPPED off).
export const SHIPPED_MORE_HREFS = [
  '/dashboard', '/findings', '/photos', '/space', '/locations', '/inventory', '/seeds', '/achievements',
  '/collection', '/helper', '/settings', '/settings/controls', '/about', '/releases', '/admin',
]
