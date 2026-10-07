module.exports = {
  apps: [
    {
      name: "trading-bot",
      script: "src/app.js",
      // t3.micro = 956 MB total, but the kernel, sshd, SSM agent and the pm2
      // daemon hold ~200 MB, leaving the bot ~750 MB of real RAM. RSS is the
      // old-space heap PLUS young gen, code and Buffers, so the old 900 MB heap
      // cap let RSS outrun physical RAM — the kernel OOM-killer (or swap-less
      // thrash) struck before pm2's 30 s memory sample could restart cleanly.
      // 620 MB old space makes V8 collect hard before RAM runs out; pm2 then
      // restarts at 750 MB as the last line of defence.
      // --expose-gc lets the backtest engine trigger GC manually.
      node_args: "--expose-gc --max-old-space-size=620",
      max_memory_restart: "750M",
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 8000,
      // Exit code 10 = our "config error, do not restart" sentinel (see
      // app.js EXIT_CONFIG_ERROR). Prevents PM2 from crash-looping the bot
      // — and spamming Telegram — when something like missing SSL certs
      // or a malformed .env makes startup impossible until manually fixed.
      stop_exit_codes: [10],
      env: {
        NODE_ENV: "production",
        UV_THREADPOOL_SIZE: "2",
      },
    },
  ],
};
