module.exports = {
  apps: [
    {
      name: "trading-bot",
      script: "src/app.js",
      // t3.micro = 1 GiB RAM (~956 MB usable). Heap + native overhead must fit
      // in ~750 MB to leave ~250 MB for OS + disk cache. --expose-gc lets the
      // backtest engine trigger GC manually between candle chunks.
      node_args: "--expose-gc --max-old-space-size=640",
      max_memory_restart: "720M",
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
