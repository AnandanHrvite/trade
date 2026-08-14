---
name: new-strategy
description: Build a BRAND-NEW strategy end-to-end from its rules — engine, Paper/Backtest/Live routes, Settings, sidebar, monitors, replay, logs, persistence, docs, tests. Do NOT use for tuning, bug fixes, or rule changes to an existing strategy.
---

# New Strategy — full build from core rules only

The user will give you **only the trading logic**. Everything else in this document is
your job and must NOT be asked about. They have specified the plumbing once already;
never make them do it again.

Treat the user's rules as the complete specification of *what to trade*. Add **no**
filters, gates, confirmations or "improvements" they did not ask for — no VIX, OI,
ADX, volume, ATR, VWAP, multi-timeframe, quality score, confirmation candle. If you
believe one is needed, finish the build as specified and raise it at the end as a
suggestion.

---

## Phase 0 — Pin the rules before writing anything

Most rework comes from under-specified rules, not bad code. Read the user's message
and check each item below. **Only ask about what is genuinely ambiguous and would
change the code** — batch the questions into ONE `AskUserQuestion` call with plain-
English options and real numbers. Never ask about anything in Phase 1+.

Ambiguities that have actually caused rework here:

| Question | Why it matters |
|---|---|
| **Which day/bar does each indicator read?** "RSI above 90" — today's forming bar, or yesterday's closed bar? | Completely different numbers. Cost 2 rebuilds on GAPS. |
| **Is the exit a fixed target or a trailing stop?** "exit at EMA21" is ambiguous. | A target exits when price reaches a level *in your favour*; a trail exits when price closes back *through* it — opposite comparisons. Cost 1 rebuild on GAPS. |
| **Is the stop a price level or a distance?** "SL = the gap" | A level is fixed; a distance is measured from the actual fill. They only coincide when the fill is exactly at the reference price. Cost 1 rebuild on GAPS. |
| **Which timeframe** for signal vs exit? | e.g. daily signal + 5-min exits is normal here. |
| **If nothing hits, when do we exit?** | Almost always "square off at forced-exit time", but confirm. |
| **Strike selection** — ATM, ITM n steps? | Defaults to `{MODE}_ITM_STEPS`. |
| **Anything the user explicitly said to leave OUT?** | Record it in the engine header comment so nobody "helpfully" adds it later. |

If the user later corrects a rule, change the **engine** and let it flow outward —
never patch the routes to compensate.

---

## Phase 1 — The engine (the only place rules exist)

Create `src/strategies/{name}.js`. This file is the single source of truth. Paper,
Backtest, Live and Replay all call into it; **no rule may be re-implemented anywhere
else**. Verify at the end with a grep that no route contains indicator maths.

Required shape:

```js
function getConfig()                       // live read of process.env — NEVER cache
function computeXxx(candles, cfg)          // time-aligned series, so charts plot the
                                           // exact numbers the signal used
function getSignal(candles, price, opts)   // -> { signal, side, reason, skipReason,
                                           //      entrySpot, slSpot, slPts, warmup, ... }
```

Rules that have bitten this repo:

- **Header comment states the rules AND the deliberate omissions.** Include which
  bar each indicator reads and why.
- **Refuse rather than guess.** Not enough history → `warmup: true` with a reason
  string. A daily series that has two bars on one IST day → refuse (it means someone
  handed you intraday candles). Never quote a stale indicator as if it were current.
- **Determinism is load-bearing.** Any value the decision depends on must be
  reproducible from recorded data. Use the candle's **open/close**, never the live
  spot, for anything the signal reads — a live-spot input drifts every second and
  Replay can never reproduce it, which breaks Paper≡Replay.
- **Every guard uses `typeof x === "number" && Number.isFinite(x)`.**
  `Number(null) === 0` and `Number("") === 0`, so coercion silently invents a price.
- **`_istDayOf(unixSec) = Math.floor((unixSec + 19800) / 86400)`** for IST day
  arithmetic. Copy it; don't re-derive.
- Indicator index alignment for the `technicalindicators` package:
  `EMA(p)` over N values → N−p+1 outputs, `out[i] ↔ values[i+p-1]`.
  `RSI(L)` over M values → M−L outputs, `out[j] ↔ values[j+L]`.
  Assert this in the test harness rather than trusting it.

---

## Phase 2 — The three routes

Copy the structure of the most recently built strategy (currently
`src/routes/gapFix3m*.js`; before that `trendDayScalp*.js`). Do **not** invent a
new shape.

- `src/routes/{name}Paper.js` — **canonical**. Every decision/fill/exit semantic
  lives here. Renders its own HTML, owns `/start /stop /exit /status /status/data
  /status/chart-data /history /reset /view/... /download/...` plus the two session
  endpoints the shared history UI (`src/utils/paperHistoryUI.js`) actually calls:
  `POST /restore-session/:date` and `DELETE /session/:index`. All nine Paper routers
  register both. Do **not** add `POST /delete-session/:idx` — four older routes still
  carry it, but it is unreachable from any UI and it mutates `totalPnl` without
  recomputing `capital` (see the note at `src/routes/orbPaper.js:1840`, where it was
  deliberately deleted).
- `src/routes/{name}Backtest.js` — calls the **same** `getSignal`; only re-implements
  paper's exits. Conservative intra-bar ordering: the adverse stop is tested on the
  bar's high/low **before** any favourable exit on the close, and a bar that opened
  beyond the stop fills at the open, never the better level. Apply a slippage haircut
  both ways (`{MODE}_BT_SLIPPAGE_PTS`) — without it, backtests of option *buying*
  always flatter.
- `src/routes/{name}LiveHarness.js` — wraps Paper via
  `require("../services/liveHarness").installHarness({ mode, modeTag, broker,
  liveLogKey })`, so **Live ≡ Paper by construction**. Triple-gate real orders:
  `{MODE}_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND
  `{MODE}_LIVE_DRY_RUN≠true`.

Paper-route specifics that have caused real bugs:

- All entry guards must be **synchronous before the first `await`**, or concurrent
  ticks double-enter.
- Lock "decided for today" **only once a position exists**; a failed entry (option
  LTP unavailable) must retry inside the entry window, throttled (~5s).
- Per-strategy sizing: `getLotQty()` already applies and **clamps** the global
  multiplier, so divide by the *clamped* value, not the raw `LOT_MULTIPLIER`.
- Weekly P&L reads the per-day JSONL files; substitute the in-memory session for
  today **only while running**, because an idle page may hold a rehydrated older
  session and would double-count it.
- Any exit comparison against a level must first check the level is a finite number.
  `spot >= null` is `spot >= 0` → instant exit on the first tick.
- Right after rehydrating a saved session, call
  `require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => state, "[{MODE}-PAPER]")`
  — without it a restart before the day's first trade resurrects yesterday's
  trades and yesterday's chart as today's session.

---

## Phase 3 — Wiring inventory (all of it, every time)

Every file below needed a change for the last strategy. Work through the list; a
missed entry means the strategy is invisible or broken on some screen.

**Core**
- `src/app.js` — 3 route mounts; `START_ALL_ROUTES` row; dashboard card + its
  accent-dot CSS + a `dashSessionTiles` row (the analytics-panel tile list,
  serialised to the client as `SESSION_TILES`); `anyModeActive` + IDLE badge; the
  client-side mode arrays; status-data URL map; crash-recovery
  `load/clear{Name}Position` + the `_liveActive` key list; graceful-shutdown
  activeModes + the `hasLive` mode strings + routeMap;
  **`OPEN_PATHS` *and* `OPEN_PREFIXES`** ← every read-only page (`/{mode}-paper/status`,
  `/status/data`, `/status/chart-data`, `/history`, `/{mode}-live/status/data`, the
  three `/{mode}-backtest` paths, the live page) plus the `/{mode}-paper/view/` and
  `/download/` prefixes. Browser navigations and the dashboard's tile poll carry no
  secret, so **when `API_SECRET` is set** anything missed returns a raw 403
  `{"success":false,"error":"Forbidden — missing or wrong secret."}` (`src/app.js:923`;
  the gate short-circuits with `next()` when `API_SECRET` is unset, `src/app.js:911`).
  Note `OPEN_PREFIXES` is honoured for **GET/HEAD only**, while `OPEN_PATHS` is
  method-agnostic. GAPS shipped without its `OPEN_PATHS` block and every GAPS link in
  the sidebar landed on exactly that.
- `src/routes/settings.js` — new section, every key, 4 TG toggles, `{MODE}_MODE_ENABLED`,
  4 `UI_SHOW_*`, `MODE_SECTION_TITLES`, `_MODE_KEYS`, `RESET_PAPER_MODES`,
  `SECTION_TO_MASTER`.
- `src/utils/sharedNav.js` — `STRATEGY_MODES` row, nav group, LIVE/ON badges.

**Shared state & persistence**
- `src/utils/sharedSocketState.js` — mode var, set/clear/is/get, `canStart` cases for
  `{MODE}_PAPER` / `{MODE}_LIVE`, `isAnyActive`. Returns `{allowed, reason}`.
- `src/utils/positionPersist.js` — save/load/clear → `.active_{name}_position.json`.
  Writes are **async** (queued); a read immediately after a save returns nothing.
  Persist the strategy's real exit levels (stop, trail, …).
- `src/utils/tradeLogger.js` — `{name}` and `{name}-live` in FILE_BY_MODE and
  DAILY_PREFIX_BY_MODE. The live key must match the harness's `liveLogKey` string
  **character for character** — nothing normalises hyphens, underscores or case
  anywhere. On an unknown mode the internal `filePathFor`/`dailyFilePathFor` throw,
  but `appendTradeLog` catches that itself and only warns
  (`[tradeLogger] append failed (mode=…): unknown mode "…"`, visible in `/logs` via
  `logger.js`); it never rethrows, so the harness's `catch (_) {}` never fires. The
  trade is dropped from both the cumulative and the daily JSONL while the run looks
  healthy. Both TDS and GAP3M have that slip today (`gap-fix-3m-live` vs
  `gap_fix_3m-live`, `trend-day-scalp-live` vs `trend_day_scalp-live`).
- `src/utils/skipLogger.js` — `{name}: "{name}_paper_skips_"`.
- `src/utils/capitalPool.js` — a `STRATEGIES` row (`{ broker, label, file }`). The
  paper route calls `check/block/release` with the mode key regardless; an unknown
  key makes all three silent no-ops, so the strategy never draws on — or shows up
  in — its broker's paper pool. TDS and GAP3M are both missing this today.

**Cross-cutting**
- `src/utils/notify.js` — `modeGroup` branch + labels + consolidated-report group.
  TG keys are built dynamically as `TG_${group}_ENTRY` etc.
- `src/utils/tickRecorder.js` — `/^{MODE}_/` settings-snapshot prefix.
- `src/utils/portfolioRisk.js` — add to `PAPER_MODES`.
- `src/utils/consolidatedEodReporter.js` — bucket.
- `src/config/instrument.js` — the ITM-steps branch only (it reads
  `${MODE}_ITM_STEPS` dynamically). There is no per-strategy expiry override any
  more: one common `OPTION_EXPIRY_*` pair serves every engine, so do **not** add a
  `{MODE}_OPTION_EXPIRY_*` key — nothing would read it.

**Replay — `src/services/tickReplay.js`** (easy to under-wire, and silently wrong)
- `MODE_TO_MODULE`, `_MODE_TO_CANONICAL_FILE`, the sharedSocketState stub
  save/install/restore, the preflight `isXxxActive()`, the mode snapshot,
  `forceClearSharedState`. Leave `_MODE_TO_ENV_PREFIX` and `_EXPIRY_PIN_KEYS`
  alone — expiry is common now, and listing a mode there mirrors a
  `{MODE}_OPTION_EXPIRY_*` key nothing reads, which would let replay honour an
  override paper ignores.
- If the strategy reads **daily** candles, confirm the candle stubs pass `D/W/M`
  through to the real fetcher — they only return the intraday warm-up otherwise, and
  the engine would compute a "daily" indicator over 5-min bars.

**Shared screens** — `realtime.js` (row + `hasDayLog` + accent CSS + `BROKER_OF`),
`consolidation.js`, `liveConsolidation.js`, `consolidationReport.js` (paper *and*
live lists), `edgeAnalytics.js` (same), `tradeLogs.js`, `cacheFiles.js`,
`allBacktest.js`, `replay.js`, `docs.js`. `liveConsolidation.js`'s `SOURCES` still
lists only EMA_RSI_ST / BB_RSI / PA — nothing since has been added, so a new
strategy's live trades are invisible there *and* under the dashboard's Live toggle,
which reads `/live-consolidation/data`.

**Docs** — `README.md` (routes table, strategy section, env table), `CHANGELOG.md`,
and a guide in `documents/{NAME}_Strategy_Guide.html` (Phase 5).

---

## Phase 4 — Verification (do all of it; do not report done without it)

1. `node -c` every changed `.js`, then `npm test` — four zero-dependency regression
   suites, and `configFidelity` asserts directly on `app.js`, `settings.js` and
   `instrument.js`, all three of which you just edited.
2. **Offline test harness** in the scratchpad: assert indicator alignment, each entry
   setup, each rejection path, warm-up refusal, every exit branch, configurability of
   each threshold, and the null/NaN guards. Aim for 60+ assertions.
3. **Boot the app** on a spare port and curl every route, JSON feed and export.
   `404` on a day file is correct ("route reached, nothing to serve"); `403` means an
   `OPEN_PATHS` / `OPEN_PREFIXES` entry is missing. Curl with `API_SECRET` set — with
   no secret configured every path is open and the gap stays invisible.
4. **Settings are live**: boot twice with different values, or POST
   `/settings/save` with `{updates:{...}}`, and confirm the strategy config **and the
   chart feed** both move. A chart that disagrees with the strategy is a bug.
5. **Three-way default check**: code `|| "default"` vs the Settings schema vs the
   README table. All three must agree, and no key may be missing from Settings.
6. **No dead settings**: every Settings key is read somewhere. Check dynamic
   `${prefix}_KEY` lookups at runtime — grep cannot see them.
7. **No duplicated logic**: grep the routes for indicator maths and threshold
   comparisons; they belong only in the engine.
8. Confirm visibility everywhere: the strategy appears on `/`, `/realtime`, `/replay`,
   `/all-backtest`, `/trade-logs`, both consolidations and `/edge-analytics`, and
   disappears from all of them when `{MODE}_MODE_ENABLED=false`.

---

## Phase 5 — The strategy guide

Write `documents/{NAME}_Strategy_Guide.html` following the existing nine. The
`TVChart` kit and the mobile CSS block are **copy-pasted** into each guide, not
shared — lift them verbatim from the newest guide.

Non-negotiable: **generate the chart data by running the real engine**, then verify
every number quoted in the prose back against that output. A guide that draws a
hand-invented trade is worse than no guide. Generate the settings table from the
Settings schema for the same reason. QA the charts with `node tools/qaGuides.js` —
it runs every guide's own `<script>` blocks in a node `vm` and asserts real SVG plus
balanced tags — and `node tools/verifyGuideCharts.js`, which checks that every price
a caption quotes is a value that chart actually draws.

Register in `src/routes/docs.js` three times: `GUIDE_MODE_BY_FILE` (hides it when the
strategy is disabled), its own `GUIDE_STATUS` entry (fills the
`<!--LIVE_STATUS_PANEL-->` marker), and a `{MODE}_MODE_ENABLED` row inside the
`Application_Setup_Guide.html` `GUIDE_STATUS` entry. Include an honest "what's still
missing" section — say plainly that it has never traded live and that backtest rupees
are simulated.

---

## Phase 6 — Reporting back

Commit (never push unless told). Then tell the user, in plain English and short:
what the strategy now does, anything you deliberately left out, and the fact that it
is **not market-validated** — clean paper sessions plus a `/replay` comparison must
come before any live gate is touched.

State clearly if the Fyers token is expired: every historical fetch returns 0 candles
and every chart renders blank, which looks like a code bug and is not one.
