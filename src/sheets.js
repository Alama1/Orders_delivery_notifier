import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { config } from './config.js';

let sheetsClient = null;

function client() {
  if (!sheetsClient) {
    // NOTE: constructed from the parsed key instead of { keyFile } —
    // keyFile mode fails with "invalid_grant: account not found" on
    // this google-auth-library version.
    let key;
    try {
      key = JSON.parse(readFileSync(config.google.serviceAccountFile, 'utf8'));
    } catch (err) {
      throw new Error(
        `Cannot read service-account key file "${config.google.serviceAccountFile}": ${err.message}`,
      );
    }
    if (!key.client_email || !key.private_key) {
      throw new Error(
        'The service-account JSON must contain "client_email" and "private_key". ' +
          'Download a JSON key: Credentials → Service account → Keys → Create new key (JSON).',
      );
    }
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

const q = (title) => `'${String(title).replace(/'/g, "''")}'`;

async function getTabTitles() {
  const res = await client().spreadsheets.get({
    spreadsheetId: config.google.sheetId,
    fields: 'sheets.properties.title',
  });
  return res.data.sheets.map((s) => s.properties.title);
}

async function readRange(range) {
  const res = await client().spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  return res.data.values || [];
}

/** Resolve which tab holds the orders (configured name or the first tab). */
export async function resolveOrdersTab() {
  if (config.google.ordersTab) return config.google.ordersTab;
  const titles = await getTabTitles();
  if (titles.length === 0) throw new Error('The spreadsheet has no tabs');
  console.log(`[sheets] ORDERS_TAB not set — using the first tab: "${titles[0]}"`);
  return titles[0];
}

/** Raw rows of the orders tab (including the header row). */
export async function readOrdersRows() {
  const tab = await resolveOrdersTab();
  return readRange(`${q(tab)}!A1:Z`);
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const normTime = (value) => {
  const m = String(value).trim().match(HHMM);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

/**
 * Pure settings parser (unit-testable). Supported rows (label in A, value in B):
 *   Час сповіщення      | 09:00   — window start
 *   Кінець сповіщень    | 18:00   — window end (optional; empty = no upper bound)
 *   Днів до здачі       | 3       — reminder window in days
 *   Сповіщати у вихідні | ні      — yes/так → notify on weekends too
 * Label matching is order-sensitive: «вихідн» and «кінець» must be checked
 * before the generic «сповіщ/час» start-time branch.
 */
export function parseSettingsRows(rows, fallback) {
  const settings = {
    time: fallback.time,
    days: fallback.days,
    endTime: fallback.endTime || null,
    weekendNotify: fallback.weekendNotify,
    source: 'env fallback',
  };
  let touched = false;

  for (const row of rows) {
    const label = String(row[0] || '').trim();
    const value = String(row[1] ?? '').trim();
    if (!label || !value || /пояс/i.test(label)) continue; // skip "Часовий пояс" etc.

    if (/вихідн/i.test(label)) {
      settings.weekendNotify = /^(так|да|yes|true|1|on)$/i.test(value);
      touched = true;
    } else if (/кінець|закінч/i.test(label)) {
      const t = normTime(value);
      if (t) {
        settings.endTime = t;
        touched = true;
      }
    } else if (/сповіщ|час/i.test(label)) {
      const t = normTime(value);
      if (t) {
        settings.time = t;
        touched = true;
      }
    } else if (/дн/i.test(label)) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 365) {
        settings.days = n;
        touched = true;
      }
    }
  }

  // a window that ends before it starts makes no sense — drop the end bound
  if (settings.endTime) {
    const [sh, sm] = settings.time.split(':').map(Number);
    const [eh, em] = settings.endTime.split(':').map(Number);
    if (eh * 60 + em <= sh * 60 + sm) settings.endTime = null;
  }

  if (touched) settings.source = 'sheet';
  return settings;
}

/**
 * Reads the settings tab ("Налаштування") and returns
 * { time, endTime, days, weekendNotify, source }.
 * Falls back to .env defaults when the tab is missing or unreadable.
 */
export async function readSettings() {
  const fallback = {
    time: config.fallback.notifyTime,
    days: config.fallback.notifyDays,
    endTime: config.fallback.endTime,
    weekendNotify: config.fallback.weekendNotify,
  };

  let rows;
  try {
    rows = await readRange(`${q(config.google.settingsTab)}!A1:B50`);
  } catch (err) {
    console.warn(
      `[sheets] settings tab "${config.google.settingsTab}" is unavailable (${err.message}) — using defaults`,
    );
    return { ...fallback, endTime: fallback.endTime || null, source: 'env fallback' };
  }

  return parseSettingsRows(rows, fallback);
}
