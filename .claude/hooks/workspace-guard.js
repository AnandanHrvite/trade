#!/usr/bin/env node
/**
 * Workspace guard: this session may only touch the trade repo.
 * Denies any file tool or Bash command that reaches outside PROJECT_DIR.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = fs.realpathSync(
  process.env.CLAUDE_PROJECT_DIR || '/Users/anandankaliamurthy/Applications/Node/trade'
);

// Paths the session legitimately needs outside the repo.
const ALLOW_PREFIXES = [
  PROJECT_DIR,
  process.env.HOME + '/trading-data',
  process.env.HOME + '/.claude/projects/-Users-anandankaliamurthy-Applications-Node-trade',
  '/private/tmp/claude-501/-Users-anandankaliamurthy-Applications-Node-trade',
  '/tmp/claude-501/-Users-anandankaliamurthy-Applications-Node-trade',
];

// Other workspaces that must never be touched from this session.
const DENY_HINTS = [
  '/Users/anandankaliamurthy/Applications/Angular',
  '/Users/anandankaliamurthy/Applications/Node/HrviteV2API',
];

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function isAllowed(p) {
  let abs = path.resolve(PROJECT_DIR, p);
  // Resolve symlinks on the nearest existing ancestor.
  let probe = abs;
  while (probe !== path.dirname(probe) && !fs.existsSync(probe)) probe = path.dirname(probe);
  try {
    abs = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  } catch (_) { /* keep the resolved path */ }
  return ALLOW_PREFIXES.some((base) => abs === base || abs.startsWith(base + path.sep));
}

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(input); } catch (_) { process.exit(0); }

  const tool = payload.tool_name || '';
  const args = payload.tool_input || {};

  // File tools: check the explicit path argument.
  const filePath = args.file_path || args.path || args.notebook_path;
  if (filePath && !isAllowed(filePath)) {
    deny(`Blocked: ${filePath} is outside the trade workspace (${PROJECT_DIR}). This session only works on the trade folder. Ask the user to open the other project in its own Claude session.`);
  }

  // Bash: block absolute paths and other-workspace names in the command text.
  if (tool === 'Bash') {
    const cmd = String(args.command || '');
    for (const hint of DENY_HINTS) {
      if (cmd.includes(hint)) {
        deny(`Blocked: command references ${hint}, another workspace. This session only works on the trade folder.`);
      }
    }
    const absPaths = cmd.match(/(?<![\w=:])\/(?:Users|Applications|opt|srv|var\/www)\/[^\s'"`;|&)]+/g) || [];
    for (const p of absPaths) {
      if (!isAllowed(p)) {
        deny(`Blocked: command touches ${p}, outside the trade workspace (${PROJECT_DIR}). This session only works on the trade folder.`);
      }
    }
  }

  process.exit(0);
});
