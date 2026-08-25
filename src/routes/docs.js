const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const sharedSocketState = require("../utils/sharedSocketState");
const { resolveTheme } = require("../utils/theme");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, enabledStrategies } = require("../utils/sharedNav");
const { renderMarkdown, escapeHtml } = require("../utils/markdown");

/**
 * Which strategy each shipped guide belongs to, so the Documents list can hide
 * guides for strategies this install has switched off — the same rule the
 * sidebar, Edge Analytics and the Consolidation Report already follow.
 *
 * Keys are lower-cased filenames; lookup is case-insensitive.
 *
 * A file that is NOT in this map is always listed. That direction matters: an
 * unknown document (a user upload, a new guide added before this map is) must
 * stay visible. Hiding by default would make uploads silently disappear.
 *
 * Listing only — GET /docs/file/:filename is deliberately NOT gated, so an
 * existing bookmark or a "Sync to local" of a disabled strategy's guide still
 * works. This is menu visibility, not access control.
 */
const GUIDE_MODE_BY_FILE = {
  "ema_rsi_st_strategy_guide.html":    "EMA_RSI_ST",
  "bb_rsi_strategy_guide.html":        "BB_RSI",
  "price_action_strategy_guide.html":  "PA",
  "orb_strategy_guide.html":           "ORB",
  "ema9_vwap_strategy_guide.html":     "EMA9VWAP",
  "trend_pullback_strategy_guide.html":"TREND_PB",
  "gaps_strategy_guide.html":          "GAPS",
  "trend_day_scalp_strategy_guide.html": "TDS",
  "3m_gap_fix_scalp_strategy_guide.html": "GAP3M",
  "oi_wall_fade_strategy_guide.html": "OIWF",
  "rsi_pivot_st_strategy_guide.html": "RSI_PIVOT_ST",
  "simple930_strategy_guide.html":    "SIMPLE930",
};

/**
 * @param {string} filename
 * @param {Set<string>} enabledModes
 * @returns {boolean} true when the file should appear in the Documents list
 */
function isDocVisible(filename, enabledModes) {
  const mode = GUIDE_MODE_BY_FILE[String(filename).toLowerCase()];
  return !mode || enabledModes.has(mode);
}

// ── Documents list presentation ─────────────────────────────────────────
const FILE_KINDS = [
  { re: /\.pdf$/i,                      icon: "📕",  tag: "PDF"   },
  { re: /\.(xlsx?|csv)$/i,              icon: "📊",  tag: "SHEET" },
  { re: /\.(docx?)$/i,                  icon: "📝",  tag: "DOC"   },
  { re: /\.(png|jpe?g|gif|svg|webp)$/i, icon: "🖼️", tag: "IMAGE" },
  { re: /\.(txt|md)$/i,                 icon: "📃",  tag: "TEXT"  },
  { re: /\.html?$/i,                    icon: "📘",  tag: "GUIDE" },
];

function fileKind(name) {
  for (const k of FILE_KINDS) if (k.re.test(name)) return k;
  return { icon: "📄", tag: "FILE" };
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

/**
 * Read + render one of the two repo markdown files. A missing or unreadable
 * file is a rendered notice, not a thrown request: /docs must still open on a
 * server where README.md was never deployed.
 */
function readDoc(projectRoot, name, opts) {
  try {
    const filepath = path.join(projectRoot, name);
    const raw      = fs.readFileSync(filepath, "utf-8");
    const stat     = fs.statSync(filepath);
    const rendered = renderMarkdown(raw, opts);
    return {
      html: rendered.html,
      toc: rendered.toc,
      size: fmtSize(stat.size),
      modified: stat.mtime.toISOString().split("T")[0],
      ok: true,
    };
  } catch (e) {
    return {
      html: '<p class="md-p">' + escapeHtml(name) + ' could not be read on this server (' + escapeHtml(e.code || "read error") + ').</p>',
      toc: [], size: "—", modified: "—", ok: false,
    };
  }
}

function shorten(text, max) {
  const t = String(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, "") + "…";
}

function tocHtml(toc) {
  if (!toc.length) return "";
  const links = toc.map(t =>
    '<a class="toc-link lvl' + t.level + '" href="#' + t.id + '" title="' + escapeHtml(t.text) + '">' +
    escapeHtml(shorten(t.text, 58)) + "</a>"
  ).join("");
  return `<details class="toc">
      <summary class="toc-head">On this page <span class="toc-count">${toc.length}</span></summary>
      <nav class="toc-list">${links}</nav>
    </details>`;
}

router.get("/", (req, res) => {
  const projectRoot = process.cwd();

  // The CHANGELOG is one long "Unreleased" section with 350+ h3 entries — an
  // h3-deep contents list there would be longer than the document's own text,
  // so it lists releases (h2) only. The README's 10 sections + 49 strategy /
  // feature sub-headings are exactly what a reader wants to jump between.
  const readme    = readDoc(projectRoot, "README.md",    { idPrefix: "rm-", tocMaxLevel: 3 });
  const changelog = readDoc(projectRoot, "CHANGELOG.md", { idPrefix: "cl-", tocMaxLevel: 2 });
  // Generated by scripts/genEnvDocs.js from every process.env read in src/, so it
  // cannot drift from the running config the way the old hand-written README
  // section did. h2 only — one entry per settings group, not per key.
  const envref    = readDoc(projectRoot, "docs/ENV.md",  { idPrefix: "ev-", tocMaxLevel: 2 });

  // Read documents folder. Guides belonging to a strategy this install has
  // switched off are hidden, matching the sidebar / Edge Analytics / Consolidation
  // Report. enabledStrategies() reads process.env per call — Settings saves mutate
  // it live — so this must not be hoisted out of the request handler.
  const docsDir = path.join(projectRoot, "documents");
  const enabledModes = new Set(enabledStrategies().map(s => s.mode));
  let docFiles = [], hiddenCount = 0;
  try {
    docFiles = fs.readdirSync(docsDir)
      .filter(f => !f.startsWith("."))
      .filter(f => { const ok = isDocVisible(f, enabledModes); if (!ok) hiddenCount++; return ok; })
      .map(f => {
        const stat = fs.statSync(path.join(docsDir, f));
        const kind = fileKind(f);
        return {
          name: f,
          icon: kind.icon,
          tag: kind.tag,
          bytes: stat.size,
          size: fmtSize(stat.size),
          mtime: stat.mtime.getTime(),
          modified: stat.mtime.toISOString().split("T")[0],
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch(e) { /* documents folder not found */ }

  const docListHtml = docFiles.length > 0
    ? docFiles.map(f => {
        const safeName = escapeHtml(f.name);
        const jsName   = f.name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const href     = "/docs/file/" + encodeURIComponent(f.name);
        return `<div class="file-row" data-name="${safeName.toLowerCase()}" data-size="${f.bytes}" data-mtime="${f.mtime}">
          <span class="file-ico" aria-hidden="true">${f.icon}</span>
          <div class="file-body">
            <a class="file-name" href="${href}" target="_blank" rel="noopener">${safeName}</a>
            <div class="file-meta">
              <span class="chip">${f.tag}</span>
              <span>${f.size}</span>
              <span class="dot">·</span>
              <span>${f.modified}</span>
            </div>
          </div>
          <div class="file-actions">
            <a class="btn btn-sm" href="${href}" target="_blank" rel="noopener">Open ↗</a>
            <button class="btn btn-sm btn-danger" type="button" onclick="deleteDoc('${jsName}')">Delete</button>
          </div>
        </div>`;
      }).join("\n      ")
    : `<div class="empty">
         <div class="empty-ico">📂</div>
         <div class="empty-title">No documents</div>
         <div class="empty-sub">Drop files into the <code class="md-code">documents/</code> folder on the server and they appear here.</div>
       </div>`;

  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const isLight    = resolveTheme() === "light";

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en"${isLight ? ' data-theme="light"' : ""}>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  ${faviconLink()}
  <title>Docs — Trading BOT</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    html { scroll-behavior:smooth; }
    html, body { height:100%; }

    /* ── Palette ──
       One token set, two skins. Every colour on this page resolves through
       these, which is what makes the light theme a 20-line block instead of a
       per-rule !important chase: the runtime hex rewriter in modalJS only
       reaches inline style="" attributes, never a stylesheet. */
    :root{
      --pg-bg:#080c14; --pg-surface:#0b1120; --pg-surface-2:#0a1020; --pg-raise:#111a2c;
      --pg-line:#16233c; --pg-line-soft:#111a2c;
      --pg-text:#b8cbe6; --pg-head:#e7f0fd; --pg-dim:#8ba1c2;
      --pg-accent:#3b82f6; --pg-accent-2:#60a5fa; --pg-accent-weak:rgba(59,130,246,0.12);
      --pg-green:#10b981; --pg-red:#ef4444; --pg-code:#fbbf24;
      --pg-shadow:0 1px 2px rgba(0,0,0,0.35);
    }
    :root[data-theme="light"]{
      --pg-bg:#f4f6f9; --pg-surface:#ffffff; --pg-surface-2:#f8fafc; --pg-raise:#f1f5f9;
      --pg-line:#e2e8f0; --pg-line-soft:#eef2f7;
      --pg-text:#334155; --pg-head:#0f172a; --pg-dim:#5c6b7f;
      --pg-accent:#2563eb; --pg-accent-2:#1d4ed8; --pg-accent-weak:rgba(37,99,235,0.07);
      --pg-green:#047857; --pg-red:#b91c1c; --pg-code:#b45309;
      --pg-shadow:0 1px 3px rgba(15,23,42,0.08);
    }

    body { font-family:'IBM Plex Sans',sans-serif; background:var(--pg-bg); color:var(--pg-text);
           -webkit-font-smoothing:antialiased; }
    ${sidebarCSS()}
    ${modalCSS()}

    .main-content { margin-left:200px; padding:20px 30px 70px; min-height:100vh; min-width:0; }
    .wrap { max-width:1320px; }

    /* ── Breadcrumb ── */
    .breadcrumb { display:flex; align-items:center; gap:5px; font-size:0.68rem; font-weight:600; margin-bottom:12px; flex-wrap:wrap; }
    .bc-link { color:var(--pg-dim); text-decoration:none; padding:3px 6px; border-radius:5px; transition:color .15s, background .15s; }
    .bc-link:hover { color:var(--pg-accent-2); background:var(--pg-accent-weak); }
    .bc-sep { color:var(--pg-dim); opacity:0.55; }
    .bc-current { color:var(--pg-head); padding:3px 6px; }

    /* ── Page header ── */
    .doc-head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; flex-wrap:wrap;
                padding-bottom:16px; border-bottom:1px solid var(--pg-line); }
    .doc-title { font-size:1.4rem; font-weight:700; color:var(--pg-head); letter-spacing:-0.4px; }
    .doc-sub { font-size:0.74rem; color:var(--pg-dim); margin-top:5px; max-width:70ch; line-height:1.55; }
    .meta-strip { display:flex; gap:7px; flex-wrap:wrap; margin-top:10px; }

    .chip { display:inline-flex; align-items:center; gap:5px; font-size:0.6rem; font-weight:700; letter-spacing:0.7px;
            text-transform:uppercase; padding:3px 8px; border-radius:5px; background:var(--pg-raise);
            color:var(--pg-dim); border:1px solid var(--pg-line); font-family:'IBM Plex Mono',monospace; }

    /* ── Buttons ── */
    .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:34px; padding:7px 14px;
           border-radius:8px; border:1px solid var(--pg-line); background:var(--pg-surface); color:var(--pg-text);
           font-family:'IBM Plex Mono',monospace; font-size:0.68rem; font-weight:700; letter-spacing:0.5px;
           text-decoration:none; cursor:pointer; transition:border-color .15s, color .15s, background .15s; white-space:nowrap; }
    .btn:hover:not(:disabled) { border-color:var(--pg-accent); color:var(--pg-accent-2); background:var(--pg-accent-weak); }
    .btn:disabled { opacity:0.55; cursor:not-allowed; }
    .btn:focus-visible { outline:2px solid var(--pg-accent); outline-offset:2px; }
    .btn-sm { min-height:30px; padding:5px 11px; font-size:0.64rem; }
    .btn-accent { background:rgba(16,185,129,0.12); border-color:rgba(16,185,129,0.32); color:var(--pg-green); }
    .btn-accent:hover:not(:disabled) { background:rgba(16,185,129,0.2); border-color:rgba(16,185,129,0.5); color:var(--pg-green); }
    .btn-danger:hover:not(:disabled) { border-color:var(--pg-red); color:var(--pg-red); background:rgba(239,68,68,0.1); }

    /* ── Sticky toolbar: tabs stay reachable through a 3,000-line changelog ── */
    .toolbar { position:sticky; top:0; z-index:40; display:flex; align-items:center; justify-content:space-between;
               gap:12px; flex-wrap:wrap; padding:14px 0 12px; margin-bottom:4px; background:var(--pg-bg);
               border-bottom:1px solid transparent; transition:border-color .2s, box-shadow .2s; }
    .toolbar.stuck { border-bottom-color:var(--pg-line); box-shadow:0 6px 16px -12px rgba(0,0,0,0.7); }

    .tabs { display:inline-flex; gap:4px; padding:4px; background:var(--pg-surface); border:1px solid var(--pg-line);
            border-radius:11px; max-width:100%; overflow-x:auto; scrollbar-width:none; }
    .tabs::-webkit-scrollbar { display:none; }
    .tab { display:inline-flex; align-items:center; gap:7px; padding:8px 15px; border:none; border-radius:8px;
           background:transparent; color:var(--pg-dim); cursor:pointer; font-family:'IBM Plex Mono',monospace;
           font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:0.9px; white-space:nowrap;
           transition:background .15s, color .15s; }
    .tab:hover { color:var(--pg-head); background:var(--pg-raise); }
    .tab[aria-selected="true"] { background:var(--pg-accent-weak); color:var(--pg-accent-2);
                                 box-shadow:inset 0 0 0 1px rgba(59,130,246,0.35); }
    .tab:focus-visible { outline:2px solid var(--pg-accent); outline-offset:2px; }
    .tab-count { font-size:0.6rem; font-weight:600; padding:1px 6px; border-radius:99px;
                 background:var(--pg-raise); color:var(--pg-dim); }
    .tab[aria-selected="true"] .tab-count { background:rgba(59,130,246,0.2); color:var(--pg-accent-2); }
    .toolbar-right { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

    /* ── Panels ── */
    .panel { display:none; }
    .panel.active { display:block; }
    .panel-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:18px; align-items:start; }
    @media(min-width:1180px){ .panel-grid.has-toc { grid-template-columns:minmax(0,1fr) 244px; } }

    .card { background:var(--pg-surface); border:1px solid var(--pg-line); border-radius:12px;
            padding:28px 32px; box-shadow:var(--pg-shadow); min-width:0; }

    /* ── Contents rail ── */
    .toc { background:var(--pg-surface); border:1px solid var(--pg-line); border-radius:12px; box-shadow:var(--pg-shadow); }
    @media(min-width:1180px){ .toc { position:sticky; top:78px; max-height:calc(100vh - 110px); overflow-y:auto; } }
    .toc-head { list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px; padding:12px 14px;
                font-size:0.6rem; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:var(--pg-dim); }
    .toc-head::-webkit-details-marker { display:none; }
    .toc-head::after { content:'▾'; margin-left:auto; font-size:0.7rem; transition:transform .2s; }
    .toc[open] .toc-head::after { transform:rotate(180deg); }
    .toc-count { font-size:0.58rem; padding:1px 6px; border-radius:99px; background:var(--pg-raise); letter-spacing:0.5px; }
    .toc-list { display:flex; flex-direction:column; padding:2px 8px 10px; }
    /* Labels are already shortened server-side; the height cap is the backstop
       for a heading with no space to break at. */
    .toc-link { display:block; font-size:0.72rem; line-height:1.4; color:var(--pg-dim); text-decoration:none;
                padding:6px 9px; max-height:calc(2.8em + 12px); overflow:hidden;
                border-left:2px solid transparent; border-radius:0 6px 6px 0; transition:color .15s, background .15s; }
    .toc-link:hover { color:var(--pg-head); background:var(--pg-raise); }
    .toc-link.active { color:var(--pg-accent-2); background:var(--pg-accent-weak); border-left-color:var(--pg-accent); }
    .toc-link.lvl3 { padding-left:20px; font-size:0.68rem; opacity:0.9; }

    /* ── Rendered markdown ──────────────────────────────────────────────
       Reading measure is capped at 96ch: on a 27" monitor an uncapped
       document line runs 200+ characters, which is where prose stops being
       readable. Tables and code blocks are exempt — they scroll in their own
       box instead. */
    .md-body { font-size:0.86rem; line-height:1.75; color:var(--pg-text); max-width:96ch; }
    .md-body > *:first-child { margin-top:0; }
    .md-h { scroll-margin-top:86px; color:var(--pg-head); font-weight:700; }
    .md-h1 { font-size:1.5rem; letter-spacing:-0.4px; margin:0 0 10px; }
    .md-h2 { font-size:1.1rem; color:var(--pg-accent-2); margin:34px 0 12px; padding-bottom:8px;
             border-bottom:1px solid var(--pg-line); }
    .md-h3 { font-size:0.95rem; margin:24px 0 8px; }
    .md-h4 { font-size:0.82rem; margin:18px 0 6px; color:var(--pg-dim); text-transform:uppercase; letter-spacing:0.8px; }
    .md-h5, .md-h6 { font-size:0.78rem; margin:14px 0 4px; color:var(--pg-dim); }
    .md-anchor { margin-left:8px; color:var(--pg-accent); text-decoration:none; font-weight:400; opacity:0;
                 transition:opacity .15s; }
    .md-h:hover .md-anchor, .md-anchor:focus-visible { opacity:0.7; }
    .md-p { margin:11px 0; }
    .md-body strong { color:var(--pg-head); font-weight:600; }
    .md-body em { color:var(--pg-text); }
    .md-list { margin:8px 0 12px; padding-left:22px; }
    .md-list li { margin:5px 0; }
    .md-list li::marker { color:var(--pg-accent); }
    .md-list .md-list { margin:5px 0 3px; }
    .md-code { font-family:'IBM Plex Mono',monospace; font-size:0.8em; color:var(--pg-code);
               background:var(--pg-raise); border:1px solid var(--pg-line); border-radius:5px; padding:1px 5px; }
    .md-pre { position:relative; margin:14px 0; padding:16px 18px; background:var(--pg-surface-2);
              border:1px solid var(--pg-line); border-radius:10px; overflow-x:auto; -webkit-overflow-scrolling:touch;
              font-family:'IBM Plex Mono',monospace; font-size:0.76rem; line-height:1.6; color:var(--pg-text); }
    .md-pre[data-lang]::before { content:attr(data-lang); position:absolute; top:0; right:0; padding:2px 9px;
              font-size:0.58rem; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:var(--pg-dim);
              background:var(--pg-raise); border-left:1px solid var(--pg-line); border-bottom:1px solid var(--pg-line);
              border-radius:0 9px 0 8px; }
    .md-table-wrap { margin:14px 0; border:1px solid var(--pg-line); border-radius:10px; overflow-x:auto;
                     -webkit-overflow-scrolling:touch; }
    .md-table { width:100%; border-collapse:collapse; font-size:0.76rem; min-width:520px; }
    .md-table th { padding:10px 13px; text-align:left; white-space:nowrap; background:var(--pg-surface-2);
                   color:var(--pg-dim); font-size:0.62rem; font-weight:700; text-transform:uppercase;
                   letter-spacing:0.9px; border-bottom:1px solid var(--pg-line); }
    .md-table td { padding:9px 13px; border-top:1px solid var(--pg-line-soft); vertical-align:top; line-height:1.55; }
    .md-table tbody tr:hover { background:var(--pg-accent-weak); }
    .md-quote { margin:14px 0; padding:12px 16px; background:var(--pg-accent-weak);
                border-left:3px solid var(--pg-accent); border-radius:0 8px 8px 0; }
    .md-quote > *:first-child { margin-top:0; }
    .md-quote > *:last-child { margin-bottom:0; }
    .md-hr { border:none; border-top:1px solid var(--pg-line); margin:26px 0; }
    .md-link { color:var(--pg-accent-2); text-decoration:none; border-bottom:1px solid rgba(96,165,250,0.35); }
    .md-link:hover { border-bottom-color:currentColor; }
    /* A repo path, not a URL — the server serves no source files, so it is a
       tooltip-bearing reference rather than a link that would 404. */
    .md-ref { color:var(--pg-text); border-bottom:1px dashed var(--pg-line); cursor:help;
              font-family:'IBM Plex Mono',monospace; font-size:0.82em; }
    .md-img { max-width:100%; height:auto; border-radius:8px; }

    /* ── Documents tab ── */
    .files-bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
    .search { position:relative; flex:1; min-width:210px; }
    .search input { width:100%; padding:9px 12px 9px 32px; border-radius:9px; border:1px solid var(--pg-line);
                    background:var(--pg-surface-2); color:var(--pg-text); font-family:'IBM Plex Sans',sans-serif;
                    font-size:0.78rem; }
    .search input::placeholder { color:var(--pg-dim); }
    .search input:focus { outline:none; border-color:var(--pg-accent); box-shadow:0 0 0 3px var(--pg-accent-weak); }
    .search-ico { position:absolute; left:11px; top:50%; transform:translateY(-50%); font-size:0.75rem; opacity:0.6; }
    .files-bar select { padding:9px 10px; border-radius:9px; border:1px solid var(--pg-line);
                        background:var(--pg-surface-2); color:var(--pg-text); font-size:0.72rem;
                        font-family:'IBM Plex Mono',monospace; cursor:pointer; }
    .files-count { font-size:0.68rem; color:var(--pg-dim); font-family:'IBM Plex Mono',monospace; white-space:nowrap; }

    .file-list { display:flex; flex-direction:column; gap:8px; }
    .file-row { display:grid; grid-template-columns:38px minmax(0,1fr) auto; gap:13px; align-items:center;
                padding:12px 14px; background:var(--pg-surface-2); border:1px solid var(--pg-line);
                border-radius:10px; transition:border-color .15s, background .15s; }
    .file-row:hover { border-color:var(--pg-accent); background:var(--pg-accent-weak); }
    .file-ico { width:38px; height:38px; display:grid; place-items:center; border-radius:9px; font-size:1.05rem;
                background:var(--pg-raise); border:1px solid var(--pg-line); }
    .file-body { min-width:0; }
    .file-name { display:block; font-size:0.83rem; font-weight:600; color:var(--pg-head); text-decoration:none;
                 overflow-wrap:anywhere; }
    .file-name:hover { color:var(--pg-accent-2); }
    .file-meta { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-top:5px; font-size:0.67rem;
                 color:var(--pg-dim); font-family:'IBM Plex Mono',monospace; }
    .file-meta .dot { opacity:0.5; }
    .file-actions { display:flex; gap:6px; }

    .empty { padding:40px 20px; text-align:center; border:1px dashed var(--pg-line); border-radius:12px; }
    .empty-ico { font-size:1.7rem; }
    .empty-title { margin-top:8px; font-size:0.9rem; font-weight:600; color:var(--pg-head); }
    .empty-sub { margin-top:5px; font-size:0.75rem; color:var(--pg-dim); }
    .no-match { display:none; padding:26px 12px; text-align:center; font-size:0.78rem; color:var(--pg-dim); }

    /* ── Back to top ── */
    .to-top { position:fixed; right:18px; bottom:18px; z-index:60; width:42px; height:42px; border-radius:50%;
              display:grid; place-items:center; background:var(--pg-surface); border:1px solid var(--pg-line);
              color:var(--pg-dim); cursor:pointer; opacity:0; pointer-events:none; transform:translateY(8px);
              transition:opacity .2s, transform .2s; box-shadow:0 8px 22px -12px rgba(0,0,0,0.8); font-size:0.95rem; }
    .to-top.show { opacity:1; pointer-events:auto; transform:translateY(0); }
    .to-top:hover { color:var(--pg-accent-2); border-color:var(--pg-accent); }

    /* ── TABLET ── */
    @media(max-width:1179px){
      .toc { margin-bottom:2px; }
      .toc-list { max-height:44vh; overflow-y:auto; }
    }

    /* ── MOBILE (iPhone 15 = 393px logical width) ──
       Last in the sheet on purpose: these rules share specificity with the base
       ones above and only win by coming after them. Rendered markdown is the one
       place this app prints text it did not author — an unbroken env key such as
       EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES has no break opportunity, so it
       used to drag the document out to 640px and the browser zoomed the whole
       page to 61% to fit it. overflow-wrap is inherited, so setting it on the
       card covers bare text nodes, not just the code spans. */
    @media(max-width:768px){
      .main-content { margin-left:0; padding:14px 12px 64px; }
      /* The hamburger is fixed at the top-left corner over the page. */
      .breadcrumb { padding-left:46px; min-height:44px; }
      .doc-head { align-items:flex-start; }
      .doc-title { font-size:1.15rem; }
      .doc-head .btn { min-height:40px; }
      .toolbar { padding:10px 0; }
      .card { padding:16px 14px; overflow-wrap:anywhere; word-break:break-word; }
      .md-body { font-size:0.84rem; max-width:none; }
      .md-h1 { font-size:1.15rem; }
      .md-h2 { font-size:1rem; margin-top:26px; }
      .md-h3 { font-size:0.9rem; }
      /* Fenced blocks and tables keep their formatting and scroll instead. */
      .md-pre, .md-pre code, .md-table { overflow-wrap:normal; word-break:normal; }
      .md-pre { padding:12px 13px; font-size:0.72rem; }
      .file-row { grid-template-columns:34px minmax(0,1fr); row-gap:10px; }
      .file-ico { width:34px; height:34px; }
      .file-actions { grid-column:1 / -1; justify-content:flex-end; }
      .file-actions .btn { min-height:40px; flex:1; }
      .files-bar { gap:8px; }
      .files-bar select, .search input { min-height:40px; }
      .to-top { right:12px; bottom:12px; }
    }
    @media(max-width:520px){
      .toolbar-right { display:none; }
    }
    @media(max-width:420px){
      .tab { padding:8px 11px; font-size:0.65rem; }
    }
    @media print{
      .sidebar, .toolbar, .to-top, .breadcrumb, .doc-head .btn, .toc { display:none !important; }
      .main-content { margin-left:0; padding:0; }
      .card { border:none; box-shadow:none; padding:0; }
      .md-body { max-width:none; }
    }
  </style>
</head>
<body>
${buildSidebar("docs", liveActive)}
<div class="main-content">
 <div class="wrap">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="/" class="bc-link">⌂ Dashboard</a>
    <span class="bc-sep">›</span>
    <a href="/settings" class="bc-link">⚙ Settings</a>
    <span class="bc-sep">›</span>
    <span class="bc-current">📄 Docs</span>
  </nav>

  <header class="doc-head">
    <div>
      <h1 class="doc-title">Documentation</h1>
      <p class="doc-sub">The user-facing spec (README), the hand-maintained release history (CHANGELOG), and the strategy guides shipped in <code class="md-code">documents/</code> — rendered from this server's own files.</p>
      <div class="meta-strip">
        <span class="chip">README · ${readme.size} · ${readme.modified}</span>
        <span class="chip">CHANGELOG · ${changelog.size} · ${changelog.modified}</span>
        <span class="chip">ENV · ${envref.size} · ${envref.modified}</span>
        <span class="chip">${docFiles.length} document${docFiles.length !== 1 ? "s" : ""}</span>
      </div>
    </div>
    <button id="sync-local-btn" class="btn btn-accent" type="button" onclick="syncToLocal()"
            title="Download ~/trading-data/ from the server as a .tar.gz snapshot">📦 SYNC TO LOCAL</button>
  </header>

  <div class="toolbar" id="toolbar">
    <div class="tabs" role="tablist" aria-label="Documentation sections">
      <button class="tab" role="tab" id="tab-readme"    aria-controls="readme"    aria-selected="true"  onclick="showTab('readme')">Readme <span class="tab-count">${readme.toc.length}</span></button>
      <button class="tab" role="tab" id="tab-changelog" aria-controls="changelog" aria-selected="false" tabindex="-1" onclick="showTab('changelog')">Changelog <span class="tab-count">${changelog.toc.length}</span></button>
      <button class="tab" role="tab" id="tab-envref"    aria-controls="envref"    aria-selected="false" tabindex="-1" onclick="showTab('envref')">Env Vars <span class="tab-count">${envref.toc.length}</span></button>
      <button class="tab" role="tab" id="tab-documents" aria-controls="documents" aria-selected="false" tabindex="-1" onclick="showTab('documents')">Documents <span class="tab-count">${docFiles.length}</span></button>
    </div>
    <div class="toolbar-right">
      <button class="btn btn-sm" type="button" onclick="window.print()">🖨 Print</button>
    </div>
  </div>

  <section id="readme" class="panel active" role="tabpanel" aria-labelledby="tab-readme">
    <div class="panel-grid${readme.toc.length ? " has-toc" : ""}">
      <article class="card"><div class="md-body">${readme.html}</div></article>
      ${tocHtml(readme.toc)}
    </div>
  </section>

  <section id="changelog" class="panel" role="tabpanel" aria-labelledby="tab-changelog">
    <div class="panel-grid${changelog.toc.length ? " has-toc" : ""}">
      <article class="card"><div class="md-body">${changelog.html}</div></article>
      ${tocHtml(changelog.toc)}
    </div>
  </section>

  <section id="envref" class="panel" role="tabpanel" aria-labelledby="tab-envref">
    <div class="panel-grid${envref.toc.length ? " has-toc" : ""}">
      <article class="card"><div class="md-body">${envref.html}</div></article>
      ${tocHtml(envref.toc)}
    </div>
  </section>

  <section id="documents" class="panel" role="tabpanel" aria-labelledby="tab-documents">
    <article class="card">
      <div class="files-bar">
        <div class="search">
          <span class="search-ico" aria-hidden="true">🔍</span>
          <input id="doc-search" type="search" placeholder="Filter documents…" aria-label="Filter documents" oninput="filterDocs()">
        </div>
        <select id="doc-sort" aria-label="Sort documents" onchange="filterDocs()">
          <option value="name">Sort: Name</option>
          <option value="new">Sort: Newest</option>
          <option value="size">Sort: Largest</option>
        </select>
        <span class="files-count" id="doc-count"></span>
      </div>
      ${hiddenCount > 0 ? `<p class="doc-sub" style="margin:-6px 0 14px;">${hiddenCount} guide${hiddenCount !== 1 ? "s" : ""} hidden — that strategy is switched off in Settings.</p>` : ""}
      <div class="file-list" id="file-list">
      ${docListHtml}
      </div>
      <div class="no-match" id="no-match">No document matches that filter.</div>
    </article>
  </section>
 </div>
</div>
<button class="to-top" id="to-top" type="button" aria-label="Back to top" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>
<script>
${modalJS()}
(function(){ if ('${resolveTheme()}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();

var PANELS = ['readme','changelog','envref','documents'];

function showTab(id, opts){
  if (PANELS.indexOf(id) === -1) id = 'readme';
  PANELS.forEach(function(p){
    var panel = document.getElementById(p);
    var tab   = document.getElementById('tab-' + p);
    var on    = (p === id);
    if (panel) panel.classList.toggle('active', on);
    if (tab){ tab.setAttribute('aria-selected', on ? 'true' : 'false'); tab.tabIndex = on ? 0 : -1; }
  });
  if (!opts || !opts.silent){
    try { history.replaceState(null, '', '#' + id); } catch(e){}
  }
  if (opts && opts.focus){ var t = document.getElementById('tab-' + id); if (t) t.focus(); }
  syncToc();
}

// Arrow keys move between tabs, the way a tablist is expected to behave.
document.addEventListener('keydown', function(e){
  var t = document.activeElement;
  if (!t || t.getAttribute('role') !== 'tab') return;
  var i = PANELS.indexOf(t.id.replace('tab-',''));
  if (i === -1) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
    e.preventDefault();
    var n = (i + (e.key === 'ArrowRight' ? 1 : PANELS.length - 1)) % PANELS.length;
    showTab(PANELS[n], { focus:true });
  }
});

// ── Documents filter + sort ──
function filterDocs(){
  var list = document.getElementById('file-list');
  if (!list) return;
  var q    = (document.getElementById('doc-search').value || '').trim().toLowerCase();
  var sort = document.getElementById('doc-sort').value;
  var rows = Array.prototype.slice.call(list.querySelectorAll('.file-row'));
  var shown = 0;
  rows.forEach(function(r){
    var hit = !q || (r.dataset.name || '').indexOf(q) !== -1;
    r.style.display = hit ? '' : 'none';
    if (hit) shown++;
  });
  rows.sort(function(a, b){
    if (sort === 'new')  return Number(b.dataset.mtime) - Number(a.dataset.mtime);
    if (sort === 'size') return Number(b.dataset.size)  - Number(a.dataset.size);
    return (a.dataset.name || '').localeCompare(b.dataset.name || '');
  }).forEach(function(r){ list.appendChild(r); });
  var count = document.getElementById('doc-count');
  if (count) count.textContent = !rows.length ? ''
      : q ? (shown + ' of ' + rows.length + ' shown')
          : (rows.length + ' document' + (rows.length === 1 ? '' : 's'));
  var none = document.getElementById('no-match');
  if (none) none.style.display = (rows.length && shown === 0) ? 'block' : 'none';
}

// ── Contents rail: open on desktop, collapsed on a phone; the link for the
//    section you are reading stays highlighted. ──
var tocObserver = null;
function syncToc(){
  if (tocObserver){ tocObserver.disconnect(); tocObserver = null; }
  var panel = document.querySelector('.panel.active');
  if (!panel || !window.IntersectionObserver) return;
  var links = {};
  panel.querySelectorAll('.toc-link').forEach(function(a){ links[a.getAttribute('href').slice(1)] = a; });
  var heads = panel.querySelectorAll('.md-h2, .md-h3');
  if (!heads.length) return;
  var visible = {};
  tocObserver = new IntersectionObserver(function(entries){
    entries.forEach(function(en){ visible[en.target.id] = en.isIntersecting; });
    var current = null;
    for (var i = 0; i < heads.length; i++){ if (visible[heads[i].id]){ current = heads[i].id; break; } }
    Object.keys(links).forEach(function(k){ links[k].classList.toggle('active', k === current); });
    if (current && links[current] && window.innerWidth >= 1180){
      var rail = links[current].closest('.toc');
      if (rail && rail.scrollHeight > rail.clientHeight){
        var top = links[current].offsetTop - rail.clientHeight / 2;
        rail.scrollTo({ top: top < 0 ? 0 : top, behavior: 'smooth' });
      }
    }
  }, { rootMargin: '-80px 0px -70% 0px' });
  heads.forEach(function(h){ tocObserver.observe(h); });
}

window.addEventListener('scroll', function(){
  var bar = document.getElementById('toolbar');
  if (bar) bar.classList.toggle('stuck', window.scrollY > 8);
  var top = document.getElementById('to-top');
  if (top) top.classList.toggle('show', window.scrollY > 400);
}, { passive:true });

(function init(){
  var hash = (location.hash || '').replace('#','');
  if (PANELS.indexOf(hash) !== -1){
    showTab(hash, { silent:true });
    window.scrollTo(0, 0);
    window.addEventListener('load', function(){ window.scrollTo(0, 0); });
  } else if (hash){
    var target = document.getElementById(hash);
    var owner  = target && target.closest ? target.closest('.panel') : null;
    if (owner){ showTab(owner.id, { silent:true }); target.scrollIntoView(); }
  }
  if (window.innerWidth >= 1180){
    document.querySelectorAll('.toc').forEach(function(d){ d.open = true; });
  }
  filterDocs();
  syncToc();
})();

function fmtBytes(n){
  if(!n) return '0 B';
  var u=['B','KB','MB','GB']; var i=0;
  while(n>=1024 && i<u.length-1){ n/=1024; i++; }
  return n.toFixed(n<10?2:1)+' '+u[i];
}
async function syncToLocal(){
  var btn = document.getElementById('sync-local-btn');
  if(!btn) return;
  var orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ CHECKING…';

  var info;
  try {
    var r = await secretFetch('/sync/info');
    if(!r) { btn.disabled=false; btn.textContent=orig; return; }
    if(!r.ok) throw new Error('HTTP ' + r.status);
    info = await r.json();
  } catch(err){
    btn.disabled=false; btn.textContent=orig;
    showAlert({icon:'❌',title:'Could not read server data',message:err.message,btnClass:'modal-btn-danger'});
    return;
  }

  btn.disabled=false; btn.textContent=orig;

  if(!info.exists){
    showAlert({icon:'📭',title:'Nothing to sync',message:'~/trading-data/ does not exist on the server yet.\\nRun a paper or live session first.',btnClass:'modal-btn-primary'});
    return;
  }

  var ageMin = info.newestMtimeMs ? Math.round((Date.now()-info.newestMtimeMs)/60000) : null;
  var ageStr = ageMin === null ? '' : (ageMin < 60 ? ageMin+' min ago' : ageMin < 1440 ? Math.round(ageMin/60)+' h ago' : Math.round(ageMin/1440)+' d ago');
  var msg = 'Download a snapshot of the server\\'s ~/trading-data/ folder.\\n\\n' +
            '• Files: ' + info.fileCount + '\\n' +
            '• Size:  ' + fmtBytes(info.totalBytes) + ' (uncompressed)\\n' +
            (ageStr ? '• Newest: ' + ageStr + '\\n' : '') +
            '\\nFormat: .tar.gz — unpack with: tar -xzf <file>';
  var ok = await showConfirm({
    icon:'📦', title:'Sync to Local',
    message: msg,
    confirmText:'Download', confirmClass:'modal-btn-primary'
  });
  if(!ok) return;

  var url = '/sync/download-all';
  try {
    var s = sessionStorage.getItem('__api_secret');
    if(s) url += '?secret=' + encodeURIComponent(s);
  } catch(_){}
  var a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ document.body.removeChild(a); }, 1000);
}

async function deleteDoc(name) {
  var ok = await showDoubleConfirm({
    icon: '🗑',
    title: 'Delete document',
    message: 'Permanently delete "' + name + '"?\\nThis cannot be undone.',
    confirmText: 'Delete',
    confirmClass: 'modal-btn-danger',
    subject: name,
    secondConfirmText: 'Yes, delete it'
  });
  if (!ok) return;
  secretFetch('/docs/file/' + encodeURIComponent(name), { method: 'DELETE' })
    .then(function(r) { return r ? r.json() : { ok: false, error: 'Cancelled — API secret not provided.' }; })
    .then(function(d) { if (d.ok) location.reload(); else showAlert({ icon: '⚠️', title: 'Delete failed', message: d.error || 'Delete failed', btnClass: 'modal-btn-danger' }); })
    .catch(function() { showAlert({ icon: '⚠️', title: 'Delete failed', message: 'Network error', btnClass: 'modal-btn-danger' }); });
}
</script>
</body></html>`);
});

// ════════════════════════════════════════════════════════════════════════
// Live "as-per-settings" status injection for the strategy guides.
//
// The guide HTML files are static and keep their documented DEFAULT columns
// intact. Each guide carries a single <!--LIVE_STATUS_PANEL--> marker; at
// serve-time we replace it with a panel showing which toggles are ENABLED /
// DISABLED on THIS server right now. Values are resolved from the live runtime
// config (process.env — kept in sync with .env by settings.js) with the
// documented default as fallback, exactly how the strategy code resolves them.
// A file without the marker is served untouched, so non-guide docs (PDF, etc.)
// are unaffected.
// ════════════════════════════════════════════════════════════════════════
const STATUS_MARKER = "<!--LIVE_STATUS_PANEL-->";

function envIsOn(key, def) {
  const v = process.env[key];
  const eff = (v === undefined || v === null || v === "") ? def : String(v);
  return eff.toLowerCase() === "true";
}

function statusBadge(text, kind) {
  const c = {
    on:   { bg: "#0d2e1a", fg: "#3fb950", bd: "#238636" },
    off:  { bg: "#21262d", fg: "#8b949e", bd: "#30363d" },
    dry:  { bg: "#33270a", fg: "#d29922", bd: "#9e6a03" },
    live: { bg: "#3a1216", fg: "#f85149", bd: "#b62324" },
  }[kind] || { bg: "#21262d", fg: "#8b949e", bd: "#30363d" };
  return `<span style="display:inline-block;padding:2px 10px;border-radius:11px;font-size:0.72rem;font-weight:700;letter-spacing:0.4px;background:${c.bg};color:${c.fg};border:1px solid ${c.bd};white-space:nowrap;font-family:'SF Mono','JetBrains Mono',Consolas,monospace;">${text}</span>`;
}

// Live order state is a tri-state: DISABLED → DRY-RUN (logged, no order) → LIVE.
function liveOrdersBadge(enableKey, dryKey) {
  if (!envIsOn(enableKey, "false")) return statusBadge("DISABLED", "off");
  const dry = envIsOn("LIVE_HARNESS_DRY_RUN", "true") || (dryKey && envIsOn(dryKey, "false"));
  return dry ? statusBadge("DRY-RUN", "dry") : statusBadge("LIVE · REAL ORDERS", "live");
}

function rowBadge(row) {
  if (row.type === "live")     return liveOrdersBadge(row.enableKey, row.dryKey);
  // A multi-choice setting: show the CHOICE, not an on/off. `warnOn` lists the
  // values that deserve a red badge rather than a neutral one.
  if (row.type === "value") {
    const v = String(process.env[row.key] || row.def || "").trim().toUpperCase() || "—";
    const warn = (row.warnOn || []).map(x => String(x).toUpperCase()).includes(v);
    return statusBadge(v, warn ? "live" : "on");
  }
  if (row.type === "globaldry") return envIsOn(row.key, "true")
    ? statusBadge("DRY-RUN (safe)", "dry")
    : statusBadge("LIVE ARMED", "live");
  return envIsOn(row.key, row.def) ? statusBadge("ENABLED", "on") : statusBadge("DISABLED", "off");
}

function rowEnvKeys(row) {
  if (row.type === "live") return [row.enableKey, row.dryKey].filter(Boolean);
  return [row.key];
}

// Per-guide feature lists. Defaults mirror the settings.js schema.
const GUIDE_STATUS = {
  "ORB_Strategy_Guide.html": { title: "ORB — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "ORB Mode (sidebar + Settings section)", key: "ORB_MODE_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Fyers)", enableKey: "ORB_LIVE_ENABLED", dryKey: "ORB_LIVE_DRY_RUN" },
    { type: "bool", label: "VIX Regime Filter", key: "ORB_VIX_ENABLED", def: "false" },
    { type: "bool", label: "Risk Throttle (streak / weekly stop)", key: "ORB_RISK_THROTTLE_ENABLED", def: "true" },
    { type: "bool", label: "Debug — Per-Candle Gate Trace", key: "ORB_DEBUG_TRACE", def: "false" },
    { type: "bool", label: "Premium-Range Gate", key: "ORB_PREMIUM_GATE_ENABLED", def: "true" },
    { type: "bool", label: "Expiry-Day-Only", key: "ORB_EXPIRY_DAY_ONLY", def: "false" },
  ] }] },
  "EMA_RSI_ST_Strategy_Guide.html": { title: "EMA_RSI_ST — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "EMA_RSI_ST Mode (sidebar + Settings section)", key: "EMA_RSI_ST_MODE_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Zerodha)", enableKey: "EMA_RSI_ST_LIVE_ENABLED", dryKey: "EMA_RSI_ST_LIVE_DRY_RUN" },
    { type: "bool", label: "VIX Filter", key: "VIX_FILTER_ENABLED", def: "true" },
    { type: "bool", label: "Candle Trail", key: "EMA_RSI_ST_CANDLE_TRAIL_ENABLED", def: "false" },
    { type: "value", label: "EMA21 Exit Rule (touch / cross &amp; close)", key: "EMA_RSI_ST_EMA_EXIT_MODE", def: "touch" },
    { type: "bool", label: "Opposite-Side Cooldown", key: "EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED", def: "true" },
    { type: "bool", label: "Expiry-Day-Only", key: "TRADE_EXPIRY_DAY_ONLY", def: "false" },
  ] }] },
  "BB_RSI_Strategy_Guide.html": { title: "BB_RSI — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "BB_RSI Mode (sidebar + Settings section)", key: "BB_RSI_MODE_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Fyers)", enableKey: "BB_RSI_LIVE_ENABLED", dryKey: "BB_RSI_LIVE_DRY_RUN" },
    { type: "bool", label: "VIX Filter", key: "BB_RSI_VIX_ENABLED", def: "false" },
    { type: "bool", label: "ADX Trend Filter", key: "BB_RSI_ADX_ENABLED", def: "false" },
    { type: "bool", label: "Expiry-Day-Only", key: "BB_RSI_EXPIRY_DAY_ONLY", def: "false" },
  ] }] },
  "Price_Action_Strategy_Guide.html": { title: "Price Action — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "PA Mode (sidebar + Settings section)", key: "PA_MODE_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Fyers)", enableKey: "PA_LIVE_ENABLED", dryKey: "PA_LIVE_DRY_RUN" },
    { type: "bool", label: "VIX Filter", key: "PA_VIX_ENABLED", def: "false" },
    { type: "bool", label: "Expiry-Day-Only", key: "PA_EXPIRY_DAY_ONLY", def: "false" },
  ] }] },
  "EMA9_VWAP_Strategy_Guide.html": { title: "EMA9 + VWAP — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "EMA9+VWAP Mode (sidebar + Settings section)", key: "EMA9VWAP_MODE_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Zerodha)", enableKey: "EMA9VWAP_LIVE_ENABLED", dryKey: "EMA9VWAP_LIVE_DRY_RUN" },
    { type: "bool", label: "VIX Filter (global keys)", key: "VIX_FILTER_ENABLED", def: "true" },
    { type: "bool", label: "2-Candle Reversal Exit", key: "EMA9VWAP_REVERSAL_EXIT_ENABLED", def: "true" },
    { type: "bool", label: "Opposite-Side Cooldown", key: "EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_ENABLED", def: "true" },
  ] }] },
  "Trend_Pullback_Strategy_Guide.html": { title: "Trend Pullback — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "Trend Pullback Mode (sidebar + Settings section)", key: "TREND_PB_MODE_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Fyers, via paper harness)", enableKey: "TREND_PB_LIVE_ENABLED", dryKey: "TREND_PB_LIVE_DRY_RUN" },
    { type: "bool", label: "VIX Regime Filter", key: "TREND_PB_VIX_ENABLED", def: "false" },
    { type: "bool", label: "OI Buildup Gate", key: "TREND_PB_OI_ENABLED", def: "false" },
  ] }] },
  "GAPS_Strategy_Guide.html": { title: "GAPS — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "GAPS Mode (sidebar + Settings section)", key: "GAPS_MODE_ENABLED", def: "true" },
    { type: "bool", label: "GAPS Paper Trading", key: "GAPS_PAPER_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Fyers, via paper harness)", enableKey: "GAPS_LIVE_ENABLED", dryKey: "GAPS_LIVE_DRY_RUN" },
    { type: "bool", label: "EMA Trailing Stop", key: "GAPS_TRAIL_ENABLED", def: "true" },
  ] }] },
  "TREND_DAY_SCALP_Strategy_Guide.html": { title: "Trend Day Scalp — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "Trend Day Scalp Mode (sidebar + Settings section)", key: "TDS_MODE_ENABLED", def: "true" },
    { type: "bool", label: "Trend Day Scalp Paper Trading", key: "TDS_PAPER_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Fyers, via paper harness)", enableKey: "TDS_LIVE_ENABLED", dryKey: "TDS_LIVE_DRY_RUN" },
  ] }] },
  "3M_GAP_FIX_SCALP_Strategy_Guide.html": { title: "3M Gap Fix Scalp — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "3M Gap Fix Scalp Mode (sidebar + Settings section)", key: "GAP3M_MODE_ENABLED", def: "true" },
    { type: "bool", label: "3M Gap Fix Scalp Paper Trading", key: "GAP3M_PAPER_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Fyers, via paper harness)", enableKey: "GAP3M_LIVE_ENABLED", dryKey: "GAP3M_LIVE_DRY_RUN" },
  ] }] },
  "OI_WALL_FADE_Strategy_Guide.html": { title: "OI Wall Fade — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "OI Wall Fade Mode (sidebar + Settings section)", key: "OIWF_MODE_ENABLED", def: "true" },
    { type: "bool", label: "OI Wall Fade Paper Trading", key: "OIWF_PAPER_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Fyers, via paper harness)", enableKey: "OIWF_LIVE_ENABLED", dryKey: "OIWF_LIVE_DRY_RUN" },
    { type: "bool", label: "Per-strike OI capture (this strategy reads nothing else)", key: "OPTION_CHAIN_RECORD_OI", def: "true" },
  ] }] },
  "RSI_PIVOT_ST_Strategy_Guide.html": { title: "RSI Pivot ST — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "RSI Pivot ST Mode (sidebar + Settings section)", key: "RSI_PIVOT_ST_MODE_ENABLED", def: "true" },
    { type: "bool", label: "RSI Pivot ST Paper Trading", key: "RSI_PIVOT_ST_PAPER_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Zerodha, via paper harness)", enableKey: "RSI_PIVOT_ST_LIVE_ENABLED", dryKey: "RSI_PIVOT_ST_LIVE_DRY_RUN" },
    { type: "value", label: "SuperTrend Stop applies to", key: "RSI_PIVOT_ST_ST_SIDES", def: "CE", warnOn: ["NONE"] },
    { type: "value", label: "Premium Stop applies to (CE-only / NONE leaves PE with NO stop)", key: "RSI_PIVOT_ST_PREMIUM_SL_SIDES", def: "BOTH", warnOn: ["CE", "NONE"] },
  ] }] },
  "SIMPLE930_Strategy_Guide.html": { title: "SIMPLE_9:30 — Live Configuration", groups: [{ rows: [
    { type: "bool", label: "SIMPLE_9:30 Mode (sidebar + Settings section)", key: "SIMPLE930_MODE_ENABLED", def: "true" },
    { type: "bool", label: "SIMPLE_9:30 Paper Trading", key: "SIMPLE930_PAPER_ENABLED", def: "true" },
    { type: "live", label: "Live Orders (Zerodha, via paper harness)", enableKey: "SIMPLE930_LIVE_ENABLED", dryKey: "SIMPLE930_LIVE_DRY_RUN" },
    { type: "value", label: "Breakout premium (also the strike the 09:25 search aims at)", key: "SIMPLE930_TRIGGER_PREMIUM", def: "180" },
    { type: "bool", label: "Trailing Stop", key: "SIMPLE930_TRAIL_ENABLED", def: "true" },
    { type: "value", label: "Stop distance off the fill (points)", key: "SIMPLE930_SL_PTS", def: "20" },
  ] }] },
  "Application_Setup_Guide.html": { title: "System — Live Configuration", groups: [
    { heading: "Global gates", rows: [
      { type: "globaldry", label: "Live Harness DRY-RUN (global kill-switch)", key: "LIVE_HARNESS_DRY_RUN" },
      { type: "bool", label: "Tick Recorder (for Replay)", key: "TICK_RECORDER_ENABLED", def: "true" },
      { type: "bool", label: "Telegram Alerts (master)", key: "TG_ENABLED", def: "true" },
      { type: "bool", label: "Daily Data Backup", key: "BACKUP_ENABLED", def: "true" },
      { type: "bool", label: "Live NIFTY Chart", key: "CHART_ENABLED", def: "true" },
    ] },
    { heading: "Strategy master toggles", rows: [
      { type: "bool", label: "EMA_RSI_ST Mode", key: "EMA_RSI_ST_MODE_ENABLED", def: "true" },
      { type: "bool", label: "BB_RSI Mode", key: "BB_RSI_MODE_ENABLED", def: "true" },
      { type: "bool", label: "Price Action Mode", key: "PA_MODE_ENABLED", def: "true" },
      { type: "bool", label: "ORB Mode", key: "ORB_MODE_ENABLED", def: "true" },
      { type: "bool", label: "EMA9+VWAP Mode", key: "EMA9VWAP_MODE_ENABLED", def: "true" },
      { type: "bool", label: "Trend Pullback Mode", key: "TREND_PB_MODE_ENABLED", def: "true" },
      { type: "bool", label: "GAPS Mode", key: "GAPS_MODE_ENABLED", def: "true" },
      { type: "bool", label: "Trend Day Scalp Mode", key: "TDS_MODE_ENABLED", def: "true" },
      { type: "bool", label: "3M Gap Fix Scalp Mode", key: "GAP3M_MODE_ENABLED", def: "true" },
      { type: "bool", label: "OI Wall Fade Mode", key: "OIWF_MODE_ENABLED", def: "true" },
      { type: "bool", label: "RSI Pivot ST Mode", key: "RSI_PIVOT_ST_MODE_ENABLED", def: "true" },
      { type: "bool", label: "SIMPLE_9:30 Mode", key: "SIMPLE930_MODE_ENABLED", def: "true" },
    ] },
  ] },
};

function renderStatusPanel(filename) {
  const cfg = GUIDE_STATUS[filename];
  if (!cfg) return "";
  const groupsHtml = cfg.groups.map(g => {
    const head = g.heading
      ? `<div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#8b949e;margin:14px 0 8px;">${g.heading}</div>`
      : "";
    const rows = g.rows.map(r => {
      const keys = rowEnvKeys(r).map(k => `<code style="background:rgba(110,118,129,0.16);color:#8b949e;padding:1px 6px;border-radius:4px;font-size:0.7rem;font-family:'SF Mono',monospace;">${k}</code>`).join(" ");
      return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid rgba(48,54,61,0.6);">
        <div style="flex:1;min-width:0;">
          <div style="color:#e6edf3;font-size:0.9rem;font-weight:500;">${r.label}</div>
          <div style="margin-top:3px;">${keys}</div>
        </div>
        <div style="flex-shrink:0;">${rowBadge(r)}</div>
      </div>`;
    }).join("");
    return head + rows;
  }).join("");

  const stamp = new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }) + " IST";

  return `<div style="max-width:900px;margin:28px auto 0;padding:22px 26px;background:#161b22;border:1px solid #30363d;border-left:4px solid #58a6ff;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,0.4);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:4px;">
      <span style="width:9px;height:9px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950;flex-shrink:0;"></span>
      <span style="font-size:1.05rem;font-weight:700;color:#58a6ff;">${cfg.title}</span>
    </div>
    <div style="font-size:0.78rem;color:#6e7681;margin-bottom:6px;">Reflects this server's current Settings — the tables below show documented <em>defaults</em>; these badges show what's <strong>active right now</strong>. As of ${stamp}.</div>
    ${groupsHtml}
  </div>`;
}

router.get("/file/:filename", (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filepath = path.join(process.cwd(), "documents", filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).send("File not found");
  }
  // HTML guides with a status marker get a live "as-per-settings" panel injected.
  if (filename.toLowerCase().endsWith(".html") && GUIDE_STATUS[filename]) {
    try {
      const html = fs.readFileSync(filepath, "utf-8");
      if (html.includes(STATUS_MARKER)) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(html.replace(STATUS_MARKER, renderStatusPanel(filename)));
      }
    } catch (e) { /* fall through to static send on any read error */ }
  }
  res.sendFile(filepath);
});

router.delete("/file/:filename", (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filepath = path.join(process.cwd(), "documents", filename);
  if (fs.existsSync(filepath)) {
    try {
      fs.unlinkSync(filepath);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete file" });
    }
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

// Legacy PDF route (backward compatibility)
router.get("/pdf/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(process.cwd(), "documents", filename);
  if (fs.existsSync(filepath) && filename.endsWith(".pdf")) {
    res.sendFile(filepath);
  } else {
    res.status(404).send("File not found");
  }
});

module.exports = router;
