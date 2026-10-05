// Builds the pane's element tree from a snapshot of the review. No mods API in here:
// `el` is what `$.ui.resolve(e)` returned and `act` holds the callbacks.

import { LEVEL, count, meter, plural, seconds, severityCounts, spinner } from './common.js'
import { expectTab } from './expect.js'
import { filesTab } from './files.js'
import { inboxView } from './inbox.js'
import { overviewTab } from './overview.js'
import { verdictTab } from './verdict.js'

const TABS = [
  ['overview', 'Overview', '1'],
  ['files', 'Files', '2'],
  ['expect', 'Expected', '3'],
  ['verdict', 'Verdict', '4'],
]

export function drawPane(el, model, act) {
  const { Box } = el
  if (model.view === 'inbox') return Box({ flexDirection: 'column', children: [titleRow(el, model), ...inboxView(el, model, act)] })

  const body = {
    overview: () => overviewTab(el, model, act),
    files: () => filesTab(el, model, act),
    expect: () => expectTab(el, model, act),
    verdict: () => verdictTab(el, model, act),
  }[model.tab]()
  return Box({ flexDirection: 'column', children: [header(el, model, act), toolbar(el, model, act), body] })
}

// ── Header ─────────────────────────────────────────────────────────────────

function titleRow(el, model) {
  const { Box, Text } = el
  const { added, removed } = model.totals
  const what = model.view === 'inbox'
    ? []
    : model.pr
    ? [Text({ key: 'pr', bold: true, wrap: 'truncate-end', children: `#${model.pr.number} ${model.pr.title}` })]
    : [Text({ key: 'branch', color: 'cyan', children: `⎇ ${model.branch || '?'}` }), Text({ key: 'mode', dimColor: true, children: `· ${model.modeLabel}` })]
  return Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    columnGap: 2,
    children: [
      Box({
        flexDirection: 'row',
        columnGap: 1,
        flexShrink: 1,
        children: [Box({ flexShrink: 0, children: [Text({ bold: true, color: 'magenta', children: '◆ lazyreview' })] }), ...what],
      }),
      Box({
        flexDirection: 'row',
        columnGap: 1,
        flexShrink: 0,
        children: model.view === 'inbox'
          ? []
          : [
              Text({ dimColor: true, children: plural(model.files.length, 'file') }),
              Text({ color: 'green', children: `+${count(added)}` }),
              Text({ color: 'red', children: `−${count(removed)}` }),
            ],
      }),
    ],
  })
}

// Who, where from, and what GitHub says about it.
function prRow(el, pr, age) {
  const { Box, Text } = el
  const { checks } = pr
  const ci = !checks.total
    ? Text({ key: 'ci', dimColor: true, children: 'no CI' })
    : checks.failed
      ? Text({ key: 'ci', color: 'red', children: `✗ CI ${checks.failed}/${checks.total} failing` })
      : checks.pending
        ? Text({ key: 'ci', color: 'yellow', children: `◌ CI ${checks.pending} running` })
        : Text({ key: 'ci', color: 'green', children: `✓ CI ${checks.passed}/${checks.total}` })
  const facts = [
    Text({ key: 'author', color: 'cyan', children: `@${pr.author}` }),
    Text({ key: 'refs', dimColor: true, children: `${pr.head} → ${pr.base}` }),
    ...(pr.agent ? [Text({ key: 'agent', color: 'magenta', children: `✦ ${pr.agent}` })] : []),
    ci,
    ...(pr.isDraft ? [Text({ key: 'draft', color: 'gray', children: 'draft' })] : []),
    ...(pr.decision === 'APPROVED' ? [Text({ key: 'decision', color: 'green', children: 'approved' })] : []),
    ...(pr.decision === 'CHANGES_REQUESTED' ? [Text({ key: 'decision', color: 'red', children: 'changes requested' })] : []),
    Text({ key: 'age', dimColor: true, children: `${plural(pr.commitCount, 'commit')} · updated ${age} ago` }),
  ]
  return Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: facts })
}

// How far the review has come: files viewed, findings open, asks met.
function progressRow(el, model) {
  const { Box, Text } = el
  const total = model.files.length
  const seen = model.viewedCount
  const items = model.expect.items
  const done = items.filter((i) => i.verdict === 'done').length
  const counts = severityCounts(el, model.openFindings)
  return Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 2,
    children: [
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ dimColor: true, children: 'viewed' }),
          meter(el, [{ n: seen, color: seen === total ? 'green' : 'cyan' }], total, 12),
          Text({ bold: seen === total, color: seen === total ? 'green' : undefined, children: `${seen}/${total}` }),
        ],
      }),
      ...(counts.length ? [Box({ flexDirection: 'row', columnGap: 1, children: counts })] : []),
      ...(items.length ? [Text({ color: done === items.length ? 'green' : 'yellow', children: `asks ${done}/${items.length}` })] : []),
    ],
  })
}

// The AI pass in one line, on the tabs without the Overview's full card.
function aiLine(el, model) {
  const { Text } = el
  const { review, now } = model
  if (review.status === 'busy') {
    const parts = review.parts > 1 ? ` in ${review.parts} parts · ${review.partsDone}/${review.parts} done` : ''
    return [Text({ key: 'ai-line', color: 'magenta', children: `${spinner(now)} AI is reviewing ${plural(review.fileCount, 'file')}${parts}… ${seconds(review.startedAt, now)}` })]
  }
  if (review.status === 'error') return [Text({ key: 'ai-line', color: 'red', wrap: 'wrap', children: `AI review failed: ${review.error}` })]
  if (review.status === 'done' && review.isStale) return [Text({ key: 'ai-line', color: 'yellow', italic: true, children: 'the diff changed since the AI review · a to re-run' })]
  return []
}

function header(el, model, act) {
  const { Box, Text, Button } = el
  const done = model.expect.items.filter((i) => i.verdict === 'done').length
  const badge = {
    files: model.files.length ? ` ${model.viewedCount}/${model.files.length}` : '',
    expect: model.expect.items.length ? ` ${done}/${model.expect.items.length}` : '',
    verdict: model.verdict.status === 'posted' ? ' ✓' : '',
    overview: model.flags ? ` ${model.flags}⚑` : '',
  }
  const tabs = TABS.map(([name, label, hotkey]) =>
    Button({
      key: 'tab-' + name,
      label: `${model.tab === name ? '▸ ' : ''}${label}${badge[name]}`,
      hotkey,
      plain: true,
      dimColor: model.tab !== name,
      onPress: () => act.showTab(name),
    }),
  )
  return Box({
    flexDirection: 'column',
    children: [
      titleRow(el, model),
      ...(model.pr ? [prRow(el, model.pr, model.prAge)] : []),
      ...(model.files.length ? [progressRow(el, model)] : []),
      ...(model.tab === 'overview' ? [] : aiLine(el, model)),
      ...model.diffWarnings.map((warning, i) => Text({ key: 'warning-' + i, color: LEVEL.warn.color, wrap: 'wrap', children: `⚠ ${warning}` })),
      Box({ flexDirection: 'row', columnGap: 3, marginTop: model.isInline ? 0 : 1, children: tabs }),
    ],
  })
}

// ── Toolbar ────────────────────────────────────────────────────────────────

function toolbar(el, model, act) {
  const { Box, Button } = el
  const key = (hotkey, label, onPress, isDim = false) =>
    Button({ key: 'key-' + hotkey, label, hotkey, plain: true, dimColor: isDim, onPress })
  const file = model.files[model.selected]
  const isLocal = !model.pr
  const isBusy = model.review.status === 'busy' || model.expect.status === 'busy'
  const isDiff = model.reader === 'diff'

  const byTab = {
    overview: [],
    files: [
      key('v', file && model.viewed.has(file.path) ? 'unmark viewed' : 'viewed ✓', act.toggleViewed, !file),
      ...(model.openFindings.length ? [key('c', 'next finding', act.nextFinding)] : []),
      ...(model.currentFinding ? [key('d', 'dismiss', act.dismissCurrent)] : []),
      key('j', 'file↓', () => act.move(1)),
      key('k', 'file↑', () => act.move(-1)),
      key('n', 'hunk↓', () => act.hunk(1), !isDiff),
      key('p', 'hunk↑', () => act.hunk(-1), !isDiff),
      key('w', isDiff ? 'whole file' : 'diff', act.toggleReader, !file),
      ...(isLocal ? [key('s', file && model.staged.has(file.path) ? 'unstage' : 'stage', act.toggleStage, !file)] : []),
      key('m', model.hideMarkdown ? 'show .md' : 'hide .md', act.toggleMarkdown),
      ...(isLocal ? [key('b', 'base', act.cycleMode)] : []),
    ],
    expect: [key('e', model.expect.items.length ? 'check again' : 'check', act.runExpect, isBusy)],
    verdict: [key('y', 'copy', act.copy)],
  }
  const shared = [
    key('a', model.review.status === 'done' ? 'AI re-review' : 'AI review', act.runReview, isBusy),
    ...(isBusy ? [key('x', 'cancel AI', act.cancelAi)] : []),
    ...(isLocal ? [key('f', 'fix with Claude', act.fix, !model.canFix)] : []),
    key('i', 'pull requests', act.openInbox),
    key('r', 'refresh', act.refresh),
    key('q', 'close', act.close),
  ]
  return Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 2,
    marginBottom: model.isInline ? 0 : 1,
    children: [...byTab[model.tab], ...shared],
  })
}

// ── Band above the prompt ──────────────────────────────────────────────────

export function drawBand(el, band, act) {
  const { Box, Text, Button } = el
  return Box({
    flexDirection: 'row',
    columnGap: 2,
    paddingX: 1,
    children: [
      Text({ bold: true, color: 'magenta', children: '◆ lazyreview' }),
      Text({ children: `${plural(band.fileCount, 'changed file')}` }),
      Text({ color: 'green', children: `+${count(band.added)}` }),
      Text({ color: 'red', children: `−${count(band.removed)}` }),
      ...(band.flags ? [Text({ color: 'red', children: `⚑ ${plural(band.flags, 'red flag')}` })] : []),
      Button({ key: 'band-open', label: 'Review', variant: 'primary', onPress: act.open }),
      Button({ key: 'band-dismiss', label: 'Dismiss', plain: true, dimColor: true, onPress: act.dismiss }),
    ],
  })
}
