// The body of each Season stats card: the section's chart(s) in order, with small subheads where a
// section draws more than one. registry.js maps section ids to these (kept here so registry.js stays
// plain JS).
import React from 'react'
import RibbonChart from './RibbonChart.jsx'
import WeeklyHeatFruitChart from './WeeklyHeatFruitChart.jsx'
import SourceMixChart from './SourceMixChart.jsx'
import SourceReportCard from './SourceReportCard.jsx'
import HeatClockCropChart from './HeatClockCropChart.jsx'
import CultivarClockChart from './CultivarClockChart.jsx'
import HeatLadderChart from './HeatLadderChart.jsx'
import PepperBestChart from './PepperBestChart.jsx'
import TomatoKeepChart from './TomatoKeepChart.jsx'
import LongestChart from './LongestChart.jsx'
import SepSizeChart from './SepSizeChart.jsx'
import SeedLotCard from '../../../components/stats/SeedLotCard.jsx'
import { v } from '../palette.js'

const subStyle = { margin: '14px 0 6px', fontSize: '0.88rem', fontWeight: 700, color: v('ink-2') }
const Sub = ({ children }) => <h3 style={subStyle}>{children}</h3>

export function RibbonBody({ section }) {
  return (
    <>
      <RibbonChart section={section} />
      <Sub>Heat in, fruit out</Sub>
      <WeeklyHeatFruitChart section={section} />
    </>
  )
}

export function SourcesBody({ section }) {
  return (
    <>
      <SourceMixChart section={section} />
      <Sub>Your sources</Sub>
      <SourceReportCard section={section} />
    </>
  )
}

export function HeatClockBody({ section }) {
  const rows = section?.series?.by_cultivar ?? []
  const med = section?.meta?.median_heat ?? {}
  return (
    <>
      <HeatClockCropChart section={section} />
      <Sub>Each tomato, planting out to first pick</Sub>
      <CultivarClockChart rows={rows.filter((r) => r?.crop_slug === 'tomato')} median={med.tomato} crop="tomato" title="Tomatoes" />
      <Sub>Each pepper, planting out to first pick</Sub>
      <CultivarClockChart rows={rows.filter((r) => r?.crop_slug === 'pepper')} median={med.pepper} crop="pepper" title="Peppers" />
    </>
  )
}

export function HeatLadderBody({ section }) {
  return (
    <>
      <HeatLadderChart section={section} />
      <Sub>Best pepper in each band</Sub>
      <PepperBestChart section={section} />
    </>
  )
}

const seedList = { display: 'grid', gap: 8 }
export function SeedLotsBody({ section }) {
  const rows = section?.series?.rows ?? []
  return (
    <div style={seedList} data-testid="seed-lot-list">
      {rows.map((lot, i) => <SeedLotCard key={lot?.lot_id ?? i} lot={lot} />)}
    </div>
  )
}

export { TomatoKeepChart as TomatoKeepBody, LongestChart as LongestBody, SepSizeChart as SepSizeBody }
