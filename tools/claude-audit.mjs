#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const REPORT_DIR = 'docs/ai-audit';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CLAUDE = 'claude';
const CLAUDE_EDITED = 'code-by-claude-edited-by-human';
const HUMAN_OR_UNKNOWN = 'human/unknown'; // anything we cannot attribute to Claude
const CATEGORIES = [CLAUDE, CLAUDE_EDITED, HUMAN_OR_UNKNOWN];

const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
const GIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'post-commit'];

// Secrets removed from prompts and commands before they are stored
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]'],
  [/\b(?:sk|pk|rk)[-_](?:live_|test_|ant-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [REDACTED]'],
  [/((?:password|passwd|pwd|contraseña|clave|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*)(["']?)[^\s"']+\2/gi, '$1[REDACTED]'],
  [/(:\/\/)[^\s:@/]+:[^\s@/]+@/g, '$1[REDACTED]@'],
];

const unique = items => [...new Set(items)];
const now = () => new Date().toISOString();
const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');

function run(command, args, { cwd, okExitCodes = [0] } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (result.error) throw result.error;
  if (!okExitCodes.includes(result.status)) {
    throw new Error(`${command} ${args.join(' ')} -> ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function normalizeLineEndings(content) {
  return content == null ? null : content.toString('utf8').replace(/\r\n/g, '\n');
}

function countLines(content) {
  const text = normalizeLineEndings(content);
  if (!text) return 0;
  const parts = text.split('\n').length;
  return text.endsWith('\n') ? parts - 1 : parts;
}

function openRepo(cwd) {
  const root = fs.realpathSync(run('git', ['rev-parse', '--show-toplevel'], { cwd }).trim());
  const git = (args, options) => run('git', args, { cwd: root, ...options });
  const gitDir = path.resolve(root, git(['rev-parse', '--git-common-dir']).trim());
  const auditDir = path.join(gitDir, 'claude-audit');
  const snapshotsDir = path.join(auditDir, 'snapshots');
  fs.mkdirSync(snapshotsDir, { recursive: true });

  return {
    root,
    git,
    auditDir,
    snapshotsDir,
    eventsFile: path.join(auditDir, 'events.jsonl'),
    handoffFile: path.join(auditDir, 'pending-commit.json'),
    errorsFile: path.join(auditDir, 'errors.log'),
  };
}

function logError(repo, error) {
  const file = repo ? repo.errorsFile : path.join(os.tmpdir(), 'claude-audit-errors.log');
  try {
    fs.appendFileSync(file, `${now()} ${error?.stack ?? error}\n`);
  } catch {}
}

function readWorkingFile(repo, file) {
  try {
    const fullPath = path.join(repo.root, file);
    const stats = fs.statSync(fullPath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(fullPath);
  } catch {
    return null;
  }
}

function readFromGit(repo, spec) {
  const result = spawnSync('git', ['cat-file', 'blob', spec], { cwd: repo.root, maxBuffer: 1 << 30 });
  return result.status === 0 ? result.stdout : null;
}

const readFileAtHead = (repo, file) => readFromGit(repo, `HEAD:${file}`);
const readStagedFile = (repo, file) => readFromGit(repo, `:${file}`);

function stagedFiles(repo) {
  return repo.git(['diff', '--cached', '--name-only', '-z', '--no-renames']).split('\0').filter(Boolean);
}

function listRepoFiles(repo) {
  return repo.git(['ls-files', '-co', '--exclude-standard', '-z'])
    .split('\0')
    .filter(file => file && toRepoPath(repo, file));
}

function toRepoPath(repo, anyPath) {
  // Resolve symlinks (/tmp -> /private/tmp on macOS) on the deepest existing folder: Write may be about to create the file
  let existing = path.resolve(repo.root, anyPath);
  const missingParts = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    missingParts.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const absolute = path.join(fs.realpathSync(existing), ...missingParts);
  const relative = path.relative(repo.root, absolute).split(path.sep).join('/');

  const isOutsideRepo = !relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative);
  if (isOutsideRepo) return null;
  // Reports are excluded so they are never attributed to Claude
  if (relative.startsWith('.git/') || relative.startsWith(REPORT_DIR + '/')) return null;
  return relative;
}

function storeContent(repo, content) {
  if (content == null) return null;
  const hash = sha256(content);
  const file = path.join(repo.snapshotsDir, hash);
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
  return hash;
}

// A null hash means the file does not exist; it is diffed as an empty file
function storedFilePath(repo, hash) {
  return path.join(repo.snapshotsDir, hash ?? storeContent(repo, Buffer.alloc(0)));
}

function readStoredContent(repo, hash) {
  return hash ? fs.readFileSync(storedFilePath(repo, hash)) : null;
}

function appendEvent(repo, event) {
  fs.appendFileSync(repo.eventsFile, JSON.stringify(event) + '\n');
}

function readEvents(repo) {
  if (!fs.existsSync(repo.eventsFile)) return [];
  const events = [];
  for (const line of fs.readFileSync(repo.eventsFile, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

function pendingChanges(events) {
  const consumedIds = new Set(events.filter(event => event.type === 'consumed').flatMap(event => event.ids));
  return events.filter(event => event.type === 'change' && !consumedIds.has(event.id));
}

function operationName(beforeHash, afterHash) {
  if (beforeHash == null) return 'create';
  if (afterHash == null) return 'delete';
  return 'modify';
}

function diffStored(repo, beforeHash, afterHash, contextLines = 0) {
  const args = [
    'diff', '--no-index', '--no-color', '--no-ext-diff', '--ignore-cr-at-eol', `-U${contextLines}`,
    storedFilePath(repo, beforeHash), storedFilePath(repo, afterHash),
  ];
  // `git diff` exits with 1 when the files differ: that is not an error
  return run('git', args, { cwd: repo.root, okExitCodes: [0, 1] });
}

class BinaryFileError extends Error {}

function diffHunks(repo, beforeHash, afterHash) {
  const diff = diffStored(repo, beforeHash, afterHash);
  if (/^Binary files /m.test(diff)) throw new BinaryFileError();

  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  return [...diff.matchAll(hunkHeader)].map(([, oldStart, oldCount, newStart, newCount]) => ({
    oldStart: Number(oldStart),
    oldCount: oldCount === undefined ? 1 : Number(oldCount), // git omits the count when it is 1
    newStart: Number(newStart),
    newCount: newCount === undefined ? 1 : Number(newCount),
  }));
}

function readableDiff(repo, beforeHash, afterHash) {
  const withoutHeaders = diffStored(repo, beforeHash, afterHash, 3).replace(/^[\s\S]*?(?=^@@)/m, '');
  if (withoutHeaders.length <= 20000) return withoutHeaders;
  return withoutHeaders.slice(0, 20000) + '\n[...truncated]';
}

async function runClaudeHook() {
  let repo;
  try {
    const input = JSON.parse(await readStdin());
    repo = openRepo(process.env.CLAUDE_PROJECT_DIR || input.cwd);
    const common = { session_id: input.session_id, prompt_id: input.prompt_id, ts: now() };

    switch (input.hook_event_name) {
      case 'SessionStart':
        appendEvent(repo, { type: 'session_start', ...common, source: input.source, model: input.model });
        break;
      case 'UserPromptSubmit':
        appendEvent(repo, { type: 'prompt', ...common, prompt: redactSecrets(input.prompt) });
        break;
      case 'Stop':
        appendEvent(repo, { type: 'stop', ...common, summary: redactSecrets(input.last_assistant_message).slice(0, 4000) });
        break;
      case 'PreToolUse':
        saveSnapshotBeforeTool(repo, input);
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure': // the tool failed, but it may have changed files anyway
        recordChangesAfterTool(repo, input, common);
        break;
    }
  } catch (error) {
    logError(repo, error);
  }
  // Never write to stdout nor exit with an error code: Claude Code would read it as a hook decision
}

function redactSecrets(text) {
  let result = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

// The model is not part of the hook input: it is read from the last assistant message in the transcript
function modelFromTranscript(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return 'unknown';
  }
  for (const line of lines.reverse()) {
    if (!line.includes('"assistant"')) continue;
    try {
      const entry = JSON.parse(line);
      const model = entry.message?.model;
      if (entry.type === 'assistant' && model && model !== '<synthetic>') return model;
    } catch {}
  }
  return 'unknown';
}

function snapshotFile(repo, input) {
  const id = String(input.tool_use_id ?? input.session_id).replace(/[^\w-]/g, '_');
  return path.join(repo.snapshotsDir, `pre-${id}.json`);
}

function filesTouchedBy(repo, input) {
  if (input.tool_name === 'Edit' || input.tool_name === 'Write') {
    const target = input.tool_input?.file_path && toRepoPath(repo, input.tool_input.file_path);
    return target ? [target] : [];
  }
  return listRepoFiles(repo);
}

function takeSnapshot(repo, files) {
  return Object.fromEntries(files.map(file => [file, storeContent(repo, readWorkingFile(repo, file))]));
}

function saveSnapshotBeforeTool(repo, input) {
  const snapshot = takeSnapshot(repo, filesTouchedBy(repo, input));
  fs.writeFileSync(snapshotFile(repo, input), JSON.stringify(snapshot));
}

function recordChangesAfterTool(repo, input, common) {
  const before = readJsonFile(snapshotFile(repo, input));
  if (!before) return;
  fs.rmSync(snapshotFile(repo, input), { force: true });

  // Include files that did not exist before, e.g. created by a Bash command
  const files = unique([...Object.keys(before), ...filesTouchedBy(repo, input)]);
  const after = takeSnapshot(repo, files);
  const changedFiles = files.filter(file => (before[file] ?? null) !== after[file]);
  if (changedFiles.length === 0) return;

  const model = modelFromTranscript(input.transcript_path);
  const command = input.tool_input?.command;
  for (const file of changedFiles) {
    const beforeHash = before[file] ?? null;
    const afterHash = after[file];
    appendEvent(repo, {
      type: 'change',
      id: crypto.randomUUID(),
      ...common,
      tool: input.tool_name,
      tool_use_id: input.tool_use_id,
      model,
      file,
      op: operationName(beforeHash, afterHash),
      before: beforeHash,
      after: afterHash,
      command: command != null ? redactSecrets(command) : undefined,
      failed: input.hook_event_name === 'PostToolUseFailure' || undefined,
      diff: readableDiff(repo, beforeHash, afterHash),
    });
  }
}

// `authors[i]` is who wrote line i + 1 of a file version. Lines outside the hunks keep their author;
// `authorsOfNewLines(replacedAuthors, count)` decides the author of the lines each hunk inserts.
function carryAuthors(oldAuthors, hunks, authorsOfNewLines) {
  const newAuthors = [];
  let oldIndex = 0;

  for (const hunk of hunks) {
    // "-12,0" means "insert after line 12"
    const hunkStart = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    while (oldIndex < hunkStart) newAuthors.push(oldAuthors[oldIndex++]);

    const replacedAuthors = oldAuthors.slice(oldIndex, oldIndex + hunk.oldCount);
    oldIndex += hunk.oldCount;
    newAuthors.push(...authorsOfNewLines(replacedAuthors, hunk.newCount));
  }

  while (oldIndex < oldAuthors.length) newAuthors.push(oldAuthors[oldIndex++]);
  return newAuthors;
}

function writtenByClaude(_replacedAuthors, count) {
  return Array(count).fill(CLAUDE);
}

function writtenBySomeoneElse(replacedAuthors, count) {
  const replacedClaudeLines = replacedAuthors.filter(author => author !== HUMAN_OR_UNKNOWN).length;
  return Array.from({ length: count }, (_, i) => (i < replacedClaudeLines ? CLAUDE_EDITED : HUMAN_OR_UNKNOWN));
}

function attributeStagedLines(repo, file, changes) {
  const counts = { [CLAUDE]: 0, [CLAUDE_EDITED]: 0, [HUMAN_OR_UNKNOWN]: 0 };
  try {
    let currentVersion = changes[0].before;
    let authors = Array(countLines(readStoredContent(repo, currentVersion))).fill(HUMAN_OR_UNKNOWN);

    for (const change of changes) {
      // If the file changed between two Claude changes, someone else did it
      if (change.before !== currentVersion) {
        authors = carryAuthors(authors, diffHunks(repo, currentVersion, change.before), writtenBySomeoneElse);
      }
      authors = carryAuthors(authors, diffHunks(repo, change.before, change.after), writtenByClaude);
      currentVersion = change.after;
    }

    const stagedVersion = storeContent(repo, readStagedFile(repo, file));
    authors = carryAuthors(authors, diffHunks(repo, currentVersion, stagedVersion), writtenBySomeoneElse);

    const headVersion = storeContent(repo, readFileAtHead(repo, file));
    for (const hunk of diffHunks(repo, headVersion, stagedVersion)) {
      for (let line = hunk.newStart; line < hunk.newStart + hunk.newCount; line++) {
        counts[authors[line - 1] ?? HUMAN_OR_UNKNOWN]++;
      }
    }
    return { counts, deleted: stagedVersion == null };
  } catch (error) {
    if (error instanceof BinaryFileError) return { counts, binary: true };
    throw error;
  }
}

function attributeFiles(repo, changes) {
  const rows = [];
  for (const [file, fileChanges] of Map.groupBy(changes, change => change.file)) {
    const { counts, deleted, binary } = attributeStagedLines(repo, file, fileChanges);
    const op = operationName(fileChanges[0].before, fileChanges.at(-1).after);

    const hasClaudeLines = counts[CLAUDE] + counts[CLAUDE_EDITED] > 0;
    const claudeDeletedIt = op === 'delete' && deleted;
    if (!hasClaudeLines && !claudeDeletedIt && !binary) continue;

    rows.push({
      file,
      op: binary ? `${op} (binary)` : op,
      tools: unique(fileChanges.map(change => change.tool)),
      ...counts,
    });
  }
  return rows;
}

function sumByCategory(rows) {
  return Object.fromEntries(CATEGORIES.map(category => [category, rows.reduce((sum, row) => sum + row[category], 0)]));
}

function runGitHook(name, args) {
  let repo;
  try {
    repo = openRepo(process.cwd()); // Git runs hooks from the repository root
    if (name === 'pre-commit') preCommit(repo);
    else if (name === 'prepare-commit-msg') prepareCommitMsg(repo, args[0]);
    else if (name === 'post-commit') postCommit(repo);
  } catch (error) {
    logError(repo, error);
    console.error(`claude-audit (${name}): ${error.message} — the commit continues without auditing`);
  }
}

function preCommit(repo) {
  discardStaleReport(repo);

  const staged = new Set(stagedFiles(repo));
  const changes = pendingChanges(readEvents(repo)).filter(change => staged.has(change.file));
  if (changes.length === 0) return;

  const rows = attributeFiles(repo, changes);
  if (rows.length === 0) return;

  const reportedChanges = changes.filter(change => rows.some(row => row.file === change.file));
  const context = collectContext(repo, reportedChanges);
  const totals = sumByCategory(rows);
  const day = commitDay();
  const reportPath = newReportPath(repo, day, context.sessions[0]);

  fs.mkdirSync(path.join(repo.root, REPORT_DIR), { recursive: true });
  fs.writeFileSync(path.join(repo.root, reportPath), renderReport({ day, context, rows, totals }));
  repo.git(['add', '--', reportPath]);
  fs.writeFileSync(repo.handoffFile, JSON.stringify({ report: reportPath, models: context.models, totals }));
}

// Git exports the author date to hooks as "@<epoch> <+hhmm>", already applying --date and GIT_AUTHOR_DATE
function commitDay() {
  const match = /^@(\d+) ([+-])(\d\d)(\d\d)$/.exec(process.env.GIT_AUTHOR_DATE ?? '');
  if (!match) return now().slice(0, 10);
  const [, epoch, sign, hours, minutes] = match;
  const offsetSeconds = (sign === '-' ? -1 : 1) * (hours * 3600 + minutes * 60);
  return new Date((Number(epoch) + offsetSeconds) * 1000).toISOString().slice(0, 10);
}

// An aborted commit leaves its report staged: remove it so it does not end up in this commit
function discardStaleReport(repo) {
  const stale = readJsonFile(repo.handoffFile);
  if (stale && !readFileAtHead(repo, stale.report)) {
    repo.git(['rm', '-q', '--cached', '--ignore-unmatch', '--', stale.report]);
    fs.rmSync(path.join(repo.root, stale.report), { force: true });
  }
  fs.rmSync(repo.handoffFile, { force: true });
}

function collectContext(repo, changes) {
  const events = readEvents(repo);
  const sessions = unique(changes.map(change => change.session_id));

  const promptIds = new Set(changes.map(change => change.prompt_id).filter(Boolean));
  const isRelated = event => (promptIds.size > 0 ? promptIds.has(event.prompt_id) : sessions.includes(event.session_id));

  const prompts = events.filter(event => event.type === 'prompt' && isRelated(event));
  const finalReplies = events.filter(event => event.type === 'stop' && isRelated(event) && event.summary);
  const dates = [...prompts, ...changes].map(event => event.ts).sort();

  return {
    sessions,
    models: process.env.CLAUDE_AUDIT_MODEL ? [process.env.CLAUDE_AUDIT_MODEL] : unique(changes.map(change => change.model)),
    prompts,
    finalReplies,
    commands: unique(changes.filter(change => change.command).map(change => change.command)),
    firstDate: dates[0],
    lastDate: dates.at(-1),
  };
}

function newReportPath(repo, day, sessionId) {
  const base = `${REPORT_DIR}/${day}-${String(sessionId).slice(0, 8)}`;
  let candidate = `${base}.md`;
  for (let n = 2; fs.existsSync(path.join(repo.root, candidate)); n++) candidate = `${base}-${n}.md`;
  return candidate;
}

function prepareCommitMsg(repo, messageFile) {
  const handoff = readJsonFile(repo.handoffFile);
  if (!handoff || !messageFile) return;
  // `git commit --no-verify` skips pre-commit but not this hook: only add trailers if the report is really staged
  if (!stagedFiles(repo).includes(handoff.report)) return;

  const totals = handoff.totals;
  const lines = CATEGORIES.map(category => `${category}=${totals[category]}`).join(', ');
  repo.git([
    'interpret-trailers', '--in-place', '--if-exists', 'replace',
    '--trailer', 'AI-Tool: Claude Code',
    '--trailer', `AI-Model: ${handoff.models.join(', ')}`,
    '--trailer', `AI-Report: ${handoff.report}`,
    '--trailer', `AI-Lines: ${lines}`,
    path.resolve(repo.root, messageFile),
  ]);
}

function postCommit(repo) {
  const handoff = readJsonFile(repo.handoffFile);
  fs.rmSync(repo.handoffFile, { force: true });

  // `git commit -- <path>` commits from a temporary index, so the report is missing from the real one
  if (handoff && readFileAtHead(repo, handoff.report)) repo.git(['add', '--', handoff.report]);

  // A change stays pending while part of it is uncommitted (git add -p)
  const isFullyCommitted = change =>
    normalizeLineEndings(readFileAtHead(repo, change.file)) === normalizeLineEndings(readWorkingFile(repo, change.file));
  const consumedIds = pendingChanges(readEvents(repo)).filter(isFullyCommitted).map(change => change.id);

  if (consumedIds.length > 0) {
    const commit = repo.git(['rev-parse', 'HEAD']).trim();
    appendEvent(repo, { type: 'consumed', ts: now(), commit, ids: consumedIds });
  }
}

function renderReport({ day, context, rows, totals }) {
  const onCommitDay = timestamp => day + timestamp.slice(10);
  const meta = { version: 1, date: onCommitDay(now()), sessions: context.sessions, models: context.models, totals, files: rows };
  const quote = text => text.split('\n').map(line => `> ${line}`).join('\n');
  const inlineCode = text => `\`${text.replace(/`/g, "'").replace(/\n/g, ' ')}\``;

  const out = [];
  out.push(`# AI usage report — ${day}`, '');
  // "--" would close the HTML comment early, so it is escaped
  out.push(`<!-- claude-audit ${JSON.stringify(meta).replace(/--/g, '-\\u002d')} -->`, '');

  out.push(
    '- **Tool:** Claude Code',
    `- **Model(s):** ${context.models.join(', ')}`,
    `- **Session(s):** ${context.sessions.map(session => `\`${session}\``).join(', ')}`,
    `- **Dates:** ${onCommitDay(context.firstDate)} → ${onCommitDay(context.lastDate)}`,
    '',
  );

  out.push('## Prompts', '');
  if (context.prompts.length === 0) out.push('_(not recorded)_', '');
  context.prompts.forEach((prompt, i) => out.push(`${i + 1}. \`${onCommitDay(prompt.ts)}\`\n\n${quote(prompt.prompt)}\n`));

  out.push(
    '## Files',
    '',
    `| File | Operation | Tools | ${CATEGORIES.join(' | ')} |`,
    '|---|---|---|--:|--:|--:|',
  );
  for (const row of rows) {
    out.push(`| \`${row.file}\` | ${row.op} | ${row.tools.join(', ')} | ${row[CLAUDE]} | ${row[CLAUDE_EDITED]} | ${row[HUMAN_OR_UNKNOWN]} |`);
  }
  out.push(
    `| **Total** | | | **${totals[CLAUDE]}** | **${totals[CLAUDE_EDITED]}** | **${totals[HUMAN_OR_UNKNOWN]}** |`,
    '',
    `Lines added in this commit (staged diff). "${HUMAN_OR_UNKNOWN}" means the line cannot be attributed to Claude, not that a person wrote it.`,
    '',
  );

  out.push(
    '## Summary of work done',
    '',
    `- ${rows.length} file(s) touched by Claude; ${totals[CLAUDE]} Claude line(s) unchanged and ${totals[CLAUDE_EDITED]} edited afterwards.`,
  );
  if (context.commands.length > 0) {
    out.push('- Terminal commands run by Claude that changed files:');
    for (const command of context.commands) out.push(`  - ${inlineCode(command)}`);
  }
  if (context.finalReplies.length > 0) {
    out.push('', '### Claude\'s final reply in each turn', '');
    for (const reply of context.finalReplies) out.push(`${quote(reply.summary)}\n`);
  }

  out.push(
    '',
    '## Human verification',
    '',
    '- [ ] I have reviewed the AI-generated code',
    '- [ ] I have run the tests',
    '- [ ] The design decisions are my own',
    '',
    '**Notes:**',
    '',
  );
  return out.join('\n');
}

function parseReport(text) {
  const match = text.match(/<!-- claude-audit (.*?) -->/);
  if (!match) return null;
  const verification = text.slice(text.indexOf('## Human verification'));
  const checkboxes = verification.match(/^- \[[ xX]\]/gm) ?? [];
  return {
    meta: JSON.parse(match[1]),
    checkboxes: checkboxes.length,
    checked: checkboxes.filter(box => /x/i.test(box)).length,
  };
}

function status(repo) {
  const pending = pendingChanges(readEvents(repo));
  if (pending.length === 0) {
    console.log('No pending Claude changes.');
    return;
  }
  console.log(`${pending.length} Claude change(s) pending commit:`);
  for (const [file, changes] of Map.groupBy(pending, change => change.file)) {
    const tools = unique(changes.map(change => change.tool)).join(', ');
    console.log(`  ${file}  (${changes.length} event(s): ${tools}; last ${changes.at(-1).ts})`);
  }
}

function report(repo) {
  const dir = path.join(repo.root, REPORT_DIR);
  const fileNames = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.md')) : [];
  if (fileNames.length === 0) {
    console.log(`No reports in ${REPORT_DIR}/.`);
    return;
  }

  const reports = [];
  for (const fileName of fileNames) {
    const parsed = parseReport(fs.readFileSync(path.join(dir, fileName), 'utf8'));
    if (parsed) reports.push({ fileName, ...parsed });
  }
  // Sorting by name would put "-2.md" before ".md"
  reports.sort((a, b) => a.meta.date.localeCompare(b.meta.date));

  const totals = Object.fromEntries(CATEGORIES.map(category => [category, 0]));
  for (const { meta } of reports) {
    for (const category of CATEGORIES) totals[category] += meta.totals[category] ?? 0;
  }
  const allLines = CATEGORIES.reduce((sum, category) => sum + totals[category], 0) || 1;
  const percent = category => `${((100 * totals[category]) / allLines).toFixed(1)}%`;
  const fullyVerified = reports.filter(r => r.checkboxes > 0 && r.checked === r.checkboxes).length;

  const out = [
    '# Global AI usage summary',
    '',
    `- Reports: ${reports.length} (fully verified: ${fullyVerified})`,
    `- Sessions: ${unique(reports.flatMap(r => r.meta.sessions)).length}`,
    `- Models: ${unique(reports.flatMap(r => r.meta.models)).join(', ')}`,
    `- Lines: ${CATEGORIES.map(category => `${category} ${totals[category]} (${percent(category)})`).join(', ')}`,
    '',
    `| Report | Model(s) | ${CATEGORIES.join(' | ')} | Verification |`,
    '|---|---|--:|--:|--:|--:|',
  ];
  for (const { fileName, meta, checked, checkboxes } of reports) {
    const counts = CATEGORIES.map(category => meta.totals[category] ?? 0).join(' | ');
    out.push(`| ${fileName} | ${meta.models.join(', ')} | ${counts} | ${checked}/${checkboxes} |`);
  }
  console.log(out.join('\n'));
}

function doctor(repo) {
  let allPassed = true;
  const check = (passed, label, hint = '') => {
    const suffix = !passed && hint ? ` — ${hint}` : '';
    console.log(`${passed ? '✔' : '✘'} ${label}${suffix}`);
    if (!passed) allPassed = false;
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check(nodeMajor >= 21, `Node ${process.versions.node}`, 'Node >= 21 is required (Map.groupBy)');

  const hooksPath = run('git', ['config', 'core.hooksPath'], { cwd: repo.root, okExitCodes: [0, 1] }).trim();
  check(hooksPath === '.githooks', `core.hooksPath = ${hooksPath || '(unset)'}`, 'run: git config core.hooksPath .githooks');
  for (const name of GIT_HOOKS) {
    const hookPath = path.join(repo.root, '.githooks', name);
    const exists = fs.existsSync(hookPath);
    const executable = exists && (process.platform === 'win32' || (fs.statSync(hookPath).mode & 0o111) !== 0);
    check(exists && executable, `.githooks/${name}`, exists ? `not executable: chmod +x .githooks/${name}` : 'file missing');
  }

  const settings = readJsonFile(path.join(repo.root, '.claude', 'settings.json'));
  check(Boolean(settings), '.claude/settings.json is valid');
  const callsClaudeAudit = group =>
    (group.hooks ?? []).some(hook => [hook.command, ...(hook.args ?? [])].join(' ').includes('claude-audit.mjs'));
  const matcherCovers = (matcher, tool) => matcher === '*' || matcher.split(/[|,\s]+/).includes(tool);

  for (const event of CLAUDE_HOOK_EVENTS) {
    const matchers = (settings?.hooks?.[event] ?? []).filter(callsClaudeAudit).map(group => group.matcher ?? '*');
    const isToolEvent = event.includes('ToolUse');
    const requiredTools = isToolEvent ? ['Edit', 'Write', 'Bash'] : [];
    const missingTools = requiredTools.filter(tool => !matchers.some(matcher => matcherCovers(matcher, tool)));

    const label = isToolEvent ? `hook ${event} (${matchers.join(' ; ')})` : `hook ${event}`;
    const hint = matchers.length === 0 ? 'not configured' : `missing matchers: ${missingTools.join(', ')}`;
    check(matchers.length > 0 && missingTools.length === 0, label, hint);
  }

  try {
    fs.accessSync(repo.auditDir, fs.constants.W_OK);
    check(true, `storage ${path.relative(repo.root, repo.auditDir)}`);
  } catch {
    check(false, 'storage', `cannot write to ${repo.auditDir}`);
  }
  const errorLines = fs.existsSync(repo.errorsFile)
    ? fs.readFileSync(repo.errorsFile, 'utf8').split('\n').filter(line => /^\d{4}-/.test(line))
    : [];
  check(errorLines.length === 0, `logged errors: ${errorLines.length}`, errorLines.at(-1));

  process.exitCode = allPassed ? 0 : 1;
}

const [command, ...args] = process.argv.slice(2);
const cliCommands = { status, report, doctor };

if (command === 'hook') {
  await runClaudeHook();
} else if (command === 'git-hook') {
  runGitHook(args[0], args.slice(1));
} else if (cliCommands[command]) {
  cliCommands[command](openRepo(process.cwd()));
} else {
  console.log('Usage: node tools/claude-audit.mjs <status|report|doctor>');
  process.exitCode = command ? 1 : 0;
}
