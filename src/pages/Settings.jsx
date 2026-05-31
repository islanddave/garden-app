// Settings parent — permissive redirect to /settings/notifications.
// Spec: mvp-critter-pre-build-revision-V001 §3.23 (senior-fullstack-engineer flagged
// forward-compat — when a second settings page lands later, refactor to a real /settings
// parent. For MVP-Critter Session 4, this is a one-line redirect that handles
// bookmark/typo + lets us add nested settings routes without breaking URL contracts).

import React from 'react'
import { Navigate } from 'react-router-dom'

export default function Settings() {
  return <Navigate to="/settings/notifications" replace />
}
