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
const DAILY_UNIQUE = 'sent_notifications_sheet_row_delivery_date_channel_recipient_send_date_key';

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
        send_date     date        NOT NULL DEFAULT CURRENT_DATE,
        done          boolean     NOT NULL DEFAULT false,
        done_at       timestamptz,
        done_by       text,
        reserved_at   timestamptz NOT NULL DEFAULT now(),
        sent_at       timestamptz
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_ack_messages (
        channel       text        NOT NULL,
        chat_id       text        NOT NULL,
        message_id    text        NOT NULL,
        sheet_row     integer     NOT NULL,
        delivery_date date        NOT NULL,
        order_label   text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (channel, chat_id, message_id)
      )
    `);
    await migrateSentNotifications(client);
    await migrateDailyResend(client);
    await ensureDailyUniqueConstraint(client);
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

/**
 * v2 → v3 migration: reminders repeat every allowed day until the order is
 * marked done. Adds the per-day dedup column (send_date) and done-tracking
 * columns (done, done_at, done_by).
 */
async function migrateDailyResend(client) {
  const col = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'sent_notifications' AND column_name = 'send_date'`,
  );
  if (col.rowCount === 0) {
    log('[db] adding send_date (per-day dedup)…');
    await client.query('ALTER TABLE sent_notifications ADD COLUMN send_date date');
    // keep historical rows on the day they were actually sent
    await client.query(
      'UPDATE sent_notifications SET send_date = COALESCE(reserved_at, sent_at, now())::date WHERE send_date IS NULL',
    );
    await client.query('ALTER TABLE sent_notifications ALTER COLUMN send_date SET NOT NULL');
  }
  await client.query('ALTER TABLE sent_notifications ADD COLUMN IF NOT EXISTS done boolean NOT NULL DEFAULT false');
  await client.query('ALTER TABLE sent_notifications ADD COLUMN IF NOT EXISTS done_at timestamptz');
  await client.query('ALTER TABLE sent_notifications ADD COLUMN IF NOT EXISTS done_by text');
}

/** One row per (order, recipient, day): reminders repeat daily until done. */
async function ensureDailyUniqueConstraint(client) {
  const exists = await client.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [DAILY_UNIQUE]);
  if (exists.rowCount > 0) return;
  await client.query(`ALTER TABLE sent_notifications DROP CONSTRAINT IF EXISTS ${NEW_UNIQUE}`);
  await client.query(
    `ALTER TABLE sent_notifications ADD CONSTRAINT ${DAILY_UNIQUE}
     UNIQUE (sheet_row, delivery_date, channel, recipient_id, send_date)`,
  );
  log('[db] added per-day unique constraint');
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
    // DB_NAME is forced into the URL path: with both connectionString and a
    // separate `database` field, node-postgres lets the URL path win, which
    // would silently point the app at the admin DB when the URL path differs.
    const url = new URL(config.db.url);
    url.pathname = `/${config.db.name}`;
    pool = new pg.Pool({ connectionString: url.toString(), ssl: sslSetting() });
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
 * Try to reserve a notification for one (order, channel, recipient, day) so
 * concurrent runs / duplicates never send twice on the same day. A new day
 * yields a fresh reservation — reminders repeat until the order is done.
 * Returns reservation id, or null if already sent/reserved that day.
 */
export async function reserveNotification({
  sheetRow,
  deliveryDate,
  orderLabel,
  daysLeft,
  channel,
  recipientId,
  sendDate,
}) {
  const { rows } = await getPool().query(
    `INSERT INTO sent_notifications (sheet_row, delivery_date, order_label, days_left, channel, recipient_id, send_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (sheet_row, delivery_date, channel, recipient_id, send_date) DO NOTHING
     RETURNING id`,
    [sheetRow, deliveryDate, orderLabel, daysLeft, channel, recipientId, sendDate],
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

/**
 * Keys (sheet_row + delivery_date) of orders marked done via the bot.
 * Used by the job to stop reminding about them.
 */
export async function getDoneOrders() {
  const { rows } = await getPool().query(
    `SELECT DISTINCT sheet_row AS "sheetRow", delivery_date::text AS "deliveryDate"
     FROM sent_notifications WHERE done = true`,
  );
  return rows;
}

/**
 * Marks every notification row of one order as done (any recipient's
 * confirmation stops the reminders for everyone). Returns the number of
 * rows flagged (0 also means the order had no notification rows yet).
 */
export async function markOrderDone({ sheetRow, deliveryDate, doneBy }) {
  const { rowCount } = await getPool().query(
    `UPDATE sent_notifications
        SET done = true, done_at = now(), done_by = $3
      WHERE sheet_row = $1 AND delivery_date = $2 AND NOT done`,
    [sheetRow, deliveryDate, doneBy ?? null],
  );
  return rowCount;
}

/**
 * Resumes reminders for an order: clears the done flag on all its rows
 * (every recipient, every delivery date). Returns false if nothing was done.
 */
export async function undoOrderDone(sheetRow) {
  const { rowCount } = await getPool().query(
    `UPDATE sent_notifications
        SET done = false, done_at = null, done_by = null
      WHERE sheet_row = $1 AND done = true`,
    [sheetRow],
  );
  return rowCount > 0;
}

/** Done orders (latest first) for the /undo list. */
export async function getDoneOrdersDetailed(limit = 15) {
  const { rows } = await getPool().query(
    `SELECT sheet_row           AS "sheetRow",
            delivery_date::text AS "deliveryDate",
            max(order_label)    AS "orderLabel",
            max(done_at)        AS "doneAt",
            max(done_by)        AS "doneBy"
       FROM sent_notifications
      WHERE done = true
      GROUP BY sheet_row, delivery_date
      ORDER BY max(done_at) DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Done-marker for an order that has no notification rows yet (e.g. bulk
 * marking before the first send). sent_at is set so reservation cleanup
 * never removes it; recipient_id is null — real sends use their own rows.
 */
export async function insertDoneMarker({ sheetRow, deliveryDate, orderLabel, daysLeft, channel, sendDate, doneBy }) {
  await getPool().query(
    `INSERT INTO sent_notifications
       (sheet_row, delivery_date, order_label, days_left, channel, recipient_id,
        send_date, done, done_at, done_by, sent_at)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, true, now(), $7, now())
     ON CONFLICT (sheet_row, delivery_date, channel, recipient_id, send_date) DO NOTHING`,
    [sheetRow, deliveryDate, orderLabel, daysLeft ?? null, channel, sendDate, doneBy ?? null],
  );
}

/** Remembers a bot acknowledgment message so replies to it resolve to the order. */
export async function storeAckMessage({ channel, chatId, messageId, sheetRow, deliveryDate, orderLabel }) {
  if (!messageId) return;
  await getPool().query(
    `INSERT INTO bot_ack_messages (channel, chat_id, message_id, sheet_row, delivery_date, order_label)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (channel, chat_id, message_id) DO NOTHING`,
    [channel, chatId, String(messageId), sheetRow, deliveryDate, orderLabel ?? null],
  );
}

/**
 * Finds the order behind a Telegram message the user replied to: either a
 * reminder (matched by chat + message id — ids are unique per chat) or a bot
 * acknowledgment (✅ / 🔓) remembered via storeAckMessage.
 */
export async function findOrderByMessageId({ channel, chatId, messageId }) {
  const { rows } = await getPool().query(
    `SELECT q.sheet_row          AS "sheetRow",
            q.delivery_date      AS "deliveryDate",
            q.order_label        AS "orderLabel",
            q.done
       FROM (
         SELECT n.sheet_row, n.delivery_date::text AS delivery_date, n.order_label,
                n.done, n.id AS ord
           FROM sent_notifications n
           JOIN recipients r ON r.id = n.recipient_id
          WHERE n.channel = $1 AND r.chat_id = $2 AND n.message_id = $3
         UNION ALL
         SELECT a.sheet_row, a.delivery_date::text,
                COALESCE(a.order_label,
                  (SELECT s.order_label FROM sent_notifications s
                    WHERE s.sheet_row = a.sheet_row AND s.delivery_date = a.delivery_date
                    ORDER BY s.id LIMIT 1)),
                COALESCE((SELECT true FROM sent_notifications s
                           WHERE s.sheet_row = a.sheet_row
                             AND s.delivery_date = a.delivery_date AND s.done
                           LIMIT 1), false),
                0
           FROM bot_ack_messages a
          WHERE a.channel = $1 AND a.chat_id = $2 AND a.message_id = $3
       ) q
      ORDER BY q.ord DESC
      LIMIT 1`,
    [channel, chatId, String(messageId)],
  );
  return rows[0] || null;
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
