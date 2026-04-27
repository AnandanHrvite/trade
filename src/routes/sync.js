/**
 * sync.js — One-shot EC2→local download of ~/trading-data/
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /sync/info          → { exists, fileCount, totalBytes, mtimeMs }
 * GET  /sync/download-all  → streams tar.gz of ~/trading-data/
 *
 * Direction is one-way (server → client). There is no upload route here.
 * The tar stream uses the system `tar` binary on the EC2 host (Linux).
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const fsp     = fs.promises;
const path    = require("path");
const os      = require("os");
const { spawn } = require("child_process");

const HOME       = os.homedir();
const DATA_DIR   = path.join(HOME, "trading-data");
const DATA_NAME  = "trading-data";

// ── Walk dir, sum file sizes + count ─────────────────────────────────────────
async function summarize(dir) {
  let fileCount = 0;
  let totalBytes = 0;
  let newestMtime = 0;
  async function walk(p) {
    let entries;
    try { entries = await fsp.readdir(p, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full);
          fileCount++;
          totalBytes += st.size;
          if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
        } catch (_) {}
      }
    }
  }
  await walk(dir);
  return { fileCount, totalBytes, newestMtime };
}

// ── GET /sync/info — preview before download ─────────────────────────────────
router.get("/info", async (req, res) => {
  try {
    const exists = fs.existsSync(DATA_DIR);
    if (!exists) {
      return res.json({ exists: false, fileCount: 0, totalBytes: 0, path: DATA_DIR });
    }
    const { fileCount, totalBytes, newestMtime } = await summarize(DATA_DIR);
    res.json({
      exists: true,
      path: DATA_DIR,
      fileCount,
      totalBytes,
      newestMtimeMs: newestMtime,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /sync/download-all — stream tar.gz ───────────────────────────────────
// Spawns `tar -czf - -C $HOME trading-data` and pipes stdout to the response.
// No temp file on disk → constant memory regardless of payload size.
router.get("/download-all", (req, res) => {
  if (!fs.existsSync(DATA_DIR)) {
    return res.status(404).json({ error: `${DATA_DIR} does not exist on server.` });
  }

  // YYYY-MM-DD_HH-mm-ss in local server time
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_` +
                `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const filename = `trading-data-${stamp}.tar.gz`;

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");

  // -C parent → entries in archive look like "trading-data/..." (clean unpack).
  const tar = spawn("tar", ["-czf", "-", "-C", HOME, DATA_NAME], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  tar.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  tar.stdout.pipe(res);

  tar.on("error", (err) => {
    console.warn(`[sync] tar spawn error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });

  tar.on("close", (code) => {
    if (code !== 0) {
      console.warn(`[sync] tar exited code=${code} stderr=${stderr.trim()}`);
      // Headers already flushed — just end the response. The client will see
      // a truncated archive; tar warnings (e.g. file vanished mid-read) are
      // common and non-fatal, so we don't fail loudly.
      if (!res.writableEnded) res.end();
    } else {
      console.log(`[sync] download served: ${filename}`);
    }
  });

  req.on("close", () => {
    // Client disconnected mid-download — kill tar so we don't keep streaming.
    if (tar.exitCode === null) {
      try { tar.kill("SIGTERM"); } catch (_) {}
    }
  });
});

module.exports = router;
