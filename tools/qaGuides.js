/* QA harness for documents/*.html strategy guides.
 * 1. every <div class="tv-chart" id="X"> has a TVChart.render("X", …) call
 * 2. every render call targets an existing div
 * 3. the chart scripts parse + execute (TVChart.buildSVG produces real SVG)
 * 4. no unbalanced <section>/<table> tags
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = process.argv[2] || require("path").join(__dirname, "..", "documents");
const files = process.argv[3] ? [process.argv[3]] : fs.readdirSync(dir).filter(f => f.endsWith(".html"));
let fail = 0;

for (const f of files) {
  const html = fs.readFileSync(path.join(dir, f), "utf-8");
  const problems = [];

  // --- chart ids ---
  const divIds = [...html.matchAll(/<div class="tv-chart[^"]*"\s+id="([^"]+)"/g)].map(m => m[1]);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const renderIds = [];

  // --- execute scripts in a sandbox with a fake DOM ---
  const rendered = {};
  const els = {};
  divIds.forEach(id => { els[id] = { get innerHTML() { return rendered[id] || ""; }, set innerHTML(v) { rendered[id] = v; } }; });
  const sandbox = {
    console,
    document: {
      readyState: "complete",
      addEventListener() {},
      getElementById(id) { renderIds.push(id); return els[id] || null; },
    },
  };
  sandbox.window = sandbox;
  try {
    vm.createContext(sandbox);
    scripts.forEach((s, i) => vm.runInContext(s, sandbox, { filename: `${f}#script${i}`, timeout: 8000 }));
  } catch (e) {
    problems.push(`script threw: ${e.message}`);
  }

  const missing = divIds.filter(id => !renderIds.includes(id));
  const orphan = renderIds.filter(id => !divIds.includes(id));
  if (missing.length) problems.push(`div with no render call: ${missing.join(", ")}`);
  if (orphan.length) problems.push(`render call with no div: ${orphan.join(", ")}`);

  for (const id of divIds) {
    const out = rendered[id] || "";
    if (!out.includes("<svg")) problems.push(`chart "${id}" produced no SVG (${out.slice(0, 60) || "empty"})`);
    else if (out.includes("NaN") || out.includes("undefined")) problems.push(`chart "${id}" SVG contains NaN/undefined`);
  }

  // --- crude tag balance ---
  for (const tag of ["section", "table", "tbody", "thead", "div"]) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    if (open !== close) problems.push(`<${tag}> unbalanced: ${open} open vs ${close} close`);
  }

  // --- anchors referenced by the TOC must exist ---
  const anchors = [...html.matchAll(/<a href="#([^"]+)"/g)].map(m => m[1]);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const deadAnchors = [...new Set(anchors)].filter(a => !ids.has(a));
  if (deadAnchors.length) problems.push(`TOC links to missing anchors: ${deadAnchors.join(", ")}`);

  if (problems.length) { fail++; console.log(`✗ ${f}`); problems.forEach(p => console.log(`    ${p}`)); }
  else console.log(`✓ ${f}  (${divIds.length} charts)`);
}
process.exit(fail ? 1 : 0);
