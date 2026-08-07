/**
 * settingsAdvisor.js — offline "advisor" that turns your own trade record into
 * concrete Settings suggestions. No external service, no API key, no cost.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY a rules engine instead of an LLM: every input here is numeric (P&L, exit
 * reason, entry hour, streak length). A deterministic rule that says "the 09:00
 * hour lost ₹4,200 over 11 trades → raise GAPS_ENTRY_START" is reproducible,
 * auditable, free, and cannot hallucinate a setting key that doesn't exist.
 *
 * WHAT it reads: exactly the trade set /edge-analytics renders — the same
 * per-strategy session files as /consolidation (paper) and /live-consolidation
 * (live), via edgeAnalytics.loadAllTrades(). Reusing that loader is what stops
 * the page and the advisor drifting apart. Read-only: this module never touches
 * a trade file and never mutates process.env — it only ever SUGGESTS a change,
 * so acting on a finding stays a manual Settings save with the usual audit trail.
 *
 * WHAT it writes: one small snapshot at ~/trading-data/.advisor_report.json,
 * refreshed by the weekly job (Sunday 08:00 IST) so the page can show "as of
 * last Sunday" alongside the live recompute.
 *
 * Every finding is sample-gated. A rule that fires on 3 trades is noise, so each
 * bucket rule needs MIN_BUCKET trades and the per-strategy rules need
 * ADVISOR_MIN_TRADES (default 20) before anything is reported at all.
 */

const fs   = require("fs");
const path = require("path");
const { enabledStrategies } = require("./sharedNav");

const DATA_DIR    = path.join(require("os").homedir(), "trading-data");
const REPORT_FILE = path.join(DATA_DIR, ".advisor_report.json");

// Weekly job fires Sunday 08:00 IST — the market is shut, the week's trades are
// all on disk, and the user has the whole day to act before Monday's open.
const RUN_DAY  = 0; // Sunday (IST)
const RUN_HOUR = 8;

// A bucket (exit reason / hour / weekday / side) needs at least this many trades
// before it is allowed to produce a finding. Deliberately not configurable:
// below ~5 the sign of a bucket's net P&L is essentially a coin flip.
const MIN_BUCKET = 5;

/**
 * Per-strategy Settings keys a finding can point at. Every key here exists in
 * routes/settings.js — findings name real keys so the user can search for them
 * in the Settings page. BB_RSI and PA have no *_LIVE_ENABLED key (their live
 * engines are native routes, not the harness), hence no `live` entry.
 *
 * `lossStreak` and `slPause` are deliberately separate: a streak brake counts
 * LOSSES and stops/skips the day, while *_SL_PAUSE_CANDLES is a cool-off measured
 * in CANDLES after a stop. Advising "lower it to 3" against the wrong one of those
 * two would tell the user to change a setting that does something else entirely.
 */
const MODE_KEYS = {
  EMA_RSI_ST: {
    entryStart: "TRADE_ENTRY_START", entryEnd: "TRADE_ENTRY_END",
    maxDailyLoss: "MAX_DAILY_LOSS", maxDailyTrades: "MAX_DAILY_TRADES",
    lossStreak: "EMA_RSI_ST_MAX_CONSEC_LOSSES", slPause: "EMA_RSI_ST_SL_PAUSE_CANDLES",
    stopLoss: "EMA_RSI_ST_STOP_LOSS_PTS", live: "EMA_RSI_ST_LIVE_ENABLED",
  },
  BB_RSI: {
    entryStart: "BB_RSI_ENTRY_START", entryEnd: "BB_RSI_ENTRY_END",
    maxDailyLoss: "BB_RSI_MAX_DAILY_LOSS", maxDailyTrades: "BB_RSI_MAX_DAILY_TRADES",
    slPause: "BB_RSI_SL_PAUSE_CANDLES", stopLoss: "BB_RSI_STOP_LOSS_PTS",
  },
  PA: {
    entryStart: "PA_ENTRY_START", entryEnd: "PA_ENTRY_END",
    maxDailyLoss: "PA_MAX_DAILY_LOSS", maxDailyTrades: "PA_MAX_DAILY_TRADES",
    slPause: "PA_SL_PAUSE_CANDLES",
  },
  ORB: {
    entryEnd: "ORB_ENTRY_END", forcedExit: "ORB_FORCED_EXIT",
    maxDailyLoss: "ORB_MAX_DAILY_LOSS", maxDailyTrades: "ORB_MAX_DAILY_TRADES",
    lossStreak: "ORB_LOSS_STREAK_SKIP", live: "ORB_LIVE_ENABLED",
  },
  EMA9VWAP: {
    entryStart: "EMA9VWAP_ENTRY_START", entryEnd: "EMA9VWAP_ENTRY_END",
    maxDailyLoss: "EMA9VWAP_MAX_DAILY_LOSS", maxDailyTrades: "EMA9VWAP_MAX_DAILY_TRADES",
    slPause: "EMA9VWAP_SL_PAUSE_CANDLES", stopLoss: "EMA9VWAP_STOP_LOSS_PTS",
    live: "EMA9VWAP_LIVE_ENABLED",
  },
  TREND_PB: {
    entryStart: "TREND_PB_ENTRY_START", entryEnd: "TREND_PB_ENTRY_END",
    forcedExit: "TREND_PB_FORCED_EXIT", timeStop: "TREND_PB_TIME_STOP_CANDLES",
    maxDailyLoss: "TREND_PB_MAX_DAILY_LOSS", maxDailyTrades: "TREND_PB_MAX_DAILY_TRADES",
    lossStreak: "TREND_PB_LOSS_STREAK_SKIP", live: "TREND_PB_LIVE_ENABLED",
  },
  GAPS: {
    entryStart: "GAPS_ENTRY_START", entryEnd: "GAPS_ENTRY_END",
    forcedExit: "GAPS_FORCED_EXIT",
    maxDailyLoss: "GAPS_MAX_DAILY_LOSS", maxDailyTrades: "GAPS_MAX_DAILY_TRADES",
    lossStreak: "GAPS_LOSS_STREAK_SKIP", live: "GAPS_LIVE_ENABLED",
  },
};

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── small helpers ────────────────────────────────────────────────────────────

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function istDateStr(d) {
  return (d || new Date()).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** YYYY-MM-DD `days` before today (IST). */
function daysAgoStr(days) {
  const d = istNow();
  d.setDate(d.getDate() - days);
  // d is already a wall-clock IST Date, so read its own fields (not toLocaleDateString,
  // which would re-apply the IST offset to an already-shifted value).
  const m = d.getMonth() + 1, day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function inr(n) {
  const v = Math.round(n);
  return `${v < 0 ? "-" : ""}₹${Math.abs(v).toLocaleString("en-IN")}`;
}

/**
 * Entry/exit timestamps are written in several shapes across the engines:
 * "DD/MM/YYYY, HH:MM:SS", "HH:MM, DD/MM/YYYY", and ISO "…THH:MM:SSZ".
 * Only the ISO form carries a timezone, so it is shifted to IST; the other two
 * are already IST wall-clock and the first HH:MM in the string is the time (the
 * date half never contains a colon). Returns minutes past midnight, or null.
 */
function minutesOfDay(raw) {
  const v = String(raw || "");
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (isNaN(d)) return null;
    const ist = new Date(d.getTime() + 19800000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }
  const m = v.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function entryHour(t) {
  const m = minutesOfDay(t.entryTime);
  return m === null ? null : Math.floor(m / 60);
}

/** Held minutes for one trade, or null when either timestamp is unusable. */
function heldMinutes(t) {
  const a = minutesOfDay(t.entryTime), b = minutesOfDay(t.exitTime);
  if (a === null || b === null) return null;
  const d = b - a;
  return d >= 0 ? d : null; // intraday only — a negative diff means a bad parse
}

function weekday(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T12:00:00`);
  return isNaN(d) ? null : d.getDay();
}

/** Core P&L stats for one trade array. */
function stats(list) {
  let net = 0, grossWin = 0, grossLoss = 0, wins = 0, losses = 0;
  for (const t of list) {
    const p = t.pnl;
    net += p;
    if (p > 0)      { wins++;   grossWin  += p; }
    else if (p < 0) { losses++; grossLoss += -p; }
  }
  const n = list.length;
  return {
    n, net, wins, losses, grossWin, grossLoss,
    winRate: n ? (wins / n) * 100 : 0,
    expectancy: n ? net / n : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
  };
}

/** Map key → { key, n, net, wins }. Null/undefined keys are skipped. */
function bucket(list, keyFn) {
  const m = new Map();
  for (const t of list) {
    const k = keyFn(t);
    if (k === null || k === undefined || k === "") continue;
    if (!m.has(k)) m.set(k, { key: k, n: 0, net: 0, wins: 0 });
    const g = m.get(k);
    g.n++; g.net += t.pnl; if (t.pnl > 0) g.wins++;
  }
  return m;
}

/** Map key → array of trades. */
function groupList(list, keyFn) {
  const m = new Map();
  for (const t of list) {
    const k = keyFn(t);
    if (k === null || k === undefined || k === "") continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return m;
}

/**
 * Longest run of losses WITHIN a single session. The daily-loss and streak
 * brakes all reset at the open, so a run measured across the whole window would
 * compare a multi-day figure against a per-day setting and advise nonsense.
 */
function maxIntradayLossStreak(list) {
  let best = 0;
  for (const day of groupList(list, t => t.date).values()) {
    let run = 0;
    for (const t of day) {
      if (t.pnl < 0) { run++; if (run > best) best = run; }
      else if (t.pnl > 0) run = 0;
    }
  }
  return best;
}

/** Worst single-day net loss (a positive rupee figure; 0 when no losing day). */
function worstDay(list) {
  let worst = { date: null, net: 0 };
  for (const g of bucket(list, t => t.date).values()) {
    if (g.net < worst.net) worst = { date: g.key, net: g.net };
  }
  return { date: worst.date, loss: worst.net < 0 ? -worst.net : 0 };
}

function envKeyValue(key) {
  if (!key) return null;
  const v = process.env[key];
  return v === undefined || v === "" ? null : String(v);
}

/**
 * Which setting an exit reason points at. Exit-reason strings are free text and
 * differ per engine, so this matches on intent words rather than exact strings —
 * an unmatched reason still produces a finding, just without a named key.
 */
function keysForExitReason(reason, K) {
  const r = String(reason).toLowerCase();
  if (/stop\s*loss|hard\s*stop|\bsl\b/.test(r))          return { keys: [K.stopLoss].filter(Boolean), hint: "the stop is being hit before the move develops — widen it, or tighten entry quality" };
  if (/time\s*stop|flat|stagnan/.test(r))                return { keys: [K.timeStop, "TIME_STOP_CANDLES", "TIME_STOP_FLAT_PTS"].filter(Boolean), hint: "trades are being timed out at a loss — review the time-stop window" };
  if (/eod|square|forced|15:1|15:3/.test(r))             return { keys: [K.forcedExit, K.entryEnd].filter(Boolean), hint: "positions are still open at the close — stop entering this late" };
  if (/trail/.test(r))                                   return { keys: [], hint: "the trail is giving back open profit — review the trail step" };
  if (/reversal|flip|opposite|re-?entry|signal/.test(r)) return { keys: [], hint: "the signal is flipping against the position — this is an entry-quality issue, not an exit one" };
  if (/target|profit/.test(r))                           return { keys: [], hint: "unexpected: a target exit should not be net negative — check the fill logic" };
  return { keys: [], hint: "review what this exit path is doing" };
}

// ── the rules ────────────────────────────────────────────────────────────────

/**
 * All findings for one strategy. Ordered by how much money each rule is about,
 * so the caller can present the expensive problems first.
 * @returns {Array<{id,mode,severity,title,detail,suggestion,keys}>}
 */
function findingsForMode(mode, label, list, minTrades) {
  const K = MODE_KEYS[mode] || {};
  const s = stats(list);
  const out = [];
  const add = (id, severity, title, detail, suggestion, keys = []) =>
    out.push({ id, mode, modeLabel: label, severity, title, detail, suggestion, keys: keys.filter(Boolean) });

  // Nothing is tunable on a sample this small — say so and stop, rather than
  // inventing findings from noise.
  if (s.n < minTrades) {
    add("sample", "info",
      `${label}: ${s.n} trade${s.n === 1 ? "" : "s"} — too few to tune`,
      `Needs at least ${minTrades} trades in the window before any suggestion is trustworthy.`,
      `Keep collecting paper sessions. Nothing to change yet.`);
    return out;
  }

  // R1 — is there an edge at all? Everything else is secondary to this.
  const pf = s.profitFactor;
  if (pf < 1) {
    add("no-edge", "high",
      `${label}: no edge yet — profit factor ${pf.toFixed(2)}`,
      `${s.n} trades, ${s.winRate.toFixed(0)}% win rate, net ${inr(s.net)} (${inr(s.expectancy)} per trade). ` +
      `It won ${inr(s.grossWin)} and lost ${inr(s.grossLoss)}.`,
      K.live
        ? `Do not turn on ${K.live}. Fix the biggest losing bucket in this list first, then collect a fresh clean sample.`
        : `Keep this strategy on paper. Fix the biggest losing bucket in this list first, then collect a fresh clean sample.`,
      [K.live]);
  } else if (pf < 1.2) {
    add("thin-edge", "medium",
      `${label}: thin edge — profit factor ${pf.toFixed(2)}`,
      `${s.n} trades, net ${inr(s.net)} (${inr(s.expectancy)} per trade). A profit factor under 1.2 does not survive costs and slippage.`,
      `Treat this as break-even. Cut the worst bucket in this list before adding size.`);
  }

  // R2 — which exit path is doing the bleeding (top 2 worst).
  // Only asked of a strategy that is NOT clearly working: in a healthy strategy
  // the stop-loss bucket is supposed to hold ~all of the losses, so flagging it
  // there would be flagging the design working as intended.
  if (pf < 1.5) {
    const reasons = [...bucket(list, t => t.exitReason || "—").values()]
      .filter(g => g.n >= MIN_BUCKET && g.net < 0 && s.grossLoss > 0 && -g.net >= s.grossLoss * 0.25)
      .sort((a, b) => a.net - b.net)
      .slice(0, 2);
    for (const g of reasons) {
      const share = (-g.net / s.grossLoss) * 100;
      const { keys, hint } = keysForExitReason(g.key, K);
      add(`exit-${g.key}`, (share >= 40 && s.net < 0) ? "high" : "medium",
        `${label}: "${g.key}" exits lost ${inr(-g.net)}`,
        `${g.n} trades exited this way, ${(g.wins / g.n * 100).toFixed(0)}% of them green, ` +
        `net ${inr(g.net)} — that is ${share.toFixed(0)}% of everything this strategy lost.`,
        `${hint}${keys.length ? ` — check ${keys.join(", ")}.` : "."}`,
        keys);
    }
  }

  // R3 — a losing time-of-day at the edge of the entry window is the cheapest
  // fix available: move the window, keep every other rule untouched.
  const hours = [...bucket(list, entryHour).values()].filter(g => g.n >= MIN_BUCKET);
  if (hours.length >= 2) {
    const worst   = hours.slice().sort((a, b) => a.net - b.net)[0];
    const earliest = Math.min(...hours.map(g => g.key));
    const latest   = Math.max(...hours.map(g => g.key));
    if (worst.net < 0) {
      const hh      = String(worst.key).padStart(2, "0");
      const isFirst = worst.key === earliest;
      const isLast  = worst.key === latest;
      // An edge hour is only actionable if this strategy actually has a key for
      // that edge — ORB, for one, has no entry-START key (its window opens off
      // the opening range), so "move the start" would name a setting that does
      // not exist, and "it sits mid-window" would be plainly wrong.
      let suggestion, keys;
      if (isFirst && K.entryStart) {
        suggestion = `It is the first hour you trade — try moving ${K.entryStart} to ${String(worst.key + 1).padStart(2, "0")}:00 and re-check next week.`;
        keys = [K.entryStart];
      } else if (isLast && K.entryEnd) {
        suggestion = `It is the last hour you trade — try moving ${K.entryEnd} back to ${hh}:00 and re-check next week.`;
        keys = [K.entryEnd];
      } else if (isFirst || isLast) {
        suggestion = `It is the ${isFirst ? "first" : "last"} hour you trade, but this strategy has no entry-window setting for that edge — the window is set by the strategy's own rules. Note it and watch whether it repeats.`;
        keys = [];
      } else {
        suggestion = `It sits mid-window, so it cannot be cut without losing the hours around it. Watch it rather than changing the window.`;
        keys = [];
      }
      add(`hour-${worst.key}`, "medium",
        `${label}: the ${hh}:00 hour lost ${inr(-worst.net)}`,
        `${worst.n} entries in that hour, ${(worst.wins / worst.n * 100).toFixed(0)}% green, net ${inr(worst.net)}.`,
        suggestion, keys);
    }
  }

  // R4 — a one-sided book usually means the signal only works with the trend.
  const sides = bucket(list, t => String(t.side || "").toUpperCase());
  const ce = sides.get("CE"), pe = sides.get("PE");
  if (ce && pe && ce.n >= 8 && pe.n >= 8 && Math.sign(ce.net) !== Math.sign(pe.net)) {
    const bad  = ce.net < pe.net ? ce : pe;
    const good = ce.net < pe.net ? pe : ce;
    add("side-skew", "info",
      `${label}: ${bad.key} trades lose, ${good.key} trades win`,
      `${bad.key}: ${bad.n} trades, net ${inr(bad.net)}. ${good.key}: ${good.n} trades, net ${inr(good.net)}.`,
      `The edge is directional over this window. Do not hard-disable one side on this alone — one trending stretch can produce this. Re-check next week before acting.`);
  }

  // R5 — weekday drag (expiry day is the usual suspect on option buying).
  const worstDow = [...bucket(list, t => weekday(t.date)).values()]
    .filter(g => g.n >= MIN_BUCKET)
    .sort((a, b) => a.net - b.net)[0];
  if (worstDow && worstDow.net < 0 && -worstDow.net > s.grossLoss * 0.3) {
    add(`dow-${worstDow.key}`, "info",
      `${label}: ${DOW[worstDow.key]}s lost ${inr(-worstDow.net)}`,
      `${worstDow.n} trades on ${DOW[worstDow.key]}s, net ${inr(worstDow.net)} — ${((-worstDow.net / s.grossLoss) * 100).toFixed(0)}% of total losses.`,
      `If that is your weekly expiry day, theta decay is the usual explanation. There is no weekday switch in Settings — note it and watch whether it repeats.`);
  }

  // R6 — the daily-loss cap is the one guard that limits a bad day. If a real
  // day blew past it, the cap is either too loose or was not applied.
  const wd  = worstDay(list);
  const cap = num(envKeyValue(K.maxDailyLoss), null);
  if (wd.loss > 0 && cap !== null && cap > 0 && wd.loss > cap * 1.15) {
    add("cap-not-binding", "high",
      `${label}: worst day lost ${inr(wd.loss)} but the cap is ${inr(cap)}`,
      `${wd.date} closed at ${inr(-wd.loss)} — ${(wd.loss / cap).toFixed(1)}× the ${K.maxDailyLoss} limit.`,
      `A cap only stops the NEXT entry, so one big open trade can still overshoot it. If the gap is large, lower ${K.maxDailyLoss} or ${K.maxDailyTrades}.`,
      [K.maxDailyLoss, K.maxDailyTrades]);
  }

  // R7 — did anything brake a losing run inside one session? A streak brake
  // (*_MAX_CONSEC_LOSSES / *_LOSS_STREAK_SKIP) counts losses and stops the day;
  // *_SL_PAUSE_CANDLES is only a cool-off in candles after a stop. Different
  // settings, so different advice — never suggest one in the other's language.
  const runLen = maxIntradayLossStreak(list);
  if (runLen >= 4) {
    // Branch on which key the strategy HAS first, then on its value. Ordering it
    // the other way round let a strategy that owns both keys (EMA_RSI_ST) fall
    // through to the slPause branch whenever its brake was roughly holding — and
    // that branch's text claims the strategy has no streak brake at all.
    if (K.lossStreak) {
      const brake = num(envKeyValue(K.lossStreak), 0);
      if (brake <= 0) {
        add("loss-streak", "medium",
          `${label}: ${runLen} losses in a row in one session, with no streak brake`,
          `${K.lossStreak} is off, so a chop day runs until the daily-loss cap or the clock stops it.`,
          `Set ${K.lossStreak} to 3 — the day then stops after three straight losses instead of grinding on.`,
          [K.lossStreak]);
      } else if (runLen >= brake + 2) {
        add("loss-streak", "medium",
          `${label}: ${runLen} losses in a row in one session`,
          `${K.lossStreak} is set to ${brake}, yet a single session still ran to ${runLen} straight losses.`,
          `The brake is not stopping the day where you set it — check it is actually being applied by this engine before changing anything else.`,
          [K.lossStreak]);
      }
      // brake set and roughly holding (runLen < brake + 2) → nothing to say.
    } else if (K.slPause) {
      const pause = num(envKeyValue(K.slPause), 0);
      add("loss-streak", "medium",
        `${label}: ${runLen} losses in a row in one session`,
        `This strategy has no streak brake — the only cool-off is ${K.slPause} (currently ${pause || "0"} candle${pause === 1 ? "" : "s"} after a stop).`,
        `Raise ${K.slPause} so re-entries are spaced further apart in chop, and lean on ${K.maxDailyLoss || "the daily loss cap"} to end the day.`,
        [K.slPause, K.maxDailyLoss]);
    }
  }

  // R8 — holding losers much longer than winners is the classic "cut losers" tell.
  const winHold = [], lossHold = [];
  for (const t of list) {
    const h = heldMinutes(t);
    if (h === null) continue;              // unparseable timestamps — skip, don't guess
    if (t.pnl > 0)      winHold.push(h);
    else if (t.pnl < 0) lossHold.push(h);  // scratches tell us nothing about holding discipline
  }
  if (winHold.length >= 8 && lossHold.length >= 8) {
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const aw = avg(winHold), al = avg(lossHold);
    if (al > aw * 1.5) {
      add("hold-asymmetry", "medium",
        `${label}: losers held ${Math.round(al)} min vs winners ${Math.round(aw)} min`,
        `Averaged over ${lossHold.length} losers and ${winHold.length} winners — losers are held ${(al / aw).toFixed(1)}× longer.`,
        `A trade that has not worked within the winners' window rarely recovers. Tighten ${K.timeStop || "TIME_STOP_CANDLES"} / TIME_STOP_FLAT_PTS to cut flat trades sooner.`,
        [K.timeStop || "TIME_STOP_CANDLES", "TIME_STOP_FLAT_PTS"]);
    }
  }

  return out;
}

// ── public analysis entry point ──────────────────────────────────────────────

const SEVERITY_RANK = { high: 0, medium: 1, info: 2 };

/**
 * Analyse the recorded trade book and produce settings findings.
 * Pure: reads trade files + process.env, writes nothing.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.book='paper']    'paper' | 'live'
 * @param {number}  [opts.lookbackDays]    default ADVISOR_LOOKBACK_DAYS or 90
 * @param {number}  [opts.minTrades]       default ADVISOR_MIN_TRADES or 20
 */
function analyze(opts = {}) {
  const book         = opts.book === "live" ? "live" : "paper";
  const lookbackDays = clamp(Math.round(num(opts.lookbackDays, num(process.env.ADVISOR_LOOKBACK_DAYS, 90))), 7, 3650);
  const minTrades    = clamp(Math.round(num(opts.minTrades,    num(process.env.ADVISOR_MIN_TRADES, 20))), 5, 500);

  const from = daysAgoStr(lookbackDays);
  const to   = istDateStr();

  // Required lazily: edgeAnalytics.js pulls in sharedNav, and requiring it at
  // module load would make the util → route → util chain load-order sensitive.
  const { loadAllTrades } = require("../routes/edgeAnalytics");

  // Disabled strategies are hidden from the sidebar, so they must not generate
  // advice either. Re-read per call — Settings saves mutate process.env live.
  const enabled    = enabledStrategies();
  const enabledSet = new Set(enabled.map(s => s.mode));

  let all = [];
  try {
    all = loadAllTrades().filter(t =>
      t.book === book && enabledSet.has(t.mode) && t.date >= from && t.date <= to);
  } catch (err) {
    console.warn(`[advisor] could not load trades: ${err.message}`);
  }

  const perMode  = [];
  const findings = [];
  for (const s of enabled) {
    const list = all.filter(t => t.mode === s.mode);
    if (!list.length) continue; // a strategy that never traded in the window is not a finding
    const st = stats(list);
    perMode.push({
      mode: s.mode, label: s.label,
      trades: st.n, net: Math.round(st.net),
      winRate: +st.winRate.toFixed(1),
      expectancy: Math.round(st.expectancy),
      profitFactor: st.profitFactor === Infinity ? null : +st.profitFactor.toFixed(2),
      maxLossStreak: maxIntradayLossStreak(list), // per-session, to match the brakes
    });
    findings.push(...findingsForMode(s.mode, s.label, list, minTrades));
  }

  findings.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
                          a.modeLabel.localeCompare(b.modeLabel));
  perMode.sort((a, b) => a.net - b.net); // worst first — that is where the work is

  const totals = stats(all);
  return {
    generatedAt: new Date().toISOString(),
    book, lookbackDays, minTrades,
    window: { from, to },
    totals: {
      trades: totals.n, net: Math.round(totals.net),
      winRate: +totals.winRate.toFixed(1),
      profitFactor: totals.profitFactor === Infinity ? null : +totals.profitFactor.toFixed(2),
    },
    counts: {
      high:   findings.filter(f => f.severity === "high").length,
      medium: findings.filter(f => f.severity === "medium").length,
      info:   findings.filter(f => f.severity === "info").length,
    },
    perMode,
    findings,
  };
}

// ── weekly snapshot ──────────────────────────────────────────────────────────

/**
 * Key for the current weekly period: the date of the most recent Sunday 08:00
 * IST. Comparing the stored key against this one makes the weekly run idempotent
 * across restarts without needing to remember a timer.
 */
function currentPeriodKey() {
  const now = istNow();
  const d = new Date(now);
  d.setDate(d.getDate() - d.getDay());       // back to this week's Sunday
  d.setHours(RUN_HOUR, 0, 0, 0);
  if (d > now) d.setDate(d.getDate() - 7);   // before Sunday 08:00 → previous week
  const m = d.getMonth() + 1, day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

function readReport() {
  try { return JSON.parse(fs.readFileSync(REPORT_FILE, "utf8")); }
  catch (_) { return null; }
}

function writeReport(report) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a truncated report.
    const tmp = `${REPORT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report));
    fs.renameSync(tmp, REPORT_FILE);
  } catch (err) {
    console.warn(`[advisor] could not persist report: ${err.message}`);
  }
}

function telegramSummary(report) {
  const lines = [
    `🧭 Weekly Settings Advisor`,
    `Window: ${report.window.from} → ${report.window.to} (${report.book})`,
    `${report.totals.trades} trades · net ${inr(report.totals.net)} · PF ${report.totals.profitFactor ?? "∞"}`,
    ``,
  ];
  const top = report.findings.filter(f => f.severity !== "info").slice(0, 5);
  if (!top.length) lines.push(`No action items this week.`);
  for (const f of top) lines.push(`${f.severity === "high" ? "🔴" : "🟠"} ${f.title}\n   → ${f.suggestion}`);
  lines.push(``, `Full report: /advisor`);
  return lines.join("\n");
}

/** Recompute, persist, and (optionally) Telegram. Returns the report. */
function runWeekly() {
  const report = analyze();
  report.periodKey = currentPeriodKey();
  writeReport(report);
  console.log(`[advisor] weekly report ready — ${report.findings.length} findings ` +
              `(${report.counts.high} high, ${report.counts.medium} medium) over ${report.totals.trades} trades.`);

  if (String(process.env.ADVISOR_TELEGRAM || "false").toLowerCase() === "true") {
    try { require("./notify").sendIfMaster(telegramSummary(report)); }
    catch (err) { console.warn(`[advisor] telegram send failed: ${err.message}`); }
  }
  return report;
}

/** Run only if this week's snapshot has not been taken yet. */
function maybeRunForPeriod() {
  const key   = currentPeriodKey();
  const saved = readReport();
  if (saved && saved.periodKey === key) return;
  runWeekly();
}

let _timer = null;

function msUntilNextRun() {
  const now    = istNow();
  const target = new Date(now);
  const ahead  = (RUN_DAY - now.getDay() + 7) % 7;
  target.setDate(target.getDate() + ahead);
  target.setHours(RUN_HOUR, 0, 0, 0);
  let delta = target.getTime() - now.getTime();
  if (delta <= 0) delta += 7 * 24 * 60 * 60 * 1000;
  return delta;
}

function scheduleNext() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    try { maybeRunForPeriod(); }
    catch (err) { console.error(`[advisor] weekly run failed: ${err.message}`); }
    scheduleNext();
  }, msUntilNextRun());
  if (_timer.unref) _timer.unref();
}

/** Boot hook: catch up on a missed week (redeploys are frequent), then schedule. */
function start() {
  try { maybeRunForPeriod(); }
  catch (err) { console.error(`[advisor] boot catch-up failed: ${err.message}`); }
  scheduleNext();
}

module.exports = { analyze, runWeekly, readReport, start, MODE_KEYS };
