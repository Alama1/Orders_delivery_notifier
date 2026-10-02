import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { config } from './config.js';

let sheetsClient = null;

export function loadServiceAccount() {
  // 1. Inline key from env (GOOGLE_SERVICE_ACCOUNT_KEY) — raw JSON or base64 of it
  const inline = config.google.serviceAccountKey.trim().replace(/\s+/g, '');
  if (inline) {
    let raw = inline;
    if (!raw.startsWith('{')) {
      raw = Buffer.from(raw, 'base64').toString('utf8');
    }
    try {
      return JSON.parse(raw);
    } catch {
      // paste artifacts: terminal copy often appends junk after the JSON —
      // retry with everything outside the outermost {…} stripped
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(raw.slice(start, end + 1));
        } catch { /* fall through to the detailed error below */ }
      }
      const hint =
        raw.startsWith('{')
          ? 'it looks like raw JSON — make sure it was not truncated'
          : `decoded ${raw.length} chars; if you copied it from a terminal, make sure the ` +
            `shell prompt (e.g. "root@vps…") was not copied along with the base64 output`;
      throw new Error(
        `GOOGLE_SERVICE_ACCOUNT_KEY does not contain valid service-account JSON — ${hint}. ` +
          `Regenerate with: base64 -w0 credentials/service-account.json`,
      );
    }
  }

  // 2. Key file on disk (local dev / plain VM)
  try {
    return JSON.parse(readFileSync(config.google.serviceAccountFile, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read service-account key file "${config.google.serviceAccountFile}": ${err.message} ` +
        `(or set GOOGLE_SERVICE_ACCOUNT_KEY instead)`,
    );
  }
}

function client() {
  if (!sheetsClient) {
    // NOTE: constructed from the parsed key instead of { keyFile } —
    // keyFile mode fails with "invalid_grant: account not found" on
    // this google-auth-library version.
    const key = loadServiceAccount();
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

const TRUE_VALUES = /^(true|так|да|yes|1|on)$/i;

/**
 * Ukrainian/English day name (full or short, e.g. «Понеділок», «Пн», «Mon»)
 * → weekday number (0 = Sunday … 6 = Saturday), or null if not a day name.
 */
export function dayNameToWeekday(raw) {
  const s = String(raw).toLowerCase().replace(/['’`ʼ]/g, '').trim();
  if (!s) return null;
  if (/^(пн|понед|mon)/.test(s)) return 1;
  if (/^(вт|вівт|tue)/.test(s)) return 2;
  if (/^(ср|сер|wed)/.test(s)) return 3;
  if (/^(чт|чет|thu)/.test(s)) return 4;
  if (/^(пт|пят|fri)/.test(s)) return 5;
  if (/^(сб|суб|sat)/.test(s)) return 6;
  if (/^(нд|нед|sun)/.test(s)) return 0;
  return null;
}

/**
 * Detects a day-of-week row: a label mentioning «дні/днів/day» plus two or
 * more day-name cells to the right (e.g. «Сповіщати у дні | Понеділок | …»).
 * Checkboxes (TRUE/FALSE) are read from the same columns of the next row.
 * Returns { enabled: number[] } or null when the row is not a day row.
 */
function parseDayOfWeekRow(row, checkboxRow) {
  const days = row.slice(1).map(dayNameToWeekday);
  if (days.filter((d) => d !== null).length < 2) return null;

  const enabled = new Set();
  let sawAnyCheckbox = false;
  for (let c = 1; c < row.length; c++) {
    if (days[c - 1] === null) continue;
    const check = String(checkboxRow?.[c] ?? '').trim();
    if (check !== '') sawAnyCheckbox = true;
    if (TRUE_VALUES.test(check)) enabled.add(days[c - 1]);
  }
  // header without any checkbox values → not configured yet, ignore the row
  return sawAnyCheckbox ? { enabled: [...enabled].sort((a, b) => a - b) } : null;
}

/**
 * Pure settings parser (unit-testable). Supported rows (label in A, value in B):
 *   Час сповіщення      | 09:00   — window start
 *   Кінець сповіщень    | 18:00   — window end (optional; empty = no upper bound)
 *   Днів до здачі       | 3       — reminder window in days
 *   Сповіщати у вихідні | ні      — yes/так → notify on weekends too (legacy)
 *   Сповіщати у дні     | Понеділок | Вівторок | …      — day names
 *                       | TRUE    | FALSE    | …      — checkboxes in the row below
 * Label matching is order-sensitive: «вихідн» and «кінець» must be checked
 * before the generic «сповіщ/час» start-time branch.
 */
export function parseSettingsRows(rows, fallback) {
  const settings = {
    time: fallback.time,
    days: fallback.days,
    endTime: fallback.endTime || null,
    weekendNotify: fallback.weekendNotify,
    notifyDaysOfWeek: fallback.notifyDaysOfWeek ?? null,
    source: 'env fallback',
  };
  let touched = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const label = String(row[0] || '').trim();
    const value = String(row[1] ?? '').trim();
    if (!label || !value || /пояс/i.test(label)) continue; // skip "Часовий пояс" etc.

    const dayRow = parseDayOfWeekRow(row, rows[i + 1]);
    if (dayRow && /дн|день|day/i.test(label)) {
      settings.notifyDaysOfWeek = dayRow.enabled;
      touched = true;
    } else if (/вихідн/i.test(label)) {
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
 * { time, endTime, days, weekendNotify, notifyDaysOfWeek, source }.
 * notifyDaysOfWeek is a sorted array of weekday numbers (0 = Sun … 6 = Sat)
 * or null when the day-checkbox rows are absent → the weekend gate applies.
 * Falls back to .env defaults when the tab is missing or unreadable.
 */
export async function readSettings() {
  const fallback = {
    time: config.fallback.notifyTime,
    days: config.fallback.notifyDays,
    endTime: config.fallback.endTime,
    weekendNotify: config.fallback.weekendNotify,
    notifyDaysOfWeek: config.fallback.notifyDaysOfWeek,
  };

  let rows;
  try {
    // columns A..H: the day row spans «Сповіщати у дні» + 7 day names
    rows = await readRange(`${q(config.google.settingsTab)}!A1:H50`);
  } catch (err) {
    console.warn(
      `[sheets] settings tab "${config.google.settingsTab}" is unavailable (${err.message}) — using defaults`,
    );
    return { ...fallback, endTime: fallback.endTime || null, source: 'env fallback' };
  }

  return parseSettingsRows(rows, fallback);
}
