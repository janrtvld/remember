const REMEMBER_METADATA_LINE = /^<!--[ \t]*remember-(?:managed:(?:start|end)|source:[^>\n]*)[ \t]*-->$/
const ESCAPED_REMEMBER_METADATA_LINE = /^&lt;!--[ \t]*remember-(?:managed:(?:start|end)|source:[^\n]*?)[ \t]*--&gt;$/

export function normalizeWikiEditorMarkdown(content: string) {
  const lines = content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => {
      const value = line.trim()
      return !REMEMBER_METADATA_LINE.test(value) && !ESCAPED_REMEMBER_METADATA_LINE.test(value)
    })
  while (lines[0]?.trim() === '') lines.shift()
  while (lines.at(-1)?.trim() === '') lines.pop()
  return lines.join('\n')
}
