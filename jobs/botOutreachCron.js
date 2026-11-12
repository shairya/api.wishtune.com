// jobs/botOutreachCron.js — runs the bot outreach pass on BOT_CRON_SCHEDULE.
// Safe to leave running: it does nothing while BOTS_ENABLED is not "true".

const cron = require("node-cron");
const { runOutreachOnce } = require("../services/bots/outreachService");

let running = false;

function startBotOutreachCron() {
  const schedule = process.env.BOT_CRON_SCHEDULE || "*/5 * * * *";
  if (!cron.validate(schedule)) {
    console.error(`[bots] invalid BOT_CRON_SCHEDULE "${schedule}" — outreach cron not started`);
    return;
  }
  cron.schedule(schedule, async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const report = await runOutreachOnce();
      if (report.ran) console.log("[bots] outreach:", JSON.stringify(report.channels));
    } catch (err) {
      console.error("[bots] outreach run failed:", err);
    } finally {
      running = false;
    }
  });
  console.log(`[bots] outreach cron scheduled (${schedule}); BOTS_ENABLED=${process.env.BOTS_ENABLED || "false"}`);
}

module.exports = { startBotOutreachCron };
