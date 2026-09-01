/**
 * GEN ENV DOCS — build docs/ENV.md from the code, not by hand.
 *
 * The env reference used to live in README.md as ~650 hand-maintained lines.
 * It drifted: 71 keys were read in src/ and documented nowhere. This script
 * derives the reference from the two places that cannot lie —
 *
 *   1. every `process.env.X` read in src/  (existence, default, type, callers)
 *   2. SETTINGS_SCHEMA in src/routes/settings.js  (label, description, section)
 *
 * — so the doc is a build artifact. It also reports conflicts: the same key
 * given different fallbacks at different call sites is a real bug, and this is
 * the only place that notices.
 *
 *   npm run docs:env          # rewrite docs/ENV.md
 *   npm run docs:env -- --check   # exit 1 if stale (for CI / pre-push)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "docs", "ENV.md");
const SETTINGS_FILE = path.join(SRC, "routes", "settings.js");

// Keys that are infrastructure rather than tuning knobs — documented, but
// grouped last so the strategy sections stay readable.
const INFRA = /^(NODE_ENV|PORT|npm_)/;

// Secrets: list the key, never a default. A default here would be a leak.
const SECRET = /(SECRET|TOKEN|PASSWORD|API_KEY|APP_ID|ACCESS|_PIN|_TOTP|WEBHOOK)/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 1. Scan the code
 * ------------------------------------------------------------------------- */

// Matches the read itself; the default is parsed from what follows, so that a
// template literal or a nested call can never swallow the next statement.
const READ = /process\.env\.([A-Z][A-Z0-9_]*)/g;

const NUM_WRAPPER = /(Number|parseInt|parseFloat)\s*\(\s*$/;

// A read inside a `${...}` slot of a template literal is almost always a status
// panel or a log banner rather than the engine reading its own config. The two
// drift independently, and when they do the UI reports a config the engine is
// not running — so classify them apart instead of lumping both into "default".
function isDisplaySite(text, index) {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const before = text.slice(lineStart, index);
  const opens = (before.match(/\$\{/g) || []).length;
  const closes = (before.match(/\}/g) || []).length;
  return opens > closes;
}

function parseDefault(tail, head) {
  // `|| "x"` / `?? "x"` — the classic fallback.
  let m = tail.match(/^\s*(?:\|\||\?\?)\s*(["'`])([^"'`]*)\1/);
  if (m) return { value: m[2], kind: "fallback" };

  // `|| 30` — numeric fallback, no quotes.
  m = tail.match(/^\s*(?:\|\||\?\?)\s*(-?\d+(?:\.\d+)?)\b/);
  if (m) return { value: m[1], kind: "fallback" };

  // `=== "true"` — opt-in boolean, so the default is off.
  m = tail.match(/^\s*===\s*(["'])([^"']*)\1/);
  if (m) return { value: m[2] === "true" ? "false" : `(not ${m[2]})`, kind: "boolean" };

  // `!== "false"` — opt-out boolean, so the default is on.
  m = tail.match(/^\s*!==\s*(["'])([^"']*)\1/);
  if (m) return { value: m[2] === "false" ? "true" : `(any but ${m[2]})`, kind: "boolean" };

  // `|| process.env.OTHER || "x"` — chained fallback, record the chain.
  m = tail.match(/^\s*\|\|\s*process\.env\.([A-Z][A-Z0-9_]*)/);
  if (m) return { value: null, kind: "chain", chainsTo: m[1] };

  return { value: null, kind: NUM_WRAPPER.test(head) ? "number" : "none" };
}

function scanCode() {
  const keys = new Map();

  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    let m;

    READ.lastIndex = 0;
    while ((m = READ.exec(text)) !== null) {
      const name = m[1];
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 120);
      const head = text.slice(Math.max(0, m.index - 20), m.index);
      const parsed = parseDefault(tail, head);

      if (!keys.has(name)) {
        keys.set(name, {
          name, files: new Set(), kinds: new Set(), chainsTo: null,
          defaults: new Map(),        // engine reads — these decide behaviour
          displayDefaults: new Map(), // status panels / log banners
          sites: [],
        });
      }
      const rec = keys.get(name);
      const display = isDisplaySite(text, m.index);
      rec.files.add(rel);
      rec.kinds.add(parsed.kind);
      if (parsed.chainsTo) rec.chainsTo = parsed.chainsTo;
      if (parsed.value !== null) {
        const bucket = display ? rec.displayDefaults : rec.defaults;
        bucket.set(parsed.value, (bucket.get(parsed.value) || 0) + 1);
        rec.sites.push({ file: rel, value: parsed.value, display });
      }
    }
  }
  return keys;
}

/* ---------------------------------------------------------------------------
 * 2. Scan SETTINGS_SCHEMA for human-written labels and descriptions
 * ------------------------------------------------------------------------- */

function scanSettings() {
  const text = fs.readFileSync(SETTINGS_FILE, "utf8");
  const meta = new Map();
  let section = "Ungrouped";

  for (const line of text.split("\n")) {
    const sec = line.match(/section:\s*"([^"]+)"/);
    if (sec) section = sec[1];

    const key = line.match(/\bkey:\s*"([A-Z][A-Z0-9_]*)"/);
    if (!key) continue;

    const grab = (field) => {
      const hit = line.match(new RegExp(`\\b${field}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      return hit ? hit[1].replace(/\\"/g, '"') : null;
    };
    meta.set(key[1], {
      section,
      label: grab("label"),
      desc: grab("desc"),
      type: grab("type"),
      schemaDefault: grab("default"),
    });
  }
  return meta;
}

/* ---------------------------------------------------------------------------
 * 3. Merge + emit
 * ------------------------------------------------------------------------- */

function inferType(rec, metaType) {
  if (metaType) return metaType;
  if (rec.kinds.has("boolean")) return "toggle";
  const vals = [...rec.defaults.keys()];
  if (vals.some((v) => /^\d{1,2}:\d{2}$/.test(v))) return "time";
  if (rec.kinds.has("number") || (vals.length && vals.every((v) => /^-?\d+(\.\d+)?$/.test(v)))) return "number";
  return "text";
}

function pickDefault(rec) {
  if (SECRET.test(rec.name)) return { text: "_(secret — set in `.env`)_", conflict: false };
  const source = rec.defaults.size ? rec.defaults : rec.displayDefaults;
  if (!source.size) {
    return { text: rec.chainsTo ? `falls back to \`${rec.chainsTo}\`` : "—", conflict: false };
  }
  const sorted = [...source.entries()].sort((a, b) => b[1] - a[1]);
  const primary = `\`${sorted[0][0]}\``;
  if (sorted.length === 1) return { text: primary, conflict: false };
  const others = sorted.slice(1).map(([v, n]) => `\`${v}\`×${n}`).join(", ");
  return { text: `${primary} ⚠️ also ${others}`, conflict: true };
}

function esc(s) {
  return String(s).replace(/\|/g, "\\|");
}

function build() {
  const code = scanCode();
  const meta = scanSettings();

  const sections = new Map();
  const conflicts = [];   // engine sites disagree with each other — behaviour depends on load order
  const misreports = [];  // a status panel / log banner states a default the engine does not use
  const undocumented = [];

  for (const rec of code.values()) {
    if (INFRA.test(rec.name) && !meta.has(rec.name)) continue;
    const m = meta.get(rec.name) || {};
    const def = pickDefault(rec);
    // Several defaults inside ONE file is per-mode branching (see getVixMaxEntry,
    // where ORB and Trend_PB intentionally tolerate a higher VIX than the rest).
    // Only disagreement ACROSS files is the load-order bug worth reporting.
    const engineFiles = new Set(rec.sites.filter((x) => !x.display).map((x) => x.file));
    if (def.conflict && rec.defaults.size > 1 && engineFiles.size > 1) {
      conflicts.push({
        name: rec.name,
        values: [...rec.defaults.entries()].sort((a, b) => b[1] - a[1]),
        files: rec.sites.filter((x) => !x.display).map((x) => x.file),
      });
    }
    // The engine's default is the one that runs; a banner quoting a different
    // one tells you your config is something it is not.
    if (rec.defaults.size && rec.displayDefaults.size) {
      const engine = [...rec.defaults.entries()].sort((a, b) => b[1] - a[1])[0][0];
      for (const [shown] of rec.displayDefaults) {
        if (shown !== engine) {
          misreports.push({
            name: rec.name,
            engine,
            shown,
            files: rec.sites.filter((x) => x.display && x.value === shown).map((x) => x.file),
          });
        }
      }
    }
    if (!m.desc) undocumented.push(rec.name);

    const section = m.section || "Not exposed in Settings";
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push({
      name: rec.name,
      type: inferType(rec, m.type),
      def: def.text,
      desc: m.desc || m.label || "",
      files: [...rec.files].sort(),
    });
  }

  // Settings keys with NO literal `process.env.KEY` anywhere — every per-index
  // key (BANKNIFTY_*, and OPTION_EXPIRY_OVERRIDE since the expiry roll went
  // per-index) is read as `process.env[U.env.something]` out of instrument.js's
  // UNDERLYING_DEFS table, which scanCode() cannot see. They are real, operator-
  // facing settings with a description; dropping them left this reference
  // silently missing a whole block of the Settings page.
  let schemaOnly = 0;
  for (const [name, m] of meta) {
    if (code.has(name)) continue;
    schemaOnly += 1;
    const section = m.section || "Not exposed in Settings";
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push({
      name,
      type: m.type || "text",
      def: SECRET.test(name)
        ? "_(secret — set in `.env`)_"
        : m.schemaDefault !== null && m.schemaDefault !== undefined ? `\`${m.schemaDefault}\`` : "\u2014",
      desc: m.desc || m.label || "",
      files: [],
    });
  }
  const totalKeys = code.size + schemaOnly;

  const order = [...sections.keys()].sort((a, b) => {
    const last = (s) => (s === "Not exposed in Settings" ? 1 : 0);
    return last(a) - last(b) || a.localeCompare(b);
  });

  const lines = [];
  lines.push("# Environment Variable Reference");
  lines.push("");
  lines.push("<!-- GENERATED BY scripts/genEnvDocs.js — DO NOT EDIT BY HAND. -->");
  lines.push("<!-- Regenerate with: npm run docs:env -->");
  lines.push("");
  lines.push(
    `Derived from every \`process.env\` read in \`src/\` and from \`SETTINGS_SCHEMA\` in ` +
      `[settings.js](src/routes/settings.js). **${totalKeys} keys** across **${order.length} groups**. ` +
      "Descriptions come from the Settings UI, and defaults from the engine's own fallback wherever the key is read as a literal " +
      "`process.env.KEY`, so neither can drift from what actually runs. Keys reached only through a helper (`cfgOn(\"KEY\", …)`) or " +
      "through instrument.js's per-index table show the Settings default instead \u2014 that is the one the UI writes."
  );
  lines.push("");

  if (conflicts.length) {
    lines.push("## \u26a0\ufe0f Conflicting engine defaults");
    lines.push("");
    lines.push("These keys are given **different fallbacks at different engine call sites**. With the key unset, behaviour depends on which module evaluated first \u2014 usually a bug.");
    lines.push("");
    lines.push("| Key | Defaults seen | Files |");
    lines.push("|---|---|---|");
    for (const c of conflicts.sort((a, b) => a.name.localeCompare(b.name))) {
      const vals = c.values.map(([v, n]) => `\`${v}\`\u00d7${n}`).join(", ");
      lines.push(`| \`${c.name}\` | ${esc(vals)} | ${[...new Set(c.files)].map((f) => `\`${f}\``).join(", ")} |`);
    }
    lines.push("");
  }

  if (misreports.length) {
    lines.push("## \u26a0\ufe0f Status panels that misreport the default");
    lines.push("");
    lines.push("The engine falls back to one value; a status panel or log banner prints another. With the key unset the UI states a configuration the engine is **not** running.");
    lines.push("");
    lines.push("| Key | Engine uses | UI shows | Where |");
    lines.push("|---|---|---|---|");
    for (const c of misreports.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`| \`${c.name}\` | \`${esc(c.engine)}\` | \`${esc(c.shown)}\` | ${[...new Set(c.files)].map((f) => `\`${f}\``).join(", ")} |`);
    }
    lines.push("");
  }

  for (const section of order) {
    const rows = sections.get(section).sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${section}`);
    lines.push("");
    lines.push("| Key | Type | Default | Description |");
    lines.push("|---|---|---|---|");
    for (const r of rows) {
      const desc = r.desc || (r.files.length ? `_used in ${r.files.length} file${r.files.length === 1 ? "" : "s"}_` : "\u2014");
      lines.push(`| \`${r.name}\` | ${r.type} | ${esc(r.def)} | ${esc(desc)} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `_${undocumented.length} of ${totalKeys} keys have no Settings description — they are listed above with their call-site count instead. ` +
      "Add them to `SETTINGS_SCHEMA` to give them a description here._"
  );
  lines.push("");

  return { text: lines.join("\n"), stats: { keys: totalKeys, groups: order.length, conflicts, misreports, undocumented } };
}

const { text, stats } = build();

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== text) {
    console.error("docs/ENV.md is stale — run: npm run docs:env");
    process.exit(1);
  }
  console.log(`docs/ENV.md up to date (${stats.keys} keys)`);
  process.exit(0);
}

fs.writeFileSync(OUT, text);
console.log(`docs/ENV.md written — ${stats.keys} keys, ${stats.groups} groups`);
if (stats.conflicts.length) {
  console.log(`⚠️  ${stats.conflicts.length} key(s) with conflicting ENGINE defaults:`);
  for (const c of stats.conflicts) {
    console.log(`   ${c.name} → ${c.values.map(([v, n]) => `${v}x${n}`).join(" vs ")}`);
  }
}
if (stats.misreports.length) {
  console.log(`⚠️  ${stats.misreports.length} status panel(s) printing a default the engine does not use:`);
  for (const c of stats.misreports) console.log(`   ${c.name}: engine=${c.engine} ui=${c.shown}`);
}
console.log(`ℹ️  ${stats.undocumented.length} key(s) not in SETTINGS_SCHEMA (no description).`);
