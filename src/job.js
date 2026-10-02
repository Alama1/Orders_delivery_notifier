import { config } from './config.js';
import { log, logError } from './logger.js';
import { readSettings, readOrdersRows } from './sheets.js';
import {
  parseOrders,
  selectCandidates,
  minutesOfDayInTz,
  isWeekendInTz,
  weekdayInTz,
  todayInTz,
  WEEKDAY_NAMES_UK,
} from './orders.js';
import { buildReminderMessage } from './message.js';
import * as db from './db.js';
import * as telegram from './channels/telegram.js';

// Channel registry — add whatsapp/viber adapters here later.
// Each sender receives (chatId, text) for the specific recipient.
const senders = {
  telegram: (chatId, text) => telegram.sendMessage(chatId, text),
};

function parseNotifyMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

const formatDays = (days) => days.map((d) => WEEKDAY_NAMES_UK[d]).join(', ');

/**
 * One pass: read settings + orders, notify about orders that are
 * within [0..X] days of delivery and haven't been notified yet.
 */
export async function runJob() {
  const summary = { orders: 0, candidates: 0, sent: 0, skipped: 0, failed: 0 };

  // 1. Settings from the sheet (or .env fallback)
  const settings = await readSettings();
  const daysDesc = settings.notifyDaysOfWeek
    ? `days=[${formatDays(settings.notifyDaysOfWeek)}]`
    : `weekends=${settings.weekendNotify ? 'on' : 'off'}`;
  log(
    `[job] settings (${settings.source}): time=${settings.time}` +
      `${settings.endTime ? `–${settings.endTime}` : ''}, days=${settings.days}, ` +
      daysDesc,
  );

  // 2. Day-of-week gate (checkboxes on the «Сповіщати у дні» row)
  const weekday = weekdayInTz(config.timezone);
  if (settings.notifyDaysOfWeek) {
    if (!settings.notifyDaysOfWeek.includes(weekday)) {
      log(
        `[job] ${WEEKDAY_NAMES_UK[weekday]} is not a notification day ` +
          `([${formatDays(settings.notifyDaysOfWeek)}]) — nothing to send today`,
      );
      return summary;
    }
  } else if (!settings.weekendNotify && isWeekendInTz(config.timezone)) {
    // legacy mode: no day checkboxes → weekends are skipped
    log('[job] weekend — notifications paused until the next workday');
    return summary;
  }

  // 3. Work-hours gate: send only inside [start, end]
  const nowMinutes = minutesOfDayInTz(config.timezone);
  const notifyMinutes = parseNotifyMinutes(settings.time);
  if (nowMinutes < notifyMinutes) {
    log(`[job] before notification time (${settings.time} ${config.timezone}) — nothing to do yet`);
    return summary;
  }
  if (settings.endTime && nowMinutes > parseNotifyMinutes(settings.endTime)) {
    log(`[job] outside work hours (after ${settings.endTime} ${config.timezone}) — try again tomorrow`);
    return summary;
  }

  // 4. Orders from the sheet
  const rows = await readOrdersRows();
  const orders = parseOrders(rows, { timezone: config.timezone });
  summary.orders = orders.length;
  const sendDate = todayInTz(config.timezone).toISOString().slice(0, 10);
  const selected = selectCandidates(orders, settings.days);
  // orders confirmed done via the bot stay silent
  const doneKeys = new Set((await db.getDoneOrders()).map((o) => `${o.sheetRow}|${o.deliveryDate}`));
  const candidates = selected.filter((o) => !doneKeys.has(`${o.sheetRow}|${o.deliveryDateIso}`));
  if (selected.length !== candidates.length) {
    log(`[job] ${selected.length - candidates.length} order(s) already marked done — skipping`);
  }
  summary.candidates = candidates.length;
  log(`[job] parsed ${orders.length} valid orders, ${candidates.length} within ${settings.days}-day window`);

  if (candidates.length === 0) return summary;

  // 5. Release reservations stuck by a previous crash
  await db.cleanupStaleReservations();

  // 6. Notify each candidate on every enabled channel, for every active recipient
  for (const channel of config.channels) {
    const recipients = await db.getActiveRecipients(channel);
    if (recipients.length === 0) {
      log(`[job] no active recipients for ${channel} — skipping channel`);
      continue;
    }
    log(`[job] ${recipients.length} recipient(s) on ${channel}: ${recipients.map((r) => r.chatId).join(', ')}`);

    for (const order of candidates) {
      const message = buildReminderMessage(order);

      if (config.dryRun) {
        log(
          `[dry-run] would send via ${channel} to ${recipients.length} recipient(s): ` +
            `row ${order.sheetRow}, ${order.label}, ${order.daysLeft} day(s) left`,
        );
        console.log('--- message preview ---\n' + message + '\n-----------------------');
        continue;
      }

      for (const recipient of recipients) {
        // Dedup is per recipient AND per day: reminders repeat every allowed
        // day until someone confirms the order via the bot.
        const reservationId = await db.reserveNotification({
          sheetRow: order.sheetRow,
          deliveryDate: order.deliveryDateIso,
          orderLabel: order.label,
          daysLeft: order.daysLeft,
          channel,
          recipientId: recipient.id,
          sendDate,
        });

        if (reservationId === null) {
          summary.skipped += 1;
          continue; // already sent/reserved for this recipient
        }

        try {
          const messageId = await senders[channel](recipient.chatId, message);
          await db.confirmNotification(reservationId, messageId);
          summary.sent += 1;
          log(
            `[job] sent via ${channel} to ${recipient.name || recipient.chatId}: ` +
              `row ${order.sheetRow}, ${order.label} (${order.daysLeft} day(s) left)`,
          );
        } catch (err) {
          await db.releaseNotification(reservationId);
          summary.failed += 1;
          logError(
            `[job] send failed via ${channel} to ${recipient.chatId} for row ${order.sheetRow} (${order.label}): ${err.message}`,
          );
        }
      }
    }
  }

  return summary;
}

export async function runJobSafe() {
  try {
    const summary = await runJob();
    log(`[job] done: ${JSON.stringify(summary)}`);
  } catch (err) {
    logError(`[job] failed: ${err.message}`);
    if (err.stack) logError(err.stack.split('\n').slice(1, 3).join('\n'));
  }
}
