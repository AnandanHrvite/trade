module.exports = {
  apps: [
    {
      name: "trading-bot",
      script: "src/app.js",
      // t3.micro = 956 MB usable. Pushed caps to the ceiling per user request
      // so paper/live sessions aren't killed by pm2 under load. V8 heap is set
      // just below the pm2 restart threshold so GC runs before pm2 kills us.
      // --expose-gc lets the backtest engine trigger GC manually.
      node_args: "--expose-gc --max-old-space-size=900",
      max_memory_restart: "940M",
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
