// pm2 process file for the VPS. Adjust the two `cwd` paths to where you cloned the repos.
//   pm2 start deploy/ecosystem.config.js && pm2 save
// (Names are prefixed "wishtune-" so they never clash with the oxxy processes.)

module.exports = {
  apps: [
    {
      name: "wishtune-crm-api",
      cwd: "/var/www/html/wishtune-crm-backend",
      script: "server.js",
      instances: 1, // keep 1: the bot cron must not run twice
      env: { NODE_ENV: "production" },
      max_memory_restart: "300M",
      time: true,
    },
    {
      name: "wishtune-crm-web",
      cwd: "/var/www/html/wishtune-crm-frontend",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3100 -H 127.0.0.1",
      env: { NODE_ENV: "production" },
      max_memory_restart: "400M",
      time: true,
    },
  ],
};
