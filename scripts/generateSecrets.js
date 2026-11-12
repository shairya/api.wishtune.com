// scripts/generateSecrets.js — prints fresh secrets to paste into .env
//   npm run secrets
const crypto = require("crypto");

const s = () => crypto.randomBytes(48).toString("hex");
console.log(`JWT_SECRET=${s()}`);
console.log(`JWT_REFRESH_SECRET=${s()}`);
console.log(`COOKIE_SECRET=${s()}`);
console.log("\n# Optional — only when you set up the Netlify webhook / bots:");
console.log(`NETLIFY_JWS_SECRET=${crypto.randomBytes(32).toString("hex")}`);
console.log(`TELEAGENT_WEBHOOK_SECRET=${crypto.randomBytes(24).toString("hex")}`);
console.log(`WYLTO_WEBHOOK_SECRET=${crypto.randomBytes(24).toString("hex")}`);
