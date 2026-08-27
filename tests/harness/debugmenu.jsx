// OPS-DEBUGMENU-001 — real-browser look at the diagnostic index at Dave's geometry.
// jsdom has no layout engine, so the unit tests can prove the rows EXIST and carry a 44px
// minHeight but cannot show whether six cards plus a status panel are actually usable on a
// 375px phone, which is the only device this page is for.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import DebugMenu from '../../src/pages/DebugMenu.jsx'
createRoot(document.getElementById('root')).render(
  <MemoryRouter><DebugMenu /></MemoryRouter>
)
