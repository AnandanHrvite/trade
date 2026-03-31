/**
 * logger.js — Global console interceptor + in-memory log store
 * ─────────────────────────────────────────────────────────────
 * Must be required ONCE at the very top of app.js before anything else.
 * After that, every console.log/info/warn/error anywhere in the app is:
 *   (a) Still printed to PM2 / terminal as normal
 *   (b) Stored in logStore (rolling buffer of MAX_LOGS entries)
 *   (c) Broadcast live to any connected SSE clients via logEvents
 */

const EventEmitter = require("events");

const MAX_LOGS  = 5000; // rolling buffer — prevents unbounded memory growth on long sessions
const logStore  = [];
const logEvents = new EventEmitter();
logEvents.setMaxListeners(100); // allow many simultaneous SSE browser tabs

const LEVEL_MAP = {
  log:   "LOG",
  info:  "INFO",
  warn:  "WARN",
  error: "ERROR",
};

// ── Store originals before we override ───────────────────────────────────────
const _orig = {
  log:   console.log.bind(console),
  info:  console.info.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
};

// Fast IST formatter: avoids expensive toLocaleString/ICU on every console.log call
// UTC+5:30 = +19800 seconds = +19800000 milliseconds
function _fastIST(nowMs) {
  const ist   = new Date(nowMs + 19800000); // shift UTC date by IST offset
  const h     = ist.getUTCHours();
  const m     = ist.getUTCMinutes();
  const s     = ist.getUTCSeconds();
  const dd    = ist.getUTCDate();
  const mm    = ist.getUTCMonth() + 1;
  const yyyy  = ist.getUTCFullYear();
  return {
    time: (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s,
    date: (dd < 10 ? "0" : "") + dd + "/" + (mm < 10 ? "0" : "") + mm + "/" + yyyy,
  };
}

function capture(level, args) {
  const nowMs = Date.now();
  const ist   = _fastIST(nowMs);

  const entry = {
    id:    nowMs + "_" + Math.random().toString(36).slice(2, 6),
    time:  ist.time,
    date:  ist.date,
    level,
    msg: args
      .map(a => {
        if (a === null)            return "null";
        if (a === undefined)       return "undefined";
        if (a instanceof Error)    return a.stack || a.message;
        if (typeof a === "object") {
          try { return JSON.stringify(a, null, 2); } catch { return String(a); }
        }
        return String(a);
      })
      .join(" "),
  };

  logStore.push(entry);
  // Trim in batches of 500 to amortize the O(n) splice cost (instead of every single overflow)
  if (logStore.length > MAX_LOGS + 500) logStore.splice(0, logStore.length - MAX_LOGS);

  logEvents.emit("log", entry);
  return entry;
}

// ── Override all four console methods ────────────────────────────────────────
["log", "info", "warn", "error"].forEach(method => {
  console[method] = (...args) => {
    _orig[method](...args);                    // still prints to PM2/terminal
    capture(LEVEL_MAP[method], args);          // capture + broadcast
  };
});

module.exports = { logStore, logEvents };
