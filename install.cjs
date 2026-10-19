// CommonJS on purpose: `curl ... | node` runs stdin as CommonJS on every Node version.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = 'miguelmartinezmestre/claude-audit';
const TOOL = 'tools/claude-audit.mjs';
const GIT_HOOKS = ['.githooks/pre-commit', '.githooks/prepare-commit-msg', '.githooks/post-commit'];
const SETTINGS = '.claude/settings.json';

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
const callsClaudeAudit = group => JSON.stringify(group).includes('claude-audit.mjs');

// Run as a file from a clone: copy the files next to it. Piped from curl: download the latest release.
async function readSource(file) {
  if (fs.existsSync(__filename)) return fs.readFileSync(path.join(__dirname, file), 'utf8');
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${await latestTag()}/${file}`);
  if (!response.ok) throw new Error(`could not download ${file}: HTTP ${response.status}`);
  return response.text();
}

let tag;
async function latestTag() {
  if (tag) return tag;
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!response.ok) throw new Error(`could not find the latest release: HTTP ${response.status}`);
  tag = (await response.json()).tag_name;
  console.log(`Installing claude-audit ${tag}`);
  return tag;
}

function mergeSettings(current, ours) {
  current.hooks ??= {};
  const added = [];
  for (const [event, groups] of Object.entries(ours.hooks)) {
    const existing = (current.hooks[event] ??= []);
    if (existing.some(callsClaudeAudit)) continue;
    existing.push(...groups);
    added.push(event);
  }
  return added;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 21) throw new Error(`Node >= 21 is required, this is ${process.versions.node}`);
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0) throw new Error('run this from inside a Git repository');
  const root = top.stdout.trim();
  const target = file => path.join(root, file);
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(target(file)), { recursive: true });
    fs.writeFileSync(target(file), content);
  };

  write(TOOL, await readSource(TOOL));
  console.log(`+ ${TOOL}`);

  for (const hook of GIT_HOOKS) {
    if (fs.existsSync(target(hook)) && !fs.readFileSync(target(hook), 'utf8').includes('claude-audit')) {
      console.log(`! ${hook} already exists and is not from claude-audit: left untouched, call claude-audit from it (see README)`);
      continue;
    }
    write(hook, await readSource(hook));
    fs.chmodSync(target(hook), 0o755);
    console.log(`+ ${hook}`);
  }

  const ours = JSON.parse(await readSource(SETTINGS));
  if (!fs.existsSync(target(SETTINGS))) {
    write(SETTINGS, JSON.stringify(ours, null, 2) + '\n');
    console.log(`+ ${SETTINGS}`);
  } else {
    let current;
    try {
      current = JSON.parse(fs.readFileSync(target(SETTINGS), 'utf8'));
    } catch {
      throw new Error(`${SETTINGS} is not valid JSON: fix it and run the installer again`);
    }
    const added = mergeSettings(current, ours);
    if (added.length > 0) write(SETTINGS, JSON.stringify(current, null, 2) + '\n');
    console.log(added.length > 0 ? `~ ${SETTINGS}: added hooks for ${added.join(', ')}` : `= ${SETTINGS}: hooks already present`);
  }

  const hooksPath = git('-C', root, 'config', 'core.hooksPath').stdout.trim();
  if (!hooksPath) {
    git('-C', root, 'config', 'core.hooksPath', '.githooks');
    console.log('+ git config core.hooksPath .githooks');
  } else if (hooksPath !== '.githooks') {
    console.log(`! core.hooksPath is already "${hooksPath}": left untouched, call the claude-audit hooks from there (see README)`);
  }

  console.log('');
  spawnSync(process.execPath, [target(TOOL), 'doctor'], { cwd: root, stdio: 'inherit' });
  console.log(`
Next steps:
  git add ${TOOL} .githooks ${SETTINGS}
  git commit -m "chore: add claude-audit"
Restart Claude Code if it is open. Everyone who clones the repository must run once:
  git config core.hooksPath .githooks`);
}

main().catch(error => {
  console.error(`claude-audit install failed: ${error.message}`);
  process.exitCode = 1;
});
