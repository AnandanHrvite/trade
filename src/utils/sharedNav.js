/**
 * sharedNav.js — Unified navigation component
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders the sidebar nav (same design as Live Trade page) for ALL pages.
 * Used by: Dashboard, Backtest, Paper Trade, Live Trade, Logs
 *
 * @param {string}  activePage  - 'dashboard' | 'emaRsiStBacktest' | 'emaRsiStPaper' | 'emaRsiStLive' | 'logs'
 * @param {boolean} liveActive  - true when EMA_RSI_ST_LIVE socket is running
 * @param {boolean} isRunning   - true when THIS page's trade/session is running
 * @param {object}  opts        - { showStopBtn, showStartBtn, showExitBtn, stopLabel, startLabel }
 */

const { resolveTheme } = require('./theme');

// Canonical strategy list + their Settings toggle keys, in sidebar order.
// Single source of truth for "which strategies is this install running?" so
// cross-strategy screens (Edge Analytics, Consolidation Report) stay in step
// with the sidebar instead of hard-coding their own strategy lists.
const STRATEGY_MODES = [
  { mode: 'EMA_RSI_ST', label: 'EMA_RSI_ST',   envKey: 'EMA_RSI_ST_MODE_ENABLED' },
  { mode: 'BB_RSI',     label: 'BB_RSI',       envKey: 'BB_RSI_MODE_ENABLED'     },
  { mode: 'PA',         label: 'Price Action', envKey: 'PA_MODE_ENABLED'         },
  { mode: 'ORB',        label: 'ORB',          envKey: 'ORB_MODE_ENABLED'        },
  { mode: 'EMA9VWAP',   label: 'EMA9+VWAP',    envKey: 'EMA9VWAP_MODE_ENABLED'   },
  { mode: 'TREND_PB',   label: 'Trend_PB',     envKey: 'TREND_PB_MODE_ENABLED'   },
  { mode: 'GAPS',       label: 'GAPS',         envKey: 'GAPS_MODE_ENABLED'       },
  { mode: 'TDS',        label: 'Trend Day Scalp', envKey: 'TDS_MODE_ENABLED'     },
  { mode: 'GAP3M',      label: '3M Gap Fix Scalp', envKey: 'GAP3M_MODE_ENABLED'  },
  { mode: 'OIWF',       label: 'OI Wall Fade', envKey: 'OIWF_MODE_ENABLED'       },
  { mode: 'RSI_PIVOT_ST', label: 'RSI Pivot ST', envKey: 'RSI_PIVOT_ST_MODE_ENABLED' },
  { mode: 'SIMPLE930', label: 'SIMPLE_9:30', envKey: 'SIMPLE930_MODE_ENABLED' },
];

// Strategies currently enabled in Settings (default ON, same as the sidebar).
// Read from process.env on every call — Settings saves mutate process.env live,
// so callers must not cache the result across requests.
function enabledStrategies() {
  return STRATEGY_MODES.filter(s => (process.env[s.envKey] || 'true').toLowerCase() === 'true');
}

function buildSidebar(activePage, liveActive, isRunning = false, opts = {}) {
  // Import bb_rsi/primary/PA/ORB state inline to avoid circular dependency issues
  let _bbRsiMode = null;
  let _primaryMode = null;
  let _paMode = null;
  let _orbMode = null;
  let _ema9vwapMode = null;
  let _trendPbMode = null;
  let _gapsMode = null;
  let _trendDayScalpMode = null;
  let _gapFix3mMode = null;
  let _oiWallFadeMode = null;
  let _rsiPivotStMode = null;
  let _simple930Mode = null;
  let _anyTradeActive = false;
  try {
    const sss = require('./sharedSocketState');
    _bbRsiMode = sss.getBbRsiMode();
    _primaryMode = sss.getMode();
    _paMode = sss.getPAMode();
    _orbMode = sss.getOrbMode ? sss.getOrbMode() : null;
    _ema9vwapMode = sss.getEma9VwapMode ? sss.getEma9VwapMode() : null;
    _trendPbMode = sss.getTrendPbMode ? sss.getTrendPbMode() : null;
    _gapsMode = sss.getGapsMode ? sss.getGapsMode() : null;
    _trendDayScalpMode = sss.getTrendDayScalpMode ? sss.getTrendDayScalpMode() : null;
    _gapFix3mMode = sss.getGapFix3mMode ? sss.getGapFix3mMode() : null;
    _oiWallFadeMode = sss.getOiWallFadeMode ? sss.getOiWallFadeMode() : null;
    _rsiPivotStMode = sss.getRsiPivotStMode ? sss.getRsiPivotStMode() : null;
    _simple930Mode = sss.getSimple930Mode ? sss.getSimple930Mode() : null;
    _anyTradeActive = sss.isAnyActive ? sss.isAnyActive() : false;
  } catch (_) {}

  // Hide Replay while any paper/live trade is running — Replay cannot run with a
  // live session anyway (it blocks on running modes), so keep the menu clean.
  const _hideReplayLive = _anyTradeActive;

  // The footer pill is global chrome, not per-page state: while any strategy
  // session is live it must read RUNNING whatever page you are on (Dashboard,
  // Logs, Settings... none of which pass isRunning). Pages that own a session
  // still pass it, so their own Start/Stop flips the pill in the same response.
  const sessionRunning = isRunning || _anyTradeActive;

  const {
    showStopBtn  = false,
    showStartBtn = false,
    showExitBtn  = false,
    stopBtnJs    = '',
    startBtnJs   = '',
    exitBtnJs    = '',
    stopLabel    = '■ Stop Trading',
    startLabel   = '▶ Start Trading',
    exitLabel    = '🚪 Exit Trade',
    statusLabel  = sessionRunning ? 'RUNNING' : 'STOPPED',
  } = opts;

  const emaRsiStModeOn    = (process.env.EMA_RSI_ST_MODE_ENABLED    || 'true').toLowerCase() === 'true';
  const bbRsiModeOn    = (process.env.BB_RSI_MODE_ENABLED    || 'true').toLowerCase() === 'true';
  const paModeOn       = (process.env.PA_MODE_ENABLED       || 'true').toLowerCase() === 'true';
  const orbModeOn      = (process.env.ORB_MODE_ENABLED      || 'true').toLowerCase() === 'true';
  const ema9vwapModeOn = (process.env.EMA9VWAP_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const trendPbModeOn  = (process.env.TREND_PB_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const gapsModeOn     = (process.env.GAPS_MODE_ENABLED     || 'true').toLowerCase() === 'true';
  const tdsModeOn      = (process.env.TDS_MODE_ENABLED      || 'true').toLowerCase() === 'true';
  const gap3mModeOn    = (process.env.GAP3M_MODE_ENABLED    || 'true').toLowerCase() === 'true';
  const oiwfModeOn     = (process.env.OIWF_MODE_ENABLED     || 'true').toLowerCase() === 'true';
  const rsiPivotStModeOn = (process.env.RSI_PIVOT_ST_MODE_ENABLED || 'true').toLowerCase() === 'true';
  const simple930ModeOn = (process.env.SIMPLE930_MODE_ENABLED || 'true').toLowerCase() === 'true';

  // ── Per-module menu-visibility toggles (managed from Settings page) ──
  const showSim      = (process.env.UI_SHOW_SIMULATE || 'false').toLowerCase() === 'true';
  const showCompare  = (process.env.UI_SHOW_COMPARE  || 'false').toLowerCase() === 'true';
  const showTracker  = (process.env.UI_SHOW_TRACKER  || 'false').toLowerCase() === 'true';

  // ── Top-level menu-visibility toggles ──
  const showDashboard   = (process.env.UI_SHOW_DASHBOARD     || 'false').toLowerCase() === 'true';
  const showAllBacktest = (process.env.UI_SHOW_ALL_BACKTEST  || 'true').toLowerCase()  === 'true';
  const showReplay      = (process.env.UI_SHOW_REPLAY        || 'true').toLowerCase()  === 'true' && !_hideReplayLive;
  const showPaperHist   = (process.env.UI_SHOW_PAPER_HISTORY || 'true').toLowerCase()  === 'true';
  const showLiveHist    = (process.env.UI_SHOW_LIVE_HISTORY  || 'true').toLowerCase()  === 'true';
  const showEdgeAnalytics = (process.env.UI_SHOW_EDGE_ANALYTICS || 'true').toLowerCase() === 'true';
  const showAdvisor       = (process.env.UI_SHOW_ADVISOR || 'true').toLowerCase() === 'true';
  // Read-only research page for per-strike OI. Default OFF — it is a data-collection
  // instrument for an unbuilt strategy, not part of the daily trading flow.
  const showOiMonitor     = (process.env.UI_SHOW_OI_MONITOR || 'false').toLowerCase() === 'true';
  // Swing Scanner — stock screen + manual positional entry. Default OFF: it is
  // the one page in this app that can place a REAL order with no dry-run gate,
  // so it should appear because someone switched it on, not by default.
  const showSwingScanner  = (process.env.UI_SHOW_SWING_SCANNER || 'false').toLowerCase() === 'true';

  // ── Per-strategy submenu toggles ──
  const showEmaRsiStBacktest = (process.env.UI_SHOW_EMA_RSI_ST_BACKTEST || 'true').toLowerCase() === 'true';
  const showEmaRsiStPaper    = (process.env.UI_SHOW_EMA_RSI_ST_PAPER    || 'true').toLowerCase() === 'true';
  const showEmaRsiStLive     = (process.env.UI_SHOW_EMA_RSI_ST_LIVE     || 'true').toLowerCase() === 'true';
  const showEmaRsiStLiveHarness = (process.env.UI_SHOW_EMA_RSI_ST_LIVE_HARNESS || 'false').toLowerCase() === 'true';
  const showBbRsiBacktest = (process.env.UI_SHOW_BB_RSI_BACKTEST || 'true').toLowerCase() === 'true';
  const showBbRsiPaper    = (process.env.UI_SHOW_BB_RSI_PAPER    || 'true').toLowerCase() === 'true';
  const showBbRsiLive     = (process.env.UI_SHOW_BB_RSI_LIVE     || 'true').toLowerCase() === 'true';
  const showBbRsiLiveHarness = (process.env.UI_SHOW_BB_RSI_LIVE_HARNESS || 'false').toLowerCase() === 'true';
  const showPaBacktest        = (process.env.UI_SHOW_PA_BACKTEST         || 'true').toLowerCase() === 'true';
  const showPaPatternBacktest = (process.env.UI_SHOW_PA_PATTERN_BACKTEST || 'true').toLowerCase() === 'true';
  const showPaPaper           = (process.env.UI_SHOW_PA_PAPER            || 'true').toLowerCase() === 'true';
  const showPaLive            = (process.env.UI_SHOW_PA_LIVE             || 'true').toLowerCase() === 'true';
  const showPaLiveHarness     = (process.env.UI_SHOW_PA_LIVE_HARNESS     || 'false').toLowerCase() === 'true';
  const showOrbBacktest       = (process.env.UI_SHOW_ORB_BACKTEST         || 'true').toLowerCase() === 'true';
  const showOrbPaper          = (process.env.UI_SHOW_ORB_PAPER            || 'true').toLowerCase() === 'true';
  const showOrbLive           = (process.env.UI_SHOW_ORB_LIVE             || 'true').toLowerCase() === 'true';
  const showOrbLiveHarness    = (process.env.UI_SHOW_ORB_LIVE_HARNESS     || 'false').toLowerCase() === 'true';
  const showOrbHistory        = (process.env.UI_SHOW_ORB_HISTORY          || 'true').toLowerCase() === 'true';
  const showEma9vwapBacktest  = (process.env.UI_SHOW_EMA9VWAP_BACKTEST    || 'true').toLowerCase() === 'true';
  const showEma9vwapPaper     = (process.env.UI_SHOW_EMA9VWAP_PAPER       || 'true').toLowerCase() === 'true';
  const showEma9vwapLive      = (process.env.UI_SHOW_EMA9VWAP_LIVE        || 'true').toLowerCase() === 'true';
  const showEma9vwapHistory   = (process.env.UI_SHOW_EMA9VWAP_HISTORY     || 'true').toLowerCase() === 'true';
  // Trend Pullback — Paper + History + Backtest live now; Live default hidden until Phase C.
  const showTrendPbBacktest    = (process.env.UI_SHOW_TREND_PB_BACKTEST     || 'true').toLowerCase()  === 'true';
  const showTrendPbPaper       = (process.env.UI_SHOW_TREND_PB_PAPER        || 'true').toLowerCase()  === 'true';
  const showTrendPbLive        = (process.env.UI_SHOW_TREND_PB_LIVE         || 'true').toLowerCase()  === 'true';
  const showTrendPbHistory     = (process.env.UI_SHOW_TREND_PB_HISTORY      || 'true').toLowerCase()  === 'true';
  const showGapsBacktest      = (process.env.UI_SHOW_GAPS_BACKTEST         || 'true').toLowerCase()  === 'true';
  const showGapsPaper         = (process.env.UI_SHOW_GAPS_PAPER            || 'true').toLowerCase()  === 'true';
  const showGapsLive          = (process.env.UI_SHOW_GAPS_LIVE             || 'true').toLowerCase()  === 'true';
  const showGapsHistory       = (process.env.UI_SHOW_GAPS_HISTORY          || 'true').toLowerCase()  === 'true';
  // Trend Day Scalp — never traded; ships visible but its Live page is triple-gated to dry-run.
  const showTdsBacktest       = (process.env.UI_SHOW_TDS_BACKTEST          || 'true').toLowerCase()  === 'true';
  const showTdsPaper          = (process.env.UI_SHOW_TDS_PAPER             || 'true').toLowerCase()  === 'true';
  const showTdsLive           = (process.env.UI_SHOW_TDS_LIVE              || 'true').toLowerCase()  === 'true';
  const showTdsHistory        = (process.env.UI_SHOW_TDS_HISTORY           || 'true').toLowerCase()  === 'true';
  // 3M Gap Fix Scalp — never traded; ships visible but its Live page is triple-gated to dry-run.
  const showGap3mBacktest     = (process.env.UI_SHOW_GAP3M_BACKTEST        || 'true').toLowerCase()  === 'true';
  const showGap3mPaper        = (process.env.UI_SHOW_GAP3M_PAPER           || 'true').toLowerCase()  === 'true';
  const showGap3mLive         = (process.env.UI_SHOW_GAP3M_LIVE            || 'true').toLowerCase()  === 'true';
  const showGap3mHistory      = (process.env.UI_SHOW_GAP3M_HISTORY         || 'true').toLowerCase()  === 'true';
  // OI Wall Fade — never traded and NOT backtestable (no historical per-strike OI), so there is no Backtest entry.
  const showOiwfPaper         = (process.env.UI_SHOW_OIWF_PAPER            || 'true').toLowerCase()  === 'true';
  const showOiwfLive          = (process.env.UI_SHOW_OIWF_LIVE             || 'true').toLowerCase()  === 'true';
  const showOiwfHistory       = (process.env.UI_SHOW_OIWF_HISTORY          || 'true').toLowerCase()  === 'true';
  // RSI Pivot ST — never traded; ships visible but its Live page is triple-gated to dry-run.
  const showRsiPivotStBacktest = (process.env.UI_SHOW_RSI_PIVOT_ST_BACKTEST || 'true').toLowerCase()  === 'true';
  const showRsiPivotStPaper    = (process.env.UI_SHOW_RSI_PIVOT_ST_PAPER    || 'true').toLowerCase()  === 'true';
  const showRsiPivotStLive     = (process.env.UI_SHOW_RSI_PIVOT_ST_LIVE     || 'true').toLowerCase()  === 'true';
  const showRsiPivotStHistory  = (process.env.UI_SHOW_RSI_PIVOT_ST_HISTORY  || 'true').toLowerCase()  === 'true';
  // SIMPLE_9:30 — never traded; ships visible but its Live page is triple-gated to dry-run.
  const showSimple930Backtest = (process.env.UI_SHOW_SIMPLE930_BACKTEST    || 'true').toLowerCase()  === 'true';
  const showSimple930Paper    = (process.env.UI_SHOW_SIMPLE930_PAPER       || 'true').toLowerCase()  === 'true';
  const showSimple930Live     = (process.env.UI_SHOW_SIMPLE930_LIVE        || 'true').toLowerCase()  === 'true';
  const showSimple930History  = (process.env.UI_SHOW_SIMPLE930_HISTORY     || 'true').toLowerCase()  === 'true';

  // ── System submenu toggles (Settings is always shown) ──
  const showTradeLogs  = (process.env.UI_SHOW_TRADE_LOGS  || 'true').toLowerCase() === 'true';
  const showTokenSync  = (process.env.UI_SHOW_TOKEN_SYNC  || 'true').toLowerCase() === 'true';

  // Determine which collapsible group the active page belongs to
  const tradingKeys = ['emaRsiStBacktest', 'emaRsiStPaper', 'emaRsiStSim', 'emaRsiStHistory', 'emaRsiStCompare', 'emaRsiStTracker', 'emaRsiStLive', 'emaRsiStLiveHarness'];
  const bbRsiKeys   = ['bbRsiBacktest', 'bbRsiPaper', 'bbRsiSim', 'bbRsiHistory', 'bbRsiCompare', 'bbRsiLive', 'bbRsiLiveHarness'];
  const paKeys      = ['paBacktest', 'paPatternBacktest', 'paPaper', 'paSim', 'paHistory', 'paCompare', 'paLive', 'paLiveHarness'];
  const orbKeys     = ['orbBacktest', 'orbPaper', 'orbLive', 'orbLiveHarness', 'orbHistory'];
  const ema9vwapKeys = ['ema9vwapBacktest', 'ema9vwapPaper', 'ema9vwapSim', 'ema9vwapLive', 'ema9vwapHistory'];
  const trendPbKeys = ['trendPbBacktest', 'trendPbPaper', 'trendPbLive', 'trendPbLiveHarness', 'trendPbHistory'];
  const gapsKeys    = ['gapsBacktest', 'gapsPaper', 'gapsLive', 'gapsHistory'];
  const tdsKeys     = ['trendDayScalpBacktest', 'trendDayScalpPaper', 'trendDayScalpLive', 'trendDayScalpHistory'];
  const gap3mKeys   = ['gapFix3mBacktest', 'gapFix3mPaper', 'gapFix3mLive', 'gapFix3mHistory'];
  const oiwfKeys    = ['oiWallFadePaper', 'oiWallFadeLive', 'oiWallFadeHistory'];
  const rsiPivotStKeys = ['rsiPivotStBacktest', 'rsiPivotStPaper', 'rsiPivotStLive', 'rsiPivotStHistory'];
  const simple930Keys = ['simple930Backtest', 'simple930Paper', 'simple930Live', 'simple930History'];

  const isTradingOpen  = tradingKeys.includes(activePage);
  const isBbRsiOpen    = bbRsiKeys.includes(activePage);
  const isPAOpen       = paKeys.includes(activePage);
  const isOrbOpen      = orbKeys.includes(activePage);
  const isEma9vwapOpen = ema9vwapKeys.includes(activePage);
  const isTrendPbOpen  = trendPbKeys.includes(activePage);
  const isGapsOpen     = gapsKeys.includes(activePage);
  const isTdsOpen      = tdsKeys.includes(activePage);
  const isGap3mOpen    = gap3mKeys.includes(activePage);
  const isOiwfOpen     = oiwfKeys.includes(activePage);
  const isRsiPivotStOpen = rsiPivotStKeys.includes(activePage);
  const isSimple930Open = simple930Keys.includes(activePage);

  // When a strategy's PAPER session is running, hide its Live / Live (Harness)
  // entries — paper and live are mutually exclusive per strategy, so the live
  // menu items are dead links during a paper session.
  const emaRsiStPaperRunning    = _primaryMode  === 'EMA_RSI_ST_PAPER';
  const bbRsiPaperRunning    = _bbRsiMode    === 'BB_RSI_PAPER';
  const paPaperRunning       = _paMode       === 'PA_PAPER';
  const orbPaperRunning      = _orbMode      === 'ORB_PAPER';
  const ema9vwapPaperRunning = _ema9vwapMode === 'EMA9VWAP_PAPER';
  const trendPbPaperRunning  = _trendPbMode  === 'TREND_PB_PAPER';
  const gapsPaperRunning     = _gapsMode     === 'GAPS_PAPER';
  const tdsPaperRunning      = _trendDayScalpMode === 'TREND_DAY_SCALP_PAPER';
  const gap3mPaperRunning    = _gapFix3mMode === 'GAP_FIX_3M_PAPER';
  const oiwfPaperRunning     = _oiWallFadeMode === 'OI_WALL_FADE_PAPER';
  const rsiPivotStPaperRunning = _rsiPivotStMode === 'RSI_PIVOT_ST_PAPER';
  const simple930PaperRunning = _simple930Mode === 'SIMPLE930_PAPER';

  // Build a ema_rsi_st items list with per-feature toggle
  const emaRsiStItems = [
    ...(showEmaRsiStBacktest ? [{ key: 'emaRsiStBacktest', href: '/ema_rsi_st-backtest',       icon: '🔍', label: 'Backtest' }] : []),
    ...(showEmaRsiStPaper    ? [{ key: 'emaRsiStPaper',    href: '/ema_rsi_st-paper/status',   icon: '📋', label: 'Paper'    }] : []),
    ...(showSim      ? [{ key: 'emaRsiStSim',     href: '/ema_rsi_st-paper/simulate', icon: '🎮', label: 'Simulate' }] : []),
    ...(showCompare  ? [{ key: 'emaRsiStCompare', href: '/compare/trading',      icon: '⚖',  label: 'Compare'  }] : []),
    ...(showTracker  ? [{ key: 'emaRsiStTracker', href: '/tracker/status',       icon: '🎯', label: 'Tracker'  }] : []),
    ...(showEmaRsiStLive && !emaRsiStPaperRunning ? [{ key: 'emaRsiStLive',     href: '/ema_rsi_st-live/status',    icon: '●',  label: 'Live'     }] : []),
    ...(showEmaRsiStLiveHarness && !emaRsiStPaperRunning ? [{ key: 'emaRsiStLiveHarness', href: '/ema_rsi_st-live-harness', icon: '🔧', label: 'Live (Harness)' }] : []),
  ];

  const bbRsiItems = [
    ...(showBbRsiBacktest ? [{ key: 'bbRsiBacktest', href: '/bb_rsi-backtest',     icon: '⚡', label: 'Backtest' }] : []),
    ...(showBbRsiPaper    ? [{ key: 'bbRsiPaper',    href: '/bb_rsi-paper/status', icon: '⚡', label: 'Paper'    }] : []),
    ...(showSim     ? [{ key: 'bbRsiSim',     href: '/bb_rsi-paper/simulate', icon: '🎮', label: 'Simulate' }] : []),
    ...(showCompare ? [{ key: 'bbRsiCompare', href: '/compare/bb_rsi',     icon: '⚖',  label: 'Compare'  }] : []),
    ...(showBbRsiLive && !bbRsiPaperRunning ? [{ key: 'bbRsiLive',     href: '/bb_rsi-live/status',  icon: '⚡', label: 'Live'     }] : []),
    ...(showBbRsiLiveHarness && !bbRsiPaperRunning ? [{ key: 'bbRsiLiveHarness', href: '/bb_rsi-live-harness', icon: '🔧', label: 'Live (Harness)' }] : []),
  ];

  const paItems = [
    ...(showPaBacktest        ? [{ key: 'paBacktest',        href: '/pa-backtest',         icon: '📐', label: 'Backtest' }] : []),
    ...(showPaPatternBacktest ? [{ key: 'paPatternBacktest', href: '/pa-pattern-backtest', icon: '△',  label: 'Pattern Test' }] : []),
    ...(showPaPaper           ? [{ key: 'paPaper',           href: '/pa-paper/status',     icon: '📐', label: 'Paper'    }] : []),
    ...(showSim     ? [{ key: 'paSim',     href: '/pa-paper/simulate',   icon: '🎮', label: 'Simulate' }] : []),
    // No PA Compare entry: compare.js only implements /trading (EMA_RSI_ST) and
    // /bb_rsi. The old '/compare/priceaction' link had no route behind it, so with
    // UI_SHOW_COMPARE=true it was a dead menu item.
    ...(showPaLive && !paPaperRunning ? [{ key: 'paLive',            href: '/pa-live/status',      icon: '📐', label: 'Live'     }] : []),
    ...(showPaLiveHarness && !paPaperRunning ? [{ key: 'paLiveHarness',     href: '/pa-live-harness',     icon: '🔧', label: 'Live (Harness)' }] : []),
  ];

  const orbItems = [
    ...(showOrbBacktest ? [{ key: 'orbBacktest', href: '/orb-backtest',      icon: '🔍', label: 'Backtest' }] : []),
    ...(showOrbPaper    ? [{ key: 'orbPaper',    href: '/orb-paper/status',  icon: '📋', label: 'Paper'   }] : []),
    ...(showOrbLive && !orbPaperRunning ? [{ key: 'orbLive',     href: '/orb-live/status',   icon: '📡', label: 'Live'    }] : []),
    ...(showOrbLiveHarness && !orbPaperRunning ? [{ key: 'orbLiveHarness', href: '/orb-live-harness', icon: '🔧', label: 'Live (Harness)' }] : []),
    ...(showOrbHistory  ? [{ key: 'orbHistory',  href: '/orb-paper/history', icon: '📜', label: 'History' }] : []),
  ];

  const ema9vwapItems = [
    ...(showEma9vwapBacktest ? [{ key: 'ema9vwapBacktest', href: '/ema9vwap-backtest',     icon: '🔍', label: 'Backtest' }] : []),
    ...(showEma9vwapPaper    ? [{ key: 'ema9vwapPaper',    href: '/ema9vwap-paper/status', icon: '📋', label: 'Paper'    }] : []),
    ...(showSim         ? [{ key: 'ema9vwapSim',     href: '/ema9vwap-paper/simulate', icon: '🎮', label: 'Simulate' }] : []),
    ...(showEma9vwapLive && !ema9vwapPaperRunning ? [{ key: 'ema9vwapLive', href: '/ema9vwap-live', icon: '●', label: 'Live' }] : []),
    ...(showEma9vwapHistory  ? [{ key: 'ema9vwapHistory',  href: '/ema9vwap-paper/history', icon: '📜', label: 'History' }] : []),
  ];

  const trendPbItems = [
    ...(showTrendPbBacktest ? [{ key: 'trendPbBacktest', href: '/trend-pb-backtest',      icon: '🔍', label: 'Backtest' }] : []),
    ...(showTrendPbPaper    ? [{ key: 'trendPbPaper',    href: '/trend-pb-paper/status',  icon: '📈', label: 'Paper'   }] : []),
    ...(showTrendPbLive && !trendPbPaperRunning ? [{ key: 'trendPbLive', href: '/trend-pb-live', icon: '📡', label: 'Live' }] : []),
    ...(showTrendPbHistory  ? [{ key: 'trendPbHistory',  href: '/trend-pb-paper/history', icon: '📜', label: 'History' }] : []),
  ];

  const gapsItems = [
    ...(showGapsBacktest ? [{ key: 'gapsBacktest', href: '/gaps-backtest',      icon: '🔍', label: 'Backtest' }] : []),
    ...(showGapsPaper    ? [{ key: 'gapsPaper',    href: '/gaps-paper/status',  icon: '🕳', label: 'Paper'   }] : []),
    ...(showGapsLive && !gapsPaperRunning ? [{ key: 'gapsLive', href: '/gaps-live', icon: '📡', label: 'Live' }] : []),
    ...(showGapsHistory  ? [{ key: 'gapsHistory',  href: '/gaps-paper/history', icon: '📜', label: 'History' }] : []),
  ];

  const tdsItems = [
    ...(showTdsBacktest ? [{ key: 'trendDayScalpBacktest', href: '/trend-day-scalp-backtest',     icon: '🔍', label: 'Backtest' }] : []),
    ...(showTdsPaper    ? [{ key: 'trendDayScalpPaper',    href: '/trend-day-scalp-paper/status', icon: '⚡', label: 'Paper'    }] : []),
    ...(showTdsLive && !tdsPaperRunning ? [{ key: 'trendDayScalpLive', href: '/trend-day-scalp-live', icon: '📡', label: 'Live' }] : []),
    ...(showTdsHistory  ? [{ key: 'trendDayScalpHistory',  href: '/trend-day-scalp-paper/history', icon: '📜', label: 'History' }] : []),
  ];

  const gap3mItems = [
    ...(showGap3mBacktest ? [{ key: 'gapFix3mBacktest', href: '/gap-fix-3m-backtest',     icon: '🔍', label: 'Backtest' }] : []),
    ...(showGap3mPaper    ? [{ key: 'gapFix3mPaper',    href: '/gap-fix-3m-paper/status', icon: '🕳', label: 'Paper'    }] : []),
    ...(showGap3mLive && !gap3mPaperRunning ? [{ key: 'gapFix3mLive', href: '/gap-fix-3m-live', icon: '📡', label: 'Live' }] : []),
    ...(showGap3mHistory  ? [{ key: 'gapFix3mHistory',  href: '/gap-fix-3m-paper/history', icon: '📜', label: 'History' }] : []),
  ];

  // No Backtest entry: Fyers exposes no historical per-strike OI, so this
  // strategy cannot be simulated over past sessions and never will be.
  const oiwfItems = [
    ...(showOiwfPaper   ? [{ key: 'oiWallFadePaper',   href: '/oi-wall-fade-paper/status', icon: '🧱', label: 'Paper'   }] : []),
    ...(showOiwfLive && !oiwfPaperRunning ? [{ key: 'oiWallFadeLive', href: '/oi-wall-fade-live', icon: '📡', label: 'Live' }] : []),
    ...(showOiwfHistory ? [{ key: 'oiWallFadeHistory', href: '/oi-wall-fade-paper/history', icon: '📜', label: 'History' }] : []),
  ];

  const rsiPivotStItems = [
    ...(showRsiPivotStBacktest ? [{ key: 'rsiPivotStBacktest', href: '/rsi-pivot-st-backtest',     icon: '🔍', label: 'Backtest' }] : []),
    ...(showRsiPivotStPaper    ? [{ key: 'rsiPivotStPaper',    href: '/rsi-pivot-st-paper/status', icon: '🎯', label: 'Paper'    }] : []),
    ...(showRsiPivotStLive && !rsiPivotStPaperRunning ? [{ key: 'rsiPivotStLive', href: '/rsi-pivot-st-live', icon: '📡', label: 'Live' }] : []),
    ...(showRsiPivotStHistory  ? [{ key: 'rsiPivotStHistory',  href: '/rsi-pivot-st-paper/history', icon: '📜', label: 'History' }] : []),
  ];

  const simple930Items = [
    ...(showSimple930Backtest ? [{ key: 'simple930Backtest', href: '/simple930-backtest',     icon: '🔍', label: 'Backtest' }] : []),
    ...(showSimple930Paper    ? [{ key: 'simple930Paper',    href: '/simple930-paper/status', icon: '🎯', label: 'Paper'    }] : []),
    ...(showSimple930Live && !simple930PaperRunning ? [{ key: 'simple930Live', href: '/simple930-live', icon: '📡', label: 'Live' }] : []),
    ...(showSimple930History  ? [{ key: 'simple930History',  href: '/simple930-paper/history', icon: '📜', label: 'History' }] : []),
  ];

  // ── Grouped navigation sections (collapsible) ──
  const topLevelItems = [
    ...(showDashboard   ? [{ key: 'dashboard',         href: '/',                   icon: '⌂',  label: 'Dashboard' }] : []),
    ...(showAllBacktest ? [{ key: 'allBacktest',       href: '/all-backtest',       icon: '⏺',  label: 'Backtest' }] : []),
    ...(showReplay      ? [{ key: 'replay',            href: '/replay',             icon: '📼', label: 'Replay' }] : []),
    ...(showPaperHist   ? [{ key: 'consolidation',     href: '/consolidation',      icon: '🧾', label: 'Paper Traded History' }] : []),
    ...(showLiveHist    ? [{ key: 'liveConsolidation', href: '/live-consolidation', icon: '🔴', label: 'Live Traded History' }] : []),
    ...(showEdgeAnalytics ? [{ key: 'edgeAnalytics',   href: '/edge-analytics',     icon: '📈', label: 'Edge Analytics' }] : []),
    ...(showAdvisor       ? [{ key: 'advisor',         href: '/advisor',            icon: '🧭', label: 'Settings Advisor' }] : []),
    ...(showOiMonitor     ? [{ key: 'oi-monitor',      href: '/oi-monitor',         icon: '🧱', label: 'OI Monitor' }] : []),
    ...(showSwingScanner  ? [{ key: 'swingScanner',     href: '/swing-scanner',      icon: '📈', label: 'Swing Scanner' }] : []),
  ];

  const sections = [
    ...(topLevelItems.length ? [{
      header: null, collapsible: false,
      items: topLevelItems,
    }] : []),
    ...(emaRsiStModeOn ? [{
      header: 'EMA_RSI_ST', collapsible: true, collapsed: !isTradingOpen,
      groupId: 'nav-ema_rsi_st',
      items: emaRsiStItems,
    }] : []),
    ...(bbRsiModeOn ? [{
      header: 'BB_RSI', collapsible: true, collapsed: !isBbRsiOpen,
      groupId: 'nav-bb_rsi',
      items: bbRsiItems,
    }] : []),
    ...(paModeOn ? [{
      header: 'PRICE ACTION', collapsible: true, collapsed: !isPAOpen,
      groupId: 'nav-pa',
      items: paItems,
    }] : []),
    ...(orbModeOn ? [{
      header: 'ORB', collapsible: true, collapsed: !isOrbOpen,
      groupId: 'nav-orb',
      items: orbItems,
    }] : []),
    ...(ema9vwapModeOn ? [{
      header: 'EMA9+VWAP', collapsible: true, collapsed: !isEma9vwapOpen,
      groupId: 'nav-ema9vwap',
      items: ema9vwapItems,
    }] : []),
    ...(trendPbModeOn ? [{
      header: 'TREND PULLBACK', collapsible: true, collapsed: !isTrendPbOpen,
      groupId: 'nav-trend-pb',
      items: trendPbItems,
    }] : []),
    ...(gapsModeOn ? [{
      header: 'GAPS', collapsible: true, collapsed: !isGapsOpen,
      groupId: 'nav-gaps',
      items: gapsItems,
    }] : []),
    ...(tdsModeOn ? [{
      header: 'TREND DAY SCALP', collapsible: true, collapsed: !isTdsOpen,
      groupId: 'nav-trend-day-scalp',
      items: tdsItems,
    }] : []),
    ...(gap3mModeOn ? [{
      header: '3M GAP FIX SCALP', collapsible: true, collapsed: !isGap3mOpen,
      groupId: 'nav-gap-fix-3m',
      items: gap3mItems,
    }] : []),
    ...(oiwfModeOn ? [{
      header: 'OI WALL FADE', collapsible: true, collapsed: !isOiwfOpen,
      groupId: 'nav-oi-wall-fade',
      items: oiwfItems,
    }] : []),
    ...(rsiPivotStModeOn ? [{
      header: 'RSI PIVOT ST', collapsible: true, collapsed: !isRsiPivotStOpen,
      groupId: 'nav-rsi-pivot-st',
      items: rsiPivotStItems,
    }] : []),
    ...(simple930ModeOn ? [{
      header: 'SIMPLE 9:30', collapsible: true, collapsed: !isSimple930Open,
      groupId: 'nav-simple930',
      items: simple930Items,
    }] : []),
    {
      header: 'SYSTEM', collapsible: false,
      items: [
        ...(showTradeLogs  ? [{ key: 'tradeLogs',  href: '/trade-logs',  icon: '🗂', label: 'Logs' }] : []),
        // Login Logs, Server Logs (📜 LOGS) and Cache Files now live as tabs inside the Logs (/trade-logs) page.
        ...(showTokenSync  ? [{ key: 'tokenSync',  href: '/token-sync',  icon: '🔑', label: 'Token Sync' }] : []),
        { key: 'settings',   href: '/settings',    icon: '⚙',  label: 'Settings'   },
      ]
    },
  ];

  // Block all backtest & paper (trading + bb_rsi + PA) when ANY live mode is active
  const anyLiveActive = liveActive || _bbRsiMode === 'BB_RSI_LIVE' || _paMode === 'PA_LIVE';
  const blocked = anyLiveActive ? ['allBacktest', 'emaRsiStBacktest', 'emaRsiStPaper', 'bbRsiBacktest', 'bbRsiPaper', 'paBacktest', 'paPatternBacktest', 'paPaper'] : [];

  function renderItem(p) {
    const isActive   = p.key === activePage;
    const isDisabled = blocked.includes(p.key);

    if (isDisabled) {
      return `<span class="sb-nav-item disabled" title="Disabled — Live trading is active">
        <span class="sb-nav-icon">${p.icon}</span> ${p.label}
        <span class="sb-nav-badge" style="margin-left:auto;font-size:0.5rem;">🔒</span>
      </span>`;
    }

    const liveBadge = p.key === 'emaRsiStLive' && liveActive
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const runningBadge = p.key === 'emaRsiStPaper' && (_primaryMode === 'EMA_RSI_ST_PAPER' || isRunning)
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const bbRsiLiveBadge = p.key === 'bbRsiLive' && _bbRsiMode === 'BB_RSI_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const bbRsiPaperBadge = p.key === 'bbRsiPaper' && _bbRsiMode === 'BB_RSI_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const paLiveBadge = p.key === 'paLive' && _paMode === 'PA_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const paPaperBadge = p.key === 'paPaper' && _paMode === 'PA_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    // ORB has a NATIVE live route (/orb-live sets ORB_LIVE in sharedSocketState),
    // so it needs the same LIVE badge bb_rsi and PA get — without it an ORB live
    // session placing real Fyers orders was the only one invisible in the sidebar.
    const orbLiveBadge = p.key === 'orbLive' && _orbMode === 'ORB_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const orbPaperBadge = p.key === 'orbPaper' && _orbMode === 'ORB_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const gapsLiveBadge = p.key === 'gapsLive' && _gapsMode === 'GAPS_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const gapsPaperBadge = p.key === 'gapsPaper' && _gapsMode === 'GAPS_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const tdsLiveBadge = p.key === 'trendDayScalpLive' && _trendDayScalpMode === 'TREND_DAY_SCALP_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const tdsPaperBadge = p.key === 'trendDayScalpPaper' && _trendDayScalpMode === 'TREND_DAY_SCALP_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const gap3mLiveBadge = p.key === 'gapFix3mLive' && _gapFix3mMode === 'GAP_FIX_3M_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const gap3mPaperBadge = p.key === 'gapFix3mPaper' && _gapFix3mMode === 'GAP_FIX_3M_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const oiwfLiveBadge = p.key === 'oiWallFadeLive' && _oiWallFadeMode === 'OI_WALL_FADE_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const oiwfPaperBadge = p.key === 'oiWallFadePaper' && _oiWallFadeMode === 'OI_WALL_FADE_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const rsiPivotStLiveBadge = p.key === 'rsiPivotStLive' && _rsiPivotStMode === 'RSI_PIVOT_ST_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const rsiPivotStPaperBadge = p.key === 'rsiPivotStPaper' && _rsiPivotStMode === 'RSI_PIVOT_ST_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    const simple930LiveBadge = p.key === 'simple930Live' && _simple930Mode === 'SIMPLE930_LIVE'
      ? `<span class="sb-nav-badge live">LIVE</span>`
      : '';

    const simple930PaperBadge = p.key === 'simple930Paper' && _simple930Mode === 'SIMPLE930_PAPER'
      ? `<span class="sb-nav-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);">ON</span>`
      : '';

    return `<a href="${p.href}" class="sb-nav-item${isActive ? ' active' : ''}">
      <span class="sb-nav-icon">${p.icon}</span> ${p.label}
      ${liveBadge}${runningBadge}${bbRsiLiveBadge}${bbRsiPaperBadge}${paLiveBadge}${paPaperBadge}${orbLiveBadge}${orbPaperBadge}${gapsLiveBadge}${gapsPaperBadge}${tdsLiveBadge}${tdsPaperBadge}${gap3mLiveBadge}${gap3mPaperBadge}${oiwfLiveBadge}${oiwfPaperBadge}${rsiPivotStLiveBadge}${rsiPivotStPaperBadge}${simple930LiveBadge}${simple930PaperBadge}
    </a>`;
  }

  const navItems = sections.map(section => {
    const items = section.items.map(renderItem).join('');
    if (section.collapsible && section.header) {
      const gid = section.groupId || 'nav-' + section.header.toLowerCase().replace(/\s+/g, '-');
      const collapsed = section.collapsed ? ' collapsed' : '';
      return `<div class="sb-section">
        <div class="sb-section-header sb-collapsible${collapsed}" onclick="toggleNavGroup('${gid}')" data-group="${gid}">
          <span>${section.header}</span>
          <span class="sb-chevron">${section.collapsed ? '›' : '‹'}</span>
        </div>
        <div class="sb-group-items${collapsed}" id="${gid}">${items}</div>
      </div>`;
    }
    const header = section.header
      ? `<div class="sb-section-header">${section.header}</div>`
      : '';
    return `<div class="sb-section">${header}${items}</div>`;
  }).join('');

  const bottomBtns = [
    showExitBtn  ? `<button onclick="${exitBtnJs}"  class="sb-action-btn sb-exit-btn">${exitLabel}</button>`  : '',
    showStopBtn  ? `<button onclick="${stopBtnJs}"  class="sb-action-btn sb-stop-btn">${stopLabel}</button>`  : '',
    showStartBtn ? `<button onclick="${startBtnJs}" class="sb-action-btn sb-start-btn">${startLabel}</button>` : '',
  ].filter(Boolean).join('\n');

  return `
<button class="hamburger" onclick="toggleSidebar()" aria-label="Menu" style="display:none;">
  <span></span><span></span><span></span>
</button>
<div class="sidebar-overlay" id="sb-overlay" onclick="closeSidebar()"></div>
<nav class="sidebar" id="main-sidebar">
  <div class="sb-brand">
    <div class="sb-brand-name">ௐ Palani Andawar Thunai ॐ</div>
    <div class="sb-brand-sub">TRADING BOT</div>
  </div>
  <div class="sb-nav">
    ${navItems}
  </div>
  <div class="sb-bottom">
    <div class="sb-status-row">
      <span class="sb-status-dot ${sessionRunning ? '' : 'stopped'}"></span>
      ${statusLabel}
    </div>
    ${bottomBtns}
    ${process.env.LOGIN_SECRET ? '<a href="/logout" class="sb-nav-item" style="margin-top:6px;font-size:0.62rem;color:var(--muted-1,#8ba1c2);justify-content:center;padding:5px;"><span class="sb-nav-icon">🔓</span> Logout</a>' : ''}
  </div>
</nav>
<div class="deploy-chip" id="deploy-chip" style="display:none;">
  <span class="deploy-chip-dot" id="deploy-chip-dot"></span>
  <span id="deploy-chip-label"></span>
</div>
<div id="socket-broken-banner" role="alert" style="display:none;position:fixed;top:0;left:0;right:0;z-index:99999;background:#7f1d1d;color:#fff;font-family:'IBM Plex Mono',monospace;font-size:0.82rem;font-weight:600;padding:10px 16px;text-align:center;border-bottom:2px solid #ef4444;box-shadow:0 4px 16px rgba(0,0,0,0.4);">
  <span id="socket-broken-msg">⚠️ Broker socket disconnected</span>
  <a href="/auth/login" style="color:#fff;text-decoration:underline;margin-left:14px;font-weight:700;">Re-login →</a>
  <button onclick="document.getElementById('socket-broken-banner').style.display='none';" aria-label="Dismiss" style="margin-left:14px;background:transparent;border:1px solid rgba(255,255,255,0.4);color:#fff;padding:2px 9px;border-radius:4px;font-family:inherit;font-size:0.7rem;cursor:pointer;">Dismiss</button>
</div>
<div id="telegram-broken-banner" role="alert" style="display:none;position:fixed;top:0;left:0;right:0;z-index:99997;background:#78350f;color:#fff;font-family:'IBM Plex Mono',monospace;font-size:0.8rem;font-weight:600;padding:9px 16px;text-align:center;border-bottom:2px solid #f59e0b;box-shadow:0 4px 16px rgba(0,0,0,0.4);">
  <span id="telegram-broken-msg">⚠️ Telegram alerts are failing</span>
  <button onclick="document.getElementById('telegram-broken-banner').style.display='none';" aria-label="Dismiss" style="margin-left:14px;background:transparent;border:1px solid rgba(255,255,255,0.4);color:#fff;padding:2px 9px;border-radius:4px;font-family:inherit;font-size:0.7rem;cursor:pointer;">Dismiss</button>
</div>
<div id="backup-nag-banner" role="status" style="display:none;position:fixed;top:0;left:0;right:0;z-index:99998;background:#1e3a5f;color:#fff;font-family:'IBM Plex Mono',monospace;font-size:0.8rem;font-weight:600;padding:9px 16px;text-align:center;border-bottom:2px solid #3b82f6;box-shadow:0 4px 16px rgba(0,0,0,0.4);">
  <span id="backup-nag-msg">📦 Today's data backup is ready</span>
  <a id="backup-nag-link" href="/backup/download" style="color:#fff;text-decoration:underline;margin-left:14px;font-weight:700;">⬇ Download now</a>
  <span id="backup-nag-hint" style="margin-left:14px;font-size:0.66rem;color:#bcd2f0;">(stays until you download today's copy)</span>
  <button id="backup-nag-close" type="button" aria-label="Dismiss" title="Dismiss for this session" style="position:absolute;top:50%;right:14px;transform:translateY(-50%);background:transparent;border:none;color:#bcd2f0;font-size:1.1rem;line-height:1;cursor:pointer;padding:2px 6px;">✕</button>
</div>
<script>
window.__LOGIN_GATE_ACTIVE = ${!!process.env.LOGIN_SECRET};
(function(){
  if(window.innerWidth<=768){
    var hb=document.querySelector('.hamburger');
    if(hb) hb.style.display='flex';
  }
  window.addEventListener('resize',function(){
    var hb=document.querySelector('.hamburger');
    if(!hb) return;
    hb.style.display=window.innerWidth<=768?'flex':'none';
    if(window.innerWidth>768) closeSidebar();
  });
})();
function toggleSidebar(){
  var sb=document.getElementById('main-sidebar');
  var ov=document.getElementById('sb-overlay');
  if(!sb) return;
  var open=sb.classList.toggle('mobile-open');
  if(ov) ov.classList.toggle('active',open);
  document.body.style.overflow=open?'hidden':'';
}
function closeSidebar(){
  var sb=document.getElementById('main-sidebar');
  var ov=document.getElementById('sb-overlay');
  if(sb) sb.classList.remove('mobile-open');
  if(ov) ov.classList.remove('active');
  document.body.style.overflow='';
}
function toggleNavGroup(gid){
  var el=document.getElementById(gid);
  var hdr=document.querySelector('[data-group="'+gid+'"]');
  if(!el) return;
  var willOpen = el.classList.contains('collapsed'); // we're about to open it
  // Accordion: close every other group first
  document.querySelectorAll('.sb-group-items').forEach(function(g){
    if(g.id === gid) return;
    g.classList.add('collapsed');
    var h=document.querySelector('[data-group="'+g.id+'"]');
    if(h) h.classList.add('collapsed');
    try{sessionStorage.setItem('nav_'+g.id,'0');}catch(e){}
  });
  // Toggle the clicked group
  if(willOpen){
    el.classList.remove('collapsed');
    if(hdr) hdr.classList.remove('collapsed');
    try{sessionStorage.setItem('nav_'+gid,'1');}catch(e){}
    try{sessionStorage.setItem('nav_last_open',gid);}catch(e){}
  } else {
    el.classList.add('collapsed');
    if(hdr) hdr.classList.add('collapsed');
    try{sessionStorage.setItem('nav_'+gid,'0');}catch(e){}
    try{sessionStorage.removeItem('nav_last_open');}catch(e){}
  }
}
// Restore: only the "last open" group stays open; everything else collapses.
(function(){
  var lastOpen = null;
  try{ lastOpen = sessionStorage.getItem('nav_last_open'); }catch(e){}
  // If there is an "active" group (the one whose page is current), prefer it
  var activeGroup = document.querySelector('.sb-group-items .sb-nav-item.active');
  if(activeGroup){
    var parent = activeGroup.closest('.sb-group-items');
    if(parent) lastOpen = parent.id;
  }
  document.querySelectorAll('.sb-group-items').forEach(function(g){
    var shouldOpen = (lastOpen && g.id === lastOpen);
    var hdr = document.querySelector('[data-group="'+g.id+'"]');
    if(shouldOpen){
      g.classList.remove('collapsed');
      if(hdr) hdr.classList.remove('collapsed');
      try{sessionStorage.setItem('nav_'+g.id,'1');}catch(e){}
    } else {
      g.classList.add('collapsed');
      if(hdr) hdr.classList.add('collapsed');
      try{sessionStorage.setItem('nav_'+g.id,'0');}catch(e){}
    }
  });
})();

/* ── Deploy status chip (top-right floating) ───────────────── */
(function(){
  var chip=document.getElementById('deploy-chip');
  var dot=document.getElementById('deploy-chip-dot');
  var lbl=document.getElementById('deploy-chip-label');
  if(!chip) return;

  var hideTimer=null;

  function elapsed(iso){
    var s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
    if(s<60) return s+'s';
    var m=Math.floor(s/60); s=s%60;
    return m+'m '+s+'s';
  }
  function ago(iso){
    var s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
    if(s<60) return s+'s ago';
    var m=Math.floor(s/60);
    if(m<60) return m+'m ago';
    var h=Math.floor(m/60);
    return h+'h ago';
  }

  var deployingTimer=null;
  var deployStart=null;

  function poll(){
    fetch('/deploy/status').then(function(r){return r.json()}).then(function(d){
      if(d.status==='idle'){
        chip.style.display='none';
        clearInterval(deployingTimer); deployingTimer=null;
        return;
      }
      chip.style.display='flex';
      clearTimeout(hideTimer);

      if(d.status==='deploying'){
        chip.className='deploy-chip deploying';
        deployStart=d.startedAt;
        lbl.textContent='DEPLOYING '+elapsed(d.startedAt);
        if(!deployingTimer){
          deployingTimer=setInterval(function(){
            if(deployStart) lbl.textContent='DEPLOYING '+elapsed(deployStart);
          },1000);
        }
      } else {
        clearInterval(deployingTimer); deployingTimer=null;
        if(d.status==='success'){
          chip.className='deploy-chip success';
          lbl.textContent='DEPLOYED '+ago(d.finishedAt);
        } else {
          chip.className='deploy-chip failure';
          lbl.textContent='DEPLOY FAILED '+ago(d.finishedAt);
        }
        // auto-hide after 5 minutes
        hideTimer=setTimeout(function(){ chip.style.display='none'; },5*60*1000);
      }
    }).catch(function(){});
  }

  poll();
  setInterval(poll,20000);
})();

/* ── Broker socket health banner (auth failures, dropped feed) ────────────── */
(function(){
  var banner = document.getElementById('socket-broken-banner');
  var msgEl  = document.getElementById('socket-broken-msg');
  if(!banner || !msgEl) return;
  var dismissedKey = 'socket_banner_dismissed_until';

  function isDismissedNow(){
    try {
      var until = parseInt(sessionStorage.getItem(dismissedKey) || '0', 10);
      return until && Date.now() < until;
    } catch(e){ return false; }
  }
  // Snooze re-show for 60s when user clicks Dismiss (so it doesn't pop right back).
  banner.querySelector('button').addEventListener('click', function(){
    try { sessionStorage.setItem(dismissedKey, String(Date.now() + 60000)); } catch(e){}
  });

  function render(d){
    if(!d || !d.broken){ banner.style.display = 'none'; return; }
    if(isDismissedNow()){ banner.style.display = 'none'; return; }
    var msg;
    if(d.reason === 'auth-failed'){
      msg = '🚨 BROKER AUTH FAILED — token rejected (code ' + (d.lastErrorCode != null ? d.lastErrorCode : '?') + '). Trading is stopped. Please re-login.';
    } else if(d.reason === 'down'){
      var sec = Math.round((d.downForMs || 0) / 1000);
      msg = '⚠️ Broker socket disconnected for ' + sec + 's during market hours — feed is silent. Check connectivity / re-login.';
    } else if(d.reason === 'flapping'){
      var mins = d.flapSince ? Math.round((Date.now() - d.flapSince) / 60000) : 0;
      msg = '🚨 Broker feed UNSTABLE — connected and dropped ' + (d.flapCount || 0) + '× in a row'
          + (mins ? ' over ~' + mins + ' min' : '')
          + '. Strategies are getting NO live ticks. Still retrying — if it persists, re-login.';
    } else {
      msg = '⚠️ Broker socket issue detected.';
    }
    msgEl.textContent = msg;
    banner.style.display = 'block';
  }

  function poll(){
    fetch('/auth/socket-health', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(render)
      .catch(function(){ /* network blip — leave banner state as-is */ });
  }
  poll();
  setInterval(poll, 10000);
})();

/* ── Telegram delivery banner (alerts blocked / rate-limited / mis-configured) ─ */
(function(){
  var banner = document.getElementById('telegram-broken-banner');
  var msgEl  = document.getElementById('telegram-broken-msg');
  if(!banner || !msgEl) return;
  var dismissedKey = 'telegram_banner_dismissed_until';

  function isDismissedNow(){
    try {
      var until = parseInt(sessionStorage.getItem(dismissedKey) || '0', 10);
      return until && Date.now() < until;
    } catch(e){ return false; }
  }
  // Snooze re-show for 5 min when dismissed — a blocked Telegram won't recover
  // in seconds, so re-popping the banner on every poll would be noise.
  banner.querySelector('button').addEventListener('click', function(){
    try { sessionStorage.setItem(dismissedKey, String(Date.now() + 300000)); } catch(e){}
  });

  function ago(ts){
    var s = Math.floor((Date.now() - ts) / 1000);
    if(s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if(m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }

  function render(d){
    // Only alert on an actual delivery failure. Not-configured is intentional
    // (Telegram optional), so we stay silent unless a send was attempted and failed.
    if(!d || !d.lastError){ banner.style.display = 'none'; return; }
    if(isDismissedNow()){ banner.style.display = 'none'; return; }
    var e = d.lastError;
    var code = (e.code != null) ? (' [' + e.code + ']') : '';
    var when = e.ts ? (' — ' + ago(e.ts)) : '';
    var rep  = (d.failCount > 1) ? (' ×' + d.failCount) : '';
    msgEl.textContent = '⚠️ Telegram alerts are FAILING' + code + rep + when + ': ' + (e.message || 'send failed');
    banner.style.display = 'block';
  }

  function poll(){
    fetch('/auth/telegram-health', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(render)
      .catch(function(){ /* network blip — leave banner state as-is */ });
  }
  poll();
  setInterval(poll, 15000);
})();

/* ── Backup download-nag banner (stays until today's snapshot is downloaded) ─ */
(function(){
  var banner = document.getElementById('backup-nag-banner');
  var msgEl  = document.getElementById('backup-nag-msg');
  var linkEl = document.getElementById('backup-nag-link');
  var closeEl= document.getElementById('backup-nag-close');
  if(!banner || !msgEl || !linkEl) return;
  var dismissedKey = 'backup_nag_dismissed_date';

  function isDismissedNow(d){
    try { return d && sessionStorage.getItem(dismissedKey) === d.date; } catch(e){ return false; }
  }
  // X button: hide for the rest of this browser session (per backup date).
  if(closeEl){
    closeEl.addEventListener('click', function(){
      try { sessionStorage.setItem(dismissedKey, msgEl.dataset.date || ''); } catch(e){}
      banner.style.display = 'none';
    });
  }

  function render(d){
    // Downloaded locally OR already pushed to Google Drive = the day is safe.
    if(!d || !d.enabled || !d.exists || d.downloaded || d.driveUploaded){ banner.style.display = 'none'; return; }
    if(isDismissedNow(d)){ banner.style.display = 'none'; return; }
    msgEl.dataset.date = d.date;
    msgEl.textContent = '📦 Data backup for ' + d.date + ' is ready';
    linkEl.href = '/backup/download?date=' + encodeURIComponent(d.date);
    banner.style.display = 'block';
  }
  // After clicking download, optimistically hide; the next poll confirms via state.
  linkEl.addEventListener('click', function(){ setTimeout(function(){ banner.style.display='none'; }, 1500); });

  function poll(){
    fetch('/backup/status', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(render)
      .catch(function(){ /* network blip — leave banner state as-is */ });
  }
  poll();
  setInterval(poll, 30000);
})();

/* ── Fixed-banner height, published as --banner-h ───────────────────────────
   All three alert banners are position:fixed at top:0, so whichever one is up
   sits on top of the sticky top bar and the hamburger. On a phone that hides
   the page title, the Start buttons and the only route to the menu — there is
   no room to spare there. This publishes the visible banner's height on <html>;
   the mobile stylesheet offsets body / .top-bar / .hamburger / .sidebar by it.
   Desktop does not read the variable, so its layout is unchanged.            */
(function(){
  var IDS = ['socket-broken-banner','telegram-broken-banner','backup-nag-banner'];
  var els = IDS.map(function(id){ return document.getElementById(id); }).filter(Boolean);
  if (!els.length) return;
  var last = -1;
  function sync(){
    var h = 0;
    for (var i = 0; i < els.length; i++) {
      // The banners share top:0 and only differ by z-index, so when two are up
      // at once the taller one is what the page has to clear.
      if (getComputedStyle(els[i]).display !== 'none') h = Math.max(h, els[i].offsetHeight);
    }
    if (h === last) return;
    last = h;
    document.documentElement.style.setProperty('--banner-h', h + 'px');
  }
  sync();
  // The banners are shown/hidden by writing style.display, and their text is
  // rewritten on each poll, so watch both the attribute and the contents.
  var mo = new MutationObserver(sync);
  els.forEach(function(el){ mo.observe(el, { attributes:true, attributeFilter:['style'], childList:true, subtree:true, characterData:true }); });
  if (window.ResizeObserver) { var ro = new ResizeObserver(sync); els.forEach(function(el){ ro.observe(el); }); }
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
})();

// Light-theme runtime. It rides on the sidebar because every page that has a
// sidebar needs it, while only some of them also emit modalJS() — the five
// that did not (realtime, advisor, edge-analytics, consolidation-report,
// trend-pb-backtest) rendered fully dark whatever UI_THEME said. themeJS is
// self-guarded, so pages that emit both run it once.
${themeJS()}
</script>`;
}

/**
 * Shared CSS for the sidebar + main-content shell.
 * Include once per page inside <style>.
 */
function sidebarCSS() {
  return `
    /* ── MUTED TEXT TIERS ──
       The two greys every page uses for labels, sub-values and empty states.
       They live here as tokens because the light skin cannot re-map a colour
       that a page hard-codes in its own stylesheet — the runtime hex rewriter
       only reaches inline style="" attributes. Pages write
       color:var(--muted-1,#8ba1c2); the fallback keeps the standalone pages
       (auth, result, the backtest interstitials) correct without this sheet.
       Both pairs clear 4.5:1 on their own theme's surfaces. */
    :root{--muted-1:#8ba1c2;--muted-2:#6d85a8;}
    :root[data-theme="light"]{--muted-1:#4b5769;--muted-2:#5c6b7f;}

    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    @keyframes ltpulse{0%,100%{opacity:1}50%{opacity:.25}}

    /* ── THEME OVERRIDE (Day View) ── */
    :root[data-theme="light"] { background-color:#f4f6f9 !important; }
    :root[data-theme="light"] body { background:#f4f6f9 !important; color:#334155 !important; }

    /* Sidebar — keep dark for contrast */
    :root[data-theme="light"] .sidebar { background:#1b2638 !important; border-right-color:#15202f !important; }
    :root[data-theme="light"] .sb-brand { border-bottom-color:#253347; }
    :root[data-theme="light"] .sb-brand-sub { color:#8ea6c8; }
    :root[data-theme="light"] .sb-section + .sb-section { border-top-color:#253347; }
    :root[data-theme="light"] .sb-section-header { color:#8ea6c8; }
    :root[data-theme="light"] .sb-nav-item { color:#b3c6e0; }
    :root[data-theme="light"] .sb-nav-item:hover { color:#c8dcf0; background:rgba(59,130,246,0.08); }
    :root[data-theme="light"] .sb-nav-item.active { color:#ffffff; background:rgba(59,130,246,0.15); }
    :root[data-theme="light"] .sb-divider { background:#253347; }
    :root[data-theme="light"] .sb-bottom { border-top-color:#253347; }
    :root[data-theme="light"] .sb-status-row { color:#8ea6c8; }

    /* Top bar */
    :root[data-theme="light"] .top-bar { background:#ffffff !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .top-bar-title { color:#1e293b !important; }
    :root[data-theme="light"] .top-bar-meta { color:#5c6b7f !important; }
    :root[data-theme="light"] .broker-badges { background:#ffffff !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .broker-badge.ok { background:#eff6ff !important; border-color:#bfdbfe !important; color:#1d4ed8 !important; }
    :root[data-theme="light"] .broker-badge.err { background:#fef2f2 !important; border-color:#fecaca !important; color:#b91c1c !important; }

    /* Page body */
    :root[data-theme="light"] .page-status-dot { background:#94a3b8 !important; }
    :root[data-theme="light"] .page-status-text { color:#5c6b7f !important; }
    :root[data-theme="light"] .page-title { color:#1e293b !important; }
    :root[data-theme="light"] .page-subtitle { color:#5c6b7f !important; }
    :root[data-theme="light"] .page-sub { color:#5c6b7f !important; }

    /* Stat cards */
    :root[data-theme="light"] .sc { background:#ffffff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06) !important; }
    :root[data-theme="light"] .sc::before { background:var(--accent,#93c5fd) !important; }
    :root[data-theme="light"] .sc-label { color:#4b5769 !important; }
    :root[data-theme="light"] .sc-val { color:#1e293b !important; }
    :root[data-theme="light"] .sc-sub { color:#5c6b7f !important; }

    /* Section titles */
    :root[data-theme="light"] .section-title { color:#4b5769 !important; }
    :root[data-theme="light"] .section-title::after { background:#e0e4ea !important; }

    /* Tables */
    :root[data-theme="light"] .data-table th { color:#4b5769 !important; background:#f1f5f9 !important; }
    :root[data-theme="light"] .data-table td { border-top-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] table th { color:#4b5769 !important; background:#f1f5f9 !important; }
    :root[data-theme="light"] table td { border-color:#e0e4ea !important; }
    :root[data-theme="light"] table tr { border-color:#e0e4ea !important; }

    /* Main content area */
    :root[data-theme="light"] .main-content { background:#f4f6f9 !important; }

    /* Page wrapper */
    :root[data-theme="light"] .page { color:#334155 !important; }

    /* Text selection */
    :root[data-theme="light"] ::selection { background:#bfdbfe !important; color:#1e293b !important; }
    :root[data-theme="light"] ::-moz-selection { background:#bfdbfe !important; color:#1e293b !important; }

    /* Sidebar overlay */
    :root[data-theme="light"] .sidebar-overlay.active { background:rgba(0,0,0,0.3) !important; }

    /* ── PAGE-SPECIFIC CLASS OVERRIDES ── */
    /* (Inline style="" colors are handled by JS rewriter in modalJS) */

    /* Generic — cards, boxes, containers used across pages */
    :root[data-theme="light"] .card,
    :root[data-theme="light"] .box,
    :root[data-theme="light"] .err-box,
    :root[data-theme="light"] .confirm-box { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .err-box,
    :root[data-theme="light"] .confirm-box { border-color:#fca5a5 !important; }

    /* Backtest/BbRsiBacktest — run bar, stat cards, tables, toggles, copy btns */
    :root[data-theme="light"] .run-bar { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .dw-table tbody tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] tbody tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .tbar input,
    :root[data-theme="light"] .tbar select { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .tw { border-color:#e0e4ea !important; }
    :root[data-theme="light"] .pag button { background:#ffffff !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .pag button.active { background:#eff6ff !important; border-color:#3b82f6 !important; color:#1d4ed8 !important; }
    :root[data-theme="light"] .pag-info { color:#4b5769 !important; }
    :root[data-theme="light"] .dw-toggle { border-color:#e0e4ea !important; color:#2563eb !important; }
    :root[data-theme="light"] .dw-toggle:hover,
    :root[data-theme="light"] .dw-toggle.active { background:#eff6ff !important; border-color:#3b82f6 !important; }
    :root[data-theme="light"] .copy-btn { background:#ffffff !important; border-color:#e0e4ea !important; color:#2563eb !important; }
    :root[data-theme="light"] .copy-btn:hover { background:#eff6ff !important; border-color:#3b82f6 !important; }
    :root[data-theme="light"] .copy-btn.copied { background:#dcfce7 !important; border-color:#10b981 !important; color:#047857 !important; }
    :root[data-theme="light"] #tooltip { background:#1e293b !important; }

    /* Analytics cards (bb_rsi/backtest) */
    :root[data-theme="light"] .ana-card { background:#ffffff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06) !important; }
    :root[data-theme="light"] .ana-card h3 { color:#4b5769 !important; }
    :root[data-theme="light"] .ana-mini { background:#ffffff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06) !important; }
    :root[data-theme="light"] .ana-mini h3 { color:#4b5769 !important; }
    :root[data-theme="light"] .ana-tbl th { color:#4b5769 !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .ana-tbl td { color:#334155 !important; border-bottom-color:#f1f5f9 !important; }
    :root[data-theme="light"] .ana-tbl tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .ana-stat-label { color:#5c6b7f !important; }

    /* Trade/Paper/BB_RSI — capital strip, stat cards, session cards, export btns */
    :root[data-theme="light"] .capital-strip { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .session-card { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .session-head { background:#f8fafc !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .export-btn { background:#f8fafc !important; border-color:#e0e4ea !important; color:#4b5769 !important; }
    :root[data-theme="light"] .export-btn:hover { background:#eff6ff !important; border-color:#1d4ed8 !important; color:#2563eb !important; }
    :root[data-theme="light"] .badge-running { background:#dcfce7 !important; color:#047857 !important; border-color:#10b981 !important; }
    :root[data-theme="light"] .bb_rsi-toast { background:#ffffff !important; box-shadow:0 4px 24px rgba(0,0,0,0.12) !important; }

    /* BB_RSI/Trade — broker badges, top bar overrides */
    :root[data-theme="light"] .broker-badge.ok { background:#eff6ff !important; border-color:#bfdbfe !important; color:#1d4ed8 !important; }
    :root[data-theme="light"] .broker-badge.err { background:#fef2f2 !important; border-color:#fecaca !important; color:#b91c1c !important; }

    /* Docs page */
    :root[data-theme="light"] .tab { background:#f8fafc !important; border-color:#e0e4ea !important; color:#4b5769 !important; }
    :root[data-theme="light"] .tab.active { background:#ffffff !important; border-color:#2563eb !important; color:#2563eb !important; }
    :root[data-theme="light"] .doc-card { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .doc-card h2 { border-bottom-color:#e0e4ea !important; color:#1e293b !important; }
    :root[data-theme="light"] .doc-card code { background:#f1f5f9 !important; color:#334155 !important; }
    :root[data-theme="light"] .doc-card pre { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .guide-link { border-color:#e0e4ea !important; }
    :root[data-theme="light"] .guide-link:hover { background:#f8fafc !important; border-color:#2563eb !important; }

    /* Logs page */
    :root[data-theme="light"] .toolbar { background:#ffffff !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .counter { background:#f1f5f9 !important; border-color:#e0e4ea !important; color:#4b5769 !important; }
    :root[data-theme="light"] .badge-live { background:#dcfce7 !important; border-color:#86efac !important; color:#166534 !important; }
    :root[data-theme="light"] .fp[data-level="ALL"]   { background:#f1f5f9 !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .fp[data-level="LOG"]   { background:#eff6ff !important; border-color:#bfdbfe !important; color:#1d4ed8 !important; }
    :root[data-theme="light"] .fp[data-level="INFO"]  { background:#f0fdf4 !important; border-color:#bbf7d0 !important; color:#047857 !important; }
    :root[data-theme="light"] .fp[data-level="WARN"]  { background:#fffbeb !important; border-color:#fcd34d !important; color:#b45309 !important; }
    :root[data-theme="light"] .fp[data-level="ERROR"] { background:#fef2f2 !important; border-color:#fca5a5 !important; color:#b91c1c !important; }
    :root[data-theme="light"] #search { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] #search::placeholder { color:#5c6b7f !important; }
    :root[data-theme="light"] .btn { border-color:#e0e4ea !important; }
    :root[data-theme="light"] .btn-scroll { background:#ffffff !important; border-color:#e0e4ea !important; color:#4b5769 !important; }
    :root[data-theme="light"] .btn-scroll.on { background:#eff6ff !important; border-color:#3b82f6 !important; color:#1d4ed8 !important; }
    :root[data-theme="light"] .btn-export { background:#eff6ff !important; border-color:#bfdbfe !important; color:#1d4ed8 !important; }
    :root[data-theme="light"] .btn-exportj { background:#f5f3ff !important; border-color:#c4b5fd !important; color:#6d28d9 !important; }
    :root[data-theme="light"] .btn-clear { background:#fef2f2 !important; border-color:#fca5a5 !important; color:#b91c1c !important; }
    :root[data-theme="light"] .log-wrap { background:#ffffff !important; }
    :root[data-theme="light"] .log-wrap::-webkit-scrollbar-track { background:#f4f6f9 !important; }
    :root[data-theme="light"] .log-wrap::-webkit-scrollbar-thumb { background:#cbd5e1 !important; }
    :root[data-theme="light"] .log-row { border-bottom-color:#f1f5f9 !important; }
    :root[data-theme="light"] .log-row:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .log-row[data-level="WARN"] { background:#fffbeb !important; }
    :root[data-theme="light"] .log-row[data-level="WARN"]:hover { background:#fef9c3 !important; }
    :root[data-theme="light"] .log-row[data-level="ERROR"] { background:#fef2f2 !important; }

    /* History pages (paperTrade, bbRsiPaper) */
    :root[data-theme="light"] .session-card { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .session-head { background:#f8fafc !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .summary-table th { background:#f1f5f9 !important; color:#4b5769 !important; }
    :root[data-theme="light"] .summary-table td { border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .holiday-table th { background:#f1f5f9 !important; color:#4b5769 !important; }
    :root[data-theme="light"] .holiday-table td { border-color:#e0e4ea !important; }

    /* Manual Tracker page */
    :root[data-theme="light"] .log-box { background:#ffffff !important; border-color:#e0e4ea !important; }

    /* Paper Trade pages (green-tinted dark theme) */
    :root[data-theme="light"] .capital-strip { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .cap-cell { border-right-color:#e0e4ea !important; }
    :root[data-theme="light"] .cap-label { color:#4b5769 !important; }
    :root[data-theme="light"] .cap-val { color:#1e293b !important; }
    :root[data-theme="light"] .cap-val.white { color:#1e293b !important; }
    :root[data-theme="light"] .cap-val.green { color:#166534 !important; }

    /* Compare page */
    :root[data-theme="light"] .panel { background:#ffffff !important; border-color:#e0e4ea !important; box-shadow:0 1px 3px rgba(0,0,0,0.06) !important; }
    :root[data-theme="light"] .metric { background:#f8fafc !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .metric-label { color:#4b5769 !important; }
    :root[data-theme="light"] .metric-val { color:#1e293b !important; }
    :root[data-theme="light"] .metric-sub { color:#5c6b7f !important; }
    :root[data-theme="light"] .subtitle { color:#5c6b7f !important; }
    :root[data-theme="light"] h1 { color:#1e293b !important; }
    :root[data-theme="light"] .diff-title { color:#1e293b !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .diff-table th { color:#4b5769 !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .diff-table td { border-bottom-color:#f1f5f9 !important; color:#334155 !important; }
    :root[data-theme="light"] .diff-table tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .diff-table .neutral { color:#334155 !important; }
    :root[data-theme="light"] .day-table th { color:#4b5769 !important; border-bottom-color:#e0e4ea !important; }
    :root[data-theme="light"] .day-table td { border-bottom-color:#f1f5f9 !important; }
    :root[data-theme="light"] .day-table tr:hover { background:#f8fafc !important; }
    :root[data-theme="light"] .chart-wrap { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .chart-title { color:#1e293b !important; }
    :root[data-theme="light"] .no-data { color:#5c6b7f !important; }
    :root[data-theme="light"] .tag.paper { background:rgba(59,130,246,0.1) !important; }
    :root[data-theme="light"] .tag.backtest { background:rgba(245,158,11,0.1) !important; }

    /* Settings page */
    :root[data-theme="light"] .auth-box { background:#ffffff !important; border-color:#e0e4ea !important; }
    :root[data-theme="light"] .auth-box h2 { color:#2563eb !important; }
    :root[data-theme="light"] .auth-box p { color:#4b5769 !important; }
    :root[data-theme="light"] .auth-box input { background:#f8fafc !important; border-color:#e0e4ea !important; color:#334155 !important; }
    :root[data-theme="light"] .auth-box button { background:#2563eb !important; }
    :root[data-theme="light"] .auth-err { color:#dc2626 !important; }
    :root[data-theme="light"] .env-key-tag { color:#2563eb !important; }

    /* ── SIDEBAR ── */
    .app-shell{display:flex;min-height:100vh;}
    /* overscroll-behavior:contain keeps a flick that started inside the drawer
       from chaining to the page once the drawer hits its top/bottom — without it
       every menu scroll on a phone ends up scrolling the page behind it. */
    /* height:100dvh (dynamic viewport) is what makes the bottom of the drawer
       reachable on a phone. With plain 100vh the browser measures the viewport
       as if the URL bar were hidden, so the drawer is ~100px taller than the
       screen actually shows — scrolling it to the end still leaves the last
       rows (SYSTEM → Settings, and the status/action block) under the browser
       chrome, unreachable. 100vh stays first as the fallback for old browsers.
       touch-action:pan-y guarantees a finger drag scrolls the drawer instead of
       being interpreted as a page pan. */
    .sidebar{width:200px;flex-shrink:0;background:#03080e;border-right:1px solid #0e1e36;display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;height:100dvh;z-index:100;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain;}
    /* Both ends are fixed chrome around the scrolling nav — without flex-shrink:0
       they compress once the item list overflows, and the bottom block is where
       Settings' neighbours (status + action buttons) live. */
    .sb-brand{padding:20px 16px 16px;border-bottom:1px solid #0e1e36;flex-shrink:0;}
    .sb-brand-name{font-size:0.72rem;font-weight:700;color:#60a5fa;letter-spacing:0.3px;line-height:1.4;white-space:nowrap;}
    .sb-brand-sub{font-size:0.6rem;color:var(--muted-2,#6d85a8);letter-spacing:2px;text-transform:uppercase;margin-top:2px;}
    .sb-nav{padding:6px 0;flex:1;}
    .sb-section{padding-bottom:4px;}
    .sb-section + .sb-section{border-top:1px solid #0e1e36;padding-top:4px;}
    .sb-section-header{font-size:0.52rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--muted-2,#6d85a8);padding:8px 16px 2px;user-select:none;}
    .sb-section-header.sb-collapsible{cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding-right:16px;transition:color 0.15s;}
    .sb-section-header.sb-collapsible:hover{color:#3b82f6;}
    .sb-chevron{font-size:0.7rem;transition:transform 0.2s;display:inline-block;}
    .sb-section-header.sb-collapsible:not(.collapsed) .sb-chevron{transform:rotate(-90deg);}
    .sb-section-header.sb-collapsible.collapsed .sb-chevron{transform:rotate(0deg);}
    .sb-group-items{overflow:hidden;max-height:500px;transition:max-height 0.25s ease-in-out,opacity 0.2s;opacity:1;}
    .sb-group-items.collapsed{max-height:0;opacity:0;padding:0;}
    .sb-nav-item{display:flex;align-items:center;gap:8px;padding:9px 16px;font-size:0.72rem;color:#a8bcd8;cursor:pointer;border-left:2px solid transparent;transition:all 0.12s;text-decoration:none;}
    .sb-nav-item:hover{color:#7aacf0;background:rgba(59,130,246,0.04);}
    .sb-nav-item.active{color:#60a5fa;background:rgba(59,130,246,0.08);border-left-color:#3b82f6;}
    .sb-nav-item.disabled{color:var(--muted-2,#6d85a8);cursor:not-allowed;opacity:0.4;pointer-events:none;}
    .sb-nav-icon{font-size:13px;width:16px;flex-shrink:0;}
    .sb-nav-badge{margin-left:auto;font-size:0.55rem;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(59,130,246,0.15);color:#60a5fa;border:0.5px solid rgba(59,130,246,0.3);white-space:nowrap;}
    .sb-nav-badge.live{background:rgba(239,68,68,0.15);color:#f87171;border-color:rgba(239,68,68,0.3);animation:pulse 1.2s infinite;}
    .sb-divider{height:0.5px;background:#0e1e36;margin:6px 16px;}
    .sb-bottom{padding:14px 16px;border-top:1px solid #0e1e36;flex-shrink:0;}
    /* Clears the iOS home-indicator bar so the last row is not half-covered.
       Separate declaration so browsers without env() keep the 14px above. */
    .sb-bottom{padding-bottom:calc(14px + env(safe-area-inset-bottom,0px));}
    .sb-status-row{display:flex;align-items:center;gap:6px;font-size:0.62rem;color:var(--muted-2,#6d85a8);margin-bottom:10px;}
    .sb-status-dot{width:5px;height:5px;border-radius:50%;background:#3b82f6;animation:pulse 1.3s infinite;}
    .sb-status-dot.stopped{background:#2a4060;animation:none;}
    .deploy-chip{display:none;position:fixed;bottom:16px;right:20px;z-index:9999;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-family:'IBM Plex Mono',monospace;font-size:0.65rem;font-weight:600;letter-spacing:0.4px;backdrop-filter:blur(8px);box-shadow:0 2px 12px rgba(0,0,0,0.3);cursor:default;transition:all 0.3s;}
    .deploy-chip.deploying{background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);color:#f59e0b;}
    .deploy-chip.success{background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);color:#10b981;}
    .deploy-chip.failure{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);color:#ef4444;}
    .deploy-chip-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
    .deploy-chip.deploying .deploy-chip-dot{background:#f59e0b;animation:pulse 1s infinite;}
    .deploy-chip.success .deploy-chip-dot{background:#10b981;}
    .deploy-chip.failure .deploy-chip-dot{background:#ef4444;animation:ltpulse 1.5s infinite;}
    :root[data-theme="light"] .deploy-chip{box-shadow:0 2px 12px rgba(0,0,0,0.1);}
    .sb-action-btn{width:100%;padding:7px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.68rem;font-weight:700;cursor:pointer;text-align:center;border:1px solid;transition:all 0.12s;background:transparent;margin-bottom:6px;}
    .sb-stop-btn{border-color:#1a3a6a;color:#60a5fa;}
    .sb-stop-btn:hover{background:rgba(59,130,246,0.08);border-color:#3b82f6;}
    .sb-start-btn{border-color:#065f46;color:#10b981;}
    .sb-start-btn:hover{background:rgba(16,185,129,0.06);border-color:#10b981;}
    .sb-exit-btn{border-color:#7f1d1d;color:#f87171;font-size:0.63rem;}
    .sb-exit-btn:hover{background:rgba(239,68,68,0.06);}
    .sb-paper-btn{border-color:#78350f;color:#f59e0b;}
    .sb-paper-btn:hover{background:rgba(245,158,11,0.06);border-color:#f59e0b;}
    .sb-reset-btn{border-color:#312e0f;color:#f59e0b;font-size:0.62rem;}
    .sb-reset-btn:hover{background:rgba(161,98,7,0.06);}

    /* ── MAIN CONTENT ── */
    /* min-width:0 is essential: .main-content is a flex item, and without it the
       default min-width:auto lets it grow WIDER than the viewport to fit its
       widest child (multi-column grids), so the overflow gets clipped by
       body{overflow-x:hidden} and the right-hand cards disappear on narrower
       desktops (13" MacBook). Pinning min-width:0 keeps it at viewport width so
       the inner responsive grids reflow instead of overflowing. */
    .main-content{margin-left:200px;flex:1;min-width:0;display:flex;flex-direction:column;min-height:100vh;}
    .top-bar{background:#040c18;border-bottom:1px solid #0e1e36;padding:7px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;}
    .top-bar-title{font-size:0.82rem;font-weight:700;color:#e0eaf8;}
    .top-bar-meta{display:none;}
    .top-bar-right{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;}
    .top-bar-badge{display:flex;align-items:center;gap:5px;font-size:0.6rem;font-weight:700;padding:3px 9px;border-radius:4px;border:0.5px solid rgba(59,130,246,0.3);background:rgba(59,130,246,0.1);color:#60a5fa;}
    .top-bar-badge.live-active{border-color:rgba(239,68,68,0.3);background:rgba(239,68,68,0.1);color:#ef4444;animation:pulse 1.2s infinite;}
    .top-bar-badge.paper-active{border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.1);color:#10b981;animation:pulse 1.2s infinite;}
    .top-bar-cache{display:inline-flex;align-items:center;gap:5px;font-size:0.6rem;font-weight:600;padding:3px 9px;border-radius:4px;border:0.5px solid rgba(16,185,129,0.25);background:rgba(16,185,129,0.07);color:#10b981;font-family:'IBM Plex Mono',monospace;letter-spacing:0.2px;white-space:nowrap;}
    .top-bar-cache.empty{border-color:rgba(74,96,128,0.3);background:rgba(74,96,128,0.07);color:var(--muted-1,#8ba1c2);}
    .top-bar-cache.schedule{border-color:rgba(34,211,238,0.25);background:rgba(34,211,238,0.07);color:#22d3ee;}
    .top-bar-cache.schedule.empty{border-color:rgba(74,96,128,0.3);background:rgba(74,96,128,0.07);color:var(--muted-1,#8ba1c2);}
    .top-bar-cache.schedule:empty{display:none;}
    .top-bar-btn{display:inline-flex;align-items:center;gap:5px;font-size:0.65rem;font-weight:700;padding:4px 10px;border-radius:5px;border:1px solid #243049;background:#0f1520;color:#a0b0c8;cursor:pointer;font-family:inherit;letter-spacing:0.2px;transition:filter 0.15s;white-space:nowrap;}
    .top-bar-btn:hover:not(:disabled){filter:brightness(1.25);}
    .top-bar-btn:disabled{opacity:0.5;cursor:not-allowed;}
    .top-bar-btn.run-paper{border-color:rgba(16,185,129,0.35);background:rgba(16,185,129,0.10);color:#10b981;}
    .top-bar-btn.run-live{border-color:rgba(239,68,68,0.35);background:rgba(239,68,68,0.10);color:#ef4444;}
    .broker-badges{display:flex;gap:6px;padding:8px 24px;background:#040c18;border-bottom:1px solid #0e1e36;flex-wrap:wrap;}
    .broker-badge{font-size:0.65rem;font-weight:600;padding:3px 10px;border-radius:5px;}
    .broker-badge.ok{background:#060e20;border:0.5px solid #0e2850;color:#60a5fa;}
    .broker-badge.err{background:#160608;border:0.5px solid #3a1020;color:#f87171;}

    /* ── PAGE BODY ── */
    .page{padding:24px;padding-bottom:60px;}
    .page-header{margin-bottom:20px;}
    .page-status-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
    .page-status-dot{width:7px;height:7px;border-radius:50%;background:#2a4060;}
    .page-status-dot.running{background:#3b82f6;animation:pulse 1.5s infinite;}
    .page-status-dot.paper-run{background:#10b981;animation:pulse 1.5s infinite;}
    .page-status-text{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted-2,#6d85a8);}
    .page-status-text.running{color:#60a5fa;}
    .page-status-text.paper-run{color:#10b981;}
    .page-title{font-size:1.4rem;font-weight:700;color:#e0eaf8;letter-spacing:-0.5px;}
    .page-subtitle{font-size:0.72rem;color:var(--muted-2,#6d85a8);margin-top:4px;}

    /* ── STAT CARDS ── */
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin-bottom:20px;}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:9px;padding:14px 16px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:1.5px;background:var(--accent,#1e3080);}
    .sc-label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin-bottom:6px;}
    .sc-val{font-size:1.1rem;font-weight:700;color:#e0eaf8;}
    .sc-sub{font-size:0.62rem;color:var(--muted-2,#6d85a8);margin-top:3px;}

    /* ── SECTION TITLES ── */
    .section-title{font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:1.8px;color:var(--muted-2,#6d85a8);margin-bottom:10px;display:flex;align-items:center;gap:8px;}
    .section-title::after{content:'';flex:1;height:0.5px;background:#0e1e36;}

    /* ── TABLE ── */
    .data-table{width:100%;border-collapse:collapse;}
    .data-table th{padding:9px 12px;text-align:left;font-size:0.6rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-1,#8ba1c2);background:#0a0f1c;}
    .data-table td{padding:8px 12px;border-top:1px solid #1a2236;font-family:monospace;font-size:0.78rem;vertical-align:top;}

    /* ── MOBILE (iPhone 15 = 393px logical width) ── */
    @media(max-width:768px){
      /* Sidebar: hidden by default, toggled by hamburger */
      .sidebar{transform:translateX(-100%);transition:transform 0.25s ease;z-index:200;width:84vw;max-width:300px;}
      .sidebar.mobile-open{transform:translateX(0);}
      /* min-width:0 lets flex children shrink below their content size, and
         overflow-x:clip stops any stray wide element from making the whole page
         pan sideways — clip (unlike hidden/auto) does NOT break the sticky
         top-bar, and iOS 16+/iPhone 15 supports it (older browsers ignore it). */
      .main-content{margin-left:0;max-width:100%;min-width:0;overflow-x:clip;}

      /* Hamburger button — 44x44 hit area (it was 36x30, under the tap-target
         minimum, and it is the ONLY way to reach the menu on a phone). The bars
         themselves are unchanged; only the box around them grew, and it still
         ends at x=46 so .top-bar's 48px left padding keeps clearing it. */
      .hamburger{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer;padding:0;background:none;border:none;position:fixed;top:var(--banner-h,0px);left:2px;min-width:44px;min-height:44px;z-index:300;}
      /* The button floats above the open drawer's top-left corner, so a flick
         that starts on it must not pan the page — same reason as the overlay.
         Scoped to the open state so it stays a normal scroll surface the rest
         of the time; browsers without :has() just keep the old behaviour. */
      body:has(.sidebar.mobile-open) .hamburger{touch-action:none;}
      .hamburger span{display:block;width:20px;height:2px;background:#8ba1c2;border-radius:2px;transition:all 0.2s;}

      /* The brand block starts at the very top of the drawer, directly under the
         fixed hamburger, so its first line was printed through the bars. Clear
         the 46px the button occupies. */
      .sb-brand{padding-left:52px;}

      /* Overlay when sidebar open. touch-action:none — a drag on the dimmed
         strip beside the drawer must dismiss-or-nothing, never scroll the page
         underneath it. */
      .sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:150;touch-action:none;}
      .sidebar-overlay.active{display:block;}

      /* Top bar: compress + let badges/buttons wrap onto a second line */
      .top-bar{padding:7px 12px 7px 48px;flex-wrap:wrap;gap:6px 8px;}
      .top-bar-meta{display:none;}
      .top-bar-title{font-size:0.78rem;}
      .top-bar-right{gap:4px;}
      .broker-badges{padding:6px 12px;}

      /* Page padding + smaller headings */
      .page{padding:14px 12px 60px;}
      .page-title{font-size:1.15rem;}

      /* Stat grid: 2 columns */
      .stat-grid{grid-template-columns:1fr 1fr;gap:8px;}
      .sc{padding:10px 12px;}
      .sc-val{font-size:0.95rem;}

      /* Collapse every multi-column grid to a single column.
         Covers named grids used across pages + any inline grid-template-columns. */
      .stat-grid-2,.ana-row,.ana-row3,.stats,.stats-row,.roll-grid,.pos-grid,
      .metric-grid,.compare-grid,.baseline-grid,.actions,.pattern-grid{grid-template-columns:1fr !important;}
      [style*="grid-template-columns"]{grid-template-columns:1fr !important;}

      /* Tables: keep the shared data-table in a scroll wrapper, and make any
         stray <table> scroll horizontally instead of overflowing the viewport. */
      .data-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
      .data-table{min-width:600px;}
      table{display:block;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}

      /* Forms, code blocks, and media never exceed the screen width */
      input,select,textarea{max-width:100%;}
      img,canvas,svg,video{max-width:100%;height:auto;}
      pre{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}

      /* Flex rows that can run off-screen wrap instead */
      .run-bar,.capital-strip,.session-head{flex-wrap:wrap;}
      .cap-cell{min-width:50%;}

      /* ── TOUCH TYPOGRAPHY ──
         iOS Safari zooms the whole page when a field whose font-size is below
         16px takes focus, and nothing the page does can undo that zoom. 16px is
         the literal threshold, so it is written in px, not rem — a rem value
         tracks the root font-size and can silently fall back under the limit.
         Pages set these sizes through class selectors (.tbar input,
         .config-input, .dl-range-inp, …) which outrank a bare element selector,
         so the override needs !important to win. It lives inside this media
         query, so desktop keeps its 10.6-13.6px filter bars unchanged. */
      input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]),
      select,textarea{font-size:16px !important;}

      /* ── TAP TARGETS ──
         44px is the smallest control a fingertip hits reliably. Every control
         the app rendered measured between 17px and 32px tall. */
      button,select,textarea,
      input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]){min-height:44px;}
      /* Anchors and spans styled as buttons are inline boxes, so a min-height
         alone does nothing to them — they need a flex box before it applies. */
      a.btn,a.export-btn,a.copy-btn,a.dw-toggle,a.brk-action,a.pdf-btn,a.tab,
      a.top-bar-btn,a.run-btn,a.preset-btn,a.btn-download,a.btn-view,
      a.bc-link,a.cr-link,a.act-btn,a.dash-chart-link,a.back,a.clear,
      .tab,.collapse-toggle,.status-pill-dismiss,.top-bar-cache.clickable,
      .fp,.sb-action-btn{min-height:44px;display:inline-flex;align-items:center;justify-content:center;}
      /* The drawer's own links were 35px, and on a phone the drawer IS the
         navigation. The sidebar already scrolls, so taller rows are safe. */
      .sb-nav-item{min-height:44px;}
      /* The dismiss ✕ on the dashboard status pill was 8px wide — a glyph, not a
         control. It needs width as much as height. */
      .status-pill-dismiss{min-width:44px;}
      /* Navigation links that carry no class of their own (📊 History, ← Status,
         🤖 AI export, ← Edge Analytics). Scoped to the header/toolbar rows so
         links inside body prose keep flowing with the text they sit in. */
      .top-bar a,.page-header a,.page-sub a,.section-title a{min-height:44px;display:inline-flex;align-items:center;}
      /* Collapsing a drawer group is a tap like any other; the header rendered
         24px tall. justify-content stays default so the chevron keeps its place
         at the far right of the row. */
      .sb-section-header.sb-collapsible{min-height:44px;}
      /* Pager arrows were 26px wide (44 tall) — a fingertip misses sideways just
         as easily as vertically. Page rules set an explicit padding-based width,
         so the floor has to outrank them. */
      .pager-btn,.pag button,.pager button{min-width:44px !important;}
      /* The recovery link on an error page is the only control it has. */
      #err a,.err-box a{min-height:44px;display:inline-flex;align-items:center;}

      /* ── LEGIBILITY FLOOR ──
         Uppercase micro-labels are set in rem (0.52–0.62rem = 8.3–9.9px). Under
         ~10px they stop being readable at arm's length on a phone, and letter-
         spacing makes it worse. Raise just the label tier; values, headings and
         body text already sit well above the floor.
         !important for the same reason the input rule above needs it: these
         sizes are set through multi-class page selectors that outrank a bare
         class here, and the rule is scoped to the phone breakpoint so desktop
         keeps its denser type. */
      .sb-section-header,.sb-brand-sub,.sb-status-row,.sb-nav-badge{font-size:0.68rem !important;}
      /* Named label classes, then the same tier caught structurally — the app
         has ~40 page-local variants of "-label"/"-sub"/"-meta"/badge, and
         listing them one by one leaves a tail that only shows up on the next
         page someone writes. */
      .sc-label,.sc-sub,.cap-label,.cap-sub,.section-title,.page-status-text,
      .top-bar-badge,.top-bar-cache,.top-bar-btn,.export-btn,.reset-btn,
      .act-btn,.chip,.pill,.tag,.counter,.pag-info,.dw-toggle,
      label,.lbl,.w-cap,.fp,.log-time,.log-lvl,
      th,.crumb span,.breadcrumb span,.panel h3,.sc-sub span,.sc-breakdown span,
      [class*="-label"],[class*="-sub"],[class*="-meta"],[class*="badge"],
      [class*="-status"],[class*="caret"],[class*="-info"],[class*="-name"],
      .capital-strip .cap-cell,.brokers span,.yr-now,
      .sub,.action-title,.chart-title,.proc-title,.sc-breakdown,.run-bar div,
      #meta,#olderHint{font-size:0.7rem !important;}

      /* Long unbreakable tokens (env keys, option symbols, file paths) inside
         inline code have to wrap. Inside <pre> they must NOT — that block keeps
         its formatting and scrolls sideways instead. */
      code,kbd,samp{overflow-wrap:anywhere;word-break:break-word;}
      pre code,pre kbd,pre samp{overflow-wrap:normal;word-break:normal;}

      /* Shared fixed banners: the message ran underneath the absolutely
         positioned ✕, and every control in them was 17-22px tall. Only padding
         and the controls are touched — never the display property, because the banners are
         shown/hidden through an inline style that an !important rule here would
         override, pinning them permanently open. */
      /* Nothing may sit under a fixed banner on a phone — see the --banner-h
         block in the nav script. The variable is 0px whenever no banner is up,
         so these four rules are inert the rest of the time. */
      body{padding-top:var(--banner-h,0px);}
      .top-bar{top:var(--banner-h,0px);}
      .sidebar{top:var(--banner-h,0px);height:calc(100vh - var(--banner-h,0px));height:calc(100dvh - var(--banner-h,0px));}

      /* The parenthetical hint costs the banner a whole extra line at 393px and
         repeats what the link already says. */
      #backup-nag-hint{display:none;}
      #backup-nag-banner{padding:8px 54px 8px 12px !important;line-height:1.6;}
      #socket-broken-banner,#telegram-broken-banner{padding:8px 12px !important;line-height:1.7;}
      #backup-nag-banner a,#socket-broken-banner a{display:inline-flex;align-items:center;min-height:44px;}
      #backup-nag-close{min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;padding:0 !important;right:4px !important;}
      #socket-broken-banner button,#telegram-broken-banner button{display:inline-flex;align-items:center;justify-content:center;}
    }
    @media(max-width:400px){
      .stat-grid{grid-template-columns:1fr;}
    }`
    ;
}

/**
 * Common JS snippet for toast notifications (used on Paper+Live pages).
 */
function toastJS() {
  return `
function showToast(msg, color) {
  var t = document.createElement('div');
  t.textContent = msg;
  var isLight = document.documentElement.getAttribute('data-theme') === 'light';
  var bg = isLight ? '#ffffff' : '#0d1320';
  var shadow = isLight ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.6)';
  t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:'+bg+';border:1px solid '+color+';color:'+color+';padding:12px 24px;border-radius:10px;font-size:0.85rem;font-weight:700;z-index:9999;box-shadow:0 4px 24px '+shadow+';letter-spacing:0.5px;pointer-events:none;';
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 3500);
}`;
}

/**
 * Client-side AI-friendly export.
 *
 * Defines window.downloadAiMarkdown(list, meta, baseName) — turns an array of
 * normalised trade objects (the same shape Consolidation / paper pages hold in
 * memory) into a Markdown report and triggers a .md download. Mirrors the
 * server-side src/utils/aiExport.js so every download site produces the same
 * format: summary stats → field legend → per-side trade table. Used by pages
 * that filter trades in the browser and so can't go through the server endpoint.
 */
function aiExportJS() {
  return `
var AI_LEGEND = {
  mode:'Strategy (ema_rsi_st / bb_rsi / pa / orb).',
  side:'CE = call (bullish) · PE = put (bearish).',
  symbol:'Option contract traded.',
  qty:'Quantity in units (lot size × lots).',
  entryPrice:'Option premium paid at entry (₹).',
  exitPrice:'Option premium received at exit (₹).',
  spotAtEntry:'NIFTY spot when entered.', spotAtExit:'NIFTY spot when exited.',
  optionEntryLtp:'Option LTP at entry (₹).', optionExitLtp:'Option LTP at exit (₹).',
  optionStrike:'Strike price.', optionType:'CE or PE.', optionExpiry:'Expiry date.',
  entryTime:'Entry timestamp, IST.', exitTime:'Exit timestamp, IST.',
  pnl:'Realised P&L in ₹ (negative = loss).',
  pnlMode:'"option" = from option LTP · "spot proxy" = estimated from spot move.',
  entryReason:'What triggered entry.', exitReason:'What closed the trade.',
  date:'Trade date, IST.', instrument:'Instrument type.'
};
var AI_ORDER = ['date','entryTime','exitTime','side','symbol','optionStrike','optionType','qty','entryPrice','exitPrice','optionEntryLtp','optionExitLtp','spotAtEntry','spotAtExit','pnl','pnlMode','entryReason','exitReason'];
var AI_DENY = {mode:1,strategy:1,loggedAt:1,type:1,id:1,reason:1};
function aiNum(v){ return (typeof v==='number'&&isFinite(v))?v:null; }
function aiFmtNum(v){ return Number.isInteger(v)?String(v):String(Math.round(v*100)/100); }
function aiFmtPnl(v){ var n=aiNum(v); if(n===null) return '—'; return (n>=0?'+':'')+aiFmtNum(n); }
function aiCell(v){
  if(v==null) return '';
  var s = (typeof v==='object')?JSON.stringify(v):(typeof v==='number'?aiFmtNum(v):String(v));
  s = s.replace(/\\r?\\n/g,' ').replace(/\\|/g,'\\\\|');
  return s.length>90 ? s.slice(0,89)+'…' : s;
}
function aiModeOf(t){ return String(t.mode||t.strategy||'trades'); }
window.tradesToAiMarkdown = function(list, meta){
  meta = meta||{};
  list = (list||[]).filter(function(t){ return t && typeof t==='object'; });
  var groups = {};
  list.forEach(function(t){ var m=aiModeOf(t); (groups[m]=groups[m]||[]).push(t); });
  var modes = Object.keys(groups).sort();
  function stats(arr){
    var w=arr.filter(function(t){return aiNum(t.pnl)>0;});
    var l=arr.filter(function(t){return aiNum(t.pnl)<0;});
    var net=arr.reduce(function(a,t){return a+(aiNum(t.pnl)||0);},0);
    var aw=w.length?w.reduce(function(a,t){return a+t.pnl;},0)/w.length:0;
    var al=l.length?l.reduce(function(a,t){return a+t.pnl;},0)/l.length:0;
    var dec=w.length+l.length;
    return {n:arr.length,w:w.length,l:l.length,winPct:dec?Math.round(w.length/dec*100):0,net:net,aw:aw,al:al};
  }
  var out=[];
  out.push('# '+(meta.title||'Trade export')+' — AI-friendly export');
  var m1=[]; if(meta.source) m1.push('Source: '+meta.source); if(meta.range) m1.push('Range: '+meta.range);
  m1.push(list.length+' trade'+(list.length===1?'':'s')); if(modes.length) m1.push('modes: '+modes.join(', '));
  out.push('> '+m1.join(' · '));
  out.push('>');
  out.push('> Structured for AI analysis: summary stats, a field legend, then the trades. P&L is in ₹ unless noted.');
  out.push('');
  if(!list.length){ out.push('_No trades in this export._'); return out.join('\\n')+'\\n'; }
  out.push('## Summary');
  out.push('| Mode | Trades | Wins | Losses | Win % | Net P&L | Avg win | Avg loss |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  function sRow(label,s){ return '| '+label+' | '+s.n+' | '+s.w+' | '+s.l+' | '+s.winPct+'% | '+aiFmtPnl(s.net)+' | '+(s.aw?aiFmtPnl(s.aw):'—')+' | '+(s.al?aiFmtPnl(s.al):'—')+' |'; }
  modes.forEach(function(m){ out.push(sRow(m, stats(groups[m]))); });
  if(modes.length>1) out.push(sRow('**TOTAL**', stats(list)));
  out.push('');
  var present={}; list.forEach(function(t){ Object.keys(t).forEach(function(k){ present[k]=1; }); });
  out.push('## Field legend');
  Object.keys(AI_LEGEND).forEach(function(k){ if(present[k]) out.push('- \\\`'+k+'\\\` — '+AI_LEGEND[k]); });
  out.push('');
  out.push('## Trades');
  modes.forEach(function(m){
    var arr=groups[m], s=stats(arr);
    var cols=[], seen={};
    arr.forEach(function(t){ Object.keys(t).forEach(function(k){ if(!AI_DENY[k]) seen[k]=1; }); });
    AI_ORDER.forEach(function(c){ if(seen[c]){ cols.push(c); seen[c]=0; } });
    Object.keys(seen).forEach(function(k){ if(seen[k]) cols.push(k); });
    out.push('### '+m+' — '+arr.length+' trade'+(arr.length===1?'':'s')+', net '+aiFmtPnl(s.net));
    if(!cols.length){ out.push('_(no fields)_'); return; }
    out.push('| '+cols.join(' | ')+' |');
    out.push('| '+cols.map(function(){return '---';}).join(' | ')+' |');
    arr.forEach(function(t){ out.push('| '+cols.map(function(c){ return c==='pnl'?aiFmtPnl(t[c]):aiCell(t[c]); }).join(' | ')+' |'); });
    out.push('');
  });
  return out.join('\\n')+'\\n';
};
window.downloadAiMarkdown = function(list, meta, baseName){
  var md = window.tradesToAiMarkdown(list, meta);
  var blob = new Blob([md], { type:'text/markdown;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = (baseName||'trades_AI') + '.md';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
};`;
}

/**
 * Shared log viewer HTML + JS (reused by Paper Trade and Live Trade status pages).
 * @param {string} logsJSON    - JSON string of log array (newest first)
 * @param {string} prefix      - Unique prefix for element IDs ('log' | 'ptlog')
 */
function logViewerHTML(logsJSON, prefix = 'log') {
  return `
  <div style="margin-top:8px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      <div class="section-title" style="margin-bottom:0;">Activity Log</div>
      <input id="${prefix}Search" placeholder="Search log…" oninput="${prefix}Filter()"
        style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:4px 9px;border-radius:6px;font-size:0.73rem;font-family:inherit;width:180px;"/>
      <select id="${prefix}Type" onchange="${prefix}Filter()"
        style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="">All entries</option>
        <option value="✅">✅ Wins</option>
        <option value="❌">❌ Errors</option>
        <option value="🚨">🚨 Alerts</option>
        <option value="🛑">🛑 SL Hits</option>
      </select>
      <select id="${prefix}PP" onchange="${prefix}Filter()"
        style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:4px 8px;border-radius:6px;font-size:0.73rem;">
        <option value="50">50/page</option>
        <option value="100">100/page</option>
        <option value="9999">All</option>
      </select>
      <span id="${prefix}Count" style="font-size:0.7rem;color:var(--muted-1,#8ba1c2);"></span>
    </div>
    <div id="${prefix}Box" style="background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;padding:12px 16px;max-height:360px;overflow-y:auto;"></div>
    <div id="${prefix}Pag" style="display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;"></div>
  </div>

  <script id="${prefix}-data" type="application/json">${logsJSON}</script>
  <script>
  var ${prefix}_ALL = JSON.parse(document.getElementById('${prefix}-data').textContent);
  var ${prefix}Filtered = ${prefix}_ALL.slice(), ${prefix}Pg = 1, ${prefix}PP_val = 50;
  function ${prefix}Filter(){
    var s = document.getElementById('${prefix}Search').value.toLowerCase();
    var t = document.getElementById('${prefix}Type').value;
    ${prefix}PP_val = parseInt(document.getElementById('${prefix}PP').value);
    ${prefix}Pg = 1;
    ${prefix}Filtered = ${prefix}_ALL.filter(function(l){
      if(t && l.indexOf(t)<0) return false;
      if(s && l.toLowerCase().indexOf(s)<0) return false;
      return true;
    });
    ${prefix}Render();
  }
  function ${prefix}Render(){
    var start=(${prefix}Pg-1)*${prefix}PP_val, slice=${prefix}Filtered.slice(start,start+${prefix}PP_val);
    document.getElementById('${prefix}Count').textContent = ${prefix}Filtered.length+' of '+${prefix}_ALL.length;
    var box=document.getElementById('${prefix}Box');
    if(slice.length===0){ box.innerHTML='<div style="color:var(--muted-1,#8ba1c2);font-size:0.78rem;">No entries match.</div>'; document.getElementById('${prefix}Pag').innerHTML=''; return; }
    box.innerHTML = slice.map(function(l){
      var c = l.indexOf('❌')>=0?'#ef4444':l.indexOf('✅')>=0?'#10b981':l.indexOf('🚨')>=0||l.indexOf('🛑')>=0?'#f59e0b':l.indexOf('🎯')>=0||l.indexOf('⚡')>=0?'#3b82f6':'#4a6080';
      return '<div style="padding:5px 0;border-bottom:1px solid #0e1e36;font-size:0.72rem;font-family:monospace;color:'+c+';line-height:1.4;">'+l+'</div>';
    }).join('');
    var total=Math.ceil(${prefix}Filtered.length/${prefix}PP_val);
    var pag=document.getElementById('${prefix}Pag');
    if(total<=1){ pag.innerHTML=''; return; }
    var h='<button onclick="${prefix}Go('+(${prefix}Pg-1)+')" '+(${prefix}Pg===1?'disabled':'')+' style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">\u2190 Prev</button>';
    for(var p=Math.max(1,${prefix}Pg-2);p<=Math.min(total,${prefix}Pg+2);p++)
      h+='<button onclick="${prefix}Go('+p+')" style="background:'+(p===${prefix}Pg?'#0a1e3d':'#07111f')+';border:1px solid '+(p===${prefix}Pg?'#3b82f6':'#0e1e36')+';color:'+(p===${prefix}Pg?'#3b82f6':'#c8d8f0')+';padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">'+p+'</button>';
    h+='<button onclick="${prefix}Go('+(${prefix}Pg+1)+')" '+(${prefix}Pg===total?'disabled':'')+' style="background:#07111f;border:1px solid #0e1e36;color:#c8d8f0;padding:3px 9px;border-radius:5px;font-size:0.7rem;cursor:pointer;">Next \u2192</button>';
    pag.innerHTML=h;
  }
  function ${prefix}Go(p){ ${prefix}Pg=Math.max(1,Math.min(Math.ceil(${prefix}Filtered.length/${prefix}PP_val),p)); ${prefix}Render(); }
  ${prefix}Filter();
  </script>`;
}


/**
 * CSS for the shared table enhancer (sort + filter + pagination on <table>).
 * Tables tagged with `enh-table-full` get sort+filter+paginate; tables tagged
 * with `enh-table-sort-filter` get sort+filter only. Include once per page.
 */
function tableEnhancerCSS() {
  return `
    .enh-bar{display:flex;align-items:center;gap:8px;margin:0 0 6px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:0.64rem;color:var(--muted-1,#8ba1c2);}
    .enh-bar .enh-filter{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:4px 9px;border-radius:5px;font-family:inherit;font-size:0.66rem;outline:none;width:200px;}
    .enh-bar .enh-filter:focus{border-color:#3b82f6;}
    .enh-bar select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:3px 6px;border-radius:5px;font-family:inherit;font-size:0.66rem;outline:none;cursor:pointer;}
    .enh-bar .enh-info{color:var(--muted-2,#6d85a8);}
    .enh-bar .enh-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);}
    .enh-pager{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:var(--muted-1,#8ba1c2);}
    .enh-pager .enh-btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:3px 8px;min-width:26px;border-radius:5px;font-family:inherit;font-size:0.66rem;cursor:pointer;}
    .enh-pager .enh-btn:hover:not(:disabled){background:#0a1e3d;border-color:#3b82f6;}
    .enh-pager .enh-btn:disabled{opacity:0.3;cursor:not-allowed;}
    th.enh-sort{cursor:pointer;user-select:none;}
    th.enh-sort:hover{color:#3b82f6 !important;}
    th.enh-sort::after{content:'\\2195';opacity:0.25;margin-left:4px;font-size:0.7em;display:inline-block;}
    th.enh-sort[data-dir="asc"]::after{content:'\\2191';opacity:1;color:#3b82f6;}
    th.enh-sort[data-dir="desc"]::after{content:'\\2193';opacity:1;color:#3b82f6;}
    :root[data-theme="light"] .enh-bar .enh-filter,
    :root[data-theme="light"] .enh-bar select{background:#fff!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .enh-bar .enh-info,
    :root[data-theme="light"] .enh-bar .enh-label{color:#5c6b7f!important;}
    :root[data-theme="light"] .enh-pager .enh-btn{background:#fff!important;border-color:#e0e4ea!important;color:#2563eb!important;}
    :root[data-theme="light"] .enh-pager .enh-btn:hover:not(:disabled){background:#eff6ff!important;border-color:#3b82f6!important;}
  `;
}

/**
 * JS snippet for the shared table enhancer. Defines window.enhanceTable(tbl, opts)
 * and auto-enhances tables with classes `enh-table-full` (sort+filter+paginate)
 * or `enh-table-sort-filter` (sort+filter only) on DOMContentLoaded. Safe to call
 * enhanceTable() again on dynamically populated tables (e.g. after AJAX fill).
 */
function tableEnhancerJS() {
  return `
(function(){
  function parseSortVal(raw){
    if (raw == null) return { kind:'empty' };
    var s = String(raw).trim();
    if (s === '' || s === '—' || s === '-') return { kind:'empty' };
    // numeric (strip currency, commas, %, +/- prefix kept)
    var num = s.replace(/[₹,\\$£€%\\s]/g,'');
    if (/^[-+]?\\d+(?:\\.\\d+)?$/.test(num)) return { kind:'num', val: parseFloat(num) };
    // date-ish (YYYY-MM-DD or DD/MM/YYYY etc.) — fallback to Date.parse
    var d = Date.parse(s);
    if (!isNaN(d) && /[\\-\\/:]/.test(s)) return { kind:'num', val: d };
    return { kind:'text', val: s.toLowerCase() };
  }
  function cmpCells(a, b, dir){
    var ka = parseSortVal(a), kb = parseSortVal(b);
    // empties always last regardless of dir
    if (ka.kind === 'empty' && kb.kind === 'empty') return 0;
    if (ka.kind === 'empty') return 1;
    if (kb.kind === 'empty') return -1;
    var c;
    if (ka.kind === 'num' && kb.kind === 'num') c = ka.val - kb.val;
    else c = String(ka.val).localeCompare(String(kb.val));
    return dir === 'desc' ? -c : c;
  }
  function cellSortText(td){
    if (!td) return '';
    if (td.dataset && td.dataset.sort != null) return td.dataset.sort;
    return (td.textContent || '').trim();
  }
  function visibleCellText(row){
    return (row.textContent || '').toLowerCase();
  }

  window.enhanceTable = function(tbl, opts){
    if (!tbl) return;
    opts = opts || {};
    var thead = tbl.tHead, tbody = tbl.tBodies && tbl.tBodies[0];
    if (!thead || !tbody) return;
    var headerCells = thead.rows[0] ? thead.rows[0].cells : [];
    // Collect current tbody rows as the row pool.
    var rows = Array.prototype.slice.call(tbody.rows);
    // Skip placeholder rows (e.g. "Loading…", "No data") — they have a single cell with colspan.
    var hasReal = rows.some(function(r){ return r.cells.length > 1 || (r.cells[0] && !r.cells[0].hasAttribute('colspan')); });
    if (rows.length === 0 || !hasReal) {
      // nothing to enhance yet; leave a marker so we can re-enhance later
      tbl.__enhPending = opts;
      return;
    }
    delete tbl.__enhPending;

    var first = !tbl.__enh;
    var inst = tbl.__enh || (tbl.__enh = {});
    inst.allRows = rows;
    inst.filtered = rows.slice();
    inst.page = inst.page || 1;
    inst.pageSize = (opts.paginate ? (inst.pageSize || opts.pageSize || 10) : 0);
    inst.sortIdx = -1;
    inst.sortDir = null;
    inst.opts = opts;

    if (first) {
      // Build controls bar
      if (opts.filter || opts.paginate) {
        var bar = document.createElement('div');
        bar.className = 'enh-bar';
        var html = '';
        if (opts.filter) html += '<input type="search" class="enh-filter" placeholder="\u{1F50D} Filter rows…"/>';
        if (opts.paginate) html += '<span class="enh-label">Rows</span><select class="enh-pagesize"><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="0">All</option></select>';
        html += '<span class="enh-info"></span>';
        bar.innerHTML = html;
        tbl.parentNode.insertBefore(bar, tbl);
        inst.bar = bar;
        var fi = bar.querySelector('.enh-filter');
        if (fi) fi.addEventListener('input', function(){ inst.page = 1; apply(); });
        var ps = bar.querySelector('.enh-pagesize');
        if (ps) {
          ps.value = String(inst.pageSize);
          ps.addEventListener('change', function(){
            inst.pageSize = parseInt(ps.value, 10) || 0;
            inst.page = 1;
            apply();
          });
        }
      }
      // Build pager
      if (opts.paginate) {
        var pager = document.createElement('div');
        pager.className = 'enh-pager';
        pager.innerHTML = '<button class="enh-btn" data-act="first" title="First">«</button><button class="enh-btn" data-act="prev" title="Prev">‹</button><span class="enh-pager-info"></span><button class="enh-btn" data-act="next" title="Next">›</button><button class="enh-btn" data-act="last" title="Last">»</button>';
        tbl.parentNode.insertBefore(pager, tbl.nextSibling);
        inst.pager = pager;
        pager.addEventListener('click', function(e){
          var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
          if (!act) return;
          var total = inst.filtered.length;
          var pgs = inst.pageSize === 0 ? 1 : Math.max(1, Math.ceil(total / inst.pageSize));
          if (act === 'first') inst.page = 1;
          else if (act === 'prev') inst.page = Math.max(1, inst.page - 1);
          else if (act === 'next') inst.page = Math.min(pgs, inst.page + 1);
          else if (act === 'last') inst.page = pgs;
          render();
        });
      }
      // Sortable headers
      if (opts.sort !== false) {
        for (var i = 0; i < headerCells.length; i++) {
          (function(idx, th){
            if (th.dataset && th.dataset.noSort === '1') return;
            th.classList.add('enh-sort');
            th.addEventListener('click', function(){
              if (inst.sortIdx === idx) {
                inst.sortDir = inst.sortDir === 'asc' ? 'desc' : (inst.sortDir === 'desc' ? null : 'asc');
                if (!inst.sortDir) inst.sortIdx = -1;
              } else {
                inst.sortIdx = idx;
                inst.sortDir = 'asc';
              }
              for (var j = 0; j < headerCells.length; j++) {
                if (j !== inst.sortIdx) headerCells[j].removeAttribute('data-dir');
              }
              if (inst.sortDir && inst.sortIdx >= 0) headerCells[inst.sortIdx].setAttribute('data-dir', inst.sortDir);
              else if (inst.sortIdx >= 0) headerCells[inst.sortIdx].removeAttribute('data-dir');
              apply();
            });
          })(i, headerCells[i]);
        }
      }
    }

    function apply(){
      var q = '';
      if (inst.bar) {
        var fi = inst.bar.querySelector('.enh-filter');
        if (fi) q = fi.value.toLowerCase().trim();
      }
      inst.filtered = q ? inst.allRows.filter(function(r){ return visibleCellText(r).indexOf(q) >= 0; }) : inst.allRows.slice();
      if (inst.sortIdx >= 0 && inst.sortDir) {
        var idx = inst.sortIdx, dir = inst.sortDir;
        inst.filtered.sort(function(a, b){
          return cmpCells(cellSortText(a.cells[idx]), cellSortText(b.cells[idx]), dir);
        });
      }
      render();
    }

    function render(){
      var total = inst.filtered.length;
      var ps = inst.pageSize;
      var pages = ps === 0 ? 1 : Math.max(1, Math.ceil(total / ps));
      if (inst.page > pages) inst.page = pages;
      if (inst.page < 1) inst.page = 1;
      var slice = ps === 0 ? inst.filtered : inst.filtered.slice((inst.page - 1) * ps, inst.page * ps);
      while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
      slice.forEach(function(r){ tbody.appendChild(r); });
      if (inst.bar) {
        var info = inst.bar.querySelector('.enh-info');
        if (info) {
          var base = (total === inst.allRows.length) ? (total + ' row' + (total === 1 ? '' : 's')) : (total + ' of ' + inst.allRows.length + ' rows');
          if (ps !== 0 && total > 0 && total > ps) {
            var startN = (inst.page - 1) * ps + 1;
            var endN = Math.min(total, inst.page * ps);
            base += ' · ' + startN + '–' + endN;
          }
          info.textContent = base;
        }
      }
      if (inst.pager) {
        var pi = inst.pager.querySelector('.enh-pager-info');
        if (pi) pi.textContent = 'Page ' + inst.page + ' / ' + pages;
        var firstBtn = inst.pager.querySelector('[data-act="first"]');
        var prevBtn  = inst.pager.querySelector('[data-act="prev"]');
        var nextBtn  = inst.pager.querySelector('[data-act="next"]');
        var lastBtn  = inst.pager.querySelector('[data-act="last"]');
        if (firstBtn) firstBtn.disabled = inst.page <= 1;
        if (prevBtn)  prevBtn.disabled  = inst.page <= 1;
        if (nextBtn)  nextBtn.disabled  = inst.page >= pages;
        if (lastBtn)  lastBtn.disabled  = inst.page >= pages;
        inst.pager.style.display = (ps === 0 || pages <= 1) ? 'none' : '';
      }
    }

    apply();
  };

  function autoEnhance(root){
    (root || document).querySelectorAll('table.enh-table-full').forEach(function(t){
      if (!t.__enh) window.enhanceTable(t, { sort:true, filter:true, paginate:true, pageSize: parseInt(t.dataset.pageSize || '10', 10) });
    });
    (root || document).querySelectorAll('table.enh-table-sort-filter').forEach(function(t){
      if (!t.__enh) window.enhanceTable(t, { sort:true, filter:true, paginate:false });
    });
  }
  window.autoEnhanceTables = autoEnhance;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ autoEnhance(); });
  else autoEnhance();
})();
`;
}


/**
 * Shared favicon link tag (OM icon for browser tab).
 * Include once per page inside <head>.
 */
function faviconLink() {
  return `<link rel="icon" type="image/png" href="data:image/png;base64,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"/>`;
}

/**
 * CSS for the custom modal system (alert, confirm, prompt replacements).
 */
function modalCSS() {
  return `
    .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.15s;pointer-events:none;}
    .modal-overlay.active{opacity:1;pointer-events:all;}
    .modal-box{background:#0d1320;border:1px solid #1a2236;border-radius:14px;padding:28px 24px 22px;width:400px;max-width:90vw;box-shadow:0 8px 40px rgba(0,0,0,0.6);transform:scale(0.95);transition:transform 0.15s;}
    .modal-overlay.active .modal-box{transform:scale(1);}
    .modal-icon{font-size:1.6rem;text-align:center;margin-bottom:10px;}
    .modal-title{font-size:0.9rem;font-weight:700;color:#e0eaf8;text-align:center;margin-bottom:6px;}
    .modal-msg{font-size:0.76rem;color:#6a8ab0;text-align:center;line-height:1.6;margin-bottom:18px;white-space:pre-line;}
    .modal-input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #1a2a40;background:#070d18;color:#e0eaf8;font-size:0.82rem;font-family:inherit;outline:none;margin-bottom:16px;transition:border-color 0.15s;}
    .modal-input:focus{border-color:#3b82f6;}
    .modal-btns{display:flex;gap:10px;justify-content:center;}
    .modal-btn{padding:9px 22px;border-radius:8px;font-size:0.78rem;font-weight:700;font-family:inherit;cursor:pointer;border:1px solid;transition:all 0.12s;}
    .modal-btn-primary{background:#1e40af;border-color:#1e40af;color:#fff;}
    .modal-btn-primary:hover{background:#2563eb;}
    .modal-btn-danger{background:#7f1d1d;border-color:#7f1d1d;color:#fff;}
    .modal-btn-danger:hover{background:#991b1b;}
    .modal-btn-cancel{background:transparent;border-color:#1a2a40;color:#6a8ab0;}
    .modal-btn-cancel:hover{border-color:#3a5070;color:#a0c0e0;}
    .modal-btn-success{background:#065f46;border-color:#065f46;color:#fff;}
    .modal-btn-success:hover{background:#047857;}

    /* ── MODAL LIGHT THEME ── */
    :root[data-theme="light"] .modal-overlay { background:rgba(0,0,0,0.3); }
    :root[data-theme="light"] .modal-box { background:#ffffff; border-color:#e0e4ea; box-shadow:0 8px 40px rgba(0,0,0,0.15); }
    :root[data-theme="light"] .modal-title { color:#1e293b; }
    :root[data-theme="light"] .modal-msg { color:#4b5769; }
    :root[data-theme="light"] .modal-input { background:#f8fafc; border-color:#e0e4ea; color:#1e293b; }
    :root[data-theme="light"] .modal-input:focus { border-color:#3b82f6; }
    :root[data-theme="light"] .modal-btn-cancel { border-color:#e0e4ea; color:#4b5769; }
    :root[data-theme="light"] .modal-btn-cancel:hover { border-color:#94a3b8; color:#334155; }
  `;
}

/**
 * JS for the custom modal system + API_SECRET session helper.
 * Include once per page inside <script>.
 */
/**
 * Light-theme runtime: sets data-theme, injects the light stylesheet, and
 * re-maps dark hexes in both rule declarations and inline styles. Self-guarded,
 * so emitting it more than once on a page is harmless.
 */
function themeJS() {
  return `
// ── Theme overriding ────────────────────────────────────────────────────────
// Emitted by BOTH modalJS() and buildSidebar(), so a page gets it whichever of
// the two it uses. The guard makes the second copy a no-op.
if (!window.__ltInit) {
window.__ltInit = true;
(function(){
  if ('${resolveTheme()}' !== 'light') return;
  document.documentElement.setAttribute('data-theme', 'light');

  // ── Force body style immediately ──
  document.body.style.setProperty('background', '#f4f6f9', 'important');
  document.body.style.setProperty('color', '#334155', 'important');

  // ── Inject light-theme CSS at END of <head> to guarantee cascade wins ──
  var _ltStyle = document.createElement('style');
  _ltStyle.id = 'light-theme-force';
  _ltStyle.textContent = [
    'body{background:#f4f6f9!important;color:#334155!important;}',
    '.main-content{background:#f4f6f9!important;}',
    '.page{color:#334155!important;}',
    '.top-bar{background:#fff!important;border-bottom-color:#e0e4ea!important;}',
    '.top-bar-title{color:#1e293b!important;}',
    '.top-bar-meta{color:#5c6b7f!important;}',
    'h1{color:#1e293b!important;}',
    '.page-title{color:#1e293b!important;}',
    '.subtitle,.page-subtitle,.page-sub{color:#5c6b7f!important;}',
    '.sc{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,.06)!important;}',
    '.sc-label,.cap-label{color:#4b5769!important;}',
    '.sc-val{color:#1e293b!important;}',
    '.sc-sub{color:#5c6b7f!important;}',
    '.section-title{color:#4b5769!important;}',
    '.section-title::after{background:#e0e4ea!important;}',
    'table th{color:#4b5769!important;background:#f1f5f9!important;}',
    'table td{border-color:#e0e4ea!important;}',
    'table tr{border-color:#e0e4ea!important;}',
    'tbody tr:hover{background:#f8fafc!important;}',
    // Cards & panels
    '.card,.box,.err-box,.confirm-box,.panel,.chart-wrap,.session-card,.ana-card,.ana-mini,.log-box,.capital-strip{background:#fff!important;border-color:#e0e4ea!important;}',
    '.metric{background:#f8fafc!important;border-color:#e0e4ea!important;}',
    '.session-head{background:#f8fafc!important;border-bottom-color:#e0e4ea!important;}',
    '.run-bar{background:#f8fafc!important;border-color:#e0e4ea!important;}',
    // Text colors
    '.panel-title,.chart-title,.diff-title,.session-name{color:#1e293b!important;}',
    '.metric-label,.cap-label,.proc-title,.stat-label,.chart-title-text,.ana-card h3,.ana-mini h3{color:#4b5769!important;}',
    '.metric-val,.cap-val,.stat-value,.proc-item .pi-val{color:#1e293b!important;}',
    '.metric-sub,.cap-sub,.no-data{color:#5c6b7f!important;}',
    '.cap-val.white{color:#1e293b!important;}',
    '.cap-val.green{color:#166534!important;}',
    // Tables (compare, diff, day, history, data)
    '.diff-table th,.day-table th,.data-table th,.summary-table th,.holiday-table th,.ana-tbl th,.tbl th{color:#4b5769!important;border-bottom-color:#e0e4ea!important;background:#f1f5f9!important;}',
    '.diff-table td,.day-table td,.data-table td,.summary-table td,.ana-tbl td,.tbl td{border-color:#e0e4ea!important;color:#334155!important;}',
    '.diff-table .neutral{color:#334155!important;}',
    '.diff-table tr:hover,.day-table tr:hover,.ana-tbl tr:hover{background:#f8fafc!important;}',
    // Cap cells
    '.cap-cell{border-right-color:#e0e4ea!important;}',
    // Stat cards for monitor
    '.stat-card,.chart-card,.proc-card{background:#fff!important;border-color:#e0e4ea!important;}',
    '.stat-sub,.proc-item .pi-label{color:#5c6b7f!important;}',
    '.bar-track{background:#e2e8f0!important;}',
    // Logs
    '.toolbar{background:#fff!important;border-bottom-color:#e0e4ea!important;}',
    '.log-wrap{background:#fff!important;}',
    '.log-row{border-bottom-color:#f1f5f9!important;}',
    '#search{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}',
    // Export/action btns
    '.export-btn,.copy-btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#4b5769!important;}',
    // Broker badges
    '.broker-badges{background:#fff!important;border-bottom-color:#e0e4ea!important;}',
    '.broker-badge.ok{background:#eff6ff!important;border-color:#bfdbfe!important;color:#1d4ed8!important;}',
    '.broker-badge.err{background:#fef2f2!important;border-color:#fecaca!important;color:#b91c1c!important;}',
    // Accents that were tuned for the dark surface and fail on a light one.
    // These are class rules, so the inline-style rewriter never sees them.
    '.card .val,#status-text{color:#1e293b!important;}',
    '.mode-ema_rsi_st{color:#1d4ed8!important;}',
    '.mode-bb_rsi{color:#b45309!important;}',
    '.mode-pa{color:#6d28d9!important;}',
    '.mode-orb{color:#047857!important;}',
    '.mode-ema9vwap{color:#0e7490!important;}',
    '.mode-trend_pb{color:#be185d!important;}',
    '.mode-gaps{color:#0369a1!important;}',
    '.mode-trend_day_scalp{color:#6d28d9!important;}',
    '.mode-gap_fix_3m{color:#0369a1!important;}',
    '.mode-rsi_pivot_st{color:#c2410c!important;}',
    '.brk-action,.brk-action.re-login{color:#1d4ed8!important;}',
    '.brk-wallet-sub .zero,.pnl-flat,.ms-caret,.log-time,.da-empty,.bc-link,.tbar label,.pager label,.run-bar label,#dashRange label{color:#4b5769!important;}',
    '#da-mode-badge{color:#1d4ed8!important;}',
    '.rh-meta b,.page-sub a{color:#0369a1!important;}',
    '.reset-btn{color:#b91c1c!important;}',
    // Selection
    '::selection{background:#bfdbfe!important;color:#1e293b!important;}',
  ].join('\\n');
  document.head.appendChild(_ltStyle);

  // ── Light-theme inline style rewriter ──────────────────────────────────────
  // Maps dark hex colors → light equivalents for inline style="" attributes.
  var bgMap = {
    '#080c14':'#f4f6f9','#040c18':'#f4f6f9','#030b18':'#f4f6f9',
    '#0d1320':'#ffffff','#07111f':'#ffffff','#070d18':'#f8fafc',
    '#0a0f1c':'#f1f5f9','#06101a':'#ffffff','#0a1528':'#f8fafc',
    '#08091a':'#ffffff','#0d1117':'#ffffff','#090f09':'#ffffff',
    '#0c0c18':'#f8fafc','#0a0a12':'#f8fafc','#0e0e1e':'#f1f5f9',
    '#0a0f14':'#f8fafc','#060910':'#f4f6f9','#040c18':'#f4f6f9',
    '#0a0e18':'#f8fafc','#060c18':'#f4f6f9','#04060e':'#f4f6f9',
    '#0a1020':'#ffffff','#0a1628':'#ffffff','#0e1c33':'#f1f5f9',
    '#0c4a6e':'#e0f2fe','#0d1f17':'#f0fdf4','#1e293b':'#f1f5f9',
    '#10131c':'#f8fafc','#0a1f12':'#f0fdf4',
    '#0d1a2a':'#f8fafc','#101828':'#f8fafc',
    '#050d1a':'#f4f6f9','#060810':'#f4f6f9','#060c1a':'#f4f6f9',
    '#080e1a':'#f8fafc','#0a1220':'#f8fafc','#0a1424':'#f8fafc',
    '#0a1a2a':'#f8fafc','#0d1726':'#f8fafc','#0f1117':'#ffffff',
    '#0f172a':'#f8fafc','#111827':'#f8fafc','#04090f':'#f4f6f9',
    '#06090e':'#f4f6f9','#060a14':'#f4f6f9','#0a120a':'#f4f6f9',
    '#0d0e00':'#fffbeb','#080700':'#fffbeb','#1a1200':'#fffbeb',
    '#1c1400':'#fffbeb','#1c0d00':'#fffbeb','#120e00':'#fffbeb',
    '#1a1a2e':'#f1f5f9','#1a1f2e':'#f1f5f9','#0e1828':'#f1f5f9',
    '#0e1a28':'#f1f5f9','#0a0c1a':'#f8fafc','#0a0d1a':'#f8fafc','#080a16':'#f1f5f9',
    // Green-tinted dark backgrounds → light green
    '#071a12':'#f0fdf4','#04100a':'#f0fdf4','#071e0f':'#f0fdf4',
    '#072014':'#f0fdf4','#060e06':'#f0fdf4','#0a1f0a':'#f0fdf4',
    '#0a2a0a':'#f0fdf4','#0a3018':'#dcfce7','#0d3018':'#dcfce7',
    '#0d3020':'#dcfce7','#0d3a18':'#dcfce7','#06180e':'#dcfce7',
    '#0d2a14':'#dcfce7','#06100e':'#f0fdf4','#134e35':'#dcfce7',
    '#064e3b':'#d1fae5','#065f46':'#d1fae5','#166534':'#bbf7d0',
    // Blue-tinted dark backgrounds → light blue
    '#07112e':'#eff6ff','#071428':'#eff6ff','#0a1e3d':'#dbeafe',
    '#0d2040':'#dbeafe','#0e2850':'#dbeafe','#0e2860':'#dbeafe',
    '#071a3e':'#dbeafe','#1d3b6e':'#dbeafe','#1e40af':'#2563eb',
    '#0e2045':'#dbeafe',
    // Red-tinted dark backgrounds → light red
    '#100408':'#fef2f2','#0a0408':'#fef2f2','#0c0608':'#fef2f2',
    '#120608':'#fef2f2','#150608':'#fef2f2','#160608':'#fef2f2',
    '#180508':'#fef2f2','#100508':'#fef2f2','#200708':'#fef2f2',
    '#200810':'#fef2f2','#1c0610':'#fee2e2','#2d0a0a':'#fee2e2',
    '#3a0f1c':'#fecaca','#3a1010':'#fecaca','#3a1020':'#fecaca',
    '#1a0505':'#fef2f2','#1a0508':'#fef2f2','#1a0707':'#fef2f2',
    '#2a0810':'#fef2f2','#2d1515':'#fee2e2','#3a1a1a':'#fee2e2',
    '#3b0a0a':'#fee2e2','#1c1017':'#fef2f2',
    // Orange/yellow dark backgrounds → light amber
    '#2a1600':'#fffbeb','#2d1600':'#fffbeb','#2d1800':'#fffbeb',
    '#2d1000':'#fffbeb','#3a2a00':'#fef9c3',
    // Purple-tinted dark → light purple
    '#0e0a28':'#f5f3ff','#1e0a3d':'#f5f3ff','#1e1550':'#ede9fe',
    '#252550':'#ede9fe','#060e20':'#eff6ff','#060e1c':'#eff6ff',
  };

  var textMap = {
    '#e0eaf8':'#1e293b','#c8d8f0':'#334155','#c0d8b0':'#1e293b',
    // The dark skin paints muted text in two tiers (#8ba1c2 normal, #6d85a8 dim);
    // both map onto light tiers that clear 4.5:1 on #f4f6f9. The pre-ramp hexes
    // stay listed so a page that still carries an old inline colour is covered.
    '#8ba1c2':'#5c6b7f','#6d85a8':'#5c6b7f','#7f9b5c':'#4d6b2e',
    '#4a6080':'#4b5769','#3a5070':'#5c6b7f','#2a4060':'#5c6b7f',
    '#1e3050':'#5c6b7f','#1a3050':'#5c6b7f','#3a5878':'#4b5769',
    '#6a8ab0':'#4b5769','#a0c0e0':'#334155','#8aa1bd':'#4b5769',
    '#2a3a50':'#5c6b7f','#2a3a52':'#5c6b7f',
    '#3a4060':'#5c6b7f','#4a5878':'#5c6b7f','#2a6080':'#4b5769',
    '#1e2940':'#4b5769','#1e2a40':'#4b5769','#a0b8d8':'#334155','#2a3c5a':'#4b5769',
    '#c0d8b0':'#1e293b','#a0c880':'#166534','#2a3a20':'#4b5769','#e2e8f0':'#1e293b',
    // Bright colors → darker for light bg
    '#60a5fa':'#1d4ed8','#34d399':'#047857','#f87171':'#b91c1c',
    '#fbbf24':'#92400e','#a78bfa':'#6d28d9','#4ade80':'#166534',
    '#818cf8':'#4f46e5','#f6ad55':'#c2410c','#fbd38d':'#b45309',
    '#f59e0b':'#92400e','#5b8dff':'#1d4ed8','#22d3ee':'#0e7490',
    '#10b981':'#047857','#ef4444':'#b91c1c','#3b82f6':'#1d4ed8',
    '#22c55e':'#15803d','#4a9cf5':'#1d4ed8','#7dd3fc':'#0369a1',
    '#06b6d4':'#0e7490','#0ea5e9':'#0369a1','#38bdf8':'#0369a1',
    '#a855f7':'#6d28d9','#ec4899':'#be185d','#c084fc':'#7e22ce',
    '#7d8aa3':'#4b5769','#86efac':'#166534','#93c5fd':'#1d4ed8',
    '#e5e7eb':'#334155','#cbd5e1':'#475569','#94a3b8':'#5c6b7f',
    '#6ee7b7':'#047857','#fb923c':'#c2410c','#8b5cf6':'#6d28d9',
    '#eab308':'#854d0e','#facc15':'#854d0e','#2dd4bf':'#0f766e',
    '#a3b8d0':'#334155','#93a9c9':'#475569','#6b7fa0':'#4b5769',
    '#a8bcd8':'#334155','#9333ea':'#7e22ce','#db2777':'#be185d',
    '#f472b6':'#be185d','#16a34a':'#166534','#9aa9c2':'#4b5769',
  };

  var borderMap = {
    '#0e1e36':'#e0e4ea','#1a2236':'#e0e4ea','#1a2a40':'#e0e4ea',
    '#0e1428':'#e0e4ea','#1a2640':'#e0e4ea','#1e1e36':'#e2e8f0',
    '#1a3a6a':'#bfdbfe','#1e3a5a':'#cbd5e1','#1e3a5f':'#cbd5e1',
    '#1a3a8a':'#93c5fd','#162416':'#d1fae5','#0e3018':'#86efac',
    '#0e4020':'#86efac','#134e35':'#86efac','#0e2850':'#93c5fd',
    '#0e2860':'#93c5fd','#0e2045':'#93c5fd','#0d2545':'#93c5fd',
    '#0d3a1e':'#86efac','#500e20':'#fca5a5','#3a0f1c':'#fca5a5',
    '#3a1020':'#fca5a5','#5a1010':'#fca5a5','#3a0d12':'#fca5a5',
    '#243048':'#cbd5e1','#253347':'#334155','#2a2a48':'#e2e8f0',
    '#1a2a18':'#d1fae5','#1a2a3a':'#e0e4ea','#1a4080':'#93c5fd',
    '#312e0f':'#fcd34d','#2a3446':'#e0e4ea','#0d4030':'#86efac',
  };

  function rewriteInlineStyles() {
    var els = document.querySelectorAll('[style]');
    for (var i = 0; i < els.length; i++) {
      var s = els[i].getAttribute('style');
      if (!s) continue;
      var orig = s;
      // Replace backgrounds
      s = s.replace(/background\\s*:\\s*(#[0-9a-fA-F]{6})/gi, function(m, hex) {
        var l = hex.toLowerCase();
        return bgMap[l] ? 'background:' + bgMap[l] : m;
      });
      // Replace text colors (not border-color)
      s = s.replace(/(^|[;}\\s])color\\s*:\\s*(#[0-9a-fA-F]{6})/gi, function(m, pre, hex) {
        var l = hex.toLowerCase();
        return textMap[l] ? pre + 'color:' + textMap[l] : m;
      });
      // Replace border colors
      s = s.replace(/border[^:]*:\\s*[^;]*?(#[0-9a-fA-F]{6})/gi, function(m, hex) {
        var l = hex.toLowerCase();
        return borderMap[l] ? m.replace(hex, borderMap[l]) : m;
      });
      if (s !== orig) els[i].setAttribute('style', s);

      // The attribute pass above only sees #rrggbb. Anything the page later set
      // through el.style.* is serialised by the browser as rgb(...), so it never
      // matched — that is how a panel kept its dark background while its text
      // was remapped. _mapDecl reads the parsed value, so it covers both forms.
      _mapDecl(els[i].style, 'color', textMap);
      _mapDecl(els[i].style, 'background-color', bgMap);
      for (var k = 0; k < _SIDES.length; k++) _mapDecl(els[i].style, _SIDES[k], borderMap);
    }
  }

  // ── Light-theme stylesheet rewriter ────────────────────────────────────────
  // The inline pass above only reaches style="" attributes. Every colour a page
  // sets through its own <style> block — strategy accents, panel badges, card
  // titles, "no data" text — was invisible to it, so those kept their dark-skin
  // value on a light background. Walking the CSSOM once at load applies the same
  // three maps to rule declarations, which is what makes the light theme hold on
  // pages nobody wrote a :root[data-theme="light"] block for.
  //
  // Declarations are set through setProperty with the original priority so an
  // !important rule stays !important and the cascade is unchanged — only the
  // colour value moves.
  var _SIDES = ['border-top-color','border-right-color','border-bottom-color','border-left-color'];

  function _hexOf(v) {
    var m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(v || '');
    if (!m) return null;
    function h(n) { n = (+n).toString(16); return n.length < 2 ? '0' + n : n; }
    return ('#' + h(m[1]) + h(m[2]) + h(m[3])).toLowerCase();
  }

  function _mapDecl(st, prop, map) {
    var hex = _hexOf(st.getPropertyValue(prop));
    if (!hex || !map[hex]) return;
    st.setProperty(prop, map[hex], st.getPropertyPriority(prop));
  }

  function _walkRules(rules) {
    for (var j = 0; j < rules.length; j++) {
      var r = rules[j];
      // Since CSS nesting shipped, a plain CSSStyleRule also exposes a (usually
      // empty) .cssRules list — so this cannot be an if/else against a grouping
      // rule. Map this rule's own declarations first, then descend into any
      // children it actually has (@media, @supports, nested blocks).
      if (r.style && r.selectorText &&
          // Rules already written for this theme hold the light values —
          // remapping them would send the colour back the other way.
          r.selectorText.indexOf('data-theme="light"') < 0 &&
          // The drawer stays dark in the light skin (see .sidebar above), so its
          // text must keep the dark-theme values.
          !/(^|[\s,>+~])(\.sb-|\.sidebar|#main-sidebar)/.test(r.selectorText)) {
        _mapDecl(r.style, 'color', textMap);
        _mapDecl(r.style, 'background-color', bgMap);
        for (var k = 0; k < _SIDES.length; k++) _mapDecl(r.style, _SIDES[k], borderMap);
      }
      if (r.cssRules && r.cssRules.length) _walkRules(r.cssRules);
    }
  }

  // A sheet is only walked once — re-walking is wasted work, and a second pass
  // over an already-mapped rule could match a value that is itself a map key.
  var _ltSeenSheets = [];
  function rewriteStyleSheets() {
    var sheets = document.styleSheets;
    window.__ltSheetsWalked = window.__ltSheetsWalked || 0;
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      var owner = sheet.ownerNode;
      if (owner && owner.id === 'light-theme-force') continue;  // already light
      if (_ltSeenSheets.indexOf(sheet) >= 0) continue;
      var rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }   // cross-origin (fonts)
      if (!rules) continue;
      _ltSeenSheets.push(sheet);
      _walkRules(rules);
      window.__ltSheetsWalked++;
    }
  }

  function rewriteAll() { rewriteStyleSheets(); rewriteInlineStyles(); }

  // Sheets can be parsed after this script runs (a <style> further down the
  // document, or a late <link>), so sweep at each point where the set can have
  // grown. rewriteStyleSheets skips anything it has already walked.
  rewriteAll();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rewriteAll);
  }
  window.addEventListener('load', rewriteAll);
  // Re-run on dynamic content changes (socket updates, etc.)
  var _ltObs = new MutationObserver(function(mutations) {
    var needsRewrite = false;
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].type === 'childList' && mutations[i].addedNodes.length) {
        needsRewrite = true; break;
      }
    }
    if (needsRewrite) rewriteInlineStyles();
  });
  _ltObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
}
`;
}

function modalJS() {
  return `
// ── Modal System ────────────────────────────────────────────────────────────
// Guard: only create overlay once (safe when modalJS is injected multiple times on a page)
(function(){
  if (document.getElementById('modal-overlay')) return;
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'modal-overlay';
  ov.innerHTML = '<div class="modal-box" id="modal-box"></div>';
  document.body.appendChild(ov);
  // Backdrop click — dismiss modal (click on overlay, not the box)
  ov.addEventListener('click', function(e) {
    if (e.target === ov) {
      _hideModal();
      if (_modalResolve) { _modalResolve(null); _modalResolve = null; }
    }
  });
})();

// Guard: only define functions once
if (typeof _showModal === 'undefined') {

var _modalResolve = null; // current modal's resolve callback

function _showModal(html) {
  var ov = document.getElementById('modal-overlay');
  var box = document.getElementById('modal-box');
  box.innerHTML = html;
  ov.classList.add('active');
  var inp = box.querySelector('.modal-input');
  if (inp) setTimeout(function(){ inp.focus(); }, 50);
}

function _hideModal() {
  var ov = document.getElementById('modal-overlay');
  if (ov) ov.classList.remove('active');
}

function showAlert(opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    _modalResolve = function(){ resolve(); };
    _showModal(
      '<div class="modal-icon">' + (opts.icon || 'ℹ️') + '</div>'
      + (opts.title ? '<div class="modal-title">' + opts.title + '</div>' : '')
      + '<div class="modal-msg">' + (opts.message || '') + '</div>'
      + '<div class="modal-btns"><button class="modal-btn ' + (opts.btnClass || 'modal-btn-primary') + '" id="modal-ok-btn">' + (opts.btnText || 'OK') + '</button></div>'
    );
    document.getElementById('modal-ok-btn').onclick = function(){ _hideModal(); _modalResolve(); };
  });
}

function showConfirm(opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    _modalResolve = function(v){ resolve(v); };
    _showModal(
      '<div class="modal-icon">' + (opts.icon || '⚠️') + '</div>'
      + '<div class="modal-title">' + (opts.title || 'Confirm') + '</div>'
      + '<div class="modal-msg">' + (opts.message || 'Are you sure?') + '</div>'
      + '<div class="modal-btns">'
      + '<button class="modal-btn modal-btn-cancel" id="modal-cancel-btn">' + (opts.cancelText || 'Cancel') + '</button>'
      + '<button class="modal-btn ' + (opts.confirmClass || 'modal-btn-danger') + '" id="modal-confirm-btn">' + (opts.confirmText || 'Yes') + '</button>'
      + '</div>'
    );
    document.getElementById('modal-cancel-btn').onclick = function(){ _hideModal(); _modalResolve(false); };
    document.getElementById('modal-confirm-btn').onclick = function(){ _hideModal(); _modalResolve(true); };
  });
}

// Two-step confirmation for irreversible delete / reset actions.
// First step shows the caller's opts (same shape as showConfirm). If accepted,
// shows a stricter "Are you absolutely sure?" step before resolving true.
// A short subject string can be passed in opts.subject to interpolate into
// the second-step message (e.g. "EMA_RSI_ST · 2026-05-12").
// NOTE: async function declarations are block-scoped even in sloppy mode
// (Annex B hoisting applies only to regular function declarations), so we
// use a var + async function expression so this helper is reachable from
// onclick handlers defined outside this guard block.
var showDoubleConfirm = async function(opts) {
  opts = opts || {};
  var first = await showConfirm(opts);
  if (!first) return false;
  var subject = opts.subject ? '\\n\\n' + opts.subject : '';
  var second = await showConfirm({
    icon: '⚠️',
    title: 'Confirm again',
    message: 'Are you absolutely sure? This cannot be undone.' + subject,
    cancelText: 'Cancel',
    confirmText: opts.secondConfirmText || 'Yes, proceed',
    confirmClass: 'modal-btn-danger',
  });
  return !!second;
};

function showPrompt(opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    _modalResolve = function(v){ resolve(v); };
    _showModal(
      '<div class="modal-icon">' + (opts.icon || '🔑') + '</div>'
      + (opts.title ? '<div class="modal-title">' + opts.title + '</div>' : '')
      + (opts.message ? '<div class="modal-msg">' + opts.message + '</div>' : '')
      + '<input type="' + (opts.inputType || 'password') + '" class="modal-input" id="modal-input" placeholder="' + (opts.placeholder || '') + '">'
      + '<div class="modal-btns">'
      + '<button class="modal-btn modal-btn-cancel" id="modal-cancel-btn">Cancel</button>'
      + '<button class="modal-btn modal-btn-primary" id="modal-ok-btn">Submit</button>'
      + '</div>'
    );
    var inp = document.getElementById('modal-input');
    inp.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); _hideModal(); _modalResolve(inp.value); } });
    document.getElementById('modal-cancel-btn').onclick = function(){ _hideModal(); _modalResolve(null); };
    document.getElementById('modal-ok-btn').onclick = function(){ _hideModal(); _modalResolve(inp.value); };
  });
}

// ── Idle timeout — auto-logout after 15 min of no activity ──────────────────
(function(){
  if (!window.__LOGIN_GATE_ACTIVE) return;
  var IDLE_MS = 15 * 60 * 1000;
  var WARN_MS = 14 * 60 * 1000;
  var _idleTimer = null;
  var _warnTimer = null;
  var _loggedOut = false;

  function resetIdle() {
    if (_loggedOut) return;
    clearTimeout(_idleTimer);
    clearTimeout(_warnTimer);
    _warnTimer = setTimeout(onWarn, WARN_MS);
    _idleTimer = setTimeout(onIdle, IDLE_MS);
  }

  function onWarn() {
    if (_loggedOut) return;
    showAlert({
      icon: '⏰', title: 'Session Expiring',
      message: 'You will be logged out in 1 minute due to inactivity.\\nMove your mouse or press a key to stay logged in.',
      btnText: 'Stay Logged In', btnClass: 'modal-btn-success'
    }).then(function() { resetIdle(); });
  }

  function onIdle() {
    _loggedOut = true;
    showAlert({
      icon: '🔒', title: 'Session Expired',
      message: 'Logged out due to 15 minutes of inactivity.',
      btnText: 'Login Again', btnClass: 'modal-btn-primary'
    }).then(function() { window.location.href = '/logout'; });
    setTimeout(function() { window.location.href = '/logout'; }, 5000);
  }

  // Throttled activity tracker — resets idle timer at most once per 200ms
  var _throttle = null;
  function onActivity() {
    if (_loggedOut || _throttle) return;
    _throttle = setTimeout(function() { _throttle = null; }, 200);
    resetIdle();
  }

  ['mousemove','mousedown','keydown','touchstart','scroll','click'].forEach(function(evt) {
    document.addEventListener(evt, onActivity, { passive: true });
  });

  resetIdle();
})();

} // end guard: typeof _showModal === 'undefined'

// ── API_SECRET session helper (outside guard — must always be defined) ─────
function getApiSecret() { return sessionStorage.getItem('__api_secret') || ''; }
function setApiSecret(val) { sessionStorage.setItem('__api_secret', val); }

async function askApiSecret() {
  var stored = getApiSecret();
  if (stored) return stored;
  var val = await showPrompt({
    icon: '🔐',
    title: 'API Secret Required',
    message: 'This action requires your API_SECRET.\\nIt will be remembered for this browser session.',
    placeholder: 'Enter API_SECRET from .env',
    inputType: 'password'
  });
  if (val === null) return null;
  if (val) setApiSecret(val);
  return val || '';
}

async function secretFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  var secret = getApiSecret();
  if (secret) opts.headers['x-api-secret'] = secret;
  // Per-call timeout. Default 15s for normal API calls; long-running operations
  // (e.g. a full-day tick replay = tens of thousands of ticks, well over 15s)
  // pass a larger opts.timeoutMs, or 0 to disable the abort timer entirely.
  var timeoutMs = (opts.timeoutMs != null) ? opts.timeoutMs : 15000;
  var controller = new AbortController();
  var tid = (timeoutMs > 0) ? setTimeout(function(){ controller.abort(); }, timeoutMs) : null;
  opts.signal = controller.signal;
  var res;
  try { res = await fetch(url, opts); } finally { if (tid) clearTimeout(tid); }
  if (res.status === 403) {
    sessionStorage.removeItem('__api_secret');
    var isRetry = !!secret;
    if (isRetry) await showAlert({ icon: '🚫', title: 'Wrong API Secret', message: 'The API secret was incorrect. Please try again.', btnClass: 'modal-btn-danger' });
    secret = await askApiSecret();
    if (secret === null) return null;
    opts.headers['x-api-secret'] = secret;
    var c2 = new AbortController();
    var t2 = (timeoutMs > 0) ? setTimeout(function(){ c2.abort(); }, timeoutMs) : null;
    opts.signal = c2.signal;
    try { res = await fetch(url, opts); } finally { if (t2) clearTimeout(t2); }
  }
  return res;
}

// Replacement for buttons that used to do location.href = '/x/start'. Those
// routes require API_SECRET, and a browser navigation cannot carry the header —
// it just lands on a raw 403 JSON page. Send it through secretFetch instead
// (which prompts once per session), then reload so the page shows the new state.
// Returns false when the user cancels the secret prompt, so nothing changed.
async function secretGo(url, btn) {
  var label = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  var res = null;
  try {
    res = await secretFetch(url);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    await showAlert({ icon: '⚠️', title: 'Request failed', message: (e && e.message) || 'Network error', btnClass: 'modal-btn-danger' });
    return false;
  }
  if (!res) { if (btn) { btn.disabled = false; btn.textContent = label; } return false; }
  location.reload();
  return true;
}

${themeJS()}
`;
}

/* ── NIFTY Expiry & NSE Holidays modal ──────────────────────────────────────
 * One popup shared by Settings (📅 EXPIRY & HOLIDAYS button) and the Dashboard
 * (the "Next Expiry Date" top-bar pill). Kept here rather than copied per page
 * so the two never drift — the calendar is the same data on both.
 * Colours are literals, not CSS vars: the Dashboard has no :root var block.
 * A page must also include modalJS() (secretFetch + showAlert) for REFRESH.
 */
function expiryHolidayModalCSS() {
  return `
    /* ── Combined Expiry/Holidays modal tabs ───────────────── */
    .eh-tab-btn {
      background: transparent; border: 1px solid transparent; border-bottom: none;
      border-top-left-radius: 7px; border-top-right-radius: 7px;
      padding: 7px 14px; cursor: pointer; color: var(--muted-1,#8ba1c2);
      font-size: 0.72rem; font-weight: 700; font-family: 'IBM Plex Mono', monospace;
      letter-spacing: 0.4px; transition: all 0.15s; margin-bottom: -1px;
    }
    .eh-tab-btn:hover { color: #c8d8f0; }
    .eh-tab-btn.eh-tab-active {
      color: #22d3ee; border-color: #1a2640; border-bottom-color: #0d1117;
      background: #0d1117;
    }

    /* ── Holiday modal table ─────────────────────────────── */
    .holiday-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .holiday-table th {
      text-align: left; padding: 8px 10px; font-size: 0.65rem; text-transform: uppercase;
      letter-spacing: 1px; color: var(--muted-1,#8ba1c2); border-bottom: 1px solid #1a2236;
    }
    .holiday-table td {
      padding: 7px 10px; border-bottom: 1px solid #1a2236; color: #c8d8f0;
    }
    .holiday-table tr:last-child td { border-bottom: none; }
    .holiday-table tr:hover td { background: rgba(59,130,246,0.06); }
    .holiday-table .past-holiday { opacity: 0.4; }
    .holiday-table .today-holiday { color: #10b981; font-weight: 600; }
    .holiday-table .preponed { color: #f59e0b; }
    .holiday-table .monthly-row td { background: rgba(59,130,246,0.08); }
    .expiry-legend { display:flex; gap:16px; padding:10px 0 4px; font-size:0.68rem; color:var(--muted-1,#8ba1c2); flex-wrap:wrap; }
    .eh-source-note { padding:0 16px 12px; font-size:0.64rem; color:var(--muted-1,#8ba1c2); letter-spacing:0.3px; }
    /* Year divider — the calendar now runs past 31 Dec into the next year. */
    .holiday-table .year-row td {
      background:rgba(59,130,246,0.05); color:#60a5fa; font-size:0.66rem;
      letter-spacing:1px; font-weight:700; padding-top:10px;
    }
    .expiry-legend span { display:flex; align-items:center; gap:4px; }
    .expiry-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
    /* Two nested scroll containers: this list inside the .eh-modal backdrop.
       Without contain, flicking the list past its end scrolled the backdrop,
       and the backdrop past its end scrolled the page behind the popup. */
    .holiday-modal-body {
      max-height: 420px; overflow-y: auto; margin-top: 10px;
      scrollbar-width: thin; scrollbar-color: #243048 transparent;
      overscroll-behavior: contain;
    }
    /* Backdrop padding lives here rather than inline so the phone rule below can
       reclaim it — 40px/20px leaves a 353px-wide card on a 393px iPhone, which
       wraps "28 Jul 2026" onto two lines. */
    .eh-modal { padding: 40px 20px; overscroll-behavior: contain; }
    .eh-close { font-size: 1.2rem; }
    @media (max-width:640px) {
      .eh-modal { padding: 14px 6px; }
      .holiday-table { font-size: 0.72rem; }
      .holiday-table th { padding: 7px 6px; }
      /* Dates stay on one line; the body already scrolls sideways if the row
         still does not fit, so nothing gets cut off. */
      .holiday-table td { padding: 7px 6px; white-space: nowrap; }
      .holiday-modal-body { max-height: 62vh; }
      /* Fingers, not a mouse: close was 22px tall and the tabs 30px, against
         the 44px this repo uses everywhere else on phones. */
      .eh-close { min-width: 44px; min-height: 44px; font-size: 1.6rem; line-height: 1; }
      .eh-tab-btn { min-height: 44px; padding: 7px 16px; }
      #holiday-refresh-btn { min-height: 44px; }
    }
    /* Light theme. The global rewriter in modalJS() only covers .holiday-table
       TH (and borders), so the cell text, legend and scrollbar have to be
       restated here — without this the dark #c8d8f0 cell colour survives and
       the whole calendar reads as pale blue on white. */
    :root[data-theme="light"] .eh-tab-btn { color:#4b5769; }
    :root[data-theme="light"] .eh-tab-btn:hover { color:#334155; }
    /* The selected tab keeps its dark chip on both themes — that is how this
       popup has always looked. It needs its own light rule purely to win on
       specificity: the theme-scoped .eh-tab-btn rule above (0,3,0) otherwise
       outranks the plain .eh-tab-btn.eh-tab-active rule (0,2,0) and greys the
       cyan label out. */
    :root[data-theme="light"] .eh-tab-btn.eh-tab-active { color:#22d3ee; }
    :root[data-theme="light"] .holiday-table td { color:#334155; }
    :root[data-theme="light"] .holiday-table .today-holiday { color:#059669; }
    :root[data-theme="light"] .expiry-legend { color:#4b5769; }
    :root[data-theme="light"] .eh-source-note { color:#4b5769; }
    :root[data-theme="light"] .holiday-modal-body { scrollbar-color:#cbd5e1 transparent; }
  `;
}

function expiryHolidayModalHTML() {
  return `
<div id="expiryHolidaysModal" class="eh-modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;overflow-y:auto;" onclick="if(event.target===this)this.style.display='none'">
  <div style="max-width:640px;margin:0 auto;background:#0d1117;border:1px solid #1a2640;border-radius:12px;overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#111827;border-bottom:1px solid #1a2640;">
      <span style="font-weight:700;font-size:0.95rem;color:#22d3ee;">📅 NIFTY Expiry &amp; NSE Holidays</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="holiday-refresh-btn" type="button" onclick="refreshHolidays()" title="Force-refresh NSE holidays from upstream API" style="padding:5px 12px;background:rgba(34,211,238,0.12);color:#22d3ee;border:1px solid rgba(34,211,238,0.25);border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;letter-spacing:0.3px;">📅 REFRESH</button>
        <button class="eh-close" aria-label="Close" onclick="document.getElementById('expiryHolidaysModal').style.display='none'" style="background:none;border:none;color:var(--muted-1,#8ba1c2);cursor:pointer;">&times;</button>
      </div>
    </div>
    <div style="display:flex;gap:6px;padding:10px 16px 0;border-bottom:1px solid #1a2640;">
      <button id="ehBtn-expiry" type="button" onclick="showExpHolTab('expiry')" class="eh-tab-btn eh-tab-active">Expiry Calendar</button>
      <button id="ehBtn-holiday" type="button" onclick="showExpHolTab('holiday')" class="eh-tab-btn">NSE Holidays</button>
    </div>
    <!-- Expiry tab -->
    <div id="ehTab-expiry">
      <div style="padding:10px 16px 0;">
        <div class="expiry-legend">
          <span><span class="expiry-dot" style="background:#3b82f6;"></span> Monthly expiry</span>
          <span><span class="expiry-dot" style="background:#f59e0b;"></span> Preponed (holiday)</span>
        </div>
      </div>
      <div class="holiday-modal-body" style="padding:0 16px 16px;">
        <table class="holiday-table">
          <thead><tr><th>#</th><th>Expiry Date</th><th>Day</th><th>Type</th><th>Preponed To</th></tr></thead>
          <tbody id="expiryTableBody"></tbody>
        </table>
      </div>
    </div>
    <!-- Holiday tab -->
    <div id="ehTab-holiday" style="display:none;">
      <div class="holiday-modal-body" style="padding:12px 16px 4px;">
        <table class="holiday-table">
          <thead><tr><th>#</th><th>Date</th><th>Day</th><th>Holiday</th></tr></thead>
          <tbody id="holidayTableBody"></tbody>
        </table>
      </div>
      <!-- Where each year's list came from. Blank until the first load. -->
      <div id="holidaySourceNote" class="eh-source-note"></div>
    </div>
  </div>
</div>`;
}

function expiryHolidayModalJS() {
  return `
// ── NSE Holiday List Modal ──────────────────────────────────────────────────
// Holiday names come from the API (NSE's own "description"), never from a
// hardcoded MM-DD table — the lunar holidays (Holi, Diwali, Id …) move every
// year, so a table here would read blank or plain wrong from January onwards.
function _ehEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
  });
}

// "2027: not published by NSE yet" is worth saying out loud — an empty next
// year is exactly the failure this screen used to hide.
function _ehYearSource(year, s) {
  s = s || {};
  var days = s.count + (s.count === 1 ? ' day' : ' days');
  if (!s.count)              return year + ': not published by NSE yet';
  if (s.source === 'api')    return year + ': live from NSE · ' + days;
  if (s.source === 'disk')   return year + ': saved copy · ' + days;
  if (s.source === 'derived') return year + ': not published yet — fixed dates only (' + days + ')';
  return year + ': built-in list · ' + days;
}

function _ehSourceNote(data) {
  var el = document.getElementById('holidaySourceNote');
  if (!el) return;
  var src = (data && data.sources) || {};
  el.textContent = Object.keys(src).sort().map(function(y) {
    return _ehYearSource(y, src[y]);
  }).join('   ·   ');
}

async function loadHolidaysTable() {
  var body = document.getElementById('holidayTableBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted-1,#8ba1c2);padding:20px;">Loading holidays...</td></tr>';
  try {
    var res = await fetch('/api/holidays', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    _ehSourceNote(data);
    // Named list when the API supplies one; bare dates are the safety net.
    var list = (data.details && data.details.length)
      ? data.details.slice()
      : (data.holidays || []).map(function(d) { return { date: d, name: '—' }; });
    if (!data.success || !list.length) {
      body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted-1,#8ba1c2);padding:20px;">No holidays found</td></tr>';
      return;
    }
    var todayStr = new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"})).toISOString().split('T')[0];
    var rows = '';
    var n = 0;
    list.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }).forEach(function(h) {
      var d = h.date;
      if (d < todayStr) return; // hide past holidays
      var name = _ehEsc(h.name || '—');
      var dt = new Date(d + 'T00:00:00');
      var dayName = dt.toLocaleDateString('en-US', {weekday:'short'});
      var display = dt.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
      var cls = d === todayStr ? 'today-holiday' : '';
      n++;
      rows += '<tr class="' + cls + '"><td>' + n + '</td><td>' + display + '</td><td>' + dayName + '</td><td>' + name + '</td></tr>';
    });
    if (!n) rows = '<tr><td colspan="4" style="text-align:center;color:var(--muted-1,#8ba1c2);padding:20px;">No upcoming holidays</td></tr>';
    body.innerHTML = rows;
  } catch(e) {
    body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#ef4444;padding:20px;">Failed to load holidays</td></tr>';
  }
}

// ── NIFTY Expiry Calendar populator ─────────────────────────────────────────
async function loadExpiriesTable() {
  var body = document.getElementById('expiryTableBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted-1,#8ba1c2);padding:20px;">Loading expiry dates...</td></tr>';
  try {
    var res = await fetch('/api/expiry-dates', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data.success || !data.expiries || !data.expiries.length) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted-1,#8ba1c2);padding:20px;">No expiry dates found</td></tr>';
      return;
    }
    var yearEl = document.getElementById('expiryYearTitle');
    if (yearEl) yearEl.textContent = 'NIFTY Options Expiry Calendar ' + (data.years || [data.year]).join(' – ');
    var todayStr = new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"})).toISOString().split('T')[0];
    var rows = '';
    var n = 0;
    var lastYear = '';
    data.expiries.forEach(function(e) {
      if (e.date < todayStr) return; // hide past expiries
      // The list spans a year boundary now, so mark where the next year starts.
      var yr = e.date.slice(0, 4);
      if (lastYear && yr !== lastYear) {
        rows += '<tr class="year-row"><td colspan="5">' + yr + '</td></tr>';
      }
      lastYear = yr;
      var dt = new Date(e.date + 'T00:00:00');
      var display = dt.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
      var dayName = dt.toLocaleDateString('en-US', {weekday:'short'});
      var type = e.monthly ? '<span style="color:#3b82f6;font-weight:600;">Monthly</span>' : 'Weekly';
      var actual = display;
      if (e.preponed) {
        var aDt = new Date(e.actual + 'T00:00:00');
        actual = aDt.toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
      }
      var cls = e.date === todayStr ? 'today-holiday' : '';
      if (e.monthly) cls += ' monthly-row';
      var preponedNote = e.preponed ? '<span class="preponed" title="Preponed due to holiday"> ⚠ ' + actual + '</span>' : '';
      n++;
      rows += '<tr class="' + cls + '"><td>' + n + '</td><td>' + display + '</td><td>' + dayName + '</td><td>' + type + '</td><td>' + (e.preponed ? preponedNote : '—') + '</td></tr>';
    });
    if (!n) rows = '<tr><td colspan="5" style="text-align:center;color:var(--muted-1,#8ba1c2);padding:20px;">No upcoming expiry dates</td></tr>';
    body.innerHTML = rows;
  } catch(e) {
    body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:20px;">Failed to load expiry dates</td></tr>';
  }
}

// ── Combined Expiry & Holidays modal (top-bar button) ───────────────────────
function showExpiryHolidaysModal() {
  var modal = document.getElementById('expiryHolidaysModal');
  if (!modal) return;
  modal.style.display = 'block';
  showExpHolTab('expiry');
  loadExpiriesTable();
  loadHolidaysTable();
}
async function refreshHolidays() {
  var btn = document.getElementById('holiday-refresh-btn');
  if (!btn) return;
  var orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ REFRESHING…';
  btn.style.opacity = '0.6';
  try {
    var res = await secretFetch('/api/holidays/refresh', { method: 'POST' });
    btn.disabled = false;
    btn.textContent = orig;
    btn.style.opacity = '1';
    if (!res) return;
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + res.statusText);
    var d = await res.json();
    // Report per year — a refresh covers the current year and the next one, and
    // the next one is legitimately empty until NSE publishes it.
    var lines = Object.keys(d.sources || {}).sort().map(function(y) {
      return _ehYearSource(y, d.sources[y]);
    }).join('\\n');
    if (d.success) {
      await showAlert({ icon:'✅', title:'Holidays Refreshed', message:(lines || ('Fetched ' + d.count + ' holidays.')) + '\\nCache updated.', btnClass:'modal-btn-success' });
    } else {
      await showAlert({ icon:'⚠️', title:'NSE API Unavailable', message:'NSE API is blocking requests or unreachable.\\nShowing the last saved copy / fallback list:\\n' + (lines || ('' + d.count + ' holidays')), btnClass:'modal-btn-primary' });
    }
    // reload the table data so the modal reflects the refreshed cache
    loadHolidaysTable();
    loadExpiriesTable();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = orig;
    btn.style.opacity = '1';
    showAlert({ icon:'❌', title:'Network Error', message: err.message + '\\nPlease check your connection and try again.', btnClass:'modal-btn-danger' });
  }
}
function showExpHolTab(tab) {
  var ex = document.getElementById('ehTab-expiry');
  var ho = document.getElementById('ehTab-holiday');
  var bex = document.getElementById('ehBtn-expiry');
  var bho = document.getElementById('ehBtn-holiday');
  if (!ex || !ho || !bex || !bho) return;
  var isExpiry = (tab === 'expiry');
  ex.style.display = isExpiry ? 'block' : 'none';
  ho.style.display = isExpiry ? 'none'  : 'block';
  bex.classList.toggle('eh-tab-active', isExpiry);
  bho.classList.toggle('eh-tab-active', !isExpiry);
}`;
}

/**
 * Styled error page — shared across all trade route files.
 * @param {string} title — error title
 * @param {string} message — error description
 * @param {string} linkHref — back-link URL
 * @param {string} linkText — back-link label
 * @param {string} sidebarKey — active sidebar page key (e.g. 'bbRsiLive')
 */
function errorPage(title, message, linkHref, linkText, sidebarKey) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'IBM Plex Sans',sans-serif;background:#060810;color:#a0b8d8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{flex:1;padding:40px 32px;margin-left:200px;display:flex;align-items:center;justify-content:center;}
@media(max-width:768px){.main-content{margin-left:0;}}
.err-box{background:#0d1320;border:1px solid #7f1d1d;border-radius:14px;padding:40px 48px;max-width:480px;text-align:center;}
.err-icon{font-size:2.5rem;margin-bottom:16px;}
.err-title{color:#ef4444;margin-bottom:12px;font-size:1.1rem;font-weight:700;}
.err-msg{font-size:0.85rem;color:#8899aa;margin-bottom:24px;line-height:1.6;}
.err-link{background:#1e40af;color:#fff;padding:9px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.85rem;display:inline-block;}
.err-link:hover{background:#2563eb;}
</style></head><body>
<div class="app-shell">
${buildSidebar(sidebarKey || 'dashboard', false)}
<div class="main-content">
<div class="err-box">
<div class="err-icon">\u{1F6AB}</div>
<h2 class="err-title">${title}</h2>
<p class="err-msg">${message}</p>
${linkHref ? `<a href="${linkHref}" class="err-link">${linkText || 'Go Back'}</a>` : ''}
</div></div></div></body></html>`;
}

// ── Shared trade date-range filter (Dashboard top bar + Edge Analytics) ──────
// Both pages offer the same ranges over the same trade records, so the option
// list AND the date maths live here once. A page-local copy would drift the
// moment one side gained a range the other didn't — and the two pages would
// then disagree about what, say, "Last month" covers on the 1st of a month.
const DATE_RANGE_OPTIONS = [
  { value: 'tm',     label: 'This month' },
  { value: 'lm',     label: 'Last month' },
  { value: 'exp',    label: 'Current week expiry' },
  { value: 'all',    label: 'All' },
  { value: 'custom', label: 'Custom' },
];

// `selected` defaults to 'all' so a page renders its full history until the
// user narrows it — never a silently pre-filtered view.
function dateRangeOptionsHTML(selected = 'all') {
  return DATE_RANGE_OPTIONS
    .map((o) => `<option value="${o.value}"${o.value === selected ? ' selected' : ''}>${o.label}</option>`)
    .join('');
}

/**
 * Client-side resolver injected into a page's <script>.
 *
 * drRange(key, customFrom, customTo) → { from, to } as inclusive 'YYYY-MM-DD'
 * bounds, '' meaning open-ended. It is synchronous so existing sync render
 * paths (Edge Analytics' currentFilter()) don't have to become async.
 *
 * The one range that needs server data is 'exp' (current week expiry), because
 * a weekly expiry preponed by an NSE holiday can't be derived from the weekday
 * alone. So a caller selecting 'exp' must await drReady() before resolving; the
 * fetch is lazy (first 'exp' selection only, cached after) rather than fired at
 * load, because the Dashboard already pulls the same calendar for its expiry
 * pill and most page views never touch this range at all.
 */
function dateRangeJS() {
  return `
// ── Shared date-range resolver (sharedNav.dateRangeJS) ───────────────────────
function drYmd(d){ var p=function(n){ return String(n).padStart(2,'0'); };
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
// Trade records are stamped in IST, so every boundary is an IST calendar day —
// the browser's own timezone must not decide which month "this month" is.
function drToday(){ return new Date().toLocaleDateString('en-CA',{ timeZone:'Asia/Kolkata' }); }
function drParts(){ var p=drToday().split('-'); return { y:+p[0], m:+p[1]-1, d:+p[2] }; }
function drShift(iso, days){ var p=iso.split('-');
  var d=new Date(+p[0], +p[1]-1, +p[2]); d.setDate(d.getDate()+days); return drYmd(d); }

var _drWindow = null;   // resolved { from, to } for the current expiry cycle
var _drReady  = null;

// Fallback if the expiry calendar can't be read: NIFTY weeklies expire Tuesday,
// so the cycle runs Wednesday → the following Tuesday. Holiday preponement is
// the only thing this misses, which is exactly what the calendar adds.
function _drTuesdayWindow(){
  var t=drParts(); var d=new Date(t.y,t.m,t.d);
  var ahead=(2-d.getDay()+7)%7;                    // 0 when today IS Tuesday
  var end=new Date(d); end.setDate(end.getDate()+ahead);
  var start=new Date(end); start.setDate(start.getDate()-6);
  return { from:drYmd(start), to:drYmd(end) };
}

// Lazy + memoised: the first caller starts the fetch, everyone after reuses it.
function drReady(){
  if(_drReady) return _drReady;
  _drReady = fetch('/api/expiry-dates',{cache:'no-store'})
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(j){
      var list=(j && j.expiries) || [];
      var today=drToday(), prev='', cur='';
      for(var i=0;i<list.length;i++){
        var d=list[i].actual || list[i].date;       // .actual is the preponed date
        if(!d) continue;
        if(d < today) prev=d; else { cur=d; break; }
      }
      if(!prev && !cur){ _drWindow=_drTuesdayWindow(); return; }
      // The cycle opens the day after the previous expiry and closes on this one.
      // No prev  → first expiry of the calendar year, so step back a week.
      // No cur   → past the last expiry of the year, so leave the end open.
      _drWindow = { from: prev ? drShift(prev,1) : drShift(cur,-6), to: cur || '' };
    })
    .catch(function(){ _drWindow=_drTuesdayWindow(); });
  return _drReady;
}

function drRange(key, customFrom, customTo){
  var t=drParts();
  if(key==='custom') return { from: customFrom || '', to: customTo || '' };
  // Open end on 'tm': the month is still running, and no trade can be dated later.
  if(key==='tm') return { from: drYmd(new Date(t.y,t.m,1)), to:'' };
  // new Date(y,-1,1) rolls to last December and new Date(y,m,0) is the last day
  // of the previous month, so January needs no special case.
  if(key==='lm') return { from: drYmd(new Date(t.y,t.m-1,1)), to: drYmd(new Date(t.y,t.m,0)) };
  // Unresolved calendar → fall back to the weekday window rather than silently
  // widening to all-time, which would read as a much better/worse period.
  if(key==='exp') return _drWindow || _drTuesdayWindow();
  return { from:'', to:'' };                       // 'all'
}
`;
}

/* ── Checkbox multi-select ──────────────────────────────────────────────────
 * A native <select> can only answer "one strategy or all", which is the wrong
 * question on a comparison page — "EMA_RSI_ST + ORB, ignore the rest" needs a
 * checkbox list. Same three-part shape as the date-range helper (CSS / HTML /
 * JS) so a page picks it up with three interpolations and one msInit() call.
 *
 * Contract: msValues(id) → the checked values verbatim — every value when all
 * are ticked, [] when none are. Callers filter with indexOf, so unticking is
 * always honoured: unticking the last box shows nothing rather than silently
 * snapping back to everything, which read as a broken checkbox.
 */
function multiSelectCSS() {
  return `
    .ms{position:relative;display:inline-block;font-family:'IBM Plex Mono',monospace;}
    .ms-btn{display:inline-flex;align-items:center;justify-content:space-between;gap:10px;min-width:150px;background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:6px 10px;border-radius:6px;font-family:inherit;font-size:0.72rem;cursor:pointer;}
    .ms-btn:hover,.ms.open .ms-btn{border-color:#38bdf8;}
    .ms-caret{color:var(--muted-1,#8ba1c2);font-size:0.55rem;}
    .ms-menu{display:none;position:absolute;z-index:60;top:calc(100% + 4px);left:0;min-width:200px;max-height:300px;overflow-y:auto;background:#07111f;border:0.5px solid #0e1e36;border-radius:8px;padding:4px;box-shadow:0 10px 28px rgba(0,0,0,0.55);}
    .ms.open .ms-menu{display:block;}
    .ms-opt{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:5px;font-size:0.72rem;color:#c7d6ea;cursor:pointer;white-space:nowrap;}
    .ms-opt:hover{background:#0c1c30;}
    .ms-opt input{width:13px;height:13px;margin:0;accent-color:#38bdf8;cursor:pointer;}
    .ms-sep{height:0.5px;background:#0e1e36;margin:4px 2px;}
    :root[data-theme="light"] .ms-btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .ms-menu{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 10px 28px rgba(15,23,42,0.14)!important;}
    :root[data-theme="light"] .ms-opt{color:#334155!important;}
    :root[data-theme="light"] .ms-opt:hover{background:#f1f5f9!important;}
    :root[data-theme="light"] .ms-sep{background:#e0e4ea!important;}
    /* Phone: match what a page's own toolbar rules give .tbar select — the control
       it replaced stretched and had a bigger touch target. The menu is pinned to
       both edges so a 200px popup can't hang off a 390px screen. */
    @media(max-width:700px){
      .ms{flex:1 1 140px;min-width:0;}
      .ms-btn{width:100%;min-width:0;padding:8px 10px;}
      .ms-menu{left:0;right:0;min-width:0;}
    }
  `;
}

// Every box ships ticked, so the page opens on the same unfiltered view the old
// "All" option gave — the control starts wide and the user narrows it.
function multiSelectHTML(id, items, allLabel = 'All') {
  const e = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const opts = items
    .map((it) => `<label class="ms-opt"><input type="checkbox" value="${e(it.value)}" checked/>${e(it.label)}</label>`)
    .join('');
  return `<div class="ms" id="${e(id)}" data-all-label="${e(allLabel)}">`
    + `<button type="button" class="ms-btn" aria-haspopup="true" aria-expanded="false"><span class="ms-text">${e(allLabel)}</span><span class="ms-caret">▼</span></button>`
    + `<div class="ms-menu"><label class="ms-opt"><input type="checkbox" class="ms-all" checked/>${e(allLabel)}</label><div class="ms-sep"></div>${opts}</div>`
    + `</div>`;
}

function multiSelectJS() {
  return `
// ── Shared checkbox multi-select (sharedNav.multiSelectJS) ───────────────────
function _msBoxes(root){ return root.querySelectorAll('.ms-menu input[type=checkbox]:not(.ms-all)'); }

// The checked values as they stand — no "all means empty" trick, so a caller
// can tell "everything ticked" apart from "nothing ticked".
function msValues(id){
  var root=document.getElementById(id); if(!root) return [];
  var boxes=_msBoxes(root), out=[];
  for(var i=0;i<boxes.length;i++) if(boxes[i].checked) out.push(boxes[i].value);
  return out;
}

function _msPaint(root){
  var boxes=_msBoxes(root), sel=[];
  for(var i=0;i<boxes.length;i++) if(boxes[i].checked) sel.push(boxes[i].parentNode.textContent.trim());
  var all=root.querySelector('.ms-all');
  // Partial selection shows the dash, not a tick — a ticked "All" next to two
  // ticked boxes is what made unticking look like it had done nothing.
  if(all){ all.checked = sel.length===boxes.length; all.indeterminate = sel.length>0 && sel.length<boxes.length; }
  var allLabel=root.getAttribute('data-all-label')||'All';
  root.querySelector('.ms-text').textContent =
    (sel.length===boxes.length) ? allLabel
    : (sel.length===0) ? 'None'
    : (sel.length<=2 ? sel.join(', ') : sel.length+' selected');
}

function msInit(id, onChange){
  var root=document.getElementById(id); if(!root) return;
  var btn=root.querySelector('.ms-btn');
  btn.addEventListener('click', function(e){
    e.stopPropagation();
    root.classList.toggle('open');
    btn.setAttribute('aria-expanded', root.classList.contains('open') ? 'true' : 'false');
  });
  // Keep the menu open while ticking boxes — picking three strategies should
  // not cost three trips through the dropdown.
  root.querySelector('.ms-menu').addEventListener('click', function(e){ e.stopPropagation(); });
  var all=root.querySelector('.ms-all');
  // Clicking a dashed "All" clears the dash and ticks it, so a partial
  // selection widens back to everything — untick then clears everything.
  if(all) all.addEventListener('change', function(){
    var boxes=_msBoxes(root);
    for(var i=0;i<boxes.length;i++) boxes[i].checked = all.checked;
    _msPaint(root); if(onChange) onChange();
  });
  var boxes=_msBoxes(root);
  for(var i=0;i<boxes.length;i++) boxes[i].addEventListener('change', function(){
    _msPaint(root); if(onChange) onChange();
  });
  document.addEventListener('click', function(){
    root.classList.remove('open'); btn.setAttribute('aria-expanded','false');
  });
  _msPaint(root);
}
`;
}

/* ── Clear Cache button — shared by every backtest page ─────────────────────
 * A backtest that quietly reused stale cached candles had no in-app fix. This
 * button wipes both historical-candle disk caches so the next run re-downloads
 * from Fyers. Nothing else is touched: no trades, no settings, no tick
 * recordings — the caches self-heal, the only cost is a slower next run.
 *
 * Usage: drop clearCacheButtonHTML() into the run-bar and clearCacheJS() into a
 * page script that also has modalJS() (it uses showConfirm / showAlert /
 * secretFetch). Binding is by class, not id, so a page that renders more than
 * one run-bar still works.
 *
 * The <style> ships with the markup so a page needs one insertion, not two. A
 * style element is display:none by default, so it adds no box to the flex row,
 * and repeating it on a two-run-bar page just re-declares identical rules.
 */
function clearCacheButtonHTML() {
  return `<style>
  .clear-cache-btn{background:#2a1a10;color:#fbbf24;border:1px solid #7c4a03;padding:6px 14px;border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;white-space:nowrap;}
  .clear-cache-btn:hover{background:#78350f;color:#fff;}
  .clear-cache-btn:disabled{opacity:.5;cursor:not-allowed;}
  :root[data-theme="light"] .clear-cache-btn{background:#fffbeb;color:#b45309;border-color:#fcd34d;}
  :root[data-theme="light"] .clear-cache-btn:hover{background:#fef3c7;color:#78350f;}
  </style><button type="button" class="clear-cache-btn" title="Delete the cached historical candles — the next run re-downloads them from Fyers">🧹 Clear Cache</button>`;
}

function clearCacheJS() {
  return `
// ── Clear Cache ────────────────────────────────────────────────────────────
// Wipes the cached historical candles so the next run pulls fresh data from
// Fyers. The server has the final say on whether a backtest is running (409) —
// every backtest page shares one job manager — with a page-local RUN_STATE
// check in front of it for the gaps a single job's status cannot cover.
document.querySelectorAll('.clear-cache-btn').forEach(function(btn){
  btn.addEventListener('click', async function(){
    // A page that drives its own run loop (the /all-backtest dashboard) exposes
    // RUN_STATE. Between two strategies in a Run All the server is momentarily
    // idle, so its 409 would not catch a click that slows the rest of the run.
    if(typeof RUN_STATE !== 'undefined' && RUN_STATE && RUN_STATE.active){
      await showAlert({ icon:'\\u23f3', title:'Backtest running',
        message:'Wait for the running backtest to finish, then clear the cache.',
        btnClass:'modal-btn-primary' });
      return;
    }
    var ok = await showConfirm({
      icon:'\\ud83e\\uddf9',
      title:'Clear backtest cache?',
      message:'Deletes the cached historical candles (backtest_cache + candle_cache).\\nNo trades or settings are touched \\u2014 the next run just re-downloads from Fyers, which takes longer.',
      confirmText:'Clear cache',
      confirmClass:'modal-btn-danger'
    });
    if(!ok) return;

    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Clearing\\u2026';
    try {
      var r = await secretFetch('/cache-files/clear-candles', { method:'POST' });
      if(!r) return;                                 // secret prompt cancelled
      var d = null;
      try { d = await r.json(); } catch(_){}
      if(r.ok && d && d.success){
        await showAlert({ icon:'\\u2705', title:'Cache cleared',
          message:'Removed ' + d.total + ' file(s) \\u2014 ' + d.backtest + ' backtest, ' + d.candle + ' candle.\\nThe next run re-downloads candles from Fyers.',
          btnClass:'modal-btn-success' });
      } else if(r.status === 409){
        await showAlert({ icon:'\\u23f3', title:'Backtest running',
          message:'Wait for the running backtest to finish, then clear the cache.',
          btnClass:'modal-btn-primary' });
      } else {
        await showAlert({ icon:'\\u26a0\\ufe0f', title:'Clear failed',
          message:(d && d.error) || ('HTTP ' + r.status),
          btnClass:'modal-btn-danger' });
      }
    } catch(e) {
      await showAlert({ icon:'\\u26a0\\ufe0f', title:'Network error',
        message:(e && e.message) || 'Request failed', btnClass:'modal-btn-danger' });
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });
});
`;
}

module.exports = { STRATEGY_MODES, enabledStrategies, buildSidebar, sidebarCSS, themeJS, toastJS, aiExportJS, logViewerHTML, faviconLink, modalCSS, modalJS, expiryHolidayModalCSS, expiryHolidayModalHTML, expiryHolidayModalJS, errorPage, tableEnhancerCSS, tableEnhancerJS, dateRangeOptionsHTML, dateRangeJS, multiSelectCSS, multiSelectHTML, multiSelectJS, clearCacheButtonHTML, clearCacheJS };
