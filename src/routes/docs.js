const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

function mdToHtml(md) {
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\| .+$/gm, function(m) { return '<div class="md-tbl">' + m + '</div>'; })
    .replace(/^- (.+)$/gm, '<div class="md-li">$1</div>')
    .replace(/^```[\s\S]*?^```/gm, function(m) {
      var code = m.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      return '<pre>' + code + '</pre>';
    })
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

router.get("/", (req, res) => {
  const projectRoot = process.cwd();
  let readme = "", changelog = "";
  try { readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf-8"); } catch(e) { readme = "README.md not found"; }
  try { changelog = fs.readFileSync(path.join(projectRoot, "CHANGELOG.md"), "utf-8"); } catch(e) { changelog = "CHANGELOG.md not found"; }

  // Read documents folder
  const docsDir = path.join(projectRoot, "documents");
  let docFiles = [];
  try {
    docFiles = fs.readdirSync(docsDir)
      .filter(f => !f.startsWith("."))
      .map(f => {
        const stat = fs.statSync(path.join(docsDir, f));
        const ext = path.extname(f).toLowerCase();
        let icon = "📄";
        if (ext === ".pdf") icon = "📕";
        else if ([".xls", ".xlsx", ".csv"].includes(ext)) icon = "📊";
        else if ([".doc", ".docx"].includes(ext)) icon = "📝";
        else if ([".png", ".jpg", ".jpeg", ".gif", ".svg"].includes(ext)) icon = "🖼️";
        else if ([".txt", ".md"].includes(ext)) icon = "📃";
        const sizeKB = (stat.size / 1024).toFixed(1);
        const modified = stat.mtime.toISOString().split("T")[0];
        return { name: f, icon, sizeKB, modified };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch(e) { /* documents folder not found */ }

  const docListHtml = docFiles.length > 0
    ? docFiles.map(f =>
        `<div class="guide-link">
          <a href="/docs/file/${encodeURIComponent(f.name)}" target="_blank" style="display:flex;align-items:center;gap:10px;flex:1;color:inherit;text-decoration:none;">
            <span class="guide-icon">${f.icon}</span>
            <span style="flex:1">${f.name}</span>
            <span style="color:#4a6080;font-size:0.72rem;white-space:nowrap">${f.sizeKB} KB &nbsp;·&nbsp; ${f.modified}</span>
          </a>
          <button class="del-btn" onclick="deleteDoc('${f.name.replace(/'/g, "\\'")}')">DELETE</button>
        </div>`
      ).join("\n      ")
    : '<p style="color:#4a6080;font-size:0.85rem;">No documents found. Place files in the <code>documents/</code> folder.</p>';

  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  ${faviconLink()}
  <title>Docs — Trading BOT</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; }
    ${sidebarCSS()}

    .main { margin-left:160px; padding:20px 28px; min-height:100vh; }
    @media(max-width:768px){ .main{margin-left:0;padding:12px;} }

    .tabs { display:flex; gap:0; margin-bottom:20px; }
    .tab { padding:10px 22px; background:#0d1117; border:1px solid #1a2640; color:#4a6080; cursor:pointer;
           font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.8px;
           font-family:'IBM Plex Mono',monospace; transition:all 0.15s; user-select:none; }
    .tab:first-child { border-radius:8px 0 0 8px; }
    .tab:last-child { border-radius:0 8px 8px 0; }
    .tab.active { background:rgba(59,130,246,0.15); color:#60a5fa; border-color:rgba(59,130,246,0.35); }
    .tab:hover:not(.active) { background:#111827; color:#8aa1bd; }

    .content { display:none; }
    .content.active { display:block; }

    .doc-card { background:#0d1117; border:1px solid #1a2640; border-radius:10px; padding:28px 32px;
                line-height:1.7; font-size:0.85rem; color:#a3b8d0; }
    .doc-card h1 { font-size:1.3rem; color:#60a5fa; margin:24px 0 8px; font-weight:700; }
    .doc-card h1:first-child { margin-top:0; }
    .doc-card h2 { font-size:1.05rem; color:#3b82f6; margin:20px 0 6px; padding-bottom:6px;
                   border-bottom:1px solid #1a2640; font-weight:600; }
    .doc-card h3 { font-size:0.9rem; color:#10b981; margin:14px 0 4px; font-weight:600; }
    .doc-card strong { color:#e5e7eb; }
    .doc-card code { background:#1a2640; padding:1px 5px; border-radius:3px; font-size:0.8rem;
                     font-family:'IBM Plex Mono',monospace; color:#fbbf24; }
    .doc-card pre { background:#0a0e18; border:1px solid #1a2640; border-radius:6px; padding:12px 16px;
                    overflow-x:auto; font-size:0.78rem; line-height:1.5; margin:8px 0;
                    font-family:'IBM Plex Mono',monospace; color:#a3b8d0; }
    .doc-card .md-li { padding-left:18px; position:relative; margin:2px 0; }
    .doc-card .md-li::before { content:"•"; position:absolute; left:4px; color:#3b82f6; }
    .doc-card .md-tbl { font-family:'IBM Plex Mono',monospace; font-size:0.75rem; color:#6b8aaa; margin:1px 0; }
    .doc-card p { margin:6px 0; }

    .guide-link { display:flex; align-items:center; gap:10px; padding:12px 16px; background:#111827;
                  border:1px solid #1a2640; border-radius:8px; color:#10b981; text-decoration:none;
                  font-size:0.85rem; font-weight:600; transition:all 0.15s; margin:8px 0; }
    .guide-link:hover { background:#1a2640; border-color:#3b82f6; color:#60a5fa; }
    .guide-icon { font-size:1.2rem; }
    .guide-link .del-btn { background:none; border:1px solid #ef4444; color:#ef4444; border-radius:5px;
                           padding:3px 10px; font-size:0.7rem; font-weight:600; cursor:pointer;
                           font-family:'IBM Plex Mono',monospace; transition:all 0.15s; opacity:0.6; }
    .guide-link .del-btn:hover { background:rgba(239,68,68,0.15); opacity:1; }
  </style>
</head>
<body>
${buildSidebar("docs", liveActive)}
<div class="main">
  <div class="tabs">
    <div class="tab active" onclick="showTab(this,'readme')">README</div>
    <div class="tab" onclick="showTab(this,'changelog')">CHANGELOG</div>
    <div class="tab" onclick="showTab(this,'guides')">Documents</div>
  </div>

  <div id="readme" class="content active">
    <div class="doc-card"><p>${mdToHtml(readme)}</p></div>
  </div>

  <div id="changelog" class="content">
    <div class="doc-card"><p>${mdToHtml(changelog)}</p></div>
  </div>

  <div id="guides" class="content">
    <div class="doc-card">
      <h1>Documents</h1>
      <p style="margin-bottom:14px;">Files from the <code>documents/</code> folder (${docFiles.length} file${docFiles.length !== 1 ? "s" : ""}):</p>
      ${docListHtml}
    </div>
  </div>
</div>
<script>
(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();
function showTab(el, id) {
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelectorAll('.content').forEach(function(c){ c.classList.remove('active'); });
  el.classList.add('active');
  document.getElementById(id).classList.add('active');
}
function deleteDoc(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  fetch('/docs/file/' + encodeURIComponent(name), { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.ok) location.reload(); else alert(d.error || 'Delete failed'); })
    .catch(function() { alert('Delete failed'); });
}
</script>
</body></html>`);
});

router.get("/file/:filename", (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filepath = path.join(process.cwd(), "documents", filename);
  if (fs.existsSync(filepath)) {
    res.sendFile(filepath);
  } else {
    res.status(404).send("File not found");
  }
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
