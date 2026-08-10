/**
 * UI theme resolution.
 *
 * UI_THEME (Settings → UI Preferences) is one of:
 *   dark   — always dark
 *   light  — always light
 *   auto   — follow the clock: light during the day, dark at night
 *
 * Every page renders `resolveTheme()` (never the raw env value) so "auto"
 * collapses to a concrete dark/light before the markup is built. Resolving on
 * the server keeps the existing one-line bootstrap script working unchanged and
 * avoids a flash of the wrong theme before paint.
 *
 * The clock is IST — the same convention as the rest of the app (trades, logs,
 * expiry). The +5:30 offset is applied to UTC explicitly rather than trusting
 * process.env.TZ, so standalone scripts that require this file resolve the same
 * way the server does.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Daytime window in IST. 06:00–17:59 is light; 18:00–05:59 is dark.
const DAY_START_HOUR = 6;
const DAY_END_HOUR   = 18;

/** Current hour (0–23) in IST. */
function istHour(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).getUTCHours();
}

/**
 * Effective theme for this render: always "dark" or "light", never "auto".
 * Anything unrecognised falls back to dark, which is the app's default skin.
 */
function resolveTheme(raw = process.env.UI_THEME, nowMs = Date.now()) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "light") return "light";
  if (value === "auto") {
    const hour = istHour(nowMs);
    return hour >= DAY_START_HOUR && hour < DAY_END_HOUR ? "light" : "dark";
  }
  return "dark";
}

module.exports = { resolveTheme, istHour, DAY_START_HOUR, DAY_END_HOUR };
