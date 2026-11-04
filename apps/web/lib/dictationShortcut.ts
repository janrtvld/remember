const ACCELERATOR_SYMBOLS: Record<string, string> = {
  CommandOrControl: '⌘',
  Command: '⌘',
  Cmd: '⌘',
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Return: '⏎',
  Enter: '⏎',
  Escape: 'esc',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
}

/** Render an accelerator like "Command+Shift+Space" as "⌘ ⇧ Space". */
export function formatAccelerator(accelerator: string | null): string {
  if (!accelerator) return ''
  return accelerator
    .split('+')
    .map((part) => ACCELERATOR_SYMBOLS[part] ?? part)
    .join(' ')
}

const CODE_TO_KEY: Record<string, string> = {
  Space: 'Space',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
])

function mainKey(code: string): string | null {
  if (code.startsWith('Key')) return code.slice(3) // KeyA -> A
  if (code.startsWith('Digit')) return code.slice(5) // Digit1 -> 1
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code // F1..F24
  return CODE_TO_KEY[code] ?? null
}

/**
 * Convert a keydown to an Electron accelerator (e.g. "Command+Shift+Space"), or
 * null while only modifiers are held / no modifier is present (a global shortcut
 * needs at least one non-shift modifier to avoid hijacking plain typing).
 */
export function eventToAccelerator(event: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(event.code)) return null
  const key = mainKey(event.code)
  if (!key) return null
  const hasPrimaryModifier = event.metaKey || event.ctrlKey || event.altKey
  if (!hasPrimaryModifier) return null

  const parts: string[] = []
  if (event.metaKey) parts.push('Command')
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}
