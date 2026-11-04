import { diff3Merge } from 'node-diff3'

export type WikiDocumentSnapshot = {
  title: string
  content: string
}

export type WikiMergeConflict = {
  field: 'title' | 'content'
  base: string
  local: string
  remote: string
}

export type WikiMergeResult = {
  document: WikiDocumentSnapshot
  conflicts: WikiMergeConflict[]
}

function normalizeText(value: string) {
  return value.replace(/\r\n?/g, '\n').trim()
}

function lines(value: string) {
  const normalized = normalizeText(value)
  return normalized ? normalized.split('\n') : []
}

function mergeTitle(base: string, local: string, remote: string) {
  if (local === remote || remote === base) return { value: local, conflict: null }
  if (local === base) return { value: remote, conflict: null }
  return {
    value: local,
    conflict: { field: 'title', base, local, remote } satisfies WikiMergeConflict,
  }
}

function mergeContent(base: string, local: string, remote: string) {
  const normalizedBase = normalizeText(base)
  const normalizedLocal = normalizeText(local)
  const normalizedRemote = normalizeText(remote)
  if (normalizedLocal === normalizedRemote || normalizedRemote === normalizedBase) {
    return { value: normalizedLocal, conflicts: [] as WikiMergeConflict[] }
  }
  if (normalizedLocal === normalizedBase) {
    return { value: normalizedRemote, conflicts: [] as WikiMergeConflict[] }
  }

  const conflicts: WikiMergeConflict[] = []
  const merged: string[] = []
  for (const region of diff3Merge(lines(normalizedLocal), lines(normalizedBase), lines(normalizedRemote), {
    excludeFalseConflicts: true,
  })) {
    if (region.ok) {
      merged.push(...region.ok)
      continue
    }
    if (!region.conflict) continue
    const conflict = {
      field: 'content',
      base: region.conflict.o.join('\n'),
      local: region.conflict.a.join('\n'),
      remote: region.conflict.b.join('\n'),
    } satisfies WikiMergeConflict
    conflicts.push(conflict)
    merged.push(...region.conflict.a)
  }
  return { value: normalizeText(merged.join('\n')), conflicts }
}

export function mergeWikiDocuments(
  base: WikiDocumentSnapshot,
  local: WikiDocumentSnapshot,
  remote: WikiDocumentSnapshot
): WikiMergeResult {
  const title = mergeTitle(base.title, local.title, remote.title)
  const content = mergeContent(base.content, local.content, remote.content)
  return {
    document: { title: title.value, content: content.value },
    conflicts: [...(title.conflict ? [title.conflict] : []), ...content.conflicts],
  }
}
