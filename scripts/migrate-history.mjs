/**
 * One-off helper: copies notification history (sent_notifications) from the
 * old production database (the one in DATABASE_URL) into the app database
 * (DB_NAME). Needed so the bot recognizes replies («Готово», «+») to reminders
 * that were sent before the switch.
 *
 *   node scripts/migrate-history.mjs                        # dry run (source = DB in DATABASE_URL)
 *   node scripts/migrate-history.mjs --from postgres        # explicit source DB
 *   node scripts/migrate-history.mjs --from postgres --yes  # apply
 *
 * Idempotent (same order+recipient+day is skipped). Row ids are NOT preserved
 * — nothing references them; recipient_id references stay valid because
 * migrate-recipients keeps the original recipient ids. Done flags are not
 * copied — the target's own done state wins.
 */
import { config } from '../src/config.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');

const apply = process.argv.includes('--yes');
const fromFlag = process.argv[process.argv.indexOf('--from') + 1];

function sslSetting() {
  const mode = (process.env.DATABASE_SSL || 'auto').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  try {
    const host = new URL(config.db.url).hostname;
    return /^(localhost|127\.|::1)/.test(host) ? false : { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

function connect(dbName) {
  const url = new URL(config.db.url);
  url.pathname = `/${dbName}`;
  return new pg.Client({ connectionString: url.toString(), ssl: sslSetting() });
}

async function main() {
  const sourceDb = fromFlag || new URL(config.db.url).pathname.replace(/^\//, '') || 'postgres';
  const source = connect(sourceDb);
  const target = connect(config.db.name);
  await source.connect();
  await target.connect();

  // ensure the target has the same schema (columns) before copying
  const { rows: srcCols } = await source.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sent_notifications'`);
  for (const col of srcCols.map((c) => c.column_name)) {
    if (col === 'id') continue;
    const { rows } = await target.query(
      'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
      ['sent_notifications', col],
    );
    if (rows.length === 0) {
      console.error(`[migrate-history] target is missing column "${col}" — run the app once first (ensureSchema)`);
      process.exit(1);
    }
  }

  const { rows: from } = await source.query(
    'SELECT * FROM sent_notifications WHERE recipient_id IS NOT NULL ORDER BY id');
  const { rows: existing } = await target.query(
    'SELECT sheet_row, delivery_date::text AS dd, channel, recipient_id, send_date::text AS sd FROM sent_notifications');
  const known = new Set(existing.map((r) => `${r.sheet_row}|${r.dd}|${r.channel}|${r.recipient_id}|${r.sd}`));
  const pending = from.filter((r) => !known.has(
    `${r.sheet_row}|${r.delivery_date.toISOString().slice(0, 10)}|${r.channel}|${r.recipient_id}|${r.send_date.toISOString().slice(0, 10)}`,
  ));

  const skippedNoRecipient = (await source.query(
    'SELECT count(*)::int AS n FROM sent_notifications WHERE recipient_id IS NULL')).rows[0].n;

  console.log(`[migrate-history] ${sourceDb} -> ${config.db.name}: ` +
    `source has ${from.length} rows (+${skippedNoRecipient} without recipient — skipped), ` +
    `target has ${existing.length}, to copy: ${pending.length}`);
  if (pending.length === 0) {
    console.log('[migrate-history] nothing to do');
  } else if (!apply) {
    console.log('[migrate-history] dry run — re-run with --yes to apply');
  } else {
    let copied = 0;
    for (const r of pending) {
      const res = await target.query(
        `INSERT INTO sent_notifications
           (sheet_row, order_label, client, delivery_date, days_left, channel, recipient_id,
            message_id, send_date, done, done_at, done_by, reserved_at, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (sheet_row, delivery_date, channel, recipient_id, send_date) DO NOTHING`,
        [r.sheet_row, r.order_label, r.client, r.delivery_date, r.days_left, r.channel, r.recipient_id,
          r.message_id, r.send_date, r.done, r.done_at, r.done_by, r.reserved_at, r.sent_at],
      );
      copied += res.rowCount;
    }
    console.log(`[migrate-history] copied ${copied} row(s)`);
  }

  await source.end();
  await target.end();
}

main().catch((err) => {
  console.error(`[migrate-history] failed: ${err.message}`);
  process.exit(1);
});
