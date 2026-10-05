// Pure helpers over `git diff` output. No mods API in here.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const MARKDOWN = /\.(md|mdx|markdown)$/i

const HEADER_ROOM = 40
const MAX_LINE = 2000

export const isMarkdown = (path) => MARKDOWN.test(path)

export const clean = (text) => String(text ?? '').replace(CONTROL_CHARS, '')

// Turns a unified patch (one or many files) into
// [{ path, oldPath, status, added, removed, isBinary, hunks: [{ oldStart, newStart, newLines, context, lines }] }]
export function parsePatch(patch) {
  const files = []
  let file = null
  let hunk = null
  let oldLeft = 0
  let newLeft = 0

  for (const line of patch.split('\n')) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const op = line[0] ?? ' '
      if (op === '\\') { hunk.lines.push(line); continue }
      const text = line === '' ? ' ' : line
      if (op === '+') { newLeft--; file.added++ }
      else if (op === '-') { oldLeft--; file.removed++ }
      else { oldLeft--; newLeft-- }
      hunk.lines.push(text)
      continue
    }

    if (line.startsWith('diff --git ')) {
      const [, oldPath = '', path = ''] = line.match(/^diff --git a\/(.*) b\/(.*)$/) ?? []
      file = { path, oldPath, status: 'M', added: 0, removed: 0, isBinary: false, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue

    const header = line.match(HUNK_HEADER)
    if (header) {
      const [, oldStart, oldLines = '1', newStart, newLines = '1', context] = header
      hunk = { oldStart: +oldStart, newStart: +newStart, newLines: +newLines, context: context.trim(), lines: [] }
      oldLeft = +oldLines
      newLeft = +newLines
      file.hunks.push(hunk)
    } else if (line.startsWith('\\') && hunk) {
      hunk.lines.push(line)
    } else if (line.startsWith('new file mode') || line === '--- /dev/null') {
      file.status = 'A'
    } else if (line.startsWith('deleted file mode') || line === '+++ /dev/null') {
      file.status = 'D'
    } else if (line.startsWith('rename from ')) {
      file.status = 'R'
      file.oldPath = line.slice('rename from '.length)
    } else if (line.startsWith('rename to ')) {
      file.path = line.slice('rename to '.length)
    } else if (line.startsWith('+++ b/')) {
      file.path = line.slice('+++ b/'.length)
    } else if (line.startsWith('Binary files ')) {
      file.isBinary = true
    }
  }
  return files
}

// A reader is drawn as pieces (one `Code` element each) grouped into pages,
// because one drawing must stay under 100,000 serialized characters.
export const PIECE_CHARS = 6000
export const PAGE_CHARS = 45000

const opCounts = (lines) => ({
  old: lines.filter((l) => l[0] === ' ' || l[0] === '-').length,
  new: lines.filter((l) => l[0] === ' ' || l[0] === '+').length,
})

// Splits every hunk into pieces a `Code` element with `format: 'diff'` accepts:
// each under the size cap, with a header whose counts match its own lines.
export function diffPieces(file, maxChars = PIECE_CHARS) {
  const pieces = []
  file.hunks.forEach((hunk, hunkIndex) => {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    let lines = []
    let size = HEADER_ROOM
    let pieceOld = oldLine
    let pieceNew = newLine
    const flush = () => {
      if (!lines.length) return
      const counts = opCounts(lines)
      pieces.push({
        source: [`@@ -${pieceOld},${counts.old} +${pieceNew},${counts.new} @@`, ...lines].join('\n'),
        firstLine: pieceNew,
        lastLine: newLine - 1,
        hunkIndex,
        isHunkStart: !pieces.some((p) => p.hunkIndex === hunkIndex),
        context: hunk.context,
        chars: size,
      })
      lines = []
      size = HEADER_ROOM
      pieceOld = oldLine
      pieceNew = newLine
    }
    for (const raw of hunk.lines) {
      const line = clean(raw).slice(0, MAX_LINE)
      if (size + line.length + 1 > maxChars) flush()
      lines.push(line)
      size += line.length + 1
      if (line[0] === '-') oldLine++
      else if (line[0] === '+') newLine++
      else if (line[0] === ' ') {
        oldLine++
        newLine++
      }
    }
    flush()
  })
  return pieces
}

// Splits a whole file into pieces a `Code` element accepts, numbered from their first line.
export function filePieces(text, maxChars = PIECE_CHARS) {
  const pieces = []
  let lines = []
  let size = 0
  let firstLine = 1
  const flush = (lastLine) => {
    if (!lines.length) return
    pieces.push({ source: lines.join('\n'), firstLine, lastLine, chars: size })
    lines = []
    size = 0
    firstLine = lastLine + 1
  }
  const all = clean(String(text).replace(/\t/g, '  ')).split('\n')
  if (all.length > 1 && all.at(-1) === '') all.pop()
  all.forEach((line, i) => {
    const cut = line.slice(0, MAX_LINE)
    if (size + cut.length + 1 > maxChars) flush(i)
    lines.push(cut)
    size += cut.length + 1
  })
  flush(all.length)
  return pieces
}

// Groups pieces into pages that each fit one drawing.
export function paginate(pieces, budget = PAGE_CHARS) {
  const pages = []
  let page = []
  let size = 0
  for (const piece of pieces) {
    if (page.length && size + piece.chars > budget) {
      pages.push(page)
      page = []
      size = 0
    }
    page.push(piece)
    size += piece.chars
  }
  if (page.length) pages.push(page)
  return pages
}

export const pageWhere = (pages, isHere) => pages.findIndex((page) => page.some(isHere))

export const holdsLine = (piece, line) => line >= piece.firstLine && line <= Math.max(piece.lastLine, piece.firstLine)

// Lock files, build output and other machine-written files: listed, but not drawn or reviewed by default.
const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|Podfile\.lock|go\.sum|flake\.lock)$/,
  /(^|\/)(dist|build|out|vendor|node_modules|\.next|coverage|__snapshots__)\//,
  /\.(min\.(js|css)|map|snap|lock)$/,
  /(\.pb\.go|_pb2\.py|\.g\.dart|\.generated\.\w+)$/,
]

export const isGenerated = (path) => GENERATED.some((pattern) => pattern.test(path))

// `git diff --numstat -z` as [{ path, added, removed }]; a rename names old and new paths.
export function parseNumstat(text) {
  const out = []
  const tokens = text.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const [added, removed, path] = tokens[i].split('\t')
    if (removed === undefined) continue
    const entry = { added: Number(added) || 0, removed: Number(removed) || 0, path }
    if (path === '') {
      entry.oldPath = tokens[++i]
      entry.path = tokens[++i]
    }
    out.push(entry)
  }
  return out
}

// A file listed by its counts alone, its diff left unread.
export const generatedFile = ({ path, oldPath, added, removed }, status) => ({
  path,
  oldPath: oldPath ?? path,
  status: oldPath ? 'R' : status,
  added,
  removed,
  isBinary: false,
  isGenerated: true,
  hunks: [],
})

export function totals(files) {
  return files.reduce((sum, f) => ({ added: sum.added + f.added, removed: sum.removed + f.removed }), { added: 0, removed: 0 })
}

export const fileHeader = (file) =>
  `FILE ${file.path} (${STATUS_WORDS[file.status]}${file.isBinary ? ', binary' : ''}${isGenerated(file.path) ? ', generated' : ''})`

// The patch with new-file line numbers in a gutter, so a model can cite lines.
export function numberedLines(file) {
  const out = []
  for (const hunk of file.hunks) {
    out.push(`@@ ${hunk.context}`)
    let line = hunk.newStart
    for (const text of hunk.lines) {
      const op = text[0]
      if (op === '\\') continue
      const gutter = op === '-' ? '' : String(line++)
      out.push(`${gutter.padStart(5)} ${op} ${text.slice(1)}`)
    }
  }
  return out
}

export const numberedPatch = (file) => [fileHeader(file), ...numberedLines(file)].join('\n')

// Every line of the new file the diff shows, added or context: [{ line, text, isAdded }].
export function newSideLines(file) {
  const out = []
  for (const hunk of file.hunks) {
    let line = hunk.newStart
    for (const text of hunk.lines) {
      if (text[0] === '+' || text[0] === ' ') out.push({ line: line++, text: text.slice(1), isAdded: text[0] === '+' })
    }
  }
  return out
}

// A short hash of a file's diff: a "viewed" mark holds only while the diff stays the same.
export function fingerprint(file) {
  const text = file.isGenerated
    ? `${file.status}${file.added}/${file.removed}`
    : `${file.status}${file.hunks.map((h) => h.lines.join('\n')).join('\n')}`
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}

export const STATUS_WORDS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed' }
