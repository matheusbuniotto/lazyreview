// lazyreview: a lazygit-style review pane for a tech lead. It reviews the session's
// working tree or a teammate's pull request: a brief (AI read, quick checks, where
// the weight is), the files with inline findings and a viewed mark, the asks
// against the diff, and a verdict posted to GitHub or handed back to Claude.

import {
  diffPieces,
  filePieces,
  fingerprint,
  generatedFile,
  holdsLine,
  isGenerated,
  isMarkdown,
  pageWhere,
  paginate,
  parseNumstat,
  parsePatch,
  totals,
} from './lib/diff.js'
import {
  MERGE_SYSTEM,
  REVIEW_SYSTEM,
  applyMerge,
  expectForkPrompt,
  expectSystem,
  expectPrompt,
  fixPrompt,
  mergePrompt,
  mergeReviews,
  parseExpectations,
  parseReview,
  reviewBatches,
  reviewPrompt,
  userAsks,
} from './lib/ai.js'
import { EVENTS, INBOX_FIELDS, PR_FIELDS, ago, draftReview, parseInbox, parsePr, prNumberOf, remoteFor, reviewMarkdown, suggestedEvent } from './lib/github.js'
import { scan } from './lib/signals.js'
import { drawBand, drawPane } from './lib/view/index.js'

const PANE = 'lazyreview'
// Not `review`: that name is Claude Code's alias for its built-in /code-review.
const COMMAND = 'lazyreview'
const MODES = ['head', 'staged', 'unstaged', 'branch']
const INBOX_WORDS = ['pr', 'prs', 'inbox']
const LOCAL = 0
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-M', '--unified=3']
const MAX_UNTRACKED = 300
const GIT_PARALLEL = 8
const AI_PARALLEL = 3
const MAX_BATCHES = 12
const MAX_ISSUES = 3
const INBOX_LIMIT = 40
const GIT_TIMEOUT_MS = 20_000
const GH_TIMEOUT_MS = 60_000
const FETCH_TIMEOUT_MS = 180_000
const REFRESH_DEBOUNCE_MS = 600
const SCROLL_AFTER_REDRAW_MS = 120

const idleReview = () => ({ status: 'idle', comments: [], summary: '', risk: '', verdict: '', focus: [], error: '', startedAt: 0, fileCount: 0, stamp: '', parts: 0, partsDone: 0, notes: [] })
const idleExpect = () => ({ status: 'idle', items: [], extras: [], vision: null, error: '', startedAt: 0 })
const idleVerdict = () => ({ event: '', message: '', status: 'idle', error: '', url: '' })

// Everything one review accumulates, kept per source (the working tree, or a PR
// number) so hopping between pull requests loses nothing.
const freshDesk = () => ({
  review: idleReview(),
  expect: idleExpect(),
  verdict: idleVerdict(),
  notes: new Map(),
  dismissed: new Set(),
  selectedPath: '',
  lastFindingId: '',
  abort: null,
  run: 0,
})

// Module state: lost on a reload, which only happens while developing the mod.
let aiModel = 'sonnet'
let isOpen = false
let view = 'review'
let tab = 'overview'
let mode = 'head'
let prNumber = LOCAL
let pr = null
let modeLabel = 'all changes vs HEAD'
let hideMarkdown = true
let root = ''
let branch = ''
let error = ''
let isLoading = false
let hasLoaded = false
let loadingLabel = 'Reading the diff…'
let allFiles = []
let staged = new Set()
let hunkIndex = 0
let reader = 'diff'
let fileText = null
let page = 0
let desks = new Map([[LOCAL, freshDesk()]])
let desk = desks.get(LOCAL)
let viewed = new Map()
let viewedKey = ''
let checks = { notes: [], findings: [] }
let inbox = { status: 'idle', rows: [], error: '', selected: 0, repo: '' }
let extraExpectations = []
let band = null
let hasEditedThisTurn = false
let ticker = null
let refreshTimer = null
let shownGenerated = new Set()
let diffWarnings = []
let lastBase = { args: [] }

const pageCache = new WeakMap()
const printCache = new WeakMap()

const visibleFiles = () => (hideMarkdown ? allFiles.filter((f) => !isMarkdown(f.path)) : allFiles)
const stampOf = (files) => files.map((f) => `${f.path}:${f.added}:${f.removed}`).join('|')
const isBusy = (d) => d.review.status === 'busy' || d.expect.status === 'busy'

function printOf(file) {
  if (!printCache.has(file)) printCache.set(file, fingerprint(file))
  return printCache.get(file)
}

function selectedIndex(files) {
  const i = files.findIndex((f) => f.path === desk.selectedPath)
  return i < 0 ? 0 : i
}

function selectedFile() {
  const files = visibleFiles()
  return files[selectedIndex(files)]
}

// The selected file's reader as pages of pieces, each page small enough for one drawing.
function readerPages() {
  const file = selectedFile()
  if (!file) return []
  const source = reader === 'diff' ? file : fileText?.path === file.path && !fileText.error ? fileText : null
  if (!source) return []
  if (!pageCache.has(source)) pageCache.set(source, paginate(reader === 'diff' ? diffPieces(file) : filePieces(fileText.text)))
  return pageCache.get(source)
}

// ── Findings, viewed marks, notes ──────────────────────────────────────────

// Quick-check red flags and AI comments on the files in view; a red flag the AI
// raised too (same line, same severity) is shown once, in the AI's words.
function allFindings() {
  const paths = new Set(visibleFiles().map((f) => f.path))
  const said = new Set(desk.review.comments.map((c) => `${c.file}:${c.line}:${c.severity}`))
  const quick = checks.findings.filter((c) => !said.has(`${c.file}:${c.line}:${c.severity}`))
  return [...quick, ...desk.review.comments].filter((c) => paths.has(c.file))
}

// Findings still to act on, in the order the file list shows them.
function openFindings() {
  const findings = allFindings().filter((c) => c.severity !== 'praise' && !desk.dismissed.has(c.id))
  return visibleFiles().flatMap((file) => findings.filter((c) => c.file === file.path).sort((a, b) => a.line - b.line))
}

function viewedPaths() {
  return new Set(visibleFiles().filter((f) => viewed.get(f.path) === printOf(f)).map((f) => f.path))
}

function nextUnviewed() {
  const files = visibleFiles()
  const from = selectedIndex(files)
  for (let k = 1; k <= files.length; k++) {
    const i = (from + k) % files.length
    if (viewed.get(files[i].path) !== printOf(files[i])) return i
  }
  return -1
}

// A note may start with a line: "L42: rename this" or "42: rename this".
function parseNote(text) {
  const match = text.match(/^L?(\d+)\s*[:–-]\s*([\s\S]+)$/i)
  return match ? { line: Number(match[1]), text: match[2].trim() } : { line: 0, text: text.trim() }
}

const noteList = () => [...desk.notes].flatMap(([file, notes]) => notes.map((note) => ({ file, ...note })))

function suggested() {
  const isLookedAt = desk.review.status === 'done' || viewedPaths().size === visibleFiles().length
  return suggestedEvent({ findings: openFindings(), items: desk.expect.items, aiVerdict: desk.review.verdict, isLookedAt })
}

function currentDraft() {
  return draftReview({
    message: desk.verdict.message,
    findings: openFindings(),
    notes: noteList(),
    items: desk.expect.items,
    extras: desk.expect.extras,
    files: visibleFiles(),
    canInline: Boolean(pr),
  })
}

const fixText = () => fixPrompt({ comments: openFindings(), items: desk.expect.items, notes: noteList() })

// ── git and gh ─────────────────────────────────────────────────────────────

async function git($, args, timeoutMs = GIT_TIMEOUT_MS) {
  return $.process.run(['git', '-c', 'core.quotePath=false', ...args], { cwd: root, timeoutMs })
}

async function gh($, args, stdin = undefined) {
  return $.process.run(['gh', ...args], { cwd: root, timeoutMs: GH_TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }) })
}

// The line that says why a command failed: git's `fatal:` rather than its warnings.
function failure(out, what) {
  const lines = out.stderr.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('warning:'))
  return new Error(lines.find((l) => l.startsWith('fatal:') || l.startsWith('error:')) ?? lines[0] ?? `${what} failed`)
}

const GH_HINT = 'Pull requests need the GitHub CLI, signed in (gh auth login), in a clone of a GitHub repo.'

async function findRoot($) {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await $.session.cwd() })
  if (top.exitCode !== 0) return false
  root = top.stdout.trim()
  return true
}

async function baseArgs($) {
  if (mode === 'staged') return { args: ['--cached'], label: 'staged', withUntracked: false }
  if (mode === 'unstaged') return { args: [], label: 'unstaged', withUntracked: true }
  if (mode === 'branch') {
    for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
      const base = await git($, ['merge-base', 'HEAD', ref])
      if (base.exitCode === 0) return { args: [base.stdout.trim()], label: `branch vs ${ref.replace(/^origin\/HEAD$/, 'origin')}`, withUntracked: true }
    }
  }
  const head = await git($, ['rev-parse', '--verify', '-q', 'HEAD'])
  return { args: [head.exitCode === 0 ? 'HEAD' : EMPTY_TREE], label: 'all changes vs HEAD', withUntracked: true }
}

const hasCommit = async ($, sha) => (await git($, ['cat-file', '-e', `${sha}^{commit}`])).exitCode === 0

// The PR's metadata from GitHub and its commits in the local clone, so the diff,
// whole files and big-change handling run on git exactly as for local changes.
async function prBase($) {
  loadingLabel = `Reading PR #${prNumber} from GitHub…`
  const meta = await gh($, ['pr', 'view', String(prNumber), '--json', PR_FIELDS]).catch((err) => ({ exitCode: 1, stderr: err.message }))
  if (meta.exitCode !== 0) throw new Error(`${failure(meta, 'gh pr view').message}. ${GH_HINT}`)
  pr = parsePr(JSON.parse(meta.stdout))
  if (!(await hasCommit($, pr.headSha)) || !(await hasCommit($, pr.baseSha))) {
    loadingLabel = `Fetching PR #${prNumber}…`
    $.ui.invalidate('ui.render')
    const remote = remoteFor((await git($, ['remote', '-v'])).stdout, pr.repo)
    const fetched = await git($, ['fetch', '--no-tags', '--quiet', remote, `pull/${prNumber}/head`, pr.base], FETCH_TIMEOUT_MS)
    if (fetched.exitCode !== 0) throw failure(fetched, 'git fetch')
  }
  const base = await git($, ['merge-base', pr.baseSha, pr.headSha])
  if (base.exitCode !== 0) throw new Error(`could not find where PR #${prNumber} branches off ${pr.base}`)
  return { args: [base.stdout.trim(), pr.headSha], label: `PR #${prNumber}`, withUntracked: false }
}

// Runs `fn` over `items`, at most `size` at a time, keeping the order of results.
async function inParallel(items, size, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
  return results
}

async function untrackedFiles($) {
  const listed = await git($, ['ls-files', '--others', '--exclude-standard', '-z'])
  const all = listed.stdout.split('\0').filter(Boolean)
  if (all.length > MAX_UNTRACKED) diffWarnings.push(`${all.length - MAX_UNTRACKED} more untracked files not shown`)
  const files = await inParallel(all.slice(0, MAX_UNTRACKED), GIT_PARALLEL, async (path) => {
    if (isGenerated(path)) {
      const stat = await git($, ['diff', '--no-index', '--numstat', '-z', '--', '/dev/null', path])
      const { added = 0, removed = 0 } = parseNumstat(stat.stdout)[0] ?? {}
      return [{ ...generatedFile({ path, added, removed }, 'A'), diffArgs: ['--no-index', '--', '/dev/null', path] }]
    }
    const diff = await git($, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', path])
    if (diff.isStdoutTruncated) diffWarnings.push(`${path} is over 4 MiB and was cut`)
    return parsePatch(diff.stdout)
  })
  return files.flat()
}

// Tracked generated files (lock files, build output): counted, and kept out of the patch.
async function trackedGenerated($, args) {
  const stat = await git($, ['diff', '--numstat', '-z', '-M', ...args])
  return parseNumstat(stat.stdout)
    .filter((entry) => isGenerated(entry.path))
    .map((entry) => ({ ...generatedFile(entry, 'M'), diffArgs: [...args, '--', entry.oldPath ?? entry.path, entry.path] }))
}

async function loadDiff($) {
  isLoading = true
  diffWarnings = []
  loadingLabel = 'Reading the diff…'
  $.ui.invalidate('ui.render')
  try {
    if (!(await findRoot($))) {
      error = 'Not inside a git repository. Start Claude Code in a repo to review its changes.'
      allFiles = []
      return
    }
    const base = prNumber ? await prBase($) : await baseArgs($)
    branch = prNumber ? pr.head : (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    const generated = await trackedGenerated($, base.args)
    const skip = generated.flatMap((f) => [f.path, f.oldPath]).map((path) => `:(exclude,literal)${path}`)
    const [tracked, untracked, cached] = await Promise.all([
      git($, ['diff', ...DIFF_FLAGS, ...base.args, '--', '.', ...skip]),
      base.withUntracked ? untrackedFiles($) : [],
      prNumber ? { stdout: '' } : git($, ['diff', '--cached', '--name-only', '-z']),
    ])
    if (tracked.exitCode !== 0) throw failure(tracked, 'git diff')
    if (tracked.isStdoutTruncated) diffWarnings.push('the diff is over 4 MiB: files past that point are missing')
    modeLabel = base.label
    lastBase = base
    allFiles = [...parsePatch(tracked.stdout), ...generated, ...untracked].sort((a, b) => a.path.localeCompare(b.path))
    staged = new Set(cached.stdout.split('\0').filter(Boolean))
    error = ''
    await inParallel(allFiles.filter((f) => f.isGenerated && shownGenerated.has(f.path)), GIT_PARALLEL, (f) => revealGenerated($, f.path))
    checks = scan(allFiles, pr)
    await loadViewed($)
    if (desk.review.status === 'done') desk.review = { ...desk.review, isStale: desk.review.stamp !== stampOf(visibleFiles()) }
    if (reader === 'file') await loadFile($)
  } catch (err) {
    error = prNumber ? `Could not open PR #${prNumber}: ${err.message}` : `git failed: ${err.message}`
  } finally {
    isLoading = false
    hasLoaded = true
    $.ui.invalidate('ui.render')
  }
}

// Reads the diff of a generated file the person asked to see.
async function revealGenerated($, path) {
  const file = allFiles.find((f) => f.path === path)
  if (!file?.diffArgs) return
  shownGenerated.add(path)
  const diff = await git($, ['diff', ...DIFF_FLAGS, ...file.diffArgs])
  const [parsed] = parsePatch(diff.stdout)
  if (parsed) allFiles = allFiles.map((f) => (f === file ? { ...parsed, path, isGenerated: true, diffArgs: file.diffArgs } : f))
  $.ui.invalidate('ui.render')
}

// The new version of a file, or the old one when it was deleted.
async function readSource($, file) {
  const path = file.status === 'D' ? file.oldPath || file.path : file.path
  if (prNumber) return (await git($, ['show', `${file.status === 'D' ? lastBase.args[0] : pr.headSha}:${path}`])).stdout
  if (file.status === 'D') return (await git($, ['show', `HEAD:${path}`])).stdout
  return $.fs.read(`${root}/${path}`)
}

async function loadFile($) {
  const file = selectedFile()
  if (!file) return
  try {
    fileText = { path: file.path, text: await readSource($, file) }
  } catch (err) {
    fileText = { path: file.path, text: '', error: `Could not read ${file.path}: ${err.message}` }
  }
  $.ui.invalidate('ui.render')
}

function scheduleRefresh($) {
  refreshTimer?.cancel()
  refreshTimer = $.clock.after(REFRESH_DEBOUNCE_MS, () => {
    refreshTimer = null
    void loadDiff($)
  })
}

// Viewed marks persist per source; each holds only while the file's diff is unchanged.
async function loadViewed($) {
  const key = `viewed:${root}#${prNumber}`
  if (key === viewedKey) return
  viewedKey = key
  const saved = await $.store.get(key)
  viewed = new Map(saved && typeof saved === 'object' ? Object.entries(saved) : [])
}

async function saveViewed($) {
  const kept = allFiles.filter((f) => viewed.has(f.path)).map((f) => [f.path, viewed.get(f.path)])
  await $.store.set(viewedKey, Object.fromEntries(kept))
}

// ── Sources: the working tree, or a pull request ──────────────────────────

function switchSource(number) {
  if (number === prNumber && hasLoaded) return
  prNumber = number
  if (!desks.has(number)) desks.set(number, freshDesk())
  desk = desks.get(number)
  pr = null
  allFiles = []
  checks = { notes: [], findings: [] }
  fileText = null
  reader = 'diff'
  page = 0
  hunkIndex = 0
  shownGenerated = new Set()
  hasLoaded = false
}

async function openPr($, number) {
  switchSource(number)
  view = 'review'
  tab = 'overview'
  await loadDiff($)
}

async function loadInbox($) {
  inbox = { ...inbox, status: 'loading', error: '' }
  $.ui.invalidate('ui.render')
  try {
    if (!root && !(await findRoot($))) throw new Error('not inside a git repository')
    const [all, waiting, repo] = await Promise.all([
      gh($, ['pr', 'list', '--state', 'open', '--limit', String(INBOX_LIMIT), '--json', INBOX_FIELDS]),
      gh($, ['pr', 'list', '--state', 'open', '--limit', String(INBOX_LIMIT), '--search', 'review-requested:@me', '--json', 'number']),
      gh($, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']),
    ])
    if (all.exitCode !== 0) throw failure(all, 'gh pr list')
    const now = await $.clock.now()
    const rows = parseInbox(JSON.parse(all.stdout), waiting.exitCode === 0 ? JSON.parse(waiting.stdout) : []).map((row) => ({ ...row, age: ago(row.updatedAt, now) }))
    inbox = { status: 'done', rows, error: '', selected: Math.max(0, Math.min(inbox.selected, rows.length - 1)), repo: repo.exitCode === 0 ? repo.stdout.trim() : '' }
  } catch (err) {
    inbox = { ...inbox, status: 'error', error: `Could not list pull requests: ${err.message}. ${GH_HINT}` }
  } finally {
    $.ui.invalidate('ui.render')
  }
}

async function openInbox($) {
  view = 'inbox'
  $.ui.invalidate('ui.render')
  if (inbox.status !== 'done') await loadInbox($)
}

async function closeInbox($) {
  view = 'review'
  if (hasLoaded) return $.ui.invalidate('ui.render')
  switchSource(LOCAL)
  await loadDiff($)
}

// ── AI ─────────────────────────────────────────────────────────────────────

function startTicker($) {
  ticker ??= $.clock.every(500, () => $.ui.invalidate('ui.render'))
}

function stopTicker() {
  if ([...desks.values()].some(isBusy)) return
  ticker?.cancel()
  ticker = null
}

async function complete($, signal, system, prompt) {
  const reply = await $.model.complete({ model: aiModel, system, prompt, maxTokens: 8000, timeoutMs: 180_000 }, { signal })
  if (!reply.isAnswered) throw new Error(reply.reason === 'aborted' ? 'cancelled' : `${reply.reason}${reply.error ? `: ${reply.error}` : ''}`)
  return reply.text
}

// Asks a fork of the session, which knows the whole conversation; null before the first reply.
async function forkSession($, prompt) {
  const reply = await $.model.fork({ prompt })
  if (reply.isAnswered) return reply.text
  if (reply.reason === 'nothing-to-fork') return null
  throw new Error(`${reply.reason}${reply.error ? `: ${reply.error}` : ''}`)
}

// Every call of one run shares the desk's abort signal, so x cancels them together;
// the results land on the desk that started the run, even after switching PRs.
async function runReview($) {
  const mine = desk
  const files = visibleFiles()
  const skipped = files.filter((f) => isGenerated(f.path))
  const batches = reviewBatches(files)
  if (!batches.length) return $.ui.toast(`lazyreview: nothing to review${skipped.length ? ' but generated files' : ''}`)
  const parts = batches.slice(0, MAX_BATCHES)
  const intent = pr ? `${pr.title}\n\n${pr.body}` : ''
  const run = ++mine.run
  mine.abort = new AbortController()
  mine.review = { ...idleReview(), status: 'busy', startedAt: await $.clock.now(), fileCount: files.length - skipped.length, parts: parts.length }
  mine.dismissed = new Set([...mine.dismissed].filter((id) => checks.findings.some((c) => c.id === id)))
  mine.lastFindingId = ''
  startTicker($)
  try {
    const results = await inParallel(parts, AI_PARALLEL, async (batch, i) => {
      try {
        const text = await complete($, mine.abort.signal, REVIEW_SYSTEM, reviewPrompt(batch, i + 1, parts.length, intent))
        return parseReview(text, files.map((f) => f.path), parts.length > 1 ? `c${i}-` : 'c')
      } catch (err) {
        return { error: err.message }
      } finally {
        if (run === mine.run) mine.review = { ...mine.review, partsDone: mine.review.partsDone + 1 }
      }
    })
    if (run !== mine.run) return
    const answered = results.filter((r) => !r.error)
    if (!answered.length) throw new Error(results[0].error)
    const failed = results.find((r) => r.error)
    const notes = [
      ...(skipped.length ? [`${skipped.length} generated file${skipped.length === 1 ? '' : 's'} not reviewed`] : []),
      ...(batches.length > parts.length ? [`${batches.length - parts.length} of ${batches.length} parts not reviewed: the diff is too large, review fewer files (s, b)`] : []),
      ...(failed ? [`${results.length - answered.length} of ${results.length} parts failed: ${failed.error}`] : []),
    ]
    let merged = mergeReviews(answered)
    if (answered.length > 1) {
      try {
        merged = applyMerge(merged, await complete($, mine.abort.signal, MERGE_SYSTEM, mergePrompt(merged, intent)))
      } catch {
        merged = { ...merged, summary: answered[0].summary, focus: merged.focus.slice(0, 3) }
      }
      if (run !== mine.run) return
    }
    mine.review = { ...idleReview(), ...merged, status: 'done', stamp: stampOf(files), parts: parts.length, notes }
  } catch (err) {
    if (run === mine.run) mine.review = { ...idleReview(), status: 'error', error: err.message }
  } finally {
    stopTicker()
    $.ui.invalidate('ui.render')
  }
}

// What a pull request says it closes, as text for the expectations check.
async function linkedIssues($) {
  try {
    const refs = await gh($, ['pr', 'view', String(prNumber), '--json', 'closingIssuesReferences'])
    const numbers = JSON.parse(refs.stdout).closingIssuesReferences.map((i) => i.number).slice(0, MAX_ISSUES)
    const issues = await Promise.all(numbers.map((n) => gh($, ['issue', 'view', String(n), '--json', 'number,title,body'])))
    return issues.filter((r) => r.exitCode === 0).map((r) => JSON.parse(r.stdout)).map((i) => `Issue #${i.number}: ${i.title}\n\n${i.body}`)
  } catch {
    return []
  }
}

// The project's VISION.md as committed (a PR's base, so a PR cannot rewrite its own vision).
async function projectVision($) {
  const done = await git($, ['show', `${prNumber ? pr.baseSha : 'HEAD'}:VISION.md`])
  return done.exitCode === 0 ? done.stdout.trim() : ''
}

async function runExpect($) {
  const mine = desk
  const files = visibleFiles()
  const own = extraExpectations.map((x) => `The reviewer also expects: ${x}`)
  const run = ++mine.run
  mine.abort = new AbortController()
  mine.expect = { ...idleExpect(), status: 'busy', startedAt: await $.clock.now() }
  startTicker($)
  try {
    const vision = await projectVision($)
    const system = expectSystem(vision)
    let text
    if (pr) {
      const asks = [`${pr.title}\n\n${pr.body}`.trim(), ...(await linkedIssues($)), ...own]
      text = await complete($, mine.abort.signal, system, expectPrompt(asks, files, 'The pull request description and linked issues', vision))
    } else {
      text = await forkSession($, expectForkPrompt(extraExpectations, files, vision))
      if (text === null) {
        const asks = [...userAsks(await $.session.messages()), ...own]
        if (!asks.length) {
          mine.expect = { ...idleExpect(), status: 'empty' }
          return
        }
        text = await complete($, mine.abort.signal, system, expectPrompt(asks, files, undefined, vision))
      }
    }
    if (run !== mine.run) return
    mine.expect = { ...idleExpect(), ...parseExpectations(text), status: 'done' }
  } catch (err) {
    if (run === mine.run) mine.expect = { ...idleExpect(), status: 'error', error: err.message }
  } finally {
    stopTicker()
    $.ui.invalidate('ui.render')
  }
}

function cancelAi() {
  desk.run++
  desk.abort?.abort()
  if (desk.review.status === 'busy') desk.review = idleReview()
  if (desk.expect.status === 'busy') desk.expect = idleExpect()
  stopTicker()
}

// ── Verdict ────────────────────────────────────────────────────────────────

async function postReview($) {
  const mine = desk
  const number = prNumber
  const draft = currentDraft()
  const event = mine.verdict.event || suggested()
  const body = draft.body || (event === 'APPROVE' ? '' : draft.inline.length ? 'See the comments inline.' : EVENTS[event])
  mine.verdict = { ...mine.verdict, event, status: 'posting', error: '' }
  $.ui.invalidate('ui.render')
  try {
    const payload = JSON.stringify({ commit_id: pr.headSha, event, body, comments: draft.inline })
    const out = await gh($, ['api', '--method', 'POST', `repos/${pr.repo}/pulls/${number}/reviews`, '--input', '-'], payload)
    if (out.exitCode !== 0) throw failure(out, 'gh api')
    mine.verdict = { ...mine.verdict, status: 'posted', url: JSON.parse(out.stdout).html_url ?? '' }
    $.ui.toast(`lazyreview: review posted on #${number}`)
  } catch (err) {
    mine.verdict = { ...mine.verdict, status: 'error', error: err.message }
  } finally {
    $.ui.invalidate('ui.render')
  }
}

async function copyReview($, press) {
  const text = pr ? reviewMarkdown(currentDraft()) : fixText()
  if (!text) return $.ui.toast('lazyreview: nothing to copy yet')
  const copied = await $.ui.copy({ text, ...(press?.surface ? { surface: press.surface } : {}) })
  $.ui.toast(copied.isCopied ? 'lazyreview: review copied as Markdown' : 'lazyreview: could not reach the clipboard')
}

async function fixWithClaude($) {
  const text = fixText()
  if (!text) return $.ui.toast('lazyreview: nothing to fix yet. Run the AI review (a) or leave a note.')
  $.prompt.submit({ text, asUser: true }).catch(() => $.ui.toast('lazyreview: could not send the fixes'))
  $.ui.toast('lazyreview: sent the review to Claude. The pane refreshes as files change.')
}

// ── Pane ───────────────────────────────────────────────────────────────────

async function openPane($) {
  band = null
  const placed = await $.ui.open({ id: PANE, title: 'Review', focus: true, rows: 36, columns: 110 })
  isOpen = true
  if (!placed.isPlaced) $.ui.toast(`lazyreview: ${placed.reason ?? 'no room for the pane yet'}`)
  $.ui.invalidate('ui.render')
}

// Scrolls once the redraw that puts the target on screen has landed.
function scrollSoon($, to, block) {
  $.clock.after(SCROLL_AFTER_REDRAW_MS, () => {
    $.ui.scroll({ in: PANE, to, block }).catch(() => {})
  })
}

async function select($, index) {
  const files = visibleFiles()
  const file = files[Math.max(0, Math.min(index, files.length - 1))]
  if (!file) return
  desk.selectedPath = file.path
  hunkIndex = 0
  page = 0
  fileText = null
  $.ui.invalidate('ui.render')
  if (reader === 'file') await loadFile($)
  scrollSoon($, 'start', 'start')
}

// Opens the Files tab on `path`, at the page and piece holding `line` (or the finding `id`).
async function jumpTo($, path, line = 0, id = '') {
  const i = visibleFiles().findIndex((f) => f.path === path)
  if (i < 0) return $.ui.toast(`lazyreview: ${path} is hidden (m shows .md files)`)
  tab = 'files'
  reader = 'diff'
  if (path !== selectedFile()?.path) await select($, i)
  if (id) desk.lastFindingId = id
  const pages = readerPages()
  page = line ? Math.max(0, pageWhere(pages, (piece) => holdsLine(piece, line))) : 0
  $.ui.invalidate('ui.render')
  if (id) return scrollSoon($, { key: 'comment-' + id }, 'center')
  const pieces = pages[page] ?? []
  const at = pieces.findIndex((piece) => holdsLine(piece, line))
  if (line && at >= 0) scrollSoon($, { key: pieces[at].isHunkStart ? 'hunk-' + pieces[at].hunkIndex : 'piece-' + at }, 'start')
}

async function nextFinding($) {
  const findings = openFindings()
  if (!findings.length) return $.ui.toast('lazyreview: no open findings')
  const next = findings[(findings.findIndex((c) => c.id === desk.lastFindingId) + 1) % findings.length]
  await jumpTo($, next.file, next.line, next.id)
}

async function jumpHunk($, delta) {
  const file = selectedFile()
  if (!file?.hunks.length || reader !== 'diff') return
  hunkIndex = Math.max(0, Math.min(hunkIndex + delta, file.hunks.length - 1))
  const onPage = pageWhere(readerPages(), (piece) => piece.hunkIndex === hunkIndex && piece.isHunkStart)
  if (onPage !== page) {
    page = onPage
    $.ui.invalidate('ui.render')
  }
  scrollSoon($, { key: 'hunk-' + hunkIndex }, 'start')
}

async function turnPage($, delta) {
  const to = Math.max(0, Math.min(page + delta, readerPages().length - 1))
  if (to === page) return
  page = to
  $.ui.invalidate('ui.render')
  scrollSoon($, 'start', 'start')
}

// Marks the file viewed and moves to the next one not viewed yet, as GitHub does.
async function toggleViewed($) {
  const file = selectedFile()
  if (!file) return
  if (viewed.get(file.path) === printOf(file)) {
    viewed.delete(file.path)
  } else {
    viewed.set(file.path, printOf(file))
    const next = nextUnviewed()
    if (next >= 0) await select($, next)
    else $.ui.toast('lazyreview: every file viewed. 4 writes the verdict.')
  }
  $.ui.invalidate('ui.render')
  await saveViewed($)
}

async function toggleStage($) {
  const file = selectedFile()
  if (!file || prNumber) return
  const paths = file.oldPath && file.oldPath !== file.path ? [file.oldPath, file.path] : [file.path]
  const args = staged.has(file.path) ? ['restore', '--staged', '--', ...paths] : ['add', '--', ...paths]
  const done = await git($, args)
  if (done.exitCode !== 0) $.ui.toast(`lazyreview: ${done.stderr.trim() || 'git failed'}`)
  await loadDiff($)
}

function actionsFor($) {
  const redraw = () => $.ui.invalidate('ui.render')
  return {
    showTab: (name) => {
      tab = name
      redraw()
    },
    select: (i) => select($, i),
    open: async (i) => {
      tab = 'files'
      await select($, i)
    },
    move: (delta) => select($, selectedIndex(visibleFiles()) + delta),
    walkFiles: async () => {
      tab = 'files'
      const next = viewedPaths().has(selectedFile()?.path) ? nextUnviewed() : selectedIndex(visibleFiles())
      await select($, Math.max(0, next))
    },
    jumpTo: (path, line, id) => jumpTo($, path, line, id),
    hunk: (delta) => jumpHunk($, delta),
    page: (delta) => turnPage($, delta),
    toggleViewed: () => toggleViewed($),
    toggleStage: () => toggleStage($),
    revealGenerated: (path) => revealGenerated($, path),
    toggleReader: async () => {
      reader = reader === 'diff' ? 'file' : 'diff'
      page = 0
      redraw()
      if (reader === 'file') await loadFile($)
    },
    toggleMarkdown: async () => {
      hideMarkdown = !hideMarkdown
      redraw()
      await $.store.set('hideMarkdown', hideMarkdown)
    },
    cycleMode: async () => {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]
      await $.store.set('mode', mode)
      await loadDiff($)
    },
    runReview: () => runReview($),
    runExpect: () => {
      tab = 'expect'
      return runExpect($)
    },
    cancelAi: () => {
      cancelAi()
      redraw()
    },
    nextFinding: () => nextFinding($),
    dismissCurrent: async () => {
      desk.dismissed = new Set(desk.dismissed).add(desk.lastFindingId)
      if (openFindings().length) await nextFinding($)
      else redraw()
    },
    toggleDismissed: (id) => {
      desk.dismissed = new Set(desk.dismissed)
      if (desk.dismissed.has(id)) desk.dismissed.delete(id)
      else desk.dismissed.add(id)
      redraw()
    },
    addNote: (path, text) => {
      if (!text.trim()) return
      desk.notes.set(path, [...(desk.notes.get(path) ?? []), parseNote(text)])
      redraw()
    },
    removeNote: (path, i) => {
      desk.notes.set(path, (desk.notes.get(path) ?? []).filter((_, j) => j !== i))
      redraw()
    },
    addExpectation: async (text) => {
      if (!text.trim()) return
      extraExpectations = [...extraExpectations, text.trim()]
      redraw()
      await $.store.set('expectations', extraExpectations)
    },
    removeExpectation: async (i) => {
      extraExpectations = extraExpectations.filter((_, j) => j !== i)
      redraw()
      await $.store.set('expectations', extraExpectations)
    },
    chooseEvent: (event) => {
      desk.verdict = { ...desk.verdict, event, status: desk.verdict.status === 'posted' ? 'posted' : 'idle' }
      redraw()
    },
    setMessage: (message) => {
      desk.verdict = { ...desk.verdict, message }
      redraw()
    },
    askToPost: () => {
      desk.verdict = { ...desk.verdict, status: 'confirm', event: desk.verdict.event || suggested() }
      redraw()
    },
    cancelPost: () => {
      desk.verdict = { ...desk.verdict, status: 'idle' }
      redraw()
    },
    post: () => postReview($),
    copy: (press) => copyReview($, press),
    fix: () => fixWithClaude($),
    openInbox: () => openInbox($),
    closeInbox: () => closeInbox($),
    refreshInbox: () => loadInbox($),
    inboxMove: (delta) => {
      inbox = { ...inbox, selected: Math.max(0, Math.min(inbox.selected + delta, inbox.rows.length - 1)) }
      redraw()
      if (inbox.rows[inbox.selected]) scrollSoon($, { key: 'pr-row-' + inbox.rows[inbox.selected].number }, 'nearest')
    },
    inboxOpen: () => (inbox.rows[inbox.selected] ? openPr($, inbox.rows[inbox.selected].number) : undefined),
    openPr: (number) => openPr($, number),
    refresh: () => loadDiff($),
    close: () => $.ui.close({ id: PANE }),
  }
}

async function snapshot($, e) {
  const files = visibleFiles()
  const pages = readerPages()
  page = Math.max(0, Math.min(page, pages.length - 1))
  const now = await $.clock.now()
  const open = openFindings()
  const seen = viewedPaths()
  const viewedCount = files.filter((f) => seen.has(f.path)).length
  const notes = noteList()
  return {
    view,
    inbox,
    started: new Set([...desks.keys()].filter((n) => n !== LOCAL)),
    hasReview: hasLoaded,
    tab,
    pr,
    prAge: pr ? ago(pr.updatedAt, now) : '',
    branch,
    modeLabel,
    error,
    isLoading,
    loadingLabel,
    files,
    totals: totals(files),
    hiddenCount: allFiles.length - files.length,
    hideMarkdown,
    selected: selectedIndex(files),
    staged,
    reader,
    fileText,
    pages,
    page,
    diffWarnings,
    review: desk.review,
    expect: desk.expect,
    notes: desk.notes,
    extraExpectations,
    checks,
    findings: allFindings(),
    openFindings: open,
    currentFinding: open.find((c) => c.id === desk.lastFindingId),
    dismissed: desk.dismissed,
    flags: checks.findings.filter((c) => c.severity === 'bug' && !desk.dismissed.has(c.id)).length + checks.notes.filter((n) => n.level === 'bad').length,
    viewed: seen,
    viewedCount,
    unviewed: files.length - viewedCount,
    verdict: { ...desk.verdict, event: desk.verdict.event || suggested(), suggested: suggested() },
    draft: pr ? currentDraft() : { body: '', inline: [] },
    remarkCount: open.length + notes.length,
    fixText: pr ? '' : fixText(),
    canFix: Boolean(fixText()),
    isInline: e.props.placement === 'inline',
    columns: e.props.bodyColumns ?? 100,
    now,
  }
}

// Plain text for places nothing draws: `claude -p "/lazyreview ai"`, the VS Code chat.
function textReport() {
  if (error) return error
  const files = visibleFiles()
  const lines = pr
    ? [`lazyreview · PR #${pr.number} ${pr.title} · @${pr.author}${pr.agent ? ` · ${pr.agent}` : ''} · ${files.length} files`]
    : [`lazyreview · ${branch} · ${modeLabel} · ${files.length} files`]
  for (const f of files) lines.push(`  ${f.status} ${f.path} +${f.added} -${f.removed}${f.isGenerated ? ' (generated)' : ''}`)
  for (const warning of diffWarnings) lines.push(`  ⚠ ${warning}`)
  if (checks.notes.length || checks.findings.length) {
    lines.push('', 'Quick checks:')
    for (const note of checks.notes) lines.push(`  ${note.level === 'info' ? 'ℹ' : '⚠'} ${note.text}`)
    for (const c of checks.findings) lines.push(`  [${c.severity}] ${c.file}:${c.line} ${c.title}`)
  }
  const { review, expect } = desk
  if (review.status === 'done') {
    lines.push('', `AI${review.risk ? ` (risk ${review.risk})` : ''}: ${review.summary}`)
    for (const note of review.notes) lines.push(`  ⚠ ${note}`)
    for (const f of review.focus) lines.push(`  → ${f.file}:${f.line} ${f.why}`)
    for (const c of review.comments) lines.push(`  [${c.severity}] ${c.file}:${c.line} ${c.title}: ${c.body}`)
  }
  if (review.status === 'error') lines.push('', `AI review failed: ${review.error}`)
  if (expect.status === 'done') {
    lines.push('', 'Expected vs implemented:')
    for (const i of expect.items) lines.push(`  [${i.verdict}] ${i.expectation}${i.note ? ` (${i.note})` : ''}`)
  }
  if (expect.status === 'error') lines.push('', `Check failed: ${expect.error}`)
  return lines.join('\n')
}

function inboxReport() {
  if (inbox.status === 'error') return inbox.error
  if (!inbox.rows.length) return 'No open pull requests.'
  return [
    `Open pull requests${inbox.repo ? ` in ${inbox.repo}` : ''}:`,
    ...inbox.rows.map((r) => `  ${r.isWaiting ? '●' : ' '} #${r.number} ${r.title} · @${r.author}${r.agent ? ` · ${r.agent}` : ''} · +${r.added} -${r.removed} · ${r.age}`),
    '',
    'Open one with /lazyreview <number>.',
  ].join('\n')
}

// ── Hooks ──────────────────────────────────────────────────────────────────

export function register(on, options) {
  if (options?.model) aiModel = options.model

  on('session.start', async ($, e, next) => {
    const savedMode = await $.store.get('mode')
    if (MODES.includes(savedMode)) mode = savedMode
    hideMarkdown = (await $.store.get('hideMarkdown')) !== false
    const savedExpectations = await $.store.get('expectations')
    if (Array.isArray(savedExpectations)) extraExpectations = savedExpectations.filter((x) => typeof x === 'string')
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Review changes or a pull request: brief, inline diff with AI findings, asks vs diff, verdict',
        argumentHint: '[<pr number or url>|prs|ai|expect|head|staged|unstaged|branch]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`lazyreview: could not register /${COMMAND}: ${err.message}`, { to: 'debug' })
    }
    return next(e)
  })

  // A new conversation asks for new things: the working tree's verdicts no longer apply.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    desks.set(LOCAL, freshDesk())
    if (prNumber === LOCAL) desk = desks.get(LOCAL)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const lower = words.map((w) => w.toLowerCase())
    const number = words.map(prNumberOf).find(Boolean)
    const newMode = lower.find((w) => MODES.includes(w))
    const wantsInbox = !number && lower.some((w) => INBOX_WORDS.includes(w))
    const surfaces = await $.session.surfaces()

    if (wantsInbox) {
      if (!surfaces.length) {
        await loadInbox($)
        return { text: inboxReport() }
      }
      await openPane($)
      await openInbox($)
      return {}
    }

    if (number) switchSource(number)
    else if (newMode || !hasLoaded) switchSource(LOCAL)
    if (newMode) {
      mode = newMode
      await $.store.set('mode', mode)
    }
    view = 'review'
    await loadDiff($)

    if (!surfaces.length) {
      if (lower.includes('ai')) await runReview($)
      if (lower.includes('expect')) await runExpect($)
      return { text: textReport() }
    }

    tab = lower.includes('expect') ? 'expect' : 'overview'
    await openPane($)
    if (lower.includes('ai')) void runReview($)
    if (lower.includes('expect')) void runExpect($)
    return {}
  })

  // Claude changed files: refresh an open pane on the working tree, and offer a review.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (EDIT_TOOLS.has(e.tool)) hasEditedThisTurn = true
    if (isOpen && prNumber === LOCAL && (EDIT_TOOLS.has(e.tool) || e.tool === 'Bash')) scheduleRefresh($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || !hasEditedThisTurn || prNumber !== LOCAL) return result
    hasEditedThisTurn = false
    $.clock.after(300, async () => {
      await loadDiff($)
      const files = visibleFiles()
      const flags = checks.findings.filter((c) => c.severity === 'bug').length
      if (!isOpen && files.length) band = { fileCount: files.length, flags, ...totals(files) }
      $.ui.invalidate('ui.render')
    })
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    // Still on screen after a reload of the mod, which emptied the module state.
    if (!hasLoaded && !isLoading) {
      isOpen = true
      isLoading = true
      $.clock.after(0, () => loadDiff($))
    }
    return drawPane($.ui.resolve(e), await snapshot($, e), actionsFor($))
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!band || isOpen || e.props.hasSurvey) return next(e)
    const theirs = await next(e)
    const el = $.ui.resolve(e)
    const mine = drawBand(el, band, {
      open: () => {
        tab = 'overview'
        return openPane($)
      },
      dismiss: () => {
        band = null
        $.ui.invalidate('ui.render')
      },
    })
    return el.Box({ flexDirection: 'column', children: [mine, theirs].filter(Boolean) })
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isOpen = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })
}
