#!/usr/bin/env node
/**
 * genSimple930GuideData.js — chart specs + prose numbers for the SIMPLE_9:30 guide.
 *
 *   node tools/genSimple930GuideData.js            # human-readable summary
 *   node tools/genSimple930GuideData.js --json     # the TVChart specs, ready to paste
 *
 * WHY THIS EXISTS
 * ───────────────
 * A strategy guide that draws a hand-invented trade is worse than no guide. Every
 * figure the guide quotes — the fill, the stop, each trail step, the exit, the
 * P&L — is produced HERE by calling the REAL backtest engine
 * (routes/simple930Backtest.simulateDay), which in turn calls the REAL rule engine
 * (strategies/simple930). Nothing in the guide is typed by hand.
 *
 * The 1-minute premium candles below are CONSTRUCTED, not fetched: NIFTY weekly
 * options are delisted at expiry, and at the time of writing the Fyers token was
 * expired, so no historical premium series could be pulled. They are shaped to be
 * plausible (a ~₹178 ITM contract on a mid-week weekly) and the guide says so
 * plainly. What is NOT constructed is any decision: the entry, the stop, every
 * trail step and the exit all come from the engine reading these candles.
 */

process.env.TZ = process.env.TZ || "Asia/Calcutta";
for (const k of Object.keys(process.env)) if (k.startsWith("SIMPLE930_")) delete process.env[k];
Object.assign(process.env, {
  NIFTY_LOT_SIZE: "75", LOT_MULTIPLIER: "1", MAX_LOT_MULTIPLIER: "10",
  INSTRUMENT: "NIFTY_OPTIONS", STRIKE_OFFSET_CE: "0", STRIKE_OFFSET_PE: "0",
  SIMPLE930_BT_SLIPPAGE_PTS: "0",     // the guide teaches the RULE; costs get their own section
});

const S  = require("../src/strategies/simple930");
const BT = require("../src/routes/simple930Backtest");
const { getCharges } = require("../src/utils/charges");

const QTY   = 75;
const DAY   = "2026-08-25";                                  // a Tuesday
const EPOCH = Math.floor(Date.parse(`${DAY}T00:00:00+05:30`) / 1000);
const SEL   = 9 * 60 + 25;
const LAST  = 15 * 60 + 30;
const ATM   = 24350;
const EXP   = "26826";

const r2 = (x) => Math.round(x * 100) / 100;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * Build a 1-minute premium series from control points.
 * `points` is [[minuteOfDay, price], ...]; the price is linearly interpolated
 * between them and each bar gets a small, deterministic wick so highs and lows
 * are real prices rather than a flat line.
 */
function series(points, wick = 1.2) {
  const out = [];
  let seg = 0;
  for (let m = SEL; m <= LAST; m++) {
    while (seg < points.length - 2 && m >= points[seg + 1][0]) seg++;
    const [m0, p0] = points[seg];
    const [m1, p1] = points[Math.min(seg + 1, points.length - 1)];
    const t = m1 === m0 ? 0 : Math.max(0, Math.min(1, (m - m0) / (m1 - m0)));
    const open = p0 + (p1 - p0) * t;
    const tn = m1 === m0 ? 0 : Math.max(0, Math.min(1, (m + 1 - m0) / (m1 - m0)));
    const close = p0 + (p1 - p0) * tn;
    // deterministic pseudo-wick — same every run, so the guide is reproducible
    const jitter = ((m * 7919) % 13) / 13;
    const hi = Math.max(open, close) + wick * (0.4 + 0.6 * jitter);
    const lo = Math.min(open, close) - wick * (0.4 + 0.6 * (1 - jitter));
    out.push({ time: EPOCH + m * 60, open: r2(open), high: r2(hi), low: r2(Math.max(0.05, lo)), close: r2(close) });
  }
  return out;
}

const spotBars = (() => {
  const a = [];
  for (let m = 9 * 60 + 15; m <= LAST; m++) a.push({ time: EPOCH + m * 60, open: ATM + 12, high: ATM + 18, low: ATM + 6, close: ATM + 12 });
  return a;
})();

const leg = (side, strike, bars) => ({
  strike, side, steps: 1, moneyness: "ITM",
  symbol: S.optionSymbol(EXP, strike, side), bars,
});

/** Everything the ladder would have quoted at 09:25, for the guide's table. */
const LADDER_AT_0925 = [
  { side: "CE", strike: 24350, ltp: 121.4, moneyness: "ATM" },
  { side: "CE", strike: 24300, ltp: 152.8, moneyness: "ITM" },
  { side: "CE", strike: 24250, ltp: 178.0, moneyness: "ITM" },
  { side: "CE", strike: 24200, ltp: 219.6, moneyness: "ITM" },
  { side: "CE", strike: 24150, ltp: 262.1, moneyness: "ITM" },
  { side: "PE", strike: 24350, ltp: 108.9, moneyness: "ATM" },
  { side: "PE", strike: 24400, ltp: 139.5, moneyness: "ITM" },
  { side: "PE", strike: 24450, ltp: 172.0, moneyness: "ITM" },
  { side: "PE", strike: 24500, ltp: 208.4, moneyness: "ITM" },
  { side: "PE", strike: 24550, ltp: 249.7, moneyness: "ITM" },
].map(r => ({ ...r, symbol: S.optionSymbol(EXP, r.strike, r.side) }));

// ── The three sessions the guide teaches ────────────────────────────────────
const SCENARIOS = {
  // 1. The rule's own worked example: fills at ₹181, stop ₹161, runs 190 → 200 →
  //    220+, and the trail takes it out on the pullback.
  trend: {
    id: "s930-trend",
    title: "NIFTY 24250 CE — the trade the rule describes",
    subtitle: "1-min OPTION PREMIUM · the only chart a rule reads · picked at 09:25 for trading nearest ₹180",
    ce: series([[SEL, 178], [SEL + 4, 176.5], [SEL + 6, 180.9], [SEL + 12, 197], [SEL + 20, 224], [SEL + 30, 241], [SEL + 42, 236], [SEL + 55, 219], [LAST, 219]]),
    pe: series([[SEL, 172], [SEL + 10, 166], [SEL + 25, 151], [SEL + 45, 143], [LAST, 140]]),
  },
  // 2. The 09:45 rule doing its job: a trade that goes nowhere is closed.
  sideways: {
    id: "s930-sideways",
    title: "NIFTY 24250 CE — the 09:45 rule closing a trade that went nowhere",
    subtitle: "1-min OPTION PREMIUM · never traded ₹220, never traded ₹160 — so it is closed at 09:45, whatever the P&L",
    ce: series([[SEL, 178], [SEL + 5, 176], [SEL + 7, 181.4], [SEL + 11, 191], [SEL + 15, 176], [SEL + 18, 188], [SEL + 22, 179], [SEL + 26, 186], [SEL + 34, 181], [LAST, 181]], 1.0),
    pe: series([[SEL, 172], [SEL + 20, 168], [SEL + 40, 171], [LAST, 170]], 1.0),
  },
  // 3. The commonest outcome of all: nothing clears the level, so nothing is done.
  notrade: {
    id: "s930-notrade",
    title: "Neither leg clears ₹180 — and the day is simply left alone",
    subtitle: "1-min OPTION PREMIUM · both watchlist legs stayed under the trigger through 09:35",
    ce: series([[SEL, 178], [SEL + 8, 174], [SEL + 14, 179.2], [SEL + 22, 170], [SEL + 40, 166], [LAST, 163]], 1.0),
    pe: series([[SEL, 172], [SEL + 10, 176], [SEL + 18, 173], [SEL + 30, 168], [LAST, 165]], 1.0),
  },
};

/**
 * PAPER-CADENCE walkthrough — the canonical path.
 *
 * simulateDay() reads whole BARS, which is right for a backtest but is not what
 * the live route does: paper polls a premium and reacts to that single number.
 * This replays each bar's CLOSE as one polled quote and drives the REAL engine
 * functions in the REAL order the paper route calls them — evaluateTrigger →
 * computeInitialStop → peak/trough → computeTrailStop → exitCheck. Every figure
 * the guide's worked example quotes comes out of here, so the guide teaches what
 * paper actually does rather than what a bar-level simulation approximates.
 */
function paperWalk(name) {
  const sc  = SCENARIOS[name];
  const cfg = S.getConfig();
  const legs = {
    CE: { symbol: S.optionSymbol(EXP, 24250, "CE"), strike: 24250, ltp: null },
    PE: { symbol: S.optionSymbol(EXP, 24450, "PE"), strike: 24450, ltp: null },
  };
  const sustain = { CE: 0, PE: 0 };
  const steps = [];
  let pos = null;

  for (let i = 0; i < sc.ce.length; i++) {
    const m = SEL + i;
    legs.CE.ltp = sc.ce[i].close;
    legs.PE.ltp = sc.pe[i] ? sc.pe[i].close : null;

    if (!pos) {
      if (!S.inEntryWindow(m, cfg)) {
        if (m > cfg.entryEndMin) {
          steps.push({ at: hhmm(m), kind: "NO-TRADE",
            text: `entry window closed with neither leg above ₹${cfg.triggerPremium} — CE peaked ₹${r2(Math.max(...sc.ce.slice(0, i).map(b => b.high)))}, PE peaked ₹${r2(Math.max(...sc.pe.slice(0, i).map(b => b.high)))}` });
          break;
        }
        continue;
      }
      const v = S.evaluateTrigger({ ce: legs.CE, pe: legs.PE }, cfg, sustain);
      for (const side of ["CE", "PE"]) {
        sustain[side] = (S._px(legs[side].ltp) && legs[side].ltp > cfg.triggerPremium) ? sustain[side] + 1 : 0;
      }
      if (!v.fire) continue;
      const leg = legs[v.leg];
      const stop = S.computeInitialStop(leg.ltp, cfg);
      pos = { side: v.leg, strike: leg.strike, symbol: leg.symbol, entry: r2(leg.ltp), entryMin: m,
              stop, initialStop: stop, peak: r2(leg.ltp), trough: r2(leg.ltp),
              trailMoves: 0, expanded: false, atMin: m };
      steps.push({ at: hhmm(m), kind: "ENTRY",
        text: `${v.reason} → BUY ${pos.side} ${pos.strike} at ₹${pos.entry}, stop ₹${stop} (${cfg.slPts}pt off the fill)`,
        price: pos.entry, stop });
      continue;
    }

    const ltp = legs[pos.side].ltp;
    if (!S._px(ltp)) continue;
    if (ltp > pos.peak)   pos.peak = r2(ltp);
    if (ltp < pos.trough) pos.trough = r2(ltp);

    if (!pos.expanded && S.isExpanded(pos.peak, pos.trough, cfg)) {
      pos.expanded = true;
      steps.push({ at: hhmm(m), kind: "BOX",
        text: `premium traded ₹${pos.peak} — through the ₹${cfg.bandUp} box top, so the ${hhmm(cfg.sidewaysMin)} sideways exit no longer applies`, price: pos.peak });
    }

    const next = S.computeTrailStop(pos.peak, pos.initialStop, cfg);
    if (S._num(next) && next > pos.stop) {
      const prev = pos.stop;
      pos.stop = next; pos.trailMoves++;
      steps.push({ at: hhmm(m), kind: "TRAIL",
        text: `peak ₹${pos.peak} → stop lifted ₹${prev} to ₹${next}`, price: pos.peak, stop: next });
    }

    const v = S.exitCheck(pos, ltp, m, cfg);
    if (v && v.exit) {
      const pts = r2(ltp - pos.entry);
      const ch  = getCharges({ broker: "zerodha", isFutures: false, entryPremium: pos.entry, exitPremium: ltp, qty: QTY });
      const pnl = r2(pts * QTY - ch);
      steps.push({ at: hhmm(m), kind: v.kind, text: v.reason, price: r2(ltp),
        pts, gross: r2(pts * QTY), charges: r2(ch), pnl });
      pos.exit = { at: hhmm(m), price: r2(ltp), kind: v.kind, pts, charges: r2(ch), pnl };
      break;
    }
  }
  return { pos, steps, cfg };
}

function run(name) {
  const sc = SCENARIOS[name];
  const cfg = S.getConfig();
  const day = {
    dateStr: DAY, expiryCode: EXP, spotBars,
    ladder: [leg("CE", 24250, sc.ce), leg("PE", 24450, sc.pe)],
  };
  const { trade, audit } = BT.simulateDay(day, cfg, QTY);
  return { sc, cfg, trade, audit };
}

/** Turn the engine's own result into a TVChart spec. Nothing is typed by hand. */
function chartSpec(name) {
  const { sc, cfg, trade } = run(name);
  const held = trade ? trade.side : "CE";
  const bars = held === "CE" ? sc.ce : sc.pe;
  // Trim to the window that matters — 09:25 to a little past the exit (or 10:15).
  const endMin = trade ? Math.min(LAST, Math.round((trade.exitTs - EPOCH) / 60) + 8) : 10 * 60 + 5;
  const slice = bars.filter(b => {
    const m = Math.round((b.time - EPOCH) / 60);
    return m >= SEL && m <= endMin;
  });
  const idxOf = (ts) => slice.findIndex(b => b.time === ts);
  const times = slice.map(b => hhmm(Math.round((b.time - EPOCH) / 60)));

  const markers = [];
  if (trade) {
    markers.push({ i: idxOf(trade.entryTs), type: "buy",  price: trade.ePrice, text: `BUY ${trade.side} ${trade.strike} @ ₹${trade.ePrice}` });
    markers.push({ i: idxOf(trade.exitTs),  type: "exit", price: trade.xPrice, text: `${trade.exitKind} @ ₹${trade.xPrice} · ₹${trade.pnl}` });
  } else {
    let hiIdx = 0;
    slice.forEach((b, i) => { if (b.high > slice[hiIdx].high) hiIdx = i; });
    markers.push({ i: hiIdx, type: "dot", color: "#fbbf24", price: slice[hiIdx].high, text: `best it managed: ₹${r2(slice[hiIdx].high)} — never above ₹${cfg.triggerPremium}` });
  }

  const hlines = [
    { price: cfg.triggerPremium, color: "#38bdf8", label: `trigger — buy above ₹${cfg.triggerPremium}`, labelAt: 0.04 },
    { price: cfg.bandUp,   color: "#a855f7", label: `box top ₹${cfg.bandUp} — clear this and 09:45 is off`, labelAt: 0.46 },
    { price: cfg.bandDown, color: "#a855f7", label: `box floor ₹${cfg.bandDown}`, labelAt: 0.04 },
  ];
  if (trade) hlines.push({ price: trade.sl, color: "#ef5350", label: `initial stop ₹${trade.sl} (${cfg.slPts}pt off the fill)`, labelAt: 0.72 });

  return {
    id: sc.id,
    spec: {
      title: sc.title,
      subtitle: sc.subtitle,
      times,
      candles: slice.map(b => [b.open, b.high, b.low, b.close]),
      hlines,
      markers,
      legend: [
        { color: "#38bdf8", label: `₹${cfg.triggerPremium} trigger` },
        { color: "#a855f7", label: `the 09:45 box ₹${cfg.bandDown}–₹${cfg.bandUp}` },
        { color: "#ef5350", label: trade ? `stop, then a ${cfg.trailPts}pt trail` : "no entry — nothing to stop" },
      ],
    },
  };
}

// ── Output ──────────────────────────────────────────────────────────────────
if (process.argv.includes("--json")) {
  const out = { charts: {}, walks: {} };
  for (const k of Object.keys(SCENARIOS)) {
    const c = chartSpec(k);
    out.charts[c.id] = c.spec;
    out.walks[k] = paperWalk(k);
  }
  console.log(JSON.stringify(out));
} else {
  const cfg = S.getConfig();
  console.log(`SIMPLE_9:30 guide data — engine ${S.NAME}`);
  console.log(`plan: ${S.describePlan(cfg)}\n`);

  const picked = S.selectWatchlist(LADDER_AT_0925, ATM, cfg);
  console.log(`09:25 ladder (ATM ${ATM}, target ₹${cfg.triggerPremium}) — nearest first:`);
  for (const c of picked.candidates) {
    const isPick = (picked.ce && c.symbol === picked.ce.symbol) || (picked.pe && c.symbol === picked.pe.symbol);
    console.log(`   ${isPick ? "→" : " "} ${c.side} ${c.strike} ${String(c.moneyness).padEnd(3)} ₹${String(c.ltp).padStart(6)}  ₹${String(c.dist).padStart(5)} away${isPick ? "   ← WATCHED" : ""}`);
  }
  console.log(`   picked CE ${picked.ce.strike} @ ₹${picked.ce.ltp} · PE ${picked.pe.strike} @ ₹${picked.pe.ltp}\n`);

  for (const name of Object.keys(SCENARIOS)) {
    const { trade, audit } = run(name);
    console.log(`── ${name} ──`);
    if (!trade) {
      console.log(`   outcome: ${audit.outcome}`);
      console.log(`   ${audit.note}\n`);
      continue;
    }
    const grossPts = r2(trade.xPrice - trade.ePrice);
    console.log(`   entry ${trade.entry}  ${trade.side} ${trade.strike} @ ₹${trade.ePrice}`);
    console.log(`   initial stop ₹${trade.sl}  (${cfg.slPts}pt off the fill)`);
    console.log(`   peak ₹${trade.peak} · trough ₹${trade.trough} · left the box: ${trade.expanded} · trail moved ${trade.trailMoves}×  → final stop ₹${trade.stop}`);
    console.log(`   exit  ${trade.exit}  ${trade.exitKind} @ ₹${trade.xPrice}`);
    console.log(`   ${trade.reason}`);
    console.log(`   ${grossPts >= 0 ? "+" : ""}${grossPts} pts × ${QTY} = ₹${r2(grossPts * QTY)} gross · charges ₹${trade.charges} · NET ₹${trade.pnl}\n`);
  }

  console.log("═══ PAPER-CADENCE walkthrough (the canonical path the guide teaches) ═══\n");
  for (const name of Object.keys(SCENARIOS)) {
    const { pos, steps } = paperWalk(name);
    console.log(`── ${name} ──`);
    for (const st of steps) {
      console.log(`   ${st.at}  ${String(st.kind).padEnd(9)} ${st.text}`);
      if (st.pnl !== undefined) console.log(`             ${st.pts >= 0 ? "+" : ""}${st.pts} pts × ${QTY} = ₹${st.gross} gross · charges ₹${st.charges} · NET ₹${st.pnl}`);
    }
    if (pos && !pos.exit) console.log(`   (still open at the end of the constructed series)`);
    // Counted separately because the EXIT step is also kind TRAIL — the guide
    // quotes the number of LIFTS, and conflating the two overstates it by one.
    const lifts = steps.filter(x => x.kind === "TRAIL" && /stop lifted/.test(x.text)).length;
    if (lifts) console.log(`   → ${lifts} trail LIFT(s) (the exit is a separate TRAIL step and is NOT one of them)`);
    console.log("");
  }

  // The guide's third money row is a clean stop-out. It is not one of the three
  // sessions above (none of them stops out cleanly), so compute it here rather
  // than let the guide quote a number nothing produced.
  {
    const cfg = S.getConfig();
    const fill = 181;
    const stop = S.computeInitialStop(fill, cfg);
    const ch   = getCharges({ broker: "zerodha", isFutures: false, entryPremium: fill, exitPremium: stop, qty: QTY });
    const pts  = r2(stop - fill);
    console.log(`── clean stop-out (rule arithmetic, not one of the sessions above) ──`);
    console.log(`   fill ₹${fill} → stop ₹${stop}  (${cfg.slPts}pt)`);
    console.log(`   ${pts} pts × ${QTY} = ₹${r2(pts * QTY)} gross · charges ₹${r2(ch)} · NET ₹${r2(pts * QTY - ch)}\n`);
  }

  // The cost floor the guide quotes, straight from the repo's own charges model.
  const c1 = getCharges({ broker: "zerodha", isFutures: false, entryPremium: 181, exitPremium: 181, qty: QTY });
  console.log(`round-trip Zerodha charges on 1 lot (${QTY}) at ₹181: ₹${r2(c1)}  = ${r2(c1 / QTY)} premium points`);
  const slip = 1.5;
  console.log(`plus ${slip}pt slippage each way = ${r2(2 * slip)} points → break-even needs about ${r2(c1 / QTY + 2 * slip)} points of premium`);
}
