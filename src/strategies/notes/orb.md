# ORB — change notes

Engine: `src/strategies/orb_breakout.js`, `src/strategies/orbExits.js` · Routes: `orb*.js` · Env prefix: `ORB_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-05: fixed the ORH/ORL overlay lines vanishing on the Paper/Replay/Live charts — they were anchored at candles[0] (7-day warm-up buffer) so the client's trim-to-today filter dropped the first point and collapsed each line to a single invisible point; now anchored to the first candle of the latest trading day (orbPaper.js, orbLive.js; Replay inherits Paper's chart-data).
- 2026-08-05: backtest hard-SL now delegates the DECISION to the shared exit engine's `orbExits.isHardSlHit` predicate instead of an inline `c.low<=sl`/`c.high>=sl` compare (fill stays local); removes latent drift if isHardSlHit ever changes. No behaviour change today.
<!-- - 2026-08-05: what changed and why -->
