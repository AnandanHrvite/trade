/* Put every chart and every quoted price in a guide on ONE price base.
 *
 * Background: the six "whole session" charts were regenerated onto six distinct
 * price bases so they stop looking like the same picture. That left each guide
 * internally inconsistent — the ORB session chart sits at 25,170 while the ORB
 * detail charts and worked examples still said 24,372 for what the text presents
 * as the same example day.
 *
 * This shifts each guide's OTHER charts, and the prices quoted in its prose, by a
 * constant so everything lands in that guide's band. A constant offset is used
 * rather than a rescale because every relationship the guides teach is expressed
 * in POINTS (a 60pt box, a 38pt stop, +116 points) and those must not move.
 * Adding a constant preserves every difference exactly.
 *
 * Left alone on purpose:
 *   - the session chart and its caption — already on the target base;
 *   - anything that is not a NIFTY-looking price. The match is deliberately
 *     narrow (23,000-26,999, optional thousands comma, optional decimals) so
 *     rupee amounts (₹1,500 / ₹3,814 / ₹10,700), percentages, periods, counts
 *     and hex colours cannot be caught by it.
 *
 * NOT idempotent — it is a one-shot alignment, kept here as the record of how the
 * numbers were derived. Re-running would shift twice; set the offsets to 0 first.
 */
const fs = require("fs");
const path = require("path");

const GUIDES = path.join(__dirname, "..", "documents");

// offset = (this guide's session-chart mid price) − (its other charts' mid price),
// rounded so the shifted values stay readable.
const PLAN = [
  { file: "BB_RSI_Strategy_Guide.html",         sessionId: "bbr-session", offset:  -260 },
  { file: "EMA9_VWAP_Strategy_Guide.html",      sessionId: "ev-session",  offset: -1250 },
  { file: "EMA_RSI_ST_Strategy_Guide.html",     sessionId: "ers-session", offset:   280 },
  { file: "ORB_Strategy_Guide.html",            sessionId: "orb-session", offset:   950 },
  { file: "Price_Action_Strategy_Guide.html",   sessionId: "pa-session",  offset:   180 },
  { file: "Trend_Pullback_Strategy_Guide.html", sessionId: "tpb-session", offset:  2070 },
];

/**
 * One pass, one shift per number — handles bare literals (24372), decimals
 * (24372.05) and comma'd prose/labels ("24,372") alike, so nothing can be
 * shifted twice. The lookbehind stops it firing inside a longer number.
 */
const PRICE = /(?<![\d.])(2[3-6])(,?)(\d{3})(\.\d+)?(?![\d])/g;

function shift(text, offset) {
  let hits = 0;
  const out = text.replace(PRICE, (m, hi, comma, lo, frac) => {
    hits++;
    const v = parseInt(hi + lo, 10) + offset;
    const head = comma ? String(Math.floor(v / 1000)) + "," + String(v % 1000).padStart(3, "0") : String(v);
    return head + (frac || "");
  });
  return { out, hits };
}

/** The balanced TVChart.render("id", …) call, so it can be excluded. */
function renderCallSpan(html, id) {
  const marker = `TVChart.render("${id}", `;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + marker.length; i < html.length; i++) {
    const ch = html[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth < 0) return { start, end: i + 1 }; }
  }
  return null;
}

// Second pass: a WHOLE-file shift (session chart included) purely to separate two
// guides whose bands still overlapped after pass 1 — Price Action sat at
// 24,330-24,575 and EMA_RSI_ST at 24,397-24,736, so their y-axes looked alike even
// though the chart shapes differ. Moving PA down clears it completely.
const PLAN2 = [
  { file: "Price_Action_Strategy_Guide.html", offset: -300 },
  { file: "BB_RSI_Strategy_Guide.html",       offset: -150 },  // clears a 39pt overlap with PA
];

let total = 0;
for (const { file, sessionId, offset } of PLAN) {
  if (!offset) { console.log(`- ${file}: offset 0, skipped`); continue; }
  const p = path.join(GUIDES, file);
  const html = fs.readFileSync(p, "utf-8");

  const span = renderCallSpan(html, sessionId);
  if (!span) { console.log(`✗ ${file}: session chart ${sessionId} not found`); continue; }
  const divIdx = html.indexOf(`id="${sessionId}"`);
  const capStart = html.indexOf('<p class="tv-cap">', divIdx);
  const capEnd = capStart < 0 ? -1 : html.indexOf("</p>", capStart) + 4;

  const frozen = [{ s: span.start, e: span.end }];
  if (capStart > 0) frozen.push({ s: capStart, e: capEnd });
  frozen.sort((a, b) => a.s - b.s);

  let out = "", cursor = 0, hits = 0;
  for (const fz of frozen) {
    const r = shift(html.slice(cursor, fz.s), offset);
    out += r.out; hits += r.hits;
    out += html.slice(fz.s, fz.e);          // frozen, verbatim
    cursor = fz.e;
  }
  const tail = shift(html.slice(cursor), offset);
  out += tail.out; hits += tail.hits;

  fs.writeFileSync(p, out);
  total++;
  console.log(`✓ ${file}  offset ${offset > 0 ? "+" : ""}${offset}  (${hits} prices shifted)`);
}
for (const { file, offset } of PLAN2) {
  const p = path.join(GUIDES, file);
  const r = shift(fs.readFileSync(p, "utf-8"), offset);
  fs.writeFileSync(p, r.out);
  console.log(`✓ ${file}  whole-file offset ${offset > 0 ? "+" : ""}${offset}  (${r.hits} prices shifted)`);
}

console.log(`\n${total} guide(s) aligned, ${PLAN2.length} separated.`);
