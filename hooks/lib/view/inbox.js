// The pull request picker: open PRs, the ones waiting on your review first.

import { count, fitEnd, spinner } from './common.js'

const TITLE_ROOM = 44

export function inboxView(el, model, act) {
  const { Box, Text, Button } = el
  const { inbox } = model
  const key = (hotkey, label, onPress) => Button({ key: 'key-' + hotkey, label, hotkey, plain: true, onPress })

  const toolbar = Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 2,
    marginBottom: model.isInline ? 0 : 1,
    children: [
      key('j', 'down', () => act.inboxMove(1)),
      key('k', 'up', () => act.inboxMove(-1)),
      key('o', 'open', act.inboxOpen),
      key('i', model.hasReview ? 'back to the review' : 'working tree', act.closeInbox),
      key('r', 'refresh', act.refreshInbox),
      key('q', 'close', act.close),
    ],
  })

  const heading = Text({ bold: true, children: `Pull requests${inbox.repo ? ` · ${inbox.repo}` : ''}` })
  if (inbox.status === 'loading' && !inbox.rows.length) return [heading, toolbar, Text({ color: 'magenta', children: `${spinner(model.now)} Asking GitHub…` })]
  if (inbox.status === 'error') return [heading, toolbar, Text({ color: 'red', wrap: 'wrap', children: inbox.error })]
  if (!inbox.rows.length) return [heading, toolbar, Text({ dimColor: true, children: 'No open pull requests.' })]

  const titleWidth = Math.max(20, Math.min(TITLE_ROOM, model.columns - 56))
  const row = (pr, i) =>
    Box({
      key: 'pr-row-' + pr.number,
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ color: 'cyan', bold: true, children: i === inbox.selected ? '▸' : ' ' }),
        Box({
          width: titleWidth + 7,
          flexShrink: 0,
          children: [Button({ key: 'pr-' + pr.number, label: fitEnd(`#${pr.number} ${pr.title}`, titleWidth + 7), plain: true, dimColor: pr.isDraft, onPress: () => act.openPr(pr.number) })],
        }),
        Text({ color: 'cyan', children: `@${pr.author}` }),
        ...(pr.agent ? [Text({ color: 'magenta', children: `✦ ${pr.agent}` })] : []),
        Text({ color: 'green', children: `+${count(pr.added)}` }),
        Text({ color: 'red', children: `−${count(pr.removed)}` }),
        checksBadge(el, pr.checks),
        Text({ dimColor: true, children: pr.age }),
        ...(pr.isDraft ? [Text({ dimColor: true, children: 'draft' })] : []),
        ...(pr.decision === 'APPROVED' ? [Text({ color: 'green', children: 'approved' })] : []),
        ...(model.started.has(pr.number) ? [Text({ color: 'yellow', children: '◐ in review' })] : []),
      ],
    })

  const waiting = inbox.rows.filter((pr) => pr.isWaiting)
  const others = inbox.rows.filter((pr) => !pr.isWaiting)
  const indexOf = (pr) => inbox.rows.indexOf(pr)
  return [
    heading,
    toolbar,
    ...(waiting.length ? [Text({ key: 'waiting', bold: true, color: 'yellow', children: `Waiting on your review (${waiting.length})` }), ...waiting.map((pr) => row(pr, indexOf(pr)))] : []),
    ...(others.length
      ? [
          Box({ key: 'others', marginTop: waiting.length ? 1 : 0, children: [Text({ bold: true, dimColor: true, children: `Other open pull requests (${others.length})` })] }),
          ...others.map((pr) => row(pr, indexOf(pr))),
        ]
      : []),
  ]
}

function checksBadge(el, checks) {
  const { Text } = el
  if (!checks.total) return Text({ dimColor: true, children: '·' })
  if (checks.failed) return Text({ color: 'red', children: '✗ CI' })
  if (checks.pending) return Text({ color: 'yellow', children: '◌ CI' })
  return Text({ color: 'green', children: '✓ CI' })
}
