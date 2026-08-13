/**
 * backtestJobManager.js — Background backtest job manager
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages background backtest jobs so the HTTP request returns immediately
 * with a progress page. Only 1 backtest can run at a time to protect server
 * resources. Jobs are stored in memory — no persistence needed.
 *
 * Usage:
 *   const jobs = require("./backtestJobManager");
 *   const { id } = jobs.createJob("ema_rsi_st");
 *   jobs.updateProgress(id, { phase: "Fetching…", pct: 10 });
 *   jobs.completeJob(id, result);
 *   jobs.getJob(id);
 */

const crypto = require("crypto");
const { resolveTheme } = require("./theme");

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

/** Thrown out of updateProgress() once a job has been cancelled — see cancelJob(). */
class BacktestCancelledError extends Error {
  constructor() {
    super("Backtest cancelled by user");
    this.name = "BacktestCancelledError";
    this.cancelled = true;
  }
}

/**
 * Report progress — and abort the run if the user pressed Cancel.
 *
 * Every backtest route funnels its progress through here (fetch-phase callback +
 * per-candle engine callback), and every one of them wraps the whole job body in
 * try/catch → failJob. So throwing here is the one hook that unwinds *any*
 * strategy's job without each engine having to poll a cancel flag. Cancellation
 * therefore takes effect at the next progress tick — engines that compute
 * synchronously with no progress callback (e.g. ORB) run to completion, but
 * their result is discarded by the completeJob() guard below.
 */
function updateProgress(id, progress) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.status === "cancelled") throw new BacktestCancelledError();
  if (job.status === "running") {
    job.progress = { ...job.progress, ...progress };
  }
}

/**
 * Mark a running job cancelled and free the slot so a queued tab can start.
 * Returns false if the job is unknown or already finished.
 */
function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  job.status = "cancelled";
  job.error = "Backtest cancelled by user.";
  job.progress = { ...job.progress, phase: "Cancelled" };
  job.completedAt = Date.now();
  if (activeJobId === id) activeJobId = null;
  // Keep the record briefly so the page's in-flight poll sees "cancelled", then
  // drop it — a later hit on the stale ?jobId= URL then just starts a fresh run.
  const t = setTimeout(() => { const j = jobs.get(id); if (j && j.status === "cancelled") jobs.delete(id); }, 30_000);
  if (t.unref) t.unref();
  return true;
}

function completeJob(id, result) {
  const job = jobs.get(id);
  if (job && job.status !== "cancelled") {
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
  // A cancelled job unwinds through its route's catch → failJob. Keep the
  // "cancelled" status; the run didn't fail, the user stopped it.
  if (job && job.status !== "cancelled") {
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
 * @param {string} basePath - Route base path (e.g. "/ema_rsi_st-backtest")
 * @param {string} title   - Page title prefix
 */
/** `data-theme="light"` when UI_THEME resolves to light, so these standalone
 *  pages follow the same setting as every other screen. */
function _lightAttr() {
  return resolveTheme() === "light" ? ' data-theme="light"' : "";
}

function buildProgressPage(jobId, basePath, title) {
  return `<!DOCTYPE html>
<html lang="en"${_lightAttr()}>
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
    .detail{color:var(--muted-1,#8ba1c2);font-size:0.72rem;margin-bottom:4px;}
    .elapsed{color:var(--muted-2,#6d85a8);font-size:0.68rem;margin-top:12px;}
    .warn{background:#1a1800;border:1px solid #3a3000;border-radius:8px;padding:12px 16px;margin-top:20px;font-size:0.72rem;color:#b8a040;line-height:1.5;}
    .err{background:#1a0808;border:1px solid #7f1d1d;border-radius:8px;padding:16px;margin-top:16px;color:#ef4444;font-size:0.8rem;}
    .err a{color:#f87171;text-decoration:underline;}
    .spinner{display:inline-block;width:18px;height:18px;border:2px solid #1a2540;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:8px;}
    @keyframes spin{to{transform:rotate(360deg)}}
    .actions{margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
    .btn{font-family:inherit;font-size:0.78rem;padding:10px 20px;min-height:40px;border-radius:8px;cursor:pointer;background:#1a0f14;border:1px solid #7f1d1d;color:#f87171;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;}
    .btn:hover{background:#2a1218;}
    .btn:disabled{opacity:0.5;cursor:default;}
    .btn.neutral{background:#0f1626;border-color:#1a2540;color:#8ba1c2;}
    .btn.neutral:hover{background:#16203a;}
    /* Light skin — these two interstitials sit outside sharedNav, so they carried
       neither the light theme nor the phone breakpoint. Both live here. */
    :root[data-theme="light"] body{background:#f4f6f9;color:#334155;}
    :root[data-theme="light"] .card{background:#ffffff;border-color:#e0e4ea;box-shadow:0 1px 3px rgba(0,0,0,0.06);}
    :root[data-theme="light"] h2{color:#1e293b;}
    :root[data-theme="light"] .phase{color:#4b5769;}
    :root[data-theme="light"] .elapsed{color:#5c6b7f;}
    :root[data-theme="light"] .detail{color:#4b5769;}
    :root[data-theme="light"] .pct{color:#1e293b;}
    :root[data-theme="light"] .warn{background:#fffbeb;border-color:#fcd34d;color:#b45309;}
    :root[data-theme="light"] .bar-wrap{background:#f1f5f9;border-color:#e0e4ea;}
    :root[data-theme="light"] .err{background:#fef2f2;border-color:#fca5a5;color:#b91c1c;}
    :root[data-theme="light"] .err a{color:#b91c1c;}
    :root[data-theme="light"] .spinner{border-color:#e0e4ea;}
    :root[data-theme="light"] .btn{background:#fef2f2;border-color:#fca5a5;color:#b91c1c;}
    :root[data-theme="light"] .btn:hover{background:#fee2e2;}
    :root[data-theme="light"] .btn.neutral{background:#f1f5f9;border-color:#e0e4ea;color:#475569;}
    :root[data-theme="light"] .btn.neutral:hover{background:#e2e8f0;}
    @media(max-width:768px){
      /* 56px of side padding left ~280px of usable width on a 440px screen. */
      body{align-items:flex-start;padding:16px 12px;}
      .card{padding:28px 20px;width:100%;max-width:100%;border-radius:12px;}
      h2{font-size:1.05rem;}
      .err a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;}
      .btn{min-height:44px;flex:1 1 140px;}
    }
  </style>
</head>
<body>
  <div class="card">
    <h2 id="head"><span class="spinner"></span> Backtest Running</h2>
    <div class="phase" id="phase">Initializing…</div>
    <div class="pct" id="pct">0%</div>
    <div class="bar-wrap"><div class="bar" id="bar" style="width:0%"></div></div>
    <div class="detail" id="detail"></div>
    <div class="elapsed" id="elapsed">Elapsed: 0s</div>
    <div class="actions" id="actions">
      <button class="btn" id="cancelBtn" type="button">✖ Cancel Backtest</button>
    </div>
    <div class="warn" id="warn">
      ⏳ Large backtests (3+ years) may take a few minutes.<br>
      This page auto-updates — <b>do not close it</b>. Server stays responsive.
    </div>
    <div class="err" id="err" style="display:none"></div>
  </div>

  <script>
    const JOB_ID = "${jobId}";
    const BASE   = "${basePath}";
    const started = Date.now();
    let cancelled = false;   // set once the server confirms — stops the poll loop

    // ── Cancel ────────────────────────────────────────────────────────────────
    // POST /backtest/cancel is a write route, so it sits behind API_SECRET. This
    // page is standalone (no sharedNav), so it carries its own minimal version of
    // secretFetch: reuse the session's stored secret, prompt only on a 403.
    async function cancelFetch() {
      const url = "/backtest/cancel?jobId=" + encodeURIComponent(JOB_ID);
      let secret = sessionStorage.getItem("__api_secret") || "";
      let res = await fetch(url, { method: "POST", headers: secret ? { "x-api-secret": secret } : {} });
      if (res.status === 403) {
        sessionStorage.removeItem("__api_secret");
        secret = window.prompt(secret ? "Wrong API secret — try again:" : "API_SECRET required to cancel:");
        if (secret === null) return null;         // user backed out — keep running
        sessionStorage.setItem("__api_secret", secret);
        res = await fetch(url, { method: "POST", headers: { "x-api-secret": secret } });
      }
      return res;
    }

    function showCancelled() {
      cancelled = true;
      document.getElementById("head").innerHTML = "🛑 Backtest Cancelled";
      document.getElementById("phase").textContent = "Stopped. No results were saved.";
      document.getElementById("warn").style.display = "none";
      // Drop ?jobId= so a refresh (or Back) starts a fresh run instead of
      // re-opening the cancelled job.
      const clean = new URL(window.location.href);
      clean.searchParams.delete("jobId");
      history.replaceState(null, "", clean.toString());
      document.getElementById("actions").innerHTML =
        '<a class="btn neutral" href="' + clean.toString() + '">↻ Run again</a>' +
        '<a class="btn neutral" href="/all-backtest">← Backtest dashboard</a>';
    }

    document.getElementById("cancelBtn").addEventListener("click", async function () {
      const btn = this;
      btn.disabled = true;
      btn.textContent = "Cancelling…";
      try {
        const res = await cancelFetch();
        if (!res) { btn.disabled = false; btn.textContent = "✖ Cancel Backtest"; return; }
        if (res.ok) { showCancelled(); return; }
        btn.disabled = false;
        btn.textContent = "✖ Cancel Backtest";
        document.getElementById("err").style.display = "block";
        document.getElementById("err").textContent = "❌ Could not cancel (HTTP " + res.status + ").";
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "✖ Cancel Backtest";
      }
    });

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
      if (cancelled) return;
      try {
        const r = await fetch(BASE + "/status?jobId=" + JOB_ID);
        const d = await r.json();
        if (cancelled) return;

        if (d.status === "cancelled") { showCancelled(); return; }

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
<html lang="en"${_lightAttr()}>
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
    .elapsed{color:var(--muted-2,#6d85a8);font-size:0.68rem;margin-top:12px;}
    /* Light skin — these two interstitials sit outside sharedNav, so they carried
       neither the light theme nor the phone breakpoint. Both live here. */
    :root[data-theme="light"] body{background:#f4f6f9;color:#334155;}
    :root[data-theme="light"] .card{background:#ffffff;border-color:#e0e4ea;box-shadow:0 1px 3px rgba(0,0,0,0.06);}
    :root[data-theme="light"] h2{color:#1e293b;}
    :root[data-theme="light"] .phase{color:#4b5769;}
    :root[data-theme="light"] .elapsed{color:#5c6b7f;}
    :root[data-theme="light"] .detail{color:#4b5769;}
    :root[data-theme="light"] .pct{color:#1e293b;}
    :root[data-theme="light"] .warn{background:#fffbeb;border-color:#fcd34d;color:#b45309;}
    :root[data-theme="light"] .bar-wrap{background:#f1f5f9;border-color:#e0e4ea;}
    :root[data-theme="light"] .err{background:#fef2f2;border-color:#fca5a5;color:#b91c1c;}
    :root[data-theme="light"] .err a{color:#b91c1c;}
    :root[data-theme="light"] .spinner{border-color:#e0e4ea;}
    @media(max-width:768px){
      /* 56px of side padding left ~280px of usable width on a 440px screen. */
      body{align-items:flex-start;padding:16px 12px;}
      .card{padding:28px 20px;width:100%;max-width:100%;border-radius:12px;}
      h2{font-size:1.05rem;}
      .err a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;}
    }
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
    var mySlot=Math.floor(Math.random()*10000);
    async function poll(){
      try{
        var r=await fetch(BASE+"/idle");
        var d=await r.json();
        if(d.idle){
          // Random delay so queued tabs don't all reload at once
          setTimeout(function(){
            var url=new URL(window.location.href);
            url.searchParams.delete("jobId");
            window.location.href=url.toString();
          }, mySlot);
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

/** Drop all finished/failed jobs — frees any large trade arrays still in memory. */
function _purgeInactive() {
  let removed = 0;
  for (const [id, job] of jobs) {
    if (job.status !== "running") { jobs.delete(id); removed++; }
  }
  return removed;
}

module.exports = {
  createJob,
  updateProgress,
  completeJob,
  failJob,
  cancelJob,
  BacktestCancelledError,
  getJob,
  getActiveJob,
  isIdle,
  buildProgressPage,
  buildQueuePage,
  _purgeInactive,
};
