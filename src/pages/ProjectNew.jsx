import React from 'react'
import ProjectOptions from '../components/ProjectOptions.jsx'
import { useState, useEffect, useId } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useApiFetch } from '../lib/api.js'
import { P, projectKindOptions } from '../lib/constants.js'
import { todayLocalISO } from '../lib/dateLocal.js'
import { VARIETY_REF_UI_SHIPPED, PROJECTS_HIDDEN } from '../lib/featureFlags.js'
import { useUxFlow, FLOWS } from '../lib/uxEvents.js'
import { readDraft, writeDraft, clearDraft } from '../lib/draftStash.js'
import { useReportOverlayDirty } from '../context/OverlayContext.jsx'
import { setReloadBlocked } from '../lib/reloadGate.js'
import { Field, Input, Select, Textarea, Button, ErrorBanner, StatusSelect, SelectChip } from '../components/forms'

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
function generateSlug(name, startDate) {
  const year = startDate ? new Date(startDate + 'T00:00:00').getFullYear() : new Date().getFullYear()
  const base = slugify(name)
  return base.endsWith(`-${year}`) ? base : `${base}-${year}`
}

// V4-PROJHIDE-001 gap: under the flag, /projects redirects to /garden (App.jsx), so a Cancel
// labelled for one destination silently teleported the user to another. No in-app link reaches
// /projects/new when the flag is on, so this is the deep-link / bookmark path only — but a Cancel
// that lands somewhere the user did not choose is a rough edge whether or not it is frequent.
// Named once, consumed twice, so the breadcrumb and the Cancel target cannot drift apart.
const BACK_TO = PROJECTS_HIDDEN ? '/garden' : '/projects'
const BACK_LABEL = PROJECTS_HIDDEN ? 'Garden' : 'Projects'

// V4-DIRTYGUARDSWEEP-001 — draft-stash route key (siblings: 'logone', 'logmany').
const DRAFT_KEY = 'projectnew'

export default function ProjectNew() {
  const { fetch } = useApiFetch()
  const navigate  = useNavigate()
  const today = todayLocalISO()
  // M1 telemetry (Inc 0) — create_project flow. Fire-and-forget; never affects UX.
  // Taps counted: start-capture (first name entry) + submit. complete() fires on success.
  const ux = useUxFlow(FLOWS.CREATE_PROJECT)
  useEffect(() => { ux.reset() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const [projectTypes, setProjectTypes] = useState([])
  const [locations, setLocations]       = useState([])
  const [allProjects, setAllProjects]   = useState([])
  const [selectedType, setSelectedType] = useState(null)
  const [form, setForm] = useState({
    name: '', slug: '', variety: '', species: '', description: '',
    status: 'planning', start_date: today, is_public: true, location_id: '',
    project_type_id: '', parent_project_id: '',
    // V1.2a-4 S1 (PROJ-RESCOPE / V102 §5.1): kind is optional in S1
    // (NOT NULL added §5.4 post-backfill). Empty string → null on POST.
    kind: '', target_end_date: '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  // V4-DIRTYGUARDSWEEP-001 — restore an interrupted draft. One-shot on mount and deliberately
  // independent of the fetches below: nothing restored here needs the loaded lists, and the pickers
  // re-render against the restored ids the moment those lists arrive. Merged over the seeds rather
  // than replacing them, so a draft written before a field existed cannot leave it undefined.
  useEffect(() => {
    const draft = readDraft(DRAFT_KEY)
    if (draft?.form) setForm(f => ({ ...f, ...draft.form }))
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // STASH predicate — BROAD on purpose: every field the user can move off its seed, picks included.
  // Over-capturing is free here in a way it is NOT on EventNew: this form has no sticky/remembered
  // seeds, and handleSubmit clears the draft on success, so there is no post-save rewrite that could
  // store a stale draft (EventNew.jsx:849-855, the regression that narrowed ITS stash trigger).
  // start_date and status are compared against their seeds rather than tested for truthiness —
  // both are non-empty on a pristine mount.
  const hasDraftContent = !!(
    form.name || form.slug || form.variety || form.species || form.description ||
    form.kind || form.target_end_date || form.parent_project_id || form.location_id ||
    form.project_type_id
  ) || form.start_date !== today || form.status !== 'planning'

  useEffect(() => {
    if (hasDraftContent) writeDraft(DRAFT_KEY, { form })
  }, [hasDraftContent, form])

  // GUARD predicate — a SEPARATE, NARROWER question than the stash above, because the two failures
  // cost different things. A missed stash costs a re-type; a false-positive guard holds a
  // service-worker update and deadens the sheet backdrop for a user who merely opened the page.
  // So this counts free text ONLY: the seeded fields are excluded (they are true on a pristine
  // mount), and the pickers are excluded because they are both restored by the stash above and one
  // tap to redo. Reusing hasDraftContent here would pin the gate the instant a project-type chip is
  // tapped, which is exactly the over-broad-guard failure this row exists to avoid.
  const hasUnsavedInput = !!(
    form.name.trim() || form.slug.trim() || form.variety.trim() ||
    form.species.trim() || form.description.trim()
  )

  useReportOverlayDirty(hasUnsavedInput)

  // /projects/new is not an overlayable route today, so the hook above is a strict no-op and the
  // reload gate below is what actually protects this page. Both legs are wired anyway: the gap this
  // row closes is "the wiring was never done", and a page that is half-wired reopens it silently the
  // next time a route is made overlayable.
  // Per-instance key and a BOOLEAN dep, both for the reasons EventNew.jsx:933-941 records — a shared
  // literal key lets one unmount release another instance's hold, and a non-boolean dep would let
  // the cleanup release mid-typing (a release NOTIFIES, and registerSW reloads on that).
  const reloadGateKey = `project-new:${useId()}`
  useEffect(() => {
    setReloadBlocked(reloadGateKey, hasUnsavedInput)
    return () => setReloadBlocked(reloadGateKey, false)
  }, [reloadGateKey, hasUnsavedInput])

  useEffect(() => {
    // Fetch types independently — route may not exist on all Lambda versions
    fetch('/api/projects/types').then(t => setProjectTypes(t ?? [])).catch(() => {})
    Promise.all([
      fetch('/api/locations/with-path'),
      fetch('/api/projects'),
    ]).then(([locs, projects]) => {
      setLocations((locs ?? []).filter(l => l.is_active))
      setAllProjects((projects ?? []).filter(p => p.name && !p.archived_at))
    }).catch(() => {})
  }, [fetch])

  function handleTypeSelect(t) {
    setSelectedType(t)
    const df = t.default_fields ?? {}
    setForm(f => ({
      ...f,
      project_type_id: t.id,
      variety: df.variety !== undefined ? (df.variety || f.variety) : f.variety,
      species: df.species !== undefined ? (df.species || f.species) : f.species,
    }))
  }

  function handleNameChange(name) {
    if (!form.name && name) { ux.tap(); ux.step(1, 'start_capture') }  // first real keystroke = capture started
    setForm(f => ({ ...f, name, slug: generateSlug(name, f.start_date) }))
  }
  function handleDateChange(start_date) {
    setForm(f => ({ ...f, start_date, slug: generateSlug(f.name, start_date) }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    ux.tap()  // submit tap
    try {
      const data = await fetch('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name:             form.name.trim(),
          slug:             form.slug.trim(),
          variety:          form.variety.trim()     || null,
          species:          form.species.trim()     || null,
          description:      form.description.trim() || null,
          status:           form.status,
          start_date:       form.start_date         || null,
          is_public:        form.is_public,
          location_id:      form.location_id        || null,
          project_type_id:  form.project_type_id    || null,
          parent_project_id: form.parent_project_id || null,
          // V1.2a-4 S1: kind + target_end_date land additive; older clients omit them.
          kind:             form.kind              || null,
          target_end_date:  form.target_end_date   || null,
        }),
      })
      ux.complete({ outcome: 'created' })
      clearDraft(DRAFT_KEY)   // the project exists — the working draft is spent
      navigate(`/projects/${data.id}`)
    } catch (err) {
      const msg = err.message ?? ''
      if (msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('duplicate') || msg.includes('23505'))
        setError(`A project with slug "${form.slug}" already exists. Try a different name or change the year.`)
      else setError(msg)
    } finally {
      setSaving(false)
    }
  }

  const gardenTypes = projectTypes.filter(t => t.category === 'garden')
  const infraTypes  = projectTypes.filter(t => t.category === 'infrastructure')

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 20px' }}>

        <div style={{ fontSize: '0.82rem', color: P.light, marginBottom: 20 }}>
          <Link to={BACK_TO} style={{ color: P.green, textDecoration: 'none' }}>{BACK_LABEL}</Link>
          {' › New project'}
        </div>
        <h1 style={{ margin: '0 0 24px', color: P.green, fontSize: '1.3rem', fontWeight: 700 }}>New project</h1>

        <ErrorBanner>{error}</ErrorBanner>

        {/* ── Type picker ── */}
        {projectTypes.length > 0 && (
          <div style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 20, marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: P.mid }}>Project type</span>
              {selectedType && (
                <button type="button" onClick={() => { setSelectedType(null); setForm(f => ({ ...f, project_type_id: '' })) }}
                  style={{ background: 'none', border: 'none', color: P.light, cursor: 'pointer', fontSize: '0.78rem' }}>
                  Clear
                </button>
              )}
            </div>
            {gardenTypes.length > 0 && (
              <>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: P.light, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Garden</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                  {gardenTypes.map(t => <SelectChip key={t.id} active={selectedType?.id === t.id} onClick={() => handleTypeSelect(t)}><span aria-hidden="true" style={{ marginRight: 4 }}>{t.icon}</span>{t.name}</SelectChip>)}
                </div>
              </>
            )}
            {infraTypes.length > 0 && (
              <>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: P.light, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Infrastructure</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {infraTypes.map(t => <SelectChip key={t.id} active={selectedType?.id === t.id} onClick={() => handleTypeSelect(t)}><span aria-hidden="true" style={{ marginRight: 4 }}>{t.icon}</span>{t.name}</SelectChip>)}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Main form ── */}
        <form onSubmit={handleSubmit} style={{ backgroundColor: P.white, border: `1px solid ${P.border}`, borderRadius: 10, padding: 28 }}>

          {selectedType && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, padding: '8px 12px', backgroundColor: P.greenPale, borderRadius: 8, border: `1px solid ${P.greenLight}` }}>
              <span style={{ fontSize: '1.1rem' }}>{selectedType.icon}</span>
              <span style={{ fontSize: '0.82rem', color: P.green, fontWeight: 600 }}>{selectedType.name}</span>
              {selectedType.description && <span style={{ fontSize: '0.78rem', color: P.mid }}> — {selectedType.description}</span>}
            </div>
          )}

          <Field label="Project name *" style={{ marginBottom: 16 }}>
            <Input required value={form.name} onChange={e => handleNameChange(e.target.value)}
              placeholder={selectedType ? `e.g. ${selectedType.name} 2026` : 'e.g. Peppers 2026'} />
          </Field>

          {/* V1.2a-4 S1 (PROJ-RESCOPE / V102 §5.1 #2): project kind classifier.
              cultivar option is gated behind VARIETY_REF_UI_SHIPPED — flips true when
              VARIETY-REF S4 lands the Cultivar-as-first-class flow. */}
          <Field label="What kind of project is this?" style={{ marginBottom: 16 }}>
            <Select
              value={form.kind}
              onChange={e => setForm(f => ({ ...f, kind: e.target.value }))}
            >
              <option value="">— Not sure yet —</option>
              {projectKindOptions(VARIETY_REF_UI_SHIPPED).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          {!VARIETY_REF_UI_SHIPPED && (
            <small style={{ fontSize: '0.75rem', color: P.light, marginTop: -10, marginBottom: 16, display: 'block' }}>
              Just a planting for now.
            </small>
          )}

          {/* V1.2a-4 S1: target_end_date is optional and only meaningful for campaigns. */}
          <Field label="Target end date (optional)" style={{ marginBottom: 16 }} help="When do you expect this to wrap? Leave blank if open-ended.">
            <Input type="date" value={form.target_end_date}
              onChange={e => setForm(f => ({ ...f, target_end_date: e.target.value }))} />
          </Field>

          {/* ── Parent project picker ── */}
          <Field label="Nest under another project?" style={{ marginBottom: 16 }} help="Optional — leave blank for a top-level project.">
            <Select
              value={form.parent_project_id}
              onChange={e => setForm(f => ({ ...f, parent_project_id: e.target.value }))}
            >
              <option value="">None — top-level project</option>
              <ProjectOptions projects={allProjects} />
            </Select>
          </Field>

          <Field label="Slug  ·  used in public URL: /garden/{slug}" style={{ marginBottom: 16 }}>
            <Input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} placeholder="auto-generated" />
          </Field>
          <small style={{ fontSize: '0.75rem', color: P.light, marginTop: -10, marginBottom: 16, display: 'block' }}>
            URL: garden.futureishere.net/garden/{form.slug || '…'}
          </small>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Variety" style={{ marginBottom: 16 }}>
              <Input value={form.variety} onChange={e => setForm(f => ({ ...f, variety: e.target.value }))} placeholder="e.g. Shishito" />
            </Field>
            <Field label="Species" style={{ marginBottom: 16 }}>
              <Input value={form.species} onChange={e => setForm(f => ({ ...f, species: e.target.value }))} placeholder="e.g. Capsicum annuum" />
            </Field>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Start date" style={{ marginBottom: 16 }}>
              <Input type="date" value={form.start_date} onChange={e => handleDateChange(e.target.value)} />
            </Field>
            <Field label="Status" style={{ marginBottom: 16 }}>
              <StatusSelect kind="project" emptyLabel={null} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} />
            </Field>
          </div>

          <Field label="Location" style={{ marginBottom: 16 }}>
            <Select value={form.location_id} onChange={e => setForm(f => ({ ...f, location_id: e.target.value }))}>
              <option value="">— None —</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.full_path}</option>)}
            </Select>
          </Field>
          {locations.length === 0 && (
            <small style={{ fontSize: '0.75rem', color: P.terra, marginTop: -10, marginBottom: 16, display: 'block' }}>
              No locations yet — <Link to="/locations" style={{ color: P.terra }}>create zones first</Link>.
            </small>
          )}

          <Field label="Description  ·  shown on public page" style={{ marginBottom: 16 }}>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3}
              placeholder="Optional — shown publicly if project is public" />
          </Field>

          {/* V4-PUBHIDE-001: is_public toggle removed; all content defaults public. */}

          <div style={{ display: 'flex', gap: 12, marginTop: 8, paddingTop: 20, borderTop: `1px solid ${P.border}` }}>
            <Button type="submit" variant="primary" loading={saving} loadingLabel="Creating…">
              Create project
            </Button>
            <Link to={BACK_TO} style={{ display: 'inline-flex', alignItems: 'center', color: P.mid, textDecoration: 'none', fontSize: '0.9rem' }}>Cancel</Link>
          </div>
        </form>
      </div>
    </div>
  )
}

