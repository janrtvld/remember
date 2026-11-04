export function selectListRange(ids: readonly string[], anchor: string | null, target: string) {
  const targetIndex = ids.indexOf(target)
  if (targetIndex < 0) return []
  const anchorIndex = anchor ? ids.indexOf(anchor) : -1
  if (anchorIndex < 0) return [target]
  return ids.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
}

export function contextListSelection(selected: readonly string[], target: string) {
  return selected.includes(target) ? [...selected] : [target]
}

export function toggleAllListSelection(ids: readonly string[], selected: readonly string[]) {
  const selectedSet = new Set(selected)
  return ids.every((id) => selectedSet.has(id)) ? [] : [...ids]
}

export const LIST_SHORTCUT_EXCLUSION =
  'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"]'
