// src/components/kitchen/useSheetDraftKey.js
// The signed-in person's draft key for one Put-Up sheet (V4 §6.5). Kept apart from ./sheetDraft.js,
// which is storage only, because AuthContext.signOut imports that module to clear drafts.
// useAuthOptional, never useAuth: a sheet rendered with no AuthProvider (a unit test, a harness)
// keeps working and simply keeps no draft.
import { useAuthOptional } from '../../context/AuthContext.jsx'
import { sheetDraftKey } from './sheetDraft.js'

export function useSheetDraftKey(sheet, id) {
  const { user } = useAuthOptional()
  return sheetDraftKey(user?.id ?? null, sheet, id)
}
