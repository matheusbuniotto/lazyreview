// Colors, glyphs and small drawing helpers shared by every part of the pane.

export const STATUS_COLORS = { M: 'yellow', A: 'green', D: 'red', R: 'cyan' }

export const SEVERITY = {
  bug: { glyph: '●', color: 'red' },
  risk: { glyph: '▲', color: 'yellow' },
  nit: { glyph: '○', color: 'cyan' },
  praise: { glyph: '✓', color: 'green' },
}

export const VERDICT = {
  done: { glyph: '✓', color: 'green', word: 'done' },
  partial: { glyph: '◐', color: 'yellow', word: 'partial' },
  missing: { glyph: '✗', color: 'red', word: 'missing' },
  unclear: { glyph: '?', color: 'gray', word: 'unclear' },
}

export const RISK = {
  low: { color: 'green', word: 'LOW' },
  medium: { color: 'yellow', word: 'MEDIUM' },
  high: { color: 'red', word: 'HIGH' },
}

export const LEVEL = {
  bad: { glyph: '✗', color: 'red' },
  warn: { glyph: '⚠', color: 'yellow' },
  info: { glyph: 'ℹ', color: 'blue' },
}

const SPINNER = ['◐', '◓', '◑', '◒']

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
export const count = (n) => n.toLocaleString('en-US')
export const seconds = (since, now) => `${Math.max(0, Math.round((now - since) / 1000))}s`
export const spinner = (now) => SPINNER[Math.floor(now / 500) % SPINNER.length]
export const where = (file, line) => (line ? `${file}:${line}` : file)

export function fitStart(text, width) {
  if (text.length <= width) return text
  return '…' + text.slice(text.length - width + 1)
}

export function fitEnd(text, width) {
  if (text.length <= width) return text
  return text.slice(0, Math.max(0, width - 1)) + '…'
}

// A row of colored blocks: [{ n, color }] out of `total`, `width` cells wide.
export function meter(el, parts, total, width) {
  const { Box, Text } = el
  let used = 0
  const cells = parts.flatMap((part, i) => {
    const n = total && part.n ? Math.min(width - used, Math.max(1, Math.round((part.n / total) * width))) : 0
    used += n
    return n ? [Text({ key: 'meter-' + i, color: part.color, children: '█'.repeat(n) })] : []
  })
  const rest = width - used ? [Text({ key: 'meter-rest', dimColor: true, children: '░'.repeat(width - used) })] : []
  return Box({ flexDirection: 'row', flexShrink: 0, children: [...cells, ...rest] })
}

export function severityCounts(el, findings) {
  const { Text } = el
  return Object.entries(SEVERITY)
    .filter(([name]) => name !== 'praise')
    .map(([name, s]) => ({ name, ...s, n: findings.filter((c) => c.severity === name).length }))
    .filter((s) => s.n)
    .map((s) => Text({ key: 'count-' + s.name, color: s.color, children: `${s.glyph} ${s.n} ${s.name}` }))
}

export const section = (el, title, color = undefined) => el.Text({ bold: true, color, children: title })
