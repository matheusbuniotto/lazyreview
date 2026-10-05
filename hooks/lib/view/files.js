// The Files tab: the file list, and the reader with findings under the lines they are about.

import { STATUS_WORDS, holdsLine, isMarkdown } from '../diff.js'
import { SEVERITY, STATUS_COLORS, count, fitStart, plural } from './common.js'

const SIDE_BY_SIDE_FROM = 100
const LIST_WIDTH = 44
const LIST_MIN_WIDTH = 22
// Columns a file row spends besides its path: border, padding, markers, badge.
const ROW_CHROME = 14
const LIST_ROWS_WIDE = 18
const LIST_ROWS_NARROW = 7

export function filesTab(el, model, act) {
  const { Box, Text } = el
  if (model.error) return Text({ color: 'red', wrap: 'wrap', children: model.error })
  if (model.isLoading && !model.files.length) return Text({ dimColor: true, children: model.loadingLabel })
  if (!model.files.length) return emptyState(el, model)

  const isWide = model.columns >= SIDE_BY_SIDE_FROM
  return Box({
    flexDirection: isWide ? 'row' : 'column',
    columnGap: 1,
    children: [fileList(el, model, act, isWide), fileReader(el, model, act)],
  })
}

export function emptyState(el, model) {
  const { Box, Text } = el
  const lines = [Text({ color: 'green', children: `✓ Nothing to review in ${model.pr ? `PR #${model.pr.number}` : model.modeLabel}` })]
  if (model.hiddenCount) lines.push(Text({ dimColor: true, children: `${plural(model.hiddenCount, 'markdown file')} hidden · m to show` }))
  if (!model.pr) lines.push(Text({ dimColor: true, children: 'b switches the base: HEAD, staged, unstaged, branch · i picks a pull request' }))
  return Box({ flexDirection: 'column', paddingY: 1, alignItems: 'center', children: lines })
}

// ── File list ──────────────────────────────────────────────────────────────

const INDENT = '  '
const folderOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1)

function worstOf(findings) {
  const name = ['bug', 'risk', 'nit'].find((severity) => findings.some((c) => c.severity === severity))
  return name ? SEVERITY[name] : null
}

function fileList(el, model, act, isWide) {
  const { Box, Text, Button } = el
  const maxRows = isWide ? LIST_ROWS_WIDE : LIST_ROWS_NARROW
  const first = Math.max(0, Math.min(model.selected - Math.floor(maxRows / 2), model.files.length - maxRows))
  const shown = model.files.slice(first, first + maxRows)
  const longest = Math.max(...model.files.flatMap((f) => [nameOf(f.path).length + INDENT.length, folderOf(f.path).length - 4]))
  const listWidth = Math.min(LIST_WIDTH, Math.max(LIST_MIN_WIDTH, longest + ROW_CHROME))
  const labelWidth = (isWide ? listWidth : model.columns) - ROW_CHROME

  // Grouped by folder, lazygit-style: a dim folder line, then the file names in it.
  const rows = shown.flatMap((file, offset) => {
    const i = first + offset
    const folder = folderOf(file.path)
    const isNewFolder = offset === 0 || folderOf(shown[offset - 1].path) !== folder
    const isSelected = i === model.selected
    const isViewed = model.viewed.has(file.path)
    const findings = model.openFindings.filter((c) => c.file === file.path)
    const worst = worstOf(findings)
    const row = Box({
      key: 'row-' + i,
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ color: 'cyan', bold: true, children: isSelected ? '▸' : ' ' }),
        Text({ color: isViewed ? 'green' : 'gray', children: isViewed ? '✓' : '·' }),
        Text({ color: STATUS_COLORS[file.status], bold: true, dimColor: isViewed && !isSelected, children: file.status }),
        Button({
          key: 'file-' + i,
          label: fitStart(folder ? `${INDENT}${nameOf(file.path)}` : nameOf(file.path), labelWidth),
          plain: true,
          dimColor: isViewed && !isSelected,
          onPress: () => act.select(i),
        }),
        ...(worst ? [Text({ color: worst.color, children: `${worst.glyph}${findings.length}` })] : []),
        ...(file.isGenerated ? [Text({ dimColor: true, children: '⚙' })] : []),
      ],
    })
    if (!isNewFolder || !folder) return [row]
    return [Text({ key: 'folder-' + i, dimColor: true, children: `      ${fitStart(folder + '/', labelWidth)}` }), row]
  })
  if (first > 0) rows.unshift(Text({ key: 'up', dimColor: true, children: `  ↑ ${first} more` }))
  const below = model.files.length - first - shown.length
  if (below > 0) rows.push(Text({ key: 'down', dimColor: true, children: `  ↓ ${below} more` }))
  if (model.hiddenCount) rows.push(Text({ key: 'hidden', dimColor: true, italic: true, children: `  ${model.hiddenCount} .md hidden` }))

  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1,
    ...(isWide ? { width: listWidth, flexShrink: 0 } : {}),
    children: [Text({ bold: true, children: `Files ${model.selected + 1}/${model.files.length}` }), ...rows],
  })
}

// ── Reader ─────────────────────────────────────────────────────────────────

function fileReader(el, model, act) {
  const { Box, Text, Button, Input } = el
  const file = model.files[model.selected]
  const notes = model.notes.get(file.path) ?? []
  const card = (finding) => findingCard(el, finding, model.dismissed.has(finding.id), () => act.toggleDismissed(finding.id))
  const pageCount = model.pages.length
  const isViewed = model.viewed.has(file.path)
  const unit = file.isGenerated && !file.hunks.length ? 'generated' : model.reader === 'diff' ? plural(file.hunks.length, 'hunk') : 'whole file'

  return Box({
    flexDirection: 'column',
    flexGrow: 1,
    borderStyle: 'round',
    borderColor: isViewed ? 'green' : 'magenta',
    paddingX: 1,
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        columnGap: 1,
        children: [
          Text({ bold: true, color: 'cyan', wrap: 'truncate-start', children: file.path }),
          Box({
            flexDirection: 'row',
            columnGap: 1,
            flexShrink: 0,
            children: [
              Text({ color: STATUS_COLORS[file.status], children: STATUS_WORDS[file.status] }),
              Text({ color: 'green', children: `+${count(file.added)}` }),
              Text({ color: 'red', children: `−${count(file.removed)}` }),
              Text({ dimColor: true, children: `· ${unit}` }),
              ...(model.staged.has(file.path) ? [Text({ color: 'green', children: '· ● staged' })] : []),
              ...(isViewed ? [Text({ color: 'green', bold: true, children: '· ✓ viewed' })] : []),
            ],
          }),
        ],
      }),
      ...(file.oldPath && file.oldPath !== file.path ? [Text({ dimColor: true, children: `renamed from ${file.oldPath}` })] : []),
      ...(pageCount > 1 ? [pager(el, model, act)] : []),
      ...readerBody(el, model, file, card, act),
      ...notes.map((note, i) => noteCard(el, note, i, () => act.removeNote(file.path, i))),
      Box({
        marginTop: 1,
        children: [
          Input({
            key: 'note',
            label: '✎ Note',
            placeholder: 'your comment on this file; start with L42: for a line',
            value: '',
            submitLabel: 'add',
            onSubmit: (text) => act.addNote(file.path, text),
          }),
        ],
      }),
      Box({
        flexDirection: 'row',
        columnGap: 2,
        marginTop: 1,
        children: [
          ...(model.page < pageCount - 1 ? [Button({ key: 'page-next-bottom', label: `next page ▶ ${linesOf(model.pages[model.page + 1])}`, variant: 'secondary', onPress: () => act.page(1) })] : []),
          isViewed
            ? Button({ key: 'viewed-next', label: 'next file ▶', variant: 'secondary', onPress: () => act.move(1) })
            : Button({ key: 'viewed-next', label: '✓ viewed, next file', variant: 'primary', onPress: act.toggleViewed }),
        ],
      }),
    ],
  })
}

const linesOf = (pieces) => `lines ${count(pieces[0].firstLine)}–${count(Math.max(...pieces.map((p) => p.lastLine)))}`

function pager(el, model, act) {
  const { Box, Text, Button } = el
  const isFirst = model.page === 0
  const isLast = model.page === model.pages.length - 1
  return Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Text({ color: 'yellow', children: `page ${model.page + 1}/${model.pages.length}` }),
      Text({ dimColor: true, children: linesOf(model.pages[model.page]) }),
      Button({ key: 'page-prev', label: '◀ prev page', hotkey: 'h', plain: true, dimColor: isFirst, onPress: () => act.page(-1) }),
      Button({ key: 'page-next', label: 'next page ▶', hotkey: 'l', plain: true, dimColor: isLast, onPress: () => act.page(1) }),
    ],
  })
}

function readerBody(el, model, file, card, act) {
  const { Text } = el
  if (file.isGenerated && !file.hunks.length) return generatedGate(el, file, act)
  if (model.reader === 'file') {
    if (!model.fileText || model.fileText.path !== file.path) return [Text({ dimColor: true, children: 'Reading the file…' })]
    if (model.fileText.error) return [Text({ color: 'red', children: model.fileText.error })]
  } else {
    if (file.isBinary) return [Text({ dimColor: true, children: 'Binary file: no text diff' })]
    if (!file.hunks.length) return [Text({ dimColor: true, children: 'No content changes (mode or rename only)' })]
  }
  return pieceBlocks(el, model, file, card)
}

function generatedGate(el, file, act) {
  const { Box, Text, Button } = el
  return [
    Box({
      flexDirection: 'column',
      marginTop: 1,
      borderStyle: 'round',
      borderColor: 'gray',
      paddingX: 1,
      children: [
        Text({ bold: true, children: '⚙ Generated file' }),
        Text({ dimColor: true, wrap: 'wrap', children: `+${count(file.added)} −${count(file.removed)} lines. Lock files and build output are not drawn or sent to the AI review by default.` }),
        Box({ marginTop: 1, children: [Button({ key: 'show-generated', label: 'Show the diff anyway', onPress: () => act.revealGenerated(file.path) })] }),
      ],
    }),
  ]
}

// The current page's pieces, each followed by the findings and notes on its lines.
// A finding on no drawn line (a removed line, the whole file) opens the first page.
function pieceBlocks(el, model, file, card) {
  const { Box, Text, Code, Markdown } = el
  const findings = model.findings.filter((c) => c.file === file.path)
  const allPieces = model.pages.flat()
  const home = new Map(findings.map((c) => [c.id, allPieces.find((piece) => holdsLine(piece, c.line))]))
  const general = model.page === 0 ? findings.filter((c) => !home.get(c.id)) : []
  const isDiff = model.reader === 'diff'
  const asMarkdown = !isDiff && isMarkdown(file.path)

  const blocks = model.pages[model.page].map((piece, i) => {
    const here = findings.filter((c) => home.get(c.id) === piece)
    const drawn = isDiff
      ? Code({ source: piece.source, format: 'diff', path: file.path })
      : asMarkdown
        ? Markdown({ key: 'md-' + i, text: piece.source })
        : Code({ source: piece.source, path: file.path, startLine: piece.firstLine })
    const showContext = isDiff && piece.isHunkStart && piece.context
    return Box({
      key: isDiff && piece.isHunkStart ? 'hunk-' + piece.hunkIndex : 'piece-' + i,
      flexDirection: 'column',
      marginTop: isDiff && !piece.isHunkStart ? 0 : 1,
      children: [
        ...(showContext ? [Text({ dimColor: true, wrap: 'truncate-end', children: `  ⋯ ${piece.context}` })] : []),
        drawn,
        ...here.map(card),
      ],
    })
  })
  return [...general.map(card), ...blocks]
}

function findingCard(el, finding, isDismissed, onToggle) {
  const { Box, Text, Button } = el
  const s = SEVERITY[finding.severity]
  const at = finding.line ? `L${finding.line}` : 'file'
  const source = finding.by === 'check' ? 'quick check' : 'AI'
  const toggle = Button({
    key: 'dismiss-' + finding.id,
    label: isDismissed ? 'restore' : '✕ dismiss',
    plain: true,
    dimColor: true,
    onPress: onToggle,
  })

  if (isDismissed) {
    return Box({
      key: 'comment-' + finding.id,
      flexDirection: 'row',
      columnGap: 1,
      marginLeft: 2,
      children: [Text({ dimColor: true, children: '✕' }), Text({ dimColor: true, strikethrough: true, wrap: 'truncate-end', children: `${at} ${finding.title}` }), toggle],
    })
  }
  return Box({
    key: 'comment-' + finding.id,
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: s.color,
    paddingX: 1,
    marginLeft: 2,
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        columnGap: 2,
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [Text({ color: s.color, bold: true, children: `${s.glyph} ${finding.severity} · ${at}` }), Text({ dimColor: true, children: `· ${source}` })],
          }),
          ...(finding.severity === 'praise' ? [] : [toggle]),
        ],
      }),
      Text({ bold: true, wrap: 'wrap', children: finding.title }),
      Text({ wrap: 'wrap', children: finding.body }),
    ],
  })
}

function noteCard(el, note, i, onRemove) {
  const { Box, Text, Button } = el
  return Box({
    key: 'note-' + i,
    flexDirection: 'row',
    columnGap: 1,
    marginTop: 1,
    children: [
      Text({ color: 'blue', bold: true, children: note.line ? `✎ you · L${note.line}` : '✎ you' }),
      Text({ wrap: 'wrap', children: note.text }),
      Button({ key: 'note-remove-' + i, label: '✕', plain: true, dimColor: true, onPress: onRemove }),
    ],
  })
}
