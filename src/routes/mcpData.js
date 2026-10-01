/**
 * /mcp-data — read-only JSON feed for scripts/mcpTradeResults.js.
 *
 * Covers every strategy on every market (NIFTY, BANKNIFTY, COMMODITY) through
 * utils/tradeSources, which discovers modes rather than listing them — so a
 * new strategy appears here without editing this file.
 *
 *   GET /modes                     → { modes: [{ mode, market }] }
 *   GET /dates?mode=               → { mode, dates: [newest first] }
 *   GET /records?mode=&date=       → { mode, date, records: [trades + settings snapshots] }
 *   GET /settings?mode=            → { mode, settings: {KEY: value} } — the values in force now
 *
 * GET only and login-gated (not in the public-path list): settings are config.
 */

const express = require("express");
const tradeSources = require("../utils/tradeSources");
const tradeLogger = require("../utils/tradeLogger");

const router = express.Router();

function modeOf(req, res) {
  const mode = String(req.query.mode || "").toLowerCase();
  if (!tradeSources.isKnownMode(mode)) {
    res.status(400).json({ success: false, error: `unknown mode "${mode}"` });
    return null;
  }
  return mode;
}

router.get("/modes", (_req, res) => {
  res.json({ success: true, modes: tradeSources.listModes() });
});

router.get("/dates", (req, res) => {
  const mode = modeOf(req, res);
  if (!mode) return;
  res.json({ success: true, mode, dates: tradeSources.listDates(mode) });
});

router.get("/records", (req, res) => {
  const mode = modeOf(req, res);
  if (!mode) return;
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: "bad date" });
  res.json({ success: true, mode, date, records: tradeSources.readRecords(mode, date) });
});

router.get("/settings", (req, res) => {
  const mode = modeOf(req, res);
  if (!mode) return;
  const snap = tradeLogger.getSettingsSnapshot(mode);
  if (!snap) return res.status(404).json({ success: false, error: `no settings map for "${mode}"` });
  res.json({ success: true, mode, settings: snap.settings || snap });
});

module.exports = router;
