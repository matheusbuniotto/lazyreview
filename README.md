# lazyreview

A lazygit-style review pane for Claude Code, built for a tech lead reviewing changes (often AI-written) from the session or from a teammate's pull request.

1. **Overview**: what the author says, the AI read (risk, two-line summary, where to look first), quick checks with no model involved, and where the weight of the change is.
2. **Files**: grouped by folder, with an inline diff, findings under the lines they are about, a viewed mark per file, and your own notes.
3. **Expected**: each ask (from the session, or from the PR description and linked issues) checked against the diff, plus what changed that nobody asked for.
4. **Verdict**: for a PR, Approve / Comment / Request changes, posted to GitHub with inline comments. For local changes, everything is handed back to Claude to fix. Either can be copied as Markdown.

Tested against Claude Code 2.1.289.

## Install

Requires Claude Code 2.1.287 or later (mods). Pull requests also need the [GitHub CLI](https://cli.github.com), signed in with `gh auth login`.

**From GitHub** (the repo is its own marketplace):

```sh
claude plugin marketplace add matheusbuniotto/lazyreview
claude plugin install lazyreview@lazyreview
```

Or inside Claude Code: `/plugin marketplace add matheusbuniotto/lazyreview`, then `/plugin install lazyreview@lazyreview`. A session that is already running needs `/reload-plugins`. Then `/plugin` lists `lazyreview` under installed mods.

To update later, run `claude plugin update lazyreview@lazyreview`, then `/reload-plugins`. To remove it, run `claude plugin uninstall lazyreview@lazyreview`.

**From a clone**, to try it or hack on it:

```sh
git clone https://github.com/matheusbuniotto/lazyreview.git ~/mods/lazyreview
claude --plugin-dir ~/mods/lazyreview
```

That session hot-reloads the mod when a file changes. To load it in every session without installing it, add the absolute path to `CLAUDE_CODE_PLUGIN_DIRS` (paths separated by `:`) under `env` in `~/.claude/settings.json`.

**Pick the model** for the AI passes (default `sonnet`): run `claude plugin configure lazyreview@lazyreview`, or use **Configure options** in `/plugin`.

**Review it first.** Mods run as you, unsandboxed. `claude plugin validate ~/mods/lazyreview` lists what this one does:
- It runs `git` and `gh`.
- It reads files in the repo.
- It calls the model.
- It can submit the "fix with Claude" prompt.
- It posts a review to GitHub, only after you confirm.

## Run

| Command | Opens |
| :- | :- |
| `/lazyreview` | The working tree (after a turn in which Claude edits files, a band above the prompt offers **Review**) |
| `/lazyreview prs` | Open pull requests, the ones waiting on your review first |
| `/lazyreview 123` (or `#123`, or a PR URL) | That pull request |
| `/lazyreview head\|staged\|unstaged\|branch` | The working tree against that base |
| add `ai` / `expect` | Starts the AI review / expectations check right away |

Not `/review`: that is Claude Code's alias for its built-in `/code-review`. In `claude -p` and the VS Code chat, where nothing draws, the command prints a text report instead.

Pull requests need the [GitHub CLI](https://cli.github.com), signed in (`gh auth login`), run from a clone of the repo. The PR's commits are fetched into the clone (`git fetch <remote> pull/N/head`) without checking anything out, so your working tree is never touched, and huge PRs work where GitHub's diff API gives up.

## A review, start to finish

1. `/lazyreview prs`, `j`/`k`, `o`: open a PR. The **Overview** shows the author, branch, CI, which coding agent wrote it (from co-author trailers and "Generated with" lines), and red flags.
2. `a`: the AI read. It returns the risk, a summary, up to three places to look first (each jumps to the line), and comments placed inline. The prompt targets the usual failures of AI-written code: calls to functions that don't exist, logic that doesn't match the description, swallowed errors, silenced checks, hollow tests, and scope creep.
3. `2`, then `v` on each file: marks it viewed and moves to the next one not yet viewed. Marks are saved, and a mark is dropped when the file's diff changes after a new push.
4. `c` walks the findings across files, and `d` dismisses one. Type into **✎ Note** to add your own comment, starting it with `L42:` to attach it to a line.
5. `3`, `e`: does the PR do what its description and linked issues say?
6. `4`: pick the verdict (one is suggested from the evidence), add a message, read the preview, then **Post to GitHub…** and confirm. Findings on a line the diff shows become inline comments. The rest, plus unmet asks and unrequested changes, goes in the summary.

Switching PRs keeps each one's review, notes and dismissals for the session.

## Keys (while the pane has focus)

| Key | Action |
| :- | :- |
| `1` `2` `3` `4` | Overview / Files / Expected / Verdict |
| `j` / `k` | Next / previous file (rows are clickable too) |
| `v` | Mark the file viewed and go to the next unviewed one |
| `n` / `p` | Next / previous hunk |
| `h` / `l` | Previous / next page of a big file |
| `w` | Toggle between the diff and the whole file (Markdown renders as Markdown) |
| `c` / `d` | Next open finding (across files) / dismiss it and move on |
| `a` | AI review of every visible file |
| `e` | Check expected vs implemented |
| `f` | Local changes: send the open findings, unmet expectations and your notes to Claude |
| `y` | Copy the review as Markdown |
| `s` / `b` | Local changes: stage or unstage the file / cycle the base (HEAD, staged, unstaged, branch) |
| `m` | Show or hide `.md` files (hidden by default; the choice is saved) |
| `i` | Pull requests (and back) |
| `x` | Cancel a running AI pass |
| `r` / `q` | Refresh (re-fetches a PR) / close |
| Esc | Return focus to the prompt and keep the pane open |

## Quick checks

These run on every load, instantly and without a model. Red flags on added lines show inline like review comments:
- possible secrets
- `.only` and skipped tests
- silenced lint or type checks
- empty `catch` blocks
- debug output
- TODOs

Facts about the whole change are listed on the Overview:
- CI failing
- tests removed
- no tests changed
- a large change
- no PR description
- sensitive paths (auth, migrations, CI, infra)
- dependency changes
- collapsed generated files

When the AI raises the same point on the same line, it is shown once.

**Vision.** Commit a `VISION.md` at the repo root saying what the project is meant to be (a sample app, a chat bot, a CLI with no UI…). The Expected check then also asks whether the change keeps to it, and tab 3 shows a red **Drifts from VISION.md** alert when it does not, such as a chat bot gaining a workflow with no chat. For a PR the vision is read from the base branch, so a PR cannot rewrite its own. Without a `VISION.md` nothing changes.

Expectations you add on tab 3 are standing ones: they are saved and checked on every review.

## Big changes

- **Paged reader.** One drawing is limited to 100,000 characters, so big diffs and files are shown a page at a time (about 400 lines). `h`/`l` turn pages, and `n`/`p`/`c` jump to whichever page holds the hunk or finding.
- **Generated files are collapsed.** Lock files and build output (`package-lock.json`, `yarn.lock`, `dist/`, `*.min.js`, …) are listed with a ⚙ and their line counts. Their diff isn't read, drawn, or sent to the AI unless you press **Show the diff anyway**.
- **The AI review runs in parts.** The diff is split into parts of about 60k characters, up to 3 run at once and up to 12 in total. A file too big for one part is split by lines and keeps its line numbers. A final short call merges the parts into one summary, risk and focus list, and drops comments that repeat each other.
- **Warnings** appear in the header when git output passes 4 MiB or there are more than 300 untracked files.

A blob-less partial clone (`--filter=blob:none`) can't be reviewed, because Claude Code turns off git's lazy fetching. Use a regular clone.

## Develop

```sh
claude plugin validate .
claude plugin test
scripts/demo-repo.sh   # a throwaway repo with every kind of change, planted bugs, a 2,200-line file and a lock file
```
