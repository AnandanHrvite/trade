module.exports = {
  apps: [
    {
      name: "trading-bot",
      script: "src/app.js",
      node_args: "--max-old-space-size=768",
      max_memory_restart: "800M",
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
