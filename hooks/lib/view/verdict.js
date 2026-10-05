// The Verdict tab: for a pull request, the review to post on GitHub; for local
// changes, what goes back to Claude. Either can be copied as Markdown.

import { EVENTS } from '../github.js'
import { plural, spinner } from './common.js'

const PREVIEW_CHARS = 6000
const EVENT_COLORS = { REQUEST_CHANGES: 'red', COMMENT: 'yellow', APPROVE: 'green' }

export function verdictTab(el, model, act) {
  return model.pr ? postReview(el, model, act) : handBack(el, model, act)
}

function preview(el, title, text) {
  const { Box, Text, Markdown } = el
  const cut = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n\n…` : text
  return Box({
    key: 'preview',
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'gray',
    paddingX: 1,
    children: [Text({ dimColor: true, children: title }), cut ? Markdown({ key: 'preview-md', text: cut }) : Text({ dimColor: true, italic: true, children: '(empty)' })],
  })
}

function postReview(el, model, act) {
  const { Box, Text, Button, Input, Select, Link } = el
  const { verdict, draft, pr } = model
  const options = Object.entries(EVENTS).map(([value, label]) => ({ value, label: value === verdict.suggested ? `${label} (suggested)` : label }))
  const inBody = model.remarkCount - draft.inline.length

  const action = {
    idle: () => [
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Button({ key: 'post-review', label: 'Post to GitHub…', variant: 'primary', onPress: act.askToPost }),
          Button({ key: 'copy-review', label: 'Copy as Markdown', variant: 'secondary', onPress: act.copy }),
        ],
      }),
    ],
    confirm: () => [
      Text({ bold: true, color: EVENT_COLORS[verdict.event], wrap: 'wrap', children: `Post "${EVENTS[verdict.event]}" on #${pr.number} with ${plural(draft.inline.length, 'inline comment')}?` }),
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Button({ key: 'post-confirm', label: 'Yes, post it', variant: 'primary', onPress: act.post }),
          Button({ key: 'post-cancel', label: 'Cancel', variant: 'secondary', onPress: act.cancelPost }),
        ],
      }),
    ],
    posting: () => [Text({ color: 'magenta', children: `${spinner(model.now)} Posting to GitHub…` })],
    posted: () => [
      Text({ color: 'green', bold: true, children: `✓ Posted "${EVENTS[verdict.event]}" on #${pr.number}` }),
      Link({ href: verdict.url || pr.url, label: verdict.url || pr.url }),
    ],
    error: () => [
      Text({ color: 'red', wrap: 'wrap', children: `GitHub refused it: ${verdict.error}` }),
      Button({ key: 'post-review', label: 'Try again…', variant: 'secondary', onPress: act.askToPost }),
    ],
  }[verdict.status]()

  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      Box({
        flexDirection: 'column',
        children: [
          Text({ bold: true, children: `Your review of #${pr.number} by @${pr.author}` }),
          Text({ dimColor: true, wrap: 'wrap', children: 'Open findings and your notes become comments. Dismiss what you do not want to send in the Files tab.' }),
        ],
      }),
      Select({ key: 'verdict-event', label: 'Verdict', options, value: verdict.event, onSelect: act.chooseEvent }),
      Input({
        key: 'verdict-message',
        label: 'Message',
        placeholder: 'a line for the author, e.g. "Nice work. Two things before merge."',
        value: verdict.message,
        submitLabel: 'set',
        onSubmit: act.setMessage,
      }),
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({ children: `${plural(draft.inline.length, 'inline comment')}` }),
          ...(inBody ? [Text({ dimColor: true, children: `${inBody} in the summary (not on a diff line)` })] : []),
          ...(model.unviewed ? [Text({ color: 'yellow', children: `⚠ ${plural(model.unviewed, 'file')} not viewed yet` })] : []),
        ],
      }),
      preview(el, 'Summary as it will appear', draft.body),
      Box({ flexDirection: 'column', children: action }),
    ],
  })
}

function handBack(el, model, act) {
  const { Box, Text, Button } = el
  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      Box({
        flexDirection: 'column',
        children: [
          Text({ bold: true, children: 'Hand the review back to Claude' }),
          Text({ dimColor: true, wrap: 'wrap', children: 'Open findings, unmet expectations and your notes, as one prompt. Dismiss what should stay as is in the Files tab.' }),
        ],
      }),
      ...(model.unviewed ? [Text({ color: 'yellow', children: `⚠ ${plural(model.unviewed, 'file')} not viewed yet` })] : []),
      preview(el, 'What Claude will get', model.fixText),
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Button({ key: 'send-fix', label: 'Send to Claude', variant: 'primary', onPress: act.fix }),
          Button({ key: 'copy-review', label: 'Copy as Markdown', variant: 'secondary', onPress: act.copy }),
        ],
      }),
    ],
  })
}
