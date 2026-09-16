// Column layout of the orders sheet (1-based, matching the CSV export):
// A(1)  checkbox TRUE/FALSE      (ignored)
// B(2)  Замовник: "№0001/25 Іваненко О.П."
// C(3)  Адреса
// D(4)  Номер телефону
// E(5)  Виріб
// F(6)  Менеджер
// G(7)  Дата прийому
// H(8)  Дата здачі              (DD.MM.YYYY — the date we count down to)
// I(9)  Вартість
// J(10) Аванс
// K(11) Залишок
// L(12) Статус
// M(13)..Q(17) appliance columns (ignored)
// R(18) просрочка formula        (ignored, we compute days-left ourselves)
export const COL = {
  CHECKBOX: 0,
  ORDER: 1,
  ADDRESS: 2,
  PHONE: 3,
  ITEM: 4,
  MANAGER: 5,
  RECEPTION_DATE: 6,
  DELIVERY_DATE: 7,
  COST: 8,
  ADVANCE: 9,
  BALANCE: 10,
  STATUS: 11,
};

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Parses "DD.MM.YYYY" (Ukrainian sheet locale) or "YYYY-MM-DD".
 * Returns a Date at UTC midnight, or null if unparsable.
 */
export function parseDate(raw) {
  const s = clean(raw);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m.map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d));
    return isValidCalendarDate(y, mo, d) ? date : null;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d));
    return isValidCalendarDate(y, mo, d) ? date : null;
  }
  return null;
}

function isValidCalendarDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** Current calendar date in the given IANA timezone → Date at UTC midnight. */
export function todayInTz(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, mo, d] = parts.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
}

/** Day of week (0 = Sunday … 6 = Saturday) in the given timezone. */
export function weekdayInTz(timezone, date = new Date()) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[name];
}

export function isWeekendInTz(timezone, date = new Date()) {
  const day = weekdayInTz(timezone, date);
  return day === 0 || day === 6;
}

/** Whole days between today (in tz) and the delivery date. Negative = overdue. */
export function daysLeft(deliveryDate, timezone) {
  const today = todayInTz(timezone);
  return Math.round((deliveryDate.getTime() - today.getTime()) / 86_400_000);
}

/** Minutes since midnight in the given timezone. */
export function minutesOfDayInTz(timezone, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function formatDate(date) {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${d}.${m}.${date.getUTCFullYear()}`;
}

/**
 * Converts raw sheet rows (arrays of cells) into valid order objects.
 * Skips empty/junk rows: a row is valid when it has an order label (B)
 * and a parsable delivery date (H) not older than year 2000.
 */
export function parseOrders(rows, { timezone, notifyDays }) {
  const today = todayInTz(timezone);
  const orders = [];

  rows.forEach((cells, i) => {
    const sheetRow = i + 1; // 1-based sheet row
    if (sheetRow === 1) return; // header row

    const label = clean(cells[COL.ORDER]);
    if (!label) return; // empty row

    const deliveryDate = parseDate(cells[COL.DELIVERY_DATE]);
    if (!deliveryDate || deliveryDate.getUTCFullYear() < 2000) return; // junk like 15.03.1900

    orders.push({
      sheetRow,
      label,
      address: clean(cells[COL.ADDRESS]),
      phone: clean(cells[COL.PHONE]),
      item: clean(cells[COL.ITEM]),
      manager: clean(cells[COL.MANAGER]),
      cost: clean(cells[COL.COST]),
      advance: clean(cells[COL.ADVANCE]),
      balance: clean(cells[COL.BALANCE]),
      status: clean(cells[COL.STATUS]),
      deliveryDate,
      deliveryDateStr: formatDate(deliveryDate),
      deliveryDateIso: deliveryDate.toISOString().slice(0, 10),
      daysLeft: Math.round((deliveryDate.getTime() - today.getTime()) / 86_400_000),
      // candidate: 0..notifyDays days left (overdue orders are skipped)
      isCandidate: true,
    });
  });

  return orders;
}

export function selectCandidates(orders, notifyDays) {
  return orders.filter((o) => o.daysLeft >= 0 && o.daysLeft <= notifyDays);
}
