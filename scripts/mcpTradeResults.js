#!/usr/bin/env node
/**
 * mcpTradeResults.js — a read-only MCP server over the trade results.
 *
 * Why: the trade logs can only be read through the web UI. This exposes the same
 * records as MCP tools so an AI client (Claude Code / Desktop) can answer "how did
 * BB_RSI do last week?" without anyone opening a dashboard or pasting JSONL.
 *
 * Two sources, same tools (see the source block below): the running app on EC2 via
 * its /trade-logs API when TRADE_MCP_URL is set — which is the point, since the real
 * trades live on the box — or this machine's ~/trading-data/ when it isn't.
 *
 * It is READ-ONLY by construction: it requires tradeLogger/aiExport, calls only GET
 * endpoints, and loads no broker module. It cannot place, modify or cancel an order,
 * nor start or stop a session. Keep it that way.
 *
 * Protocol: MCP over stdio, JSON-RPC 2.0, newline-delimited. Hand-rolled rather
 * than via @modelcontextprotocol/sdk so this adds no dependency and still runs on
 * the Node 16 the EC2 deploy pins.
 *
 * Register against the box with:
 *   claude mcp add trade-results \
 *     -e TRADE_MCP_URL=https://<ec2-ip>:3000 \
 *     -e TRADE_MCP_SECRET=<the box's LOGIN_SECRET> \
 *     -e TRADE_MCP_INSECURE=1 \
 *     -- node <repo>/scripts/mcpTradeResults.js
 */

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const tradeLogger = require("../src/utils/tradeLogger");
const aiExport = require("../src/utils/aiExport");

const PROTOCOL_VERSION = "2024-11-05";
const MODES = Object.keys(tradeLogger.DAILY_PREFIX_BY_MODE);

// ---------------------------------------------------------------- source
//
// Two sources, same tools. Set TRADE_MCP_URL to read the running app (EC2)
// over its /trade-logs API; leave it unset to read this machine's
// ~/trading-data/ directly. The remote source is what makes this useful — the
// real trades live on the box, not on the laptop.
//
//   TRADE_MCP_URL     e.g. https://<ec2-ip>:3000
//   TRADE_MCP_SECRET  the box's LOGIN_SECRET (only if its login gate is on)
//   TRADE_MCP_INSECURE=1  accept the box's self-signed cert
//
// Reads only. Every endpoint used here is a GET; nothing below can start,
// stop or change a session.
const REMOTE_URL = (process.env.TRADE_MCP_URL || "").replace(/\/+$/, "");
const REMOTE = !!REMOTE_URL;

/** The app's cookie is a plain sha256 of LOGIN_SECRET — mint it, don't POST /login. */
function authCookie() {
  const s = process.env.TRADE_MCP_SECRET;
  if (!s) return null;
  return `__trade_login=${crypto.createHash("sha256").update(s).digest("hex")}`;
}

// Any TLS-trust failure has the same remedy, and the box's cert is both
// self-signed and (being long-lived) eventually expired — so match the whole
// family rather than just the self-signed codes.
const TLS_TRUST_ERRORS = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** GET one JSON endpoint on the remote app. Rejects with a readable message. */
function getJson(pathAndQuery) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(REMOTE_URL + pathAndQuery); }
    catch (_) { return reject(new Error(`TRADE_MCP_URL is not a valid URL: "${REMOTE_URL}"`)); }

    const cookie = authCookie();
    const opts = {
      headers: {
        // Explicitly NOT text/html: the login gate redirects HTML requests but
        // returns a clean 401 for API ones, which is the error we want to show.
        accept: "application/json",
        ...(cookie ? { cookie } : {}),
      },
      timeout: 20000,
      // The box serves a self-signed cert on :3000, so verification fails by
      // default. Opt in explicitly rather than disabling it silently.
      ...(u.protocol === "https:" && process.env.TRADE_MCP_INSECURE === "1"
        ? { rejectUnauthorized: false }
        : {}),
    };

    const req = (u.protocol === "https:" ? https : http).get(u, opts, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 302) {
          return reject(new Error(
            "the app rejected the request (login gate). Set TRADE_MCP_SECRET to the box's LOGIN_SECRET."
          ));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`${u.pathname} returned HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error(`${u.pathname} did not return JSON (got ${body.slice(0, 80)}…)`)); }
      });
    });

    req.on("timeout", () => req.destroy(new Error(`timed out after 20s calling ${REMOTE_URL}`)));
    req.on("error", (err) => reject(new Error(
      TLS_TRUST_ERRORS.has(err.code)
        ? `the app's certificate is not trusted (${err.code}) — set TRADE_MCP_INSECURE=1 to accept it.`
        : `cannot reach ${REMOTE_URL}: ${err.message}`
    )));
  });
}

/** Dates that have logs for a mode, newest first. Local disk or remote app. */
async function sourceDates(mode) {
  if (!REMOTE) return tradeLogger.listDailyDates(mode).map((d) => d.date);
  // No ?page → the route returns every date unpaged (parsePaging returns null
  // only when `page` is absent), so a long history is never truncated.
  const j = await getJson(`/trade-logs/list?mode=${encodeURIComponent(mode)}`);
  const rows = (j && (j.files || j.rows || j.dates)) || [];
  return rows.map((r) => (typeof r === "string" ? r : r.date)).filter(Boolean);
}

/** Raw records (trades AND settings snapshots) for one mode+date. */
async function sourceRecords(mode, date) {
  if (!REMOTE) return tradeLogger.readDailyTrades(mode, date);
  // Same rule as above: omit ?page and /view returns the whole day.
  const j = await getJson(
    `/trade-logs/view?mode=${encodeURIComponent(mode)}&date=${encodeURIComponent(date)}`
  );
  return (j && j.trades) || [];
}

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
async function readRange(mode, from, to) {
  assertMode(mode);
  const dates = (await sourceDates(mode))
    .filter((d) => (!from || d >= from) && (!to || d <= to));

  const out = [];
  for (const date of dates) {
    const recs = await sourceRecords(mode, date);
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
    async handler() {
      const rows = [];
      for (const mode of MODES) {
        const dates = await sourceDates(mode);
        rows.push({
          mode,
          days: dates.length,
          latest: dates.length ? dates[0] : null,
          earliest: dates.length ? dates[dates.length - 1] : null,
        });
      }
      rows.sort((a, b) => b.days - a.days);
      return { source: REMOTE ? REMOTE_URL : "local ~/trading-data", modes: rows };
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
    async handler({ mode }) {
      assertMode(mode);
      return { mode, dates: await sourceDates(mode) };
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
    async handler({ mode, from, to, limit }) {
      const all = await readRange(mode, from, to);
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
    async handler({ mode, from, to, groupBy }) {
      const trades = await readRange(mode, from, to);
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
    async handler({ from, to }) {
      const rows = [];
      for (const mode of MODES) {
        const trades = await readRange(mode, from, to);
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
    async handler({ mode, date }) {
      assertMode(mode);
      const { snapshots } = aiExport.splitRecords(await sourceRecords(mode, date));
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
    async handler({ mode, from, to }) {
      assertMode(mode);
      const dates = (await sourceDates(mode))
        .filter((d) => (!from || d >= from) && (!to || d <= to));
      // Feed aiExport the raw records (trades AND snapshots) — it splits them
      // itself and needs the snapshots for its Settings section.
      const recs = [];
      for (const date of dates) recs.push(...(await sourceRecords(mode, date)));
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
      // Handlers are async (the remote source does HTTP), so resolve the
      // promise here — returning it unawaited would serialise "{}" and a
      // rejection would become an unhandled rejection that kills the server.
      return Promise.resolve()
        .then(() => tool.handler((params && params.arguments) || {}))
        .then((out) => {
          const text = typeof out.markdown === "string" ? out.markdown : JSON.stringify(out, null, 1);
          reply(id, { content: [{ type: "text", text }] });
        })
        .catch((err) => {
          // Tool failures come back as isError content, not a JSON-RPC error,
          // so the model can read the message and correct its arguments.
          reply(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
        });
    }

    case "ping":
      return reply(id, {});

    default:
      if (isNotification) return;
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

// In-flight tool calls. A remote read is async, so stdin can reach EOF while
// requests are still waiting on HTTP — exiting there would drop their replies.
const inFlight = new Set();

let buf = "";
let stdinEnded = false;
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
      const p = handle(msg);
      // handle() returns a promise only for tools/call; track it so EOF waits.
      if (p && typeof p.then === "function") {
        inFlight.add(p);
        p.finally(() => {
          inFlight.delete(p);
          if (stdinEnded) drain();
        });
      }
    } catch (err) {
      if (msg && msg.id != null) replyError(msg.id, -32603, err.message);
    }
  }
});

/** Exit only once every reply has been written. */
function drain() {
  if (inFlight.size === 0) process.exit(0);
}

process.stdin.on("end", () => {
  stdinEnded = true;
  drain();
});
