#!/usr/bin/env node
/**
 * oiChainProbe.js — DOES PER-STRIKE OPTION OI ACTUALLY EXIST, AND DOES IT MOVE?
 * ─────────────────────────────────────────────────────────────────────────────
 * This repo has never captured per-strike option Open Interest. The only OI it
 * has ever seen is a single scalar — NIFTY current-month FUTURES OI (oiFilter.js
 * and the futures row in optionChainRecorder.js). optionChainRecorder already
 * polls the ATM±N CE/PE chain every few seconds, but on the OPTION rows it keeps
 * only LTP/bid/ask and discards `oi`.
 *
 * Before building a strike-OI strategy on top of that, two questions have to be
 * answered with real numbers, not assumptions:
 *
 *   Q1  Does Fyers return `oi` on an OPTION quote at all, or only on futures?
 *   Q2  How OFTEN does it change, and by how much? An OI field that refreshes
 *       once every 15 minutes cannot drive a 5-minute writer-unwind signal, no
 *       matter how good the idea is.
 *
 * This script answers both, then tells you which fetch path to build on. It
 * WRITES NOTHING and places NO orders — it is a read-only probe.
 *
 *   node scripts/oiChainProbe.js                 # 10 min, ATM±3, 5s cadence
 *   node scripts/oiChainProbe.js --minutes 30
 *   node scripts/oiChainProbe.js --strikes 5 --interval 10
 *   node scripts/oiChainProbe.js --minutes 0     # one-shot shape dump, then exit
 *
 * Run it DURING MARKET HOURS. Outside them OI is frozen by definition and the
 * cadence numbers are meaningless — the script says so rather than lying.
 *
 * Requires a live Fyers token (~/trading-data/.fyers_token). A stale token is the
 * usual cause of an empty/zero result here (see the repo's zero-candles note).
 * ─────────────────────────────────────────────────────────────────────────────
 */

process.env.TZ = "Asia/Calcutta";
// Pure observer: never let a probe run append rows to today's real recording.
process.env.TICK_RECORDER_ENABLED = "false";
require("dotenv").config();

const path       = require("path");
const fyers      = require(path.join(__dirname, "../src/config/fyers"));
const instrument = require(path.join(__dirname, "../src/config/instrument"));

const STRIKE_STEP          = 50;
const MAX_SYMBOLS_PER_CALL = 50;   // Fyers getQuotes cap — mirrors optionChainRecorder

// ── CLI ──────────────────────────────────────────────────────────────────────
function argNum(flag, dflt, min, max) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i === process.argv.length - 1) return dflt;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, v));
}

const MINUTES     = argNum("--minutes", 10, 0, 360);
const STRIKE_SPAN = argNum("--strikes", 3, 1, 15);
const INTERVAL_S  = argNum("--interval", 5, 2, 60);

const pct = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
const fmtOi = (v) => (v == null ? "—" : v.toLocaleString("en-IN"));

function isMarketHours() {
  // 09:15–15:30 IST, same arithmetic as socketManager/optionChainRecorder.
  const istSec = Math.floor(Date.now() / 1000) + 19800;
  const mins   = Math.floor(istSec / 60) % 1440;
  return mins >= 555 && mins < 930;
}

/**
 * Read OI off a quote row under every field name Fyers has used. Deliberately
 * identical to the extraction already in oiFilter.js / optionChainRecorder.js so
 * this probe cannot pass while production reads nothing.
 */
function extractOi(v) {
  const raw = v.oi ?? v.open_interest ?? v.openInterest;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function resolveExpiryCode() {
  try {
    const ctx  = await instrument.getMarketContext();
    const type = (process.env.OPTION_EXPIRY_TYPE || "weekly").trim().toLowerCase();
    const code = type === "monthly" ? ctx.monthlyExpiryCode : ctx.weeklyExpiryCode;
    if (code) return code;
  } catch (_) { /* fall through to the computed path */ }
  return instrument.getNearestThursdayExpiry();
}

/** One getQuotes sweep of the chain. Returns Map<symbol, {oi, ltp, raw}>. */
async function pollChain(symbols) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += MAX_SYMBOLS_PER_CALL) {
    const batch = symbols.slice(i, i + MAX_SYMBOLS_PER_CALL);
    const resp  = await fyers.getQuotes(batch);
    if (!resp || resp.s !== "ok" || !Array.isArray(resp.d)) {
      throw new Error(`getQuotes failed: s=${resp && resp.s} msg=${(resp && resp.message) || "?"}`);
    }
    for (const row of resp.d) {
      const sym = row.n || row.symbol;
      const v   = row.v || row;
      if (!sym || !v) continue;
      out.set(sym, { oi: extractOi(v), ltp: Number(v.lp || v.ltp || 0), raw: v });
    }
  }
  return out;
}

/**
 * Fallback path: the options-chain-v3 REST endpoint. instrument.js already calls
 * this (with strikecount=1) but parses only the expiry and throws the rest away.
 * If getQuotes carries no option OI, THIS is the path to build the recorder on —
 * so the probe checks it in the same run rather than leaving a second unknown.
 */
async function probeOptionChainRest() {
  const https = require("https");
  const appId = process.env.APP_ID;
  const token = process.env.ACCESS_TOKEN;
  if (!appId || !token) return { ok: false, reason: "no APP_ID / ACCESS_TOKEN in env" };

  const url = `https://api-t1.fyers.in/data/options-chain-v3?symbol=NSE%3ANIFTY50-INDEX&strikecount=${STRIKE_SPAN}&timestamp=`;
  let data;
  try {
    data = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { Authorization: `${appId}:${token}`, "Content-Type": "application/json" },
      }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("error", reject);
        res.on("end", () => {
          try { resolve(JSON.parse(body.trim().replace(/^﻿/, ""))); }
          catch (_) { reject(new Error(`unparseable body: ${body.slice(0, 160)}`)); }
        });
      });
      req.on("error", reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  if (data.s !== "ok" || !data.data) return { ok: false, reason: `s=${data.s} msg=${data.message || ""}` };
  const chain = data.data.optionsChain;
  if (!Array.isArray(chain) || chain.length === 0) return { ok: false, reason: "no optionsChain[] in payload" };

  const withOi = chain.filter((r) => Number(r.oi) > 0);
  return {
    ok: withOi.length > 0,
    rows: chain.length,
    rowsWithOi: withOi.length,
    sample: chain.find((r) => Number(r.oi) > 0) || chain[0],
    hasOich: chain.some((r) => r.oich != null || r.oichp != null),
    reason: withOi.length > 0 ? null : "optionsChain[] present but every row has oi<=0",
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log("\n══ OI CHAIN PROBE ══════════════════════════════════════════════");

  if (!process.env.ACCESS_TOKEN) {
    console.error("❌ No Fyers ACCESS_TOKEN. Log in via the app first — a stale/absent token\n" +
                  "   is the usual cause of an all-zero result here.");
    process.exit(1);
  }
  if (!isMarketHours()) {
    console.warn("⚠️  Outside market hours (09:15–15:30 IST). OI is frozen now, so the\n" +
                 "   CADENCE numbers below will read as 'never changes' and mean nothing.\n" +
                 "   The availability answer (Q1) is still valid. Re-run intraday for Q2.\n");
  }

  const spot = await instrument.getLiveSpot();
  if (!(spot > 0)) { console.error("❌ Could not read spot."); process.exit(1); }
  const expiryCode = await resolveExpiryCode();
  if (!expiryCode) { console.error("❌ Could not resolve an expiry code."); process.exit(1); }

  const atm = instrument.calcATMStrike(spot);   // pure ATM, no side offset
  const symbols = [];
  for (let k = -STRIKE_SPAN; k <= STRIKE_SPAN; k++) {
    const strike = atm + k * STRIKE_STEP;
    if (strike <= 0) continue;
    symbols.push(`NSE:NIFTY${expiryCode}${strike}CE`);
    symbols.push(`NSE:NIFTY${expiryCode}${strike}PE`);
  }

  console.log(`spot ${spot}  ATM ${atm}  expiry ${expiryCode}  ATM±${STRIKE_SPAN} → ${symbols.length} symbols`);
  console.log(`cadence ${INTERVAL_S}s  duration ${MINUTES}m\n`);

  // ── Q1: availability + raw field shape ─────────────────────────────────────
  console.log("── Q1: does getQuotes carry OI on an OPTION row? ──");
  let first;
  try {
    first = await pollChain(symbols);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const firstSym = symbols[0];
  const firstRow = first.get(firstSym);
  if (!firstRow) { console.error(`❌ No quote returned for ${firstSym}.`); process.exit(1); }

  console.log(`raw quote fields for ${firstSym}:`);
  console.log("  " + Object.keys(firstRow.raw).sort().join(", "));
  console.log(`  oi=${firstRow.raw.oi} open_interest=${firstRow.raw.open_interest} openInterest=${firstRow.raw.openInterest}`);

  const withOi = [...first.values()].filter((r) => r.oi != null).length;
  const quotesHaveOi = withOi > 0;
  console.log(`\n${quotesHaveOi ? "✅" : "❌"} ${withOi}/${first.size} option quotes carry a non-zero OI.\n`);

  // ── Q1b: the REST option-chain fallback ────────────────────────────────────
  console.log("── Q1b: does options-chain-v3 carry per-strike OI? ──");
  const rest = await probeOptionChainRest();
  if (rest.ok) {
    console.log(`✅ ${rest.rowsWithOi}/${rest.rows} chain rows carry OI` +
                `${rest.hasOich ? " (and an oich/oichp change field)" : ""}.`);
    console.log("   sample row: " + JSON.stringify(rest.sample).slice(0, 220));
  } else {
    console.log(`❌ unusable — ${rest.reason}`);
  }
  console.log("");

  if (!quotesHaveOi && !rest.ok) {
    console.error("🛑 NEITHER path returns per-strike OI. Do not build the recorder change —\n" +
                  "   there is no data source. Re-check the token first, then Fyers' plan/entitlements.");
    process.exit(2);
  }

  if (MINUTES === 0) {
    console.log("--minutes 0 → shape dump only, skipping the cadence probe.");
    process.exit(0);
  }
  if (!quotesHaveOi) {
    console.log("ℹ️  getQuotes has no option OI, so the cadence probe below would measure nothing.\n" +
                "    Build the recorder on the options-chain-v3 path and re-probe cadence there.");
    process.exit(0);
  }

  // ── Q2: how often does it actually change? ─────────────────────────────────
  console.log(`── Q2: change cadence over ${MINUTES}m ──`);
  console.log("(one line per poll: how many of the tracked strikes moved)\n");

  // Per-symbol tally. `changes` counts polls where OI differed from the previous
  // poll; `deltas` holds the % moves so we can size a realistic threshold rather
  // than guessing one. `gapsMs` measures the wall-clock time BETWEEN changes —
  // that number, not the poll interval, is the real resolution of the feed.
  const stats = new Map();
  for (const [sym, row] of first) {
    stats.set(sym, { last: row.oi, lastChangeAt: Date.now(), polls: 0, changes: 0, deltas: [], gapsMs: [] });
  }

  const deadline = Date.now() + MINUTES * 60 * 1000;
  let pollCount = 0, failCount = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
    let snap;
    try {
      snap = await pollChain(symbols);
    } catch (err) {
      failCount++;
      console.log(`  poll ${++pollCount}: ✖ ${err.message}`);
      continue;
    }
    pollCount++;

    let moved = 0;
    const now = Date.now();
    for (const [sym, row] of snap) {
      const st = stats.get(sym);
      if (!st || row.oi == null) continue;
      st.polls++;
      if (st.last != null && row.oi !== st.last) {
        moved++;
        st.changes++;
        st.deltas.push(((row.oi - st.last) / st.last) * 100);
        st.gapsMs.push(now - st.lastChangeAt);
        st.lastChangeAt = now;
      }
      st.last = row.oi;
    }
    const elapsedM = ((MINUTES * 60 * 1000 - (deadline - now)) / 60000).toFixed(1);
    console.log(`  poll ${pollCount} (+${elapsedM}m): ${moved}/${snap.size} strikes moved`);
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log("\n── per-strike summary ──");
  console.log("strike/side          latest OI    polls  changed   median gap   max |Δ%|");
  const rows = [];
  for (const sym of symbols) {
    const st = stats.get(sym);
    if (!st || !st.polls) continue;
    const gaps = st.gapsMs.slice().sort((a, b) => a - b);
    const medGapS = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)] / 1000) : null;
    const maxAbs  = st.deltas.length ? Math.max(...st.deltas.map(Math.abs)) : 0;
    rows.push({ sym, st, medGapS, maxAbs });
    console.log(
      `${sym.replace("NSE:NIFTY", "").padEnd(18)} ${fmtOi(st.last).padStart(12)} ` +
      `${String(st.polls).padStart(6)} ${String(st.changes).padStart(8)} ` +
      `${(medGapS == null ? "never" : medGapS + "s").padStart(12)} ${pct(maxAbs).padStart(10)}`
    );
  }

  const allGaps = rows.flatMap((r) => r.st.gapsMs).sort((a, b) => a - b);
  const medianGapS = allGaps.length ? Math.round(allGaps[Math.floor(allGaps.length / 2)] / 1000) : null;
  const allDeltas  = rows.flatMap((r) => r.st.deltas.map(Math.abs)).sort((a, b) => a - b);
  const p90Delta   = allDeltas.length ? allDeltas[Math.floor(allDeltas.length * 0.9)] : 0;
  const never      = rows.filter((r) => r.st.changes === 0).length;

  console.log("\n══ VERDICT ═════════════════════════════════════════════════════");
  console.log(`polls: ${pollCount} (${failCount} failed)   strikes that never moved: ${never}/${rows.length}`);
  console.log(`median gap between OI changes: ${medianGapS == null ? "n/a — nothing changed" : medianGapS + "s"}`);
  console.log(`per-change |Δ| p90: ${pct(p90Delta)}   (a 5-min threshold must sit ABOVE this noise)`);

  if (medianGapS == null) {
    console.log("\n🛑 OI never moved. Either the market is closed, or Fyers is serving a\n" +
                "   static end-of-previous-day value. Do NOT build the 5-min signal on this\n" +
                "   until an intraday run shows real movement.");
  } else if (medianGapS <= 60) {
    console.log("\n✅ OI refreshes well inside a 5-min bar. Proceed with the recorder change;\n" +
                "   a 5-min writer-unwind signal has enough resolution.");
  } else if (medianGapS <= 300) {
    console.log("\n⚠️  OI refreshes on the order of minutes. A 5-min bar is workable but the\n" +
                "   lookback must span at least 2 bars, and the delta threshold must clear\n" +
                "   the p90 noise above. Do not use a 1-bar lookback.");
  } else {
    console.log("\n🛑 OI refreshes slower than a 5-min bar. A 5-min writer-unwind signal is\n" +
                "   not supportable on this feed. Reconsider the timeframe (15-min) or the\n" +
                "   data source before building anything.");
  }
  console.log("");
  process.exit(0);
})().catch((err) => {
  console.error(`\n❌ probe crashed: ${err.stack || err.message}`);
  process.exit(1);
});
