/**
 * backtestJobManager.js — Background backtest job manager
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages background backtest jobs so the HTTP request returns immediately
 * with a progress page. Only 1 backtest can run at a time to protect server
 * resources. Jobs are stored in memory — no persistence needed.
 *
 * Usage:
 *   const jobs = require("./backtestJobManager");
 *   const { id } = jobs.createJob("swing");
 *   jobs.updateProgress(id, { phase: "Fetching…", pct: 10 });
 *   jobs.completeJob(id, result);
 *   jobs.getJob(id);
 */

const crypto = require("crypto");

const jobs = new Map();
let activeJobId = null;

function createJob(type) {
  // Only 1 concurrent backtest — protect server resources
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    if (active && active.status === "running") {
      return { id: activeJobId, existing: true };
    }
  }

  const id = crypto.randomBytes(6).toString("hex");
  jobs.set(id, {
    id,
    type,
    status: "running",
    progress: { phase: "Starting…", pct: 0, current: 0, total: 0 },
    result: null,
    error: null,
    startedAt: Date.now(),
    completedAt: null,
  });
  activeJobId = id;

  // Cleanup old jobs — keep last 5
  const all = [...jobs.entries()].sort((a, b) => b[1].startedAt - a[1].startedAt);
  for (const [oldId] of all.slice(5)) {
    if (oldId !== id) jobs.delete(oldId);
  }

  return { id, existing: false };
}

function updateProgress(id, progress) {
  const job = jobs.get(id);
  if (job && job.status === "running") {
    job.progress = { ...job.progress, ...progress };
  }
}

function completeJob(id, result) {
  const job = jobs.get(id);
  if (job) {
    job.status = "done";
    job.result = result;
    job.progress = { phase: "Done", pct: 100 };
    job.completedAt = Date.now();
    if (activeJobId === id) activeJobId = null;
    // Cleanup old jobs to prevent memory leak (each job holds full trade array)
    const all = [...jobs.entries()].sort((a, b) => b[1].startedAt - a[1].startedAt);
    for (const [oldId] of all.slice(3)) jobs.delete(oldId);
  }
}

function failJob(id, error) {
  const job = jobs.get(id);
  if (job) {
    job.status = "error";
    job.error = typeof error === "string" ? error : (error.message || String(error));
    job.progress = { ...job.progress, phase: "Failed" };
    if (activeJobId === id) activeJobId = null;
  }
}

function getJob(id) {
  return jobs.get(id) || null;
}

function getActiveJob() {
  if (!activeJobId) return null;
  const job = jobs.get(activeJobId);
  return (job && job.status === "running") ? job : null;
}

function isIdle() {
  if (!activeJobId) return true;
  const job = jobs.get(activeJobId);
  return !job || job.status !== "running";
}

/**
 * Build a dark-themed progress page with animated progress bar.
 * Polls /status every 1.5s and auto-redirects when done.
 *
 * @param {string} jobId   - Job ID to poll
 * @param {string} basePath - Route base path (e.g. "/swing-backtest")
 * @param {string} title   - Page title prefix
 */
function buildProgressPage(jobId, basePath, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title || "Backtest"} — Running…</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;display:flex;align-items:center;justify-content:center;}
    .card{background:#0d1320;border:1px solid #1a2540;border-radius:16px;padding:48px 56px;max-width:560px;width:90%;text-align:center;}
    h2{color:#e0e8f0;font-size:1.2rem;margin-bottom:8px;}
    .phase{color:#6b8db5;font-size:0.85rem;margin-bottom:24px;min-height:1.2em;}
    .bar-wrap{background:#0a0e1a;border:1px solid #1a2540;border-radius:10px;height:28px;overflow:hidden;position:relative;margin-bottom:16px;}
    .bar{height:100%;border-radius:10px;background:linear-gradient(90deg,#3b82f6,#10b981);transition:width 0.6s ease;position:relative;min-width:2%;}
    .bar::after{content:'';position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,0.15) 50%,transparent 100%);animation:shimmer 2s infinite;}
    @keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
    .pct{font-size:1.8rem;font-weight:700;color:#e0e8f0;margin-bottom:6px;}
    .detail{color:#4a6080;font-size:0.72rem;margin-bottom:4px;}
    .elapsed{color:#3a5070;font-size:0.68rem;margin-top:12px;}
    .warn{background:#1a1800;border:1px solid #3a3000;border-radius:8px;padding:12px 16px;margin-top:20px;font-size:0.72rem;color:#b8a040;line-height:1.5;}
    .err{background:#1a0808;border:1px solid #7f1d1d;border-radius:8px;padding:16px;margin-top:16px;color:#ef4444;font-size:0.8rem;}
    .err a{color:#f87171;text-decoration:underline;}
    .spinner{display:inline-block;width:18px;height:18px;border:2px solid #1a2540;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:8px;}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="card">
    <h2><span class="spinner"></span> Backtest Running</h2>
    <div class="phase" id="phase">Initializing…</div>
    <div class="pct" id="pct">0%</div>
    <div class="bar-wrap"><div class="bar" id="bar" style="width:0%"></div></div>
    <div class="detail" id="detail"></div>
    <div class="elapsed" id="elapsed">Elapsed: 0s</div>
    <div class="warn">
      ⏳ Large backtests (3+ years) may take a few minutes.<br>
      This page auto-updates — <b>do not close it</b>. Server stays responsive.
    </div>
    <div class="err" id="err" style="display:none"></div>
  </div>

  <script>
    const JOB_ID = "${jobId}";
    const BASE   = "${basePath}";
    const started = Date.now();

    // Preserve original query params (from, to, resolution) when redirecting
    function buildRedirectURL(extra) {
      const url = new URL(window.location.href);
      if (extra) Object.entries(extra).forEach(([k, v]) => url.searchParams.set(k, v));
      return url.toString();
    }

    function fmtTime(ms) {
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + "s";
      const m = Math.floor(s / 60);
      return m + "m " + (s % 60) + "s";
    }

    async function poll() {
      try {
        const r = await fetch(BASE + "/status?jobId=" + JOB_ID);
        const d = await r.json();

        if (d.status === "done") {
          document.getElementById("phase").textContent = "Complete! Loading results…";
          document.getElementById("pct").textContent = "100%";
          document.getElementById("bar").style.width = "100%";
          window.location.href = buildRedirectURL({ jobId: JOB_ID });
          return;
        }

        if (d.status === "error") {
          document.getElementById("phase").textContent = "Failed";
          document.getElementById("err").style.display = "block";
          document.getElementById("err").innerHTML = "❌ " + (d.error || "Unknown error") +
            '<br><br><a href="' + BASE + '">← Try again</a>';
          document.querySelector(".spinner").style.display = "none";
          return;
        }

        if (d.status === "not_found") {
          // Job lost (server restarted) — re-trigger with same params
          var retryUrl = new URL(window.location.href);
          retryUrl.searchParams.delete("jobId");
          window.location.href = retryUrl.toString();
          return;
        }

        // Running
        const p = d.progress || {};
        const pct = p.pct || 0;
        document.getElementById("pct").textContent = pct + "%";
        document.getElementById("bar").style.width = Math.max(pct, 1) + "%";
        document.getElementById("phase").textContent = p.phase || "Processing…";

        if (p.current > 0 && p.total > 0) {
          document.getElementById("detail").textContent =
            "Candle " + p.current.toLocaleString() + " / " + p.total.toLocaleString();
        }

        const elapsed = d.elapsed || (Date.now() - started);
        document.getElementById("elapsed").textContent = "Elapsed: " + fmtTime(elapsed);

        setTimeout(poll, 1500);
      } catch (e) {
        // Network error — retry
        setTimeout(poll, 3000);
      }
    }

    poll();
  </script>
</body>
</html>`;
}

/**
 * Build a queue/waiting page that polls until the server is idle,
 * then auto-reloads to start its own backtest job.
 */
function buildQueuePage(basePath, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title || "Backtest"} — Queued</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;display:flex;align-items:center;justify-content:center;}
    .card{background:#0d1320;border:1px solid #1a2540;border-radius:16px;padding:48px 56px;max-width:560px;width:90%;text-align:center;}
    h2{color:#e0e8f0;font-size:1.2rem;margin-bottom:8px;}
    .phase{color:#6b8db5;font-size:0.85rem;margin-bottom:24px;}
    .spinner{display:inline-block;width:18px;height:18px;border:2px solid #1a2540;border-top-color:#f59e0b;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:8px;}
    @keyframes spin{to{transform:rotate(360deg)}}
    .warn{background:#1a1800;border:1px solid #3a3000;border-radius:8px;padding:12px 16px;margin-top:20px;font-size:0.72rem;color:#b8a040;line-height:1.5;}
    .elapsed{color:#3a5070;font-size:0.68rem;margin-top:12px;}
  </style>
</head>
<body>
  <div class="card">
    <h2><span class="spinner"></span> Queued — Waiting</h2>
    <div class="phase">Another backtest is running. This tab will start automatically when it finishes.</div>
    <div class="elapsed" id="elapsed">Waiting: 0s</div>
    <div class="warn">
      ⏳ Split mode opens multiple tabs. Each runs one at a time to protect server resources.<br>
      This page auto-starts — <b>do not close it</b>.
    </div>
  </div>
  <script>
    const BASE = "${basePath}";
    const started = Date.now();
    function fmtTime(ms){var s=Math.floor(ms/1000);if(s<60)return s+"s";var m=Math.floor(s/60);return m+"m "+(s%60)+"s";}
    async function poll(){
      try{
        var r=await fetch(BASE+"/idle");
        var d=await r.json();
        if(d.idle){
          // Remove jobId param and reload — this tab will create its own job
          var url=new URL(window.location.href);
          url.searchParams.delete("jobId");
          window.location.href=url.toString();
          return;
        }
      }catch(e){}
      document.getElementById("elapsed").textContent="Waiting: "+fmtTime(Date.now()-started);
      setTimeout(poll,2000);
    }
    poll();
  </script>
</body>
</html>`;
}

module.exports = {
  createJob,
  updateProgress,
  completeJob,
  failJob,
  getJob,
  getActiveJob,
  isIdle,
  buildProgressPage,
  buildQueuePage,
};
