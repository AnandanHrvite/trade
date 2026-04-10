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
  res.json(deployState);
});

module.exports = router;
