/**
 * One-off helper: copies recipients from the old production database (the one
 * in DATABASE_URL, e.g. `postgres`) into the app database (DB_NAME, e.g.
 * `order_delivery`) so the new DB can fully replace the old one.
 *
 *   node scripts/migrate-recipients.mjs          # dry run: shows what moves
 *   node scripts/migrate-recipients.mjs --yes    # apply
 *
 * Idempotent: chats already present in the target (same channel+chat_id) are
 * skipped — target data wins (fresh registrations / /remove are kept).
 */
import { config } from '../src/config.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pg = require('pg');

const apply = process.argv.includes('--yes');

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
  const sourceDb = new URL(config.db.url).pathname.replace(/^\//, '') || 'postgres';
  const source = connect(sourceDb);
  const target = connect(config.db.name);
  await source.connect();
  await target.connect();

  const { rows: from } = await source.query('SELECT * FROM recipients ORDER BY id');
  const { rows: existing } = await target.query('SELECT channel, chat_id FROM recipients');
  const known = new Set(existing.map((r) => `${r.channel}|${r.chat_id}`));
  const pending = from.filter((r) => !known.has(`${r.channel}|${r.chat_id}`));

  console.log(`[migrate-recipients] ${sourceDb} -> ${config.db.name}: ` +
    `source has ${from.length}, target already has ${existing.length}, to copy: ${pending.length}`);
  for (const r of pending) {
    console.log(`  #${r.id} ${r.channel} ${r.chat_id} — ${r.name || r.username || '—'} (${r.active ? 'active' : 'INACTIVE'}, added ${r.added_at?.toISOString?.().slice(0, 10) ?? '?'})`);
  }
  if (pending.length === 0) {
    console.log('[migrate-recipients] nothing to do');
  } else if (!apply) {
    console.log('[migrate-recipients] dry run — re-run with --yes to apply');
  } else {
    for (const r of pending) {
      await target.query(
        `INSERT INTO recipients (id, channel, chat_id, name, username, active, added_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (channel, chat_id) DO NOTHING`,
        [r.id, r.channel, r.chat_id, r.name, r.username, r.active, r.added_at],
      );
    }
    // keep the id sequence ahead of the copied ids
    await target.query(
      `SELECT setval(pg_get_serial_sequence('recipients', 'id'),
                     GREATEST((SELECT COALESCE(MAX(id), 1) FROM recipients), 1))`,
    );
    const { rows: after } = await target.query('SELECT count(*)::int AS n FROM recipients');
    console.log(`[migrate-recipients] done — target now has ${after[0].n} recipient(s)`);
  }

  await source.end();
  await target.end();
}

main().catch((err) => {
  console.error(`[migrate-recipients] failed: ${err.message}`);
  process.exit(1);
});
