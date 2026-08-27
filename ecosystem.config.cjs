/* pm2 process definition — production.
 *
 *   cd /var/www/chatconvert.progryss.com/html
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * .cjs, not .js, on purpose: package.json declares "type": "module", so a .js
 * file here would be parsed as ESM and `module.exports` would throw.
 *
 * NO SECRETS IN THIS FILE — it is committed. Every value the app needs comes
 * from .env, loaded by node itself via --env-file below. This app has no
 * `dotenv` dependency and nothing in it reads .env at runtime, so without that
 * flag the process starts and immediately dies with
 * `Invalid environment: DATABASE_URL is required` while .env sits right there.
 *
 * Paths are derived from __dirname, so this works from any checkout location.
 */
const { join } = require("node:path");

module.exports = {
  apps: [
    {
      name: "chatconvert",

      // Same entry point the sibling apps use (see `pm2 describe zipeta`).
      script: join(__dirname, "node_modules/@react-router/serve/bin.js"),
      args: "./build/server/index.js",
      cwd: __dirname,

      // Loads .env into process.env before the app boots. PORT lives there too.
      node_args: `--env-file=${join(__dirname, ".env")}`,

      // EXACTLY ONE INSTANCE — never cluster mode.
      // The pg-boss queue starts inside the web process (app/entry.server.tsx)
      // and owns the cron schedules for GDPR erasure, retention purge, analytics
      // rollup and auto-resolve. A second instance runs every one of them twice.
      exec_mode: "fork",
      instances: 1,

      autorestart: true,
      max_restarts: 10,
      min_uptime: "20s",
      restart_delay: 4000,

      // Never watch in production — a stray file write would restart the app
      // mid-request.
      watch: false,

      // Safety valve on a 1.9 GB box shared with three other apps: restart
      // rather than let a leak trigger the OOM killer, which might pick a
      // neighbouring app instead. Raise it if a legitimate catalog sync or
      // embedding run trips it — in-flight pg-boss jobs are durable and retry.
      max_memory_restart: "500M",

      // Timestamp every log line.
      time: true,
    },
  ],
};
