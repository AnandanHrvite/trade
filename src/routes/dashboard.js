/**
 * dashboard.js — the Dashboard page ("/") while no paper session runs.
 * ─────────────────────────────────────────────────────────────────────────────
 * app.js owns the route (menu toggle, demo redirect, and the swap to the
 * Real-Time Monitor while any session runs — routes/realtime.js renders that
 * live view); this module only renders the idle page, so it can be rendered
 * and checked without booting the server (tests/dashboard.regression.js).
 *
 * Top to bottom, most important first:
 *   alerts → today's P&L (one chip per market) → market filter →
 *   Today so far / Last session table (grouped by market, subtotals, TOTAL) →
 *   quick links → brokers & option expiry → P&L charts by market.
 * Every strategy list on the page comes from utils/dashboardModel.js (registry ×
 * running pairs), so a newly converted pair appears here with no edit.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const instrumentConfig = require("../config/instrument");
const zerodha  = require("../services/zerodhaBroker");
const { buildSidebar, sidebarCSS, modalCSS, modalJS,
        expiryHolidayModalCSS, expiryHolidayModalHTML, expiryHolidayModalJS,
        dateRangeOptionsHTML, dateRangeJS } = require("../utils/sharedNav");
const { startAllRoster, discoverStartRoutes } = require("../utils/startAllRoster");
const sharedSocketState = require("../utils/sharedSocketState");
const demoMode      = require("../utils/demoMode");
const manualTradesSyncJob = require("../utils/manualTradesSyncJob");

function renderDashboard() {
  const fyersOk     = !!process.env.ACCESS_TOKEN;
  const zerodhaOk   = zerodha.isAuthenticated();
  const zerodhaConf = !!process.env.ZERODHA_API_KEY;
  const bbRsiMode   = sharedSocketState.getBbRsiMode();
  const bbRsiModeOn  = (process.env.BB_RSI_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const paMode      = sharedSocketState.getPAMode ? sharedSocketState.getPAMode() : null;
  const paModeOn    = (process.env.PA_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const orbMode     = sharedSocketState.getOrbMode ? sharedSocketState.getOrbMode() : null;
  const orbModeOn   = (process.env.ORB_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const ema9vwapMode   = sharedSocketState.getEma9VwapMode ? sharedSocketState.getEma9VwapMode() : null;
  const ema9vwapModeOn = (process.env.EMA9VWAP_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const trendPbMode    = sharedSocketState.getTrendPbMode ? sharedSocketState.getTrendPbMode() : null;
  const trendPbModeOn  = (process.env.TREND_PB_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const tdsMode        = sharedSocketState.getTrendDayScalpMode ? sharedSocketState.getTrendDayScalpMode() : null;
  const tdsModeOn      = (process.env.TDS_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const haScalpMode    = sharedSocketState.getHaScalpMode ? sharedSocketState.getHaScalpMode() : null;
  const haScalpModeOn  = (process.env.HA_SCALP_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const prevOrbScalpMode   = sharedSocketState.getPrevOrbScalpMode ? sharedSocketState.getPrevOrbScalpMode() : null;
  const prevOrbScalpModeOn = (process.env.PREV_ORB_SCALP_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const itm20ScalpMode   = sharedSocketState.getItm20ScalpMode ? sharedSocketState.getItm20ScalpMode() : null;
  const itm20ScalpModeOn = (process.env.ITM20_SCALP_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const earlyBirdMode   = sharedSocketState.getEarlyBirdMode ? sharedSocketState.getEarlyBirdMode() : null;
  const earlyBirdModeOn = (process.env.EARLYBIRD_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const simple930Mode    = sharedSocketState.getSimple930Mode ? sharedSocketState.getSimple930Mode() : null;
  const simple930ModeOn = (process.env.SIMPLE930_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const rsiPivotStMode   = sharedSocketState.getRsiPivotStMode ? sharedSocketState.getRsiPivotStMode() : null;
  const rsiPivotStModeOn = (process.env.RSI_PIVOT_ST_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const emaRsiStV2Mode   = sharedSocketState.getEmaRsiStV2Mode ? sharedSocketState.getEmaRsiStV2Mode() : null;
  // V2 defaults OFF, unlike every other strategy's 'true' — it is unvalidated.
  const emaRsiStV2ModeOn = (process.env.EMA_RSI_ST_V2_MODE_ENABLED || 'false').toLowerCase() === 'true';
  const stRsiPivBbMode   = sharedSocketState.getStRsiPivBbMode ? sharedSocketState.getStRsiPivBbMode() : null;
  // ST_RSI_PIV_BB — defaults OFF like V2.
  const stRsiPivBbModeOn = (process.env.ST_RSI_PIV_BB_MODE_ENABLED || 'false').toLowerCase() === 'true';
  const sailVwapStMode   = sharedSocketState.getSailVwapStMode ? sharedSocketState.getSailVwapStMode() : null;
  // SAIL_VWAP_ST — defaults OFF.
  const sailVwapStModeOn = (process.env.SAIL_VWAP_ST_MODE_ENABLED || 'false').toLowerCase() === 'true';
  // PIVOT_EMA_ST — defaults ON (the user wants Start All to start it).
  const pivotEmaStMode       = sharedSocketState.getPivotEmaStMode ? sharedSocketState.getPivotEmaStMode() : null;
  const pivotEmaStModeOn     = (process.env.PIVOT_EMA_ST_MODE_ENABLED || 'true').toLowerCase() === 'true';
  // GAP_RUNAWAY (NIFTY) + its stock scanner — default ON (Start All starts them).
  const gapRunawayMode       = sharedSocketState.getGapRunawayMode ? sharedSocketState.getGapRunawayMode() : null;
  const gapRunawayModeOn     = (process.env.GAP_RUNAWAY_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const gapRunawayStkMode    = sharedSocketState.getGapRunawayStkMode ? sharedSocketState.getGapRunawayStkMode() : null;
  const gapRunawayStkModeOn  = (process.env.GAP_RUNAWAY_STK_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const analyticsPanelOn = (process.env.UI_DASHBOARD_ANALYTICS_PANEL || 'true').toLowerCase() === 'true';
  // Every strategy and running (strategy, market) pair switched ON, market by
  // market (utils/dashboardModel.js — registry × pairs, never hand-typed). Each
  // section below — hero chips, market filter, today's table, P&L charts,
  // broker pools — is built from this one list, so a newly converted pair
  // appears on every one of them with no edit here.
  const dashboardModel = require("../utils/dashboardModel");
  const dashboardUI    = require("../utils/dashboardUI");
  const _dashRows    = dashboardModel.enabledRows();
  const _dashMarkets = dashboardModel.marketsOf(_dashRows);

  // True when ANY strategy is currently running. While active we
  // hide the dashboard's control buttons (Start All), broker
  // connection cards, and schedule/cache pills so they can't be touched or
  // distract mid-trade — the running-status badge stays visible. Mirror of the
  // IDLE condition used for the top-bar badge below.
  const anyModeActive = (bbRsiModeOn && bbRsiMode)
    || (paModeOn && paMode)
    || (orbModeOn && orbMode)
    || (ema9vwapModeOn && ema9vwapMode)
    || (trendPbModeOn && trendPbMode)
    || (tdsModeOn && tdsMode)
    || (haScalpModeOn && haScalpMode)
    || (prevOrbScalpModeOn && prevOrbScalpMode)
    || (itm20ScalpModeOn && itm20ScalpMode)
    || (earlyBirdModeOn && earlyBirdMode)
    || (simple930ModeOn && simple930Mode)
    || (rsiPivotStModeOn && rsiPivotStMode)
    || (emaRsiStV2ModeOn && emaRsiStV2Mode)
    || (stRsiPivBbModeOn && stRsiPivBbMode)
    || (sailVwapStModeOn && sailVwapStMode)
    || (pivotEmaStModeOn && pivotEmaStMode)
    || (gapRunawayModeOn && gapRunawayMode)
    || (gapRunawayStkModeOn && gapRunawayStkMode)
    || (sharedSocketState.heldSlots ? sharedSocketState.heldSlots().length > 0 : false);
  // The mode-specific top-bar badge below only covers ORB_PAPER. When some
  // OTHER mode is active we still want a running indicator visible — show a
  // generic badge in that gap.
  const specificBadgeShown = (orbModeOn && orbMode === 'ORB_PAPER');

  // Rows for the "Today so far" / "Last session" table. Each links to its
  // paper page as discovered from the mounted routers (null when the route is
  // not mounted — a plain name, never a dead link), and polls its own
  // /status/data during market hours.
  const _dashNorm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const _dashTileRoutes = discoverStartRoutes();
  const dashSessionTiles = _dashRows.map((r) => ({
    key: r.key,
    label: r.label,
    market: r.market,
    accent: r.accent,
    paper: ((_dashTileRoutes.get(_dashNorm(r.paperPrefix.replace(/^\//, '').replace(/-paper$/, ''))) || {}).pages || {}).paper || null,
    statusData: r.paperPrefix + '/status/data',
  }));

  // ── Start-All roster — the enabled strategies (same helper the sidebar uses)
  // joined to the start routes discovered from the mounted routers. Read per
  // request because Settings saves mutate process.env live; the buttons refetch
  // it again on click (/api/start-all-roster) so a strategy enabled after this
  // page was rendered still starts without a reload.
  const startAllModes = startAllRoster();
  // Button-state poll: same roster, /start → /status/data on each wired route.
  const startAllPollTargets = startAllModes.map((m) => ({ url: m.paper.replace('/start', '/status/data'), kind: 'paper' }));
  // Endpoint → display name, for the Start-All failure list.
  // Built from the roster so it cannot drift from the endpoints actually called.
  const startAllEndpointLabels = {};
  for (const m of startAllModes) startAllEndpointLabels[m.paper] = `${m.label} Paper`;
  // How many /start calls the Start-All button runs at once (Settings → Server & Broker).
  // A hand-edited 0 or negative means one-at-a-time (clamped to 1), not the default.
  const _saC = parseInt(process.env.START_ALL_CONCURRENCY || "5", 10);
  const startAllConcurrency = Number.isFinite(_saC) ? Math.max(1, Math.min(10, _saC)) : 5;

  // ── Broker investment pools (paper) — remaining = pool + paper P&L over the
  // top-bar date range, summed over every ENABLED strategy that trades through
  // that broker (same broker map as utils/capitalPool.js).
  //
  // The P&L half is filled in client-side from the same trade list the charts
  // read, not from each file's all-time `totalPnl`: a wallet that ignored the
  // range sat next to a range-filtered curve and the two openly disagreed.
  // Sharing `_applyDashRange` is what keeps them from drifting apart again.
  const zerodhaInv = parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000");
  const fyersInv   = parseFloat(process.env.FYERS_INV_AMOUNT   || "100000");
  // Each enabled row's capitalPool broker (registry broker; pairs carry their own).
  const _poolModes = _dashRows.map((r) => [r.broker, r.key, true]);
  const _modesOf = (broker) => _poolModes.filter(([b, , on]) => b === broker && on).map(([, m]) => m);
  const brokerPools = {
    fyers:   { inv: fyersInv,   modes: _modesOf('fyers') },
    zerodha: { inv: zerodhaInv, modes: _modesOf('zerodha') },
  };
  const _inr0 = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  // Rendered with the pool alone and a "…" delta: the range-filtered number is
  // only knowable once the trade list lands, and showing an all-time figure in
  // the meantime is exactly the mismatch this block exists to avoid.
  const _walletHtml = (broker, inv) =>
    `<span class="brk-wallet" title="Investment pool: ${_inr0(inv)} + paper P&L over the selected range">`
    + `<span class="brk-wallet-remain" id="wallet-remain-${broker}">${_inr0(inv)}</span>`
    + `<span class="brk-wallet-sub">of ${_inr0(inv)} · <span class="zero" id="wallet-pnl-${broker}">…</span></span>`
    + `</span>`;
  const fyersWalletHtml   = _walletHtml('fyers', fyersInv);
  const zerodhaWalletHtml = _walletHtml('zerodha', zerodhaInv);

  // ── Cumulative P&L placement ─────────────────────────────────────────────
  // Always a full-width band below the strategy grid. It used to tuck into the
  // last row's spare columns when the enabled-card count left a clean gap, but
  // there is no gap to tuck into any more: .mm-grid balances its rows and grows
  // the last row's cards to fill it, so the strategy grid never ends short.
  const cumCardInner = `
    <div class="dash-chart-hdr">
      <div class="dash-chart-title">
        <span class="dash-chart-dot" id="dashCumDot" style="background:#3b82f6;"></span>
        <span>All strategies · cumulative P&amp;L</span>
      </div>
      <div class="dash-chart-stats" id="dash-cum-stats">—</div>
      <a href="/consolidation" id="dashCumLink" class="dash-chart-link">Trade history →</a>
    </div>
    <div class="dash-chart-wrap"><canvas id="dashCumChart"></canvas></div>
    <div id="dashCumEmpty" class="dash-chart-empty" style="display:none;">No paper trades yet</div>`;
  const cumCardBelow  = `<div class="dash-chart-card" id="dashCumCard" style="margin-top:4px;">${cumCardInner}</div>`;

  // ── Token expiry warning ─────────────────────────────────────────────────
  const nowIST     = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const istHour    = nowIST.getHours();
  const istMin     = nowIST.getMinutes();
  const nearExpiry = istHour === 5 && istMin >= 45;  // 5:45–5:59 AM: expiring soon
  // 6:00–8:59 AM: already expired — unless the login happened after today's 6 AM.
  const _savedAt   = zerodha.tokenSavedAt();
  const _savedIST  = _savedAt ? new Date(new Date(_savedAt).toLocaleString("en-US", { timeZone: "Asia/Kolkata" })) : null;
  const loggedInAfter6 = !!_savedIST
    && _savedIST.toDateString() === nowIST.toDateString()
    && _savedIST.getHours() >= 6;
  const pastExpiry = istHour >= 6 && istHour < 9 && !loggedInAfter6;

  // Only the two states that need acting on. A permanent "token is valid" strip
  // is noise the whole trading day and trains the eye to skip the banner —
  // which is exactly the banner that has to be noticed at 5:45 AM.
  const zerodhaExpiryHtml = zerodhaOk && pastExpiry
    ? `⚠️ <strong>Token expired at 6 AM.</strong> Please re-login with Zerodha before trading.`
    : zerodhaOk && nearExpiry
    ? `⏰ <strong>Token expires at 6 AM</strong> — Re-login now if you plan to trade after 6 AM.`
    : ``;

  // ── Option expiry warnings — ONE BANNER PER INDEX ────────────────────────
  // Two things can go wrong, and each is raised separately for each underlying:
  //
  //   (a) the index's stored override has already passed its 15:30 close, so
  //       every strategy on that index refuses entries. Staleness is decided by
  //       instrument.js — the same predicate the entry guard uses — so this
  //       banner can never claim the expiry is fine while the engine is refusing
  //       to trade it (or vice versa).
  //   (b) nothing could be resolved at all (utils/expiryHealth.js verdict
  //       "fail"), which is the case the auto-roll cannot repair on its own.
  //
  // Per index rather than one shared strip because NIFTY 50 and NIFTY BANK
  // expire on DIFFERENT calendars — NIFTY BANK has been monthly-only since NSE
  // withdrew its weeklies in Nov-2024 — so one of them is stale most weeks while
  // the other trades normally. A single banner could not say which index is
  // blocked, nor which Settings key to fix, which is the only thing the operator
  // actually needs from it.
  let optionExpiryAlertHtml = "";
  {
    const { isExpiryOverrideStale, underlyingOf } = instrumentConfig;
    let expiryHealth = null;
    try { expiryHealth = require("../utils/expiryHealth"); } catch (_) { /* no banner, never a broken page */ }

    // A stale OPTION expiry blocks nothing when the app is trading FUTURES: the
    // month contract is derived from the date, not from this override. Showing
    // "entries are blocked" there would be a false alarm about a real block.
    const _futuresMode = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
    const fmt = (d) => new Date(`${d}T00:00:00+05:30`)
      .toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    // Settings opens by SECTION, not by field, so "#SOME_KEY" would land on the
    // first section and leave the operator hunting for the box the banner just
    // told them to fill in. Ask Settings which section owns the key.
    const settingsHref = (k) => {
      try {
        const anchor = require("../routes/settings").sectionAnchorFor(k);
        return anchor ? `/settings#${anchor}` : "/settings";
      } catch (_) { return "/settings"; }
    };

    // While the post-close roll is still retrying (15:40 → 16:45 IST) the expiry
    // is being repaired, so "entries are blocked — go fix it" is noise. Say what
    // is happening instead; the red banner returns if every attempt fails.
    let rollPending = false;
    try { rollPending = Boolean(expiryHealth && expiryHealth.isRollPending()); } catch (_) {}

    const keys = expiryHealth ? expiryHealth.underlyingKeys() : ["NIFTY", "BANKNIFTY"];
    const health = (() => { try { return expiryHealth ? expiryHealth.getStates() : {}; } catch (_) { return {}; } })();

    const banners = [];
    for (const key of keys) {
      const U     = underlyingOf(key);
      const oKey  = U.env.expiryOverride;
      const value = String(process.env[oKey] || "").trim();

      if (!_futuresMode && value && isExpiryOverrideStale(value)) {
        banners.push(rollPending
          ? `<div class="opt-expiry-alert rolling">`
            + `<span class="opt-expiry-icon">🔄</span>`
            + `<div class="opt-expiry-text">`
            +   `<div class="opt-expiry-title">${U.label} option expiry expired — updating it automatically</div>`
            +   `<div class="opt-expiry-body"><strong>${fmt(value)}</strong> has ended. The next ${U.label} contract is being resolved now, with retries until 16:45 IST. Nothing to do unless this is still here after that.</div>`
            + `</div>`
            + `</div>`
          : `<div class="opt-expiry-alert">`
            + `<span class="opt-expiry-icon">🚨</span>`
            + `<div class="opt-expiry-text">`
            +   `<div class="opt-expiry-title">${U.label} option expiry session ended — ${U.label} entries are blocked</div>`
            +   `<div class="opt-expiry-body"><strong>${oKey}</strong> = ${fmt(value)}. That contract no longer exists, so every ${U.label} strategy will refuse entries until it is updated to the next expiry date.</div>`
            + `</div>`
            + `<a href="${settingsHref(oKey)}" class="opt-expiry-cta">Change Expiry →</a>`
            + `</div>`);
        continue;   // one banner per index — the stale value is the actionable fact
      }

      // ── Expiry could not be resolved at all ────────────────────────────────
      // Raised by the background expiry-health check, which runs the same
      // resolution an entry runs. It normally repairs a blank/expired expiry
      // itself; this is the case it cannot — nothing the broker quotes matched,
      // so a human has to pick the contract. Read-only: rendering never triggers
      // a broker call, so a slow API can't slow the Dashboard down.
      const st = health[key];
      if (st && st.status === "fail") {
        // `reason` can carry a broker/exception message, so it is escaped before
        // reaching the markup rather than trusted to stay plain text.
        const reason = esc(st.reason || "");
        banners.push(
          `<div class="opt-expiry-alert">`
          + `<span class="opt-expiry-icon">🚨</span>`
          + `<div class="opt-expiry-text">`
          +   `<div class="opt-expiry-title">${U.label} option expiry could not be resolved — ${U.label} entries will be skipped</div>`
          +   `<div class="opt-expiry-body">Auto-detection found no ${U.label} contract the broker will quote${reason ? ` (${reason})` : ""}. Set <strong>${oKey}</strong> for this expiry.</div>`
          + `</div>`
          + `<a href="${settingsHref(oKey)}" class="opt-expiry-cta">Set Expiry →</a>`
          + `</div>`
        );
      }
    }
    optionExpiryAlertHtml = banners.join("");
  }

  // ── Manual-trades sync failures (expired login etc.) — stays until that
  // broker's next good sync. The reason is a broker message, so it is escaped.
  const manualSyncAlertHtml = manualTradesSyncJob.getSyncErrors().map((e) => {
    const reason = String(e.message).replace(/\.+$/, "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const failedAt = new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    return `<div class="opt-expiry-alert">`
      + `<span class="opt-expiry-icon">🚨</span>`
      + `<div class="opt-expiry-text">`
      +   `<div class="opt-expiry-title">${e.broker} trade sync failed (${failedAt})</div>`
      +   `<div class="opt-expiry-body">${reason}. Log in again, then press Sync Now. Brokers only give today's trades, so a missed day can only be added by uploading the tradebook.</div>`
      + `</div>`
      + `<a href="/pnl-history" class="opt-expiry-cta">Open P&amp;L History →</a>`
      + `</div>`;
  }).join("");

  // ── Dashboard quick-edit values, one row per index (same keys the Settings
  // page owns — this is a second editor, not a second source). Each date is
  // pattern-checked before it reaches a value="" attribute, and the type is
  // narrowed to the two options the select offers.
  const dashExpiryRows = (() => {
    let keys;
    try { keys = require("../utils/expiryHealth").underlyingKeys(); }
    catch (_) { keys = ["NIFTY", "BANKNIFTY"]; }
    return keys.map((key) => {
      const U   = instrumentConfig.underlyingOf(key);
      const raw = String(process.env[U.env.expiryOverride] || "").trim();
      const typ = String(process.env[U.env.expiryType] || "").trim().toLowerCase();
      return {
        key,
        label:       U.label,
        overrideKey: U.env.expiryOverride,
        typeKey:     U.env.expiryType,
        // Only this index's own weekly flag decides whether "weekly" is even
        // offerable — NIFTY BANK has no weekly contract to name, so its select
        // must not be able to write one.
        weekly:      U.weekly,
        date:        /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "",
        type:        typ === "monthly" ? "monthly" : typ === "weekly" ? "weekly" : (U.weekly ? "weekly" : "monthly"),
      };
    });
  })();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <link rel="icon" type="image/png" href="data:image/png;base64,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"/>
  <title>ௐ Palani Andawar Thunai ॐ — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; min-height:100vh; overflow-x:hidden; }
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

    ${sidebarCSS()}
    ${dashboardUI.dashCSS()}

    /* ── PAGE WRAPPER ── */
    .page { padding:14px max(20px, env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); display:flex; flex-direction:column; gap:8px; }
    .page > .dh-hero, .page > .dh-filter { margin-bottom:0; }
    .page > .dh-h { margin:10px 0 0; }

    /* ── BROKER CONNECTIONS — compact single-line rows ── */
    /* 2×2 on wide screens: Fyers | Zerodha on the first row, then one
       option-expiry strip per index (NIFTY 50 | NIFTY BANK) on the second. The
       expiry strips used to share the broker row as a third narrow track; with
       one strip per index a symmetric 2-column grid gives each of them the same
       width as a broker row and still costs only one extra line. */
    .brokers { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px; margin-bottom:0; }
    .brokers > .brk-expiry { grid-column:1 / -1; }
    /* All expiry quick-edits share one full-width line; they wrap only when a
       card would drop under ~360px. */
    .brk-cfg-strip { grid-column:1 / -1; display:grid; grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); gap:8px; }
    @media (max-width:640px) { .brk-cfg-strip { grid-template-columns:1fr; } }
    /* flex-wrap:wrap (not nowrap) so the login button drops to its own line
       when the column is narrow instead of overflowing the clipped body and
       becoming invisible (13" MacBook / un-maximized window / zoomed view). */
    .brk-row {
      display:flex; align-items:center; gap:6px 10px; flex-wrap:wrap;
      padding:5px 12px; border-radius:9px;
      border:1px solid #1a2236; background:#0d1320;
      min-width:0;
    }
    .brk-name { font-size:0.82rem !important; }
    .brk-wallet { margin-left:auto; display:flex; flex-direction:column; align-items:flex-end; line-height:1.1; flex:0 0 auto; }
    .brk-wallet-remain { font-size:0.92rem; font-weight:800; color:#e0eaf8; font-variant-numeric:tabular-nums; }
    .brk-wallet-sub { font-size:0.58rem; color:var(--muted-1,#8ba1c2); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .brk-wallet-sub .pos { color:#34d399; }
    .brk-wallet-sub .neg { color:#f87171; }
    .brk-wallet-sub .zero { color:#7d8aa3; }
    /* Stack the two broker rows on laptop/small-desktop widths so each gets the
       full content width and the login button always fits (was 720px — too low,
       it skipped the 13" MacBook band). */
    /* 1700, not 1500: a broker row needs ~470px to keep its login button on the
       same line, and three tracks only clear that above ~1650px viewport
       (1700 - 200px sidebar - 40px page padding = 1460 content, /2.95fr ≈ 489
       per broker). At the old 1500 threshold a 1550px window gave each broker
       439px and the Zerodha login button dropped to a second line. */
    @media (max-width:1200px) { .brokers { grid-template-columns:1fr; } }
    .brk-row.ok   { border-color:#0d3a1e; background:#04100a; }
    .brk-row.ok.blue { border-color:#0d2545; background:#030b18; }
    .brk-row.bad  { border-color:#3a0f1c; background:#100408; }
    .brk-row.muted { border-color:#1e1e36; background:#0a0a12; }
    .brk-dot {
      width:8px; height:8px; border-radius:50%;
      background:#4a5878; flex-shrink:0;
    }
    .brk-row.ok .brk-dot  { background:#10b981; }
    .brk-row.ok.blue .brk-dot { background:#3b82f6; }
    .brk-row.bad .brk-dot { background:#ef4444; }
    .brk-dot.pulse { animation:pulse 1.5s infinite; }
    .brk-name { font-size:0.92rem; font-weight:700; color:#e0eaf8; letter-spacing:-0.2px; }
    .brk-status {
      font-size:0.58rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;
      padding:3px 9px; border-radius:20px; border:1px solid;
      background:#0e0e1e; border-color:#2a2a48; color:var(--muted-1,#8ba1c2);
      /* As a plain flex item this defaulted to flex-shrink:1, so on a narrow
         row the pill box was squeezed while DISCONNECTED — one unbreakable
         word — kept its width and spilled out underneath the login button.
         Refusing to shrink makes the row wrap the button instead. */
      flex-shrink:0; white-space:nowrap;
    }
    .brk-row.ok .brk-status  { background:#071e0f; border-color:#0e4020; color:#34d399; }
    .brk-row.ok.blue .brk-status { background:#07112e; border-color:#0e2860; color:#60a5fa; }
    .brk-row.bad .brk-status { background:#1c0610; border-color:#500e20; color:#f87171; }
    .brk-action {
      font-size:0.74rem; font-weight:600; text-decoration:none;
      padding:6px 12px; border-radius:6px; white-space:nowrap;
      transition:filter 0.15s;
    }
    .brk-action.re-login { color:var(--muted-1,#8ba1c2); }
    .brk-action.re-login:hover { color:#60a5fa; }
    .brk-action.login { color:#fff; border:1px solid; }
    .brk-action.login.fyers   { background:#0d3a18; border-color:#1a6030; }
    .brk-action.login.zerodha { background:#1a4a8a; border-color:#2a6aaa; }
    .brk-action.login:hover { filter:brightness(1.15); }
    .brk-action.muted-hint {
      font-size:0.66rem; color:var(--muted-1,#8ba1c2); font-style:italic;
      border:1px dashed #252550; padding:4px 10px; border-radius:6px;
    }
    .brk-expiry {
      font-size:0.7rem; line-height:1.4;
      padding:7px 12px; border-radius:7px; border:1px solid;
    }
    .brk-expiry.expired  { background:#2d1600; border-color:#c05621; color:#f6ad55; }
    .brk-expiry.expiring { background:#2a1600; border-color:#744210; color:#fbd38d; }

    /* ── Option expiry quick-edit (mirrors Settings → OPTION_EXPIRY_OVERRIDE /
       OPTION_EXPIRY_TYPE; saves through the same POST /settings/save) ── */
    .brk-cfg {
      display:flex; align-items:center; gap:6px 8px; flex-wrap:wrap;
      padding:5px 12px; border-radius:9px;
      border:1px solid #1a2236; background:#0d1320;
      min-width:0;
    }
    .brk-cfg-label {
      font-size:0.58rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;
      color:var(--muted-1,#8ba1c2); flex:0 0 auto; white-space:nowrap;
    }
    /* max-width keeps the inputs from stretching across the whole strip when it
       spans the full grid width on laptop/tablet. */
    .brk-cfg-field { flex:0 1 auto; min-width:0; max-width:190px; }
    /* Soak up the leftover row width here so the Save button sits next to the
       fields instead of being flung to the far right edge of the strip. */
    .brk-cfg-spacer { flex:1 1 0; min-width:0; }
    .brk-cfg-input {
      width:100%; min-width:0; color-scheme:dark;
      background:#0a0f18; border:1px solid #243049; color:#c8d8f0;
      border-radius:6px; padding:4px 7px;
      font-size:0.7rem; font-family:inherit;
    }
    .brk-cfg-input:focus { outline:none; border-color:#3b82f6; }
    .brk-cfg-save {
      flex:0 0 auto; margin-left:auto; cursor:pointer; font-family:inherit;
      padding:5px 12px; border-radius:6px; white-space:nowrap;
      background:#0f2540; border:1px solid #1e4a7a; color:#93c5fd;
      font-size:0.7rem; font-weight:700;
      transition:filter 0.15s, transform 0.08s;
    }
    .brk-cfg-save:hover:not(:disabled) { filter:brightness(1.25); }
    .brk-cfg-save:active:not(:disabled) { transform:translateY(1px); }
    .brk-cfg-save:disabled { opacity:0.55; cursor:not-allowed; }
    /* Shown only when a per-mode expiry key shadows the common one — takes the
       whole line so it cannot be mistaken for part of the field row. */
    .brk-cfg-warn {
      flex:1 0 100%; text-decoration:none;
      font-size:0.6rem; font-weight:600; line-height:1.3;
      color:#fbbf24;
    }
    .brk-cfg-warn:hover { text-decoration:underline; }
    /* Touch sizing. At the desktop scale these controls come out 26px tall with
       an 11.2px font, which is both under the 44px tap target and — because iOS
       Safari zooms the whole page when you focus an input whose font-size is
       below 16px — makes tapping the date field yank the layout about. 16px is
       the exact threshold, so it is set literally rather than in rem. */
    @media (max-width:768px) {
      .brk-cfg-input { font-size:16px; padding:9px 10px; min-height:44px; }
      .brk-cfg-save  { font-size:0.85rem; padding:12px 16px; min-height:44px; }
      /* It is a link to Settings, so give it a real tap target too rather than
         a 21px-tall line of text. */
      .brk-cfg-warn  { font-size:0.72rem; line-height:1.5; display:flex; align-items:center; min-height:44px; }
      .brk-cfg-label { font-size:0.62rem; }
      .brk-cfg       { gap:8px; padding:8px 12px; }
      /* Between 641 and 768px the two fields still sit side by side, and the
         190px cap is exactly what let the iOS date control — which will not
         shrink below its intrinsic width — spill out over the select. Cap
         removed, and the basis raised to 260px: that is wider than any
         plausible intrinsic width, so when the strip cannot give both fields
         260px they wrap onto separate full-width lines by themselves instead
         of being squeezed into an overlap. No extra breakpoint needed. */
      .brk-cfg-field { max-width:none; flex:1 1 260px; }
      /* Fields grow again below 768px, so there is no leftover width to soak
         up and the spacer would only force a needless wrap. */
      .brk-cfg-spacer { display:none; }
    }
    @media (max-width:640px) {
      .brk-cfg-label { flex:1 0 100%; }
      /* One control per row. Side by side these collided on a real iPhone:
         iOS gives input[type=date] an intrinsic minimum width from its rendered
         text ("Jul 28, 2026") and will not shrink below it however the flex item
         is sized, so the date box grew straight into the type select. Headless
         Chrome renders a narrower date control and never showed it. Stacking
         removes the whole class of problem and gives full-width tap targets. */
      .brk-cfg-field { flex:1 0 100%; max-width:none; min-width:0; }
      .brk-cfg-save  { flex:1 0 100%; }
    }
    :root[data-theme="light"] .brk-cfg-warn { color:#b45309; }
    :root[data-theme="light"] .brk-cfg { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .brk-cfg-label { color:#5c6b7f; }
    :root[data-theme="light"] .brk-cfg-input { color-scheme:light; background:#ffffff; border-color:#e2e8f0; color:#1e293b; }
    :root[data-theme="light"] .brk-cfg-save { background:#dbeafe; border-color:#93c5fd; color:#1d4ed8; }

    /* ── Option expiry override RED alert (full-width, prominent) ── */
    .opt-expiry-alert {
      display:flex; align-items:center; gap:14px;
      padding:12px 16px; border-radius:10px;
      background:linear-gradient(90deg,#2a0508 0%,#1c0610 100%);
      border:1px solid #ef4444; color:#fecaca;
      box-shadow:0 0 0 1px rgba(239,68,68,0.15), 0 4px 14px rgba(239,68,68,0.18);
      animation:pulse-red 2s ease-in-out infinite;
      margin-bottom:0;
    }
    @keyframes pulse-red { 0%,100%{box-shadow:0 0 0 1px rgba(239,68,68,0.15), 0 4px 14px rgba(239,68,68,0.18);} 50%{box-shadow:0 0 0 1px rgba(239,68,68,0.35), 0 6px 22px rgba(239,68,68,0.32);} }
    /* Roll in progress — the same strip in amber, without the alarm: the expiry
       is expired but being repaired, so it reports rather than demands. */
    .opt-expiry-alert.rolling {
      background:linear-gradient(90deg,#2a1a05 0%,#1c1206 100%);
      border-color:#f59e0b; color:#fde68a;
      box-shadow:0 0 0 1px rgba(245,158,11,0.15), 0 4px 14px rgba(245,158,11,0.18);
      animation:none;
    }
    .opt-expiry-alert.rolling .opt-expiry-title { color:#fcd34d; }
    .opt-expiry-alert.rolling .opt-expiry-body  { color:#fde68a; }
    .opt-expiry-icon { font-size:1.4rem; flex-shrink:0; }
    .opt-expiry-text { flex:1; min-width:0; }
    .opt-expiry-title { font-size:0.78rem; font-weight:700; color:#fca5a5; letter-spacing:0.3px; margin-bottom:2px; }
    .opt-expiry-body  { font-size:0.72rem; color:#fecaca; line-height:1.5; }
    .opt-expiry-body strong { color:#fff; }
    .opt-expiry-cta {
      display:inline-flex; align-items:center; gap:4px; flex-shrink:0;
      padding:7px 14px; border-radius:7px;
      background:#dc2626; color:#fff; text-decoration:none;
      font-size:0.75rem; font-weight:700; letter-spacing:0.2px;
      border:1px solid #f87171; transition:filter 0.15s, transform 0.08s;
    }
    .opt-expiry-cta:hover { filter:brightness(1.12); }
    .opt-expiry-cta:active { transform:translateY(1px); }
    @media (max-width:640px) {
      .opt-expiry-alert { flex-direction:column; align-items:flex-start; }
      /* Already full-width here, but it measured 31px tall on a 393px phone —
         under the 44px tap target, and it is the primary action of a blocking
         alert, so it is the one control on this page you least want to fumble. */
      .opt-expiry-cta { width:100%; justify-content:center; min-height:44px; }
    }

    /* Compact utility strip (Start All) */
    .util-strip {
      display:flex; flex-wrap:wrap; align-items:center; gap:6px;
      padding:6px 10px; border-radius:9px;
      border:1px solid #1a2236; background:#0a0f18;
      margin-bottom:0;
    }
    .util-btn {
      display:inline-flex; align-items:center; gap:6px;
      padding:5px 11px; border-radius:6px; cursor:pointer;
      background:#0f1520; border:1px solid #243049; color:#a0b0c8;
      font-size:0.7rem; font-weight:600; font-family:inherit; letter-spacing:0.2px;
      transition:filter 0.15s, transform 0.08s;
    }
    .util-btn:hover:not(:disabled) { filter:brightness(1.2); }
    .util-btn:active:not(:disabled) { transform:translateY(1px); }
    .util-btn:disabled { opacity:0.55; cursor:not-allowed; }
    .util-btn.run-paper { background:#062016; border-color:#166534; color:#4ade80; font-weight:700; }
    /* Active running state — pulsing glow so the user can see the mode is running */
    .util-btn.is-active-paper {
      background:#052e1d !important; border-color:#22c55e !important; color:#86efac !important;
      opacity:1 !important; cursor:default !important;
      animation: pulse-paper 1.8s ease-in-out infinite;
    }
    .util-btn.is-locked { opacity:0.35 !important; cursor:not-allowed !important; filter:grayscale(0.5); }
    @keyframes pulse-paper {
      0%,100% { box-shadow:0 0 0 0 rgba(34,197,94,0.55); }
      50%     { box-shadow:0 0 0 6px rgba(34,197,94,0); }
    }
    :root[data-theme="light"] .util-btn.is-active-paper { background:#dcfce7 !important; border-color:#166534 !important; color:#15803d !important; }
    .util-info { font-size:0.68rem; color:var(--muted-1,#8ba1c2); margin-left:auto; font-family:'IBM Plex Mono',monospace; }

    /* Mobile */
    @media (max-width:640px) {
      .util-strip { flex-direction:column; align-items:stretch; }
      .util-btn { justify-content:center; width:100%; }
      .util-info { margin:4px 0 0; text-align:center; }
      /* Broker rows: status line first, then the login button on its own
         full-width line. Both brokers then look the same (previously Fyers
         squeezed its button onto line 1 and Zerodha pushed a half-width one
         onto line 2), and the button becomes a proper 44px tap target. */
      .brk-row { row-gap:8px; }
      .brk-action.login {
        flex:1 0 100%; display:flex; align-items:center; justify-content:center;
        min-height:44px; font-size:0.8rem;
      }
      .brk-action.re-login { flex:0 0 auto; margin-left:auto; }
    }

    /* Light theme */
    :root[data-theme="light"] .brk-row { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .brk-row.ok   { background:#f0fdf4; border-color:#bbf7d0; }
    :root[data-theme="light"] .brk-row.ok.blue { background:#eff6ff; border-color:#bfdbfe; }
    :root[data-theme="light"] .brk-row.bad  { background:#fef2f2; border-color:#fecaca; }
    :root[data-theme="light"] .brk-row.muted { background:#f8fafc; border-color:#e2e8f0; }
    :root[data-theme="light"] .brk-name { color:#1e293b; }
    :root[data-theme="light"] .brk-wallet-remain { color:#1e293b; }
    :root[data-theme="light"] .brk-wallet-sub { color:#5c6b7f; }
    :root[data-theme="light"] .brk-status { background:#f1f5f9; border-color:#e2e8f0; color:#5c6b7f; }
    :root[data-theme="light"] .brk-row.ok .brk-status { background:#dcfce7; border-color:#86efac; color:#166534; }
    :root[data-theme="light"] .brk-row.ok.blue .brk-status { background:#dbeafe; border-color:#93c5fd; color:#1d4ed8; }
    :root[data-theme="light"] .brk-row.bad .brk-status { background:#fee2e2; border-color:#fca5a5; color:#b91c1c; }
    :root[data-theme="light"] .util-strip { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .util-btn { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    :root[data-theme="light"] .util-btn.run-paper { background:#dcfce7; border-color:#86efac; color:#166534; }
    :root[data-theme="light"] .util-info { color:#4b5769; }
    /* Light theme — top-bar pills/buttons + broker expiry pill (shared chrome lacks light variants) */
    :root[data-theme="light"] .top-bar-btn { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    :root[data-theme="light"] .top-bar-btn.run-paper { background:#dcfce7; border-color:#86efac; color:#166534; }
    /* Pills that open a popup — the rest of the pills are read-only labels.
       Brightening is invisible on the light theme's near-white pill, so that
       one darkens instead. */
    .top-bar-cache.clickable { cursor:pointer; }
    .top-bar-cache.clickable:hover { filter:brightness(1.25); }
    :root[data-theme="light"] .top-bar-cache.clickable:hover { filter:brightness(0.94); }
    :root[data-theme="light"] .top-bar-cache { background:#f0fdf4; border-color:#bbf7d0; color:#166534; }
    :root[data-theme="light"] .top-bar-cache.empty { background:#f8fafc; border-color:#e2e8f0; color:#4b5769; }
    :root[data-theme="light"] .top-bar-cache.schedule { background:#ecfeff; border-color:#a5f3fc; color:#0e7490; }
    :root[data-theme="light"] .top-bar-cache.schedule.empty { background:#f8fafc; border-color:#e2e8f0; color:#4b5769; }
    :root[data-theme="light"] .top-bar-badge { background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; }
    :root[data-theme="light"] .top-bar-badge.live-active { background:#fef2f2; border-color:#fca5a5; color:#b91c1c; }
    :root[data-theme="light"] .top-bar-badge.paper-active { background:#f0fdf4; border-color:#bbf7d0; color:#166534; }
    :root[data-theme="light"] .brk-expiry.expiring { background:#fffbeb; border-color:#fde68a; color:#b45309; }
    :root[data-theme="light"] .brk-expiry.expired { background:#fef2f2; border-color:#fecaca; color:#c2410c; }

    /* ── PER-MODULE START CARDS ── */
    /* ── PER-MODULE P&L CHART CARDS ── */
    /* Rows are balanced over the number of VISIBLE cards and the last row is
       never short of full width. Two pieces make that work:
       - --mm-cols is computed in JS (_layoutModuleGrid) as the count spread
         evenly over ceil(count / 4) rows, so 5 cards go 3+2 rather than 4+1 and
         7 go 4+3. Cards are hidden per strategy at runtime, so the count cannot
         be baked in server-side.
       - flex, not grid: grid keeps a short LAST row at the full column width and
         leaves a hole on the right. Flex items grow into whatever the row has
         left, so the trailing 2 or 3 cards widen and the row is flush.
       250px is what a card needs to keep its stats line — "27 trades · 8W/19L ·
       +₹4,910.40" — on one line, so the basis is a max() against that floor:
       once a column would be narrower (phones, narrow splits), the floor wins
       and the cards wrap on their own regardless of --mm-cols. */
    .mm-grid { display:flex; flex-wrap:wrap; gap:10px; --mm-cols:4; }
    /* The 0.5px shaved off the basis is anti-wrap slack: an exact fit
       (cols * basis + gaps == 100%) can round up a fraction of a pixel on a
       fractional container width and bump the last card to its own row. Flex
       grow reclaims the slack immediately, so the cards still fill the row. */
    .mm-grid > .mm-card { flex:1 1 max(250px, calc((100% - (var(--mm-cols) - 1) * 10px) / var(--mm-cols) - 0.5px)); }
    /* Grid and flex items both default to min-width:auto, which can force an
       item wider than its share and overflow the (clipped) page. Let them
       shrink so the grids always reflow to the available width. */
    .mm-grid > * { min-width:0; }
    .mm-mkt[hidden] { display:none; }
    .mm-mkt .dh-mhead { margin-top:6px; }
    .mm-card { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:8px 10px 9px; display:flex; flex-direction:column; }
    .mm-hdr { display:flex; align-items:center; gap:8px; padding-bottom:6px; border-bottom:1px solid #1a2236; margin-bottom:6px; }
    .mm-dot { width:7px; height:7px; border-radius:50%; background:var(--acc,#4a6080); flex-shrink:0; }
    .mm-title { font-size:0.62rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    /* Global date-range filter (top-bar) — narrows every chart on the dashboard.
       Same option set as Edge Analytics so the two pages agree on what a range
       means; wraps rather than widening the bar when Custom opens its inputs. */
    .dash-range { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; flex-shrink:0; }
    .dash-range label { font-size:0.58rem; text-transform:uppercase; letter-spacing:1px; color:var(--muted-2,#6d85a8); font-family:'IBM Plex Mono',monospace; }
    .dash-range select, .dash-range input { background:#07111f; border:1px solid #1a2236; color:#e0eaf8; padding:5px 8px; border-radius:4px; font-family:'IBM Plex Mono',monospace; font-size:0.7rem; outline:none; max-width:100%; }
    .dash-range select:focus, .dash-range input:focus { border-color:#38bdf8; }
    .dash-range .drg-custom { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; }
    :root[data-theme="light"] .dash-range label { color:#4b5769; }
    :root[data-theme="light"] .dash-range select, :root[data-theme="light"] .dash-range input { background:#f8fafc; border-color:#e0e4ea; color:#334155; }
    .mm-stats { font-size:0.66rem; font-family:'IBM Plex Mono',monospace; color:var(--muted-1,#8ba1c2); margin-bottom:4px; }
    .mm-stats .pnl-pos { color:#10b981; font-weight:700; }
    .mm-stats .pnl-neg { color:#ef4444; font-weight:700; }
    .mm-stats .pnl-flat { color:var(--muted-1,#8ba1c2); font-weight:700; }
    .mm-wrap { position:relative; height:100px; }
    /* The lopsided top padding used to push this line past the empty chart box;
       that box now collapses when there is nothing to draw, so the padding is
       even again. */
    .mm-empty { text-align:center; padding:20px 14px; color:var(--muted-1,#8ba1c2); font-size:0.72rem; }
    :root[data-theme="light"] .mm-card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .mm-hdr { border-bottom-color:#e0e4ea; }
    :root[data-theme="light"] .mm-title { color:#475569; }
    :root[data-theme="light"] .mm-stats { color:#5c6b7f; }
    :root[data-theme="light"] .mm-empty { color:#5c6b7f; }


    /* ── DASHBOARD LIGHT THEME ── */
    :root[data-theme="light"] body { background:#f4f6f9; color:#334155; }

    /* The broker-strip login buttons. Their fills are class
       rules, so the light skin's hex rewriter reaches the Fyers green but has
       no entry for the Zerodha navy — it stayed dark while themeJS's
       .brk-action rule pulled the label to #1d4ed8, leaving dark-on-dark.
       Painting both as solid brand buttons needs
       !important + this specificity to outrank that .brk-action rule. */
    :root[data-theme="light"] .brk-action.login.fyers   { background:#166534 !important; border-color:#14532d !important; color:#ffffff !important; }
    :root[data-theme="light"] .brk-action.login.zerodha { background:#2563eb !important; border-color:#1d4ed8 !important; color:#ffffff !important; }

    /* ── CUMULATIVE P&L CHART CARDS (Paper) ── */
    .dash-chart-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .dash-chart-card { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:10px 12px 12px; }
    .dash-chart-hdr { display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap; padding-bottom:6px; border-bottom:1px solid #1a2236; }
    .dash-chart-title { display:flex; align-items:center; gap:8px; font-size:0.66rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    .dash-chart-dot { width:7px; height:7px; border-radius:50%; display:inline-block; }
    .dash-chart-stats { font-size:0.66rem; font-family:'IBM Plex Mono',monospace; color:var(--muted-1,#8ba1c2); }
    .dash-chart-stats .pnl-pos { color:#10b981; font-weight:700; }
    .dash-chart-stats .pnl-neg { color:#ef4444; font-weight:700; }
    .dash-chart-stats .pnl-flat { color:var(--muted-1,#8ba1c2); font-weight:700; }
    .dash-chart-link { font-size:0.66rem; color:#60a5fa; text-decoration:none; font-weight:600; padding:3px 9px; border-radius:5px; border:1px solid #1a3a6a; background:#080e1a; transition:filter 0.15s; margin-left:auto; }
    .dash-chart-link:hover { filter:brightness(1.25); }
    .dash-chart-wrap { position:relative; height:clamp(140px, 26vh, 360px); }
    .dash-chart-empty { text-align:center; padding:28px 20px; color:var(--muted-1,#8ba1c2); font-size:0.72rem; }
    @media (max-width:900px) { .dash-chart-grid { grid-template-columns:1fr; } }
    :root[data-theme="light"] .dash-chart-card { background:#ffffff; border-color:#e0e4ea; }
    :root[data-theme="light"] .dash-chart-title { color:#475569; }
    :root[data-theme="light"] .dash-chart-stats { color:#5c6b7f; }
    :root[data-theme="light"] .dash-chart-link { background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; }
    :root[data-theme="light"] .dash-chart-empty { color:#5c6b7f; }

    /* ── Dashboard Analytics Panel (market-hour aware) ── */
    .dash-analytics { background:#0d1320; border:1px solid #1a2236; border-radius:9px; padding:10px 12px 12px; }
    .da-header { display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap; padding-bottom:6px; border-bottom:1px solid #1a2236; }
    .da-title { display:flex; align-items:center; gap:8px; font-size:0.66rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#a0b0c8; }
    .da-badge { font-size:0.58rem; font-weight:700; padding:2px 8px; border-radius:4px; letter-spacing:0.6px; background:rgba(74,96,128,0.12); color:#a0b0c8; border:1px solid rgba(74,96,128,0.30); }
    .da-badge.live { background:rgba(16,185,129,0.10); color:#10b981; border-color:rgba(16,185,129,0.30); }
    .da-badge.post { background:rgba(59,130,246,0.10); color:#60a5fa; border-color:rgba(59,130,246,0.30); }
    .da-sub { font-size:0.66rem; color:var(--muted-1,#8ba1c2); font-family:'IBM Plex Mono',monospace; margin-left:auto; }
    .da-body { display:flex; flex-direction:column; gap:10px; }
    .da-loading { padding:18px; text-align:center; color:var(--muted-1,#8ba1c2); font-size:0.72rem; }
    .da-day { font-size:0.7rem; font-weight:600; color:var(--dh-muted); }
    .da-empty { padding:14px 12px; text-align:center; color:var(--muted-1,#8ba1c2); font-size:0.72rem; }
    :root[data-theme="light"] .dash-analytics { background:#fff; border-color:#e0e4ea; }
    :root[data-theme="light"] .da-title { color:#475569; }
    :root[data-theme="light"] .da-sub { color:#5c6b7f; }

    /* ── MOBILE ── */
    @media (max-width:640px) {
      .main-content { margin-left:0; }
      .page { padding:12px max(16px, env(safe-area-inset-right)) calc(40px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); gap:10px; }
      /* top-bar: hide meta on mobile */
      .top-bar-meta { display:none; }
      .top-bar { padding:7px 10px 7px 48px; }
    }
    /* Dashboard top bar — DESKTOP ONLY (below 768px the shared phone rules own
       it, and pinning the bar there once put Start All, the expiry/holiday
       pills and the status badge off screen behind .main-content's
       overflow-x:clip).
       This used to force the whole bar onto one line (flex-wrap:nowrap +
       flex-shrink:0 on the right-hand group) and hand the leftovers to
       overflow-x:auto. The bar's natural width is ~1350px, so anything under a
       ~1600px viewport parked the expiry/holiday pills and the status badge
       inside a scroller — and with no visible scrollbar on a trackpad that
       reads as "the badges are gone", which is what a 13"/14" MacBook saw.
       Wrapping is the honest version: the bar still renders as one line
       whenever one line fits (nothing changes on a 1920px screen), and drops
       the right-hand group onto a second line only when it genuinely cannot,
       instead of hiding it. row-gap keeps the two lines from touching. */
    @media (min-width:769px) {
      .top-bar { flex-wrap:wrap; row-gap:6px; }
      .top-bar > div:first-child { flex-shrink:0; }
      .top-bar-meta { white-space:nowrap; }
    }
    /* Phone: let every top-bar group wrap onto its own line and fill the width.
       min-width:0 is what actually lets the group shrink — a flex item's
       automatic minimum size would otherwise hold it at its content width even
       with wrapping enabled. */
    @media (max-width:768px) {
      .top-bar { flex-wrap:wrap; overflow-x:clip; row-gap:6px; }
      .top-bar > div:first-child { flex:1 1 auto; min-width:0; }
      .top-bar-right {
        flex:1 1 100%; min-width:0; flex-wrap:wrap;
        justify-content:flex-start; gap:6px;
      }
      .top-bar-right .top-bar-btn { flex:1 1 auto; justify-content:center; }
      .dash-range { flex:0 0 auto; }
      /* The expiry/holiday pills carry a full sentence and are white-space:nowrap
         in sharedNav, so at 320px (iPhone SE) they alone still ran 11px past the
         edge. Let them wrap rather than widen the bar. */
      .top-bar-right .top-bar-cache { max-width:100%; min-width:0; white-space:normal; }
      /* Same problem, different pill: the trading-status pill ("Weekend —
         markets resume Monday 9:15 AM") is built in JS and its inner box carries
         an INLINE white-space:nowrap, so at 320px it ran 45px past the edge and
         took its dismiss ✕ behind .main-content's overflow-x:clip with it — the
         one control that closes the pill, unreachable. The inline style is why
         this needs !important. */
      #trading-status-alert { max-width:100%; min-width:0; }
      #trading-status-alert > div { max-width:100%; white-space:normal !important; }
    }
    ${modalCSS()}
    ${expiryHolidayModalCSS()}
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('dashboard', false)}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">⌂ Dashboard</div>
    </div>
    <div class="dash-range" id="dashRange" title="Date range for all charts">
      <label for="dashRangeSel">Chart range</label>
      <select id="dashRangeSel">${dateRangeOptionsHTML('td')}</select>
      <span class="drg-custom" id="dashRangeCustom" style="display:none;">
        <input type="date" id="dashRangeFrom" title="From date (inclusive)"/>
        <input type="date" id="dashRangeTo" title="To date (inclusive)"/>
      </span>
    </div>
    <div class="top-bar-right">
      ${anyModeActive ? '' : `
      <button id="btn-all-start" class="top-bar-btn run-paper" onclick="startAll(this)" title="Start all paper modes">▶ Start All (Paper)</button>`}
      <!-- The manual "Reset Token" button was removed: token clearing is now
           automatic (4:00 PM + 7:00 AM IST schedulers, and the login routes
           wipe any DISCONNECTED broker's saved token before starting OAuth).
           POST /admin/reset still exists for the rare stuck-socket case. -->
      <!-- Expiry / holiday pills stay outside the idle-only block: which expiry is
           next matters most while a session is running. Click opens the shared
           Expiry & NSE Holidays calendar (same popup as Settings).
           One pill per index: NIFTY 50 expires every Tuesday, NIFTY BANK only
           monthly (NSE withdrew BANKNIFTY weeklies in Nov-2024), so a single
           pill would be showing the wrong date for one of them most weeks. -->
      <span id="expiry-info-pill" class="top-bar-cache schedule empty clickable" title="Next NIFTY 50 expiry (weekly/monthly) and next NIFTY BANK expiry — BANKNIFTY is monthly only, since NSE withdrew its weekly options in Nov-2024. Click for the full expiry calendar" onclick="showExpiryHolidaysModal()"></span>
      <span id="holiday-info-pill" class="top-bar-cache schedule empty clickable" title="Next NSE trading holiday — click for the full holiday list" onclick="showExpiryHolidaysModal()"></span>
      <div id="trading-status-alert" style="display:none;position:relative;"></div>
      ${orbModeOn && orbMode === 'ORB_PAPER' ? '<span class="top-bar-badge live-active" style="border-color:#10b981;"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>ORB PAPER</span>' : ''}
      ${anyModeActive && !specificBadgeShown ? '<span class="top-bar-badge live-active" style="border-color:#22c55e;"><span style="width:5px;height:5px;border-radius:50%;background:#22c55e;display:inline-block;"></span>TRADE ACTIVE</span>' : ''}
    </div>
  </div>

<div class="page">

  <!-- Alerts that need acting on — stale option expiry, failed trade sync. -->
  ${optionExpiryAlertHtml}
  ${manualSyncAlertHtml}

  <!-- ① TODAY'S P&L — big total, one chip per market (tap = filter to it). -->
  ${dashboardUI.heroHTML(_dashMarkets, { sub: 'Loading…' })}
  ${dashboardUI.filterHTML(_dashMarkets)}

  ${analyticsPanelOn ? `
  <!-- ② TODAY SO FAR (market open) / LAST SESSION (closed) — every strategy,
       grouped by market with a subtotal on each market row and a grand TOTAL. -->
  <section id="dashAnalytics" class="dash-analytics">
    <div class="da-header">
      <div class="da-title"><span id="da-mode-badge" class="da-badge">—</span><span id="da-title-txt">Today</span></div>
      <div class="da-sub" id="da-sub-txt">Loading…</div>
    </div>
    <div id="da-body" class="da-body">
      <div class="da-loading">Loading…</div>
    </div>
  </section>` : ''}

  <!-- ③ QUICK LINKS -->
  ${dashboardUI.quickLinksHTML({ demo: demoMode.isDemo() })}

  <!-- ④ BROKERS & EXPIRY — compact single-line rows (hidden while a trade runs).
       The option-expiry quick-edit shares this grid row so it costs no extra
       height, and hides with the rest of the controls mid-trade: switching the
       expiry would change the contract the engine resolves for its next entry,
       which is exactly what this block is hidden to prevent. Settings remains
       reachable if it genuinely has to be changed during a session. -->
  ${anyModeActive ? '' : `
  <div class="brokers">
    <div class="brk-row ${fyersOk ? 'ok' : 'bad'}">
      <span class="brk-dot ${fyersOk ? 'pulse' : ''}"></span>
      <span class="brk-name">Fyers</span>
      ${fyersWalletHtml}
      <span class="brk-status">${fyersOk ? 'Connected' : 'Disconnected'}</span>
      ${fyersOk
        ? `<a href="/auth/login" class="brk-action re-login">re-login →</a>`
        : `<a href="/auth/login" class="brk-action login fyers">🔐 Login with Fyers</a>`}
    </div>
    <div class="brk-row ${zerodhaOk ? 'ok blue' : zerodhaConf ? 'bad' : 'muted'}">
      <span class="brk-dot ${zerodhaOk ? 'pulse' : ''}"></span>
      <span class="brk-name">Zerodha</span>
      ${zerodhaWalletHtml}
      <span class="brk-status">${zerodhaOk ? 'Connected' : zerodhaConf ? 'Disconnected' : 'Not Configured'}</span>
      ${zerodhaOk
        ? `<a href="/auth/zerodha/login" class="brk-action re-login">re-login →</a>`
        : zerodhaConf
          ? `<a href="/auth/zerodha/login" class="brk-action login zerodha">🔐 Login with Zerodha</a>`
          : `<span class="brk-action muted-hint">Set ZERODHA_API_KEY in .env</span>`}
    </div>
    <div class="brk-cfg-strip">
    ${dashExpiryRows.map((r) => `
    <div class="brk-cfg" data-underlying="${r.key}">
      <span class="brk-cfg-label" title="${r.overrideKey} / ${r.typeKey} — the same keys as Settings. One common expiry for every ${r.label} strategy. Blank = auto-detect.">⏱ ${r.label} Expiry</span>
      <span class="brk-cfg-field">
        <input type="date" id="dashExpiryDate_${r.key}" class="brk-cfg-input" value="${r.date}"
               title="${r.label} Option Expiry (manual). Blank = auto-detect."/>
      </span>
      <span class="brk-cfg-field">
        <select id="dashExpiryType_${r.key}" class="brk-cfg-input" title="${r.weekly
            ? 'Weekly = Tuesday expiry. Monthly = last Tuesday of the month, or the preponed date when NSE moves it.'
            : `${r.label} has NO weekly contract — NSE withdrew them in Nov-2024 — so monthly is the only option here. Turn on the ${r.label} Weekly Expiries Exist toggle in Settings if NSE ever relists them.`}">
          ${r.weekly ? `<option value="weekly"${r.type === 'weekly' ? ' selected' : ''}>weekly</option>` : ''}
          <option value="monthly"${r.type === 'monthly' ? ' selected' : ''}>monthly</option>
        </select>
      </span>
      <span class="brk-cfg-spacer"></span>
      <button type="button" class="brk-cfg-save" onclick="saveDashExpiry(this,'${r.key}','${r.overrideKey}','${r.typeKey}')" title="Save ${r.overrideKey} + ${r.typeKey} to .env (same as a Settings save)">Save</button>
    </div>`).join('')}
    </div>
    ${zerodhaOk && zerodhaExpiryHtml ? `<div class="brk-expiry ${pastExpiry ? 'expired' : 'expiring'}">${zerodhaExpiryHtml}</div>` : ''}
  </div>`}

  <!-- ⑤ P&L OVER TIME — the top-bar Range applies. A strategy's card shows only
       when it traded in the range (see _renderModuleChart). -->
  <div class="dh-h"><h2>P&amp;L over time</h2><span class="dh-h-note" id="dash-range-note">Paper trades · uses the Range above</span></div>
  ${cumCardBelow}
  ${_dashMarkets.map((g) => `
  <section class="mm-mkt" data-dh-market="${g.key}" id="mm-mkt-${g.key}">
    <div class="dh-mhead">${g.label}</div>
    <div class="mm-grid">${_dashRows.filter((r) => r.market === g.key).map((r) => `
      <div class="mm-card" data-mode="${r.key}" style="--acc:${r.accent}">
        <div class="mm-hdr">
          <span class="mm-dot"></span>
          <span class="mm-title">${r.label}</span>
        </div>
        <div class="mm-stats" id="mm-stats-${r.key}">—</div>
        <div class="mm-wrap"><canvas id="mmChart-${r.key}"></canvas></div>
        <div class="mm-empty" id="mm-empty-${r.key}" style="display:none;">No paper trades yet</div>
      </div>`).join('')}
    </div>
  </section>`).join('')}

</div>

${expiryHolidayModalHTML()}

<script>
${modalJS()}
${expiryHolidayModalJS()}
${dateRangeJS()}
${dashboardUI.dashClientJS()}
// Market of every enabled row (trade.mode → market group) and the market list
// the filter offers — both derived server-side from registry × pairs.
var DASH_MARKETS = ${JSON.stringify(_dashMarkets)};
var MODE_MARKET  = ${JSON.stringify(dashboardModel.modeMarketMap(_dashRows))};
var MM_KEYS      = ${JSON.stringify(_dashRows.map((r) => r.key))};
function _inMarket(t){
  var m = dhMarket();
  return m === 'ALL' || MODE_MARKET[String((t && t.mode) || '').toUpperCase()] === m;
}

// ── Quick Action: Start All Paper ───────────────────────────────────────────
// The lists below are the roster as it stood when this page was RENDERED — the
// enabled strategies joined to the start routes discovered from the mounted
// routers. Every Start-All click refetches them from /api/start-all-roster
// first (_refreshRoster), so a strategy that was added to the app or enabled in
// Settings since the page loaded is started too, without a reload and without
// this button naming any strategy. The render-time lists are the fallback for
// when that fetch fails.
var PAPER_ENDPOINTS   = ${JSON.stringify(startAllModes.filter((m) => !m.paperOff).map((m) => m.paper))};
var ALL_MODE_LABELS   = ${JSON.stringify(startAllModes.filter((m) => !m.paperOff).map((m) => m.label))};
var ENDPOINT_LABELS   = ${JSON.stringify(startAllEndpointLabels)};

// Replaces every roster-derived list in one place, so the endpoints, the button
// labels, the failure-list names and the button-state poll can never disagree
// about which strategies are in play.
function _applyRoster(modes){
  if(!Array.isArray(modes) || !modes.length) return false;
  var paper = [];
  var labels = [], names = {}, poll = [];
  modes.forEach(function(m){
    if(!m || !m.paper) return;
    if(!m.paperOff){ paper.push(m.paper); labels.push(m.label); }
    names[m.paper] = m.label + ' Paper';
    poll.push({ url: m.paper.replace('/start','/status/data'), kind: 'paper' });
  });
  if(!paper.length) return false;
  PAPER_ENDPOINTS = paper;
  ALL_MODE_LABELS = labels;
  ENDPOINT_LABELS = names;
  ALL_BTN_POLL = poll;
  return true;
}

// Called at the top of every Start-All handler. A failed fetch is not an error:
// the page keeps the roster it was rendered with rather than refusing to start.
// Bounded, because it now sits between the click and the first /start — an
// unanswered request must not leave the button hanging on ⏳ forever.
async function _refreshRoster(){
  var ctl = new AbortController();
  var tid = setTimeout(function(){ ctl.abort(); }, 5000);
  try {
    var r = await fetch('/api/start-all-roster', { cache:'no-store', signal: ctl.signal });
    if(!r.ok) return false;
    var d = await r.json();
    return _applyRoster(d && d.modes);
  } catch(e){ return false; }
  finally { clearTimeout(tid); }
}

// Opens a Start-All click: refuses a second one, then disables the button
// BEFORE the roster fetch. That fetch is a network round-trip, and a button
// left live across it can be clicked again and start the whole roster twice.
// _startAllBusy is raised here too, so pollSessionActiveSwap() cannot navigate
// away while the click is still resolving.
var _startAllClickBusy = false;
async function _beginStartAll(btn){
  if(_startAllClickBusy) return false;
  _startAllClickBusy = true;
  _startAllBusy = true;
  btn.disabled = true;
  btn.textContent = '⏳ Checking strategies...';
  await _refreshRoster();
  return true;
}

// Every path that does NOT reach _runStartAll (nothing enabled, confirm
// cancelled) — releases the guards and puts the button back.
function _abortStartAll(btn, origText){
  _startAllClickBusy = false;
  _startAllBusy = false;
  btn.disabled = false;
  btn.textContent = origText;
}

function _escHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}

// Server-supplied, so there is no second strategy list to keep in step with the
// roster. Falls back to the raw URL for anything not in the map.
function _prettyEndpoint(url){
  return ENDPOINT_LABELS[url] || url;
}

// True from the first /start until the whole roster has been attempted AND the
// result has been shown. Read by pollSessionActiveSwap(), which must not
// navigate away mid-run — see the comment there.
var _startAllBusy = false;

// One /start call → its outcome. Never throws.
async function _startOne(ep){
  try {
    var r = await secretFetch(ep);
    if (!r) return { ok:false, f:{ endpoint: ep, error: 'No response from server' } };
    var body = null;
    try { body = await r.json(); } catch(_) { /* non-JSON body */ }
    if (r.ok && (!body || body.success !== false)) return { ok:true };
    var msg = (body && (body.error || body.message)) || ('HTTP ' + r.status);
    return { ok:false, f:{ endpoint: ep, status: r.status, error: msg } };
  } catch(e){
    return { ok:false, f:{ endpoint: ep, error: (e && e.message) || 'Network error' } };
  }
}

// Starts are independent (each strategy owns its own sharedSocketState slot and
// start reservation, and the broker calls they share are de-duplicated server
// side by services/marketData.js), so they run START_ALL_CONCURRENCY at a time
// instead of one after another. 1 = the old sequential behaviour.
var START_ALL_CONCURRENCY = ${startAllConcurrency};

async function _startAll(endpoints){
  var results = { successes: [], failures: [] };
  function record(ep, out){
    if (out.ok) results.successes.push({ endpoint: ep });
    else results.failures.push(out.f);
  }
  if (!endpoints.length) return results;
  // The FIRST start runs alone: if the API secret is not yet in this session it
  // is prompted for exactly once (parallel 403s would stack N prompts), and its
  // token / holiday / spot checks warm the shared server-side answers.
  var first = await _startOne(endpoints[0]);
  record(endpoints[0], first);
  // Secret still missing (prompt cancelled / rejected) → the rest one at a time,
  // exactly as before, so each start can prompt on its own.
  var authBlocked = !first.ok && (!first.f.status || first.f.status === 403);
  var limit = authBlocked ? 1 : START_ALL_CONCURRENCY;
  var next = 1;
  async function worker(){
    while (next < endpoints.length){
      var ep = endpoints[next++];
      record(ep, await _startOne(ep));
    }
  }
  var pool = [];
  for (var w = 0; w < Math.min(limit, endpoints.length - 1); w++) pool.push(worker());
  await Promise.all(pool);
  return results;
}

// ── Post-start verification ────────────────────────────────────────────────
// HTTP 200 from /start only means the route ACCEPTED the request — it is not
// proof the engine actually came up (mutual-exclusion lock held by the other
// mode, expired broker token, socket refused, an engine that starts and then
// stops itself). So once the whole roster has been attempted we poll each
// mode's own /status/data and report its \`running\` flag — the same field the
// Start-All button state polls. Engines that need a tick or a broker
// round-trip before flipping the flag get a few retries; only the
// not-yet-running ones are re-polled, so one slow starter does not hold up the
// confirmation for the rest.
var VERIFY_ATTEMPTS = 4;
var VERIFY_GAP_MS   = 800;

// Every wired start route ends in \`/start\` and exposes \`/status/data\` on the
// same router — the same derivation the server uses to build ALL_BTN_POLL.
function _statusUrlFor(startEndpoint){
  return startEndpoint.replace('/start', '/status/data');
}

function _sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

// Paper routes report \`running\`.
function _isUp(d){
  if (!d || typeof d !== 'object') return false;
  return !!d.running;
}

function _whyDown(d){
  if (!d || typeof d !== 'object') return 'no status returned';
  return 'engine not running';
}

async function _pollRunning(endpoint){
  try {
    var r = await fetch(_statusUrlFor(endpoint), { cache:'no-store' });
    if (!r.ok) return { running:false, error:'status check failed (HTTP ' + r.status + ')' };
    var d = await r.json();
    return _isUp(d) ? { running:true } : { running:false, error:_whyDown(d) };
  } catch(e){
    return { running:false, error:'status check unreachable' };
  }
}

async function _verifyAllRunning(endpoints){
  var verdict = {};
  var pending = endpoints.slice();
  for (var attempt = 0; attempt < VERIFY_ATTEMPTS && pending.length; attempt++){
    if (attempt) await _sleep(VERIFY_GAP_MS);
    var checked = await Promise.all(pending.map(_pollRunning));
    var stillPending = [];
    for (var i = 0; i < pending.length; i++){
      verdict[pending[i]] = checked[i];
      if (!checked[i].running) stillPending.push(pending[i]);
    }
    pending = stillPending;
  }
  return verdict;
}

function _startAllRow(name, ok, why){
  var tint   = ok ? 'rgba(22,163,74,0.10)' : 'rgba(239,68,68,0.10)';
  var edge   = ok ? 'rgba(22,163,74,0.35)' : 'rgba(239,68,68,0.35)';
  var colour = ok ? '#16a34a' : '#ef4444';
  return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:5px;'
       + 'border-radius:7px;background:' + tint + ';border:1px solid ' + edge + ';">'
       + '<span style="font-size:0.85rem;">' + (ok ? '✅' : '❌') + '</span>'
       + '<span style="flex:1;min-width:0;text-align:left;">' + _escHtml(name)
       + (ok ? '' : '<br><span style="font-size:0.68rem;opacity:0.85;">' + _escHtml(why) + '</span>')
       + '</span>'
       + '<span style="font-weight:700;color:' + colour + ';letter-spacing:0.04em;">'
       + (ok ? 'OK' : 'FAILED') + '</span>'
       + '</div>';
}

// Always shown after a Start All. Previously an all-success run just reloaded
// the page silently, which left no confirmation that every strategy was really
// up; now every attempted mode is listed by name with its verified state.
async function _handleStartAllResult(btn, origText, label, endpoints, result){
  var failByEndpoint = {};
  result.failures.forEach(function(f){ failByEndpoint[f.endpoint] = f; });

  var verdict = await _verifyAllRunning(endpoints);

  var okCount = 0;
  var rows = endpoints.map(function(ep){
    var v = verdict[ep] || { running:false };
    if (v.running){ okCount++; return _startAllRow(_prettyEndpoint(ep), true, ''); }
    // Prefer the /start error — it says WHY. Fall back to the status probe.
    var why = (failByEndpoint[ep] && failByEndpoint[ep].error)
           || v.error
           || 'started but not running';
    return _startAllRow(_prettyEndpoint(ep), false, why);
  }).join('');

  var total  = endpoints.length;
  var allOk  = okCount === total;
  var header = allOk
    ? ('All ' + total + ' running — verified.')
    : (okCount + ' of ' + total + ' running. See the failures below.');

  await showAlert({
    icon: allOk ? '✅' : (okCount > 0 ? '⚠️' : '❌'),
    title: label + ' — ' + okCount + '/' + total + ' Running',
    message: '<div style="text-align:left;">'
           + '<div style="margin-bottom:10px;">' + header + '</div>'
           + '<div style="max-height:min(46vh,340px);overflow-y:auto;">' + rows + '</div>'
           + '</div>',
    btnText: 'OK',
    btnClass: 'modal-btn-primary',
  });

  btn.disabled = false;
  btn.textContent = origText;
  // Reload so the dashboard badges/buttons pick up whatever did come up. With
  // nothing running there is no state change to show — leave the page put so
  // the user can act on the reasons they just read.
  if (okCount > 0) location.reload();
}

// Guard for an empty roster: every strategy disabled in Settings would otherwise "succeed" with 0 starts
// and silently reload the page.
async function _noModesEnabled(endpoints, what){
  if (endpoints.length) return false;
  await showAlert({
    icon: '⚠️',
    title: 'Nothing to start',
    message: 'No strategy is enabled for ' + what + '. Enable one in Settings → Strategy Modes and try again.',
    btnText: 'OK', btnClass: 'modal-btn-primary',
  });
  return true;
}

// Single entry point for the Start-All buttons, so the busy flag can
// never be left set (or skipped) by one of them drifting from the others.
async function _runStartAll(btn, origText, label, endpoints){
  _startAllBusy = true;
  try {
    var result = await _startAll(endpoints);
    await _handleStartAllResult(btn, origText, label, endpoints, result);
  } finally {
    _startAllBusy = false;
    _startAllClickBusy = false;
  }
}

async function startAllPaper(btn){
  var orig = btn.textContent;
  if (!await _beginStartAll(btn)) return;
  if (await _noModesEnabled(PAPER_ENDPOINTS, 'Paper')) return _abortStartAll(btn, orig);
  btn.textContent = '⏳ Starting paper: ' + ALL_MODE_LABELS.join(' + ') + '...';
  await _runStartAll(btn, orig, 'All Paper', PAPER_ENDPOINTS);
}

function startAll(btn){
  return startAllPaper(btn);
}

// ── Quick-Action button state ───────────────────────────────────────────────
var _allBtnState = { paperOn:false };
var _marketsClosed = false;        // set by checkTradingStatus(): weekend / NSE holiday / pre- or post-market
// Derived from the same enabled-strategy roster as the Start-All endpoint lists.
var ALL_BTN_POLL = ${JSON.stringify(startAllPollTargets)};

function _applyAllBtnState(paperOn){
  // _marketsClosed wins: this poll runs every few seconds and would
  // otherwise re-show the buttons that checkTradingStatus() just hid on a
  // weekend / NSE holiday / outside market hours.
  var b = document.getElementById('btn-all-start');
  if(!b) return;
  if(_marketsClosed){ b.style.display = 'none'; return; }
  b.style.display = '';
  b.classList.remove('run-paper','is-active-paper','is-locked');
  if(paperOn){
    b.disabled = true; b.classList.add('is-active-paper');
    b.textContent = '● PAPER ACTIVE'; b.title = 'Paper trading is running';
  } else {
    b.disabled = false; b.classList.add('run-paper');
    b.textContent = '▶ Start All (Paper)'; b.title = 'Start all paper modes';
  }
}

async function pollAllBtnsStatus(){
  if(!document.getElementById('btn-all-start')) return;
  try {
    var results = await Promise.all(ALL_BTN_POLL.map(function(p){
      return fetch(p.url,{cache:'no-store'})
        .then(function(r){ return r.ok ? r.json() : {running:false}; })
        .catch(function(){ return {running:false}; });
    }));
    var paperOn=false;
    for(var i=0;i<results.length;i++){
      if(results[i] && results[i].running) paperOn=true;
    }
    _allBtnState.paperOn = paperOn;
    _applyAllBtnState(paperOn);
  } catch(_){}
}
pollAllBtnsStatus();
// Polls skip while the tab is hidden and catch up the moment it is shown again.
setInterval(function(){ if (!document.hidden) pollAllBtnsStatus(); }, 10000);
document.addEventListener('visibilitychange', function(){ if (!document.hidden) pollAllBtnsStatus(); });

// ── Dashboard Cumulative P&L Charts (Paper) ─────────────────────────────────
function _fmtINR(n){
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _buildCumSeries(trades){
  var sorted = trades.slice().sort(function(a, b){
    var da = (a.date || '') + ' ' + (a.entryTime || '');
    var db = (b.date || '') + ' ' + (b.entryTime || '');
    return da.localeCompare(db);
  });
  var cum = 0, labels = [], data = [];
  for (var i = 0; i < sorted.length; i++){
    var t = sorted[i];
    cum += (t.pnl || 0);
    var lbl = (t.date || '') + (t.entryTime ? ' ' + t.entryTime.split(',')[0] : '');
    labels.push(lbl);
    data.push(cum);
  }
  return { labels: labels, data: data, total: cum };
}

var PNL_GREEN = '#10b981', PNL_RED = '#ef4444', PNL_FLAT = '#8ba1c2';
var PNL_GREEN_FILL = 'rgba(16,185,129,0.14)', PNL_RED_FILL = 'rgba(239,68,68,0.14)', PNL_FLAT_FILL = 'rgba(74,96,128,0.10)';
function _pnlColor(total){ return total > 0 ? PNL_GREEN : (total < 0 ? PNL_RED : PNL_FLAT); }
function _pnlFill(total){ return total > 0 ? PNL_GREEN_FILL : (total < 0 ? PNL_RED_FILL : PNL_FLAT_FILL); }

function _renderDashCumChart(canvasId, emptyId, trades){
  var canvas = document.getElementById(canvasId);
  var empty  = document.getElementById(emptyId);
  if (!canvas) return null;
  // The canvas sits in a fixed-height wrapper (.mm-wrap / .dash-chart-wrap), so
  // hiding the canvas alone left the wrapper's height behind as an empty band
  // above the "no trades" line. Collapse the wrapper too.
  var wrap = canvas.parentElement;
  if (!trades || !trades.length){
    if (empty) empty.style.display = 'block';
    canvas.style.display = 'none';
    if (wrap) wrap.style.display = 'none';
    return null;
  }
  if (empty) empty.style.display = 'none';
  if (wrap) wrap.style.display = '';
  canvas.style.display = 'block';
  var s = _buildCumSeries(trades);
  var isLight = document.documentElement.getAttribute('data-theme') === 'light';
  var gridCol = isLight ? '#e0e4ea' : '#1a2236';
  var tickCol = isLight ? '#64748b' : '#3a5070';
  var baseColor = _pnlColor(s.total);
  var baseFill  = _pnlFill(s.total);
  return new Chart(canvas, {
    type: 'line',
    data: { labels: s.labels, datasets: [{
      data: s.data, borderColor: baseColor,
      // Fill is split at the zero line: green above, red below — matches the line colour.
      backgroundColor: function(ctx){
        var chart = ctx.chart, area = chart.chartArea;
        if (!area) return baseFill; // before first layout
        var zeroPx = chart.scales.y.getPixelForValue(0);
        var r = (zeroPx - area.top) / (area.bottom - area.top);
        r = Math.max(0, Math.min(1, r));
        var g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, PNL_GREEN_FILL);
        g.addColorStop(r, PNL_GREEN_FILL);
        g.addColorStop(r, PNL_RED_FILL);
        g.addColorStop(1, PNL_RED_FILL);
        return g;
      },
      borderWidth: 2, fill: true, tension: 0.25, pointRadius: 0,
      segment: {
        borderColor: function(ctx){
          var y0 = ctx.p0.parsed.y, y1 = ctx.p1.parsed.y;
          return ((y0 + y1) / 2) >= 0 ? PNL_GREEN : PNL_RED;
        },
      },
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: function(ctx){ return _fmtINR(ctx.parsed.y); } } } },
      scales: {
        x: { ticks: { display: false }, grid: { display: false } },
        y: { ticks: { color: tickCol, font: { size: 9 }, callback: function(v){ return _fmtINR(v); } }, grid: { color: gridCol } },
      },
    },
  });
}

function _updateChartStats(elId, trades){
  var el = document.getElementById(elId);
  if (!el) return;
  if (!trades || !trades.length){ el.innerHTML = '<span class="pnl-flat">0 trades</span>'; return; }
  var total = 0, wins = 0, losses = 0;
  for (var i = 0; i < trades.length; i++){
    var p = trades[i].pnl || 0;
    total += p;
    if (p > 0) wins++; else if (p < 0) losses++;
  }
  var cls = total > 0 ? 'pnl-pos' : (total < 0 ? 'pnl-neg' : 'pnl-flat');
  el.innerHTML = trades.length + ' trades · ' + wins + 'W/' + losses + 'L · <span class="' + cls + '">' + (total >= 0 ? '+' : '') + _fmtINR(total) + '</span>';
}

// ── Global date-range filter (top-bar) — applied to every chart on the page ──
// The charts already hold the full trade list client-side, so the range is a
// pure filter step: no refetch, and switching ranges cannot desync the total
// chart from the per-module ones because both read the same _dashRange.
// The option list and the date maths come from sharedNav's dateRangeJS() so
// this page and Edge Analytics always mean the same thing by a given range.
// Placeholder only — the wire-up block below calls _readDashRange() to fill this
// in from the select's own value before anything renders, so the page never
// filters by a range that differs from the one shown in the bar.
var _dashRange = { key:'', from:'', to:'' };

function _readDashRange(){
  var sel = document.getElementById('dashRangeSel');
  var key = sel ? sel.value : 'all';
  var f = document.getElementById('dashRangeFrom');
  var t = document.getElementById('dashRangeTo');
  var r = drRange(key, (f && f.value) || '', (t && t.value) || '');
  _dashRange = { key:key, from:r.from, to:r.to };
}

function _applyDashRange(trades){
  var f = _dashRange;
  if (!f.from && !f.to) return trades || [];
  return (trades || []).filter(function(t){
    var d = t.date || '';
    if (f.from && d < f.from) return false;
    if (f.to   && d > f.to)   return false;
    return true;
  });
}
function _dashRangeActive(){ return !!(_dashRange.from || _dashRange.to); }

var _dcData = { paper: null };
var _dcChart = null;

function _renderDashTotal(){
  var trades = _applyDashRange(_dcData.paper || []).filter(_inMarket);
  var total = trades.reduce(function(a,t){ return a + (t.pnl||0); }, 0);
  var dot = document.getElementById('dashCumDot');
  if (dot) dot.style.background = _pnlColor(total);
  var link = document.getElementById('dashCumLink');
  if (link) link.href = '/consolidation';
  // Nothing in the source/range → no card, same as the strategy cards above.
  var card = document.getElementById('dashCumCard');
  if (card) card.style.display = trades.length ? '' : 'none';
  var emptyEl = document.getElementById('dashCumEmpty');
  if (emptyEl) emptyEl.textContent = 'No paper trades ' + (_dashRangeActive() ? 'in this range' : 'yet');
  var title = document.querySelector('#dashCumCard .dash-chart-title span:last-child');
  if (title) {
    var mk = dhMarket(), lbl = (DASH_MARKETS.filter(function(g){ return g.key === mk; })[0] || {}).label;
    title.textContent = (lbl ? lbl : 'All strategies') + ' · cumulative P&L';
  }
  if (_dcChart) { _dcChart.destroy(); _dcChart = null; }
  _dcChart = _renderDashCumChart('dashCumChart', 'dashCumEmpty', trades);
  _updateChartStats('dash-cum-stats', trades);
}

// The login cookie has a sliding 15-min expiry, so a tab left open outlives
// its session: the page HTML is already rendered, but every later data fetch
// comes back 401. Swallowing that into an empty array drew *blank charts on a
// logged-out page*, which reads as "no trades today" — the one message it must
// never send. Say the session expired instead, and offer the way back.
var _authBannerShown = false;
function _authLost(){
  if (_authBannerShown) return;
  _authBannerShown = true;
  var bar = document.createElement('div');
  bar.id = 'sessionExpiredBar';
  bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;background:#b91c1c;color:#fff;'
    + 'padding:12px 16px;font:600 0.9rem system-ui,sans-serif;display:flex;gap:12px;'
    + 'align-items:center;justify-content:center;flex-wrap:wrap;'
    + 'padding-top:calc(12px + env(safe-area-inset-top));';
  bar.innerHTML = '<span>Session expired — charts below are not your data.</span>'
    + '<a href="/login" style="background:#fff;color:#b91c1c;padding:6px 14px;border-radius:6px;'
    + 'text-decoration:none;min-height:44px;display:inline-flex;align-items:center;">Log in again</a>';
  document.body.appendChild(bar);
}

async function loadDashCumCharts(){
  try {
    var r = await fetch('/consolidation/data?enabledOnly=1', { cache: 'no-store' });
    if (r.status === 401) _authLost();
    if (r.ok){ var d = await r.json(); _dcData.paper = (d && d.trades) || []; }
  } catch(_){ _dcData.paper = []; }
  _renderDashTotal();
  _paintHero();
}

// ── Today's P&L hero ────────────────────────────────────────────────────────
// Market open and the Today panel polled the strategies: open + closed from
// those polls (_heroLive). Otherwise: today's saved paper trades. Nothing today
// → ₹0, and the sub line names the last session so a quiet day is not read as
// a broken page.
var _heroLive = null;
function _istToday(){ return new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' }); }
function _paintHero(){
  if (_heroLive) { dhHero(_heroLive.byMarket, _heroLive.sub); return; }
  var all = _dcData.paper;
  if (!all) return;
  var today = _istToday(), byMarket = {}, n = 0, last = null;
  all.forEach(function(t){
    if (!t || !t.date) return;
    if (t.date === today) {
      var m = MODE_MARKET[String(t.mode || '').toUpperCase()] || 'NIFTY';
      byMarket[m] = (byMarket[m] || 0) + (+t.pnl || 0); n++;
    } else if (t.date < today && (!last || t.date > last)) last = t.date;
  });
  var sub = n ? n + ' closed trade' + (n === 1 ? '' : 's') + ' today · no strategy running' : 'No trades today';
  if (!n && last) {
    var lastNet = all.reduce(function(a, t){ return a + (t && t.date === last ? (+t.pnl || 0) : 0); }, 0);
    sub += ' · last session ' + last + ': ' + dhFmtINR(lastNet);
  }
  dhHero(byMarket, sub);
}

// Global date-range selector (top-bar) — re-renders every chart.
(function(){
  var sel = document.getElementById('dashRangeSel');
  if (!sel) return;
  function refreshRange(){
    _readDashRange();
    _renderDashTotal();
    MM_KEYS.forEach(_renderModuleChart);
    _renderBrokerWallets();
  }
  function syncCustomVisibility(){
    var custom = document.getElementById('dashRangeCustom');
    if (custom) custom.style.display = sel.value === 'custom' ? '' : 'none';
  }
  function onRangeChange(){
    syncCustomVisibility();
    // Only 'Current week expiry' needs the expiry calendar — fetched on first
    // use and cached, so every later selection resolves without a round-trip.
    if (sel.value === 'exp') { drReady().then(refreshRange); return; }
    refreshRange();
  }
  sel.addEventListener('change', onRangeChange);
  ['dashRangeFrom','dashRangeTo'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', onRangeChange);
  });
  // Adopt whatever the select actually shows before the first render: on a
  // back-navigation the browser restores the previous selection, and a default
  // _dashRange of "All" would then disagree with the visible label.
  syncCustomVisibility();
  _readDashRange();
  if (sel.value === 'exp') drReady().then(refreshRange);
})();

dhMarketInit(DASH_MARKETS.map(function(g){ return g.key; }), function(){
  _renderDashTotal();
  if (typeof _daRerender === 'function') _daRerender();
});
loadDashCumCharts();

// ── Per-Module P&L Charts (Range filter) ─────────────────────────────────────
var _mmData = { paper: null };
var _mmCharts = {};

// A strategy with no trades in the selected range has nothing to show,
// so its whole card is hidden rather than kept as a "0 trades" placeholder —
// and an emptied grid shows nothing at all.
// Rows are balanced over the VISIBLE cards, never ragged: 4 per row is the
// widest a row gets, and the count is then spread evenly over the rows that
// needs — 5 cards go 3+2 (not 4+1), 7 go 4+3, 11 go 4+4+3. The last row's cards
// stretch to fill whatever width is left (flex-grow, see .mm-grid), so there is
// no dead space on the right regardless of how many strategies are enabled.
var MM_MAX_COLS = 4;
function _layoutModuleGrid(grid, visible){
  if (!grid) return;
  var rows = Math.max(1, Math.ceil(visible / MM_MAX_COLS));
  grid.style.setProperty('--mm-cols', String(Math.max(1, Math.ceil(visible / rows))));
}

// Each market section lays out its own visible cards, and hides itself (title
// included) when none of its strategies traded in the range.
function _updateModuleGridEmpty(){
  document.querySelectorAll('.mm-mkt').forEach(function(sec){
    var visible = 0;
    sec.querySelectorAll('.mm-card[data-mode]').forEach(function(c){
      if (c.style.display !== 'none') visible++;
    });
    _layoutModuleGrid(sec.querySelector('.mm-grid'), visible);
    sec.hidden = visible === 0;
  });
}

function _renderModuleChart(mode){
  var card = document.querySelector('.mm-card[data-mode="' + mode + '"]');
  if (!card) return;
  var all = _mmData.paper || [];
  var trades = _applyDashRange(all.filter(function(t){ return (t.mode || '').toUpperCase() === mode; }));
  if (_mmCharts[mode]) { _mmCharts[mode].destroy(); _mmCharts[mode] = null; }
  card.style.display = trades.length ? '' : 'none';
  if (!trades.length) { _updateModuleGridEmpty(); return; }  // never draw into a hidden card
  // The card's own "no trades" line is unreachable from here now that an empty
  // card is hidden outright; _renderDashCumChart still owns it for the shared
  // cumulative card below the grid.
  _mmCharts[mode] = _renderDashCumChart('mmChart-' + mode, 'mm-empty-' + mode, trades);
  _updateChartStats('mm-stats-' + mode, trades);
  _updateModuleGridEmpty();
}

// ── Broker wallets — remaining = investment pool + paper P&L in the SAME range
// the charts are showing. Reads _mmData.paper (every mode) and narrows it with the pool's own mode list, so a broker's
// wallet moves only for the strategies that actually trade through it.
// Deliberately paper-only, and driven by _applyDashRange so the wallet and the
// curve below it can never quote different periods.
var BROKER_POOLS = ${JSON.stringify(brokerPools)};
function _inr0(n){ return '₹' + Math.round(n).toLocaleString('en-IN'); }
function _renderBrokerWallets(){
  var all = _mmData.paper;
  if (!all) return;                    // trades not loaded yet — keep the "…"
  var rows = _applyDashRange(all);
  Object.keys(BROKER_POOLS).forEach(function(broker){
    var pool = BROKER_POOLS[broker];
    var remainEl = document.getElementById('wallet-remain-' + broker);
    var pnlEl    = document.getElementById('wallet-pnl-' + broker);
    if (!remainEl && !pnlEl) return;   // wallets are hidden while a mode runs
    var pnl = 0;
    for (var i = 0; i < rows.length; i++){
      if (pool.modes.indexOf(String(rows[i].mode || '').toUpperCase()) !== -1) pnl += (rows[i].pnl || 0);
    }
    if (remainEl) remainEl.textContent = _inr0(pool.inv + pnl);
    if (pnlEl){
      pnlEl.className   = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'zero';
      pnlEl.textContent = (pnl > 0 ? '▲ ' : pnl < 0 ? '▼ ' : '') + _inr0(Math.abs(pnl));
    }
  });
}

async function loadModuleCharts(){
  try {
    var r1 = await fetch('/consolidation/data', { cache: 'no-store' });
    if (r1.status === 401) _authLost();
    if (r1.ok){ var d1 = await r1.json(); _mmData.paper = (d1 && d1.trades) || []; }
  } catch(_){ _mmData.paper = []; }
  MM_KEYS.forEach(_renderModuleChart);
  _renderBrokerWallets();
}

loadModuleCharts();

// ── Market schedule pills (top bar) — independent of analytics panel ─────────
// A phone can't spare a whole top-bar row per pill: "📅 Next Expiry Date :
// 28/07/2026 - M - 1 day" is 41 characters and takes the full 393px width on
// its own, pushing the broker rows off the first screen. Each pill therefore
// carries both labels and picks one by viewport — the short form keeps the
// date, the W/M type and the days, which is all the bar has to convey; the
// popup behind the pill has the rest.
var SCHED_PILL_NARROW = 768;
function setSchedulePillLabel(el, full, short){
  el.dataset.full  = full;
  el.dataset.short = short;
  el.textContent = window.innerWidth <= SCHED_PILL_NARROW ? short : full;
}
function applySchedulePillLabels(){
  ['expiry-info-pill','holiday-info-pill'].forEach(function(id){
    var el = document.getElementById(id);
    if (!el || !el.dataset.full) return;
    var want = window.innerWidth <= SCHED_PILL_NARROW ? el.dataset.short : el.dataset.full;
    if (el.textContent !== want) el.textContent = want;
  });
}
(function(){
  var t = null;
  window.addEventListener('resize', function(){
    clearTimeout(t);
    t = setTimeout(applySchedulePillLabels, 150);   // also covers rotate
  });
})();

async function loadMarketSchedulePills(){
  function istDateISO(){ return new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' }); }
  function diffDays(iso){
    var parts = iso.split('-');
    var dt = new Date(Date.UTC(+parts[0], +parts[1]-1, +parts[2]));
    var today = istDateISO().split('-');
    var nowDt = new Date(Date.UTC(+today[0], +today[1]-1, +today[2]));
    return Math.round((dt - nowDt) / 86400000);
  }
  function fmtDMY(iso){ var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  var expEl = document.getElementById('expiry-info-pill');
  var holEl = document.getElementById('holiday-info-pill');
  if (!expEl || !holEl) return;
  try {
    var [hr, er] = await Promise.all([
      fetch('/api/holidays',     { cache:'no-store' }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
      fetch('/api/expiry-dates', { cache:'no-store' }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
    ]);
    var todayIso = istDateISO();
    // Next expiry
    var expiries = (er && er.expiries) || [];
    var nextExp = null;
    for (var i = 0; i < expiries.length; i++) {
      var e = expiries[i];
      var d = e.actual || e.date;
      if (d >= todayIso) { nextExp = { date:d, monthly:e.monthly, preponed:e.preponed }; break; }
    }
    // One pill carries both indices: NIFTY takes the next expiry of any kind,
    // NIFTY BANK the next MONTHLY row of that very same calendar (NSE withdrew
    // BANKNIFTY weeklies in Nov-2024, so the month contract is the only one
    // listed). Reading both off one /api/expiry-dates response guarantees they
    // can never disagree about a holiday prepone.
    var nextBn = null;
    for (var b = 0; b < expiries.length; b++) {
      if (!expiries[b].monthly) continue;
      var bd = expiries[b].actual || expiries[b].date;
      if (bd >= todayIso) { nextBn = { date:bd, preponed:expiries[b].preponed }; break; }
    }
    var nFull = '\u26A0 No upcoming NIFTY expiry', nShort = '\u26A0 No NIFTY expiry';
    if (nextExp) {
      var d = diffDays(nextExp.date);
      var typeLbl = (nextExp.monthly ? 'M' : 'W') + (nextExp.preponed ? '*' : '');
      var when = d === 0 ? 'today' : d + (d === 1 ? ' day' : ' days');
      var whenShort = d === 0 ? 'today' : d + 'd';
      var dm = fmtDMY(nextExp.date).slice(0, 5);   // 28/07/2026 -> 28/07
      nFull  = 'NIFTY ' + fmtDMY(nextExp.date) + ' - ' + typeLbl + ' - ' + when;
      nShort = 'N ' + dm + ' \u00B7 ' + typeLbl + ' \u00B7 ' + whenShort;
    }
    var bFull = '\u26A0 No upcoming BANK NIFTY expiry', bShort = '\u26A0 No BN expiry';
    if (nextBn) {
      var bdd = diffDays(nextBn.date);
      var bnType = 'M' + (nextBn.preponed ? '*' : '');
      var bnWhen = bdd === 0 ? 'today' : bdd + (bdd === 1 ? ' day' : ' days');
      var bnWhenShort = bdd === 0 ? 'today' : bdd + 'd';
      var bnDm = fmtDMY(nextBn.date).slice(0, 5);
      bFull  = 'BANK NIFTY ' + fmtDMY(nextBn.date) + ' - ' + bnType + ' - ' + bnWhen;
      bShort = 'BN ' + bnDm + ' \u00B7 ' + bnType + ' \u00B7 ' + bnWhenShort;
    }
    if (nextExp || nextBn) expEl.classList.remove('empty');
    else expEl.classList.add('empty');
    setSchedulePillLabel(
      expEl,
      '\uD83D\uDCC5 ' + nFull + '  |  \uD83C\uDFE6 ' + bFull,
      '\uD83D\uDCC5 ' + nShort + ' | ' + bShort
    );
    // Next holiday
    var holidays = ((hr && hr.holidays) || []).slice().sort();
    var nextHol = null;
    for (var j = 0; j < holidays.length; j++) {
      if (holidays[j] >= todayIso) { nextHol = holidays[j]; break; }
    }
    if (nextHol) {
      var hd = diffDays(nextHol);
      // Only surface the holiday from the previous day onward (tomorrow / today) —
      // no point showing a countdown to a holiday weeks away.
      if (hd <= 1) {
        var hwhen = hd === 0 ? 'today' : 'tomorrow';
        holEl.style.display = '';
        holEl.classList.remove('empty');
        setSchedulePillLabel(
          holEl,
          '🎉 Holiday ' + fmtDMY(nextHol) + ' · ' + hwhen,
          '🎉 ' + fmtDMY(nextHol).slice(0, 5) + ' · ' + hwhen
        );
      } else {
        holEl.style.display = 'none';
      }
    } else {
      holEl.style.display = 'none';
    }
  } catch(_){}
}
loadMarketSchedulePills();
setInterval(function(){ if (!document.hidden) loadMarketSchedulePills(); }, 3600000); // hourly — these change daily at most
document.addEventListener('visibilitychange', function(){ if (!document.hidden) loadMarketSchedulePills(); });

// ── Dashboard Analytics Panel ─────────────────────────────────────────────────
// Live view (market hours) vs Post-market view (last session only).
var _daRerender = null;
(function initAnalyticsPanel(){
  var root = document.getElementById('dashAnalytics');
  if (!root) return;

  // Enabled-strategy tiles (server-rendered from *_MODE_ENABLED). Drives both
  // the live and post-market views so disabled strategies never appear here.
  var SESSION_TILES = ${JSON.stringify(dashSessionTiles)};
  function istNowMinutes(){
    // Minutes since IST midnight using fixed +05:30 offset (no DST in India)
    return Math.floor((Math.floor(Date.now() / 1000) + 19800) / 60) % 1440;
  }
  function istDateISO(){
    var d = new Date();
    // en-CA gives YYYY-MM-DD
    return d.toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' });
  }
  function istDow(){
    var d = new Date(new Date().toLocaleString('en-US', { timeZone:'Asia/Kolkata' }));
    return d.getDay(); // 0=Sun..6=Sat
  }

  // Are we inside an NSE trading session?
  function isMarketOpenNow(holidays){
    var dow = istDow();
    if (dow === 0 || dow === 6) return false;
    var iso = istDateISO();
    if (holidays && holidays.indexOf(iso) !== -1) return false;
    var m = istNowMinutes();
    return m >= 9*60+15 && m < 15*60+30;
  }

  function fetchJSON(url){
    return fetch(url, { cache:'no-store' }).then(function(r){
      // A 401 here means the sliding login cookie lapsed while the tab sat open.
      // Returning null would leave the panel on "Loading analytics…" forever.
      if (r.status === 401) { _authLost(); return null; }
      return r.ok ? r.json() : null;
    }).catch(function(){ return null; });
  }

  // Keep a tile only if the strategy has something to report today: a closed
  // trade, or an open position — a trade taken, just not finished yet. A failed
  // status fetch (d == null) is not proof of an idle strategy, so it keeps its
  // tile and shows OFFLINE rather than disappearing mid-session.
  // hasOpenPosition: strategies report an open position in one of two shapes —
  // a single "position", or EarlyBird's "positions[]" PLUS a separate NIFTY
  // option leg at "option.position". Testing "position" alone made an EarlyBird
  // tile vanish on an option-only day that had not closed a trade yet.
  function hasOpenPosition(d){
    if (!d) return false;
    if (d.position) return true;
    if (Array.isArray(d.positions) && d.positions.length) return true;
    return !!(d.option && d.option.position);
  }
  function shouldShowLiveTile(d){
    if (!d) return true;
    var taken = d.tradeCount != null ? d.tradeCount : (d.tradesTaken || 0);
    return (+taken > 0) || hasOpenPosition(d);
  }

  // Tile → paper page URL. It comes from the server-discovered mounts, so an
  // unmounted route simply renders a non-clickable tile instead of a dead link.
  function tileHref(t){
    return t.paper || null;
  }
  // Today so far: one line per strategy that traded or holds a position; the
  // rest are counted in their market's subtotal but not drawn. A failed status
  // fetch (d == null) is not proof of an idle strategy, so it shows OFFLINE.
  function liveRows(data){
    return SESSION_TILES.map(function(t){
      var d = data[t.key];
      var base = { key:t.key, label:t.label, market:t.market, accent:t.accent, href:tileHref(t) };
      if (!d) return Object.assign(base, { offline:true });
      var stale = !!d.staleSession;
      // Field names vary by strategy (ORB uses livePnl/tradesTaken, EarlyBird
      // openPnl — already summed across its stock legs AND its option leg) —
      // same order as realtime.js openPnl().
      var open = (d.unrealisedPnl !== undefined ? d.unrealisedPnl
               : d.unrealised !== undefined ? d.unrealised
               : d.livePnl !== undefined ? d.livePnl
               : d.openPnl !== undefined ? d.openPnl
               : 0) || 0;
      var taken = stale ? 0 : (d.tradeCount != null ? d.tradeCount : (d.tradesTaken || 0));
      return Object.assign(base, {
        running: !!d.running, open: +open || 0, closed: stale ? 0 : (+d.sessionPnl || 0),
        trades: +taken || 0, w: stale ? 0 : (d.wins || 0), l: stale ? 0 : (d.losses || 0),
        quiet: !shouldShowLiveTile(d),
      });
    });
  }
  function renderLive(data) {
    var out = dhSummary(liveRows(data), DASH_MARKETS, { market: dhMarket() });
    // The hero is every market regardless of the filter.
    var allOut = dhMarket() === 'ALL' ? out : dhSummary(liveRows(data), DASH_MARKETS, {});
    var hb = {};
    Object.keys(allOut.byMarket).forEach(function(m){ hb[m] = allOut.byMarket[m].open + allOut.byMarket[m].closed; });
    _heroLive = { byMarket: hb, sub: allOut.total.trades + ' trade' + (allOut.total.trades === 1 ? '' : 's') + ' today · market open' };
    _paintHero();
    if (!out.html) return '<div class="da-empty">No strategy is enabled for this market.</div>';
    if (!out.total.trades && !out.total.open) {
      return '<div class="da-empty">No strategy has taken a trade yet today.</div>' + out.html;
    }
    return out.html;
  }

  function aggregateTrades(trades, fromIso, toIso) {
    // Returns { byStrategy: {EMA_RSI_ST:{net,trades,w,l}, ...}, total: {...}, byDate: { 'YYYY-MM-DD': net } }
    // Buckets by the trade's reliable mode field (EMA_RSI_ST/BB_RSI/PA/ORB),
    // limited to the enabled tiles. Trades are pre-filtered to enabled modes by
    // the /data?enabledOnly=1 fetch, so the total matches the visible cards.
    var bys = {};
    SESSION_TILES.forEach(function(t){ bys[t.key] = {net:0,t:0,w:0,l:0}; });
    var tot = { net:0, t:0, w:0, l:0 };
    var byDate = {};
    var bestDay = null, worstDay = null;
    trades.forEach(function(tr){
      if (!tr || !tr.date) return;
      if (fromIso && tr.date < fromIso) return;
      if (toIso && tr.date > toIso) return;
      var key = String(tr.mode || '').toUpperCase();
      var p = +tr.pnl || 0;
      if (bys[key]) {
        bys[key].net += p; bys[key].t++; if (p > 0) bys[key].w++; else if (p < 0) bys[key].l++;
      }
      tot.net += p; tot.t++; if (p > 0) tot.w++; else if (p < 0) tot.l++;
      byDate[tr.date] = (byDate[tr.date] || 0) + p;
    });
    // Best / worst day
    Object.keys(byDate).forEach(function(d){
      var v = byDate[d];
      if (bestDay === null || v > bestDay.v) bestDay = { d:d, v:v };
      if (worstDay === null || v < worstDay.v) worstDay = { d:d, v:v };
    });
    return { byStrategy: bys, total: tot, byDate: byDate, bestDay: bestDay, worstDay: worstDay };
  }

  function lastTradingDate(byDate){
    var dates = Object.keys(byDate).sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  function pctWR(w, l){
    var tot = w + l;
    return tot === 0 ? 0 : Math.round(100 * w / tot);
  }

  // Last session: every enabled strategy's net on the last day anything traded,
  // grouped by market with subtotals — strategies that sat out are quiet.
  function renderPostMarket(paperTrades) {
    var combined = paperTrades || [];
    if (!combined.length) {
      return '<div class="da-empty">No trade history yet. Run a paper session — the last session appears here after the close.</div>';
    }
    var combinedAgg = aggregateTrades(combined);
    var lastDay = lastTradingDate(combinedAgg.byDate);
    var lastDayAgg = lastDay ? aggregateTrades(combined, lastDay, lastDay) : null;
    var rows = SESSION_TILES.map(function(t){
      var b = lastDayAgg ? lastDayAgg.byStrategy[t.key] : null;
      return { key:t.key, label:t.label, market:t.market, accent:t.accent, href:tileHref(t),
               closed: b ? b.net : 0, trades: b ? b.t : 0, w: b ? b.w : 0, l: b ? b.l : 0, quiet: !(b && b.t > 0) };
    });
    var out = dhSummary(rows, DASH_MARKETS, { market: dhMarket(), closedOnly: true, quietText: 'no trade that day', split: true });
    var head = '<div class="da-day">' + (lastDay ? 'Last trading day · ' + lastDay + ' · WR ' + pctWR(out.total.w, out.total.l) + '%' : '') + '</div>';
    return head + (out.html || '<div class="da-empty">Nothing traded in this market that day.</div>');
  }

  // Tag the title & badge based on mode
  function setMode(mode, sub){
    var badge = document.getElementById('da-mode-badge');
    var title = document.getElementById('da-title-txt');
    var subEl = document.getElementById('da-sub-txt');
    if (mode === 'live') {
      badge.className = 'da-badge live'; badge.textContent = 'MARKET OPEN';
      title.textContent = 'Today so far';
    } else {
      badge.className = 'da-badge post'; badge.textContent = 'MARKET CLOSED';
      title.textContent = 'Last session';
    }
    subEl.textContent = sub || '';
  }

  var _pollTimer = null;
  function clearPoll(){ if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }
  var _daLast = null;   // { live: data } or { post: trades } — the filter re-renders from it
  _daRerender = function(){
    var body = document.getElementById('da-body');
    if (!body || !_daLast) return;
    body.innerHTML = _daLast.live ? renderLive(_daLast.live) : renderPostMarket(_daLast.post);
  };

  async function refresh(){
    // A hidden tab polls nothing (8s in session = a dozen+ status fetches each);
    // the visibilitychange listener below refreshes the moment it is shown again.
    if (document.hidden) return;
    var body = document.getElementById('da-body');
    // Only need holidays here (for the market-open check). Expiry data is
    // surfaced in the top-bar pills, populated independently.
    var holRes = await fetchJSON('/api/holidays');
    var holidays = (holRes && holRes.holidays) || [];
    var marketOpen = isMarketOpenNow(holidays);

    if (marketOpen) {
      // setMode writes this through textContent, so it takes the character, not
      // the HTML entity — "&middot;" printed itself verbatim.
      setMode('live', 'Polling every 8s · ' + istDateISO());
      var liveResults = await Promise.all(SESSION_TILES.map(function(t){
        return fetchJSON(t.statusData).then(function(d){ return (d && d.monitor) ? d.monitor : d; });
      }));
      var liveData = {};
      SESSION_TILES.forEach(function(t, i){ liveData[t.key] = liveResults[i]; });
      _daLast = { live: liveData };
      body.innerHTML = renderLive(liveData);

      clearPoll();
      _pollTimer = setInterval(refresh, 8000);
    } else {
      setMode('post', 'Paper · refreshed ' + istDateISO());
      var paper = await fetchJSON('/consolidation/data?enabledOnly=1');
      var paperTrades = (paper && paper.trades) || [];
      // Same endpoint the hero reads — keep it current after a session ends.
      if (paper && paper.trades) _dcData.paper = paperTrades;
      _heroLive = null; _paintHero();
      _daLast = { post: paperTrades };
      body.innerHTML = renderPostMarket(paperTrades);

      clearPoll();
      _pollTimer = setInterval(refresh, 60000); // every minute after-hours (covers session end)
    }
  }

  document.addEventListener('visibilitychange', function(){ if (!document.hidden) refresh(); });
  refresh();
})();

// ── Check Trading Status — slim dismissible notification pill ────────────────
function dismissStatusAlert(){
  var d=document.getElementById('trading-status-alert');
  if(d){d._dismissed=true;d.style.display='none';}
}
function showStatusPill(alertDiv, icon, msg, color, dismissible){
  if(alertDiv._dismissed) return;
  alertDiv.style.display = 'block';
  alertDiv.innerHTML = '<div style="display:inline-flex;align-items:center;gap:6px;background:#07111f;border:0.5px solid '
    +color+';border-radius:20px;padding:3px 10px 3px 8px;font-size:0.68rem;color:'+color+';white-space:nowrap;">'
    +'<span>'+icon+'</span> <span>'+msg+'</span>'
    + (dismissible === false ? '' :
       ' <span class="status-pill-dismiss" role="button" aria-label="Dismiss" tabindex="0" onclick="dismissStatusAlert()" style="cursor:pointer;opacity:0.5;margin-left:4px;">&#x2715;</span>')
    +'</div>';
}
async function checkTradingStatus(){
  try {
    var alertDiv = document.getElementById('trading-status-alert');
    var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    var day = now.getDay(); var hour = now.getHours();
    // IST calendar date. toISOString() would read \`now\` back as UTC and give
    // yesterday's date from 00:00 to 05:30 IST, missing a holiday until 5:30.
    var todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // Holiday check runs first and unconditionally so the Start All button
    // is hidden regardless of weekend/pre/post-market early-returns below.
    var isHoliday = false;
    try {
      var hres = await fetch('/api/holidays', {cache:'no-store'});
      if(hres.ok){
        var hdata = await hres.json();
        if(hdata && hdata.success && hdata.holidays && hdata.holidays.includes(todayStr)){
          isHoliday = true;
        }
      }
    } catch(e){}
    // NSE shut = hide the NSE Start-All button, applied
    // below via _applyAllBtnState. Pre/post-market counts as shut too — the same
    // window the pill reports as closed.
    _marketsClosed = isHoliday || day === 0 || day === 6 || hour < 7 || hour >= 16;
    _applyAllBtnState(_allBtnState.paperOn);

    if(!alertDiv || alertDiv._dismissed) return;
    if(isHoliday){
      showStatusPill(alertDiv, '🎉', 'NSE Holiday — markets closed today', '#fbbf24', false); return;
    }
    if(day === 0 || day === 6){
      // Not dismissible: the weekend state lasts all day, so a ✕ only hides a
      // fact the user cannot change.
      showStatusPill(alertDiv, '🏖️', 'Weekend — markets resume Monday 9:15 AM', '#ef4444', false); return;
    }
    if(hour < 7 || hour >= 16){
      // Not dismissible, same reason as weekend/holiday: pre/post-market is a
      // fact the user cannot change, so a ✕ only hides it.
      var pillTxt = hour < 7 ? 'Pre-market — opens 9:15 AM IST' : 'Post-market — closed for the day';
      showStatusPill(alertDiv, '🕐', pillTxt, '#60a5fa', false); return;
    }
    alertDiv.style.display = 'none';
  } catch(e){}
}
checkTradingStatus();
setInterval(function(){ if (!document.hidden) checkTradingStatus(); }, 60000); // Check every minute
document.addEventListener('visibilitychange', function(){ if (!document.hidden) checkTradingStatus(); });

// Auto-swap to Real-Time view as soon as a session starts (UI_SHOW_REALTIME).
// Suspended while a Start-All run is in flight: that loop fires one /start per
// strategy SEQUENTIALLY from this page, and the first strategy to come up would
// otherwise trip this poll within 10s and navigate the page away — cancelling
// every /start still queued behind it, with no error shown. That is the
// "I pressed Start All but only the first few strategies started" bug.
async function pollSessionActiveSwap(){
  if (_startAllBusy) return;
  try {
    var r = await fetch('/api/session-active', { cache:'no-store' });
    if (!r.ok) return;
    var j = await r.json();
    if (j && j.active === true) location.replace('/');
  } catch(e){}
}
setInterval(function(){ if (!document.hidden) pollSessionActiveSwap(); }, 10000);
document.addEventListener('visibilitychange', function(){ if (!document.hidden) pollSessionActiveSwap(); });
// ─────────────────────────────────────────────────────────────────────────────

// ── Option expiry quick-save (dashboard mirror of the Settings fields) ───────
// Writes ONE index's override + type pair (OPTION_EXPIRY_* for NIFTY 50,
// BANKNIFTY_OPTION_EXPIRY_* for NIFTY BANK) through POST /settings/save, so the
// audit log + per-mode daily settings snapshot behave exactly as they do when
// the change is made on the Settings page. Both keys are INSTANT effect.
// One index per Save: the two calendars are independent — NIFTY BANK has been
// monthly-only since Nov-2024 — so writing both pairs from one button would
// stamp a NIFTY Tuesday onto a contract that has never been listed.
// Two keys is the whole payload: instrument.js resolves every strategy on an
// index from that index's pair, so there are no per-strategy expiry keys to
// send as well.
async function saveDashExpiry(btn, underlying, overrideKey, typeKey){
  var dateEl = document.getElementById('dashExpiryDate_' + underlying);
  var typeEl = document.getElementById('dashExpiryType_' + underlying);
  if(!dateEl || !typeEl || !overrideKey || !typeKey) return;
  var label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    var res = await secretFetch('/settings/save', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        updates: (function(){
          var u = {};
          u[overrideKey] = (dateEl.value || '').trim();
          u[typeKey]     = typeEl.value;
          return u;
        })(),
        note: 'dashboard: ' + underlying + ' option expiry quick-edit'
      })
    });
    if(!res){ btn.disabled = false; btn.textContent = label; return; }
    var d = await res.json();
    if(d && d.success){
      // success:true only means process.env was updated — the .env write can
      // still have failed, and the section auto-fill can pull in a key that
      // needs a restart. Settings surfaces both; a green tick here while the
      // change silently dies on the next PM2 restart would be worse than a
      // plain failure, so mirror the same three outcomes.
      if(!d.fileSaved){
        await showAlert({
          icon:'⚠️', title:'Applied, but NOT written to .env',
          message:'The new expiry is live right now, but saving .env failed:\\n'
                + (d.fileError || 'unknown error')
                + '\\n\\nIt will be lost the next time the server restarts. Fix the file and save again.',
          btnClass:'modal-btn-danger'
        });
        btn.textContent = '⚠ Not saved';                    // never a tick — the change is not durable
        setTimeout(function(){ location.reload(); }, 700);
        return;
      }
      if(d.needsRestart && d.needsRestart.length){
        await showAlert({
          icon:'🔄', title:'Saved — restart needed',
          message:'Written to .env. These keys only take effect after a restart:\\n'
                + d.needsRestart.join(', '),
          btnClass:'modal-btn-primary'
        });
      }
      btn.textContent = '✓ Saved';
      setTimeout(function(){ location.reload(); }, 700);   // refresh expiry pill + stale-expiry banner
    } else {
      btn.disabled = false; btn.textContent = label;
      showAlert({icon:'❌',title:'Save Failed',message:(d && d.error) || 'Could not save expiry settings.',btnClass:'modal-btn-danger'});
    }
  } catch(e){
    btn.disabled = false; btn.textContent = label;
    showAlert({icon:'❌',title:'Save Failed',message:e.message,btnClass:'modal-btn-danger'});
  }
}

// refreshHolidays() lives in sharedNav's expiryHolidayModalJS() (injected above)
// syncToLocal() moved to /docs page
</script>
</div></div>
</body>
</html>`;

  return html;
}

module.exports = { renderDashboard };
