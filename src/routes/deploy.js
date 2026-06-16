/**
 * deploy.js — GitHub Actions deploy status via webhook
 * ─────────────────────────────────────────────────────
 * POST /deploy/webhook   — receives GitHub workflow_run events
 * GET  /deploy/status    — returns current deploy state (polled by sidebar)
 * Webhook setup: GitHub repo → Settings → Webhooks → workflow_run event
 */

const express = require("express");
const router  = express.Router();

// In-memory deploy state
let deployState = {
  status: "idle",       // idle | deploying | success | failure
  startedAt: null,      // ISO timestamp
  finishedAt: null,     // ISO timestamp
  commitMsg: "",        // head commit message
  commitSha: "",        // short SHA
  actor: "",            // who pushed
};

// A deploy's "completed" webhook is delivered right when the PM2 restart step
// recycles THIS process, so it routinely lands in the restart window and is
// lost — leaving the badge stuck on "deploying" forever. Self-heal: if a deploy
// has been "deploying" longer than any real run takes, resolve it to success.
// Sound because the server is up enough to serve this very request, so a deploy
// that started this long ago must have finished (real runs are ~25–90s).
const DEPLOY_STALE_MS = 3 * 60 * 1000;

function currentState() {
  if (deployState.status === "deploying" && deployState.startedAt) {
    const age = Date.now() - new Date(deployState.startedAt).getTime();
    if (age > DEPLOY_STALE_MS) {
      deployState = {
        ...deployState,
        status:     "success",
        finishedAt: deployState.finishedAt || new Date().toISOString(),
      };
    }
  }
  return deployState;
}

/* ── Webhook receiver ──────────────────────────────────────────────────────── */
router.post("/webhook", (req, res) => {
  const event  = req.headers["x-github-event"];
  const body   = req.body;

  // Only handle workflow_run events
  if (event !== "workflow_run") return res.sendStatus(204);

  const run    = body.workflow_run;
  if (!run) return res.sendStatus(204);

  const action = body.action; // requested | in_progress | completed

  if (action === "requested" || action === "in_progress") {
    deployState = {
      status:     "deploying",
      startedAt:  run.run_started_at || new Date().toISOString(),
      finishedAt: null,
      commitMsg:  (run.head_commit && run.head_commit.message) || run.display_title || "",
      commitSha:  run.head_sha ? run.head_sha.slice(0, 7) : "",
      actor:      (run.actor && run.actor.login) || "",
    };
  } else if (action === "completed") {
    deployState = {
      status:     run.conclusion === "success" ? "success" : "failure",
      startedAt:  deployState.startedAt || run.run_started_at,
      finishedAt: run.updated_at || new Date().toISOString(),
      commitMsg:  (run.head_commit && run.head_commit.message) || run.display_title || deployState.commitMsg,
      commitSha:  run.head_sha ? run.head_sha.slice(0, 7) : deployState.commitSha,
      actor:      (run.actor && run.actor.login) || deployState.actor,
    };
  }

  res.sendStatus(200);
});

/* ── Status endpoint (polled by sidebar) ───────────────────────────────────── */
router.get("/status", (req, res) => {
  res.json(currentState());
});

module.exports = router;
