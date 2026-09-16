import 'dotenv/config';

const bool = (v, dflt = false) =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const int = (v, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
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
