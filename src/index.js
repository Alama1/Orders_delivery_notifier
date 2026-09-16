import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import { log, logError } from './logger.js';
import { ensureDatabase, ensureSchema, closeDb } from './db.js';
import { runJobSafe } from './job.js';
import { runPoller } from './bot.js';

const runOnce = process.argv.includes('--once');
const pollAbort = new AbortController();

async function main() {
  log(`order-delivery-notifier starting (tz: ${config.timezone}, channels: ${config.channels.join(', ')})`);

  const errors = validateConfig();
  if (errors.length > 0) {
    for (const e of errors) logError(`[config] ${e}`);
    logError('Fix the .env file and try again. See .env.example for reference.');
    process.exit(1);
  }

  await ensureDatabase();
  await ensureSchema();

  if (runOnce) {
    log('[once] single run (--once)');
    await runJobSafe();
    await closeDb();
    return;
  }

  // catch-up run right after boot, then the schedule takes over
  await runJobSafe();

  cron.schedule(config.cron, runJobSafe, { timezone: config.timezone });
  log(`[cron] scheduled "${config.cron}" (${config.timezone}) — press Ctrl+C to stop`);

  // command listener (/add, /remove, /help) — skipped in DRY_RUN
  if (config.dryRun) {
    log('[dry-run] bot command listener is disabled');
  } else {
    runPoller(pollAbort.signal).catch((err) => logError(`[bot] poller crashed: ${err.message}`));
  }
}

async function shutdown(signal) {
  log(`received ${signal}, shutting down…`);
  pollAbort.abort();
  try {
    await closeDb();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  logError(`fatal: ${err.message}`);
  if (err.stack) logError(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
