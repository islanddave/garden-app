import { buildDisplayList } from '../lib/projectTree.js'

// FIX-4: shared grouped project <option> list. Single source of truth for every project
// picker (EventNew, LogMany, Plants, ProjectNew parent-select, Tasks, PhotoLibrary).
// Renders a depth-indented flat list: parent categories first, children indented beneath
// them via parent_project_id (buildDisplayList ordering), every project still selectable.
// Caller owns any leading placeholder <option>; this returns only the project options.
export default function ProjectOptions({ projects }) {
  const sorted = [...(projects || [])].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  return buildDisplayList(sorted).map(({ project, depth }) => (
    <option key={project.id} value={project.id}>
      {depth > 0 ? ' '.repeat(depth * 3) + '↳ ' : ''}{project.name}
    </option>
  ))
}
