// TodayV2Stub — the EMPTY V2 the gate's self-test mounts (todaymeasure.jsx ?v2=1&v2stub=1). V5-TODAYREDESIGN-001 S0.
//
// It carries the version anchor and nothing else, so it passes the instrument half of gate:today-shape:v2
// (the V2 route mounted, the prefs GET observed) and must FAIL every census check: no sections, no glance,
// no bar, no rows. `npm run gate:today-shape:v2:self-test` arms every check of the contract against it and
// passes only when each state reds on the census and on nothing that says the harness itself broke — the
// proof, before any V2 exists, that the contract can go red.
export default function TodayV2Stub() {
  return <div data-today-version="2" />
}
