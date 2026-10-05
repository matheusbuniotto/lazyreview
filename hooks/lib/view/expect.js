// The Expected tab: each ask (from the session, or the PR's description and issues)
// against the diff, plus what changed that nobody asked for.

import { VERDICT, meter, seconds, spinner } from './common.js'

export function expectTab(el, model, act) {
  const { Box, Text, Button, Input } = el
  const { expect, now } = model
  const from = model.pr ? `the description of PR #${model.pr.number} and its linked issues` : 'what you asked for in this session'
  const rows = []

  if (expect.status === 'busy') {
    rows.push(Text({ color: 'magenta', children: `${spinner(now)} Comparing ${from} with the diff… ${seconds(expect.startedAt, now)}` }))
  } else if (expect.status === 'error') {
    rows.push(Text({ color: 'red', wrap: 'wrap', children: `Check failed: ${expect.error}` }))
  } else if (expect.status === 'empty') {
    const why = model.pr ? 'the PR has no description.' : 'no requests in this session.'
    rows.push(Text({ dimColor: true, wrap: 'wrap', children: `Nothing to check yet: ${why} Add an expectation below and press e.` }))
  } else if (!expect.items.length) {
    rows.push(Text({ wrap: 'wrap', children: `Reads ${from} (plus anything you add below), then checks each expectation against the diff and lists changes nobody asked for.` }))
    rows.push(Box({ marginTop: 1, children: [Button({ key: 'run-expect', label: 'Run the check', hotkey: 'e', variant: 'primary', onPress: act.runExpect })] }))
  }

  if (expect.items.length) {
    rows.push(progress(el, expect.items, model.columns))
    rows.push(...expect.items.map((item, i) => expectRow(el, item, i)))
  }
  if (expect.extras.length) {
    rows.push(Text({ key: 'extras-title', bold: true, color: 'yellow', children: 'Not asked for' }))
    rows.push(...expect.extras.map((x, i) => Box({ key: 'extra-' + i, flexDirection: 'row', columnGap: 1, paddingLeft: 2, children: [Text({ color: 'yellow', children: '•' }), Text({ wrap: 'wrap', children: x })] })))
  }

  rows.push(
    Box({
      key: 'own',
      flexDirection: 'column',
      marginTop: 1,
      children: [
        Text({ bold: true, children: 'Your expectations' }),
        ...model.extraExpectations.map((text, i) =>
          Box({
            key: 'own-' + i,
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Button({ key: 'own-remove-' + i, label: '✕', plain: true, dimColor: true, onPress: () => act.removeExpectation(i) }),
              Text({ wrap: 'wrap', children: text }),
            ],
          }),
        ),
        Input({
          key: 'expect-input',
          label: '+ Expect',
          placeholder: 'something the change must do, e.g. "rejects empty emails"',
          value: '',
          submitLabel: 'add',
          onSubmit: act.addExpectation,
        }),
      ],
    }),
  )
  return Box({ flexDirection: 'column', children: rows })
}

function progress(el, items, columns) {
  const { Box, Text } = el
  const done = items.filter((i) => i.verdict === 'done').length
  const partial = items.filter((i) => i.verdict === 'partial').length
  const width = Math.max(10, Math.min(30, columns - 40))
  return Box({
    key: 'progress',
    flexDirection: 'row',
    columnGap: 1,
    marginBottom: 1,
    children: [
      meter(el, [{ n: done, color: 'green' }, { n: partial, color: 'yellow' }], items.length, width),
      Text({ bold: true, children: `${done}/${items.length} implemented` }),
    ],
  })
}

function expectRow(el, item, i) {
  const { Box, Text } = el
  const v = VERDICT[item.verdict]
  const detail = [item.evidence, item.note].filter(Boolean).join(' · ')
  return Box({
    key: 'expect-' + i,
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ color: v.color, bold: true, children: v.glyph }),
          Text({ wrap: 'wrap', bold: item.verdict !== 'done', children: item.expectation }),
        ],
      }),
      ...(detail ? [Box({ paddingLeft: 2, children: [Text({ dimColor: true, wrap: 'wrap', children: `${v.word} · ${detail}` })] })] : []),
    ],
  })
}
