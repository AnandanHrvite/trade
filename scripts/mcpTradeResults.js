#!/usr/bin/env node
/**
 * mcpTradeResults.js — a read-only MCP server over the trade results already on disk.
 *
 * Why: the trade logs in ~/trading-data/ can only be read through the web UI. This
 * exposes the same records as MCP tools so an AI client (Claude Code / Desktop) can
 * answer "how did BB_RSI do last week?" without anyone opening a dashboard.
 *
 * It is READ-ONLY by construction: it requires tradeLogger/aiExport and touches
 * nothing else. It cannot place, modify or cancel an order — no broker module is
 * loaded here, and that is deliberate. Keep it that way.
 *
 * Protocol: MCP over stdio, JSON-RPC 2.0, newline-delimited. Hand-rolled rather
 * than via @modelcontextprotocol/sdk so this adds no dependency and still runs on
 * the Node 16 the EC2 deploy pins.
 *
 * Register with:
 *   claude mcp add trade-results -- node <repo>/scripts/mcpTradeResults.js
 */

const tradeLogger = require("../src/utils/tradeLogger");
const aiExport = require("../src/utils/aiExport");

const PROTOCOL_VERSION = "2024-11-05";
const MODES = Object.keys(tradeLogger.DAILY_PREFIX_BY_MODE);

// ---------------------------------------------------------------- helpers

const num = (v) => (typeof v === "number" && isFinite(v) ? v : Number(v) || 0);
const r2 = (v) => Math.round(num(v) * 100) / 100;

/** Validate a mode name up front so every tool reports the same clear error. */
function assertMode(mode) {
  if (!MODES.includes(mode)) {
    throw new Error(`unknown mode "${mode}". Known modes: ${MODES.join(", ")}`);
  }
}

/**
 * Read trades for one mode across a date range (inclusive), newest date first.
 * Dates absent from disk are skipped silently — a day with no session is not an
 * error. settings_snapshot lines are filtered out; only real trades come back.
 */
function readRange(mode, from, to) {
  assertMode(mode);
  const dates = tradeLogger
    .listDailyDates(mode)
    .map((d) => d.date)
    .filter((d) => (!from || d >= from) && (!to || d <= to));

  const out = [];
  for (const date of dates) {
    const recs = tradeLogger.readDailyTrades(mode, date);
    const { trades } = aiExport.splitRecords(recs);
    for (const t of trades) out.push({ date, ...t });
  }
  return out;
}

/** Win rate / net / profit factor over a flat list of trades. */
function statsOf(trades) {
  const wins = trades.filter((t) => num(t.pnl) > 0);
  const losses = trades.filter((t) => num(t.pnl) < 0);
  const net = trades.reduce((a, t) => a + num(t.pnl), 0);
  const grossWin = wins.reduce((a, t) => a + num(t.pnl), 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + num(t.pnl), 0));
  const decided = wins.length + losses.length;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    // Scratches (pnl exactly 0) are excluded from the denominator so a flat
    // trade neither helps nor hurts the win rate.
    winPct: decided ? r2((wins.length / decided) * 100) : 0,
    net: r2(net),
    avgWin: wins.length ? r2(grossWin / wins.length) : 0,
    avgLoss: losses.length ? r2(-grossLoss / losses.length) : 0,
    // Infinity is not valid JSON, so an all-wins set reports null, not a number.
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    bestTrade: trades.length ? r2(Math.max(...trades.map((t) => num(t.pnl)))) : 0,
    worstTrade: trades.length ? r2(Math.min(...trades.map((t) => num(t.pnl)))) : 0,
  };
}

/** Group trades by a field and return per-group stats, worst net last. */
function groupStats(trades, key) {
  const by = new Map();
  for (const t of trades) {
    const k = String(t[key] == null || t[key] === "" ? "(none)" : t[key]);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  return [...by.entries()]
    .map(([k, list]) => ({ [key]: k, ...statsOf(list) }))
    .sort((a, b) => b.net - a.net);
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: "list_modes",
    description:
      "List every strategy whose trade results are on disk, with how many days of logs each has and its newest date. Call this first to learn valid mode names.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler() {
      const rows = MODES.map((mode) => {
        const dates = tradeLogger.listDailyDates(mode);
        return {
          mode,
          days: dates.length,
          latest: dates.length ? dates[0].date : null,
          earliest: dates.length ? dates[dates.length - 1].date : null,
        };
      }).sort((a, b) => b.days - a.days);
      return { modes: rows };
    },
  },

  {
    name: "list_dates",
    description:
      "List the dates that have trade logs for one strategy, newest first.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", description: "Strategy key, e.g. bb_rsi." } },
      required: ["mode"],
      additionalProperties: false,
    },
    handler({ mode }) {
      assertMode(mode);
      return { mode, dates: tradeLogger.listDailyDates(mode).map((d) => d.date) };
    },
  },

  {
    name: "get_trades",
    description:
      "Return the individual trades for one strategy over a date range (inclusive). Use for detail; use summarise_results for aggregates.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Strategy key, e.g. orb." },
        from: { type: "string", description: "Start date YYYY-MM-DD. Omit for earliest." },
        to: { type: "string", description: "End date YYYY-MM-DD. Omit for latest." },
        limit: { type: "number", description: "Max trades to return (default 200)." },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    handler({ mode, from, to, limit }) {
      const all = readRange(mode, from, to);
      // Cap the payload so a wide range cannot blow up the client's context;
      // `returned < total` is the caller's signal to narrow the range.
      // Only an omitted limit takes the default — an explicit 0 must stay 0,
      // which `num(limit) || 200` would have silently turned into 200.
      const cap = limit == null ? 200 : Math.max(0, Math.min(num(limit), 1000));
      return { mode, from: from || null, to: to || null, total: all.length, returned: Math.min(cap, all.length), trades: all.slice(0, cap) };
    },
  },

  {
    name: "summarise_results",
    description:
      "Win rate, net P&L, profit factor and average win/loss for one strategy over a date range. Optionally break the numbers down per day, per exit reason or per side (CE/PE).",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Strategy key, e.g. ema_rsi_st." },
        from: { type: "string", description: "Start date YYYY-MM-DD." },
        to: { type: "string", description: "End date YYYY-MM-DD." },
        groupBy: {
          type: "string",
          enum: ["date", "exitReason", "side"],
          description: "Optional breakdown dimension.",
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    handler({ mode, from, to, groupBy }) {
      const trades = readRange(mode, from, to);
      const res = { mode, from: from || null, to: to || null, overall: statsOf(trades) };
      if (groupBy) res.breakdown = groupStats(trades, groupBy);
      return res;
    },
  },

  {
    name: "compare_modes",
    description:
      "Compare every strategy's results over the same date range, best net P&L first. Use to answer which strategy is performing best.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD." },
        to: { type: "string", description: "End date YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    handler({ from, to }) {
      const rows = [];
      for (const mode of MODES) {
        const trades = readRange(mode, from, to);
        // Strategies that did not trade in the window add only noise.
        if (!trades.length) continue;
        rows.push({ mode, ...statsOf(trades) });
      }
      rows.sort((a, b) => b.net - a.net);
      return { from: from || null, to: to || null, modes: rows };
    },
  },

  {
    name: "get_settings_snapshot",
    description:
      "Return the settings that were in force for a strategy on a given day, as recorded in that day's log. Use to check which config produced a day's results.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Strategy key." },
        date: { type: "string", description: "Date YYYY-MM-DD." },
      },
      required: ["mode", "date"],
      additionalProperties: false,
    },
    handler({ mode, date }) {
      assertMode(mode);
      const { snapshots } = aiExport.splitRecords(tradeLogger.readDailyTrades(mode, date));
      return {
        mode,
        date,
        count: snapshots.length,
        snapshots: snapshots.map((s) => ({
          capturedAt: s.capturedAt,
          reason: s.reason,
          note: s.note,
          changedKeys: s.changedKeys,
          settings: s.settings,
        })),
      };
    },
  },

  {
    name: "export_markdown",
    description:
      "Render a strategy's trades over a date range as the app's AI-friendly Markdown report (summary + field legend + settings + trade tables). Use when you want the full annotated record rather than raw JSON.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Strategy key." },
        from: { type: "string", description: "Start date YYYY-MM-DD." },
        to: { type: "string", description: "End date YYYY-MM-DD." },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    handler({ mode, from, to }) {
      assertMode(mode);
      const dates = tradeLogger
        .listDailyDates(mode)
        .map((d) => d.date)
        .filter((d) => (!from || d >= from) && (!to || d <= to));
      // Feed aiExport the raw records (trades AND snapshots) — it splits them
      // itself and needs the snapshots for its Settings section.
      const recs = [];
      for (const date of dates) recs.push(...tradeLogger.readDailyTrades(mode, date));
      const title = `${mode} trades ${from || "start"} → ${to || "latest"}`;
      return { markdown: aiExport.buildMarkdown(recs, { title }) };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------- JSON-RPC

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;
  // A notification (no id) never gets a response — replying to one is a
  // protocol violation that some clients treat as fatal.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "trade-results", version: "1.0.0" },
      });

    case "notifications/initialized":
      return;

    case "tools/list":
      return reply(
        id,
        { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
      );

    case "tools/call": {
      const tool = TOOL_BY_NAME.get(params && params.name);
      if (!tool) return replyError(id, -32602, `unknown tool "${params && params.name}"`);
      try {
        const out = tool.handler((params && params.arguments) || {});
        const text = typeof out.markdown === "string" ? out.markdown : JSON.stringify(out, null, 1);
        return reply(id, { content: [{ type: "text", text }] });
      } catch (err) {
        // Tool failures come back as isError content, not a JSON-RPC error, so
        // the model can read the message and correct its arguments.
        return reply(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
    }

    case "ping":
      return reply(id, {});

    default:
      if (isNotification) return;
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      // Un-parseable line: no id to answer with, so drop it rather than guess.
      continue;
    }
    try {
      handle(msg);
    } catch (err) {
      if (msg && msg.id != null) replyError(msg.id, -32603, err.message);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
