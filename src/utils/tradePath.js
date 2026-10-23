/**
 * tradePath.js — records HOW a trade moved after entry, for later analysis.
 *
 * mfe/mae only say how far price went each way and when it was LAST at that
 * extreme, so they cannot answer "did it go our way first, or against us
 * first?". This adds:
 *   firstMoveDir    "UP" | "DOWN" — which side reached ±FIRST_MOVE_PTS first
 *   secsToFirstMove seconds from entry to that first move
 *   pathPts         favourable pts at every 30s mark for the first 15 min
 *                   (pathPts[0] = at 30s, pathPts[1] = at 60s, …)
 *
 * Pure observer: callers pass the same favPts they already use for mfe/mae
 * (same unit — spot pts for most engines, premium pts for simple930), and it
 * only writes these three fields on pos. Never read by any decision.
 */

const FIRST_MOVE_PTS = 3;
const SAMPLE_SECS    = 30;
const MAX_SAMPLES    = 30;

function trackPath(pos, favPts, nowMs) {
  if (!pos || !Number.isFinite(favPts) || !Number.isFinite(pos.entryTimeMs)) return;
  const secs = (nowMs - pos.entryTimeMs) / 1000;
  if (!(secs >= 0)) return;

  if (pos.firstMoveDir == null && Math.abs(favPts) >= FIRST_MOVE_PTS) {
    pos.firstMoveDir    = favPts > 0 ? "UP" : "DOWN";
    pos.secsToFirstMove = parseFloat(secs.toFixed(1));
  }

  // A mark we have stepped past takes the previous tick's value (that was
  // the price at the mark); a mark hit exactly takes this tick's value.
  if (!Array.isArray(pos.pathPts)) pos.pathPts = [];
  const v = parseFloat(favPts.toFixed(2));
  const prev = Number.isFinite(pos.pathPrevPts) ? pos.pathPrevPts : v;
  while (pos.pathPts.length < MAX_SAMPLES) {
    const markSecs = (pos.pathPts.length + 1) * SAMPLE_SECS;
    if (secs < markSecs) break;
    pos.pathPts.push(secs === markSecs ? v : prev);
  }
  pos.pathPrevPts = v;
}

/** Fields to spread into the closed-trade record. */
function pathFields(pos) {
  return {
    firstMoveDir:    (pos && pos.firstMoveDir) || null,
    secsToFirstMove: pos && pos.secsToFirstMove != null ? pos.secsToFirstMove : null,
    pathPts:         pos && Array.isArray(pos.pathPts) ? pos.pathPts : [],
  };
}

module.exports = { trackPath, pathFields, FIRST_MOVE_PTS };
