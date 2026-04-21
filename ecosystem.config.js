module.exports = {
  apps: [
    {
      name: "trading-bot",
      script: "src/app.js",
      // --expose-gc lets the backtest engine trigger GC manually between
      // candle chunks. Heap/restart caps kept generous so paper/live modes
      // aren't killed mid-session on a t3.micro.
      node_args: "--expose-gc --max-old-space-size=768",
      max_memory_restart: "800M",
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 8000,
      env: {
        NODE_ENV: "production",
        UV_THREADPOOL_SIZE: "2",
      },
    },
  ],
};
