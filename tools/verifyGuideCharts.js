/* Assert that each session chart's marked entry/exit actually obeys the rule its
 * caption claims — otherwise a guide teaches one thing and draws another.
 *
 * These are illustrative charts, not recorded sessions, which is exactly why they
 * need checking: a hand-placed marker can drift from the rule silently. This ran
 * after the price-alignment pass and caught the BB_RSI profit-lock exit sitting at
 * a 6-point giveback while the caption described a 50% giveback.
 */
const fs = require("fs");
const path = require("path");
const GUIDES = path.join(__dirname, "..", "documents");

function spec(guide, id) {
  const html = fs.readFileSync(path.join(GUIDES, `${guide}_Strategy_Guide.html`), "utf-8");
  const marker = `TVChart.render("${id}", `;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`${guide}: no render call for ${id}`);
  let depth = 0, i = start + marker.length;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth < 0) break; }
  }
  return JSON.parse(html.slice(start + marker.length, i));
}
const at = i => { const m = 9 * 60 + 15 + i * 5; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
const byText = (s, p) => s.markers.find(m => m.text && m.text.startsWith(p));

let fail = 0;
const check = (name, ok, detail) => { if (!ok) fail++; console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(34)} ${detail}`); };

// ORB — exit is the FIRST candle to close back below EMA20 after entry.
{
  const s = spec("ORB", "orb-session"), c = s.candles;
  const e = s.overlays.find(o => o.name === "EMA20").data;
  const en = byText(s, "BUY"), ex = s.markers.find(m => m.type === "exit");
  let first = null;
  for (let i = en.i + 1; i < c.length; i++) if (e[i] != null && c[i][3] < e[i]) { first = i; break; }
  check("ORB exit = first close < EMA20", first === ex.i,
    `exit ${at(ex.i)} close ${c[ex.i][3]} vs EMA20 ${e[ex.i]}; first break ${first == null ? "never" : at(first)}`);
}

// EMA_RSI_ST — on this day price never bounces back to the EMA21 trail, so the
// trade must end on the exit-before-close rule instead. Assert BOTH halves: that
// the trail is genuinely never touched, and that the exit sits at 14:30
// (EMA_RSI_ST_EOD_EXIT_TIME, the shipped Settings value). A caption claiming a
// trail exit here would be describing something the chart does not show.
{
  const s = spec("EMA_RSI_ST", "ers-session"), c = s.candles;
  const e = s.overlays.find(o => o.name === "EMA21 trail").data;
  const en = byText(s, "BUY"), ex = byText(s, "EXIT");
  let touch = null;
  for (let i = en.i + 1; i < c.length; i++) if (e[i] != null && c[i][2] <= e[i] && c[i][1] >= e[i]) { touch = i; break; }
  check("EMA_RSI_ST trail never touched", touch === null,
    touch === null ? "no candle spans EMA21 after entry — EOD exit is correct" : `trail touched at ${at(touch)}`);
  check("EMA_RSI_ST exit = 14:30 EOD rule", at(ex.i) === "14:30",
    `exit ${at(ex.i)} @ ${ex.price} (EMA_RSI_ST_EOD_EXIT_TIME=14:30)`);
}

// EMA9+VWAP — exit candle is red and closes below both previous lows.
{
  const s = spec("EMA9_VWAP", "ev-session"), c = s.candles;
  const ex = s.markers.find(m => m.type === "exit"), i = ex.i;
  const red = c[i][3] < c[i][0], below = c[i][3] < c[i - 1][2] && c[i][3] < c[i - 2][2];
  check("EMA9VWAP exit = 2-candle reversal", red && below,
    `exit ${at(i)} red=${red} close ${c[i][3]} vs prev lows ${c[i - 1][2]}/${c[i - 2][2]}`);
}

// BB_RSI — exit sits at the profit-lock floor: entry + 50% of the peak gain.
{
  const s = spec("BB_RSI", "bbr-session"), c = s.candles;
  const en = byText(s, "BUY"), ex = s.markers.find(m => m.type === "exit");
  let peak = -Infinity, pi = 0;
  for (let i = en.i; i < ex.i; i++) if (c[i][1] > peak) { peak = c[i][1]; pi = i; }
  const floor = Math.round((c[en.i][3] + 0.5 * (peak - c[en.i][3])) * 100) / 100;
  check("BB_RSI exit = 50% profit-lock floor", Math.abs(ex.price - floor) < 0.5 && c[ex.i][2] <= floor,
    `peak ${peak} @${at(pi)}, floor ${floor}, exit ${ex.price} @${at(ex.i)} (low ${c[ex.i][2]})`);
}

// Trend Pullback — the entry candle is green, closes above EMA20 and above the prior high.
{
  const s = spec("Trend_Pullback", "tpb-session"), c = s.candles;
  const e = s.overlays[0].data, en = s.markers.find(m => m.type === "buy"), i = en.i;
  const green = c[i][3] > c[i][0], aboveEma = e[i] != null && c[i][3] > e[i], abovePrev = c[i][3] > c[i - 1][1];
  check("TREND_PB entry = resumption candle", green && aboveEma && abovePrev,
    `${at(i)} green=${green}, close ${c[i][3]} > EMA20 ${e[i]}=${aboveEma}, > prevHigh ${c[i - 1][1]}=${abovePrev}`);
}

// ORB — the opening-range box is measured off the first three candles.
{
  const s = spec("ORB", "orb-session"), c = s.candles, z = s.zones[0];
  const hi = Math.max(...c.slice(0, 3).map(x => x[1])), lo = Math.min(...c.slice(0, 3).map(x => x[2]));
  check("ORB box = first 3 candles", Math.abs(z.top - hi) < 0.5 && Math.abs(z.bottom - lo) < 0.5,
    `box ${z.bottom}–${z.top} vs candles ${lo.toFixed(2)}–${hi.toFixed(2)} (${Math.round(hi - lo)}pt)`);
}

// ── Caption arithmetic: the "+N points" claimed next to the EXIT must equal
//    exit − entry. Takes the claim that FOLLOWS the exit price, because a caption
//    may legitimately quote an earlier figure too (BB_RSI quotes the +50 peak run
//    before the +25 it actually banks).
console.log("");
const SESSIONS = { ORB: "orb-session", EMA_RSI_ST: "ers-session", BB_RSI: "bbr-session",
  EMA9_VWAP: "ev-session", Price_Action: "pa-session", Trend_Pullback: "tpb-session" };
const num = s => (s == null ? null : parseInt(String(s).replace(/,/g, ""), 10));
for (const [guide, id] of Object.entries(SESSIONS)) {
  const html = fs.readFileSync(path.join(GUIDES, `${guide}_Strategy_Guide.html`), "utf-8");
  const i = html.indexOf(`id="${id}"`);
  const cs = html.indexOf('<p class="tv-cap">', i);
  const cap = html.slice(cs, html.indexOf("</p>", cs)).replace(/<[^>]+>/g, "").replace(/&mdash;/g, "-");
  const buy = (cap.match(/BUY (?:CE|PE)(?: on retest| at)? ?([\d,]{5,6})/) || [])[1];
  const exitAt = cap.search(/EXIT [\d,]{5,6}/);
  const exit = (cap.match(/EXIT ([\d,]{5,6})/) || [])[1];
  const claim = exitAt < 0 ? null : (cap.slice(exitAt).match(/\+?([\d,]+) (?:spot )?points/) || [])[1];
  const diff = (num(buy) != null && num(exit) != null) ? Math.abs(num(exit) - num(buy)) : null;
  check(`${guide} caption arithmetic`, claim == null || diff == null || diff === num(claim),
    `${buy} → ${exit} = ${diff} pts, caption claims +${claim}`);
}

// ── Every price quoted in ANY caption must be a value that chart actually draws.
//    Covers all 26 charts, not just the six session ones. Tolerance 2 points, and
//    the haystack is deliberately wide — a caption may legitimately name a level
//    that is not a marker (a box edge, a peak high, the stop the strategy wanted),
//    so candles, zones, overlays and bands all count.
console.log("");
{
  const drawnValues = s => {
    const v = [];
    (s.candles || []).forEach(c => c.forEach(x => typeof x === "number" && v.push(x)));
    (s.markers || []).forEach(m => typeof m.price === "number" && v.push(m.price));
    (s.zones   || []).forEach(z => [z.top, z.bottom].forEach(x => typeof x === "number" && v.push(x)));
    (s.overlays|| []).forEach(o => (o.data || []).forEach(x => typeof x === "number" && v.push(x)));
    (s.bands   || []).forEach(b => ["upper", "lower", "mid"].forEach(k => (b[k] || []).forEach(x => typeof x === "number" && v.push(x))));
    return v;
  };
  let charts = 0, prices = 0;
  for (const file of fs.readdirSync(GUIDES).filter(f => f.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(GUIDES, file), "utf-8");
    const re = /TVChart\.render\("([^"]+)", /g;
    let m;
    while ((m = re.exec(html)) !== null) {
      let depth = 0, i = m.index + m[0].length, end = -1;
      for (; i < html.length; i++) {
        const ch = html[i];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth < 0) { end = i; break; } }
      }
      let s = null;
      try { s = JSON.parse(html.slice(m.index + m[0].length, end)); }
      catch (_) { try { s = eval("(" + html.slice(m.index + m[0].length, end) + ")"); } catch (_) { continue; } }
      const di = html.indexOf(`id="${m[1]}"`);
      const cs = di < 0 ? -1 : html.indexOf('<p class="tv-cap">', di);
      if (cs < 0) continue;
      const cap = html.slice(cs, html.indexOf("</p>", cs)).replace(/<[^>]+>/g, "");
      const V = drawnValues(s);
      const quoted = [...cap.matchAll(/(?<![\d.])(2[3-6]),(\d{3})(?![\d])/g)].map(x => parseInt(x[1] + x[2], 10));
      const orphan = quoted.filter(q => !V.some(v => Math.abs(v - q) <= 2));
      charts++; prices += quoted.length;
      if (orphan.length) { fail++; console.log(`  ✗ ${file.replace("_Strategy_Guide.html", "")} #${m[1]} quotes ${orphan.join(",")} — not drawn on that chart`); }
    }
  }
  check("all caption prices are drawn", true, `${prices} prices across ${charts} captioned charts`);
}

console.log(fail ? `\n${fail} check(s) failed — a guide draws something its text does not describe` : "\nevery marked entry/exit obeys the rule its caption states");
process.exit(fail ? 1 : 0);
