// Quick checks run on every change before anyone reads it, no model needed:
// red flags on added lines (drawn inline like review comments) and facts about
// the change as a whole. No mods API in here.

import { isGenerated, isMarkdown, newSideLines } from './diff.js'

const LARGE_CHANGE = 400
const HUGE_CHANGE = 1000
const SHOWN_LINES = 4

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.\w+$|_test\.go$|(^|\/)test_[^/]+\.py$/i
const CODE_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|cs|php|scala|c|cc|cpp|h|hpp|vue|svelte)$/i
const MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|composer\.json)$/
const SENSITIVE = /(^|\/)(auth\w*|security|crypto|payments?|billing|migrations?|secrets?)(\/|[._-]|$)|(^|\/)\.github\/workflows\/|(^|\/)Dockerfile|\.tf$|(^|\/)(k8s|helm|infra|terraform)\//i

export const isTestFile = (path) => TEST_FILE.test(path)

const LINE_RULES = [
  {
    kind: 'secret',
    severity: 'bug',
    title: 'Possible hardcoded secret',
    body: 'Move it to the environment or a secret store, and rotate it: it is in the git history now.',
    pattern: /\b(sk-(live|test|proj)?-?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|passw(or)?d|token)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
  {
    kind: 'only',
    severity: 'bug',
    title: 'Focused test left in',
    body: '`.only` makes the runner skip every other test in the suite.',
    pattern: /\b(it|test|describe|context)\.only\(/,
  },
  {
    kind: 'skip',
    severity: 'risk',
    title: 'Test skipped',
    body: 'A skipped test can hide a failure. Ask why, or fix it.',
    pattern: /\b(it|test|describe)\.skip\(|\bx(it|describe)\(|@pytest\.mark\.skip|\bt\.Skip\(/,
  },
  {
    kind: 'silenced',
    severity: 'risk',
    title: 'Lint or type check silenced',
    body: 'Check the reason: coding agents often silence a check instead of fixing the code.',
    pattern: /eslint-disable|@ts-(ignore|expect-error|nocheck)|#\s*noqa|#\s*type:\s*ignore|\/\/\s*nolint|#\[allow\(|@SuppressWarnings/,
  },
  {
    kind: 'swallowed',
    severity: 'risk',
    title: 'Error swallowed',
    body: 'An empty catch hides failures. Handle it, log it, or let it propagate.',
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}|except(\s+[\w.]+)?\s*:\s*pass\b/,
  },
  {
    kind: 'debug',
    severity: 'nit',
    title: 'Debug output left in',
    body: 'Remove it, or use the project logger.',
    pattern: /\bconsole\.(log|debug)\(|^\s*debugger;?\s*$|\bbreakpoint\(\)|\bpdb\.set_trace\(|\bbinding\.pry\b/,
  },
  {
    kind: 'todo',
    severity: 'nit',
    title: 'TODO added',
    body: 'Finish it before merging, or track it in an issue.',
    pattern: /\b(TODO|FIXME|XXX|HACK)\b/,
  },
]

// One finding per rule per file, at its first match; the other lines are named in the body.
function lineFindings(file) {
  if (file.isGenerated || isMarkdown(file.path)) return []
  const added = newSideLines(file).filter((l) => l.isAdded)
  return LINE_RULES.flatMap((rule) => {
    const hits = added.filter((l) => rule.pattern.test(l.text)).map((l) => l.line)
    if (!hits.length) return []
    const more = hits.slice(1)
    const also = more.length
      ? ` Also on ${more.slice(0, SHOWN_LINES).map((n) => `L${n}`).join(', ')}${more.length > SHOWN_LINES ? ` and ${more.length - SHOWN_LINES} more` : ''}.`
      : ''
    return [{ id: `${rule.kind}@${file.path}`, by: 'check', file: file.path, line: hits[0], severity: rule.severity, title: rule.title, body: rule.body + also }]
  })
}

const listed = (paths) => (paths.length > 3 ? `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more` : paths.join(', '))

// Facts about the whole change, worst first: [{ level: 'bad'|'warn'|'info', text, file? }].
function changeNotes(files, pr) {
  const notes = []
  const real = files.filter((f) => !f.isGenerated && !isMarkdown(f.path))
  const size = real.reduce((n, f) => n + f.added + f.removed, 0)
  const tests = real.filter((f) => isTestFile(f.path))
  const code = real.filter((f) => CODE_FILE.test(f.path) && !isTestFile(f.path) && f.status !== 'D')
  const removedTests = tests.filter((f) => f.status === 'D' || (f.removed > 10 && f.removed > f.added * 2))

  if (pr?.checks.failed) notes.push({ level: 'bad', text: `CI failing: ${listed(pr.checks.failing)}` })
  if (removedTests.length) notes.push({ level: 'bad', text: `Tests removed or gutted: ${listed(removedTests.map((f) => f.path))}`, file: removedTests[0].path })
  if (code.length && !tests.length) notes.push({ level: 'warn', text: `No tests changed for ${code.length} source file${code.length === 1 ? '' : 's'}` })
  if (size > HUGE_CHANGE) notes.push({ level: 'warn', text: `Very large change: ${size.toLocaleString('en-US')} lines. Reviews past ~${LARGE_CHANGE} lines miss most defects; consider asking to split it.` })
  else if (size > LARGE_CHANGE) notes.push({ level: 'warn', text: `Large change: ${size.toLocaleString('en-US')} lines` })
  if (pr && pr.body.trim().length < 40) notes.push({ level: 'warn', text: 'No real description: ask the author what it does and why' })

  const sensitive = real.filter((f) => SENSITIVE.test(f.path)).map((f) => f.path)
  if (sensitive.length) notes.push({ level: 'warn', text: `Sensitive areas: ${listed(sensitive)}`, file: sensitive[0] })
  const manifests = files.filter((f) => MANIFEST.test(f.path)).map((f) => f.path)
  if (manifests.length) notes.push({ level: 'info', text: `Dependencies changed: ${listed(manifests)}`, file: manifests[0] })
  const generated = files.filter((f) => f.isGenerated || isGenerated(f.path)).map((f) => f.path)
  if (generated.length) notes.push({ level: 'info', text: `${generated.length} generated file${generated.length === 1 ? '' : 's'} collapsed: ${listed(generated)}` })
  return notes
}

export function scan(files, pr = null) {
  return { notes: changeNotes(files, pr), findings: files.flatMap(lineFindings) }
}
