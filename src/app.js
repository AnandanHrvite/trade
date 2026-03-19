require("dotenv").config();
require("./services/logger");              // ← MUST be first: intercepts all console.* from here on

const express  = require("express");
const https    = require("https");
const fs       = require("fs");
const { ACTIVE, getActiveStrategy } = require("./strategies");
const { INSTRUMENT } = require("./config/instrument");
const zerodha  = require("./services/zerodhaBroker");
const { clearFyersToken } = require("./config/fyers");
const sharedSocketState = require("./utils/sharedSocketState");

const app = express();
app.use(express.json());

// ── Local security — simple secret token ────────────────────────────────────
// Set API_SECRET in .env. Pass as ?secret=xxx or header x-api-secret: xxx
// Status pages are open (read-only). All action routes require the secret.
// OPEN_PATHS: routes that bypass the API_SECRET check.
// Status/read-only pages are open. All action routes (start/stop/exit) are PROTECTED.
// Since this app runs on localhost only, protection is mainly against accidental browser hits.
const OPEN_PATHS = [
  "/",
  "/logs",              // log viewer — read-only
  "/logs/stream",       // SSE stream — read-only
  "/logs/export",       // export txt
  "/logs/export-json",  // export json
  "/trade/status",          // read-only status page
  "/paperTrade/status",     // read-only status page
  "/paperTrade/history",    // read-only history
  "/paperTrade/debug",      // read-only debug
  "/paperTrade/client.js",  // static asset
  "/paperTrade/export-csv", // read-only export
  "/result",                // read-only results
  "/result/all",
  "/auth/status",           // read-only auth status
  "/auth/zerodha/status",
  "/auth/zerodha/logout",
  // NOTE: /trade/start, /trade/stop, /trade/exit are intentionally NOT here — they require API_SECRET
  // NOTE: /paperTrade/start, /paperTrade/stop, /paperTrade/reset, /paperTrade/exit also require secret
];
app.use((req, res, next) => {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // no secret set → open (dev mode)
  const isOpen = OPEN_PATHS.some(p => req.path === p || req.path.startsWith("/auth/callback"));
  if (isOpen) return next();
  const token = req.headers["x-api-secret"] || req.query.secret;
  if (token !== secret) return res.status(403).json({ success: false, error: "Forbidden — missing or wrong secret." });
  next();
});



// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/auth",       require("./routes/auth"));
app.use("/backtest",   require("./routes/backtest"));
app.use("/result",     require("./routes/result"));
app.use("/paperTrade", require("./routes/paperTrade"));
app.use("/trade",      require("./routes/trade"));
app.use("/logs",       require("./routes/logs"));       // ← live log viewer

// ── Home — HTML Dashboard ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  try {
  const fyersOk     = !!process.env.ACCESS_TOKEN;
  const zerodhaOk   = zerodha.isAuthenticated();
  const zerodhaConf = !!process.env.ZERODHA_API_KEY;
  const liveEnabled = process.env.LIVE_TRADE_ENABLED === "true";
  const liveReady   = liveEnabled && fyersOk && zerodhaOk;
  const liveActive  = sharedSocketState.getMode() === "LIVE_TRADE";
  const activeStrategyName = getActiveStrategy().NAME;

  // Backtest default date range — last 30 days to yesterday
  const todayIST     = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const yesterdayIST = new Date(todayIST); yesterdayIST.setDate(todayIST.getDate() - 1);
  const monthAgoIST  = new Date(todayIST); monthAgoIST.setDate(todayIST.getDate() - 30);
  const backtestTo   = yesterdayIST.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const backtestFrom = monthAgoIST.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  // ── Dual broker connection panel ──────────────────────────────────────────
  const fyersCardBorder    = fyersOk   ? "#065f46" : "#9b2c2c";
  const fyersCardBg        = fyersOk   ? "#0a1f0a" : "#1a0808";
  const zerodhaCardBorder  = zerodhaOk ? "#1a4a7a" : (zerodhaConf ? "#9b2c2c" : "#4a5568");
  const zerodhaCardBg      = zerodhaOk ? "#080f1a" : "#0a0a14";

  const fyersBtnHtml = fyersOk
    ? `<div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:#0a2a0a;border:1px solid #065f46;border-radius:8px;">
        <span style="color:#10b981;font-weight:700;font-size:0.88rem;">✅ Connected</span>
        <a href="/auth/login" style="font-size:0.72rem;color:#4a6080;text-decoration:none;margin-left:auto;">re-login</a>
       </div>`
    : `<a href="/auth/login" style="display:block;text-align:center;background:#276749;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:0.88rem;transition:background 0.15s;"
        onmouseover="this.style.background='#2f855a'" onmouseout="this.style.background='#276749'">
        🔐 Login with Fyers
       </a>`;

  // ── 6 AM token expiry warning ─────────────────────────────────────────────
  const nowIST     = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const istHour    = nowIST.getHours();
  const istMin     = nowIST.getMinutes();
  const nearExpiry = istHour === 5 && istMin >= 45;  // 5:45–5:59 AM: expiring soon
  const pastExpiry = istHour >= 6 && istHour < 9;   // 6:00–8:59 AM: already expired

  const zerodhaExpiryHtml = zerodhaOk && pastExpiry
    ? `<div style="margin-top:8px;padding:8px 12px;background:#2d1800;border:1px solid #c05621;border-radius:6px;font-size:0.75rem;color:#f6ad55;">
        ⚠️ <strong>Token expired at 6 AM.</strong> Please re-login with Zerodha before starting live trading.
       </div>`
    : zerodhaOk && nearExpiry
    ? `<div style="margin-top:8px;padding:8px 12px;background:#2d1800;border:1px solid #744210;border-radius:6px;font-size:0.75rem;color:#fbd38d;">
        ⏰ <strong>Token expires at 6 AM</strong> — Re-login now if you plan to trade after 6 AM.
       </div>`
    : zerodhaOk
    ? `<div style="margin-top:8px;padding:6px 10px;background:#080d14;border:1px solid #1a3050;border-radius:6px;font-size:0.72rem;color:#4a7090;">
        ℹ️ Token valid until 6 AM. Re-login each morning before starting live trade.
       </div>`
    : "";

  const zerodhaBtnHtml = zerodhaOk
    ? `<div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:#080f1a;border:1px solid #1a4a7a;border-radius:8px;">
        <span style="color:#63b3ed;font-weight:700;font-size:0.88rem;">✅ Connected</span>
        <a href="/auth/zerodha/login" style="font-size:0.72rem;color:#4a6080;text-decoration:none;margin-left:auto;">re-login</a>
       </div>${zerodhaExpiryHtml}`
    : zerodhaConf
      ? `<a href="/auth/zerodha/login" style="display:block;text-align:center;background:#1a4a7a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:0.88rem;transition:background 0.15s;"
          onmouseover="this.style.background='#2a5a9a'" onmouseout="this.style.background='#1a4a7a'">
          🔐 Login with Zerodha
         </a>`
      : `<div style="text-align:center;padding:10px 16px;background:#1a1a2e;border:1px dashed #4a5568;border-radius:8px;font-size:0.78rem;color:#4a6080;">
          ⚠️ Add <code style="color:#a0aec0;">ZERODHA_API_KEY</code> &amp; <code style="color:#a0aec0;">ZERODHA_API_SECRET</code> to .env
         </div>`;

  // Panel status chips for the big panels
  const ptStatus  = `<div class="panel-badge" style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);color:#fbbf24;">📋 PAPER</div>`;
  const liveStatus = liveReady
    ? `<div class="panel-badge" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#f87171;"><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:#ef4444;animation:pulse 1.5s infinite;margin-right:5px;vertical-align:middle;"></span>LIVE READY</div>`
    : liveEnabled
      ? `<div class="panel-badge" style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);color:#fbbf24;">⚠ NEEDS LOGIN</div>`
      : `<div class="panel-badge" style="background:rgba(74,88,120,0.1);border:1px solid rgba(74,88,120,0.2);color:#4a5878;">🔒 DISABLED</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="icon" type="image/png" href="data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAFoAUcDASIAAhEBAxEB/8QAHQABAAIDAQEBAQAAAAAAAAAAAAcIBAUGCQMCAf/EAFMQAAEDAwEEBgQICAoHCQAAAAEAAgMEBREGBxIhMQgTQVFhcRQigZEyQlKCobGywRUjMzVidJLRFiQ0Q1NylKKzwhclVFZj4fEYRGRlc5Oj0uL/xAAbAQEAAgMBAQAAAAAAAAAAAAAABQYDBAcCAf/EAD8RAAIBAwEFBQUGBAYBBQAAAAABAgMEEQUGEiExQVFhcYGhE5Gx0fAUIjJCweEVIzayMzVScsLxFiU0U2KC/9oADAMBAAIRAxEAPwC5aIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgPm5zWNLnENaBkknAAX7BBGQchcLtBvoybRSv8AGocPs/v93esjZ/fuvYbVVO/HRj8U4n4Te7zH1eSr0doraWoux9em92fXXgSD06qrb2/p3dp2aIisJHhERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBc/rK+x2W1PeHA1EmRE3nj9L2fWtxW1UNHSSVNQ7cijbvOKhu8XOa/XqWslz1MZxG3sHcPZ9arG02s/YLfcpv78uXcu35d/gS2k2H2qpvT/BHn39x8A55D56hx6x5L3uceS/TZZYJI6uleWyxEPaW8yse4xSy0+7Fx48R3hfq3xyx0wZLzB4DuC5Gm199PjkuW7Hc3n7iXdLXmG9WtlSwgSABsrR2O/cVulC2m7tLp+9skGTSzHD2fWPvCmKCeKogZPC4Pje0Oa4ciCuwbOaytRt8Tf348+/sfz7+7BS9VsPstXMfwy5fLyPuiIrGRYREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBEWm1bc/wAFWGprAQJA3dj/AKx/dz9iw3FeFvSlVnyim35HulTlVmoR5vgcRtQv7qipFlon5ax2JC34z+72fXnuXy0tSW6GilhrLbU1cjJMb8UbnAcOI4Hnlc7YGOqK2a4Tet1YLhnvXX6PFe6iqDTV9PTDrfWbJGHEnHPmFyKVzUvr321RZcs8ODSSXLjhcOXin1LncUo2lsqEHjGMvisvyycttG1rpjSboaWPTc9VXzN3xDM50LWMyRvE5J4kHAA7F9tner9L6tp52DTlTT11OAZYIi6Ubp4BwORwzw4jgtdtj2b3vU9dDerfcbfVVsUQgkhc4Q7zQSQQckZ4ngcLI2N7PLxpP0q5VlzoIK2qjEXUsxKGMBzxdkDJOOXcpl2tL2WfZrP+2Ofl6meX8O/hqmqj9r/ulzzyx2Y64N1q+lt8lLEykt1RRuJdl0sZbnuxkrY7LNQOybNWO45PUk9h7W+36/NfPWTaxsVN6XW09SN526I4w3d4DnxK46qc+iroq2Fxa7eBJHYQoOlfVNP1H2kFjGOHBZWFlcG1x+PExUaEbyz9jJ5znD48/Mn5FrNO3Btzs1NWDGZGesB2OHA/Stmuw0K0a9ONSHJrK8ykzg4ScZc0ERFlPIREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAXC7YpC2w07BnDpuPu/5rulyu0ygdW6XlMeC+Bwk9nI/WofX6cqmnVVHsz7mm/RG/pc4wvKcpcskd2MBtinI5kDP7RX5X80tIJaeejJw5zSAPHmPvX4qZWU8ZfJkYOMdpK43cRbjBrvXq38Gi7ST9rKPXJ+ayZsEBfgF3Jo7yv7SytnhEgAHYR3FYktRHM0MqaeSNhPqv7khqmQsLYKeR0TTxf3+Kw+z+7jHEz+ye7jHE2CxbqAaJ3g4L7wSsmiEjDkFYl3f+LZC3i57s4Xmmnvo80k/aJEmbJnufpUB3Js7gPcF2S53Z/QOoNL0sbwQ+QGQg+PL6MLol3DRKcqen0Yy57q9Sg6hOM7qpKPLLCIilDTCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgC+UkbZGOY8BzXAgg8iCvqi+NJ8GCHNX6eq9P3b02ja59M92WEdn6J8frWqucsdeyOqphl7Xb0kXce1TjUQw1ELoZ42SRvGHNcMgrjrzoCinkM9vmdTSH4rskewjj78rnWrbKV4Sc7Nb0Xx3eq8O1evTiWqx1yDUVccJLhnt8SOpnPqIJ8xvazcyN8fGHcv6176dkY6p72dWMBg7e3K1111LZLXd66z112aJ6SV0Eu9E4t3hwOHAcV9LFqCz32/Udkt12aamrcWRYic1uQ0ni4juCpysLpz9l7N5z2MsrhNU99xe7zzh4xjny7OJl0zhR0pM3B73ZDBz8l0GhdM1F4uIuNfGW0kbs4PxsfFH3rqbJoK30rxNXSGqk544ge08z9C7CGOOGMRxMaxjRhrWjAAVx0bZKq6irXqwv8AT1fj0x8eXArV/rsd1wt+b5v5H0aA0AAAAcgv6iLoxVQiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiALV6ivNHYrVJcK5zhEwhuBzcScADK2iwbtb6K6W+Wir6aOqppB68bxkOxxH/AFWKspum1TeJdM8snuk4Ka3+XXHMprqHSd6rL/cKymvltlhqKmSZj5wWyEOcXesBkZ49hWVofTd2s+r7Vdq69W8U1FVxzyejDekcGnO63OBx5cT2r5ah1nW09zqKZ2gqa3dTK9nUmgmLm4OMOJfxI7wvtoHVVTXaho7a/Q8N1jqaqON7fQ5Q9rScHDg7DcDJyeHBUFU7/wBtu7y8cfT5nY5zuPsrzjGO1cvHkW8sN0pbxaoLlRuLoJgS3PMYJBB8iCtisW3UVLb6KKjo4I6enibuxxxjDWjwWUr/AElNQSm8vr4nG5uLk9zl08AiIsh5CIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAi5bVevdKaY3o7xeaeGcD+TsPWSn5jcke3Ci/UPSIt8e+yx2ConGOEtXMIm/styfpC1qt3RpcJSJSz0W+vFmjSbXbyXveESZtBJBosEj4fb5LVbFyTb7nkk/xhvb+ioD1Rty1Ld3s35LTQtjzuthiLyM+LifqXO27avqa2Ryx2/UctM2Vwc8RwM4nl2tVRUWtYd7zh6/hx8S40tmbt6e7eTipPv789heDI70VJ2batatORq2s+dCw/5VsqHbxreLnqKnmHdPRx/cArGtWpdYv68yMlsTfLlOL838i4yKrdr6RWp2gCporJWjtLd+Jx9ziPoXX2bpE2yUtbeNO1lMO2SlmbMPcd0rLDUreXXHiaFbZTU6Syob3g1/2Tqi4/S20bRupXNitt8p+vdyp5yYZc9wa7GfZldgtyE4zWYvJBVrerQluVYuL7GsBERezCEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREARFDu2fbDSaWE9nsT4am7NH46Z3rRUnn8p/6PZ29yxVq0KMd6bNyxsK99VVKhHL9F3s7fXeutPaNouuu9XmeQZhpYhvTS+TeweJwFW3aRty1DenS0tLUGzUR4CCkfmZ4/Tk5+wYHmoq1FqW4XaunqqirnqKiZ2ZaiV2ZHn7h4fUs7QGz7VWuaossNtfJA12JqyY7kEZ8XnmfAZPgoKteVrmW7DguxczpWn7PWGlU/bXLUpLq+S8E/i+PgaipvNRK5xiAZvHJcfWcT3krFgjrrlUiCnjqayc8o4mOkcfmjJVrNCdG7S9qZHUapq5r7VDBMLSYaZp7sD1ne0+xTLY7FZrHSils1ro7fDjG5TQtjB88Dj7Vko6XN8ZPHqa97tpa0nu0IuffyXz9CilNsw19Mxjzpa4U7JOLXVLRCD+2QfoW60zsR11f4pZaKC2xthcGP66sAIJGewFW32h86L5/3LV7Fvzfc/wBYb9lQ8Kjeruyf4V7/AMOTXntNdSsHcxik/N9cdpXZ/Rt2jtbkfgR3gK13/wBFrqzo/wC1CnaXNslLUgf0FfGT7nEK7iKyvTKPeQ0ds9QXNRfk/mef902YbQraHGr0beQ1vN0dOZW+9mVzMza63TmKdlTRyj4krXRu9xwvSbC114tFru9N6NdbdR18JGDHUwNkb7nArDPSov8ADI36G3FRP+dST8Hj45+J55wXepZgShsrfEYKkjZ/tk1Np50cNNc3VVK3A9DryXsx3NdnLfYfYpt1n0dtDXpr5bM2p0/VHkaY78JPjG7/ACkKv+0bYzrTRjZaqWiF0tjeJraEF4aO97PhM8+I8VpTs69u96PvRYbfWtL1ePsqmMv8sl8OmfB5LQbOdrmm9WOjopXutV0dgejVDhuyH/hv5O8jg+CkhebtDcZ6fA3usj+STy8irAbGduE9B1Vq1NPLWW0YYyqdl09N3b3a9n0jx5LbttT/AC1vf8yv6xse4J1bHiv9PXyfXwfHvZaJFi0VVTVtJFV0k8c8ErA+OSNwc17TyII5hZSmShtNPDCIiHwIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiKO9t+vYtEaVfJTysN0qw6Oka7juYHrSkdzfpJAXipUjTg5y5I2LW1qXdaNGksykcn0gdrLNO082nbBVAXJzcVdUw8aYEfAb/wAQj9kePKpdwrpq2YueTu5yG5zxPae8lfu73Ce5VslRNJJIXvLiXnLnOJyXHvJKs30c9i0dpgp9XatpQ+5uAkoqKVuRSjse8dsncPi+fKv/AMy+q5f/AEjqa+x7N2PHjJ++T+S9PF8ea2J7AJrnHBf9dRS09G7D4LXktklHYZTzY39EcT245Gz9uoaO20MVFb6aGkpoWhscMLAxjB3ADgFmIpyhbwoRxFHNtT1W51Kpv1nw6Lovrt5hERZyNOR2h86L5/3LV7Fvzfc/1hv2VtNofOj+f9y1exb833P9Yb9lUaH9Sv6/IWSP+Ty8v7iQkRFeSthERAEIBGCiICE9r+wWxaoZPddNshs16ILiGtxT1J/TaPgk/Kb7QVVG+Wm8aYvs1sutJNQV9M7D43js7CDyc09hHAr0aXAbYdm1p2h2A09QGU10p2k0NaG+tE75LvlMPaPaOKjbuwjUW9T4P4lv0LairaSVG5e9T7eq+a+l2ECdHvaw/TtYyz3eZxs07/XBOfRHE/lG/oH4w7Offm2sUjJY2yRua9jgC1zTkEHtBXnTfLVddM6gqrVc6d1LcKKQslYeI8CD2tI4g9oKtJ0Vtfi92U6Vr5QamiZv0ZceLogfWj8dwkY/RI7lr6dcuEvYz8vkSe1ejQq0/wCIW/8A+sdV/q+fdxJ3REU0c9CIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiA+UsjI43SSODWtBLnE4AA5lUV26a1l1jresqmSO9Djd1VM3PwYmk7vv4uPi7wVp+kXqI6c2VXSWNxZPWAUkRB4+vne/uhypJa6dlfd6emqKkU0c8wbLMWk9W0n1nYHE4GThQuqVsyVNeJ0LYqxUYTvJLjyXxf6LyaJy6KWzNl4rhre+U+/QUku7bonjhNM08ZCO1rDwHe7+qrYDHZhVYvO2+WzWimsOi6GCz2uiibBTy1IEk7mtGAd34LSeZ+EclcNV7X9XzzF79XXjJ/onbjfcAAlK+oW8NyCb7WL7Z/UtXruvWaguiby0vLhnt48y8OUVNdObc9ZW+Zub+K9gIzFXwhwd84YcPep22ZbYrJqyaK23CMWu7SYEbHP3opz3Mf3/onj3ZW5R1GjVe7yfeV/Udl76yg6mFKK5tdPFcGSoiIt4rpyO0PnR/P+5avYt+b7n+sN+ytptD50fz/uWr2Lfm+5/rDfsqjw/qV+H/Askf8AJ5eX9xISItHqvUdo0vaJLpeqptPTM4Dtc93Y1rebnHuV3lJRWXyK9TpzqTUILLfJI3i1N81BZLHFv3e7UVC3GR187WE+QJyVWTaRt6vtzkkprPM6x0J4NERDqmQd5d8Xyb7yobrr/UVE75iHSyuOXSzvL3u8yf3qJrarFPFJZ7y62GxVapFTup7vcuL9/JepdKs2y7O6Ylov/Xkf0NNK8e/dwseLbbs8kOPwvUR+L6KUD6lSl11rXH8qG+TQvyLnWj+fJ82hav8AE6/YvX5k0titPxhyl718j0E0nqzT2qYppLDc4a5sBaJdxrgWF2cZDgCM4K36rn0KaueqotU9cWnclpQCBj4sisYpm1qyq0lOXNnP9YsoWN7O3g21HHPnxSf6kFdK/Z62/aZdq23Qf6ztMZNQGjjPTcS7PeWfCHhvBVq2aalqNKayt15p3H8RO1zmg/CbycPa0ke1eglRCyeF8MrGvje0tc13EOB4EH2Lz82n6cOkdoN4sAa5sVLUk05PbC71oz+yQPYozUqO5JVY/TLpsff/AGmhOxq8Ulw/2vg14LPqegFDUQVlHDWU7g+GZjZI3Dta4ZB9xWSo26OF7N72Q2aSRxdNStdSPJ/4bsD+7uqSVL0p+0gpdpQby3dtcTov8ra9zCIiyGuEREAREQBERAEREAREQBERAEREAREQBERAVr6bdyLKTTdna4gSvmqHjv3Q1o+sqtVLO6ne6SMDfLcNJ+L4qeemy4nWen2Z4C3SHHnL/wAlEOzzS1drPV9Dp63nckqX5klIyIYm8XvPkOztJA7VW7xOdw19dDr+z0qdvpFOcnhJNt+bMfTGnNQ6ruZobHbKq51RwX9WODB3vceDR5kKVLd0Z9eVFMJaq4WKieR+SfPI9w8y1mPpKtBobStl0fYILPZKMU9PGPWceL5Xdr3u+M49/sHBdEpClpkEvvvLKpfbZ3M6jVqlGPfxb/RFG9ZbD9oOmqeSrltkVzpIxl81uk60tHeWEB+PIFcBb6+ekeN1xcwHO7nl5dxXpGq19KjZXR/g2fXen6VkE8J3rpBG3DZWE464AcnA43scwc8wc4LvTlCO9Dp0JPRNrZXFZULtJN8mu3sa7/pHadHLaI7V9jfabnUCW6ULAWyuPrVEPIOP6TTwPfkHtKmBUN2C6il07tQss/WFsM1S2CUdm7J6h+sH2BXyHJbmn1nUpYlzRXtqtNhZXm9TWIzWcdj6/PzOR2hc6L5/3LV7Fvzfc/1hv2VtNoXOi+f9y1exb833P9Yb9lVan/Ur8P8AgeI/5NLy/uO0utwpLVbam5V0rYaamidLK88mtaMkqkm2LaLcdX6klqnudHBGSylgzltPH97zzJ9nYFOfS91S606PorFTybstxlL5QDxMcfIHwLiD81Vu2Y6Or9daxprDRvMbXkyVVRjPUwj4T/E8QAO0kKc1GrKrUVGP0yxbJ2NG1tZahW65w30iub83w8PE+Gh9G6k1tdnUNgoJKuRpBmmcd2KEHte88B5cSewFdltP2X23Z1Z6Ft4vb7je6vMhgpmbkMMY4HifWcSeAPDkeCt/o/TVn0nYoLNY6RtNSQDgBxc93a95+M49pKp30mb5JeNrl3hyTFQvbSsGeA3G4P8AeLj7V4uLSNvRy+Mn6G3peuV9W1Bwp/dpRTfe+iy/0XZzI5pKaor66KkoaWSaonkEcMETS5z3E4DQOZKsTs66NDpqNldre5zQPeN70ChcN5ng+Ug8fBo9pW16IWgaeksrtd3GEPrKsuit+R+ShB3XPHi4gjPyR4lWJWxZWMXFTqcc9CN2h2nrQrStrR43eDfXPYuzHbzycjs+0DpnQlPVxaco5acVZYZ3SVD5S8tBDfhHhzPLvXXIilYxjFYisIotWtUrTdSpJtvqwqj9NC2Mp9fWm6xtx6dbyx573RPI+p49ytwq0dOFsfVaTd/Ob9WPZiP71qags0GT+ylRw1Sml1yvRv8AQ3XQprHS6EvFG45FPct4Du342n7lPqrp0Hz/AKg1OP8AxsP+GVYterH/AAImDaRJapWx2r4IIiLbIMIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAqr03KVw1LpysA9SSjmiz4tkaf8y/fQlo6R991LXvLTVxU0EUQPMMc5xcR7WtXX9M+zms2fW28RMLn22vAeQPgxytLSf2gxQd0e9ZM0Zr+KsqXOFBVR9RVgdjCc72O3dIB8gVB1mqN6pS5HSbCE77Zx0aX4kmvc84818S9KLHpZ4aqnjnp5GSwyND2PY7LXNPEEHtBWQpw5tyCwL3S01daK2hrg001RTyRSg/Ic0g/QSs9RV0idc02ldF1VugmAulxhdFEwH1o4zwdIe7hwHeT4FYq1SNODlLkbdja1Lq4hSpc2/d3+XMppYz1OoLeY3kiOti3Xd4EgwV6QDkvPHZtaZL5tBsFqiaSai4Qh2OxoeHOPsa0lehw5KO0pPdk/AuG3M06lGPXDfvx8jkdoXOi+f8ActXsW/N9z/WG/ZW02hc6L5/3LV7Fvzfc/wBYb9lV2n/Ur8P+BDx/yaXl/cV96Y1xdVbUaeh3vUordGAPF7nOP3KROhhp6Kl0dctSyRj0i4VRgjcRxEUXd5vLvcFE3SuOdttzB7KWlH/xqxnRhbE3Yfp7qsZLZi/+t1z8qwW63ryTfTPyJ7Vqjo7PUIR5S3U/dvfEk1ee21t7nbTtVvzk/haqwfKRy9CexUG2722S2bYNUU0jS3rK51QzPa2UCQH+8veqr7kfE1Nh5JXVSPXd/X9y6+zilpqLQVgpaPd6iO204ZjtHVt4+3n7V0SiXoxath1Ds4pLbLKDX2ljaeRpPEx/zbvLHq+bVLS36E1Upxkuwq2pW9S3u6lOpzTf/fmgiIsxpBVL6aV1ZU62s9pjfveg0TpJB3Okdy9zB71aHUN3obDZ6q7XKYQ0tMwvkd9QHeSeAHeVQbaRqKo1TrW5Xyq4PqJiQ3OQxo4BvsGB7FF6nVSgodX9fEuexljKpdSuWuEVjzf7Zz5Fi+hPSOj0Xfawj1Zrk1jT37kTc/aVgVGnRpsL7Dsds8c7Cyeta6ukBH9Kct/ubqktblpFxoxT7CB1yuq+oVprlnHu4foERFsEUEREAREQBERAEREAREQBERAEREAREQBERAaXWFiotTaYuNgrwfRq6B0LyObc8nDxBwR5KgeqrDddI6nq7LdIzDW0UmCccHj4r297XDiP+q9FlHm1/ZfZdolqa2pHod1gaRSV7G5czt3HD4zCezs5ghaF9ae3jmPNFm2b1xabUdOr/hy59z7fmV02T7Yr3paFtExzK2gByaGocRud5ifzb5cR4KaKDpCaUkgDqy1Ximl7WMYyQew7w+pVs15su1po2ok/ClnmmpGn1a6kaZYHDvyBlvk4Bce2tnjG62rc3HZv8lERubi3+5nyZeq2jaXqv89JPPWL5+OOH6lpNXdIgeivj07aHQOIwKqvcMN8Qxp4nzPsVctYajuGobpNWV1XNVzSu3pJpD6zz2cOwDsA4Ba+3UdzvVY2lt9LV3KoccNjgjdK4+xuVO+yHo7XCrqoLrryP0SiaQ5ttY/Ms3hI4cGN7wDk+C+r7ReSWePwQ3dL0Cm5LEX75Pu7f0M/ofaBnbUy69ucBZHuOgtYcPh54SSjwx6oPblys4sekp4KSmjpqaJkMETAyONjQ1rGgYAAHIALIJwp+3oqjBQRy/VNRnqNzKvPhnkuxdF9dTkdoXOi+f8ActXsV/kF0/WG/ZWbriqpqk0op6iGYsLw8MeHbvLnjksLYr/ILp+sN+yqZT/qV/X5CUimtHkn3f3FdumBQPpdrvpRHqVtugkae/dL2H7IUp9DS/R1mgq2xPf+Pt1W57Wk8erk4/aDvesPpoaZfV6atWqaePedbpjT1JA5RS43SfAPAHz1CWwrWkmitbwVzt51JKOqqo283xnngd4wHD+rjtU5Of2e83nyfwf7lnoUP4ts/GnDjKK4eMenmviXxVZumVoqVxodc0MJcxjBR3DdHwRk9VIfDJLSfFqsdb6umuFFDWUkzJ6edgfFIw5a9pGQQvzdaCiu1sqbdcKeOppKmMxTRPGWvaRggqWuKKr03Eoul389Nu41kuXBru6r66lCNmmsLno+/wAVwt1QIpGnGHnLJGnmx47WnHsIBVu9C7XtJ6kp2R1VZHZ7gRh9NVvDWk/oPPquHuPgq27bNjl30LWzXC3RTXDTr3ZjqWjefTA/Elxyx2P5HtwVHFJcqiBgZkSR9jXcfpUFTrVrOTj6M6Zdabp+v0Y14vj0kufg1+j4nor+EqDqut9Npurxnf61u778rktU7U9FaejeJrxDW1DRwp6JwmeT3cDut9pCpD+GvVx6K3y3uH1LHnutVI0sZuxN7mDj71nlqtRr7sUiLo7D28ZZq1XJdiWPmSVtn2r3XWE4piPQ6CJ29BRsfndPy5D8Z3d2Ds7zzexnRFTrzXNJagx/oEThPcJRyZCDxGe93wR5k9hXw2b7PNT69uQp7JRu9GDsT10wIgh78u+Mf0Rk+XNXP2X6Fs+z/TTbTa2mWV5D6ureAJKiTHwj3Acg3kB7SfFrbVLmp7Spy+Jtaxq1ro1r9ltcKfRLp3vv+L4nWU8UcELIYmNZGxoa1rRgNA4ABfZEVgOWBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAwuc1FbdHUtNLcr7brHFEzi+oq6eLA9rhzW4r6yCgoZ66rkbFBTxulleeTWtBJPuCpLtg2lXDV2oZaiRzhSxOIo6Uu9SBnYSO15HEn2cgtK8uo0Irhlsn9A0erqVV7st2Meb/RfXAse3bFsytUhpbfK9kQOC6ktzmx/QBn3LsdJ610xqhjvwJeKerkYMuh4slaO8sdg48eSoC65VpOevI8AAFsLLqOvt1fDVxzyQzwuDo54TuyRnvBCjYapVi/vJNFvuNi7ScH7KpJS7Xhrz4I9E1Xnpe62udmhtumrbNJTsrYnz1LmEgvYDuhmRxxnJI7eCkrYrrT+G2iYbjOY/Tqd3UVW5wDngAh4HYHAg478hR50stnl51LS27UdipZq2e3xvgqaWIb0jonHeD2N+MQc5A44PDkpG5k6ts5U+pVNFows9XjSu8LdbXHlnHD9is9l1HdbTcY66kqDHLG7ILRj2cOY8Crl7AKwV+nKmtAwKh0UuO7eZlU5smkdR3i5MoKS0VrZHO3XPmgdGyPvLnOAAA96uHsGpobVpiqpXStEVKYousccDDWYzx5KtWvs1qVFL8X3vdhlw2tnCVk915fD3ZR3Wp7NQ6g0/XWS4x9ZSVsLoZW9uCOY8RwI8QFQXXml7ponVtZYrkCJ6V+YpgMCaMn1JG+BHuOR2L0Co7lQVhLaSupahw5iKZryPcVxO2jZna9olhEUjm0l2pQTRVgbncJ5sf3sPaOzmPGy3tt7eOY80VLZzWXpld0634Jc+59vz9/QgLYdtiq9LxC2XGN9bai7LoWn8ZTk83R54Fp5lp7eWO2zuldaaZ1PTiWy3emqHkcYS7dlb5sPrD3KiGr9L6g0de3Wy+UMtFUsOY3c2St+VG7k4eXtwsekvU8TmmRu85vwXtO64e1RVC9rW/wBxrKXR8y5als3Zao/b05bspccrin34/VHotIxj2Fj2hzXDBBHAjuUYat2E7O9QzvqfwXJaql5JdJbpOqBPeWYLPoVarJtX1VbGNZSaou8LG8mSyda0ex28umpdvutmMDXX2hmx/S0bM/QAtuWpUKixUg/Qg6eymqWk961rJebX6MkH/st6Z67P8Jr31XydyHPv3fuXT6b6P+zizSCeW21N3lbxBuE5e3P9RoDT7QVEg6Qms8fy2ynx9F//AEsefpAa1cDu3i2Rf+nRtP15WON1ZReVD0/c2Kmk7RVVuyrrHjj4ItnRUtLRUkdLR08VPBGN1kUTA1jR3ADgFlKBujXry+6y1HfI7xeJK9sFLE+NhjaxjCXuBIDQO5Typa3rKtBTisFK1KwqWFw6FVpyWOK71nqERFmNAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgIu6Tt3dZ9kFzMRAfVyRUwPg52T9DSqibONLVettaUOnqaTq3VLy6aYjPVRNGXvx2nHLvJCs30zXluyuiYDwdd4c+yOQqO+hTSMk15e61zQXQWxrGE9m/KM/YULdQ9rdxi+XA6Jold2Og1biH4sv38EidbHsi2dWq1C3x6Vt9U3dw+asiE0sh7y93HPlgdyrx0m9l9t0TV0N60/E+C1V8joX05cXCnlA3huk8d1wB4HOC09hVx1EPS2ohV7GaybGTR1dPOD3evuH6Hlbl3bwdF4XIr+g6tdR1Cnv1G1J4abzz/cjfoU3d7b3frG53qSU0dSwHva/dP0PVplS/oiVLodsUMIOBUW+oYfHG67/ACq6C86a80PMybYU1DUnL/Uk/wBP0I7203qm09ZIbjU+sGbzY4wcGR5xho/f2DKqJqLWFXXyyMmqJZoy/e6ljyIWnwHI+amzpr3OWGHTlticQJfSJXY8Nxv3n3qJtiOy+u2j3eojFV6DbKMN9Kqdzedl3wWMHIuIBOTwA7+AUHcWKnf1JpZlLHwRadnfYWWlRuqzwuLz2cWlg5eiv8lNUNmijdTyMOWyQSFr2nvBGFZvo67VanUc/wDBq+VPpVV1ZdR1TvhyBoy6N/e4DiD2gHPeeW2mdHOhtGlau8aYu9dNUUUDp5aas3HCVjRl265oG67AJAOQeXBRRsKrX0e1zTL43kNluMUbsdocd371s04VbStFcs+5mzd1LHXbCpKnxcU8PGGmlleTLw6m09ZNS2x9vv1rprhSu49XMzOD3tPNp8RgqDdY9GG01Lnz6Vvs9vJ4imrGddH5B4w4Dz3lYockU7Vt6dX8aOa2Oq3di/5E2l2c17nwKU3no9bS6B7/AEe30NzY3k+lrGjPsfulR1qDT94sFwmoLxQvpKmDAljc5rt0kZAJaSM+Cujt02gxaI02Y6Z7Dd6xrm0wPHqmj4UpHcOwdp8iqUXi4z3Ksknnke8ueXkvOXOcTxc49pKgbylSpT3KfPr9dp03Z2/vr+i61yko9MJ5ffzxgwlsdP2G9agrPQ7Haq25TjmymhL93zI4N9pCnHYr0fpbtBBftbtmpqN4D4La0lksrewynmxp+SPW7yOSszYbNa7Jb2W+0W+moKWMerFAwMaPHA5nxPFZrfTp1FvT4I09V2uoWsnSoLfkvcvn5cO8hPot7OtWaMud3uOo6CKjjraWKOJnXte/LXEnIbkDge9T+iKZo0Y0YKETneoX9S/ruvVSTeOXLhw7wiIsppBERAEREAREQBERAEREAREQBERAEREAREQBERAEREBB/TNiL9lVHIP5u7wk+1kgUb9CurEW0K8UjnYNRa95o7yyVv3OKmTpTW81+xa8PYMupHw1Q8myDP0EqtHRyvLbLtgsssjg2Kpe6kkJPDEg3R/e3VDXL3LyMn3HQdGh9p2frUlzW98E0XrUddJGMS7EdTtIzima/wDZlYfuUijko+6Rbg3Ypqgn/Yse97QpSv8A4UvBlM0z/wB7R/3R+KKx9Fd27txtA+VDUg/+y5XdVC9g1/t2mdqdsvV1dK2kgZOHmOMvd60TmjgPEq0Q276A/wBouX9ico3T7ilTpNTkk8lu2s027uryM6NNyW6llLPHLIm6bUmdUaci+TQzO98jR9y6roTNxoq+vx8K5D6ImqK+k7rGz6y1Xaq2yPnfBT0Bif1sRjO8ZCeR8MLq+jLtE0zo3R9wo71LVsnqK4ysEVOZBu7jRzHktdVoK9U88M8/I37ixuXs9G3UHv8ADhjj+LPIspqyPrdLXaL5dFM33xuVCtkrtzaVpR3ddaT/ABGq11224aDqLXV07Ki470sD2NzRO5lpCqdsv9XaLpjwutJ/itWS9rU6lSG48mLZmyuLW1uFXg45XDKx0Z6HDksO4VtPb6Cor6yRsVPTxulleeTWtBJPuCzByUGdLXWQs+lIdOUsuKq4nfmAPEQtPAfOcPc0qVuKyo03NlH0yxlf3UKEer49y6v3FdtrmsavWGsK25TFzY3v3YoyfycYzuM9g4nxJUpdFTZdFdJG651BTdZSQSYtkEjfVlkaeMxB5hp4N8QT2BRBsy0nV621vb9P05c1tRJv1Mw/moW8Xv8APHAeJCv3aKCjtVsprZQQsgpaWJsMMbRwaxowB9CiNPt/azdWf0y+7UamrC2jZW/BtdOkeXr8MmcOCIinTmgREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQGo1daYr9pi6WWXd3a6llpzns3mkA+wkFeeUJqrVdW7+9DVUc+HdhY9jsH3EL0kVKOlNpJ2nNp1RcIYi2hvYNZEQOAl5St897DvnqK1SlmKmuheNir1QrTtpfmWV4rn6fAtrs71BBqnRttvcJaTUQjrQPiyDg8ftArl+kw4t2H6kwQMxRA57jMxQx0UtoUdouL9LXWfcoqyQdQ954RTch5Bww3zA71aG8W6gu9vkt90oqetpZcdZDPGHsdg5GQeBwQCtihV+00Gs8cYZEahZvR9UjJr7ikpLvWc48VyPOSKV8MnWRP3XDkQvv8AhGt/2l30K/H+jfQH+5dg/sEf7k/0b6A/3LsH9gj/AHLQelTf5kWj/wA4t/8A4n6FAZ55Z3B00heQMAlfqCsqIGbkUxY3OcDCuvrfQeiaX0T0fSdki3t/e3KJgzy7gtZsn0Ro2uorg+t0vZqhzJ2hplo2OwN3kMhQ6qJ6h9gxx7enLJvraii7V3O48Lpw7cFPzcK0jBqHYPktvswGdpOmR/5vS/4rVeH/AEb6A/3LsH9gj/cv3R6A0PS1UVVS6RscE8LxJHJHQxtcxwOQQQOBBUzDS5xknvIjK22tvUpyj7N8U1zRvLpX0drttRca6VsFLTRullkceDWjiSqGbW9WVOsNa112m3mse/EUZP5Ng4Nb7Bz8SVLnSa2pR3Av0vY5w6iik/jMrDwnlafgg9rGn3u8uMP7K9HVeudcUVhg3xDI7rayYD8lA0+u7zPIeLgvF7X9vUVOHJer/Yz7M6ZHTbaV7c8G116R+b9+MeBYnofaOFp0lUasrIt2ru53KbPNtMw8D852T5BqntYlvpKa30EFDSRNgp6eNsUUbeTWtGAB5ALLUzRpKlTUEUDUb2V9czry6v3LovcERFlNIIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAo+256Ej17oaot0YY25Ux9It8jjjEoB9UnucMtPmD2KQUXicFOLjLkzNb3FS2qxrU3iUXlHm230q13GSKeGSGogeY5oZBhzSDhzSOwgj6FZ/YlttpJaCCy6tqizcAZT3F/EEdjZu4j5fI9veczpGbGjqfrNU6Xga29tb/GqZuGitaBwI7BIBw48HDhzwqqNdWWyslhkjkp54nFk0MrC1zXDm1zTxBVflGrZVcx/ZnVqU7HaOzSnzXvi+7u9GejlNPDUwMnp5Y5YnjeY9jg5rh3gjgVkKhOkNol9084fgm71ttGcmNj96Fx8WHI+hSTZ+kPqyFgbUfgW4fpPiMbj+y4D6FvU9WptffTXqVW52KvIP+TNSXufy9Sf9oXOi+f8ActXsW/kF0/WG/ZUL3vbtd7oyLrbPaozHnBbM85z7fBc9QbY9SWelqILZWW6iE7w9zmwiR4OMcN4kfQq3HK1p3n5PX8OOXiSFLZy+enu2aSk8deHPPTJcC4VlJQ0klXW1MNNTxjL5ZXhrGjxJ4Kuu3HbZBU0M1l0rPI2lcCyorm5a6YdrIu0NPa7mezhxMLap11eL7N1tzudbc3g5b6RIdxvk3kPYAubpobjeblDSUsE9bW1DgyGCFhc557mtCmbjUZ1luwWF6m7pWyVCykq1zJTkuP8A9V39/nhdx/GtrLtcoqengkqKmd7YoIIm5c5xOGtaO9XW2BbNodn+lv40I5L3XbsldK3iGY+DE0/Jbk+ZJPctF0fdjkOi4GX6/wAcVTqKVmGNGHMomnm1p7Xntd7BwyTNS3bCz9kt+fP4EDtPtArx/Zrd/cXN9r+S9eYREUmU4IiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiALgto2yzSGummW7UBhuG7hlfSkRzjuBOMPHg4H2LvUXmcIzWJLJmoXFW3mqlKTi11RUjVnRm1VRPfLp660F2gz6sc2aeb6ctPvCj+5bI9pNA8sn0bdJMdtOxsw97CVfdMLQnplGXLKLRb7Z39NYqKMvFYfpw9Dzxn0PrKBwbPpO9xF3LfoZG594Wx01st17qFzhbNOVLmscGvfM9kTWnxLiFdDaD/ANy+f9y1WxT+QXT9Yb9lVyNTOrOxf4e3r+HJOPaivKwdzGCT4drXPBCWkejFfal7JdT3ykt8PN0NG0zSnw3iA0f3lPuz3ZzpLQ1Pu2G2tZUvbiWsmPWTyebzyHgMDwXZIrXRtKVF5iuJTL/Xb6/W7Vn93sXBfv55CIi2SICIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAh4DvREBTjVW3TVFVd6iGp6ikFPPIxtO6kG9Fh2N0knJIx2r67MNseoKXU1Ba6SOOriuFbFHLTtphvybxDfVIOQQDn2KRtrTWUeuat9zpIxFUNY+nnMIIe0NAIzjmCDnzWTsXZ6XrL0i3UrBS08D/SJxEGjLhhrQcc88fIKgQuv/AFX2fs3v72N7rjln3eh0+dzZLTHNUI7rjnHTPjjt9ScxyREV/OYBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAYdxoqOup+orqSCpizncmjD258iv1RUdLRU4go6aGniHJkTAxo9gWUi8ezjvb2OJ93pY3c8AiIvZ8CIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiAIiIAiIgCIiA//9k="/>
  <title>Palani Andawar thunai — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; min-height:100vh; overflow-x:hidden; }
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

    /* ── NAV ── */
    nav { display:flex; align-items:center; justify-content:space-between; padding:10px 24px; border-bottom:1px solid #1a2236; background:#0d1320; position:sticky; top:0; z-index:100; }
    .brand { font-size:0.92rem; font-weight:700; color:#fff; white-space:nowrap; }
    .brand span { color:#3b82f6; }
    .nav-links { display:flex; gap:4px; }
    .nav-links a { font-size:0.76rem; color:#6b7a99; text-decoration:none; padding:6px 12px; border-radius:6px; border:1px solid transparent; white-space:nowrap; }
    .nav-links a:hover { color:#c8d8f0; background:#161b22; border-color:#1a2236; }
    .nav-links a.active { color:#3b82f6; background:#0a1e3d; border-color:#1d3b6e; }

    /* ── PAGE WRAPPER ── */
    .page { max-width:960px; margin:0 auto; padding:28px 24px 48px; display:flex; flex-direction:column; gap:12px; }

    /* ── SECTION CARD ── */
    .card { background:#0d1320; border:1px solid #1a2236; border-radius:12px; overflow:hidden; }
    .card-hdr { display:flex; align-items:center; gap:8px; padding:14px 18px 12px; border-bottom:1px solid #1a2236; }
    .card-hdr-icon { font-size:0.88rem; }
    .card-hdr-title { font-size:0.62rem; font-weight:700; text-transform:uppercase; letter-spacing:1.8px; color:#4a6080; }
    .card-body { padding:16px 18px; }

    /* ── BROKER GRID ── */
    .broker-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .bk { border-radius:9px; padding:14px 16px; border:1px solid; }
    .bk.ok-green  { background:#06100a; border-color:#0d3a18; }
    .bk.err-red   { background:#120609; border-color:#3a0d12; }
    .bk.ok-blue   { background:#060c18; border-color:#0d2040; }
    .bk.no-conf   { background:#0c0c14; border-color:#252540; }
    .bk-top { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
    .bk-name { font-size:0.88rem; font-weight:700; color:#e0eaf8; }
    .bk-badge { font-size:0.52rem; font-weight:700; padding:2px 7px; border-radius:3px; text-transform:uppercase; letter-spacing:0.8px; }
    .bk-badge.ok-g  { background:#072014; border:1px solid #0e4020; color:#34d399; }
    .bk-badge.ok-b  { background:#071428; border:1px solid #0e2850; color:#60a5fa; }
    .bk-badge.err   { background:#200710; border:1px solid #400e20; color:#f87171; }
    .bk-desc { font-size:0.67rem; color:#3a5070; line-height:1.5; margin-bottom:10px; }
    .bk-btn { display:flex; align-items:center; justify-content:space-between; padding:7px 11px; border-radius:7px; font-size:0.75rem; font-weight:600; text-decoration:none; cursor:pointer; font-family:inherit; border:1px solid; width:100%; }
    .bk-btn.g { background:#06180e; border-color:#0a3018; color:#34d399; }
    .bk-btn.b { background:#0a1e3d; border-color:#1d3b6e; color:#fff; text-align:center; justify-content:center; }
    .bk-relogin { font-size:0.62rem; color:#2a4060; }

    /* ── BACKTEST BAR ── */
    .bt-bar { display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; padding:16px 18px; }
    .bt-f { display:flex; flex-direction:column; gap:3px; }
    .bt-f label { font-size:0.52rem; font-weight:600; text-transform:uppercase; letter-spacing:1.2px; color:#3a5070; }
    .bt-f input, .bt-f select {
      background:#fff;
      border:1.5px solid #3b82f6;
      color:#0f172a;
      padding:5px 8px;
      border-radius:6px;
      font-size:0.78rem;
      font-family:'IBM Plex Mono',monospace;
      outline:none;
      cursor:pointer;
      color-scheme:light;
    }
    .bt-f input:focus, .bt-f select:focus { border-color:#2563eb; }
    .bt-run { background:#3b82f6; border:none; color:#fff; padding:7px 18px; border-radius:7px; font-size:0.8rem; font-weight:600; cursor:pointer; font-family:inherit; white-space:nowrap; align-self:flex-end; transition:background 0.15s; }
    .bt-run:hover { background:#2563eb; }
    .bt-strat { margin-left:auto; font-size:0.72rem; color:#3a5070; align-self:center; white-space:nowrap; }
    .bt-strat strong { color:#3b82f6; }

    /* ── TRADE STATUS PANELS ── */
    .ts-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:0; }
    .ts-cell { padding:12px 16px; border-right:1px solid #1a2236; }
    .ts-cell:last-child { border-right:none; }
    .ts-label { font-size:0.52rem; font-weight:600; text-transform:uppercase; letter-spacing:1.4px; color:#3a5070; margin-bottom:5px; }
    .ts-val { font-size:0.95rem; font-weight:700; color:#e0eaf8; }
    .ts-val.pos { color:#4ade80; }
    .ts-val.neg { color:#f87171; }
    .ts-val.flat { color:#3a5070; }
    .ts-sub { font-size:0.62rem; color:#3a5070; margin-top:2px; }
    .ts-pos-bar { margin:10px 18px 0; padding:10px 14px; background:#0a0f14; border:1px solid #1a2a3a; border-radius:8px; display:flex; flex-wrap:wrap; gap:10px 24px; }
    .ts-pos-item { font-size:0.68rem; color:#3a5878; }
    .ts-pos-item strong { color:#a0c0e0; font-weight:600; }
    .ts-pos-item.pnl-pos strong { color:#4ade80; }
    .ts-pos-item.pnl-neg strong { color:#f87171; }
    .ts-flat-note { font-size:0.72rem; color:#2a3a50; font-style:italic; }
    @media (max-width:640px) { .ts-grid { grid-template-columns:1fr 1fr; } }

    /* ── ACTIVE CONFIGURATION ── */
    .cfg-grid { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:0; }
    .cfg-cell { padding:16px 18px; border-right:1px solid #1a2236; }
    .cfg-cell:last-child { border-right:none; }
    .cfg-label { font-size:0.52rem; font-weight:600; text-transform:uppercase; letter-spacing:1.5px; color:#3a5070; margin-bottom:6px; }
    .cfg-val { font-size:1rem; font-weight:700; color:#e0eaf8; margin-bottom:3px; }
    .cfg-sub { font-size:0.65rem; color:#3a5070; }
    .cfg-val.disabled { color:#ef4444; }
    .live-note { margin:0 18px 14px; padding:10px 14px; background:#0a0a14; border:1px solid #252540; border-radius:8px; font-size:0.7rem; color:#3a5070; }
    .live-note code { color:#a0b0c0; font-family:'IBM Plex Mono',monospace; font-weight:600; }

    /* ── MOBILE ── */
    @media (max-width:640px) {
      nav { flex-wrap:wrap; gap:6px; padding:8px 14px; }
      .brand { font-size:0.82rem; }
      .nav-links { flex-wrap:wrap; gap:3px; }
      .nav-links a { font-size:0.7rem; padding:5px 8px; }
      .page { padding:14px 12px 40px; gap:10px; }
      .broker-grid { grid-template-columns:1fr; }
      .ts-grid     { grid-template-columns:1fr 1fr; }
      .cfg-grid    { grid-template-columns:1fr 1fr; }
      .cfg-cell    { border-right:none; border-bottom:1px solid #1a2236; }
      .cfg-cell:nth-child(odd) { border-right:1px solid #1a2236; }
      .cfg-cell:last-child { border-bottom:none; }
      .bt-bar { flex-direction:column; align-items:stretch; }
      .bt-strat { margin-left:0; text-align:center; }
      .bt-run { align-self:flex-start; }
    }
  </style>
</head>
<body>

<nav>
  <div class="brand">🪔 Palani Andawar thunai — <span>Trading BOT</span></div>
  <div class="nav-links">
    <a href="/" class="active">Dashboard</a>
    ${liveActive
      ? '<span title="Disabled — Live trade is running" style="font-size:0.76rem;color:#2a3446;padding:6px 12px;border-radius:6px;border:1px solid transparent;cursor:not-allowed;opacity:0.38;white-space:nowrap;">🔒 🔍 Backtest</span>'
      : '<a href="/backtest">🔍 Backtest</a>'}
    ${liveActive
      ? '<span title="Disabled — Live trade is running" style="font-size:0.76rem;color:#2a3446;padding:6px 12px;border-radius:6px;border:1px solid transparent;cursor:not-allowed;opacity:0.38;white-space:nowrap;">🔒 📋 Paper</span>'
      : '<a href="/paperTrade/status">📋 Paper</a>'}
    <a href="/trade/status">🔴 Live</a>
    <a href="/logs">📜 Logs</a>
    ${liveActive ? '<span style="display:flex;align-items:center;gap:5px;font-size:0.68rem;font-weight:700;color:#ef4444;background:#2d0a0a;border:1px solid #7f1d1d;padding:3px 10px;border-radius:5px;white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:#ef4444;display:inline-block;animation:ltpulse 1.2s infinite;"></span>LIVE ACTIVE</span><style>@keyframes ltpulse{0%,100%{opacity:1}50%{opacity:.25}}</style>' : ""}
  </div>
</nav>

<div class="page">

  <!-- ① BROKER CONNECTIONS -->
  <div class="card">
    <div class="card-hdr">
      <span class="card-hdr-icon">🔌</span>
      <span class="card-hdr-title">Broker Connections</span>
    </div>
    <div class="card-body">
      <div class="broker-grid">

        <div class="bk ${fyersOk ? 'ok-green' : 'err-red'}">
          <div class="bk-top">
            <span style="font-size:1.1rem;">📊</span>
            <span class="bk-name">Fyers</span>
            <span class="bk-badge ${fyersOk ? 'ok-g' : 'err'}">${fyersOk ? 'CONNECTED' : 'DISCONNECTED'}</span>
          </div>
          <div class="bk-desc">Data · WebSocket · REST quotes · Historical candles<br>Used by: Backtest · Paper Trade · Live Trade</div>
          ${fyersOk
            ? `<div class="bk-btn g"><span>✅ Connected</span><a href="/auth/login" class="bk-relogin">re-login</a></div>`
            : `<a href="/auth/login" class="bk-btn" style="background:#1a4a2a;border-color:#2a6a3a;color:#fff;text-align:center;justify-content:center;">🔐 Login with Fyers</a>`}
        </div>

        <div class="bk ${zerodhaOk ? 'ok-blue' : zerodhaConf ? 'err-red' : 'no-conf'}">
          <div class="bk-top">
            <span style="width:17px;height:17px;background:#7c3aed;border-radius:50%;display:inline-block;flex-shrink:0;"></span>
            <span class="bk-name">Zerodha</span>
            <span class="bk-badge ${zerodhaOk ? 'ok-b' : 'err'}">${zerodhaOk ? 'CONNECTED' : 'DISCONNECTED'}</span>
          </div>
          <div class="bk-desc">Orders · Live Trade only · Free Personal API<br>Used by: Live Trade only</div>
          ${zerodhaOk
            ? `<div class="bk-btn g" style="background:#06100e;border-color:#0a2820;"><span style="color:#60a5fa;">✅ Connected</span><a href="/auth/zerodha/logout" class="bk-relogin" style="color:#ef4444;" onclick="return confirm('Clear Zerodha token? You will need to login again.')">logout</a></div>`
            : zerodhaConf
              ? `<a href="/auth/zerodha/login" class="bk-btn b">🔐 Login with Zerodha</a>`
              : `<div style="padding:7px 10px;background:#0c0c18;border:1px dashed #252550;border-radius:7px;font-size:0.7rem;color:#3a4060;text-align:center;">Add <code style="color:#6070a0;font-family:monospace;">ZERODHA_API_KEY</code> to .env</div>`}
        </div>

      </div>

      <!-- Hard Reset -->
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #1a2236;display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:0.67rem;color:#3a5070;">⚠️ Socket stuck or tokens in bad state? Hard reset clears all tokens &amp; restarts the Node process (PM2 auto-revives).</span>
        <button onclick="hardReset()" style="background:#1a0808;border:1px solid #5a1010;color:#f87171;padding:6px 14px;border-radius:7px;font-size:0.75rem;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;margin-left:16px;">🔄 Hard Reset</button>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-hdr">
      <span class="card-hdr-icon">🔍</span>
      <span class="card-hdr-title">Backtest</span>
    </div>
    <div class="bt-bar">
      <div class="bt-f">
        <label>From</label>
        <input type="date" id="bt-from" value="${backtestFrom}"/>
      </div>
      <div class="bt-f">
        <label>To</label>
        <input type="date" id="bt-to" value="${backtestTo}"/>
      </div>
      <div class="bt-f">
        <label>Candle</label>
        <select id="bt-res">
          ${["3","5","15","60"].map(v => `<option value="${v}"${String(process.env.TRADE_RESOLUTION||"15")===v?" selected":""}>${v}-min</option>`).join("")}
        </select>
      </div>
      <button class="bt-run" onclick="runBT()">🔍 Run →</button>
      <span class="bt-strat">Strategy: <strong>${ACTIVE}</strong> · Opens in new tab</span>
    </div>
  </div>

  <!-- ③ PAPER TRADE STATUS -->
  <div class="card" id="paper-status-card">
    <div class="card-hdr" style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="card-hdr-icon">📋</span>
        <span class="card-hdr-title">Paper Trade</span>
        <span id="paper-run-badge" style="display:none;font-size:0.6rem;font-weight:700;letter-spacing:1.2px;padding:2px 8px;border-radius:4px;background:#0d3018;color:#4ade80;border:1px solid #166534;">RUNNING</span>
        <span id="paper-stop-badge" style="display:none;font-size:0.6rem;font-weight:700;letter-spacing:1.2px;padding:2px 8px;border-radius:4px;background:#1a1a2e;color:#3a5070;border:1px solid #252550;">IDLE</span>
      </div>
      <a href="/paperTrade/status" style="font-size:0.72rem;color:#c89828;text-decoration:none;padding:5px 12px;border-radius:6px;border:1px solid #3a2a00;background:#120e00;white-space:nowrap;">Open Paper →</a>
    </div>
    <div id="paper-status-body" style="padding:14px 18px 16px;">
      <div style="color:#3a5070;font-size:0.75rem;">Loading…</div>
    </div>
  </div>

  <!-- ④ LIVE TRADE STATUS -->
  <div class="card" id="live-status-card">
    <div class="card-hdr" style="display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="card-hdr-icon">🔴</span>
        <span class="card-hdr-title">Live Trade</span>
        <span id="live-run-badge" style="display:none;font-size:0.6rem;font-weight:700;letter-spacing:1.2px;padding:2px 8px;border-radius:4px;background:#2d0a0a;color:#ef4444;border:1px solid #7f1d1d;animation:ltpulse 1.2s infinite;">LIVE</span>
        <span id="live-stop-badge" style="display:none;font-size:0.6rem;font-weight:700;letter-spacing:1.2px;padding:2px 8px;border-radius:4px;background:#1a1a2e;color:#3a5070;border:1px solid #252550;">IDLE</span>
      </div>
      <a href="/trade/status" style="font-size:0.72rem;color:#c84040;text-decoration:none;padding:5px 12px;border-radius:6px;border:1px solid #3a1010;background:#120608;white-space:nowrap;">Open Live →</a>
    </div>
    <div id="live-status-body" style="padding:14px 18px 16px;">
      <div style="color:#3a5070;font-size:0.75rem;">Loading…</div>
    </div>
  </div>

  <!-- ⑤ ACTIVE CONFIGURATION -->
  <div class="card">
    <div class="card-hdr">
      <span class="card-hdr-icon">⚙️</span>
      <span class="card-hdr-title">Active Configuration</span>
    </div>
    <div class="cfg-grid">
      <div class="cfg-cell" style="border-top:2px solid #3b82f6;">
        <div class="cfg-label">Strategy</div>
        <div class="cfg-val">${ACTIVE}</div>
        <div class="cfg-sub">${activeStrategyName}</div>
      </div>
      <div class="cfg-cell" style="border-top:2px solid #8b5cf6;">
        <div class="cfg-label">Instrument</div>
        <div class="cfg-val">NIFTY OPTIONS</div>
        <div class="cfg-sub">1 lot = 65 qty (Jan 2026+)</div>
      </div>
      <div class="cfg-cell" style="border-top:2px solid #f59e0b;">
        <div class="cfg-label">Trade Resolution</div>
        <div class="cfg-val">${process.env.TRADE_RESOLUTION || "5"}-min</div>
        <div class="cfg-sub">TRADE_RESOLUTION in .env</div>
      </div>
      <div class="cfg-cell" style="border-top:2px solid #ef4444;">
        <div class="cfg-label">Live Trading</div>
        <div class="cfg-val ${liveReady ? '' : 'disabled'}">${liveReady ? '⚡ ENABLED' : liveEnabled ? '⚠ NEEDS LOGIN' : '🔒 DISABLED'}</div>
        <div class="cfg-sub">${liveReady ? 'All systems ready' : liveEnabled ? 'Broker login required' : 'Set LIVE_TRADE_ENABLED=true in .env'}</div>
      </div>
    </div>
    <div class="live-note">
      🔒 Live trading disabled. Set <code>LIVE_TRADE_ENABLED=true</code> in .env when ready.
    </div>
  </div>

</div>

<script>
function runBT(){
  var f=document.getElementById('bt-from').value;
  var t=document.getElementById('bt-to').value;
  var r=document.getElementById('bt-res').value;
  if(!f||!t){alert('Set both dates');return;}
  if(f>=t){alert('From must be before To');return;}
  window.open('/backtest?from='+f+'&to='+t+'&resolution='+r,'_blank');
}
// ── Dashboard: Paper & Live trade status panels ──────────────────────────────
function fmtPnl(v){ if(v===null||v===undefined) return {txt:'—',cls:'flat'}; var n=parseFloat(v); return {txt:(n>=0?'+':'')+'\u20b9'+n.toFixed(0),cls:n>0?'pos':n<0?'neg':'flat'}; }
function fmtNum(v,prefix,suffix){ if(v===null||v===undefined) return '—'; return (prefix||'')+v+(suffix||''); }

function renderPaperStatus(d){
  var rb=document.getElementById('paper-run-badge'), sb=document.getElementById('paper-stop-badge');
  if(rb&&sb){ rb.style.display=d.running?'inline':'none'; sb.style.display=d.running?'none':'inline'; }
  var pnl=fmtPnl(d.sessionPnl), upnl=fmtPnl(d.unrealisedPnl);
  var posHtml='';
  if(d.position){
    var p=d.position, pp=fmtPnl(p.optPremiumPnl!=null?p.optPremiumPnl:d.unrealisedPnl);
    posHtml='<div class="ts-pos-bar">'
      +'<span class="ts-pos-item"><strong>'+p.side+'</strong> &nbsp;'+p.symbol+'</span>'
      +'<span class="ts-pos-item">Entry Spot <strong>\u20b9'+(p.entryPrice||'—')+'</strong></span>'
      +(p.optionEntryLtp?'<span class="ts-pos-item">Opt Entry <strong>\u20b9'+p.optionEntryLtp+'</strong></span>':'')
      +(p.optionCurrentLtp?'<span class="ts-pos-item">Opt LTP <strong>\u20b9'+p.optionCurrentLtp+'</strong></span>':'')
      +'<span class="ts-pos-item '+(pp.cls==='pos'?'pnl-pos':pp.cls==='neg'?'pnl-neg':'')+'">Unrealised <strong>'+pp.txt+'</strong></span>'
      +(p.stopLoss?'<span class="ts-pos-item">SL <strong>\u20b9'+p.stopLoss+'</strong></span>':'')
      +'</div>';
  } else if(d.running){
    posHtml='<div style="padding:8px 18px 0;"><span class="ts-flat-note">Flat — watching for signal</span></div>';
  }
  var capital=d.capital!=null?'\u20b9'+parseFloat(d.capital).toFixed(0):'—';
  document.getElementById('paper-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Unrealised PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">'+(d.pnlSource||'—')+'</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Capital</div><div class="ts-val">'+capital+'</div><div class="ts-sub">Simulated</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Total PnL (all-time)</div><div class="ts-val '+fmtPnl(d.totalPnl).cls+'">'+fmtPnl(d.totalPnl).txt+'</div><div class="ts-sub">From saved data</div></div>'
    +'</div>'
    +posHtml;
}

function renderLiveStatus(d){
  var rb=document.getElementById('live-run-badge'), sb=document.getElementById('live-stop-badge');
  if(rb&&sb){ rb.style.display=d.running?'inline':'none'; sb.style.display=d.running?'none':'inline'; }
  var pnl=fmtPnl(d.sessionPnl), upnl=fmtPnl(d.unrealisedPnl);
  var posHtml='';
  if(d.position){
    var p=d.position, pp=fmtPnl(p.optPremiumPnl!=null?p.optPremiumPnl:d.unrealisedPnl);
    posHtml='<div class="ts-pos-bar">'
      +'<span class="ts-pos-item"><strong>'+p.side+'</strong> &nbsp;'+p.symbol+'</span>'
      +'<span class="ts-pos-item">Entry Spot <strong>\u20b9'+(p.entryPrice||'—')+'</strong></span>'
      +(p.optionEntryLtp?'<span class="ts-pos-item">Opt Entry <strong>\u20b9'+p.optionEntryLtp+'</strong></span>':'')
      +(p.optionCurrentLtp?'<span class="ts-pos-item">Opt LTP <strong>\u20b9'+p.optionCurrentLtp+'</strong></span>':'')
      +'<span class="ts-pos-item '+(pp.cls==='pos'?'pnl-pos':pp.cls==='neg'?'pnl-neg':'')+'">Opt Premium PnL <strong>'+pp.txt+'</strong></span>'
      +(p.stopLoss?'<span class="ts-pos-item">SL <strong>\u20b9'+p.stopLoss+'</strong></span>':'')
      +(p.orderId?'<span class="ts-pos-item">Order <strong>'+p.orderId+'</strong></span>':'')
      +'</div>';
  } else if(d.running){
    posHtml='<div style="padding:8px 18px 0;"><span class="ts-flat-note">Flat — watching for signal</span></div>';
  }
  var fyers=d.fyersOk?'<span style="color:#4ade80;">●</span> Fyers':'<span style="color:#f87171;">●</span> Fyers';
  var zerodha=d.zerodhaOk?'<span style="color:#4ade80;">●</span> Zerodha':'<span style="color:#f87171;">●</span> Zerodha';
  document.getElementById('live-status-body').innerHTML=
    '<div class="ts-grid">'
    +'<div class="ts-cell"><div class="ts-label">Session PnL</div><div class="ts-val '+pnl.cls+'">'+pnl.txt+'</div><div class="ts-sub">'+d.tradeCount+' trades · '+(d.wins||0)+'W/'+(d.losses||0)+'L</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Opt Premium PnL</div><div class="ts-val '+upnl.cls+'">'+upnl.txt+'</div><div class="ts-sub">Unrealised</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Activity</div><div class="ts-val" style="font-size:0.75rem;">'+fyers+' &nbsp; '+zerodha+'</div><div class="ts-sub">Broker connections</div></div>'
    +'<div class="ts-cell"><div class="ts-label">Ticks / Candles</div><div class="ts-val flat" style="font-size:0.82rem;">'+(d.tickCount||0)+' / '+(d.candleCount||0)+'</div><div class="ts-sub">This session</div></div>'
    +'</div>'
    +posHtml;
}

async function pollDashboardStatus(){
  try {
    var pr = await fetch('/paperTrade/status/data',{cache:'no-store'});
    if(pr.ok){ var pd=await pr.json(); renderPaperStatus(pd); }
  } catch(e){}
  try {
    var lr = await fetch('/trade/status/data',{cache:'no-store'});
    if(lr.ok){ var ld=await lr.json(); renderLiveStatus(ld); }
  } catch(e){}
}
pollDashboardStatus();
setInterval(pollDashboardStatus, 4000);
// ─────────────────────────────────────────────────────────────────────────────

function hardReset(){
  if(!confirm('Clear all tokens and restart the server?\\nYou will need to re-login both Fyers and Zerodha after.')) return;
  var secret = prompt('Enter API_SECRET from your .env\\n(leave blank if API_SECRET is not set):') || '';
  var url = '/admin/reset' + (secret ? '?secret=' + encodeURIComponent(secret) : '');
  fetch(url, {method:'POST'})
    .then(function(r){
      if(r.status === 403){ alert('Wrong API_SECRET — reset blocked.\\nCheck API_SECRET in your .env and try again.'); return null; }
      return r.json();
    })
    .then(function(d){
      if(!d) return;
      if(d.success){ alert(d.message + '\\nPage will reload in 6 seconds.'); setTimeout(function(){ location.reload(); }, 6000); }
      else { alert('Reset failed: ' + (d.error || JSON.stringify(d))); }
    })
    .catch(function(){ alert('Reset sent — server restarting. Reload in 6 seconds.'); setTimeout(function(){ location.reload(); }, 6000); });
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send(`<pre style="color:red;padding:32px;font-family:monospace;">
Dashboard Error: ${err.message}

${err.stack}

Check your .env file — common causes:
• ACTIVE_STRATEGY not matching available strategies (should be STRATEGY_1)
• Missing required env vars
</pre>`);
  }
});

// ── Admin: Token Clear + Hard Restart ────────────────────────────────────────
// POST /admin/reset  (requires API_SECRET)
// Clears both Fyers & Zerodha tokens from disk/memory, then exits.
// PM2 / nodemon auto-restarts the process — fresh SDK singletons, clean slate.
// Use this whenever the Fyers socket enters a broken state mid-session (e.g.
// EOD token clear without a server restart causes fyersDataSocket singleton
// to hold a dead auth context that getInstance() keeps returning).
app.post("/admin/reset", (req, res) => {
  console.log("🔄 [ADMIN] Hard reset requested — clearing tokens & restarting...");
  try { clearFyersToken(); }    catch (_) {}
  try { zerodha.clearZerodhaToken(); } catch (_) {}
  res.json({ success: true, message: "Tokens cleared. Server restarting now..." });
  setTimeout(() => process.exit(0), 300); // brief delay so response flushes
});

// ── Global error handlers ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ success: false, error: err.message, stack: process.env.NODE_ENV === "development" ? err.stack : undefined });
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[UnhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err.message, err.stack);
});

// ── EOD Token Auto-Clear Scheduler ──────────────────────────────────────────
// Clears BOTH Fyers and Zerodha tokens at 3:31 PM IST every day.
// This ensures:
//   (a) Tokens are wiped even if the app ran all day without a manual stop.
//   (b) Next morning on first startup, loadToken() sees no file → forces fresh login.
// Re-schedules itself for the same time the next day so it runs perpetually.

function scheduleEODTokenClear() {
  const now    = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const clearAt = new Date(now);
  clearAt.setHours(15, 31, 0, 0); // 3:31 PM IST

  let msUntil = clearAt - now;
  if (msUntil <= 0) msUntil += 24 * 60 * 60 * 1000; // if already past, schedule for tomorrow

  console.log(`🕒 EOD token clear scheduled in ${Math.round(msUntil / 60000)} min (at 3:31 PM IST)`);

  setTimeout(() => {
    console.log("🔴 [EOD] 3:31 PM IST — auto-clearing Fyers & Zerodha tokens...");
    clearFyersToken();
    zerodha.clearZerodhaToken();
    console.log("✅ [EOD] Both tokens cleared. Fresh login required tomorrow morning.");
    scheduleEODTokenClear(); // re-schedule for tomorrow's 3:31 PM
  }, msUntil);
}

scheduleEODTokenClear();

// ── HTTPS Server ──────────────────────────────────────────────────────────────
// Generate cert once on EC2 (never commit certs/ to git):
//
//   mkdir -p certs
//   openssl req -x509 -newkey rsa:4096 \
//     -keyout certs/key.pem -out certs/cert.pem \
//     -days 3650 -nodes -subj "/CN=43.205.26.92"
//
// Add to .gitignore:  certs/

const PORT   = process.env.PORT   || 3000;
const HOST   = "0.0.0.0";
const EC2_IP = process.env.EC2_IP || "43.205.26.92"; // override via .env if IP changes

// Fail fast with a clear message if certs are missing
let sslOptions;
try {
  sslOptions = {
    key:  fs.readFileSync("./certs/key.pem"),
    cert: fs.readFileSync("./certs/cert.pem"),
  };
} catch (e) {
  console.error("\n❌  SSL certificates not found. Generate them on EC2:\n");
  console.error("    mkdir -p certs");
  console.error(`    openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem -days 3650 -nodes -subj "/CN=${EC2_IP}"\n`);
  process.exit(1);
}

https.createServer(sslOptions, app).listen(PORT, HOST, () => {
  console.log(`\n🚀 Trading App running at https://${EC2_IP}:${PORT} (AWS — HTTPS)`);
  console.log(`   Active Strategy  : ${ACTIVE}`);
  console.log(`   Instrument       : ${INSTRUMENT}`);
  console.log(`   Fyers Login      : ${process.env.ACCESS_TOKEN ? "✅ token set" : "❌ not logged in"}`);
  console.log(`   Zerodha Login    : ${zerodha.isAuthenticated() ? "✅ token set" : "❌ not logged in"}`);
  console.log(`   Live Trading     : ${process.env.LIVE_TRADE_ENABLED === "true" ? "✅ ENABLED" : "🔒 disabled"}`);
  console.log(`\n📖 Dashboard → https://${EC2_IP}:${PORT}`);
  console.log(`   📜 Live Logs  → https://${EC2_IP}:${PORT}/logs`);
  console.log(`   ⚠️  Browser warning expected (self-signed cert) — click Advanced → Proceed\n`);
});