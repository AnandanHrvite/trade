/**
 * expiryHealth.js — keep the option expiry current, and shout when it can't be
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The hole this closes
 * ────────────────────
 * The expiry only ever got resolved when a signal fired. So a week whose expiry
 * could not be named announced itself as a *skipped entry*, mid-session, after
 * the setup had already gone — and a manual override that had expired simply sat
 * there blocking every strategy until someone noticed and retyped it.
 *
 * What this does
 * ──────────────
 *   1. On a schedule (and at boot) it runs the SAME resolution a trade runs, so
 *      it can never report "fine" while an entry would be refused. One extra run
 *      at 15:40 — after the close, before app.js clears the broker tokens at
 *      16:00 — rolls the contract that expired at 15:30 the SAME day, so the
 *      next morning starts on a live expiry. If even that run cannot resolve it,
 *      a Telegram says so, and setting it by hand is the fallback.
 *   2. If OPTION_EXPIRY_OVERRIDE is blank or has already expired, it writes the
 *      newly-resolved expiry back through the Settings persistence path. The
 *      Settings page, the Dashboard expiry strip and .env all show the new date
 *      immediately, and it survives a restart.
 *   3. If resolution FAILS, it changes nothing, raises a Dashboard banner and
 *      sends one Telegram — that is the case where a human must pick the expiry.
 *
 * A deliberately FORWARD-dated override is never touched. Someone who set next
 * week's expiry on purpose (e.g. to avoid 0DTE) keeps it; only a blank or an
 * already-expired value is filled in. "Expired" is instrument.js's own predicate,
 * the same one the entry guard and the stale-expiry banner use.
 *
 * What it does NOT do
 * ───────────────────
 *   - It never places, modifies or cancels an order. Its only broker calls are
 *     the read-only getQuotes() probes validateAndGetOptionSymbol already makes.
 *   - It never re-implements expiry logic. It asks instrument.js, so there is
 *     still exactly one definition of "the nearest tradeable contract".
 *
 * Verdicts:
 *   ok       — a real contract was named and quoted back
 *   fail     — nothing validated: an entry right now would be skipped
 *   unknown  — could not attempt it (no token / no spot / disabled). Not an
 *              alarm — a missing token is its own separately-reported problem.
 *
 * Gates — stays out of the way when:
 *   - EXPIRY_HEALTHCHECK_ENABLED=false   (own kill switch)
 *   - no Fyers ACCESS_TOKEN              (nothing to ask; don't provoke auth alerts)
 *   - a replay is in progress            (replay monkey-patches getQuotes)
 *   - weekend / NSE holiday              (nothing expires, nothing to fix)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const nseHolidays = require("./nseHolidays");
const notify      = require("./notify");

// Check window (IST minutes from midnight). Starts well before the 09:15 open so
// a broken week is on screen — or already rolled — with time to act on it.
const WINDOW_OPEN_MIN  = 480;   // 08:00
const WINDOW_CLOSE_MIN = 930;   // 15:30

// One extra check per day, at a FIXED time just after the close. On expiry day
// the stored expiry dies at 15:30, and app.js clears both broker tokens at 16:00
// — after which nothing can be resolved until the next morning's login. 15:40
// sits in that gap, so the roll to next week's contract happens the same evening
// instead of waiting for the next day. It is a fixed minute rather than another
// interval tick because a 30-minute tick could land at 15:35 or 16:05.
const POST_CLOSE_MIN  = 940;     // 15:40
const TOKEN_CLEAR_MIN = 960;     // 16:00 — app.js clears both broker tokens here
const HEARTBEAT_MS    = 60_000;  // scheduler granularity — the checks themselves are rate-limited below

const DEFAULT_INTERVAL_MINS = 30;
const MIN_INTERVAL_MINS     = 5;
const BOOT_DELAY_MS         = 30_000;   // let the token and feeds settle first

let _timer   = null;
let _running = false;   // one check at a time — the fallback ladder must not overlap itself
let _tradingDay = { day: null, allowed: null };
let _lastCheckAt  = 0;      // rate-limits the in-window checks off the 1-minute heartbeat
let _postCloseDay = null;   // IST date the 15:40 run already fired for — one per day

// Last verdict, read by the Dashboard. Starts "unknown" so a page load before the
// first check renders no banner rather than a false alarm.
let _state = {
  status:     "unknown",
  symbol:     null,
  expiry:     null,
  expiryDate: null,
  reason:     null,
  checkedAt:  null,
};

// Telegram goes out on a CHANGE of verdict, and again once a day while broken —
// enough to be noticed, not enough to become background noise.
let _notified = { status: null, day: null };

function _enabled() {
  return (process.env.EXPIRY_HEALTHCHECK_ENABLED || "true").toLowerCase() !== "false";
}

function _autoRollEnabled() {
  return (process.env.EXPIRY_AUTO_ROLL_ENABLED || "true").toLowerCase() !== "false";
}

function _intervalMs() {
  const mins = parseInt(process.env.EXPIRY_HEALTHCHECK_MINS || String(DEFAULT_INTERVAL_MINS), 10);
  return (Number.isFinite(mins) && mins >= MIN_INTERVAL_MINS ? mins : DEFAULT_INTERVAL_MINS) * 60_000;
}

function _istMinutes() {
  const istSec = Math.floor(Date.now() / 1000) + 19800;   // UTC+5:30
  return Math.floor(istSec / 60) % 1440;
}

function _istDay() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Weekend / NSE holiday, cached per IST date (it cannot change intraday). */
async function _isTradingDay() {
  const day = _istDay();
  if (_tradingDay.day === day && _tradingDay.allowed !== null) return _tradingDay.allowed;
  let allowed = true;
  try { allowed = !(await nseHolidays.isNonTradingDay(new Date())); }
  catch (_) { allowed = true; }   // calendar unavailable → check anyway rather than skip silently
  _tradingDay = { day, allowed };
  return allowed;
}

/** Reason to skip the whole check, or null to proceed. */
function _skipReason() {
  if (!_enabled())               return "disabled";
  if (!process.env.ACCESS_TOKEN) return "no Fyers token";
  try { if (require("../services/tickReplay").isReplayInProgress()) return "replay in progress"; }
  catch (_) { /* replay module unavailable — not a reason to skip */ }
  return null;
}

function _setState(patch) {
  _state = { ..._state, ...patch, checkedAt: Date.now() };
}

/**
 * Resolve the expiry, roll the override if it is blank or expired, and record
 * the verdict. Never throws — a health check that takes the process down with it
 * is worse than no health check.
 */
async function check() {
  if (_running) return _state;

  const skip = _skipReason();
  if (skip) {
    // A skip is not a verdict. Clear any previous alarm so a banner can never
    // outlive the condition that raised it.
    _setState({ status: "unknown", symbol: null, expiry: null, expiryDate: null, reason: skip });
    return _state;
  }
  if (!(await _isTradingDay())) return _state;

  _running = true;
  try {
    const instrument = require("../config/instrument");

    let spot;
    try {
      spot = await instrument.getLiveSpot();
    } catch (err) {
      _setState({ status: "unknown", symbol: null, expiry: null, expiryDate: null, reason: `no spot price (${err.message})` });
      return _state;
    }

    // Ask what AUTO-detection would pick, ignoring any override — that is the
    // contract a fresh override must be set to, and the honest health verdict.
    const auto = await instrument.validateAndGetOptionSymbol(spot, "CE", null, { ignoreOverride: true });

    if (!auto || !auto.symbol || auto.invalid) {
      _setState({
        status: "fail", symbol: null, expiry: null, expiryDate: null,
        reason: "no expiry could be validated against the broker",
      });
      _maybeNotify();
      return _state;
    }

    _maybeRoll(auto);
    _setState({
      status: "ok",
      symbol: auto.symbol,
      expiry: auto.expiry,
      expiryDate: auto.expiryDate || null,
      reason: null,
    });
  } catch (err) {
    _setState({ status: "unknown", symbol: null, expiry: null, expiryDate: null, reason: `check errored (${err.message})` });
  } finally {
    _running = false;
  }

  _maybeNotify();
  return _state;
}

/**
 * Write the resolved expiry into OPTION_EXPIRY_OVERRIDE when the stored value is
 * blank or already expired. The change is announced by log + Telegram rather than
 * returned, so there is one record of it and no state that nothing reads.
 */
function _maybeRoll(auto) {
  if (!_autoRollEnabled() || !auto.expiryDate) return;

  const instrument = require("../config/instrument");
  const current    = (process.env.OPTION_EXPIRY_OVERRIDE || "").trim();

  // A live, forward-dated override is a deliberate choice — leave it alone.
  if (current && !instrument.isExpiryOverrideStale(current)) return;
  if (current === auto.expiryDate) return;
  // Never write a date that is itself already past its session close: replacing
  // one dead contract with another only looks like a fix. Leave the stale value
  // (and its banner) in place and try again on the next check.
  if (instrument.isExpiryOverrideStale(auto.expiryDate)) {
    console.warn(`[expiryHealth] ⚠️  Resolved expiry ${auto.expiryDate} has already expired — not rolling to it`);
    return;
  }

  // The code decides weekly vs monthly from the date itself; keep the Settings
  // dropdown honest about which one this contract actually is.
  const type = /^\d{2}[A-Z]{3}$/.test(String(auto.expiry || "")) ? "monthly" : "weekly";

  try {
    const settings = require("../routes/settings");
    const res = settings.applyUpdates(
      { OPTION_EXPIRY_OVERRIDE: auto.expiryDate, OPTION_EXPIRY_TYPE: type },
      `auto expiry roll: ${current || "(blank)"} → ${auto.expiryDate} (${auto.expiry})`
    );
    if (!res || res.success === false) {
      console.warn(`[expiryHealth] ⚠️  Could not save rolled expiry: ${(res && res.error) || "unknown error"}`);
      return;
    }
    console.log(`[expiryHealth] 🔄 Expiry rolled ${current || "(blank)"} → ${auto.expiryDate} (${auto.expiry}, ${type}) — Settings and Dashboard updated`);
    notify.sendIfMaster(
      `🔄 <b>Option expiry updated automatically</b>\n` +
      `${current || "(blank)"} → <b>${auto.expiryDate}</b> (${auto.expiry}, ${type})`
    );
  } catch (err) {
    console.warn(`[expiryHealth] ⚠️  Expiry roll failed: ${err.message}`);
  }
}

function _maybeNotify() {
  const day = _istDay();
  if (_notified.status === _state.status && _notified.day === day) return;

  if (_state.status === "fail") {
    notify.sendIfMaster(
      `🚨 <b>Option expiry could not be resolved</b>\n` +
      `No tradeable NIFTY contract was found, so every strategy will skip entries.\n` +
      `Set <b>Option Expiry (manual)</b> in Settings for this week.`
    );
  } else if (_state.status === "ok" && _notified.status === "fail") {
    notify.sendIfMaster(`✅ <b>Option expiry resolved again</b> — ${_state.expiry} (${_state.symbol})`);
  }
  _notified = { status: _state.status, day };
}

/** Current verdict for the Dashboard. Pure read — never triggers a broker call. */
function getState() {
  return { ..._state };
}

/**
 * The 15:40 run is the last chance of the day — app.js clears both broker tokens
 * at 16:00. If the expiry is STILL stale after it, say so once, plainly, so the
 * operator can set it by hand this evening rather than meet it at tomorrow's open.
 */
function _postCloseAlert() {
  try {
    // A "fail" verdict has already gone out through _maybeNotify with the same
    // instruction — one message per problem, not two.
    if (_state.status === "fail") return;
    const instrument = require("../config/instrument");
    const current    = (process.env.OPTION_EXPIRY_OVERRIDE || "").trim();
    if (!current || !instrument.isExpiryOverrideStale(current)) return;
    console.warn(`[expiryHealth] ⚠️  Post-close roll did not update the expiry — ${current} is still stale`);
    notify.sendIfMaster(
      `⚠️ <b>Option expiry could not be rolled</b>\n` +
      `<b>${current}</b> has expired and auto-detection could not name the next contract.\n` +
      `Set <b>Option Expiry (manual)</b> in Settings — entries stay blocked until then.`
    );
  } catch (_) { /* an alert that throws must not take the scheduler down */ }
}

/** Start the periodic check. Idempotent. */
function start() {
  if (_timer || !_enabled()) return;

  // One check shortly after boot whatever the hour, so a restart shows a current
  // verdict — and rolls an expiry that died while the process was down.
  setTimeout(() => {
    _lastCheckAt = Date.now();   // the heartbeat must not immediately repeat it
    check().catch(() => {});
  }, BOOT_DELAY_MS).unref();

  // A 1-minute heartbeat rather than an interval timer: the in-window checks still
  // run every EXPIRY_HEALTHCHECK_MINS (rate-limited below), but the post-close roll
  // has to land on an exact minute, which an interval anchored to boot cannot
  // promise — a 30-minute tick could fall at 15:35 and then at 16:05, by which
  // time the token is gone.
  _timer = setInterval(() => {
    const mins = _istMinutes();

    // Post-close roll — once per day, inside the 15:40 → 16:00 token-clear gap.
    if (mins >= POST_CLOSE_MIN && mins < TOKEN_CLEAR_MIN && _postCloseDay !== _istDay()) {
      // A check still in flight would make check() a no-op and the alert below
      // read pre-roll state; leave the day's slot unclaimed and retry next minute.
      if (_running) return;
      _postCloseDay = _istDay();
      _lastCheckAt  = Date.now();
      // Gated on the trading day so a weekend never reports "could not roll"
      // when nothing was attempted — check() skips those days on its own.
      _isTradingDay()
        .then((ok) => (ok ? check().then(_postCloseAlert) : null))
        .catch(() => {});
      return;
    }

    if (mins < WINDOW_OPEN_MIN || mins > WINDOW_CLOSE_MIN) return;
    if (Date.now() - _lastCheckAt < _intervalMs()) return;
    _lastCheckAt = Date.now();
    check().catch(() => {});
  }, HEARTBEAT_MS);
  _timer.unref();

  console.log(`   Expiry health    : ✅ every ${Math.round(_intervalMs() / 60000)} min, 08:00–15:30 IST, plus a 15:40 roll` +
              `${_autoRollEnabled() ? " (auto-roll ON)" : " (auto-roll off)"}`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, check, getState };
