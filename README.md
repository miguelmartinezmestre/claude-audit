# claude-audit

Traceability of AI use in a Git repository. It records what [Claude Code](https://docs.claude.com/en/docs/claude-code) changes while you work and, on every commit that includes Claude's code, adds:

- a report in `docs/ai-audit/<date>-<session>.md`, committed with your changes: models, session, dates, prompts (with secrets redacted), files and lines per author, Claude's final replies, and a "Human verification" checklist for you to fill in;
- trailers in the commit message:

  ```
  AI-Tool: Claude Code
  AI-Model: claude-opus-4-5
  AI-Report: docs/ai-audit/2026-10-19-a713d671.md
  AI-Lines: claude=40, code-by-claude-edited-by-human=3, human/unknown=2
  ```

Commits without Claude changes are left untouched.

A single Node.js script, no dependencies, works on Windows, macOS and Linux.

## Requirements

- Node.js 21 or newer
- Git
- Claude Code

## Install

From the root of the repository where you want to use it:

```bash
gh release download v1.0.0 -R miguelmartinezmestre/claude-audit -p 'claude-audit-*.zip'
unzip -n claude-audit-v1.0.0.zip   # Windows: tar -xkf claude-audit-v1.0.0.zip
rm claude-audit-v1.0.0.zip
git config core.hooksPath .githooks
node tools/claude-audit.mjs doctor
```

You can also download the zip from the [releases page](https://github.com/miguelmartinezmestre/claude-audit/releases). It contains:

```
tools/claude-audit.mjs     the whole tool
.githooks/                 pre-commit, prepare-commit-msg, post-commit
.claude/settings.json      Claude Code hooks
```

`unzip -n` and `tar -k` never overwrite existing files. If your repository already has one of these files:

- **`.claude/settings.json`**: copy the entries under `"hooks"` from the zip into yours. `doctor` tells you which ones are missing.
- **Other Git hooks**: `core.hooksPath` makes Git use `.githooks/` instead of `.git/hooks/`, so move your hooks there. With husky, call the claude-audit hooks from yours instead: `node .githooks/pre-commit`, `node .githooks/prepare-commit-msg "$@"` and `node .githooks/post-commit`.

When `doctor` shows everything with ✔, commit the files:

```bash
git add tools/claude-audit.mjs .githooks .claude/settings.json
git commit -m "chore: add claude-audit"
```

Restart Claude Code if it was open, so it loads the new hooks.

Everyone who clones the repository needs to run `git config core.hooksPath .githooks` once.

## Usage

Work with Claude Code and commit as usual. The report and the trailers are added on their own.

```bash
node tools/claude-audit.mjs status   # Claude changes not committed yet
node tools/claude-audit.mjs report   # summary of all the reports in docs/ai-audit
node tools/claude-audit.mjs doctor   # checks the installation
```

### Line categories

Lines are counted on the staged diff, so only what goes into the commit counts (it works with `git add -p` and `git commit -- <file>`).

| Category | Meaning |
|---|---|
| `claude` | Line written by Claude and committed unchanged |
| `code-by-claude-edited-by-human` | Line written by Claude and changed afterwards outside Claude |
| `human/unknown` | Line that cannot be attributed to Claude. Usually yours, but not guaranteed |

### Overrides at commit time

- **Model:** `CLAUDE_AUDIT_MODEL` replaces the detected model in the report and in `AI-Model`.
- **Date:** with `--date` (and `GIT_COMMITTER_DATE`), the report uses the commit's day in its name and in every date it shows. The times stay the real ones.

```bash
D="2026-11-19T15:35:00"; CLAUDE_AUDIT_MODEL="claude-sonnet-4-5" GIT_COMMITTER_DATE="$D" git commit --date="$D" -m "message"
```

The `;` after `D="..."` is required: without it `$D` is empty and Git fails with `invalid date format`.

## Where the data lives

| Path | Content |
|---|---|
| `.git/claude-audit/events.jsonl` | Append-only log of everything recorded, with the real dates and models |
| `.git/claude-audit/snapshots/` | Copies of the files before and after each Claude change |
| `.git/claude-audit/errors.log` | Hook errors. Hooks never block Claude or Git |
| `docs/ai-audit/` | The committed reports |

Everything under `.git/` stays on your machine and is not pushed.

## Limitations

- Only changes made through Claude's `Edit`, `Write`, `Bash` and `PowerShell` tools are tracked. Other tools (MCP servers, notebooks) and changes made outside Claude Code count as `human/unknown`.
- Changes to binary files and files larger than 2 MB are not attributed.
- The events are local: if Claude works on one machine and you commit from another, there is no report.
- Closing the commit editor without writing a message does not abort the commit, because the trailers already make the message non-empty.
- If Claude edits `tools/claude-audit.mjs` and leaves it with a syntax error, the hooks fail without logging anything until it is fixed.

## Development

```bash
node --test tests/*.test.mjs
```
