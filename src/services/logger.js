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

function capture(level, args) {
  const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

  const entry = {
    id:    Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    time:  nowIST.toLocaleTimeString("en-IN",  { hour12: false }),
    date:  nowIST.toLocaleDateString("en-IN"),
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
  if (logStore.length > MAX_LOGS) logStore.splice(0, logStore.length - MAX_LOGS);

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
