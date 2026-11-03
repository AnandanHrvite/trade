// A hand-written bullish order-block retest, [open, high, low, close]. Explicit
// because the setup depends on exact wick placement. Each named bar is one rule.
const FLAT = [1000, 1001, 999, 1000]; // ties, so the filler makes no swings

const BARS = {
  a0:  [1000, 1002, 994, 996],
  a1:  [996, 997, 992, 995],     // earlier small low (992)
  a2:  [995, 1005, 994, 1003],
  a3:  [1003, 1010, 1000, 1008],
  a4:  [1008, 1020, 1005, 1015], // swing high (1020)
  a5:  [1015, 1018, 1006, 1010],
  a6:  [1010, 1012, 995, 998],
  a7:  [998, 1000, 990, 992],    // BLOCK 990-1000: takes the 992 low
  a8:  [992, 1006, 991, 1004],
  a9:  [1004, 1016, 1003, 1014], // gap: low 1003 above the block's 1000
  a10: [1014, 1024, 1012, 1022], // BREAK: closes above 1020
  a11: [1022, 1035, 1020, 1032],
  a12: [1032, 1040, 1030, 1038],
  a13: [1038, 1039, 1028, 1030], // INDUCEMENT (1028)
  a14: [1030, 1045, 1029, 1042], // TARGET high (1045)
  a15: [1042, 1043, 1025, 1027], // SWEEP: low under 1028
  a16: [1027, 1028, 1010, 1012],
  a17: [1012, 1013, 998, 1004],  // RETEST: touches 1000, closes down
  a18: [1004, 1008, 1001, 1007], // REACTION: closes up — entry at 1007
};

// overrides: { a10: [...] } swaps a named bar, so each test breaks one rule.
function bullBars(overrides) {
  const named = Object.keys(BARS).map(k => (overrides && overrides[k]) || BARS[k]);
  return [...Array.from({ length: 80 }, () => FLAT.slice()), ...named];
}

// Turns rows into candles on one trading day per 75 bars, 09:15 IST onward.
const DAY0 = Date.UTC(2026, 0, 5, 3, 45) / 1000; // Mon 09:15 IST
function toCandles(rows, stepSec = 300, firstBarOffset = 0) {
  return rows.map((r, i) => {
    const bar = i + firstBarOffset;
    const day = Math.floor(bar / 75), inDay = bar % 75;
    return { time: DAY0 + day * 86400 + inDay * stepSec, open: r[0], high: r[1], low: r[2], close: r[3], volume: 1000 };
  });
}

// The exact opposite setup, for proving PE is a true mirror of CE.
function mirrorRows(rows, about = 2000) {
  return rows.map(([o, h, l, c]) => [about - o, about - l, about - h, about - c]);
}

module.exports = { bullBars, toCandles, mirrorRows };
