// GardenArrival — the one-time "bloom" reveal played over a critter card the first time a
// newly-earned critter is witnessed (scrolled fully into view or tapped). Mirrors the log-event
// CritterArrival flight language, scaled to the card:
//   • a sun arcs up from the top-left and rests above the top edge (soft glow),
//   • plant-family flowers grow OUT from the L/R edges (each its own bloom — tomato star, pepper
//     star, cucurbit trumpet, allium globe, herb spike, marigold, nasturtium, strawberry, brassica,
//     dianthus, bean), every bloom slow-pulsing,
//   • grass grows up the whole bottom edge and stands until the end,
//   • the critter flies in on a smooth eased arc and settles, staying,
//   • then the garden lingers several seconds and fades slowly.
// ~6s. Ambient/in-context (no modal/sound/haptic). Caller skips this entirely under
// prefers-reduced-motion. `flowers` is best-effort drawn from the user's live plantings; falls back
// to a curated family mix (V?-PLANTSOURCE follow-up to wire plantings precisely).

import React from 'react'

// Family flower symbol ids (one bloom per plant family). DEFAULT_FLOWERS is the fallback mix.
export const FLOWER_IDS = ['ga-tomflo', 'ga-pepflo', 'ga-cucflo', 'ga-alliflo', 'ga-herbflo',
  'ga-marigold', 'ga-nastur', 'ga-strawflo', 'ga-brasflo', 'ga-dianthus', 'ga-beanflo']
const DEFAULT_FLOWERS = ['ga-tomflo', 'ga-cucflo', 'ga-alliflo', 'ga-herbflo',
  'ga-marigold', 'ga-pepflo', 'ga-nastur', 'ga-strawflo']

// Slot layout: 4 left edge + 4 right edge (top→bottom). Positions are % of card height.
const SLOTS = [
  { side: 'left',  topPct: 9,  size: 26, delay: 0.04 },
  { side: 'left',  topPct: 31, size: 28, delay: 0.16 },
  { side: 'left',  topPct: 55, size: 24, delay: 0.10 },
  { side: 'left',  topPct: 74, size: 24, delay: 0.24 },
  { side: 'right', topPct: 7,  size: 26, delay: 0.08 },
  { side: 'right', topPct: 29, size: 26, delay: 0.20 },
  { side: 'right', topPct: 53, size: 24, delay: 0.13 },
  { side: 'right', topPct: 73, size: 24, delay: 0.27 },
]
const BLADE_DELAYS = [0.02, 0.10, 0.05, 0.14, 0.08, 0.17, 0.04, 0.12, 0.07, 0.15]

// The symbol <defs> are emitted with each arrival; duplicate symbol ids across concurrent
// arrivals are harmless (a <use href> resolves to the first match).
function GardenSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <symbol id="ga-sun" viewBox="0 0 52 52"><g stroke="#ffce4a" strokeWidth="2.6" strokeLinecap="round"><path d="M26 5v6M26 41v6M5 26h6M41 26h6M11 11l4 4M37 37l4 4M41 11l-4 4M15 37l-4 4" /></g><circle cx="26" cy="26" r="12" fill="#ffd24d" /><circle cx="26" cy="26" r="12" fill="none" stroke="#f6b51e" strokeWidth="1.4" /></symbol>
      <symbol id="ga-tomflo" viewBox="0 0 30 30"><path d="M15 6 v18 M15 24 q-7 0 -7 -6 M15 24 q7 0 7 -6" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><path d="M15 4 l2.2 5.5 5.8 .3 -4.5 3.7 1.6 5.7 -5.1 -3.1 -5.1 3.1 1.6 -5.7 -4.5 -3.7 5.8 -.3Z" fill="#f4c430" /><circle cx="15" cy="11" r="2.2" fill="#caa019" /></symbol>
      <symbol id="ga-pepflo" viewBox="0 0 30 30"><path d="M15 8 v16" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><g fill="#f7f4ec"><ellipse cx="15" cy="6" rx="2.6" ry="5" /><ellipse cx="15" cy="6" rx="2.6" ry="5" transform="rotate(72 15 10)" /><ellipse cx="15" cy="6" rx="2.6" ry="5" transform="rotate(144 15 10)" /><ellipse cx="15" cy="6" rx="2.6" ry="5" transform="rotate(216 15 10)" /><ellipse cx="15" cy="6" rx="2.6" ry="5" transform="rotate(288 15 10)" /></g><circle cx="15" cy="10" r="2" fill="#cdb24a" /></symbol>
      <symbol id="ga-cucflo" viewBox="0 0 32 32"><path d="M16 16 v12" stroke="#3f7d3a" strokeWidth="2.2" fill="none" strokeLinecap="round" /><g fill="#f6b51e"><path d="M16 16 Q9 13 9 6 Q16 7 16 16Z" /><path d="M16 16 Q23 13 23 6 Q16 7 16 16Z" /><path d="M16 16 Q12 9 6 9 Q9 16 16 16Z" /><path d="M16 16 Q20 9 26 9 Q23 16 16 16Z" /><path d="M16 16 Q16 8 16 4 Q19 9 16 16Z" /></g><circle cx="16" cy="15" r="3" fill="#d98a14" /></symbol>
      <symbol id="ga-alliflo" viewBox="0 0 30 30"><path d="M15 13 v15" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><g fill="#9b6fce"><circle cx="15" cy="9" r="2" /><circle cx="11" cy="11" r="2" /><circle cx="19" cy="11" r="2" /><circle cx="12.5" cy="7" r="2" /><circle cx="17.5" cy="7" r="2" /><circle cx="15" cy="12.5" r="2" /></g><circle cx="15" cy="9.5" r="1.6" fill="#c8a6ec" /></symbol>
      <symbol id="ga-herbflo" viewBox="0 0 30 30"><path d="M15 28 v-16" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><g fill="#8a6fc0"><circle cx="15" cy="6" r="2.4" /><circle cx="12" cy="10" r="2.1" /><circle cx="18" cy="10" r="2.1" /><circle cx="13" cy="14" r="1.9" /><circle cx="17" cy="14" r="1.9" /></g></symbol>
      <symbol id="ga-marigold" viewBox="0 0 30 30"><path d="M15 13 v15" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><circle cx="15" cy="10" r="7.5" fill="#e8821e" /><g fill="#f4a83a"><circle cx="15" cy="4.5" r="2.4" /><circle cx="20.5" cy="6.5" r="2.4" /><circle cx="21" cy="12" r="2.4" /><circle cx="15" cy="15" r="2.4" /><circle cx="9" cy="12" r="2.4" /><circle cx="9.5" cy="6.5" r="2.4" /></g><circle cx="15" cy="10" r="3" fill="#b85e12" /></symbol>
      <symbol id="ga-nastur" viewBox="0 0 30 30"><path d="M15 13 v15" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><g fill="#e8631e"><circle cx="15" cy="5.5" r="3.4" /><circle cx="20.5" cy="8.5" r="3.4" /><circle cx="18.5" cy="13.5" r="3.4" /><circle cx="11.5" cy="13.5" r="3.4" /><circle cx="9.5" cy="8.5" r="3.4" /></g><circle cx="15" cy="10" r="2.6" fill="#f6c542" /></symbol>
      <symbol id="ga-strawflo" viewBox="0 0 30 30"><path d="M15 13 v15" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><g fill="#fbfbf8"><circle cx="15" cy="5.5" r="3.2" /><circle cx="20.5" cy="8.5" r="3.2" /><circle cx="18.5" cy="14" r="3.2" /><circle cx="11.5" cy="14" r="3.2" /><circle cx="9.5" cy="8.5" r="3.2" /></g><circle cx="15" cy="10" r="2.6" fill="#f4c430" /></symbol>
      <symbol id="ga-brasflo" viewBox="0 0 30 30"><path d="M15 13 v15" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><g fill="#f4d83a"><ellipse cx="15" cy="6" rx="2.4" ry="3.6" /><ellipse cx="19" cy="10" rx="3.6" ry="2.4" /><ellipse cx="15" cy="14" rx="2.4" ry="3.6" /><ellipse cx="11" cy="10" rx="3.6" ry="2.4" /></g><circle cx="15" cy="10" r="1.8" fill="#caa019" /></symbol>
      <symbol id="ga-dianthus" viewBox="0 0 30 30"><path d="M15 13 v15" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><path d="M15 4 l1.5 4 4-1 -2.5 3.5 3 2.5 -4 .5 .5 4 -3.5 -2.5 -3.5 2.5 .5 -4 -4 -.5 3 -2.5 -2.5 -3.5 4 1Z" fill="#e87fa6" /><circle cx="15" cy="10" r="2" fill="#c0507e" /></symbol>
      <symbol id="ga-beanflo" viewBox="0 0 30 30"><path d="M15 13 v15" stroke="#3f7d3a" strokeWidth="2" fill="none" strokeLinecap="round" /><g fill="#f3e8c8"><ellipse cx="15" cy="8" rx="5" ry="3.4" /><ellipse cx="12" cy="12" rx="3.2" ry="2.4" fill="#e7d6a8" /><ellipse cx="18" cy="12" rx="3.2" ry="2.4" fill="#e7d6a8" /></g></symbol>
      <symbol id="ga-blade" viewBox="0 0 12 34" preserveAspectRatio="none"><path d="M6 34 C3 22 2 12 5 1 C5 12 6 22 6 34Z" fill="#6aa84f" /><path d="M6 34 C9 22 10 12 7 2 C7 12 6 22 6 34Z" fill="#5a9440" /></symbol>
    </svg>
  )
}

const STYLE = `
.ga-root{position:absolute;inset:0;pointer-events:none;z-index:8;}
.ga-flier{position:absolute;left:50%;top:42%;width:64%;aspect-ratio:1/1;transform:translate(-50%,-50%);z-index:7;opacity:1;filter:drop-shadow(0 0 7px rgba(255,210,90,.85));will-change:transform;animation:ga-fly 6000ms cubic-bezier(.25,.6,.3,1) forwards;}
.ga-sun{position:absolute;left:50%;top:-30px;width:46px;height:46px;margin-left:-23px;z-index:4;opacity:0;will-change:transform;animation:ga-sun 6000ms cubic-bezier(.25,.6,.3,1) forwards;}
.ga-glow{position:absolute;left:50%;top:-40px;width:76px;height:76px;margin-left:-38px;border-radius:50%;background:rgba(255,206,74,.26);z-index:3;opacity:0;animation:ga-glow 6000ms ease forwards;}
.ga-flourish{position:absolute;inset:0;z-index:5;animation:ga-fade 6000ms ease both;}
.ga-veg{position:absolute;opacity:0;animation:ga-grow 820ms cubic-bezier(.3,1.5,.5,1) both;}
.ga-pz{display:block;width:100%;height:100%;transform-origin:center bottom;animation:ga-pz 2400ms ease-in-out 820ms infinite;}
.ga-grass{position:absolute;left:4px;right:4px;bottom:-2px;height:30px;display:flex;align-items:flex-end;justify-content:space-between;z-index:5;opacity:0;animation:ga-grass 6000ms ease forwards;}
.ga-blade{flex:1;height:100%;transform-origin:center bottom;opacity:0;animation:ga-bladegrow 880ms cubic-bezier(.3,1.5,.5,1) both;}
@keyframes ga-fly{0%{opacity:0;transform:translate(calc(-50% - 70px),-26px) scale(.55) rotate(-10deg)}10%{opacity:1}24%{transform:translate(calc(-50% - 42px),-58px) scale(.72) rotate(7deg)}44%{transform:translate(calc(-50% - 14px),-52px) scale(.87) rotate(3deg)}64%{transform:translate(calc(-50% + 2px),-22px) scale(.97) rotate(-2deg)}80%{transform:translate(-50%,-51%) scale(1) rotate(1deg)}100%{opacity:1;transform:translate(-50%,-50%) scale(1) rotate(0)}}
@keyframes ga-sun{0%{opacity:0;transform:translate(-100px,42px) scale(.55)}9%{opacity:1}30%{transform:translate(-56px,10px) scale(.8)}55%{transform:translate(-24px,-4px) scale(.94)}80%{transform:translate(-4px,0) scale(1)}88%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(0,0) scale(1)}}
@keyframes ga-glow{0%,5%{opacity:0}16%{opacity:1}78%{opacity:1}100%{opacity:0}}
@keyframes ga-grow{0%{opacity:0;transform:translateY(8px) scale(.1)}14%{opacity:1}55%{transform:translateY(-2px) scale(1.12)}100%{opacity:1;transform:translateY(0) scale(1)}}
@keyframes ga-bladegrow{0%{opacity:0;transform:scaleY(.05)}16%{opacity:1}60%{transform:scaleY(1.07)}100%{opacity:1;transform:scaleY(1)}}
@keyframes ga-pz{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}
@keyframes ga-fade{0%,75%{opacity:1}100%{opacity:0}}
@keyframes ga-grass{0%{opacity:0}10%{opacity:1}82%{opacity:1}100%{opacity:0}}
`

export default function GardenArrival({ imageUrl, viewScale = 1, flowers }) {
  const picks = (flowers && flowers.length ? flowers : DEFAULT_FLOWERS)
  const placed = SLOTS.map((s, i) => ({ ...s, sym: picks[i % picks.length] }))
  return (
    <div className="ga-root" aria-hidden="true">
      <GardenSprite />
      <style>{STYLE}</style>
      <div className="ga-glow" />
      <svg className="ga-sun"><use href="#ga-sun" /></svg>
      <div className="ga-flourish">
        {placed.map((s, i) => (
          <span key={i} className="ga-veg" style={{
            [s.side]: -14, top: `${s.topPct}%`, width: s.size, height: s.size, animationDelay: `${s.delay}s`,
          }}>
            <svg className="ga-pz"><use href={`#${s.sym}`} /></svg>
          </span>
        ))}
      </div>
      <div className="ga-grass">
        {BLADE_DELAYS.map((d, i) => (
          <svg key={i} className="ga-blade" style={{ animationDelay: `${d}s` }}><use href="#ga-blade" /></svg>
        ))}
      </div>
      <img className="ga-flier" src={imageUrl} alt="" draggable={false}
        style={{ objectFit: 'contain', transform: `translate(-50%,-50%) scale(${viewScale})` }} />
    </div>
  )
}
