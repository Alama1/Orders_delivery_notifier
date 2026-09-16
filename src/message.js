import { formatDate } from './orders.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const line = (label, value) => (value ? `${label} ${esc(value)}` : null);

/** Ukrainian plural: 1 день, 2/3/4 дні, 5+ днів */
export function uaDays(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  const word =
    m10 === 1 && m100 !== 11 ? 'день' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'дні' : 'днів';
  return `${n} ${word}`;
}

function dueText(days) {
  if (days === 0) return 'сьогодні';
  if (days === 1) return 'завтра';
  if (days < 0) return `прострочено на ${uaDays(-days)}`;
  return `через ${uaDays(days)}`;
}

/** Builds the HTML reminder text for one order (Telegram-safe). */
export function buildReminderMessage(order) {
  const parts = [
    '<b>🔔 Нагадування про здачу замовлення</b>',
    '',
    `${esc(order.label)}${order.item ? ` — ${esc(order.item)}` : ''}`,
    `📅 Дата здачі: <b>${formatDate(order.deliveryDate)}</b> (${dueText(order.daysLeft)})`,
    line('📍 Адреса:', order.address),
    line('📞 Телефон:', order.phone),
    line('👤 Менеджер:', order.manager),
    line('📦 Статус:', order.status),
    line('💰 Залишок:', order.balance),
  ];
  return parts.filter((p) => p !== null).join('\n');
}
