const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");

router.get("/", (req, res) => {
  const projectRoot = process.cwd();
  
  // Read README and CHANGELOG
  let readme = "", changelog = "";
  try { readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf-8"); } catch(e) {}
  try { changelog = fs.readFileSync(path.join(projectRoot, "CHANGELOG.md"), "utf-8"); } catch(e) {}
  
  // Simple markdown → HTML (basic)
  function mdToHtml(md) {
    return md
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/^### (.+)$/gm, '<h3 style="color:#10b981;margin-top:16px;">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 style="color:#3b82f6;margin-top:20px;border-bottom:1px solid #1e2a40;padding-bottom:4px;">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="color:#60a5fa;">$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e5e7eb;">$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:#1e2a40;padding:1px 4px;border-radius:3px;font-size:0.85em;">$1</code>')
      .replace(/^- (.+)$/gm, '<div style="padding-left:16px;">• $1</div>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  res.send(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Docs — Trading Bot</title>${faviconLink}
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'IBM Plex Mono','Menlo',monospace;background:#060a10;color:#a3b1c6;display:flex;min-height:100vh;font-size:13px}
${sidebarCSS}
.main{flex:1;padding:20px;overflow-y:auto}
.doc-card{background:#0d1117;border:0.5px solid #0e1428;border-radius:8px;padding:20px 24px;margin-bottom:20px}
.doc-card h1{font-size:18px} .doc-card h2{font-size:15px} .doc-card h3{font-size:13px}
.tabs{display:flex;gap:0;margin-bottom:20px}
.tab{padding:8px 20px;background:#0d1117;border:0.5px solid #0e1428;color:#4a6080;cursor:pointer;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;transition:all 0.15s}
.tab:first-child{border-radius:6px 0 0 6px}.tab:last-child{border-radius:0 6px 6px 0}
.tab.active{background:rgba(59,130,246,0.12);color:#60a5fa;border-color:rgba(59,130,246,0.25)}
.tab:hover:not(.active){background:#111827;color:#8aa1bd}
.content{display:none}.content.active{display:block}
</style></head><body>
${buildSidebar("docs")}
<div class="main">
<div class="tabs">
  <div class="tab active" onclick="showTab('readme')">README</div>
  <div class="tab" onclick="showTab('changelog')">CHANGELOG</div>
  <div class="tab" onclick="showTab('guides')">Strategy Guides</div>
</div>
<div id="readme" class="content active"><div class="doc-card">${mdToHtml(readme)}</div></div>
<div id="changelog" class="content"><div class="doc-card">${mdToHtml(changelog)}</div></div>
<div id="guides" class="content"><div class="doc-card">
<h2 style="color:#3b82f6;">Strategy Documentation PDFs</h2><br>
<p>Place PDF files in your project root and access them here:</p><br>
<div style="display:flex;flex-direction:column;gap:8px;margin-top:12px;">
  <a href="/docs/pdf/Trading_Strategy_Guide.pdf" style="color:#10b981;text-decoration:none;padding:8px 12px;background:#111827;border-radius:6px;border:0.5px solid #1e2a40;">📄 Trading Strategy Guide (Logic + Charts)</a>
</div>
</div></div>
</div>
<script>
function showTab(id){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.content').forEach(c=>c.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  event.target.classList.add('active');
}
</script></body></html>`);
});

// Serve PDF files from project root
router.get("/pdf/:filename", (req, res) => {
  const filepath = path.join(process.cwd(), req.params.filename);
  if (fs.existsSync(filepath) && req.params.filename.endsWith(".pdf")) {
    res.sendFile(filepath);
  } else {
    res.status(404).send("File not found");
  }
});

module.exports = router;
