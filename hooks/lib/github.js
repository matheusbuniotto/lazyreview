// Pull requests through the `gh` CLI: parsing its JSON, and the review a lead posts.
// No mods API in here.

import { clean, newSideLines } from './diff.js'

export const PR_FIELDS = [
  'number', 'title', 'body', 'author', 'url', 'isDraft', 'baseRefName', 'headRefName', 'headRefOid',
  'baseRefOid', 'createdAt', 'updatedAt', 'reviewDecision', 'statusCheckRollup', 'commits', 'labels',
].join(',')

export const INBOX_FIELDS = [
  'number', 'title', 'body', 'author', 'isDraft', 'additions', 'deletions', 'changedFiles',
  'updatedAt', 'reviewDecision', 'statusCheckRollup', 'headRefName',
].join(',')

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const AGENTS = [
  ['Claude', /claude|anthropic/i],
  ['Copilot', /copilot/i],
  ['Cursor', /cursor/i],
  ['Codex', /codex|openai/i],
  ['Devin', /devin/i],
  ['Gemini', /gemini|jules/i],
]

// "123", "#123" or a pull request URL, as a number; null for anything else.
export function prNumberOf(text) {
  const match = String(text).trim().match(/^#?(\d+)$|\/pull\/(\d+)/)
  return match ? Number(match[1] ?? match[2]) : null
}

export const repoOfUrl = (url) => String(url).match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? ''

// The git remote that points at `owner/repo`, from `git remote -v`; origin when none does.
export function remoteFor(remotes, repo) {
  const slugOf = (url) => url.replace(/\.git$/, '').split(/[:/]/).slice(-2).join('/').toLowerCase()
  const match = remotes
    .split('\n')
    .map((line) => line.split(/\s+/))
    .find(([, url]) => url && slugOf(url) === repo.toLowerCase())
  return match?.[0] || 'origin'
}

export function checksOf(rollup = []) {
  const checks = { passed: 0, failed: 0, pending: 0, total: rollup.length, failing: [] }
  for (const run of rollup) {
    const result = run.conclusion || run.state || ''
    if (PASSED.has(result)) checks.passed++
    else if (FAILED.has(result)) {
      checks.failed++
      checks.failing.push(run.name || run.context || 'check')
    } else checks.pending++
  }
  return checks
}

// Which coding agent wrote the change, from bot logins, co-author trailers and "Generated with" lines.
export function agentOf(login, texts) {
  const signs = [
    ...(String(login).endsWith('[bot]') ? [login] : []),
    ...texts.flatMap((text) => [...String(text).matchAll(/co-authored-by:\s*([^<\n]+)|generated (?:with|by) \[?([^\]\n(]+)/gi)].map((m) => m[1] ?? m[2])),
  ]
  return AGENTS.find(([, pattern]) => signs.some((sign) => pattern.test(sign)))?.[0] ?? ''
}

// A PR body without the template's HTML comments and the blank lines they leave.
const withoutTemplate = (body) =>
  clean(String(body ?? '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export function parsePr(json) {
  const login = json.author?.login ?? 'unknown'
  const commits = json.commits ?? []
  return {
    number: json.number,
    title: clean(json.title),
    body: withoutTemplate(json.body),
    author: login,
    url: json.url,
    repo: repoOfUrl(json.url),
    isDraft: Boolean(json.isDraft),
    base: json.baseRefName,
    head: json.headRefName,
    headSha: json.headRefOid,
    baseSha: json.baseRefOid,
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
    decision: json.reviewDecision ?? '',
    checks: checksOf(json.statusCheckRollup),
    commitCount: commits.length,
    agent: agentOf(login, [json.body ?? '', ...commits.map((c) => `${c.messageHeadline}\n${c.messageBody}`)]),
    labels: (json.labels ?? []).map((l) => l.name),
  }
}

// Open pull requests, the ones waiting on you first, then the most recently updated.
export function parseInbox(list, requested) {
  const waiting = new Set(requested.map((pr) => pr.number))
  return list
    .map((json) => ({
      number: json.number,
      title: clean(json.title),
      author: json.author?.login ?? 'unknown',
      isDraft: Boolean(json.isDraft),
      added: json.additions ?? 0,
      removed: json.deletions ?? 0,
      fileCount: json.changedFiles ?? 0,
      updatedAt: json.updatedAt,
      decision: json.reviewDecision ?? '',
      checks: checksOf(json.statusCheckRollup),
      agent: agentOf(json.author?.login ?? '', [json.body ?? '']),
      isWaiting: waiting.has(json.number),
    }))
    .sort((a, b) => Number(b.isWaiting) - Number(a.isWaiting) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function ago(iso, now) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (!Number.isFinite(minutes)) return ''
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 60 / 24)}d`
}

// ── The review ─────────────────────────────────────────────────────────────

export const EVENTS = {
  REQUEST_CHANGES: 'Request changes',
  COMMENT: 'Comment',
  APPROVE: 'Approve',
}

const PREFIX = { bug: '**Bug:** ', risk: '**Risk:** ', nit: 'nit: ' }

// What the evidence suggests: open bugs or unmet asks block, open risks need a word,
// and approval waits until the change was actually looked at.
export function suggestedEvent({ findings, items, aiVerdict, isLookedAt = true }) {
  if (findings.some((c) => c.severity === 'bug') || items.some((i) => i.verdict === 'missing')) return 'REQUEST_CHANGES'
  if (aiVerdict === 'request_changes') return 'REQUEST_CHANGES'
  if (findings.some((c) => c.severity === 'risk') || items.some((i) => i.verdict === 'partial')) return 'COMMENT'
  return isLookedAt ? 'APPROVE' : 'COMMENT'
}

const findingText = (c) => `${PREFIX[c.severity] ?? ''}${c.title}. ${c.body}`.trim()

// The review as GitHub takes it: findings on lines the diff shows go inline,
// everything else (other findings, notes, unmet asks, scope creep) into the body.
export function draftReview({ message, findings, notes, items, extras, files, canInline = true }) {
  const commentable = new Map(files.map((f) => [f.path, new Set(newSideLines(f).map((l) => l.line))]))
  const isInline = (file, line) => canInline && Boolean(line) && commentable.get(file)?.has(line)

  const remarks = [
    ...findings.map((c) => ({ file: c.file, line: c.line, text: findingText(c) })),
    ...notes.map((n) => ({ file: n.file, line: n.line, text: n.text })),
  ]
  const inline = remarks.filter((r) => isInline(r.file, r.line)).map((r) => ({ path: r.file, line: r.line, side: 'RIGHT', body: r.text }))
  const elsewhere = remarks.filter((r) => !isInline(r.file, r.line))
  const unmet = items.filter((i) => i.verdict === 'missing' || i.verdict === 'partial')

  const sections = [message.trim()]
  if (elsewhere.length) {
    sections.push(['**Comments**', ...elsewhere.map((r) => `- \`${r.file}${r.line ? `:${r.line}` : ''}\` ${r.text}`)].join('\n'))
  }
  if (unmet.length) {
    sections.push(['**Not done yet**', ...unmet.map((i) => `- ${i.expectation} (${i.verdict})${i.note ? `: ${i.note}` : ''}`)].join('\n'))
  }
  if (extras.length) {
    sections.push(['**Not in the description**, please explain or split out', ...extras.map((x) => `- ${x}`)].join('\n'))
  }
  return { body: sections.filter(Boolean).join('\n\n'), inline }
}

// The text a person copies: the body, then the inline comments as a list.
export function reviewMarkdown(draft) {
  if (!draft.inline.length) return draft.body
  return [draft.body, ['**Inline**', ...draft.inline.map((c) => `- \`${c.path}:${c.line}\` ${c.body}`)].join('\n')].filter(Boolean).join('\n\n')
}
