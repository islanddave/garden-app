// V3-IA: the standalone Plants/Plantings page is retired — Garden absorbed it.
// Old /plants links (bookmarks, PlantingDetail ?edit=, InventoryDetail packet CTA,
// FAB ?add=1) redirect to /garden with the full query string preserved so the
// Garden PlantingEditor deep-links keep working.
import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'

export default function PlantsRedirect() {
  const location = useLocation()
  return <Navigate to={{ pathname: '/garden', search: location.search }} replace />
}
