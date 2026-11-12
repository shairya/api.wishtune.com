// config/mysql.js — shared mysql2/promise pool (same env names as oxxycrm).
// All DATETIME values are stored and read in UTC; the frontend converts to IST.

const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DB || "wishtune_crm",
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "Z",
  charset: "utf8mb4",
});

// Make DEFAULT CURRENT_TIMESTAMP / NOW() UTC too, whatever the server's zone.
pool.pool.on("connection", (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

module.exports = pool;
