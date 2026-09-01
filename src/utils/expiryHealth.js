/**
 * expiryHealth.js — keep every index's option expiry current, and shout when it can't be
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The hole this closes
 * ────────────────────
 * The expiry only ever got resolved when a signal fired. So a week whose expiry
 * could not be named announced itself as a *skipped entry*, mid-session, after
 * the setup had already gone — and a manual override that had expired simply sat
 * there blocking every strategy until someone noticed and retyped it.
 *
 * ONE CHECK PER INDEX
 * ───────────────────
 * Every underlying in instrument.js's UNDERLYING_DEFS (NIFTY 50 and NIFTY BANK
 * today) gets its OWN resolution, its OWN roll into its OWN override key, its
 * OWN Dashboard verdict and its OWN Telegram. They cannot share one: NIFTY 50
 * expires weekly on a Tuesday, NIFTY BANK only monthly (NSE withdrew BANKNIFTY
 * weeklies in Nov-2024), so a single verdict would be wrong for one of them
 * every week — and rolling one date into both keys would hand BANKNIFTY a
 * contract that has never been listed.
 *
 * What this does
 * ──────────────
 *   1. On a schedule (and at boot) it runs, PER INDEX, the SAME resolution a
 *      trade runs, so it can never report "fine" while an entry would be
 *      refused. On expiry day the contract dies at the 15:30 close and is
 *      replaced the SAME evening by the post-close ladder: 15:40, then 16:15 /
 *      16:30 / 16:45 if it keeps failing. app.js holds its 16:00 token clear
 *      while that ladder runs, since every attempt needs the token. Only when
 *      all four fail does the Dashboard ask for the expiry to be typed in by
 *      hand — naming exactly which index still needs it.
 *   2. If an index's override ({OPTION_EXPIRY_OVERRIDE} for NIFTY,
 *      {BANKNIFTY_OPTION_EXPIRY_OVERRIDE} for NIFTY BANK) is blank or has
 *      already expired, it writes that index's newly-resolved expiry back
 *      through the Settings persistence path. The Settings page, the Dashboard
 *      expiry strips and .env all show the new date immediately, and it
 *      survives a restart.
 *   3. If resolution FAILS, it changes nothing, raises a Dashboard banner for
 *      that index and sends one Telegram — that is the case where a human must
 *      pick the expiry.
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
 *     still exactly one definition of "the nearest tradeable contract" — and
 *     one definition of what NIFTY BANK's expiries even are.
 *
 * Verdicts (per index):
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

// ── The indices this checks ──────────────────────────────────────────────────
// Read from instrument.js rather than listed here, so adding a third index to
// UNDERLYING_DEFS puts it under the same auto-roll + alerting without touching
// this file. Falls back to the two known keys if that require ever fails, since
// a health check that silently monitors NOTHING is the worst outcome available.
function underlyingKeys() {
  try {
    const keys = Object.keys(require("../config/instrument").UNDERLYING_DEFS || {});
    if (keys.length) return keys;
  } catch (_) { /* fall through */ }
  return ["NIFTY", "BANKNIFTY"];
}

/** Human name for messages/logs — "NIFTY 50", "NIFTY BANK". */
function labelOf(key) {
  try { return require("../config/instrument").underlyingOf(key).label; }
  catch (_) { return key; }
}

/** The .env key holding this index's manual expiry override. */
function overrideKeyOf(key) {
  try { return require("../config/instrument").underlyingOf(key).env.expiryOverride; }
  catch (_) { return key === "NIFTY" ? "OPTION_EXPIRY_OVERRIDE" : `${key}_OPTION_EXPIRY_OVERRIDE`; }
}

// ── The post-close roll ladder ───────────────────────────────────────────────
// The stored expiry dies at the 15:30 close, and until it is replaced every
// strategy on that index refuses entries. app.js clears both broker tokens at
// 16:00, after which nothing can be resolved until the next morning's login —
// so the whole repair has to happen in the evening, on fixed minutes (a
// 30-minute interval tick anchored to boot could land at 15:35 and then 16:05).
//
//   15:40  first attempt — the usual case, done before the token clear
//   16:15 / 16:30 / 16:45  three retries, for a broker that answered badly once
//
// ONE ladder covers every index: each rung runs check(), which resolves all of
// them, so NIFTY and NIFTY BANK are repaired in the same pass. The ladder is
// finished only when NO index is left stale — a month-end that expires both at
// once cannot let one of them fall off the retries.
//
// While the ladder is still running app.js HOLDS the token clear (see
// isRollPending) — clearing the token mid-ladder would guarantee the retries
// fail. Only when all four attempts have failed does the Dashboard raise the
// "set it by hand" alert; before that the banner says the roll is in progress,
// because a red "entries are blocked" banner over a repair already under way is
// noise, not information.
const POST_CLOSE_ATTEMPT_MINS = [940, 975, 990, 1005];   // 15:40, 16:15, 16:30, 16:45
const LADDER_END_MIN = POST_CLOSE_ATTEMPT_MINS[POST_CLOSE_ATTEMPT_MINS.length - 1] + 10;   // 16:55
const HEARTBEAT_MS   = 60_000;  // scheduler granularity — the checks themselves are rate-limited below

const DEFAULT_INTERVAL_MINS = 30;
const MIN_INTERVAL_MINS     = 5;
const BOOT_DELAY_MS         = 30_000;   // let the token and feeds settle first

let _timer   = null;
let _running = false;   // one check at a time — the fallback ladder must not overlap itself
let _tradingDay = { day: null, allowed: null };
let _lastCheckAt  = 0;      // rate-limits the in-window checks off the 1-minute heartbeat

// Today's post-close ladder. `done` = every index's expiry is current again (or
// there was nothing to repair); `exhausted` = all four attempts ran and at least
// one index is still stale, which is the only state that asks the operator in.
let _postClose = { day: null, attempts: 0, done: false, exhausted: false };

// Last verdict PER INDEX, read by the Dashboard. A key starts "unknown" so a
// page load before the first check renders no banner rather than a false alarm.
const _states = Object.create(null);

function _blankState() {
  return { status: "unknown", symbol: null, expiry: null, expiryDate: null, reason: null, checkedAt: null };
}
function _stateOf(key) {
  if (!_states[key]) _states[key] = { ..._blankState(), underlying: key, label: labelOf(key) };
  return _states[key];
}

// Telegram goes out on a CHANGE of verdict, and again once a day while broken —
// enough to be noticed, not enough to become background noise. Tracked per index
// so a NIFTY BANK failure is not swallowed by a healthy NIFTY 50.
const _notified = Object.create(null);   // key -> { status, day }

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

function _setState(key, patch) {
  _states[key] = { ..._stateOf(key), ...patch, underlying: key, label: labelOf(key), checkedAt: Date.now() };
}

/**
 * Resolve every index's expiry, roll the ones whose override is blank or
 * expired, and record a verdict for each. Never throws — a health check that
 * takes the process down with it is worse than no health check.
 */
async function check() {
  if (_running) return getStates();

  const skip = _skipReason();
  if (skip) {
    // A skip is not a verdict. Clear any previous alarm so a banner can never
    // outlive the condition that raised it.
    for (const key of underlyingKeys()) {
      _setState(key, { status: "unknown", symbol: null, expiry: null, expiryDate: null, reason: skip });
    }
    return getStates();
  }
  if (!(await _isTradingDay())) return getStates();

  _running = true;
  try {
    // Sequential, not parallel: each index costs a handful of getQuotes probes
    // and they share one broker session — firing both at once is how a rate
    // limit turns two healthy indices into two "assumed VALID" guesses.
    for (const key of underlyingKeys()) await _checkOne(key);
  } finally {
    _running = false;
  }

  for (const key of underlyingKeys()) _maybeNotify(key);
  return getStates();
}

/** One index: resolve, roll if needed, record the verdict. Never throws. */
async function _checkOne(key) {
  try {
    const instrument = require("../config/instrument");

    let spot;
    try {
      spot = await instrument.getLiveSpot(key);
    } catch (err) {
      _setState(key, { status: "unknown", symbol: null, expiry: null, expiryDate: null, reason: `no spot price (${err.message})` });
      return;
    }

    // Ask what AUTO-detection would pick for THIS index, ignoring any override —
    // that is the contract a fresh override must be set to, and the honest
    // health verdict.
    const auto = await instrument.validateAndGetOptionSymbol(spot, "CE", null, { ignoreOverride: true, underlying: key });

    if (!auto || !auto.symbol || auto.invalid) {
      _setState(key, {
        status: "fail", symbol: null, expiry: null, expiryDate: null,
        reason: "no expiry could be validated against the broker",
      });
      return;
    }

    _maybeRoll(key, auto);
    _setState(key, {
      status: "ok",
      symbol: auto.symbol,
      expiry: auto.expiry,
      expiryDate: auto.expiryDate || null,
      reason: null,
    });
  } catch (err) {
    _setState(key, { status: "unknown", symbol: null, expiry: null, expiryDate: null, reason: `check errored (${err.message})` });
  }
}

/**
 * Write the resolved expiry into THIS index's override key when the stored value
 * is blank or already expired. The change is announced by log + Telegram rather
 * than returned, so there is one record of it and no state that nothing reads.
 */
function _maybeRoll(key, auto) {
  if (!_autoRollEnabled() || !auto.expiryDate) return;

  const instrument = require("../config/instrument");
  const U          = instrument.underlyingOf(key);
  const current    = String(process.env[U.env.expiryOverride] || "").trim();

  // A live, forward-dated override is a deliberate choice — leave it alone.
  if (current && !instrument.isExpiryOverrideStale(current)) return;
  if (current === auto.expiryDate) return;
  // Never write a date that is itself already past its session close: replacing
  // one dead contract with another only looks like a fix. Leave the stale value
  // (and its banner) in place and try again on the next check.
  if (instrument.isExpiryOverrideStale(auto.expiryDate)) {
    console.warn(`[expiryHealth/${key}] ⚠️  Resolved expiry ${auto.expiryDate} has already expired — not rolling to it`);
    return;
  }

  // The code decides weekly vs monthly from the date itself; keep the Settings
  // dropdown honest about which one this contract actually is. A monthly-only
  // index (NIFTY BANK) can only ever produce the YYMMM form, so this writes
  // "monthly" for it without needing a special case.
  const type = /^\d{2}[A-Z]{3}$/.test(String(auto.expiry || "")) ? "monthly" : "weekly";

  try {
    const settings = require("../routes/settings");
    const res = settings.applyUpdates(
      { [U.env.expiryOverride]: auto.expiryDate, [U.env.expiryType]: type },
      `auto expiry roll (${U.label}): ${current || "(blank)"} → ${auto.expiryDate} (${auto.expiry})`
    );
    if (!res || res.success === false) {
      console.warn(`[expiryHealth/${key}] ⚠️  Could not save rolled expiry: ${(res && res.error) || "unknown error"}`);
      return;
    }
    console.log(`[expiryHealth/${key}] 🔄 ${U.label} expiry rolled ${current || "(blank)"} → ${auto.expiryDate} (${auto.expiry}, ${type}) — Settings and Dashboard updated`);
    notify.sendIfMaster(
      `🔄 <b>${U.label} option expiry updated automatically</b>\n` +
      `${current || "(blank)"} → <b>${auto.expiryDate}</b> (${auto.expiry}, ${type})`
    );
  } catch (err) {
    console.warn(`[expiryHealth/${key}] ⚠️  Expiry roll failed: ${err.message}`);
  }
}

function _maybeNotify(key) {
  const day   = _istDay();
  const state = _stateOf(key);
  const prev  = _notified[key] || { status: null, day: null };
  if (prev.status === state.status && prev.day === day) return;

  // A failed rung of the post-close ladder is not news yet — the retries are
  // still coming, and the ladder sends exactly one message if they all fail.
  // Nothing is recorded in _notified either, so a failure that outlives the
  // ladder still reports itself on the next check.
  if (state.status === "fail" && isRollPending()) return;

  const label = labelOf(key);
  if (state.status === "fail") {
    notify.sendIfMaster(
      `🚨 <b>${label} option expiry could not be resolved</b>\n` +
      `No tradeable ${label} contract was found, so every ${label} strategy will skip entries.\n` +
      `Set <b>${overrideKeyOf(key)}</b> in Settings for this expiry.`
    );
  } else if (state.status === "ok" && prev.status === "fail") {
    notify.sendIfMaster(`✅ <b>${label} option expiry resolved again</b> — ${state.expiry} (${state.symbol})`);
  }
  _notified[key] = { status: state.status, day };
}

/**
 * Current verdict for ONE index. Pure read — never triggers a broker call.
 * Defaults to NIFTY so a caller that predates the per-index split still reads
 * the verdict it always read.
 */
function getState(underlying) {
  return { ..._stateOf(underlying || "NIFTY") };
}

/** Every index's verdict, keyed by underlying. Pure read. */
function getStates() {
  const out = {};
  for (const key of underlyingKeys()) out[key] = { ..._stateOf(key) };
  return out;
}

/** Is THIS index's stored expiry still one that cannot be traded? */
function isOverrideStale(underlying) {
  try {
    const instrument = require("../config/instrument");
    const U       = instrument.underlyingOf(underlying);
    const current = String(process.env[U.env.expiryOverride] || "").trim();
    return Boolean(current) && instrument.isExpiryOverrideStale(current);
  } catch (_) {
    return false;   // cannot tell → never claim a problem we have not proven
  }
}

/** Every index whose stored expiry has expired — [] when there is nothing to repair. */
function staleUnderlyings() {
  return underlyingKeys().filter(isOverrideStale);
}

/** Reset the ladder when the IST date turns over. */
function _postCloseForDay() {
  const day = _istDay();
  if (_postClose.day !== day) _postClose = { day, attempts: 0, done: false, exhausted: false };
  return _postClose;
}

/**
 * Is the post-close roll still working? app.js asks this before clearing the
 * broker tokens at 16:00 — the retries need the token that clear would destroy,
 * so the clear waits for the ladder to finish (it has its own hard deadline, so
 * a wedged check can never postpone it indefinitely).
 */
function isRollPending() {
  if (!_enabled() || !_autoRollEnabled()) return false;
  const pc = _postCloseForDay();
  if (pc.done || pc.exhausted) return false;
  const mins = _istMinutes();
  // Only from the first attempt until just past the last one, and only if there
  // is actually something — on any index — to repair.
  if (mins < POST_CLOSE_ATTEMPT_MINS[0]) return false;
  if (mins > LADDER_END_MIN) return false;
  return staleUnderlyings().length > 0;
}

/**
 * One rung of the ladder: run the same check an entry runs, for every index
 * (which rolls each expiry as a side effect), then decide whether the day is
 * finished, needs another attempt, or has run out of them.
 */
async function _runPostCloseAttempt(attemptNo) {
  if (!(await _isTradingDay())) {
    _postClose.done = true;   // nothing expires on a holiday — nothing to repair
    return;
  }

  const before = staleUnderlyings();
  console.log(`[expiryHealth] 🔁 Post-close expiry roll — attempt ${attemptNo}/${POST_CLOSE_ATTEMPT_MINS.length} ` +
              `(stale: ${before.map(labelOf).join(", ") || "none"})`);
  await check();

  const stale = staleUnderlyings();
  if (stale.length === 0) {
    _postClose.done = true;
    console.log(`[expiryHealth] ✅ Post-close roll complete — every index's expiry is current again`);
    return;
  }

  if (attemptNo < POST_CLOSE_ATTEMPT_MINS.length) {
    console.warn(`[expiryHealth] ⚠️  Still stale after attempt ${attemptNo} (${stale.map(labelOf).join(", ")}) — retrying at ` +
                 `${_fmtIstMinute(POST_CLOSE_ATTEMPT_MINS[attemptNo])} IST`);
    return;
  }

  // Out of attempts — this is the case that needs a person. The message names
  // the indices that are still broken AND the exact key to set for each, so a
  // NIFTY BANK failure cannot be read as a NIFTY 50 one.
  _postClose.exhausted = true;
  const lines = stale.map((key) => {
    const current = String(process.env[overrideKeyOf(key)] || "").trim() || "(blank)";
    return `• <b>${labelOf(key)}</b> — ${current} → set <b>${overrideKeyOf(key)}</b>`;
  });
  console.error(`[expiryHealth] ❌ All ${POST_CLOSE_ATTEMPT_MINS.length} post-close attempts failed — still stale: ` +
                stale.map((k) => `${labelOf(k)} (${process.env[overrideKeyOf(k)] || "blank"})`).join(", "));
  notify.sendIfMaster(
    `⚠️ <b>Option expiry could not be rolled</b>\n` +
    `${POST_CLOSE_ATTEMPT_MINS.length} attempts could not name the next contract for:\n` +
    `${lines.join("\n")}\n` +
    `Set it in Settings — entries on those indices stay blocked until then.`
  );
}

function _fmtIstMinute(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
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

    // Post-close ladder — 15:40, then 16:15 / 16:30 / 16:45 while it keeps failing.
    // Bounded at both ends: a process that boots at 21:00 must not fire all four
    // rungs a minute apart (its own boot check already attempts the roll).
    const pc = _postCloseForDay();
    if (!pc.done && !pc.exhausted && pc.attempts < POST_CLOSE_ATTEMPT_MINS.length &&
        mins >= POST_CLOSE_ATTEMPT_MINS[pc.attempts] && mins <= LADDER_END_MIN) {
      // Most days no index expires at 15:40 — nothing to repair, and no reason
      // to spend a broker probe finding that out.
      if (staleUnderlyings().length === 0) { pc.done = true; return; }
      // A check still in flight would make check() a no-op and the verdict below
      // read pre-roll state; leave this rung unclaimed and retry next minute.
      if (_running) return;
      pc.attempts  += 1;
      _lastCheckAt  = Date.now();
      _runPostCloseAttempt(pc.attempts).catch((err) => {
        console.warn(`[expiryHealth] ⚠️  Post-close attempt failed: ${err.message}`);
      });
      return;
    }

    if (mins < WINDOW_OPEN_MIN || mins > WINDOW_CLOSE_MIN) return;
    if (Date.now() - _lastCheckAt < _intervalMs()) return;
    _lastCheckAt = Date.now();
    check().catch(() => {});
  }, HEARTBEAT_MS);
  _timer.unref();

  console.log(`   Expiry health    : ✅ ${underlyingKeys().map(labelOf).join(" + ")} — every ${Math.round(_intervalMs() / 60000)} min, ` +
              `08:00–15:30 IST, post-close roll ${POST_CLOSE_ATTEMPT_MINS.map(_fmtIstMinute).join("/")}` +
              `${_autoRollEnabled() ? " (auto-roll ON)" : " (auto-roll off)"}`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  start, stop, check,
  getState,            // one index's verdict (defaults to NIFTY)
  getStates,           // every index's verdict, keyed by underlying
  isRollPending,
  isOverrideStale,     // is THIS index's stored expiry already past its close?
  staleUnderlyings,    // every index that needs a new expiry right now
  underlyingKeys,      // the indices this monitors — the Dashboard renders one strip each
  labelOf,
  overrideKeyOf,
};
