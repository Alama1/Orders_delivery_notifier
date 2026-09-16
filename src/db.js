import pg from 'pg';
import { config } from './config.js';
import { log } from './logger.js';

let pool = null;

const pgConfigFromUrl = (url) => ({
  connectionString: url,
  ssl: sslSetting(),
});

function sslSetting() {
  const mode = (process.env.DATABASE_SSL || 'auto').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  // auto: enable SSL for non-local hosts
  try {
    const host = new URL(config.db.url).hostname;
    return /^(localhost|127\.|::1)/.test(host) ? false : { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

function adminUrl() {
  const url = new URL(config.db.url);
  url.pathname = '/postgres';
  return url.toString();
}

function assertDbName(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Invalid DB_NAME "${name}": only letters, digits and underscore are allowed`);
  }
}

export async function ensureDatabase() {
  assertDbName(config.db.name);
  const client = new pg.Client(pgConfigFromUrl(adminUrl()));
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.db.name]);
    if (rows.length === 0) {
      console.log(`[db] database "${config.db.name}" not found — creating`);
      await client.query(`CREATE DATABASE "${config.db.name}"`);
      console.log(`[db] database "${config.db.name}" created`);
    } else {
      console.log(`[db] database "${config.db.name}" exists`);
    }
  } finally {
    await client.end();
  }
}

const OLD_UNIQUE = 'sent_notifications_sheet_row_delivery_date_channel_key';
const NEW_UNIQUE = 'sent_notifications_sheet_row_delivery_date_channel_recipient_key';

export async function ensureSchema() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS recipients (
        id        serial PRIMARY KEY,
        channel   text        NOT NULL,
        chat_id   text        NOT NULL,
        name      text,
        username  text,
        active    boolean     NOT NULL DEFAULT true,
        added_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (channel, chat_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS sent_notifications (
        id            serial PRIMARY KEY,
        sheet_row     integer     NOT NULL,
        order_label   text        NOT NULL,
        client        text,
        delivery_date date        NOT NULL,
        days_left     integer,
        channel       text        NOT NULL,
        recipient_id  integer,
        message_id    text,
        reserved_at   timestamptz NOT NULL DEFAULT now(),
        sent_at       timestamptz
      )
    `);
    await migrateSentNotifications(client);
    await ensureNewUniqueConstraint(client);
    console.log('[db] schema is up to date');
  } finally {
    client.release();
  }
}

/** v1 → v2 migration: dedup changed from per-channel to per-recipient. */
async function migrateSentNotifications(client) {
  const old = await client.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [OLD_UNIQUE]);
  if (old.rowCount === 0) return; // nothing to migrate

  log('[db] migrating sent_notifications to per-recipient dedup…');
  await client.query('ALTER TABLE sent_notifications ADD COLUMN IF NOT EXISTS recipient_id integer');

  // Existing sends belong to the primary chat from .env — keep them "already sent"
  // for that recipient so nothing is re-delivered after the migration.
  const seed = await seedPrimaryRecipient(client);
  if (seed) {
    await client.query(
      'UPDATE sent_notifications SET recipient_id = $1 WHERE recipient_id IS NULL AND channel = $2',
      [seed.id, seed.channel],
    );
  }

  await client.query(`ALTER TABLE sent_notifications DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
  log('[db] migration done');
}

async function ensureNewUniqueConstraint(client) {
  const exists = await client.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [NEW_UNIQUE]);
  if (exists.rowCount > 0) return;
  await client.query(
    `ALTER TABLE sent_notifications ADD CONSTRAINT ${NEW_UNIQUE}
     UNIQUE (sheet_row, delivery_date, channel, recipient_id)`,
  );
  log('[db] added per-recipient unique constraint');
}

/**
 * Registers the chat from TELEGRAM_CHAT_ID as the first recipient
 * (idempotent; never re-activates a chat disabled via /remove).
 */
async function seedPrimaryRecipient(client) {
  const chatId = config.telegram.chatId;
  if (!chatId) return null;
  await client.query(
    `INSERT INTO recipients (channel, chat_id, name)
     VALUES ('telegram', $1, 'Primary (from .env)')
     ON CONFLICT (channel, chat_id) DO NOTHING`,
    [chatId],
  );
  const { rows } = await client.query(
    'SELECT id, channel FROM recipients WHERE channel = $1 AND chat_id = $2',
    ['telegram', chatId],
  );
  return rows[0] || null;
}

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ ...pgConfigFromUrl(config.db.url), database: config.db.name });
  }
  return pool;
}

export async function cleanupStaleReservations(minutes = 15) {
  const { rowCount } = await getPool().query(
    `DELETE FROM sent_notifications
     WHERE sent_at IS NULL AND reserved_at < now() - ($1 || ' minutes')::interval`,
    [minutes],
  );
  if (rowCount > 0) console.log(`[db] released ${rowCount} stale reservation(s)`);
}

export async function getActiveRecipients(channel) {
  const { rows } = await getPool().query(
    `SELECT id, chat_id AS "chatId", name
     FROM recipients
     WHERE channel = $1 AND active = true
     ORDER BY id`,
    [channel],
  );
  return rows;
}

/**
 * Adds a recipient. Returns:
 *   'added'        — new row created
 *   'reactivated'  — previously removed via /remove, switched back on
 *   'exists'       — already active
 */
export async function addRecipient({ channel, chatId, name, username }) {
  const existing = await getPool().query(
    'SELECT id, active FROM recipients WHERE channel = $1 AND chat_id = $2',
    [channel, chatId],
  );
  if (existing.rowCount > 0) {
    if (!existing.rows[0].active) {
      await getPool().query(
        'UPDATE recipients SET active = true, name = COALESCE($2, name), username = COALESCE($3, username) WHERE id = $1',
        [existing.rows[0].id, name || null, username || null],
      );
      return 'reactivated';
    }
    return 'exists';
  }
  await getPool().query(
    'INSERT INTO recipients (channel, chat_id, name, username) VALUES ($1, $2, $3, $4)',
    [channel, chatId, name || null, username || null],
  );
  return 'added';
}

export async function deactivateRecipient(channel, chatId) {
  const { rowCount } = await getPool().query(
    'UPDATE recipients SET active = false WHERE channel = $1 AND chat_id = $2 AND active = true',
    [channel, chatId],
  );
  return rowCount > 0;
}

/**
 * Try to reserve a notification for one (order, channel, recipient) so
 * concurrent runs / duplicates never send twice.
 * Returns reservation id, or null if already sent/reserved.
 */
export async function reserveNotification({
  sheetRow,
  deliveryDate,
  orderLabel,
  daysLeft,
  channel,
  recipientId,
}) {
  const { rows } = await getPool().query(
    `INSERT INTO sent_notifications (sheet_row, delivery_date, order_label, days_left, channel, recipient_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (sheet_row, delivery_date, channel, recipient_id) DO NOTHING
     RETURNING id`,
    [sheetRow, deliveryDate, orderLabel, daysLeft, channel, recipientId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

export async function confirmNotification(id, messageId) {
  await getPool().query('UPDATE sent_notifications SET sent_at = now(), message_id = $2 WHERE id = $1', [
    id,
    messageId ? String(messageId) : null,
  ]);
}

export async function releaseNotification(id) {
  await getPool().query('DELETE FROM sent_notifications WHERE id = $1 AND sent_at IS NULL', [id]);
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
