// The one reader of the planting-chooser projection. Every consumer gets the list through this
// module, so the path (and with it the dataCache key `${sub}|${path}`) is spelled once and every
// cached reader shares one warm entry. lambda/plants/grid-view.test.js censuses the importers of
// this file against the field reads the projection was built from: a new importer must be counted
// there.
import { useCachedFetch } from './useCachedFetch.js'

export const PICKER_PATH = '/api/plants?view=picker'

export function pickerPath(projectId) {
  return projectId ? `${PICKER_PATH}&project_id=${projectId}` : PICKER_PATH
}

// SWR read through useCachedFetch: household-scoped cache, `error` only on a cold failure.
// `enabled: false` is the hook's IDLE mode (no request, no cache entry). Readers that must not go
// through useCachedFetch (PhotoLibrary, LogManyVoice) import PICKER_PATH instead and say why.
export function usePlantPicker({ enabled = true, projectId = null } = {}) {
  return useCachedFetch(enabled ? pickerPath(projectId) : null)
}
