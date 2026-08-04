# ORB — Redesign Proposal (2026-08-04)

Scope: `src/strategies/orb_breakout.js`, `src/utils/orbStopRisk.js`, `src/routes/orb{Paper,Live,Backtest}.js`,
`scripts/orbValidate.js`. Replay is out of scope by construction — it drives paper's `onTick()`.

**Status: proposal. No code changed yet.**

---

## 0. What the evidence actually supports

Five trades cannot establish or refute an edge. So this document separates three tiers of claim,
and you should treat them very differently:

| Tier | Claim type | Confidence | Example |
|---|---|---|---|
| **A** | Provable from code | Certain | ATR(5m) is measured on yesterday's afternoon |
| **B** | Structural/geometric, true regardless of n | High | All three post-buffer stops sat inside the OR box |
| **C** | Statistical, from n=5 or n=39 | ~None | "the body filter should be 0.6" |

Everything actionable below is Tier A or Tier B. Tier C items are listed as *hypotheses to test on the
long sample*, never as changes to ship. This is the discipline the existing engine header already
demands ("39 sessions is far too small… these constants are priors, not optima") and it is the reason
this redesign deliberately does **not** tune a single threshold against the 5 trades.

---

## 1. Weaknesses in the current ORB

### 1.1 [TIER A — BUG] The volatility yardstick measures the wrong day

`getSignal()` freezes ATR at the 09:30 OR boundary:

```js
const yard  = orEndIdx >= 0 ? candles.slice(0, orEndIdx + 1) : candles;   // ends 09:25
const atr5  = _atrAtLast(yard, 14);        // 14 five-min bars ending 09:25
const atr15 = _atrAtLast(_to15m(yard), 14); // 14 fifteen-min bars ending 09:25
```

At 09:25 today has produced **two** 5-min bars. A 14-period ATR therefore averages ~2 bars of today
and ~12 bars of **yesterday afternoon**, and the bar that bridges the two sessions carries a true
range equal to the **overnight gap**. ATR(15m) is worse: 14 fifteen-minute buckets ending 09:25 is
3.5 hours, i.e. essentially all of yesterday's afternoon plus the gap.

This is not theoretical. It is visible in your own skip log:

```
2026-07-29  OR = 24195.8 / 24144.2  → range 51.6pt
2026-07-29  "Breakout candle body 5.5pt < 34.8pt (0.6×ATR5)"   → implied ATR5 = 58.0pt
```

**An average 5-minute true range of 58pt on a day whose entire 15-minute opening range was 51.6pt is
arithmetically impossible from today's bars.** The number is imported from yesterday and the gap.

Every downstream threshold is scaled by this contaminated number:

| Consumer | Formula | Effect of inflation |
|---|---|---|
| Decisive-body gate | `body ≥ 0.6 × ATR5` | Blocks almost every day |
| Breakout buffer | `max(0.15×OR, 0.30×ATR5, 1)` | Entry pushed further from the edge |
| ATR stop floor | `1.5 × ATR5` | Inert (see 1.2), so masked |
| Day sanity | `OR ≤ 2.5 × ATR15` | Wide-open days wrongly pass |

This single defect explains the trade drought. Of the 14 sessions from 10-Jul that appear in the skip
log, the engine took **1** trade; **7** were blocked by the body gate, at thresholds of 15.1, 17.7,
20.2, 20.4, 22.6, 28.5 and **34.8** points. Those imply ATR5 values of 25 → 58pt, against a plausible
real range of roughly 12–22pt for that regime. The gate was running at roughly **2× its intended
strictness**, and non-uniformly — strictest after the largest gaps, which is backwards.

Note the pre-27-Jul skip rows show the threshold *declining* through the session (10 Jul: 22.6 →
16.8). That is the pre-rebuild engine recomputing ATR live; it is not evidence against the freeze. It
is evidence that the freeze changed behaviour materially and nobody re-derived the constants after.

### 1.2 [TIER B] The stop is decoupled from structure — and lands *inside* the opening range

`orbStopRisk.resolveInitialStop()` takes the strategy's structural/ATR stop and **clamps it to
whatever ₹1,500 buys**: `capSpotPts = (1500 / 65) / 0.60 = 38.46 pt`. The module's own header admits
the consequence: "every ATR multiplier from 1.0× to 2.5× gives an IDENTICAL result… the multiplier is
not tuned, it is **INERT**."

The clamp does not merely override the stop — it puts it in the worst possible place. Take the three
trades the *current* engine would still have accepted, with the stop **recomputed under today's
clamp** (entry ∓ 38.46pt). Only 31-Jul actually ran this code; 06-Jul and 08-Jul predate the rebuild,
so their rows are counterfactual — their real `initialStopLoss` values are used in the paragraph below.

| Trade | Side | Entry | Stop under today's clamp | OR box | Inside the box? |
|---|---|---|---|---|---|
| 06-Jul | CE | 24369.10 | 24330.64 | 24291.00 – 24359.10 | **yes** |
| 08-Jul | PE | 24220.05 | 24258.51 | 24232.05 – 24294.25 | **yes** |
| 31-Jul | PE | 24310.00 | 24348.46 *(actual)* | 24328.20 – 24377.55 | **yes** |

The opening range is, by definition, the price band where the session's two-sided auction took place —
the zone of maximum acceptance and therefore of maximum touch probability per point. Placing a stop
there is the highest-probability-of-being-hit location on the entire chart.

And it is not only the clamp. Checking `initialStopLoss` against the OR box for **all five** trades —
including 07-Jul and 09-Jul, whose stops came from the pre-rebuild 2-candle swing rule, and including
the 06-Jul winner — every one of the five sat inside its own opening range. Two entirely different
stop mechanisms landed in the same wrong place, because **no stop rule ORB has ever run references
the OR box at all**. That is the defect; the rupee clamp is just its current form.

Worse, it is simultaneously **too wide to be structural**. On 31-Jul the breakout thesis was dead the
moment price closed back above ORL 24328.2 — 18.2pt from entry. The stop was 38.46pt away. The trade
paid an extra **20 points for information it already had**.

So the stop is too wide to respect structure and too tight to survive noise. It is the worst of both.

### 1.3 [TIER B] The entry chases; the risk budget then can't fund it

The entry sequence is: breakout candle with body ≥ 0.6×ATR5 → **next** candle must make a higher high
*and* a higher close beyond the edge → buy that close. By construction you buy after two consecutive
expansion bars. Entry distance beyond the OR edge on the three accepted trades: 10.0, 12.0, 18.2 pt —
and that is with a *deflated* view, because the buffer was inflated by 1.1.

For an option buyer this compounds: you pay the post-breakout IV pop and the delta expansion, then
place a stop that is a fixed rupee count regardless of how far you chased. Chase further → same
rupee stop → smaller effective R.

### 1.4 [TIER B] The payoff geometry has never been reached

| Trade | MFE (spot pt) | MAE (spot pt) | Distance entry → `targetSpot` (1.5×OR) |
|---|---:|---:|---:|
| 06-Jul | +25.45 | −5.90 | 92.15 |
| 07-Jul | +2.35 | −31.70 | 79.50 |
| 08-Jul | +12.75 | −15.70 | 81.30 |
| 09-Jul | +29.15 | −21.10 | 161.63 |
| 31-Jul | +0.90 | −39.75 | 55.82 |
| **mean** | **+14.12** | **−22.83** | |

Mean adverse excursion is **1.6× mean favourable excursion**. Maximum favourable excursion across all
five trades is 29.15pt against a thesis that predicts 56–162pt. The move the strategy is designed to
capture did not occur once.

**The oracle test.** Sum of `mfePnl` (peak unrealised, gross) = ₹2,161.25. Subtract the ₹352.22 of
charges actually incurred: a **perfect, clairvoyant exit at the top tick of every trade** returns
**+₹1,809 over 5 trades (₹362/trade)** — before the slippage such an exit would cost.

That is the most important number in this document. **The exit stack is not what lost the money.**
Even a flawless exit barely clears costs. The signal has nothing to harvest. Tuning the trail, the
breakeven, or the SL multiplier cannot fix this. Only the entry can.

### 1.5 [TIER A] Exit logic exists in four hand-maintained copies

| Location | Copy |
|---|---|
| `orbPaper.js` `_managePositionOnClose` + `_checkExits` | canonical |
| `orbLive.js:428/472` | duplicate |
| `orbBacktest.js:176–248` | duplicate (inline, ~70 lines) |
| `scripts/orbValidate.js:109–160` | duplicate |
| `replay.js` | ✅ none — drives paper's `onTick` |

The backtest copy carries a comment explaining that it *used to* evaluate the rules in the wrong order
and silently reported different trades than paper would have taken. That bug class is structural: four
copies means it recurs. Your "identical logic between Replay / Backtest / Paper / Live" requirement is
currently satisfied only for the **entry** (all four call `getSignal`), never for the **exit**.

### 1.6 [TIER B] Smaller defects

- **No option-side gating in backtest.** Premium band, spread cap and OI filter are live-only, so
  backtest trade counts are an upper bound. `_paperOnlyGates()` discloses this on the page — good —
  but any threshold "validated" in backtest is validated against a different strategy than paper runs.
- **0DTE is unguarded.** 07-Jul entered a 07-Jul expiry. Gamma/theta on 0DTE make a 38pt spot stop
  behave nothing like it does on a 4-day option. `ORB_EXPIRY_DAY_ONLY` exists but is the *opposite*
  control; there is no minimum-DTE gate.
- **VWAP is TWAP.** The index has no spot volume so `computeVwap` correctly falls back to a time
  average. The *side* test survives; any "distance from VWAP" test is weaker than it looks. NIFTY
  **futures** carry real volume and the repo already polls futures OI (`oiFilter._futSymbol`) — that is
  the available participation proxy and it is currently used only as a directional veto.
- **`ORB_MAX_DAILY_LOSS` is inert either way.** At the ₹3,000 code default one trade's ₹1,500 cap can
  never reach it; at the ₹500 you actually ran it fires after *any* losing trade but changes nothing,
  because `ORB_MAX_DAILY_TRADES=1` has already ended the day. The 206 `daily_loss` skip rows in your
  export are that second case under the old gate ordering — pure noise, since fixed
  ([orbPaper.js:617](src/routes/orbPaper.js#L617) now checks the trade budget first).
- **Entry price ≠ signal price.** Paper enters at `state.lastTickPrice` on the first tick of the *next*
  bar; backtest enters at `oc.close`. On 31-Jul: signal close 24311.7, recorded entry 24310.0. Small,
  systematic, and it makes paper↔backtest parity approximate rather than exact.

---

## 2. Root causes of the losses

Ranked by how much of the −₹4,229 each explains.

**RC-1 — Entries are taken on breakouts with no follow-through, then stopped at a level engineered to
be hit.** (1.2 + 1.3 + 1.4.) The proximate cause of 4 of 4 losses.

**RC-2 — The gates that were supposed to select quality were calibrated against a corrupted ruler.**
(1.1.) Because ATR5 is inflated, the body gate rejects ~90% of days for the *wrong reason* while the
buffer simultaneously pushes entries further from structure. The filter is both too strict and
pointed the wrong way.

**RC-3 — Risk sizing is a clamp, not a size.** Fixing the rupee loss and varying the stop distance is
backwards. Professional practice fixes the *structural* stop and varies the *size*.

**RC-4 — No market-context gate at all.** There is no trend-day vs range-day classification, no
prior-day / CPR / pivot proximity check, no check that the breakout has room to run. 08-Jul is the
clearest case: the PE thesis was eventually *correct* (spot fell 24232 → 23821 later that day) but the
entry was taken into the middle of a chop band with a stop 38pt away in the noise.

**RC-5 — Sample-driven decision-making.** The 2026-07-26 rebuild was selected on 39 sessions with
`P(edge ≤ 0) ≈ 37–39%` and a single trade worth 211% of net. That is a coin flip presented as a
finding. Any further change decided on 5 more trades repeats the error.

---

## 3. Every losing trade, against your 12 questions

Note first: the **current** engine's buffer rule already rejects 07-Jul and 09-Jul (see per-trade
notes) — the 2026-07-26 rebuild fixed the two most obviously broken entries. Removing just those two
leaves 3 trades worth **−₹1,862.74**, still losing and for entirely different reasons. (That is a
lower bound on today's engine, not a re-run: the confirmation rule and the OR-vs-ATR15 filter may
reject some of the other three as well.) That is why this redesign targets structure and risk, not
more entry filters.

### T2 — 07-Jul-2026 PE, −₹1,812.39 (worst loss)
`ORL 24428.5 / ORH 24482.1 / range 53.6` · breakout close **24426.25** · entry 24427.6 · exit 24459.3 in 7m44s
MFE +2.35pt @ 15s · MAE −31.70pt @ 464s

1. **Never taken because** the breakout cleared ORL by **2.25pt = 4.2% of the OR**. That is inside the
   bid-ask noise of the index, not a breakout.
2. **Prevented by** the buffer rule (`max(0.15×53.6, 0.30×ATR5, 1)` = **≥8.04pt** required) — the
   current engine already rejects this. Also by a min-DTE gate (this was 0DTE).
3. **Missing:** clearance, thrust, follow-through, headroom. Nothing about it was institutional.
4. **One more candle:** yes, decisively — the next candle reversed and the trade would never have been
   armed. This is exactly what the current confirmation rule does.
5. **Liquidity sweep:** **yes, textbook.** 2.25pt poke below ORL, MFE reached at 15 seconds, then a
   31.7pt reversal. Sell-side stops resting under ORL were taken and the auction rotated.
6. **OR size:** 53.6pt — normal, not the problem.
7. **Momentum exhausted:** not exhausted — *absent*. There was never a momentum leg.
8. **Immediate rejection:** yes. secsToMFE 15 vs secsToMAE 464.
9. **VWAP:** the record shows `vwapAligned: true`, but VWAP here is TWAP over 4 bars of a 53pt range —
   the test carried near-zero information at 09:35.
10. **Volume:** not evaluated (`volPass` blank; index has no volume). Futures volume would have shown a
    non-expansion bar.
11. **S/R:** ORL 24428.5 is itself the level; there was no *further* level to fall to before the
    prior-day support band. Zero headroom.
12. **Premium decay:** 0DTE expiry-day PE. Entry ₹97.05 → peak ₹101 → exit ₹70.10. A −31.7pt adverse
    spot move destroyed 28% of premium in 8 minutes; on a 4-day option the same move costs ~19%.
    **0DTE roughly doubled the damage.**

### T3 — 08-Jul-2026 PE, −₹772.78
`ORL 24232.05 / ORH 24294.25 / range 62.2` · breakout close 24219.75 (12.3pt clear) · entry 24220.05 · exit 24235.75 in 11m
MFE +12.75pt · MAE −15.70pt

1. **Never taken because** the entry sat 12pt below ORL with the stop 38pt *above* it — i.e. **20pt
   inside the box**. Structurally guaranteed to be tested by ordinary rotation.
2. **Prevented by** structure-anchored stop placement + a headroom check. The breakout was into the
   middle of a range with no near support to target.
3. **Missing:** headroom, and any trend-day classification. The day was a range day until ~13:50.
4. **One more candle:** no. Waiting would have entered *lower* with the same stop geometry.
5. **Liquidity sweep:** partly — 12.3pt clearance is real but modest; the reversal to 24235 was a
   rotation back into the box, not a stop-hunt spike.
6. **OR size:** 62.2pt, normal.
7. **Momentum exhausted:** no — it never started. The thesis was right and paid *five hours later*
   (spot 23821 by 14:55). The trade was **structurally correct and tactically premature**.
   The strategy has no mechanism to re-enter after a correct-but-early stop.
8. **Immediate rejection:** partially — MFE at 185s, MAE at 673s.
9. **VWAP:** aligned, but again low-information this early.
10. **Volume:** not evaluated.
11. **S/R:** yes, and it is the crux — the entry was in mid-range with the next real support far below.
12. **Premium decay:** modest (14-Jul expiry, 6 DTE). ₹178.95 → ₹168.25 on a −15.7pt spot move. Delta
    behaved as expected; decay was not the cause here.

### T4 — 09-Jul-2026 CE, −₹554.34
`ORH 24037.8 / ORL 23930.05 / range 107.75` · breakout close **24038.05** · entry 24037.8 · exit 24037.45 in 23m
MFE +29.15pt · MAE −21.10pt

1. **Never taken because** the breakout cleared ORH by **0.25 points — 0.23% of the OR.** This is a
   tick, not a breakout.
2. **Prevented by** the buffer rule (would have required **≥16.16pt**) — current engine rejects it.
   Also by the OR-width filter: 107.75pt is a wide, already-expanded open.
3. **Missing:** clearance, compression, thrust.
4. **One more candle:** the engine's confirmation *did* run (entry 09:35 on the old engine, no
   confirmation existed then). Today's rule would have demanded a higher high and higher close beyond
   24037.8 — almost certainly rejecting it.
5. **Liquidity sweep:** yes — a 0.25pt clearance of a well-defined ORH is precisely where buy-stops sit.
6. **OR too large:** **yes.** 107.75pt. Under the corrected ATR15 this is likely > 2.5× and the day is
   skipped outright. The 15-Jul (137pt) and 22-Jul (117.5pt) skips show the mechanism works when the
   number is right.
7. **Momentum exhausted:** yes. A 107.75pt opening range *is* the day's move; there was little left.
8. **Immediate rejection:** no — this one drifted (MFE at 817s, MAE at 175s) and died of attrition.
9. **VWAP:** `volPass` blank, `vwapAligned: true`. On a 107pt range the VWAP side test is nearly
   coin-flip.
10. **Volume:** not evaluated.
11. **S/R:** ORH 24037.8 was the level; entry was *at* it, no headroom.
12. **Premium decay:** ₹172.35 → ₹165 over 23 minutes on a −0.35pt net spot move. **Pure theta/vega
    bleed** — the option lost 4.3% while the underlying went nowhere. This is the cost of holding a
    directional option through chop, and it is why a time-stop matters.

### T5 — 31-Jul-2026 PE, −₹1,486.94 (the only trade under the current engine)
`ORL 24328.2 / ORH 24377.55 / range 49.35` · breakout close 24311.7 (16.5pt clear, buffer 11.48) · body 33.05pt
entry 24310.00 · **initial SL 24348.46 = exactly the ₹1,500 rupee clamp** · exit 24349.75 in 4m21s
MFE +0.90pt @ 3.4s · MAE −39.75pt @ 260.6s · `signalStrength: STRONG`

1. **Never taken because** — and this is the important one — **the stop was placed 20.26pt inside the
   opening range.** `24348.46` vs `ORL 24328.2`. The trade's own structural invalidation (a close back
   above ORL) was 18.2pt away; the stop was 38.46pt away. It risked 38pt to hold a thesis that was
   already dead at 18pt.
2. **Prevented by** — in descending order of effect, and note the stop is *not* the big lever here:
   (a) the **acceptance bar** (§5 Stage 3) — MFE arrived 3.4s after entry, so a third bar of
   acceptance never arms the trade at all; (b) the **chase penalty** P2 — entry was 16.5pt below ORL,
   made ~4pt worse by the ATR bug inflating the buffer to 11.48pt when `0.15×OR` is 7.40pt;
   (c) a **headroom check** — no level was ever consulted; (d) **box re-entry exit**, which fires on
   the *close* back inside the box rather than on a tick 20pt deep inside it. Structure-anchored
   sizing alone would only have moved the stop 38.46 → ≥34.75pt (§6.1): worth ~₹145, not the fix.
3. **Missing:** every one of them. MFE of 0.9 points means the market did not accept the breakout for
   a single tick. There was no follow-through to grade.
4. **One more candle:** **yes — the single highest-value change for this trade.** MFE was reached
   3.4 seconds after entry. A rule requiring the *entry* candle to close beyond the breakout close (a
   third bar of acceptance), or a 1-candle time stop at < 0.5R, exits at a fraction of −39.75pt.
5. **Liquidity sweep:** **yes.** The 33.05pt body closing 16.5pt below ORL, MFE at 3.4 seconds, then a
   full 40pt reversal back through the entire OR box in four minutes, is the canonical failed-breakdown
   / stop-run signature. A large body is *not* evidence of institutional participation — an aggressive
   sweep produces the largest body of the morning.
6. **OR size:** 49.35pt — on the narrow side, which is the *favourable* condition per the engine's own
   strongest hypothesis. The OR was not the problem.
7. **Momentum exhausted:** no. It was **fake**, not exhausted. This is the distinction the current
   engine cannot draw: `body ≥ 0.6×ATR5` measures *magnitude*, never *acceptance*.
8. **Immediate rejection:** **yes, maximally.** MFE +0.90pt at 3.4s vs MAE −39.75pt at 260.6s. Price
   never traded meaningfully in our favour after the fill.
9. **VWAP:** `vwapAligned: true`. But with a TWAP proxy and a 49pt range, "below VWAP" at 09:40 means
   the price is below the average of eight bars — near-tautological after a 33pt down bar. **VWAP as
   currently implemented is not supporting the move; it is restating it.**
10. **Volume:** not evaluated. `volPass` blank. Futures volume/OI on that bar is the one datum that
    could have distinguished sweep from participation, and it was not consulted.
11. **S/R:** not checked at all. No prior-day low, CPR, or pivot proximity test exists in the engine.
12. **Premium decay:** ₹145.80 → peak ₹146.55 → ₹124.00 in 4m21s. 4-Aug expiry, 4 DTE. Decay was
    negligible over 4 minutes; this loss was **pure delta**. Not a decay problem.

### Cross-trade pattern

| Signature | T2 | T3 | T4 | T5 |
|---|:-:|:-:|:-:|:-:|
| Clearance < 20% of OR | ✅ 4.2% | ✅ 19.8% | ✅ 0.2% | ❌ 33.4% |
| Initial stop inside the OR box | ✅ | ✅ | ✅ | ✅ |
| MFE reached < 200s (instant rejection) | ✅ 15s | ✅ 185s | ❌ 817s | ✅ 3.4s |
| MAE > 1.5 × MFE | ✅ 13.5× | ❌ 1.2× | ❌ 0.7× | ✅ 44× |
| Entered on the 1st or 2nd post-OR candle | ✅ | ✅ | ✅ | ✅ |
| Headroom to next level ever checked | ❌ | ❌ | ❌ | ❌ |
| Participation ever checked | ❌ | ❌ | ❌ | ❌ |

**All five trades — including the winner — were entered on the first or second candle after the OR
closed.** 09:30–09:45 IST is the highest-noise, lowest-information window of the NIFTY session: it is
where overnight order flow is absorbed and where stop-runs are cheapest to execute. The strategy
concentrates 100% of its risk there. That is a structural exposure choice nobody made deliberately.

---

## 4. New architecture

### 4.1 The principle

> **Fix what a trade *is*, not how many filters guard it.**

Adding twelve filters to a 5-trade sample is curve-fitting with extra steps. The redesign changes three
structural things and expresses everything else as a *transparent, logged, continuously-scored*
ranking that you calibrate later on real data.

### 4.2 Module layout — one owner per concern

```
src/strategies/orb/
  index.js          public API — evaluateEntry / onTick / onCandleClose  (the ONLY entry point)
  context.js        frozen day context @ 09:30: OR, ATR5, ATR15, gap, prior-day H/L/C,
                    CPR (P/BC/TC), weekly H/L, day-type classification
  volatility.js     intraday-only ATR (the 1.1 fix) + range-expansion helpers
  breakout.js       committed-breakout detection, confirmation, retest/resume  (from orb_breakout.js)
  score.js          the 0–100 quality score: components, penalties, explain()
  risk.js           structural stop → position size → accept/reject   (replaces orbStopRisk clamp)
  exits.js          onTick exits + onCandleClose exits — SINGLE implementation
```

`src/strategies/orb_breakout.js` becomes a thin re-export so nothing outside breaks in one step.

### 4.3 The contract every mode uses

```js
// Once per 5-min close, when flat:
const decision = orb.evaluateEntry({ candles, context, alreadyTraded, chain });
// → { signal:"BUY_CE"|"BUY_PE"|"NONE", score, components[], penalties[], gates[],
//     entrySpot, stopSpot, stopPts, stopInsideBox, lots, riskINR, reason, rejectedBy }

// Every tick, when in position:
const t = orb.onTick(position, { spot, optionLtp });
// → { exit:false } | { exit:true, reason }

// Once per 5-min close, when in position:
const c = orb.onCandleClose(position, bar, candles);
// → { exit:false, stopSpot? } | { exit:true, reason } | { partial: lots, reason }
```

Rules:

- **No exit logic outside `exits.js`.** `orbPaper`, `orbLive`, `orbBacktest` and `orbValidate` all
  become thin adapters that translate a decision into a fill.
- **`evaluateEntry` is pure** given `(candles, context, chain)`. `chain` is `null` in backtest; every
  chain-dependent component then reports `unavailable` and contributes its **neutral** value, and that
  fact is stamped on the decision so the backtest page can keep disclosing the gap.
- **Backtest feeds synthetic ticks through the real `onTick`** in the order `open → adverse extreme →
  favourable extreme → close`, preserving the intrabar-first ordering `orbBacktest.js` already
  documents. This is what makes backtest == paper by construction instead of by review.
- Replay is unchanged — it already drives paper's `onTick`.

### 4.4 Why score-and-log rather than more hard gates

A hard gate destroys information: a rejected day leaves no measurable counterfactual. A **score
recorded on every candle** — taken *and* rejected — turns the next six months into a dataset you can
regress realised R against. Because the score is logged and the candles are recorded, *any* threshold
can be re-evaluated retrospectively without re-running the market.

This is the only honest way to end up with calibrated weights. The shipped weights below are
**priors from first principles, not fits.**

---

## 5. Exact entry rules

### Stage 0 — Freeze the day context at 09:30 (once, immutable)

```
OR            = high/low of 09:15–09:30                     [unchanged]
ATR5, ATR15   = intraday-only ATR (see §7 ORB_ATR_INTRADAY_ONLY)
gap           = today.open − prevDay.close
priorDay      = {high, low, close}
CPR           = P=(H+L+C)/3, BC=(H+L)/2, TC=2P−BC           [from prior day]
weekly        = {high, low} of the last 5 sessions
dayType       = TREND_UP | TREND_DOWN | RANGE | GAP_SHOCK
```

`dayType` is mechanical, not fitted: `GAP_SHOCK` if `|gap| > ORB_GAP_OR_MULT × OR`;
`TREND_*` if the OR closed in its top/bottom third **and** spot is on the corresponding side of both
VWAP and the prior-day close; otherwise `RANGE`.

### Stage 1 — Day veto (hard, cheap, few parameters)

| Gate | Rule | Rationale |
|---|---|---|
| `or_vs_atr` | `OR ≤ ORB_OR_ATR_MAX × ATR15` | Wide open ⇒ move already happened |
| `gap_sanity` | `\|gap\| ≤ ORB_GAP_OR_MULT × OR` | Overnight shock is news, not structure |
| `min_dte` | `DTE ≥ ORB_MIN_DTE` | 0DTE gamma breaks the stop model (T2) |
| `risk_throttle` | existing weekly-loss / losing-streak breaker | unchanged |

All fail **open** when their input is unavailable, and all log the numbers. No minimum OR width: the
engine's own ablation found the two best trades came from the two narrowest ranges, so a floor points
the wrong way. Narrowness is rewarded in the **score** instead — continuously, no cliff.

### Stage 2 — Committed breakout (unchanged in shape, corrected in scale)

First in-window 5-min **close** clearing the OR edge by
`buffer = max(ORB_BUFFER_OR_MULT × OR, ORB_BUFFER_ATR_MULT × ATR5, 1)`.
One committed breakout per day. Never buy the breakout candle.

With the ATR fix this buffer stops being inflated by the overnight gap. On 31-Jul it becomes 7.40pt
instead of 11.48pt — entry ~4pt closer to structure, stop ~4pt narrower.

### Stage 3 — Acceptance (this is the new part)

Two entry archetypes. Which are enabled is `ORB_ENTRY_PATH ∈ {confirm, retest, both}` (default `both`).

**Path A — CONFIRM+HOLD (3-bar acceptance).** Current rule *plus one bar*:
1. breakout candle `b` clears the edge and is the correct colour;
2. candle `b+1` extends (higher high **and** higher close beyond the edge);
3. **candle `b+2` does not close back through the breakout candle's close.**

Step 3 is the direct fix for T5, where MFE was reached 3.4 seconds after entry. Two bars measure
*thrust*; the third measures *acceptance*. Cost: one bar of entry price. Benefit: the entire class of
"large body, instant reversal" is filtered by definition rather than by threshold.

**Path B — RETEST-AND-HOLD.** Price returns to within
`max(ORB_RETEST_TOL_MIN, ORB_RETEST_TOL_PCT × OR)` of the edge and closes **beyond** it again, inside
`ORB_RETEST_MAX_WAIT` candles. A close back through the box cancels the day.

> ⚠️ Path B backtested **worse** on the pre-rebuild engine (10.3% WR, PF 0.37 — memory
> `project_orb_backtest_tuning_findings`) because "retest selects WEAK breakouts and discards runaway
> winners". That result was produced with the *same wide stop* as an immediate entry, so a retest entry
> got a smaller edge for identical risk. Under structure-anchored sizing (§6) a retest entry gets a
> proportionally **smaller stop**, so its R changes even if its win rate does not.
> **Do not choose between A and B on 5 trades — run `orbValidate` over ≥2 years and let it decide.**

### Stage 4 — Quality score (0–100), gate at `ORB_MIN_SCORE`

All components are **continuous** (no cliffs), all are logged, all clamp to [0, weight].

| # | Component | Measure | Weight | Rationale |
|---|---|---|---:|---|
| C1 | **OR compression** | `1 − (orRatio − TIGHT)/(WIDE − TIGHT)`, orRatio = OR/ATR15 | 20 | A quiet open stores energy the breakout releases. The engine's own strongest untested hypothesis (OR<1.5×ATR15: 4 trades/75%/+₹10.7k vs OR≥1.5: 5/0%/−₹7.3k). Scored, not gated, because n=9. |
| C2 | **Breakout thrust** | `body_b / ATR5`, scaled over [0.4, 1.2] | 15 | Magnitude of commitment |
| C3 | **Follow-through** | `(extension of b+1 beyond b.close) / ATR5`, over [0.1, 0.8] | 15 | Distinguishes acceptance from a single sweep bar. **The datum T5 had none of.** |
| C4 | **Headroom** | distance to nearest opposing level (prior-day H/L, CPR TC/BC, weekly H/L, round-100) ÷ ATR5, over [0.5, 2.5] | 20 | Answers "is there room to run". Never checked today. T3/T4/T5 all scored ~0 here. |
| C5 | **Trend + VWAP posture** | 15m EMA20 slope sign (½) + signed VWAP distance in ATR5 with an **inverted-U** peak at 0.5–1.5 (½) | 20 | Right side of VWAP is necessary but *too far* is exhaustion. Penalises chasing at the same time as it rewards alignment. |
| C6 | **Participation** | futures OI/volume expansion on bar `b` vs the OR mean, over [1.0, 1.8] | 10 | Index has no spot volume; NIFTY futures do and the repo already polls them. **Neutral 5/10 when unavailable, flagged `estimated`.** |
| | | | **100** | |

Penalties (subtracted, each capped):

| # | Penalty | Measure | Max | Rationale |
|---|---|---|---:|---|
| P1 | **Liquidity sweep** | wick beyond the edge ÷ body on bar `b`, **plus** whether `b` took out the prior 3-bar swing extreme and closed back | −25 | T2, T4, T5 |
| P2 | **Chase** | `(entry − edge)/ATR5` above `ORB_CHASE_ATR_MAX` | −20 | Entry far from structure ⇒ stop can't be both structural and affordable |
| P3 | **Late / expiry** | minutes past `ORB_RANGE_END` scaled to `ORB_ENTRY_END`, plus a flat penalty at DTE ≤ 1 | −15 | An "opening range" breakout decays through the day; 0DTE breaks the stop model |

`score = clamp(ΣC − ΣP, 0, 100)`. Trade iff `score ≥ ORB_MIN_SCORE` (default **60**).

**Every evaluation — accepted or rejected — writes the full vector to the skip log:**

```json
{"gate":"score","score":41,"threshold":60,"side":"PE","spot":24310,
 "components":{"compression":16,"thrust":13,"follow":2,"headroom":3,"trend":11,"participation":5},
 "penalties":{"sweep":-21,"chase":-6,"late":-2},
 "reason":"score 41 < 60 — follow-through 2/15 and headroom 3/20; sweep penalty −21 (wick 2.1× body, swept 3-bar low)"}
```

Because the score is logged and ticks are recorded, **any threshold can be re-evaluated retroactively**
from history. That is what makes the gate cheap to change and impossible to accidentally overfit.

### Stage 5 — Live-only option gates (unchanged + one addition)

Premium band, bid-ask spread, VIX, OI veto — all as today. New, optional, **default off**:
`ORB_OPT_MOM_PCT` — require the option LTP to have risen ≥ N% between the breakout close and the entry
decision. Spot broke out but the premium did not expand ⇒ nobody is paying for it.
**Not modellable in backtest** — must be added to `_paperOnlyGates()`.

---

## 6. Exact exit rules and risk

### 6.1 Structure-anchored stop, then size to fit (replaces the clamp)

```
1. structuralStop = CE: min(b.low, ORH − retestTol)      PE: max(b.high, ORL + retestTol)
2. stopSpot       = clamp(structuralStop, ORB_MIN_STOP_PTS, ORB_MAX_STOP_PTS) from entry
3. stopPts        = |entry − stopSpot|
4. riskPerLot     = stopPts × ASSUMED_DELTA × lotSize
5. lots           = floor(ORB_RISK_PER_TRADE / riskPerLot)
6. if lots < ORB_MIN_LOTS  →  REJECT, log gate:"risk_too_wide"  (never clamp the stop)
```

**This does not, on its own, guarantee the stop escapes the OR box — and it must not pretend to.**
On 31-Jul, `max(b.high, ORL+tol)` = 24344.75, which is still *inside* the box (24328.20–24377.55).
A stop genuinely outside the box (`ORH+tol`) would be 72.55pt from entry — unaffordable at any
sane budget. The lesson is not that the rule is wrong; it is that **when the entry is chased, no
affordable stop exists outside the box.** A stop inside the box is therefore a *diagnostic of a bad
entry*, and the correct response is to reject the trade, never to relocate the stop.

So the decision object carries `stopInsideBox` as a first-class, logged flag, and rejection is handled
where it belongs — by the chase penalty P2, by `ORB_MAX_STOP_PTS`, and by the acceptance bar. The
close-based **box re-entry exit** (§6.2 rule 4) remains the *primary* invalidation; the tick stop is
only the disaster backstop behind it.

**And be honest about the size of the win on 31-Jul: it is small.** The breakout bar closed at
24311.70 with a 33.05pt body, so its open — and therefore a lower bound on its high — is 24344.75.
`max(b.high, ORL + tol)` = `max(≥24344.75, 24333.20)` = **≥24344.75**, i.e. ≥34.75pt of risk against
the clamp's 38.46pt. That is a **~10% reduction, not a transformative one**, and at 0.6 delta × 65 it
still costs ₹1,355/lot — barely inside a ₹1,500 budget.

The reason is 1.3: entry was 16.5pt *below* ORL, so every structural anchor is far away by
construction. **You cannot fix a chased entry with a better stop rule.** On 31-Jul the changes that
actually matter are the acceptance bar (§5 Stage 3) and the chase penalty P2 — which is why the stop
redesign is Phase 3 and not Phase 1.

Where structure-anchored sizing genuinely pays is the setup class this engine currently has no way to
express: an entry *near* the edge (retest, or a tight confirm) where the invalidation is 10–20pt away.
There the stop is small in points, the budget funds it easily, and R roughly doubles for the same
rupees. Under the clamp that setup is impossible to distinguish from a chase — both get 38.46pt.

`ORB_RISK_MODE=clamp` preserves the legacy behaviour for A/B comparison for one release.

### 6.2 Exits, in evaluation order

**On every tick** (`exits.onTick`):
1. Per-trade rupee backstop `ORB_MAX_TRADE_LOSS` — unchanged, now genuinely a *backstop* rather than
   the primary stop.
2. Premium disaster stop `ORB_PREMIUM_STOP_PCT` — unchanged.
3. Hard SL at `position.stopSpot`.

**On every 5-min close** (`exits.onCandleClose`), in order:
4. **Box re-entry exit [NEW].** Close back inside the OR box ⇒ the breakout failed. Exit.
   `ORB_BOX_REENTRY_EXIT=true`. This is the *structural* invalidation the strategy has never had; it
   supersedes the blunt "strong opposite candle body ≥ 0.3×OR" rule, which requires a large bar to
   admit a failure that a small bar proves just as well.
5. **Time stop [NEW].** After `ORB_TIME_STOP_CANDLES` (default 4 = 20 min), if favourable excursion
   `< ORB_TIME_STOP_MIN_R` × stopPts, exit. Reuses `tradeGuards.checkTimeStop` — do not re-implement.
   Direct answer to T4, which bled 4.3% of premium over 23 minutes on a 0.35pt net spot move.
6. **Breakeven.** `max(ORB_BREAKEVEN_PTS, ORB_BREAKEVEN_OR_MULT × OR)` — unchanged. Measured as the
   single most valuable exit component and flat over 10–25pt, so not a fitted edge.
7. **Optional partial at 1R.** `ORB_PARTIAL_AT_R`, **default 0 = OFF**. Deliberately off: this is a
   right-tail strategy (best trade = 211% of net in the 39-session study) and partials cut exactly the
   tail that pays for everything. The dial exists so you can measure the claim, not because it is
   recommended.
8. **EMA trend-trail.** `ORB_TRAIL_EMA` (20) — unchanged. Measured *not* flat (9 too tight, 34 beat 20
   in-sample) but anything in 13–55 is within noise, so the incumbent stays.
9. **EOD square-off** at `ORB_FORCED_EXIT`.

### 6.3 Re-entry after a correct-but-early stop

08-Jul was directionally right and stopped 5 hours early. `ORB_MAX_DAILY_TRADES=1` forbids the
re-entry. **Recommendation: leave it at 1 for now.** A second entry doubles the daily variance on a
strategy with `P(edge ≤ 0) ≈ 39%`. Revisit only after the long-sample validation shows a positive
expectancy for the first trade. Logged here so the idea is not lost.

---

## 7. New configurable settings

All appear in the Settings UI (repo rule: no key ships without a toggle) and in README.md.

**Bug fix / compatibility**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `ORB_ATR_INTRADAY_ONLY` | toggle | `true` | Exclude the cross-session bar from ATR true range so ATR(5m)/ATR(15m) measure *today*. `false` = legacy (gap-contaminated). **Temporary — delete after validation.** |

**Entry & score**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `ORB_ENTRY_PATH` | select | `both` | `confirm` \| `retest` \| `both` |
| `ORB_ACCEPTANCE_BARS` | number | `1` | Extra bars of acceptance after confirmation (0 = today's behaviour, 1 = the 3-bar rule) |
| `ORB_SCORE_ENABLED` | toggle | `true` | Gate on the quality score |
| `ORB_MIN_SCORE` | number 0–100 | `60` | Minimum score to trade |
| `ORB_SCORE_W_COMPRESSION` | number | `20` | Weight — OR compression |
| `ORB_SCORE_W_THRUST` | number | `15` | Weight — breakout body |
| `ORB_SCORE_W_FOLLOW` | number | `15` | Weight — follow-through |
| `ORB_SCORE_W_HEADROOM` | number | `20` | Weight — room to the next level |
| `ORB_SCORE_W_TREND` | number | `20` | Weight — trend + VWAP posture |
| `ORB_SCORE_W_PARTICIPATION` | number | `10` | Weight — futures OI/volume expansion |
| `ORB_SCORE_P_SWEEP` | number | `25` | Max liquidity-sweep penalty |
| `ORB_SCORE_P_CHASE` | number | `20` | Max chase penalty |
| `ORB_SCORE_P_LATE` | number | `15` | Max late/expiry penalty |
| `ORB_OR_TIGHT_ATR` | number | `1.0` | OR/ATR15 scoring full marks |
| `ORB_OR_WIDE_ATR` | number | `2.5` | OR/ATR15 scoring zero |
| `ORB_HEADROOM_ATR_TARGET` | number | `2.5` | Headroom (×ATR5) scoring full marks |
| `ORB_CHASE_ATR_MAX` | number | `1.0` | Entry distance from edge (×ATR5) at which the chase penalty maxes |
| `ORB_LEVEL_SOURCES` | multi | `priorday,cpr,weekly,round` | Which levels feed the headroom test |
| `ORB_MIN_DTE` | number | `1` | Skip entries with fewer days to expiry (1 = no 0DTE) |
| `ORB_OPT_MOM_PCT` | number | `0` | Require option LTP up N% since the breakout close. 0 = off. **Paper/live only.** |

**Risk & exits**

| Key | Type | Default | Meaning |
|---|---|---|---|
| `ORB_RISK_MODE` | select | `size` | `size` = structural stop + size to fit · `clamp` = legacy |
| `ORB_RISK_PER_TRADE` | number | `1500` | Rupee budget used to compute lot size |
| `ORB_MIN_LOTS` | number | `1` | Reject the trade if the budget cannot fund this many lots |
| `ORB_MIN_STOP_PTS` | number | `8` | Floor on the structural stop |
| `ORB_MAX_STOP_PTS` | number | `45` | Skip the trade if structure demands a wider stop |
| `ORB_BOX_REENTRY_EXIT` | toggle | `true` | Exit on a 5-min close back inside the OR box |
| `ORB_TIME_STOP_CANDLES` | number | `4` | Exit after N candles if not sufficiently in profit |
| `ORB_TIME_STOP_MIN_R` | number | `0.5` | "Sufficiently" = this × the initial stop distance |
| `ORB_PARTIAL_AT_R` | number | `0` | Book a partial at N×R. 0 = off (recommended) |

**Removed / deprecated**

`ORB_SL_ATR_MULT` (inert under `clamp`, superseded under `size`) · `ORB_OPP_CANDLE_EXIT` +
`ORB_OPP_CANDLE_BODY_MULT` (superseded by box re-entry) · `ORB_MAX_DAILY_LOSS` (unreachable at 1
trade/day — keep the key, fix the UI note).

---

## 8. Expected advantages

1. **The gates finally measure what they claim.** Fixing ATR removes a systematic ~2× distortion from
   the body gate, the buffer and the day filter simultaneously. Every constant in the engine becomes
   interpretable for the first time.
2. **The stop becomes diagnostic instead of arbitrary.** Derived from the trade's own invalidation, it
   is small when the entry is good and — critically — *visibly* too wide or box-bound when the entry
   is a chase, which is information the ₹1,500 clamp destroys by construction. Note this is **not**
   the biggest P&L lever: §1.4's oracle test shows even a perfect exit returns only ₹362/trade, so
   the entry changes (4, 5) dominate. This one mostly stops good setups being priced like bad ones.
3. **Better R per trade at the same rupee risk — on near-edge entries only.** A stop derived from the
   trade's own invalidation is small when the entry is close to structure and large when it is not,
   so the budget funds *more* size on exactly the setups that deserve it. On a chased entry like
   31-Jul the gain is only ~10% (§6.1) — the multiplier lives in the retest/tight-confirm class the
   clamp currently makes indistinguishable from a chase.
4. **Fake breakouts are excluded by construction, not by threshold.** The third acceptance bar and the
   sweep penalty target the exact signature present in T2, T4 and T5. Threshold-based filters can be
   dodged by a 33-point body; a *reversal within one bar* cannot.
5. **Fewer, better trades — by design.** Sweep penalty + headroom + acceptance bar will cut the trade
   count further from an already-low base. That is the stated goal; the risk is stated in §9.
6. **Rejections become data.** Full component vectors on every evaluation turn six months of
   not-trading into a regression dataset. Today a rejected day leaves one sentence.
7. **Paper == Live == Backtest == Replay, structurally.** One `exits.js`. Four adapters. The class of
   bug already documented in `orbBacktest.js` becomes impossible rather than merely fixed.
8. **The pathological option cases are gated.** No 0DTE; premium momentum optionally required.

---

## 9. Possible disadvantages — read these before approving

1. **Trade frequency may collapse to unvalidatable levels.** The engine already takes ~1 trade per 14
   sessions. Adding an acceptance bar, a sweep penalty, a headroom test and a score gate could take it
   to 1 per 30. At that rate the ~147 trades needed for 95% confidence take **decades**.
   *This is the single biggest risk in the whole proposal.* Mitigations: ship `ORB_MIN_SCORE` low
   (60), log the score on rejections so the threshold is retro-fittable, and treat the ATR fix as
   *loosening* (it lowers the inflated body threshold and should raise the count materially).
2. **The score is 11 numbers calibrated on nothing.** It is a first-principles prior. It will look
   authoritative on the dashboard long before it is. Until the regression exists, treat it as a *sort
   order and an explanation*, never as a probability.
3. **The acceptance bar costs entry price on real winners.** On a genuine trend day the third bar is
   the most expensive one. This may reduce the right tail — the tail that pays for everything.
   `ORB_ACCEPTANCE_BARS=0` must exist so this is measurable, and it must be measured.
4. **The retest path has a negative prior.** Backtested at 10.3% WR / PF 0.37 pre-rebuild. The
   structural-sizing argument for revisiting it is plausible, not proven.
5. **Headroom and participation are new failure surfaces.** CPR/pivot maths on a stale prior day, or
   futures OI on a roll day, can veto good trades silently. Both must fail **open** and log it.
6. **Backtest still cannot see the option chain.** Premium band, spread, OI and the new
   `ORB_OPT_MOM_PCT` remain paper-only. Any conclusion from `orbValidate` remains an upper bound on
   trade count.
7. **The ATR fix invalidates every historical comparison.** All 39-session ablation numbers, all
   thresholds, all prior conclusions were produced with the contaminated ruler. They must be re-derived.
8. **This is a large change to a strategy with `P(edge ≤ 0) ≈ 39%`.** It may simply be that ORB
   long-options on NIFTY has no edge. The proposal buys a much better measuring instrument; it does not
   guarantee something to measure. **Budget for the answer being "retire ORB."**

---

## 10. Step-by-step implementation plan

Ordered so the highest-confidence, lowest-risk changes ship first and each phase is independently
verifiable. **Nothing goes live until `LIVE_HARNESS_DRY_RUN` has been off-tested via `/replay`.**

### Phase 0 — Establish the baseline (no code) · ½ day
- `node scripts/orbValidate.js --from 2023-01-01 --to 2026-07-31` → record net / WR / PF / P(edge≤0) /
  trade count with today's code. **Every later phase is measured against this number, not against −₹4,229.**
- If the Fyers token is stale you will get 0 candles — that is an expired token, not a date problem
  (see memory `reference_backtest_zero_candles_stale_token`).

### Phase 1 — The ATR fix, alone · 1 day *(highest confidence, smallest diff)*
- `volatility.js`: true range uses `high−low` only when the previous bar is from a different IST day.
- Behind `ORB_ATR_INTRADAY_ONLY` (default `true`), Settings + README.
- **Verify:** re-run `orbValidate`. Expect a materially higher trade count and *lower* body thresholds.
  Assert `ATR5 < OR_width` on every session — the 29-Jul violation must disappear.
- Ship this on its own. It is a bug fix and its effect must be attributable.

### Phase 2 — Extract `exits.js`, no behaviour change · 2 days
- Move `_managePositionOnClose` + `_checkExits` verbatim into `src/strategies/orb/exits.js`.
- Rewire `orbPaper`, `orbLive`, `orbBacktest`, `orbValidate` to call it. Delete all four copies.
- Backtest drives the real `onTick` with synthetic ticks `open → adverse → favourable → close`.
- **Verify:** `orbValidate` output must be **byte-identical** to Phase 1. A single differing trade means
  the extraction changed behaviour — fix before continuing. Replay a recorded session and diff against
  the live paper record (baseline = the on-disk paper trades; snapshot mode must match exactly).

### Phase 3 — `risk.js`: structural stop + size-to-fit · 2 days
- New module; `ORB_RISK_MODE=size|clamp`, `ORB_MAX_STOP_PTS`, `ORB_MIN_LOTS`, `ORB_RISK_PER_TRADE`.
- Reject with `gate:"risk_too_wide"` rather than clamping.
- Keep `ORB_MAX_TRADE_LOSS` as the per-tick backstop. Emit `stopInsideBox` on every decision.
- **Verify:** run `orbValidate` with `size` vs `clamp` over the full sample and report both. Then
  check the invariant that actually holds: **no stop is derived from the rupee budget** (every
  `stopSpot` traces to `b.high`/`b.low` or the box edge), and report the *rate* of `stopInsideBox`
  with its P&L split. Do **not** assert that no stop lies inside the box — §6.1 shows that is
  unachievable at an affordable budget on a chased entry. If `stopInsideBox` trades are not
  materially worse than the rest, the chase hypothesis is wrong and P2 needs rethinking.

### Phase 4 — Structural exits · 1 day
- Box re-entry exit; time stop via `tradeGuards.checkTimeStop`; retire the opposite-candle rule.
- **Verify:** `orbValidate` A/B for each exit independently, not bundled.

### Phase 5 — `context.js` + `score.js` · 3 days
- Day context (prior day, CPR, weekly, day-type), then the six components and three penalties.
- **Ship with `ORB_SCORE_ENABLED=true`, `ORB_MIN_SCORE=0`** for the first two weeks: score everything,
  gate nothing, log everything. This builds the calibration dataset without changing behaviour.
- `/orb-paper` and `/orb-backtest` render the component breakdown per trade; skip log carries the full
  vector; `tradeLogger` persists `score` + `components` on every trade record.
- **Verify:** the score of the 5 historical trades is computable and the ordering is sane —
  T5 and T2 must rank at the bottom. This is a **sanity check, not a fit**; do not tune weights to it.

### Phase 6 — Acceptance bar + entry paths · 2 days
- `ORB_ACCEPTANCE_BARS`, `ORB_ENTRY_PATH`, `ORB_MIN_DTE`.
- **Verify:** `orbValidate` over the full sample for the 2×3 grid of `ACCEPTANCE_BARS × ENTRY_PATH`.
  Report every cell including trade counts. **Pick nothing with fewer than 30 trades.**

### Phase 7 — Turn the gate on · ongoing
- Set `ORB_MIN_SCORE` from the Phase 5/6 distribution — the percentile that keeps ≥30 trades over the
  validation window, not the one that maximises backtest P&L.
- Wire the score into `/realtime` and the dashboard rollups (repo rule: new signals must appear on the
  shared monitors, gated by `ORB_MODE_ENABLED`).
- Run paper for ≥20 sessions. `/replay` each one in snapshot mode; paper and replay must match exactly.
- Only then consider `ORB_LIVE_ENABLED` with `LIVE_HARNESS_DRY_RUN=false`.

### Phase 8 — Calibrate, then delete
- After ~50 scored trades (taken *and* rejected-then-simulated), regress realised R on each component.
- Set weights from the regression. **Delete any component whose coefficient is indistinguishable from
  zero** — a component that does not predict is a parameter that overfits.
- Remove `ORB_ATR_INTRADAY_ONLY` and `ORB_RISK_MODE=clamp` once the new paths are validated.

### Non-negotiables throughout
- `node -c` on every touched file; commit per phase, never bundled.
- Do not push 09:00–15:30 IST on a weekday (`.githooks` pre-push will block it — report the block, do
  not bypass).
- Paper decision/fill/exit semantics remain canonical: when backtest or live disagrees with paper,
  fix backtest/live.
- Every new key gets a Settings UI entry, a README line, and a CHANGELOG entry.

---

## Appendix — the three numbers to remember

| | |
|---|---|
| **₹1,809** | Total P&L of all 5 trades under a *perfect clairvoyant exit*. The exits are not the problem. |
| **5 of 5** | Trades whose recorded `initialStopLoss` sat **inside** their own opening range box — under two different stop rules, because none of them references the box. |
| **58pt** | ATR(5m) the engine believed on 29-Jul, on a day whose entire 15-min opening range was 51.6pt. |
