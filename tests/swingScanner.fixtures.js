/**
 * Deterministic synthetic OHLCV for scanner tests. No RNG from Math.random —
 * a seeded LCG, so a failing case is always reproducible.
 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// 09:15 IST on the Monday at least `n` sessions before today, so a fixture
// series lands inside the date window the scanner actually requests.
const istDayKeyOf = t => Math.floor((t + 19800) / 86400);
function mondayBefore(days) {
  let dk = istDayKeyOf(Math.floor(Date.now() / 1000)) - days;
  while (((dk + 4) % 7) !== 1) dk--;          // walk back to a Monday
  return dk * 86400 - 19800 + (9 * 3600 + 15 * 60);   // 09:15 IST that day
}
const BASE = mondayBefore(400);
const istDayKey = t => Math.floor((t + 19800) / 86400);
const istWeekday = t => (istDayKey(t) + 4) % 7;

/** Hourly NSE bars (7 per session) over `sessions` trading days. */
function hourly({ sessions = 80, start = 1000, drift = 0, vol = 0.006, seed = 42, volBase = 200000 } = {}) {
  const rnd = lcg(seed);
  const out = [];
  let p = start, d = 0, made = 0;
  while (made < sessions) {
    const t0 = BASE + d * 86400;
    if (istWeekday(t0) === 0 || istWeekday(t0) === 6) { d++; continue; }
    for (let b = 0; b < 7; b++) {
      const mins = b * 60;
      if (mins >= 375) break;
      const open = p;
      const shock = (rnd() - 0.5) * 2 * vol * p;
      p = Math.max(1, p + drift * p + shock);
      const close = p;
      const wick = Math.abs(shock) * (0.3 + rnd() * 0.7);
      out.push({
        time: t0 + mins * 60,
        open, close,
        high: Math.max(open, close) + wick,
        low:  Math.max(0.5, Math.min(open, close) - wick),
        volume: Math.round(volBase * (0.5 + rnd() * 1.5)),
      });
    }
    made++; d++;
  }
  return out;
}

/** Daily NSE bars stamped 00:00 IST, the way Fyers returns 1D. */
function daily({ sessions = 200, start = 1000, drift = 0, vol = 0.015, seed = 7, volBase = 1500000 } = {}) {
  const rnd = lcg(seed);
  const out = [];
  let p = start, d = 0, made = 0;
  while (made < sessions) {
    const t0 = BASE + d * 86400;
    if (istWeekday(t0) === 0 || istWeekday(t0) === 6) { d++; continue; }
    const open = p;
    const shock = (rnd() - 0.5) * 2 * vol * p;
    p = Math.max(1, p + drift * p + shock);
    const close = p;
    const wick = Math.abs(shock) * (0.4 + rnd());
    out.push({
      time: istDayKey(t0) * 86400 - 19800,          // 00:00 IST
      open, close,
      high: Math.max(open, close) + wick,
      low:  Math.max(0.5, Math.min(open, close) - wick),
      volume: Math.round(volBase * (0.5 + rnd() * 1.5)),
    });
    made++; d++;
  }
  return out;
}

/** A double-bottom into a breakout — the shape PA is built to find. */
function doubleBottom({ start = 1000, seed = 3 } = {}) {
  const rnd = lcg(seed);
  const out = [];
  let d = 0, made = 0, idx = 0;
  // price path: drift down, bottom, bounce, back to bottom, then break the neckline
  const path = [];
  for (let i = 0; i < 40; i++) path.push(start - i * 4);          // decline to 844
  for (let i = 0; i < 14; i++) path.push(844 + i * 6);            // bounce to 928 (neckline)
  for (let i = 0; i < 14; i++) path.push(928 - i * 6);            // back down to 844
  for (let i = 0; i < 30; i++) path.push(844 + i * 5);            // rally through 928
  for (let i = 0; i < 20; i++) path.push(994 + i * 1);            // hold above
  while (idx < path.length) {
    const t0 = BASE + d * 86400;
    if (istWeekday(t0) === 0 || istWeekday(t0) === 6) { d++; continue; }
    for (let b = 0; b < 7 && idx < path.length; b++, idx++) {
      const open = idx === 0 ? path[0] : path[idx - 1];
      const close = path[idx];
      const wick = 2 + rnd() * 3;
      out.push({
        time: t0 + b * 3600, open, close,
        high: Math.max(open, close) + wick,
        low:  Math.min(open, close) - wick,
        volume: Math.round(200000 * (0.5 + rnd())),
      });
    }
    made++; d++;
  }
  return out;
}

module.exports = { hourly, daily, doubleBottom, lcg, BASE, istDayKey, istWeekday };

/**
 * A double bottom that PA can actually trade, on a ~₹900 stock:
 *   two swing lows 12 bars apart within the SCALED tolerance, a neckline
 *   between them, a breakout candle that opens below and closes above it, then
 *   a retest bar that dips back to the level and closes above. Ends ON the
 *   retest bar, which is the bar PA enters on.
 */
function paDoubleBottomSetup() {
  // [open, high, low, close] — explicit, because the pattern depends on exact
  // wick placement and a generator would only obscure that.
  const pattern = [
    [900, 901, 899, 898], [898, 899, 893, 894], [894, 895, 887, 888], [888, 889, 879, 880],
    [880, 881, 871, 872], [872, 873, 863, 864],
    [864, 865, 857.0, 858],                                   // bottom 1  (low 857.0)
    [858, 867, 857.6, 866], [866, 877, 865, 876], [876, 887, 875, 886],
    [886, 895, 885, 894], [894, 901, 893, 900],
    [900, 904, 899, 903],                                     // neckline  (high 904)
    [903, 904, 895, 896], [896, 897, 885, 886], [886, 887, 875, 876],
    [876, 877, 867, 868], [868, 869, 861, 862],
    [862, 863, 857.3, 858.2],                                 // bottom 2  (low 857.3)
    [858.2, 868, 857.9, 867], [867, 878, 866, 877], [877, 887, 876, 886],
    [886, 893, 885, 892], [892, 897, 891, 896], [896, 899, 895, 898],
    [898, 900, 897, 899], [899, 901, 898, 900], [900, 902, 899, 901],
    [901, 903, 900, 902],
    [902, 909, 901, 908],                                     // breakout: opens 902 ≤ 904, closes 908 > 904
    [908, 909, 904.2, 906],                                   // retest: dips to 904.2, closes 906 > 904
  ];
  // Flat filler so the series clears PA's 35-bar warm-up without adding swing
  // points inside the 30-bar pattern window.
  const filler = [];
  for (let i = 0; i < 40; i++) filler.push([902, 903, 901, 902]);

  const rows = [...filler, ...pattern];
  const out = [];
  let d = 0, idx = 0;
  while (idx < rows.length) {
    const t0 = BASE + d * 86400;
    if (istWeekday(t0) === 0 || istWeekday(t0) === 6) { d++; continue; }
    for (let b = 0; b < 7 && idx < rows.length; b++, idx++) {
      const [o, h, l, c] = rows[idx];
      out.push({ time: t0 + b * 3600, open: o, high: h, low: l, close: c, volume: 250000 });
    }
    d++;
  }
  return out;
}

module.exports.paDoubleBottomSetup = paDoubleBottomSetup;
