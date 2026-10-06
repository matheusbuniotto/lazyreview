// Prompts for the model and parsing of its answers. No mods API in here.

import { clean, fileHeader, isGenerated, numberedLines, numberedPatch } from './diff.js'

const PATCH_BUDGET = 90_000
export const BATCH_CHARS = 60_000
const ASKS_BUDGET = 20_000
const INTENT_BUDGET = 4_000
const VISION_BUDGET = 4_000
const MAX_FOCUS = 5

export const SEVERITIES = ['bug', 'risk', 'nit', 'praise']
export const VERDICTS = ['done', 'partial', 'missing', 'unclear']
export const FITS = ['fits', 'drifts', 'unclear']

export const RISKS = ['low', 'medium', 'high']
const AI_VERDICTS = ['approve', 'comment', 'request_changes']

export const REVIEW_SYSTEM = `You are a staff engineer reviewing a change, often written by an AI coding agent, for a tech lead who must decide whether it can merge.
Report only what matters, most important first: real bugs, security issues, risky behaviour, missing error handling, and the failure modes typical of AI-written code: calls to functions or APIs that do not exist, logic that does not match the stated intent, duplicated helpers, swallowed errors, checks silenced instead of fixed, tests that assert nothing or were bent to pass, and changes nobody asked for. Add a nit only when it is cheap and clearly better. Praise sparingly.
Every comment and focus entry names the file and the new-file line number shown in the left gutter of the diff.
Answer with JSON only, no prose and no code fence:
{"summary": "<two sentences: what the change does, and how sound it is>",
 "risk": "low|medium|high",
 "verdict": "approve|comment|request_changes",
 "focus": [{"file": "<path>", "line": <number>, "why": "<where a human should look first and why, one line>"}],
 "comments": [{"file": "<path>", "line": <number>, "severity": "bug|risk|nit|praise", "title": "<at most 8 words>", "body": "<what is wrong and how to fix it, at most 3 sentences>"}]}
Give at most 3 focus entries.`

export const EXPECT_SYSTEM = `You compare what was asked for (a user's requests to a coding agent, or a pull request's description and linked issues) with the diff that was produced.
First list each concrete expectation from the user's requests (merge duplicates, drop chit-chat, keep later corrections over earlier asks). Then judge each one against the diff.
Answer with JSON only, no prose and no code fence:
{"items": [{"expectation": "<short imperative>", "verdict": "done|partial|missing|unclear", "evidence": "<file:line or empty>", "note": "<what is missing or why, one sentence, empty when done>"}],
 "extras": ["<a change in the diff nobody asked for, one line each>"]}`

const VISION_SYSTEM = `
The project also has a vision: what it is meant to be. Judge whether the diff keeps to it, for example a sample app growing a feature that does not belong in a sample, or a chat bot gaining a workflow with no chat. Add this key to the JSON:
 "vision": {"fit": "fits|drifts|unclear", "note": "<when it drifts, how, one sentence; otherwise empty>"}`

// The expectations prompt, with the vision question added when the project states one.
export const expectSystem = (vision) => (vision ? EXPECT_SYSTEM + VISION_SYSTEM : EXPECT_SYSTEM)

const visionBlock = (vision) => (vision ? `The project's vision:\n${vision.slice(0, VISION_BUDGET)}\n\n` : '')

// Every changed file's stats, then as much of each diff as fits: small files whole,
// large ones cut to an even share of what is left. Generated files are listed only.
export function patchFor(files, budget = PATCH_BUDGET) {
  const stats = files.map((f) => `${f.status} ${f.path} +${f.added} -${f.removed}${isGenerated(f.path) ? ' (generated, diff omitted)' : ''}`)
  const texts = files.filter((f) => !isGenerated(f.path)).map(numberedPatch)
  const out = [...texts]
  let left = budget - stats.join('\n').length
  texts
    .map((text, i) => i)
    .sort((a, b) => texts[a].length - texts[b].length)
    .forEach((i, k, order) => {
      const share = Math.floor(left / (order.length - k))
      if (texts[i].length > share) out[i] = texts[i].slice(0, Math.max(0, share - 60)) + '\n… (rest of this file cut to fit)'
      left -= out[i].length
    })
  return `Changed files:\n${stats.join('\n')}\n\n${out.join('\n\n')}`
}

// The diff split into batches a model reviews separately; a file too big for
// one batch is split by lines, each part keeping its line numbers.
export function reviewBatches(files, budget = BATCH_CHARS) {
  const units = files
    .filter((f) => !isGenerated(f.path) && !f.isBinary && f.hunks.length)
    .flatMap((file) => {
      const header = fileHeader(file)
      const parts = []
      let part = []
      let size = 0
      for (const line of numberedLines(file)) {
        if (part.length && size + line.length + 1 > budget - header.length - 40) {
          parts.push(part)
          part = []
          size = 0
        }
        part.push(line)
        size += line.length + 1
      }
      if (part.length) parts.push(part)
      return parts.map((lines, k) =>
        [parts.length > 1 ? `${header} part ${k + 1}/${parts.length}` : header, ...lines].join('\n'),
      )
    })

  const batches = []
  let batch = []
  let size = 0
  for (const unit of units) {
    if (batch.length && size + unit.length > budget) {
      batches.push(batch.join('\n\n'))
      batch = []
      size = 0
    }
    batch.push(unit)
    size += unit.length + 2
  }
  if (batch.length) batches.push(batch.join('\n\n'))
  return batches
}

// `intent` is what the change claims to do (a PR's title and description), when known.
export function reviewPrompt(batch, part, parts, intent = '') {
  const claim = intent ? `The author describes the change as:\n${intent.slice(0, INTENT_BUDGET)}\n\n` : ''
  const split = parts > 1 ? ` (part ${part} of ${parts}; the other parts are reviewed separately, so judge only the code shown here and never comment on what is missing from this part)` : ''
  return `${claim}Review this diff${split}.\n\n${batch}`
}

export function expectPrompt(asks, files, heading = "The user's requests, oldest first", vision = '') {
  const requests = asks.join('\n---\n').slice(-ASKS_BUDGET)
  return `${visionBlock(vision)}${heading}:\n${requests}\n\nThe diff:\n\n${patchFor(files)}`
}

// The same check asked of a fork of the session, which already holds the whole
// conversation: corrections, answers to Claude's questions, and what Claude claimed.
export function expectForkPrompt(extras, files, vision = '') {
  const own = extras.length ? `\n\nI also expect:\n${extras.map((x) => `- ${x}`).join('\n')}` : ''
  return `Do not use any tools. Act as a reviewer of this conversation's work.\n\n${expectSystem(vision)}\n\n${visionBlock(vision)}Judge what I asked for in this conversation against the diff below, not against what you said you did.${own}\n\nThe diff:\n\n${patchFor(files)}`
}

// The first JSON object in a reply, tolerating a code fence or stray prose.
export function parseJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model answered without JSON')
  return JSON.parse(text.slice(start, end + 1))
}

export function parseReview(text, paths, idPrefix = 'c') {
  const json = parseJson(text)
  const known = new Set(paths)
  const comments = (Array.isArray(json.comments) ? json.comments : [])
    .filter((c) => c && known.has(c.file))
    .map((c, i) => ({
      id: `${idPrefix}${i}`,
      file: c.file,
      line: Number.isInteger(c.line) ? c.line : 0,
      severity: SEVERITIES.includes(c.severity) ? c.severity : 'nit',
      title: clean(c.title).slice(0, 120),
      body: clean(c.body).slice(0, 1500),
      by: 'ai',
    }))
  const focus = (Array.isArray(json.focus) ? json.focus : [])
    .filter((f) => f && known.has(f.file))
    .map((f) => ({ file: f.file, line: Number.isInteger(f.line) ? f.line : 0, why: clean(f.why).slice(0, 200) }))
  return {
    summary: clean(json.summary).slice(0, 1000),
    risk: RISKS.includes(json.risk) ? json.risk : '',
    verdict: AI_VERDICTS.includes(json.verdict) ? json.verdict : '',
    focus,
    comments,
  }
}

export const MERGE_SYSTEM = `You merge the reviews of the parts of one large change into a single verdict for a tech lead.
Answer with JSON only, no prose and no code fence:
{"summary": "<two sentences on the whole change: what it does, and how sound it is>",
 "risk": "low|medium|high",
 "verdict": "approve|comment|request_changes",
 "focus": [{"file": "<path>", "line": <number>, "why": "<one line>"}],
 "duplicates": ["<id of a comment that repeats the point of an earlier one>"]}
Give at most 3 focus entries, each on a different concern.`

export function mergePrompt(review, intent = '') {
  const claim = intent ? `The author describes the change as:\n${intent.slice(0, INTENT_BUDGET)}\n\n` : ''
  const comments = review.comments.map((c) => `${c.id} [${c.severity}] ${c.file}:${c.line} ${c.title}`)
  return `${claim}Part reviews:\n${review.summary}\n\nTheir comments, in order:\n${comments.join('\n')}`
}

// The merged verdict over the parts' review; repeated comments dropped.
export function applyMerge(review, text) {
  const json = parseJson(text)
  const paths = new Set(review.comments.map((c) => c.file))
  const drop = new Set(Array.isArray(json.duplicates) ? json.duplicates : [])
  const focus = (Array.isArray(json.focus) ? json.focus : [])
    .filter((f) => f && paths.has(f.file))
    .map((f) => ({ file: f.file, line: Number.isInteger(f.line) ? f.line : 0, why: clean(f.why).slice(0, 200) }))
  return {
    ...review,
    summary: clean(json.summary).slice(0, 1000) || review.summary,
    risk: RISKS.includes(json.risk) ? json.risk : review.risk,
    verdict: AI_VERDICTS.includes(json.verdict) ? json.verdict : review.verdict,
    focus: focus.length ? focus.slice(0, MAX_FOCUS) : review.focus,
    comments: review.comments.filter((c) => !drop.has(c.id)),
  }
}

// The parts of a batched review as one: the worst risk and verdict, every comment.
export function mergeReviews(parts) {
  const worst = (list, key) => list[Math.max(-1, ...parts.map((p) => list.indexOf(p[key])))] ?? ''
  return {
    summary: parts.map((p) => p.summary).filter(Boolean).join(' '),
    risk: worst(RISKS, 'risk'),
    verdict: worst(AI_VERDICTS, 'verdict'),
    focus: parts.flatMap((p) => p.focus).slice(0, MAX_FOCUS),
    comments: parts.flatMap((p) => p.comments),
  }
}

export function parseExpectations(text) {
  const json = parseJson(text)
  const items = (Array.isArray(json.items) ? json.items : [])
    .filter((item) => item && item.expectation)
    .map((item) => ({
      expectation: clean(item.expectation).slice(0, 300),
      verdict: VERDICTS.includes(item.verdict) ? item.verdict : 'unclear',
      evidence: clean(item.evidence).slice(0, 200),
      note: clean(item.note).slice(0, 500),
    }))
  const extras = (Array.isArray(json.extras) ? json.extras : []).map((x) => clean(x).slice(0, 300)).filter(Boolean)
  const fit = json.vision && FITS.includes(json.vision.fit) ? { fit: json.vision.fit, note: clean(json.vision.note).slice(0, 500) } : null
  return { items, extras, vision: fit }
}

// The user's own words from the transcript: prompts, not tool results or command echoes.
export function userAsks(messages) {
  return messages
    .filter((m) => m.role === 'user' && typeof m.text === 'string')
    .map((m) => m.text.trim())
    .filter((text) => text && !text.startsWith('<') && !text.startsWith('/'))
}

// What "Ask Claude to fix" sends: open findings, unmet expectations and the reviewer's
// notes ([{ file, line, text }]).
export function fixPrompt({ comments, items, notes }) {
  const at = (file, line) => (line ? `${file}:${line}` : file)
  const lines = []
  for (const c of comments) {
    lines.push(`- [${c.severity}] ${at(c.file, c.line)} ${c.title}: ${c.body}`)
  }
  for (const item of items.filter((i) => i.verdict === 'missing' || i.verdict === 'partial')) {
    lines.push(`- [${item.verdict}] ${item.expectation}${item.note ? `: ${item.note}` : ''}`)
  }
  for (const note of notes) lines.push(`- [reviewer] ${at(note.file, note.line)}: ${note.text}`)
  if (!lines.length) return ''
  return `Code review of the current changes found the items below. Fix each one, or tell me why it should stay as is.\n\n${lines.join('\n')}`
}
