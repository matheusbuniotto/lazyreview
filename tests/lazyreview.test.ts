import { expect, mock, test } from 'claude-code/testing'
import { diffPieces, isGenerated, paginate, parseNumstat, parsePatch } from '../hooks/lib/diff.js'
import { applyMerge, fixPrompt, mergeReviews, parseReview, patchFor, reviewBatches, userAsks } from '../hooks/lib/ai.js'
import { agentOf, checksOf, draftReview, prNumberOf, remoteFor, suggestedEvent } from '../hooks/lib/github.js'
import { scan } from '../hooks/lib/signals.js'

const TRACKED = `diff --git a/math.js b/math.js
index 1..2 100644
--- a/math.js
+++ b/math.js
@@ -1,3 +1,7 @@
 export function add(a, b) {
   return a + b
 }
+
+export function div(a, b) {
+  return a / b
+}
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Notes
+more
`

const UNTRACKED = `diff --git a/new.js b/new.js
new file mode 100644
--- /dev/null
+++ b/new.js
@@ -0,0 +1 @@
+const x = JSON.parse(input)
`

const SECRET = `diff --git a/auth.js b/auth.js
new file mode 100644
--- /dev/null
+++ b/auth.js
@@ -0,0 +1,3 @@
+const API_TOKEN = 'sk-live-1234567890abcdef'
+// TODO: rotate
+console.log(API_TOKEN)
`

// A new file of `lines` lines, as `git diff` prints it.
function bigPatch(path: string, lines: number) {
  const body = Array.from({ length: lines }, (_, i) => `+export const value${i} = { id: ${i}, label: 'item number ${i}' }`)
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${body.join('\n')}\n`
}

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const REVIEW_REPLY = JSON.stringify({
  summary: 'Adds div and a parser.',
  risk: 'medium',
  verdict: 'request_changes',
  focus: [{ file: 'new.js', line: 1, why: 'input is never declared' }],
  comments: [
    { file: 'math.js', line: 6, severity: 'risk', title: 'Division by zero', body: 'Guard b === 0.' },
    { file: 'new.js', line: 1, severity: 'bug', title: 'input is undefined', body: 'Declare input.' },
  ],
})

const EXPECT_REPLY = JSON.stringify({
  items: [
    { expectation: 'Add a div helper', verdict: 'done', evidence: 'math.js:5', note: '' },
    { expectation: 'Reject division by zero', verdict: 'missing', evidence: '', note: 'No guard.' },
  ],
  extras: ['Adds new.js'],
})

const PR_JSON = {
  number: 7,
  title: 'Add div',
  body: 'Adds a div helper that rejects zero, for the calculator page.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  author: { login: 'alice' },
  url: 'https://github.com/acme/calc/pull/7',
  isDraft: false,
  baseRefName: 'main',
  headRefName: 'feature/div',
  headRefOid: 'head7',
  baseRefOid: 'base7',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-03T00:00:00Z',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ],
  commits: [{ messageHeadline: 'Add div', messageBody: '' }],
  labels: [],
}

const PR_LIST = [
  { number: 9, title: 'Bump deps', author: { login: 'bob' }, body: '', isDraft: true, additions: 3, deletions: 3, changedFiles: 1, updatedAt: '2026-10-02T00:00:00Z', reviewDecision: '', statusCheckRollup: [], headRefName: 'deps' },
  { number: 7, title: 'Add div', author: { login: 'alice' }, body: PR_JSON.body, isDraft: false, additions: 5, deletions: 0, changedFiles: 2, updatedAt: '2026-10-01T00:00:00Z', reviewDecision: '', statusCheckRollup: PR_JSON.statusCheckRollup, headRefName: 'feature/div' },
]

const pane = (surface: 'terminal' | 'desktop', bodyColumns = 120) => ({
  plugin: 'lazyreview',
  component: 'Pane',
  requestId: 'lazyreview',
  surface,
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'Review',
    isFocused: true,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}) as const

type World = { surfaces?: string[]; isRepo?: boolean; isModelUp?: boolean; canFork?: boolean; asks?: string[]; isHuge?: boolean; extra?: string; hasGh?: boolean }

// A repo with math.js and README.md changed and new.js untracked; `gh` knows PR #7 of acme/calc.
function stubWorld(on, options: World = {}) {
  const { surfaces = ['terminal'], isRepo = true, isModelUp = true, canFork = false, asks = ['Add a div helper that rejects zero'], isHuge = false, extra = '', hasGh = true } = options
  const tracked = (isHuge ? TRACKED + bigPatch('src/big.js', 2500) : TRACKED) + extra
  const models: string[] = []
  const git: string[][] = []
  const ghCalls: { args: string[]; stdin?: string }[] = []
  const saved = new Map<string, unknown>()
  const toasts: string[] = []
  const prompts: string[] = []
  const copies: string[] = []
  const clock = mock.clock(on, { now: Date.parse('2026-10-04T00:00:00Z') })

  on('process.run', ($, e) => {
    const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'gh') {
      const args = e.argv.slice(1)
      ghCalls.push({ args, stdin: e.init?.stdin })
      if (!hasGh) return out('', 1, 'gh: To get started with GitHub CLI, please run:  gh auth login')
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('closingIssuesReferences')) return out(JSON.stringify({ closingIssuesReferences: [{ number: 3 }] }))
      if (args[0] === 'pr' && args[1] === 'view') return out(JSON.stringify(PR_JSON))
      if (args[0] === 'issue') return out(JSON.stringify({ number: 3, title: 'Division', body: 'Dividing by zero must throw.' }))
      if (args[0] === 'pr' && args[1] === 'list') return out(JSON.stringify(args.includes('--search') ? [{ number: 7 }] : PR_LIST))
      if (args[0] === 'repo') return out('acme/calc\n')
      if (args[0] === 'api') return out(JSON.stringify({ html_url: 'https://github.com/acme/calc/pull/7#pullrequestreview-1' }))
      return out('')
    }
    const args = e.argv.filter((a) => a !== '-c' && a !== 'core.quotePath=false').slice(1)
    git.push(args)
    if (!isRepo) return out('', 128, 'fatal')
    if (args.includes('--show-toplevel')) return out('/work\n')
    if (args.includes('--abbrev-ref')) return out('feature\n')
    if (args.includes('--verify')) return out('abc\n')
    if (args[0] === 'cat-file') return out('', git.some((a) => a[0] === 'fetch') ? 0 : 1)
    if (args[0] === 'remote') return out('origin\thttps://github.com/acme/calc.git (fetch)\n')
    if (args[0] === 'merge-base') return out('mb7\n')
    if (args[0] === 'ls-files') return out(isHuge ? 'new.js\0dist/app.min.js\0' : 'new.js\0')
    if (args.includes('--numstat') && args.includes('--no-index')) return out(`9\t0\t\0/dev/null\0${args.at(-1)}\0`)
    if (args.includes('--no-index')) return out(UNTRACKED, 1)
    if (args.includes('--name-only')) return out('math.js\0')
    if (args.includes('--numstat')) return out(isHuge ? '4506\t0\tpackage-lock.json\0' : '')
    if (args[0] === 'diff' && args.at(-1) === 'package-lock.json') return out(bigPatch('package-lock.json', 4506))
    if (args[0] === 'diff' && args.includes('head7')) return out(TRACKED + UNTRACKED)
    if (args[0] === 'diff') return out(tracked)
    return out('')
  })
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: surfaces }))
  const forks: string[] = []
  on('session.messages', () => ({ value: asks.map((text) => ({ role: 'user', text, toolUses: [] })) }))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return { value: canFork ? { isAnswered: true, text: EXPECT_REPLY, usage: USAGE } : { isAnswered: false, reason: 'nothing-to-fork' } }
  })
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: {} }))
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('model.complete', ($, e) => (models.push(e.prompt), {
    value: !isModelUp ? { isAnswered: false, reason: 'api-error', usage: USAGE } : { isAnswered: true, text: e.system.includes('"comments"') ? REVIEW_REPLY : EXPECT_REPLY, usage: USAGE },
  }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  return { git, ghCalls, saved, toasts, prompts, copies, clock, forks, models }
}

// Opens the pane on the Files tab.
async function filesPane($, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = 120) {
  await $.command.run({ command: 'lazyreview', args: '' })
  const ui = await $.ui.mount(pane(surface, bodyColumns))
  await ui.press({ key: 'tab-files' })
  return ui
}

// ── pure helpers ───────────────────────────────────────────────────────────

test('parsePatch reads status, counts and hunks', async () => {
  const files = parsePatch(TRACKED + UNTRACKED)
  expect(files.map((f) => `${f.status} ${f.path} +${f.added} -${f.removed}`)).toEqual([
    'M math.js +4 -0',
    'M README.md +1 -0',
    'A new.js +1 -0',
  ])
  expect(files[0].hunks[0].newStart).toBe(1)
})

test('diffPieces splits a big hunk into valid pieces that keep every line', async () => {
  const [file] = parsePatch(bigPatch('src/big.js', 2000))
  const pieces = diffPieces(file)
  expect(pieces.length > 10).toBe(true)
  expect(pieces[1].source.split('\n')[0]).toMatch(/^@@ -0,0 \+\d+,\d+ @@$/)
  expect(pieces.reduce((n, p) => n + p.source.split('\n').length - 1, 0)).toBe(2000)
  expect(pieces.at(-1).lastLine).toBe(2000)
  for (const page of paginate(pieces)) expect(page.reduce((n, p) => n + p.chars, 0) <= 45000).toBe(true)
})

test('generated files are recognised by name and folder', async () => {
  expect(['package-lock.json', 'web/yarn.lock', 'dist/app.js', 'a.min.js', 'go.sum'].every(isGenerated)).toBe(true)
  expect(['src/lock.js', 'distance.js', 'README.md'].some(isGenerated)).toBe(false)
})

test('parseNumstat reads counts and renames', async () => {
  expect(parseNumstat('3\t1\ta.js\0' + '0\t0\t\0old.js\0new.js\0')).toEqual([
    { added: 3, removed: 1, path: 'a.js' },
    { added: 0, removed: 0, path: 'new.js', oldPath: 'old.js' },
  ])
})

test('reviewBatches covers a huge file in parts and skips generated files', async () => {
  const files = parsePatch(bigPatch('src/big.js', 3000) + bigPatch('package-lock.json', 3000) + UNTRACKED)
  const batches = reviewBatches(files)
  expect(batches.length > 1).toBe(true)
  expect(batches.every((b) => b.length <= 60000)).toBe(true)
  expect(batches.join('\n')).toContain('FILE src/big.js (added) part 1/')
  expect(batches.join('\n')).toContain(' 3000 + ')
  expect(batches.join('\n')).not.toContain('package-lock.json')
})

test('patchFor keeps every file in view when the diff is too big', async () => {
  const text = patchFor(parsePatch(bigPatch('src/big.js', 3000) + UNTRACKED), 20000)
  expect(text.length <= 20000).toBe(true)
  expect(text).toContain('FILE new.js (added)')
  expect(text).toContain('… (rest of this file cut to fit)')
})

test('parseReview drops comments on files that are not in the diff', async () => {
  const text = '```json\n' + JSON.stringify({ summary: 's', comments: [{ file: 'x.js', line: 1, severity: 'bug', title: 't', body: 'b' }] }) + '\n```'
  expect(parseReview(text, ['math.js']).comments).toEqual([])
})

test('mergeReviews keeps the worst risk and verdict of the parts', async () => {
  const part = (risk: string, verdict: string) => ({ summary: risk, risk, verdict, focus: [], comments: [] })
  expect(mergeReviews([part('low', 'approve'), part('high', 'comment')])).toMatchObject({ risk: 'high', verdict: 'comment', summary: 'low high' })
})

test('the merge of a batched review keeps one summary and drops repeated comments', async () => {
  const comment = (id: string) => ({ id, file: 'a.js', line: 1, severity: 'risk', title: id, body: '', by: 'ai' })
  const merged = applyMerge(
    { summary: 'one two', risk: 'low', verdict: 'approve', focus: [], comments: [comment('c0-0'), comment('c1-0')] },
    JSON.stringify({ summary: 'Whole.', risk: 'high', verdict: 'comment', focus: [{ file: 'a.js', line: 1, why: 'here' }, { file: 'x.js', line: 1, why: 'gone' }], duplicates: ['c1-0'] }),
  )
  expect(merged).toMatchObject({ summary: 'Whole.', risk: 'high', verdict: 'comment', focus: [{ file: 'a.js', line: 1, why: 'here' }] })
  expect(merged.comments.map((c) => c.id)).toEqual(['c0-0'])
})

test('userAsks keeps the user prompts only', async () => {
  const asks = userAsks([
    { role: 'user', text: 'Build it', toolUses: [] },
    { role: 'user', text: '<command-name>/clear</command-name>', toolUses: [] },
    { role: 'assistant', text: 'Done', toolUses: [] },
  ])
  expect(asks).toEqual(['Build it'])
})

test('fixPrompt is empty with nothing to fix', async () => {
  expect(fixPrompt({ comments: [], items: [], notes: [] })).toBe('')
})

test('quick checks flag secrets, TODOs and debug output on added lines, and missing tests', async () => {
  const { findings, notes } = scan(parsePatch(SECRET + TRACKED))
  expect(findings.map((f) => `${f.severity} ${f.file}:${f.line} ${f.title}`)).toEqual([
    'bug auth.js:1 Possible hardcoded secret',
    'nit auth.js:3 Debug output left in',
    'nit auth.js:2 TODO added',
  ])
  expect(notes.map((n) => n.text)).toContain('No tests changed for 2 source files')
})

test('the GitHub helpers read PR refs, agents, remotes and checks', async () => {
  expect([prNumberOf('#12'), prNumberOf('12'), prNumberOf('https://github.com/a/b/pull/34/files'), prNumberOf('ai')]).toEqual([12, 12, 34, null])
  expect(agentOf('alice', ['Co-Authored-By: Claude Opus <noreply@anthropic.com>'])).toBe('Claude')
  expect(agentOf('copilot-swe-agent[bot]', [])).toBe('Copilot')
  expect(agentOf('alice', ['plain commit'])).toBe('')
  expect(remoteFor('origin\tgit@github.com:me/calc.git (fetch)\nupstream\thttps://github.com/acme/calc (fetch)\n', 'acme/calc')).toBe('upstream')
  expect(checksOf([{ conclusion: 'FAILURE', name: 'test' }, { status: 'IN_PROGRESS', name: 'e2e' }])).toMatchObject({ failed: 1, pending: 1, failing: ['test'] })
})

test('a review comment off the diff goes into the body, and bugs suggest requesting changes', async () => {
  const files = parsePatch(TRACKED)
  const findings = [
    { file: 'math.js', line: 6, severity: 'bug', title: 'Zero', body: 'Guard it.' },
    { file: 'math.js', line: 40, severity: 'nit', title: 'Far away', body: 'Rename.' },
  ]
  const draft = draftReview({ message: 'Thanks!', findings, notes: [], items: [], extras: ['Adds a CLI'], files })
  expect(draft.inline).toEqual([{ path: 'math.js', line: 6, side: 'RIGHT', body: '**Bug:** Zero. Guard it.' }])
  expect(draft.body).toContain('Thanks!')
  expect(draft.body).toContain('- `math.js:40` nit: Far away. Rename.')
  expect(draft.body).toContain('- Adds a CLI')
  expect(suggestedEvent({ findings, items: [], aiVerdict: '' })).toBe('REQUEST_CHANGES')
  expect(suggestedEvent({ findings: [], items: [], aiVerdict: 'approve' })).toBe('APPROVE')
  expect(suggestedEvent({ findings: [], items: [], aiVerdict: '', isLookedAt: false })).toBe('COMMENT')
})

// ── command ────────────────────────────────────────────────────────────────

test('/lazyreview prints a text report where nothing draws, with .md hidden', async ($, on) => {
  stubWorld(on, { surfaces: [] })
  const out = await $.command.run({ command: 'lazyreview', args: '' })
  expect(out.text).toContain('lazyreview · feature · all changes vs HEAD · 2 files')
  expect(out.text).toContain('M math.js +4 -0')
  expect(out.text).toContain('A new.js +1 -0')
  expect(out.text).not.toContain('README.md')
})

test('/lazyreview ai reports the findings headlessly', async ($, on) => {
  stubWorld(on, { surfaces: [] })
  const out = await $.command.run({ command: 'lazyreview', args: 'ai' })
  expect(out.text).toContain('AI (risk medium): Adds div and a parser.')
  expect(out.text).toContain('[risk] math.js:6 Division by zero')
  expect(out.text).toContain('→ new.js:1 input is never declared')
})

test('/lazyreview staged diffs the index only', async ($, on) => {
  const { git } = stubWorld(on, { surfaces: [] })
  await $.command.run({ command: 'lazyreview', args: 'staged' })
  expect(git.some((a) => a[0] === 'diff' && a.includes('--cached') && !a.includes('--name-only'))).toBe(true)
  expect(git.some((a) => a[0] === 'ls-files')).toBe(false)
})

test('session.start registers /lazyreview and loads saved preferences', async ($, on) => {
  const { saved } = stubWorld(on, { surfaces: [] })
  saved.set('hideMarkdown', false)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.command.run({ command: 'lazyreview', args: '' })
  expect(out.text).toContain('README.md')
})

test('/lazyreview <number> reviews a pull request from its fetched commits', async ($, on) => {
  const { git } = stubWorld(on, { surfaces: [] })
  const out = await $.command.run({ command: 'lazyreview', args: '#7' })
  expect(git).toContainEqual(['fetch', '--no-tags', '--quiet', 'origin', 'pull/7/head', 'main'])
  expect(git.some((a) => a[0] === 'diff' && a.includes('mb7') && a.includes('head7'))).toBe(true)
  expect(out.text).toContain('lazyreview · PR #7 Add div · @alice · Claude · 2 files')
  expect(out.text).toContain('CI failing: test')
})

test('/lazyreview prs lists open pull requests headlessly, yours first', async ($, on) => {
  stubWorld(on, { surfaces: [] })
  const out = await $.command.run({ command: 'lazyreview', args: 'prs' })
  expect(out.text).toContain('● #7 Add div · @alice · Claude · +5 -0')
  expect(out.text.indexOf('#7')).toBeDefined()
  expect(out.text.indexOf('#7') < out.text.indexOf('#9')).toBe(true)
})

test('without gh the pull request list explains what it needs', async ($, on) => {
  stubWorld(on, { surfaces: [], hasGh: false })
  const out = await $.command.run({ command: 'lazyreview', args: 'prs' })
  expect(out.text).toContain('gh auth login')
})

// ── pane ───────────────────────────────────────────────────────────────────

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane opens on the overview (${surface})`, async ($, on) => {
    stubWorld(on, { extra: SECRET })
    await $.command.run({ command: 'lazyreview', args: '' })
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: '◆ lazyreview' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Quick checks' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Possible hardcoded secret' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Where the change is' })).toBeDefined()
    expect(await ui.find({ key: 'overview-ai' })).toBeDefined()
    await ui.unmount()
  })

  test(`the files tab lists files and draws the inline diff (${surface})`, async ($, on) => {
    stubWorld(on)
    const ui = await filesPane($, surface)
    expect(await ui.find({ key: 'file-0' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 \.md hidden/ })).toBeDefined()
    await ui.unmount()
  })

  test(`AI comments land under their hunk (${surface})`, async ($, on) => {
    stubWorld(on)
    const ui = await filesPane($, surface)
    await ui.press({ key: 'key-a' })
    expect(await ui.find({ key: 'comment-c0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▲ 1 risk' })).toBeDefined()
    await ui.press({ key: 'key-j' })
    expect(await ui.find({ key: 'comment-c1' })).toBeDefined()
    await ui.unmount()
  })

  test(`expected vs implemented shows verdicts and extras (${surface})`, async ($, on) => {
    stubWorld(on)
    await $.command.run({ command: 'lazyreview', args: '' })
    const ui = await $.ui.mount(pane(surface))
    await ui.press({ key: 'tab-expect' })
    await ui.press({ key: 'run-expect' })
    expect(await ui.find({ type: 'Text', text: '1/2 implemented' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Reject division by zero' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Adds new.js' })).toBeDefined()
    await ui.unmount()
  })

  test(`a pull request opens on its brief, and the verdict posts to GitHub (${surface})`, async ($, on) => {
    const { ghCalls } = stubWorld(on)
    await $.command.run({ command: 'lazyreview', args: '7' })
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: '#7 Add div' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✦ Claude' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✗ CI 1/2 failing' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'What the author says' })).toBeDefined()
    await ui.press({ key: 'key-a' })
    expect(await ui.find({ type: 'Text', text: 'risk MEDIUM' })).toBeDefined()
    expect(await ui.find({ key: 'focus-0' })).toBeDefined()

    await ui.press({ key: 'tab-verdict' })
    expect(await ui.find({ key: 'verdict-event' })).toMatchObject({ props: { value: 'REQUEST_CHANGES' } })
    await ui.input({ key: 'verdict-message', text: 'Two things before merge.' })
    await ui.press({ key: 'post-review' })
    await ui.press({ key: 'post-confirm' })
    expect(await ui.find({ type: 'Text', text: '✓ Posted "Request changes" on #7' })).toBeDefined()
    const post = ghCalls.find((c) => c.args[0] === 'api')
    expect(post.args).toContain('repos/acme/calc/pulls/7/reviews')
    const payload = JSON.parse(post.stdin)
    expect(payload).toMatchObject({ commit_id: 'head7', event: 'REQUEST_CHANGES' })
    expect(payload.body).toContain('Two things before merge.')
    expect(payload.comments).toContainEqual({ path: 'math.js', line: 6, side: 'RIGHT', body: '**Risk:** Division by zero. Guard b === 0.' })
    await ui.unmount()
  })
}

test('the inbox lists open PRs and opens one', async ($, on) => {
  stubWorld(on)
  await $.command.run({ command: 'lazyreview', args: 'prs' })
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: 'Waiting on your review (1)' })).toBeDefined()
  expect(await ui.find({ key: 'pr-9' })).toBeDefined()
  await ui.press({ key: 'key-o' })
  expect(await ui.find({ type: 'Text', text: '#7 Add div' })).toBeDefined()
  await ui.press({ key: 'key-i' })
  expect(await ui.find({ type: 'Text', text: '◐ in review' })).toBeDefined()
})

test('the PR expectations come from its description and linked issues', async ($, on) => {
  const { models } = stubWorld(on)
  await $.command.run({ command: 'lazyreview', args: '7' })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab-expect' })
  await ui.press({ key: 'run-expect' })
  expect(models[0]).toContain('The pull request description and linked issues')
  expect(models[0]).toContain('Issue #3: Division')
  expect(await ui.find({ type: 'Text', text: '1/2 implemented' })).toBeDefined()
})

test('v marks a file viewed, moves on, and remembers it', async ($, on) => {
  const { saved } = stubWorld(on)
  const ui = await filesPane($)
  await ui.press({ key: 'key-v' })
  expect(await ui.find({ type: 'Text', text: 'new.js' })).toBeDefined()
  expect(await ui.find({ key: 'tab-files' })).toMatchObject({ props: { label: '▸ Files 1/2' } })
  expect(Object.keys(saved.get('viewed:/work#0') as object)).toEqual(['math.js'])
  await ui.press({ key: 'viewed-next' })
  expect(await ui.find({ type: 'Text', text: '2/2' })).toBeDefined()
})

test('a focus entry on the overview jumps to the file', async ($, on) => {
  stubWorld(on)
  await $.command.run({ command: 'lazyreview', args: 'ai' })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'focus-0' })
  expect(await ui.find({ type: 'Text', text: 'new.js' })).toBeDefined()
  expect(await ui.find({ key: 'comment-c1' })).toBeDefined()
})

test('the narrow pane stacks the list over the diff', async ($, on) => {
  stubWorld(on)
  const ui = await filesPane($, 'terminal', 70)
  expect(await ui.find({ key: 'file-1' })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeDefined()
})

test('m shows markdown files and saves the choice', async ($, on) => {
  const { saved } = stubWorld(on)
  const ui = await filesPane($)
  await ui.press({ key: 'key-m' })
  expect(await ui.find({ key: 'file-2' })).toBeDefined()
  expect(saved.get('hideMarkdown')).toBe(false)
})

test('s stages the selected file, or unstages a staged one', async ($, on) => {
  const { git } = stubWorld(on)
  const ui = await filesPane($)
  await ui.press({ key: 'key-s' })
  expect(git).toContainEqual(['restore', '--staged', '--', 'math.js'])
  await ui.press({ key: 'key-j' })
  await ui.press({ key: 'key-s' })
  expect(git).toContainEqual(['add', '--', 'new.js'])
})

test('notes, line notes and the AI findings go to Claude with f', async ($, on) => {
  const { prompts } = stubWorld(on)
  const ui = await filesPane($)
  await ui.input({ key: 'note', text: 'rename div to divide' })
  await ui.input({ key: 'note', text: 'L6: guard zero' })
  expect(await ui.find({ type: 'Text', text: 'rename div to divide' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✎ you · L6' })).toBeDefined()
  await ui.press({ key: 'key-a' })
  await ui.press({ key: 'key-f' })
  expect(prompts[0]).toContain('[risk] math.js:6 Division by zero')
  expect(prompts[0]).toContain('[reviewer] math.js: rename div to divide')
  expect(prompts[0]).toContain('[reviewer] math.js:6: guard zero')
})

test('the verdict tab previews the hand-back and copies it', async ($, on) => {
  const { copies } = stubWorld(on)
  const ui = await filesPane($)
  await ui.press({ key: 'key-a' })
  await ui.press({ key: 'tab-verdict' })
  expect(await ui.find({ type: 'Text', text: 'What Claude will get' })).toBeDefined()
  await ui.press({ key: 'copy-review' })
  expect(copies[0]).toContain('Division by zero')
})

test('f with nothing to fix says so', async ($, on) => {
  const { toasts, prompts } = stubWorld(on)
  const ui = await filesPane($)
  await ui.press({ key: 'key-f' })
  expect(prompts).toEqual([])
  expect(toasts[0]).toContain('nothing to fix yet')
})

test('an added expectation is saved and drawn', async ($, on) => {
  const { saved } = stubWorld(on)
  await $.command.run({ command: 'lazyreview', args: '' })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab-expect' })
  await ui.input({ key: 'expect-input', text: 'rejects zero' })
  expect(saved.get('expectations')).toEqual(['rejects zero'])
  await ui.press({ key: 'own-remove-0' })
  expect(saved.get('expectations')).toEqual([])
})

test('a failed model call shows the reason', async ($, on) => {
  stubWorld(on, { isModelUp: false })
  const ui = await filesPane($)
  await ui.press({ key: 'key-a' })
  expect(await ui.find({ type: 'Text', text: /^AI review failed: api-error/ })).toBeDefined()
})

test('outside a git repo the pane says so', async ($, on) => {
  stubWorld(on, { isRepo: false })
  await $.command.run({ command: 'lazyreview', args: '' })
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /^Not inside a git repository/ })).toBeDefined()
})

// ── band ───────────────────────────────────────────────────────────────────

const bandSite = {
  plugin: 'lazyreview',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('after a turn that edited files the band offers a review and counts red flags', async ($, on) => {
  const { clock } = stubWorld(on, { extra: SECRET })
  await $.tool.call({ tool: 'Edit', file_path: '/work/math.js', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, usage: null })
  await clock.advance(300)
  await clock.settle()
  const band = await $.ui.mount(bandSite)
  expect(await band.find({ type: 'Text', text: '3 changed files' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '⚑ 1 red flag' })).toBeDefined()
  await band.press({ key: 'band-dismiss' })
  expect(await band.find({ type: 'Text', text: '3 changed files' })).toBeUndefined()
})

test('the band stays empty when no file was edited', async ($, on) => {
  const { clock } = stubWorld(on)
  await $.tool.call({ tool: 'Read', file_path: '/work/math.js' })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, usage: null })
  await clock.advance(300)
  const band = await $.ui.mount(bandSite)
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
})

test('w reads the whole file, and markdown renders as Markdown', async ($, on) => {
  stubWorld(on)
  on('fs.read', ($, e) => ({ value: e.path.endsWith('README.md') ? '# Notes\nmore\n' : 'export function add(a, b) {}\n' }))
  const ui = await filesPane($)
  await ui.press({ key: 'key-w' })
  expect(await ui.find({ key: 'piece-0' })).toBeDefined()
  await ui.press({ key: 'key-m' })
  await ui.press({ key: 'file-2' })
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await ui.press({ key: 'key-w' })
  expect(await ui.find({ key: 'hunk-0' })).toBeDefined()
})

test('the expectations check asks a fork of the session first', async ($, on) => {
  const { forks } = stubWorld(on, { canFork: true })
  await $.command.run({ command: 'lazyreview', args: '' })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab-expect' })
  await ui.input({ key: 'expect-input', text: 'rejects zero' })
  await ui.press({ key: 'run-expect' })
  expect(forks[0]).toContain('- rejects zero')
  expect(await ui.find({ type: 'Text', text: '1/2 implemented' })).toBeDefined()
})

test('with no requests anywhere the check explains instead of failing', async ($, on) => {
  stubWorld(on, { asks: [] })
  await $.command.run({ command: 'lazyreview', args: '' })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab-expect' })
  await ui.press({ key: 'run-expect' })
  expect(await ui.find({ type: 'Text', text: /^Nothing to check yet/ })).toBeDefined()
})

test('a dismissed finding collapses and is not sent to Claude', async ($, on) => {
  const { prompts } = stubWorld(on)
  const ui = await filesPane($)
  await ui.press({ key: 'key-a' })
  await ui.press({ key: 'dismiss-c0' })
  expect(await ui.find({ key: 'dismiss-c0' })).toMatchObject({ props: { label: 'restore' } })
  await ui.press({ key: 'key-f' })
  expect(prompts[0]).not.toContain('Division by zero')
  expect(prompts[0]).toContain('input is undefined')
})

test('c walks the open findings across files', async ($, on) => {
  stubWorld(on)
  const ui = await filesPane($)
  await ui.press({ key: 'key-a' })
  await ui.press({ key: 'key-c' })
  expect(await ui.find({ key: 'comment-c0' })).toBeDefined()
  await ui.press({ key: 'key-c' })
  expect(await ui.find({ key: 'comment-c1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'new.js' })).toBeDefined()
})

test('the file badge takes the colour of its worst finding', async ($, on) => {
  stubWorld(on)
  const ui = await filesPane($)
  await ui.press({ key: 'key-a' })
  expect(await ui.find({ type: 'Text', text: '▲1' })).toMatchObject({ props: { color: 'yellow' } })
  expect(await ui.find({ type: 'Text', text: '●1' })).toMatchObject({ props: { color: 'red' } })
})

test('d dismisses the current finding and moves to the next', async ($, on) => {
  stubWorld(on)
  const ui = await filesPane($)
  await ui.press({ key: 'key-a' })
  expect(await ui.find({ key: 'key-d' })).toBeUndefined()
  await ui.press({ key: 'key-c' })
  await ui.press({ key: 'key-d' })
  expect(await ui.find({ key: 'comment-c1' })).toBeDefined()
  await ui.press({ key: 'key-d' })
  expect(await ui.find({ key: 'key-c' })).toBeUndefined()
})

// ── huge changes ───────────────────────────────────────────────────────────

const sizeOf = async (ui) => JSON.stringify(await ui.find({ type: 'Box' })).length

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a 2,500-line file is drawn a page at a time under the size bound (${surface})`, async ($, on) => {
    stubWorld(on, { isHuge: true })
    const ui = await filesPane($, surface)
    await ui.press({ key: 'file-4' })
    expect(await ui.find({ type: 'Text', text: 'src/big.js' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^page 1\/\d+$/ })).toBeDefined()
    const size = await sizeOf(ui)
    expect(size < 100000 && size > 40000).toBe(true)
    await ui.press({ key: 'page-next' })
    expect(await ui.find({ type: 'Text', text: /^page 2\// })).toBeDefined()
    await ui.press({ key: 'page-prev' })
    expect(await ui.find({ type: 'Text', text: /^page 1\// })).toBeDefined()
    await ui.unmount()
  })
}

test('the whole-file reader pages a big file too', async ($, on) => {
  stubWorld(on, { isHuge: true })
  const big = Array.from({ length: 2500 }, (_, i) => `export const value${i} = { id: ${i}, label: 'item number ${i}' }`).join('\n')
  on('fs.read', () => ({ value: big }))
  const ui = await filesPane($)
  await ui.press({ key: 'file-4' })
  await ui.press({ key: 'key-w' })
  expect(await ui.find({ type: 'Text', text: /^page 1\// })).toBeDefined()
  expect((await sizeOf(ui)) < 100000).toBe(true)
})

test('a lock file is listed but its diff waits until asked for', async ($, on) => {
  stubWorld(on, { isHuge: true })
  const ui = await filesPane($)
  await ui.press({ key: 'file-3' })
  expect(await ui.find({ type: 'Text', text: '⚙ Generated file' })).toBeDefined()
  await ui.press({ key: 'show-generated' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect((await sizeOf(ui)) < 100000).toBe(true)
})

test('the AI review of a huge diff runs in parts and says what it skipped', async ($, on) => {
  const { models } = stubWorld(on, { isHuge: true })
  await $.command.run({ command: 'lazyreview', args: '' })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'key-a' })
  expect(models.length > 1).toBe(true)
  expect(models.some((p) => p.includes('package-lock.json'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: '⚠ 2 generated files not reviewed' })).toBeDefined()
})

test('an untracked generated file is listed as added, not renamed', async ($, on) => {
  stubWorld(on, { isHuge: true, surfaces: [] })
  const out = await $.command.run({ command: 'lazyreview', args: '' })
  expect(out.text).toContain('A dist/app.min.js +9 -0 (generated)')
})
