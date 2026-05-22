/**
 * backup.js — Download daily data snapshots + nag-until-downloaded status
 * ─────────────────────────────────────────────────────────────────────────────
 * Surfaced as a "Backup & Restore" card inside the Settings page (no nav item).
 *
 * GET  /backup/status            → { enabled, date, exists, downloaded }  (banner poll)
 * GET  /backup/data              → { enabled, backups: [...], hour, retainDays }
 * GET  /backup/download?date=…   → streams backup-<date>.tar.gz, marks it downloaded
 * POST /backup/create            → cut a snapshot for today now
 *
 * Auth: inherits the app-wide gate (LOGIN_SECRET / API_SECRET middleware in app.js),
 * same as every other route. No extra gating here.
 */

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const router  = express.Router();
const backup  = require("../utils/backupManager");
const sharedSocketState = require("../utils/sharedSocketState");

// ── GET /backup/status — lightweight poll for the download-nag banner ─────────
router.get("/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(backup.todayStatus());
});

// ── GET /backup/data — full list for the Settings card ────────────────────────
router.get("/data", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    enabled: backup.isEnabled(),
    hour: parseInt(process.env.BACKUP_HOUR_IST || "16", 10),
    retainDays: parseInt(process.env.BACKUP_RETAIN_DAYS || "14", 10),
    backups: backup.listBackups(),
  });
});

// ── POST /backup/create — snapshot today now ──────────────────────────────────
router.post("/create", async (req, res) => {
  if (!backup.isEnabled()) {
    return res.status(403).json({ ok: false, error: "Backup is disabled (BACKUP_ENABLED=false)" });
  }
  const date = backup.istDateStr();
  const r = await backup.createSnapshot(date);
  if (r.ok) {
    console.log(`[backup] manual snapshot created: backup-${date}.tar.gz (${(r.sizeBytes / 1048576).toFixed(2)} MB)`);
    res.json({ ok: true, date, sizeBytes: r.sizeBytes });
  } else {
    res.status(500).json({ ok: false, error: r.error });
  }
});

// ── GET /backup/download?date=YYYY-MM-DD — stream + mark downloaded ────────────
router.get("/download", (req, res) => {
  const date = String(req.query.date || backup.istDateStr());
  const file = backup.getBackupFile(date);
  if (!file) {
    return res.status(404).json({ error: `No backup for ${date}` });
  }
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="backup-${date}.tar.gz"`);
  res.setHeader("Cache-Control", "no-store");

  const stream = fs.createReadStream(file);
  stream.on("error", (err) => {
    console.warn(`[backup] download stream error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  // Mark downloaded only once the file has fully flushed to the client.
  res.on("finish", () => {
    if (res.writableEnded) {
      backup.markDownloaded(date);
      console.log(`[backup] download served + marked downloaded: backup-${date}.tar.gz`);
    }
  });
  stream.pipe(res);
});

// ── POST /backup/restore — upload a .tar.gz and restore it ────────────────────
// Body = the raw .tar.gz bytes (Content-Type application/gzip). Destructive:
// overwrites ~/trading-data + data/ticks. Refused while any session is active;
// a pre-restore safety snapshot is taken automatically inside backupManager.
router.post("/restore", (req, res) => {
  if (sharedSocketState.isAnyActive && sharedSocketState.isAnyActive()) {
    return res.status(409).json({ ok: false, error: "A trading session is active — stop it before restoring." });
  }

  const tmp = path.join(backup.BACKUP_DIR, `.restore-upload-${Date.now()}.tar.gz`);
  try { fs.mkdirSync(backup.BACKUP_DIR, { recursive: true }); } catch (_) {}

  const ws = fs.createWriteStream(tmp);
  const cleanup = () => { try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {} };

  ws.on("error", (err) => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ ok: false, error: "upload write failed: " + err.message });
  });
  req.on("error", () => { cleanup(); });

  ws.on("finish", async () => {
    try {
      const r = await backup.restoreFromFile(tmp);
      cleanup();
      if (r.ok) {
        console.log(`[backup] RESTORE complete: ${r.restored.join(", ")} (pre-restore: ${r.preRestore || "none"})`);
        res.json({ ok: true, restored: r.restored, preRestore: r.preRestore });
      } else {
        console.warn(`[backup] restore rejected: ${r.error}`);
        res.status(400).json({ ok: false, error: r.error, preRestore: r.preRestore || null });
      }
    } catch (err) {
      cleanup();
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  req.pipe(ws);
});

module.exports = router;
