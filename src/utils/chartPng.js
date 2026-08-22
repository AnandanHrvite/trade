/**
 * chartPng.js — dependency-free candlestick chart → PNG
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders the same picture the paper pages draw with lightweight-charts, but
 * server-side and with zero new npm packages: we rasterise straight into an RGB
 * pixel buffer and wrap it in a PNG container (zlib is in Node core).
 *
 * Why not screenshot the real page? The paper chart is drawn in the browser, so
 * capturing it would mean shipping headless Chromium (~300 MB) onto the EC2 box
 * for one image a day. This module takes the SAME `{candles, markers}` payload
 * the page's /status/chart-data endpoint already returns, so the picture is
 * built from identical data — only the pixels are drawn here instead of there.
 *
 * Deliberately minimal: candles, an optional overlay line, entry/exit markers,
 * axes and a title. No indicators panes, no crosshair, no interactivity — this
 * is a glanceable end-of-day snapshot for Telegram, not the live chart.
 */

const zlib = require("zlib");

// ── Canvas ──────────────────────────────────────────────────────────────────
// Sized for a phone: Telegram scales a photo to the chat width, so a wider
// image just means smaller candles on screen. 1000×560 keeps a full session of
// 5-minute candles legible on the user's iPhone without horizontal squeeze.
const WIDTH   = 1000;
const HEIGHT  = 560;
const PAD_L   = 12;
const PAD_R   = 74;   // right gutter holds the price axis labels
const PAD_T   = 46;   // top strip holds the title
const PAD_B   = 34;   // bottom strip holds the time axis

// Dark palette, matching the dashboard's own chart colours.
const C_BG        = [17, 24, 39];
const C_GRID      = [31, 41, 55];
const C_AXIS_TEXT = [148, 163, 184];
const C_TITLE     = [226, 232, 240];
const C_UP        = [16, 185, 129];
const C_DOWN      = [239, 68, 68];
const C_OVERLAY   = [96, 165, 250];
const C_ENTRY     = [59, 130, 246];
const C_WIN       = [16, 185, 129];
const C_LOSS      = [239, 68, 68];

// ── Pixel buffer ────────────────────────────────────────────────────────────

function createCanvas(w, h, bg) {
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    px[i * 3]     = bg[0];
    px[i * 3 + 1] = bg[1];
    px[i * 3 + 2] = bg[2];
  }
  return { w, h, px };
}

function setPx(cv, x, y, c) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 3;
  cv.px[i] = c[0]; cv.px[i + 1] = c[1]; cv.px[i + 2] = c[2];
}

function fillRect(cv, x, y, w, h, c) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(cv.w, Math.round(x + w));
  const y1 = Math.min(cv.h, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) setPx(cv, xx, yy, c);
  }
}

/** Bresenham — used for the overlay polyline and marker glyphs. */
function drawLine(cv, x0, y0, x1, y1, c) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  // Guard against a pathological run if inputs are NaN — the loop below is
  // otherwise unbounded when a coordinate never reaches its target.
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return;
  for (let guard = 0; guard < 8000; guard++) {
    setPx(cv, x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// ── Bitmap font ─────────────────────────────────────────────────────────────
// A 5×7 glyph set covering the characters axis labels and titles actually use.
// Each string is 7 rows of 5 columns; "1" paints a pixel. Rendering text with a
// real font would mean a font library and a rasteriser — vastly more code than
// the handful of labels this chart needs.
const GLYPHS = {
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["11111","00010","00100","00010","00001","10001","01110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["00110","01000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00010","01100"],
  "A": ["01110","10001","10001","11111","10001","10001","10001"],
  "B": ["11110","10001","10001","11110","10001","10001","11110"],
  "C": ["01110","10001","10000","10000","10000","10001","01110"],
  "D": ["11110","10001","10001","10001","10001","10001","11110"],
  "E": ["11111","10000","10000","11110","10000","10000","11111"],
  "F": ["11111","10000","10000","11110","10000","10000","10000"],
  "G": ["01110","10001","10000","10111","10001","10001","01111"],
  "H": ["10001","10001","10001","11111","10001","10001","10001"],
  "I": ["01110","00100","00100","00100","00100","00100","01110"],
  "J": ["00111","00010","00010","00010","00010","10010","01100"],
  "K": ["10001","10010","10100","11000","10100","10010","10001"],
  "L": ["10000","10000","10000","10000","10000","10000","11111"],
  "M": ["10001","11011","10101","10101","10001","10001","10001"],
  "N": ["10001","11001","10101","10011","10001","10001","10001"],
  "O": ["01110","10001","10001","10001","10001","10001","01110"],
  "P": ["11110","10001","10001","11110","10000","10000","10000"],
  "Q": ["01110","10001","10001","10001","10101","10010","01101"],
  "R": ["11110","10001","10001","11110","10100","10010","10001"],
  "S": ["01111","10000","10000","01110","00001","00001","11110"],
  "T": ["11111","00100","00100","00100","00100","00100","00100"],
  "U": ["10001","10001","10001","10001","10001","10001","01110"],
  "V": ["10001","10001","10001","10001","10001","01010","00100"],
  "W": ["10001","10001","10001","10101","10101","11011","10001"],
  "X": ["10001","10001","01010","00100","01010","10001","10001"],
  "Y": ["10001","10001","01010","00100","00100","00100","00100"],
  "Z": ["11111","00001","00010","00100","01000","10000","11111"],
  "+": ["00000","00100","00100","11111","00100","00100","00000"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"],
  ",": ["00000","00000","00000","00000","01100","00100","01000"],
  ":": ["00000","01100","01100","00000","01100","01100","00000"],
  "/": ["00001","00010","00010","00100","01000","01000","10000"],
  "(": ["00010","00100","01000","01000","01000","00100","00010"],
  ")": ["01000","00100","00010","00010","00010","00100","01000"],
  "%": ["11001","11010","00010","00100","01000","01011","10011"],
  "@": ["01110","10001","10111","10101","10111","10000","01110"],
  "#": ["01010","01010","11111","01010","11111","01010","01010"],
  "=": ["00000","00000","11111","00000","11111","00000","00000"],
  "|": ["00100","00100","00100","00100","00100","00100","00100"],
  "_": ["00000","00000","00000","00000","00000","00000","11111"],
  "*": ["00000","10101","01110","11111","01110","10101","00000"],
  "'": ["00100","00100","00100","00000","00000","00000","00000"],
  "?": ["01110","10001","00001","00010","00100","00000","00100"],
  "!": ["00100","00100","00100","00100","00100","00000","00100"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

/** Width in pixels of `text` at the given scale, including inter-glyph gaps. */
function textWidth(text, scale) {
  const n = String(text).length;
  if (n === 0) return 0;
  return n * (GLYPH_W * scale + scale) - scale;
}

function drawText(cv, text, x, y, c, scale) {
  scale = scale || 1;
  let cx = Math.round(x);
  for (const raw of String(text)) {
    // Typographic dashes/quotes are common in the titles we're handed; fold them
    // onto their ASCII twins so they don't render as "?".
    const ch = ({ "\u2014": "-", "\u2013": "-", "\u2018": "'", "\u2019": "'", "\u00d7": "X" }[raw] || raw).toUpperCase();
    const g  = GLYPHS[ch] || GLYPHS["?"];
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (g[row][col] === "1") fillRect(cv, cx + col * scale, y + row * scale, scale, scale, c);
      }
    }
    cx += GLYPH_W * scale + scale;
  }
}

// ── PNG encoding ────────────────────────────────────────────────────────────

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body    = Buffer.concat([typeBuf, data]);
  const crcBuf  = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crcBuf]);
}

/** Encode an RGB pixel buffer as a PNG (colour type 2, 8-bit, filter 0). */
function encodePng(cv) {
  const raw = Buffer.alloc(cv.h * (cv.w * 3 + 1));
  for (let y = 0; y < cv.h; y++) {
    const rowStart = y * (cv.w * 3 + 1);
    raw[rowStart] = 0; // filter type: none
    cv.px.copy(raw, rowStart + 1, y * cv.w * 3, (y + 1) * cv.w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Candle epoch seconds → "HH:MM" in IST, for the time axis. */
function istHHMM(epochSec) {
  try {
    return new Date(epochSec * 1000).toLocaleTimeString("en-GB", {
      timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch (_) {
    return "";
  }
}

function niceNum(v) {
  const a = Math.abs(v);
  if (a >= 1000) return String(Math.round(v));
  if (a >= 100)  return v.toFixed(0);
  return v.toFixed(1);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * renderChartPng({ title, subtitle, candles, markers, overlay })
 *
 *   candles  [{ time, open, high, low, close }]   time = epoch seconds
 *   markers  [{ time, position, color, shape, text }]  — the page's own shape
 *   overlay  [{ time, value }]                    — optional single line
 *
 * Returns a PNG Buffer, or null when there is nothing worth drawing.
 */
function renderChartPng({ title, subtitle, candles, markers, overlay } = {}) {
  const cs = (candles || []).filter(c =>
    c && Number.isFinite(c.high) && Number.isFinite(c.low) &&
    Number.isFinite(c.open) && Number.isFinite(c.close));
  if (cs.length < 2) return null;

  const cv = createCanvas(WIDTH, HEIGHT, C_BG);

  const plotX = PAD_L;
  const plotY = PAD_T;
  const plotW = WIDTH - PAD_L - PAD_R;
  const plotH = HEIGHT - PAD_T - PAD_B;

  // Price range across candles AND any overlay, padded 4% so nothing clips.
  let lo = Infinity, hi = -Infinity;
  for (const c of cs) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
  for (const p of overlay || []) {
    if (p && Number.isFinite(p.value)) {
      if (p.value < lo) lo = p.value;
      if (p.value > hi) hi = p.value;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }   // flat series → give it height
  const padRange = (hi - lo) * 0.04;
  lo -= padRange; hi += padRange;

  const yOf = (price) => plotY + plotH - ((price - lo) / (hi - lo)) * plotH;

  // Candles are indexed, not time-scaled, so gaps (lunch lulls, missing bars)
  // don't stretch the chart — same as the page's lightweight-charts default.
  const slotW = plotW / cs.length;
  const bodyW = Math.max(1, Math.min(11, Math.floor(slotW * 0.62)));
  const xOf   = (i) => plotX + i * slotW + slotW / 2;

  // Horizontal grid + right-hand price labels.
  const GRID_ROWS = 5;
  for (let g = 0; g <= GRID_ROWS; g++) {
    const price = lo + ((hi - lo) * g) / GRID_ROWS;
    const y = Math.round(yOf(price));
    fillRect(cv, plotX, y, plotW, 1, C_GRID);
    drawText(cv, niceNum(price), plotX + plotW + 6, y - 3, C_AXIS_TEXT, 1);
  }

  // Time axis — about six evenly spaced labels, centred under their candle.
  const LABELS = 6;
  const step   = Math.max(1, Math.floor(cs.length / LABELS));
  for (let i = 0; i < cs.length; i += step) {
    const label = istHHMM(cs[i].time);
    if (!label) continue;
    const x = xOf(i) - textWidth(label, 1) / 2;
    drawText(cv, label, x, plotY + plotH + 10, C_AXIS_TEXT, 1);
  }

  // Overlay line (e.g. VWAP / EMA), drawn under the candles so wicks stay read-
  // able. Points are matched to candles by time; unmatched points are skipped.
  if (overlay && overlay.length) {
    const idxByTime = new Map();
    for (let i = 0; i < cs.length; i++) idxByTime.set(cs[i].time, i);
    let prev = null;
    for (const p of overlay) {
      if (!p || !Number.isFinite(p.value)) continue;
      const i = idxByTime.get(p.time);
      if (i === undefined) continue;
      const cur = { x: xOf(i), y: yOf(p.value) };
      if (prev) drawLine(cv, prev.x, prev.y, cur.x, cur.y, C_OVERLAY);
      prev = cur;
    }
  }

  // Candles.
  for (let i = 0; i < cs.length; i++) {
    const c   = cs[i];
    const col = c.close >= c.open ? C_UP : C_DOWN;
    const x   = xOf(i);
    fillRect(cv, x - 0.5, yOf(c.high), 1, Math.max(1, yOf(c.low) - yOf(c.high)), col);
    const yTop = yOf(Math.max(c.open, c.close));
    const yBot = yOf(Math.min(c.open, c.close));
    fillRect(cv, x - bodyW / 2, yTop, bodyW, Math.max(1, yBot - yTop), col);
  }

  // Entry / exit markers — a triangle at the candle plus its label. Colour and
  // direction come straight from the page's marker payload, so the Telegram
  // image and the web chart always agree on what an arrow means.
  const idxByTime = new Map();
  for (let i = 0; i < cs.length; i++) idxByTime.set(cs[i].time, i);
  for (const m of markers || []) {
    if (!m) continue;
    const i = idxByTime.get(m.time);
    if (i === undefined) continue;
    const c    = cs[i];
    const up   = m.position !== "aboveBar";
    const col  = hexToRgb(m.color) || (up ? C_ENTRY : C_WIN);
    const x    = xOf(i);
    const yRef = up ? yOf(c.low) + 7 : yOf(c.high) - 7;

    // Triangle: pointing up below the bar (entry), down above it (exit).
    const H = 7;
    for (let r = 0; r < H; r++) {
      const halfW = up ? (r * 0.62) : ((H - 1 - r) * 0.62);
      const yy    = up ? yRef + r : yRef - (H - 1 - r);
      fillRect(cv, x - halfW, yy, Math.max(1, halfW * 2), 1, col);
    }

    if (m.text) {
      const label = String(m.text).slice(0, 16);
      const lw = textWidth(label, 1);
      const lx = Math.min(WIDTH - PAD_R - lw - 2, Math.max(plotX, x - lw / 2));
      const ly = up ? yRef + H + 3 : yRef - H - 10;
      // Marker labels sit on top of candles, where thin text on a red/green body
      // is unreadable. Lay an opaque plate down first so every label stays legible
      // wherever the arrow lands.
      fillRect(cv, lx - 2, ly - 2, lw + 4, GLYPH_H + 4, C_BG);
      drawText(cv, label, lx, ly, col, 1);
    }
  }

  if (title)    drawText(cv, String(title).slice(0, 46), PAD_L, 10, C_TITLE, 2);
  if (subtitle) drawText(cv, String(subtitle).slice(0, 78), PAD_L, 30, C_AXIS_TEXT, 1);

  return encodePng(cv);
}

function hexToRgb(hex) {
  if (!hex || typeof hex !== "string") return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

module.exports = { renderChartPng };
