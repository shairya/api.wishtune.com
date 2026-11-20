// pm2 process file for the SANDBOX (devcrm / devapi). Separate folders, ports and names
// from production, so the two never touch each other.
//   pm2 start deploy/ecosystem.dev.config.js && pm2 save

module.exports = {
  apps: [
    {
      name: "wishtune-dev-api",
      cwd: "/var/www/html/wishtune-crm-backend-dev",
      script: "server.js",
      instances: 1,
      env: { NODE_ENV: "production" }, // SANDBOX_MODE / PORT 5200 come from that folder's .env
      max_memory_restart: "250M",
      time: true,
    },
    {
      name: "wishtune-dev-web",
      cwd: "/var/www/html/wishtune-crm-frontend-dev",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3200 -H 127.0.0.1",
      env: { NODE_ENV: "production" },
      max_memory_restart: "350M",
      time: true,
    },
  ],
};
