#!/usr/bin/env node
// PostToolUse hook: when a strategy's engine or route file is edited, remind
// Claude to record the change in that strategy's notes file.
// Notes live in src/strategies/notes/<file>.md — one per strategy.

const rules = [
  { name: 'BB_RSI',     notes: 'bb_rsi.md',       re: /^(bb_rsi\.js|bbRsi\w*\.js)$/ },
  { name: 'EMA9_VWAP',  notes: 'ema9_vwap.md',    re: /^(ema9_vwap\.js|ema9vwap\w*\.js)$/ },
  { name: 'Gaps',       notes: 'gaps.md',         re: /^gaps\w*\.js$/ },
  { name: 'ORB',        notes: 'orb.md',          re: /^(orb_breakout\.js|orbExits\.js|orb[A-Z]\w*\.js)$/ },
  { name: 'PA',         notes: 'price_action.md', re: /^(price_action\.js|pa[A-Z]\w*\.js)$/ },
  { name: 'EMA_RSI_ST', notes: 'ema_rsi_st.md',   re: /^(strategy1_sar_ema_rsi\.js|emaRsiSt\w*\.js)$/ },
  { name: 'Trend_PB',   notes: 'trend_pb.md',     re: /^(trend_pb\.js|trendPb\w*\.js)$/ },
];

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let file = '';
  try {
    const j = JSON.parse(raw || '{}');
    file = (j.tool_input && j.tool_input.file_path) || '';
  } catch (_) { /* no-op */ }

  const base = file.split('/').pop() || '';
  // Never fire on edits to the notes files themselves.
  if (file.includes('/src/strategies/notes/')) return process.exit(0);

  const hit = rules.find((r) => r.re.test(base));
  if (!hit) return process.exit(0);

  const msg =
    `You edited a ${hit.name} file (${base}). Before finishing this task, ` +
    `append a dated one-line bullet describing this change to ` +
    `src/strategies/notes/${hit.notes} (newest on top). Only update that one notes file.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
  }));
  process.exit(0);
});
