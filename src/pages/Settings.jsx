// Redirects /settings to /settings/notifications, so a bookmark or typo lands somewhere and nested
// settings routes can be added later without breaking URL contracts.

import React from 'react'
import { Navigate } from 'react-router-dom'

export default function Settings() {
  return <Navigate to="/settings/notifications" replace />
}
