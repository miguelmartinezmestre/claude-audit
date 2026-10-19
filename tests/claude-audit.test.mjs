// Integration tests: temporary repo + hook JSON input on stdin, as Claude Code sends it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SRC = path.resolve(import.meta.dirname, '..');
const MODEL = 'claude-opus-5-5';
const repos = [];

// Hooks swallow errors so they never break anything: check here that there were none
after(() => {
  for (const repo of repos) {
    const log = path.join(repo, '.git/claude-audit/errors.log');
    assert.ok(!fs.existsSync(log), fs.existsSync(log) && fs.readFileSync(log, 'utf8'));
  }
});

function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-')));
  repos.push(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '.githooks');
  for (const f of ['tools/claude-audit.mjs', '.githooks/pre-commit', '.githooks/prepare-commit-msg', '.githooks/post-commit']) {
    fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), path.join(repo, f));
    if (process.platform !== 'win32') fs.chmodSync(path.join(repo, f), 0o755);
  }
  const transcript = path.join(repo, '.git', 'fake-transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', message: { model: MODEL, role: 'assistant', content: [] } },
    { type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  let n = 0;
  const hook = (input) => {
    const r = spawnSync('node', [path.join(repo, 'tools/claude-audit.mjs'), 'hook'], {
      input: JSON.stringify({ session_id: 'sess-1234abcd', prompt_id: 'p1', transcript_path: transcript, cwd: repo, ...input }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'hooks must not write to stdout');
  };
  const file = (rel) => path.join(repo, rel);
  const write = (rel, text) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), text); };
  // Simulates a Claude tool call: PreToolUse -> effect -> PostToolUse
  const tool = (tool_name, tool_input, effect, post = 'PostToolUse') => {
    const tool_use_id = `toolu_${++n}`;
    hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id });
    effect();
    hook({ hook_event_name: post, tool_name, tool_input, tool_use_id, tool_response: {} });
  };
  const claudeWrite = (rel, text) => tool('Write', { file_path: file(rel), content: text }, () => write(rel, text));
  const claudeEdit = (rel, old_string, new_string) => tool('Edit', { file_path: file(rel), old_string, new_string, replace_all: false }, () =>
    write(rel, fs.readFileSync(file(rel), 'utf8').replace(old_string, new_string)));
  const claudeBash = (command, effect, post) => tool('Bash', { command, description: 'test' }, effect, post);
  const prompt = (text, prompt_id = 'p1') => hook({ hook_event_name: 'UserPromptSubmit', prompt: text, prompt_id });
  const lastMsg = () => git('log', '-1', '--format=%B');
  const trailers = () => git('log', '-1', '--format=%(trailers:only,unfold)').trim();
  const cli = (...args) => execFileSync('node', ['tools/claude-audit.mjs', ...args], { cwd: repo, encoding: 'utf8' });
  hook({ hook_event_name: 'SessionStart', source: 'startup' });
  return { repo, git, hook, write, file, claudeWrite, claudeEdit, claudeBash, prompt, lastMsg, trailers, cli };
}

const lines = (...xs) => xs.map(x => x + '\n').join('');

test('a) Claude creates a file: correct report and trailers; prompts redacted', () => {
  const r = makeRepo();
  r.prompt('Create src/a.mjs. My token is ghp_abcdefghijklmnopqrstuvwxyz0123 and password=hunter2');
  r.claudeWrite('src/a.mjs', lines('export const a = 1;', 'export const b = 2;', 'export const c = 3;'));
  r.hook({ hook_event_name: 'Stop', last_assistant_message: 'I created src/a.mjs with three constants.' });
  r.git('add', 'src/a.mjs');
  r.git('commit', '-q', '-m', 'feat: a');

  const t = r.trailers();
  assert.match(t, /^AI-Tool: Claude Code$/m);
  assert.match(t, new RegExp(`^AI-Model: ${MODEL}$`, 'm'));
  assert.match(t, /^AI-Lines: claude=3, code-by-claude-edited-by-human=0, human\/unknown=0$/m);
  const report = t.match(/^AI-Report: (.+)$/m)[1];
  assert.match(report, /^docs\/ai-audit\/\d{4}-\d{2}-\d{2}-sess-123\.md$/);
  assert.ok(r.git('show', '--name-only', '--format=', 'HEAD').split('\n').includes(report), 'the report is part of the commit');

  const md = fs.readFileSync(r.file(report), 'utf8');
  for (const s of [MODEL, 'sess-1234abcd', '| `src/a.mjs` | create | Write | 3 | 0 | 0 |', 'I created src/a.mjs', '## Human verification', '- [ ] I have run the tests', '**Notes:**']) {
    assert.ok(md.includes(s), `missing from the report: ${s}`);
  }
  for (const where of [md, fs.readFileSync(path.join(r.repo, '.git/claude-audit/events.jsonl'), 'utf8')]) {
    assert.ok(!where.includes('ghp_abcdef') && !where.includes('hunter2'), 'secrets must be redacted');
  }
  assert.equal(r.git('status', '--porcelain', '--', 'docs', 'src'), '');
  assert.match(r.cli('status'), /No pending Claude changes/);
  assert.match(r.cli('report'), /Reports: 1 .*\n[\s\S]*claude 3 \(100\.0%\)/);

  // commit aborted from the editor: its report must not sneak into the next one
  r.claudeWrite('src/b.mjs', lines('export const b = 1;'));
  r.git('add', 'src/b.mjs');
  assert.equal(spawnSync('git', ['commit', '-q', '-e', '-m', 'x'], { cwd: r.repo, env: { ...process.env, GIT_EDITOR: 'false' } }).status, 1);
  r.git('commit', '-q', '-m', 'feat: b');
  assert.equal(r.git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(f => f.startsWith('docs/')).length, 1);
  assert.equal(fs.readdirSync(r.file('docs/ai-audit')).length, 2);
});

test('b) Claude edits and a human changes one of its lines before committing: code-by-claude-edited-by-human', () => {
  const r = makeRepo();
  r.write('src/m.mjs', lines('const x = 1;', 'const y = 2;', 'const z = 3;'));
  r.git('add', '.'); r.git('reset', '-q', 'tools', '.githooks'); r.git('commit', '-q', '-m', 'human base');
  assert.equal(r.trailers(), '');

  r.prompt('Change y and add two functions');
  r.claudeEdit('src/m.mjs', 'const y = 2;\n', lines('const y = 20;', 'function f() { return x; }', 'function g() { return z; }'));
  // the human modifies one Claude line and adds one of their own
  r.write('src/m.mjs', fs.readFileSync(r.file('src/m.mjs'), 'utf8').replace('return z;', 'return z * 2;') + 'const human = true;\n');
  r.git('add', 'src/m.mjs');
  r.git('commit', '-q', '-m', 'feat: m');
  assert.match(r.trailers(), /^AI-Lines: claude=2, code-by-claude-edited-by-human=1, human\/unknown=1$/m);
});

test('c) Claude modifies files through Bash (also when the command fails)', () => {
  const r = makeRepo();
  r.write('src/x.mjs', lines('let arr = [1, 2];'));
  r.git('add', 'src/x.mjs'); r.git('commit', '-q', '-m', 'base');

  const script = "const fs=require('fs');fs.writeFileSync('src/x.mjs',fs.readFileSync('src/x.mjs','utf8').replace(/arr/g,'values')+'export default values;\\n')";
  r.claudeBash(`node -e "${script}"`, () => execFileSync('node', ['-e', script], { cwd: r.repo }));
  // a command that creates a file and exits with an error: arrives through PostToolUseFailure
  const failing = "require('fs').writeFileSync('src/y.mjs','export const y = 1;\\n');process.exit(1)";
  r.claudeBash(`node -e "${failing}"`, () => spawnSync('node', ['-e', failing], { cwd: r.repo }), 'PostToolUseFailure');

  assert.match(r.cli('status'), /src\/x\.mjs[\s\S]*src\/y\.mjs/);
  r.git('add', 'src');
  r.git('commit', '-q', '-m', 'refactor: values');
  assert.match(r.trailers(), /^AI-Lines: claude=3, code-by-claude-edited-by-human=0, human\/unknown=0$/m);
  const md = fs.readFileSync(r.file(r.trailers().match(/^AI-Report: (.+)$/m)[1]), 'utf8');
  assert.ok(md.includes('| `src/x.mjs` | modify | Bash | 2 | 0 | 0 |'));
  assert.ok(md.includes('| `src/y.mjs` | create | Bash | 1 | 0 | 0 |'));
  assert.ok(md.includes('node -e'), 'the report lists the command');
});

test('d) partial commit (add -p) and single-file commit: only what is staged counts', () => {
  const r = makeRepo();
  const ten = Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};`);
  r.claudeWrite('src/a.mjs', lines(...ten));
  r.claudeWrite('src/b.mjs', lines('export const b = 1;', 'export const c = 2;'));

  // equivalent to `git add -p` picking only the first 5 lines
  r.write('src/a.mjs', lines(...ten.slice(0, 5)));
  r.git('add', 'src/a.mjs');
  r.write('src/a.mjs', lines(...ten));
  r.git('commit', '-q', '-m', 'partial');
  assert.match(r.trailers(), /^AI-Lines: claude=5, code-by-claude-edited-by-human=0, human\/unknown=0$/m);
  assert.ok(!fs.readFileSync(r.file(r.trailers().match(/^AI-Report: (.+)$/m)[1]), 'utf8').includes('src/b.mjs'));

  // single-file commit with a temporary index (`git commit -- path`), going through the editor
  r.git('add', '-N', 'src/b.mjs'); // `commit -- path` requires git to know the path
  r.git('commit', '-q', '-e', '-m', 'only b', '--', 'src/b.mjs');
  assert.match(r.lastMsg(), /^only b\n\nAI-Tool: Claude Code\n/);
  assert.match(r.trailers(), /^AI-Lines: claude=2, code-by-claude-edited-by-human=0, human\/unknown=0$/m);
  assert.equal(r.git('status', '--porcelain', '--', 'docs'), '', 'the report also ends up in the real index');

  // the rest of a.mjs stays pending and is attributed in the next commit
  r.git('add', 'src/a.mjs');
  r.git('commit', '-q', '-m', 'rest');
  assert.match(r.trailers(), /^AI-Lines: claude=5, code-by-claude-edited-by-human=0, human\/unknown=0$/m);
  assert.match(r.cli('status'), /No pending Claude changes/);
  assert.equal(fs.readdirSync(r.file('docs/ai-audit')).length, 3, 'one report per commit, none overwritten');
  assert.match(r.cli('report'), /Reports: 3/);
});

test('e) commit without Claude changes: no trailers and no report', () => {
  const r = makeRepo();
  r.claudeWrite('src/claude.mjs', lines('export const c = 1;')); // pending, but not staged
  r.write('notes.txt', lines('written by hand'));
  r.git('add', 'notes.txt');
  r.git('commit', '-q', '-m', 'docs: notes');
  assert.equal(r.trailers(), '');
  assert.equal(r.lastMsg().trim(), 'docs: notes');
  assert.ok(!fs.existsSync(r.file('docs/ai-audit')));
  assert.match(r.cli('status'), /src\/claude\.mjs/);
});

test('commit-time overrides: backdated commit keeps the real times; CLAUDE_AUDIT_MODEL replaces the model', () => {
  const r = makeRepo();
  r.prompt('Create src/a.mjs');
  r.claudeWrite('src/a.mjs', lines('export const a = 1;'));
  r.git('add', 'src/a.mjs');
  // 00:30 in +0200 is still the 15th in UTC: the commit's own day must win
  const date = '2026-08-16T00:30:00+0200';
  execFileSync('git', ['commit', '-q', `--date=${date}`, '-m', 'feat: a'], { cwd: r.repo, env: { ...process.env, GIT_COMMITTER_DATE: date, CLAUDE_AUDIT_MODEL: 'claude-sonnet-4-5' } });

  assert.match(r.trailers(), /^AI-Model: claude-sonnet-4-5$/m);
  const report = r.trailers().match(/^AI-Report: (.+)$/m)[1];
  assert.equal(report, 'docs/ai-audit/2026-08-16-sess-123.md');
  const md = fs.readFileSync(r.file(report), 'utf8');
  const realTime = JSON.parse(fs.readFileSync(path.join(r.repo, '.git/claude-audit/events.jsonl'), 'utf8').split('\n')[1]).ts.slice(10);
  assert.ok(!md.includes(MODEL), 'the real model is replaced');
  for (const s of ['# AI usage report — 2026-08-16', '- **Model(s):** claude-sonnet-4-5', `\`2026-08-16${realTime}\``]) assert.ok(md.includes(s), `missing from the report: ${s}`);
  assert.ok(!md.includes(new Date().toISOString().slice(0, 10)), 'no real date left in the report');
});

test('doctor detects an incomplete setup', () => {
  const r = makeRepo();
  const out = spawnSync('node', ['tools/claude-audit.mjs', 'doctor'], { cwd: r.repo, encoding: 'utf8' });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /✔ core\.hooksPath = \.githooks/);
  assert.match(out.stdout, /✘ \.claude\/settings\.json is valid/);
});

test('installer: installs into a repo with its own Claude settings, merging them, and can run again', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-audit-install-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const ownHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [ownHook] } }));

  const install = () => spawnSync('node', [path.join(SRC, 'install.cjs')], { cwd: repo, encoding: 'utf8' });
  assert.equal(install().status, 0);
  const second = install();
  assert.equal(second.status, 0);
  assert.match(second.stdout, /hooks already present/);
  assert.match(second.stdout, /✔ logged errors: 0/);
  assert.doesNotMatch(second.stdout, /✘/);

  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.hooks.PreToolUse[0], ownHook);
  assert.equal(settings.hooks.PreToolUse.length, 3);
  assert.equal(execFileSync('git', ['config', 'core.hooksPath'], { cwd: repo, encoding: 'utf8' }).trim(), '.githooks');
});
