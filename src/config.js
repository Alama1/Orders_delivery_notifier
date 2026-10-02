import 'dotenv/config';

const bool = (v, dflt = false) =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const int = (v, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

// "1,3,5" (0 = Sunday … 6 = Saturday) → sorted unique array; empty/invalid → null
const daysOfWeek = (v) => {
  if (!v || !v.trim()) return null;
  const set = new Set(
    v.split(',').map((p) => Number.parseInt(p.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  );
  return set.size > 0 ? [...set].sort((a, b) => a - b) : null;
};

const KNOWN_CHANNELS = ['telegram'];
const IMPLEMENTED_CHANNELS = ['telegram'];

const rawChannels = (process.env.NOTIFY_CHANNELS || 'telegram')
  .split(',')
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);

const channels = rawChannels.filter((c) => {
  if (!KNOWN_CHANNELS.includes(c)) {
    console.warn(`[config] unknown channel "${c}" in NOTIFY_CHANNELS, ignoring`);
    return false;
  }
  if (!IMPLEMENTED_CHANNELS.includes(c)) {
    console.warn(`[config] channel "${c}" is not implemented yet, ignoring`);
    return false;
  }
  return true;
});

export const config = {
  google: {
    sheetId: process.env.GOOGLE_SHEET_ID || '',
    // service-account key: inline JSON (or base64 of it) — for Portainer/env-managed setups
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '',
    // ...or a path to the JSON file — for plain-VM / local setups
    serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './credentials/service-account.json',
    ordersTab: (process.env.ORDERS_TAB || '').trim(),
    settingsTab: (process.env.SETTINGS_TAB || 'Налаштування').trim(),
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  db: {
    url: process.env.DATABASE_URL || '',
    name: (process.env.DB_NAME || 'order_delivery').trim(),
  },
  cron: process.env.CRON || '*/10 * * * *',
  timezone: process.env.TIMEZONE || 'Europe/Kyiv',
  // fallbacks used when the settings tab is missing/invalid
  fallback: {
    notifyTime: (process.env.NOTIFY_TIME || '09:00').trim(),
    notifyDays: int(process.env.NOTIFY_DAYS, 3),
    endTime: (process.env.NOTIFY_END_TIME || '').trim(), // empty = no upper bound
    weekendNotify: bool(process.env.NOTIFY_WEEKENDS, false),
    // e.g. "1,2,3,4,5"; null → NOTIFY_WEEKENDS decides (Mon–Fri vs all days)
    notifyDaysOfWeek: daysOfWeek(process.env.NOTIFY_DAYS_OF_WEEK),
  },
  channels,
  dryRun: bool(process.env.DRY_RUN, false),
};

export function validateConfig() {
  const errors = [];
  if (!config.google.sheetId) errors.push('GOOGLE_SHEET_ID is required');
  if (config.channels.length === 0) {
    errors.push('NOTIFY_CHANNELS contains no implemented channel (telegram)');
  }
  if (config.channels.includes('telegram')) {
    if (!config.telegram.botToken) errors.push('TELEGRAM_BOT_TOKEN is required');
    if (!config.telegram.chatId) {
      console.warn(
        '[config] TELEGRAM_CHAT_ID is not set — no chat will be auto-registered. ' +
          'Add recipients by sending /add to the bot.',
      );
    }
  }
  if (!config.db.url) errors.push('DATABASE_URL is required');
  return errors;
}
