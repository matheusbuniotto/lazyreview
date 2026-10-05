// The Overview tab: the brief a lead reads before the code. What the author says,
// what the AI makes of it, where to look first, red flags, and where the weight is.

import { LEVEL, RISK, SEVERITY, count, fitStart, meter, seconds, spinner, where } from './common.js'
import { emptyState } from './files.js'

const DESCRIPTION_CHARS = 700
const DESCRIPTION_LINES = 12
const HEAVIEST = 6

export function overviewTab(el, model, act) {
  const { Box, Text } = el
  if (model.error) return Text({ color: 'red', wrap: 'wrap', children: model.error })
  if (model.isLoading && !model.files.length) return Text({ dimColor: true, children: model.loadingLabel })
  if (!model.files.length) return emptyState(el, model)

  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      ...(model.pr ? [description(el, model.pr)] : []),
      aiRead(el, model, act),
      ...startHere(el, model, act),
      redFlags(el, model, act),
      weight(el, model, act),
      nextSteps(el, model, act),
    ],
  })
}

function block(el, key, title, children, color = undefined) {
  const { Box, Text } = el
  return Box({ key, flexDirection: 'column', children: [Text({ bold: true, color, children: title }), ...children] })
}

function description(el, pr) {
  const { Box, Text, Markdown } = el
  const body = pr.body.split('\n').slice(0, DESCRIPTION_LINES).join('\n').slice(0, DESCRIPTION_CHARS)
  const text = body.length < pr.body.length ? `${body.trimEnd()}…` : body
  return block(el, 'description', 'What the author says', [
    Box({
      borderStyle: 'round',
      borderColor: 'gray',
      paddingX: 1,
      children: [text ? Markdown({ key: 'description-md', text }) : Text({ dimColor: true, italic: true, children: 'No description.' })],
    }),
  ])
}

function aiRead(el, model, act) {
  const { Box, Text, Button } = el
  const { review, now } = model
  const rows = []
  if (review.status === 'busy') {
    const parts = review.parts > 1 ? ` in ${review.parts} parts · ${review.partsDone}/${review.parts} done` : ''
    rows.push(Text({ color: 'magenta', children: `${spinner(now)} Reading ${review.fileCount} files${parts}… ${seconds(review.startedAt, now)}` }))
  } else if (review.status === 'error') {
    rows.push(Text({ color: 'red', wrap: 'wrap', children: `AI review failed: ${review.error}` }))
  } else if (review.status === 'done') {
    const risk = RISK[review.risk]
    const advice = { approve: 'approve', comment: 'comment', request_changes: 'request changes' }[review.verdict]
    rows.push(
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          ...(risk ? [Text({ color: risk.color, bold: true, children: `risk ${risk.word}` })] : []),
          ...(advice ? [Text({ dimColor: true, children: `AI would ${advice}` })] : []),
          ...(review.isStale ? [Text({ color: 'yellow', italic: true, children: 'the diff changed since · a to re-run' })] : []),
        ],
      }),
    )
    if (review.summary) rows.push(Text({ wrap: 'wrap', children: review.summary }))
    rows.push(...review.notes.map((note, i) => Text({ key: 'coverage-' + i, color: 'yellow', wrap: 'wrap', children: `⚠ ${note}` })))
  } else {
    rows.push(Text({ dimColor: true, wrap: 'wrap', children: 'A risk level, a two-line summary, where to look first, and comments on the lines they are about.' }))
    rows.push(Box({ marginTop: 1, children: [Button({ key: 'overview-ai', label: 'Run the AI review', variant: 'primary', onPress: act.runReview })] }))
  }
  return Box({ key: 'ai-read', flexDirection: 'column', borderStyle: 'round', borderColor: 'magenta', paddingX: 1, children: [Text({ bold: true, color: 'magenta', children: 'AI read' }), ...rows] })
}

function startHere(el, model, act) {
  const { Box, Text, Button } = el
  const focus = model.review.status === 'done' ? model.review.focus : []
  if (!focus.length) return []
  return [
    block(
      el,
      'start-here',
      'Start here',
      focus.map((f, i) =>
        Box({
          key: 'focus-row-' + i,
          flexDirection: 'column',
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                Box({ flexShrink: 0, children: [Text({ color: 'magenta', bold: true, children: `${i + 1}.` })] }),
                Button({ key: 'focus-' + i, label: where(f.file, f.line), plain: true, onPress: () => act.jumpTo(f.file, f.line) }),
              ],
            }),
            Box({ paddingLeft: 3, children: [Text({ dimColor: true, wrap: 'wrap', children: f.why })] }),
          ],
        }),
      ),
    ),
  ]
}

function redFlags(el, model, act) {
  const { Box, Text, Button } = el
  const quick = model.checks.findings.filter((c) => !model.dismissed.has(c.id))
  const flagged = quick.filter((c) => c.severity !== 'nit')
  const nits = quick.length - flagged.length
  const rows = [
    ...model.checks.notes.map((note, i) => {
      const level = LEVEL[note.level]
      return Box({
        key: 'note-row-' + i,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ color: level.color, children: level.glyph }),
          note.file
            ? Button({ key: 'flag-note-' + i, label: note.text, plain: true, onPress: () => act.jumpTo(note.file, 0) })
            : Text({ wrap: 'wrap', children: note.text }),
        ],
      })
    }),
    ...flagged.map((c, i) => {
      const s = SEVERITY[c.severity]
      return Box({
        key: 'flag-row-' + i,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ color: s.color, children: s.glyph }),
          Text({ children: c.title }),
          Button({ key: 'flag-' + i, label: where(c.file, c.line), plain: true, dimColor: true, onPress: () => act.jumpTo(c.file, c.line, c.id) }),
        ],
      })
    }),
    ...(nits ? [Text({ key: 'nits', dimColor: true, children: `○ ${nits} nit${nits === 1 ? '' : 's'} (TODOs, debug output) in the Files tab` })] : []),
  ]
  if (!rows.length) return block(el, 'red-flags', 'Quick checks', [Text({ color: 'green', children: '✓ No red flags: tests changed, no secrets, nothing silenced' })])
  return block(el, 'red-flags', 'Quick checks', rows)
}

// The heaviest files, so a lead sees where the change really is.
function weight(el, model, act) {
  const { Box, Text, Button } = el
  const files = model.files
    .map((file, i) => ({ file, i }))
    .filter(({ file }) => !file.isGenerated)
    .sort((a, b) => b.file.added + b.file.removed - (a.file.added + a.file.removed))
  const heaviest = files.slice(0, HEAVIEST)
  const max = Math.max(1, ...heaviest.map(({ file }) => file.added + file.removed))
  const labelWidth = Math.max(16, Math.min(40, model.columns - 40))
  const rows = heaviest.map(({ file, i }) =>
    Box({
      key: 'weight-' + i,
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ color: model.viewed.has(file.path) ? 'green' : 'gray', children: model.viewed.has(file.path) ? '✓' : '·' }),
        Box({ width: labelWidth, flexShrink: 0, children: [Button({ key: 'weight-file-' + i, label: fitStart(file.path, labelWidth), plain: true, onPress: () => act.open(i) })] }),
        meter(el, [{ n: file.added, color: 'green' }, { n: file.removed, color: 'red' }], max, 16),
        Text({ dimColor: true, children: `+${count(file.added)} −${count(file.removed)}` }),
      ],
    }),
  )
  if (files.length > HEAVIEST) rows.push(Text({ key: 'weight-more', dimColor: true, children: `  and ${files.length - HEAVIEST} smaller files` }))
  return block(el, 'weight', 'Where the change is', rows)
}

function nextSteps(el, model, act) {
  const { Box, Button } = el
  const isDone = model.viewedCount === model.files.length
  return Box({
    key: 'next-steps',
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Button({ key: 'walk-files', label: isDone ? 'Files ▶' : model.viewedCount ? 'Continue with the files ▶' : 'Walk the files ▶', variant: isDone ? 'secondary' : 'primary', onPress: act.walkFiles }),
      Button({ key: 'write-verdict', label: 'Write the verdict', variant: isDone ? 'primary' : 'secondary', onPress: () => act.showTab('verdict') }),
    ],
  })
}
