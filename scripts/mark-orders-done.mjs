/**
 * One-off helper: marks every order currently inside the notification window
 * as done, so it stops (or never starts) pinging — e.g. before switching the
 * production DB to the new "repeat daily" logic.
 *
 *   node scripts/mark-orders-done.mjs          # dry run: shows what would happen
 *   node scripts/mark-orders-done.mjs --yes    # apply
 *
 * Uses the same .env / GOOGLE_* credentials as the app — run it with the env
 * of the database you are switching to. Orders are read from the orders tab;
 * an order counts as "current" when 0 ≤ days_left ≤ NOTIFY window from the
 * «Налаштування» tab. Already-done orders are skipped (idempotent).
 */
import { config } from '../src/config.js';
import * as db from '../src/db.js';
import { readSettings, readOrdersRows } from '../src/sheets.js';
import { parseOrders, selectCandidates, todayInTz } from '../src/orders.js';
import { log } from '../src/logger.js';

const apply = process.argv.includes('--yes');

async function main() {
  const settings = await readSettings();
  const rows = await readOrdersRows();
  const orders = parseOrders(rows, { timezone: config.timezone });
  const candidates = selectCandidates(orders, settings.days);

  const doneKeys = new Set((await db.getDoneOrders()).map((o) => `${o.sheetRow}|${o.deliveryDate}`));
  const targets = candidates.filter((o) => !doneKeys.has(`${o.sheetRow}|${o.deliveryDateIso}`));

  console.log(
    `[mark-done] db=${config.db.name}, window=${settings.days}d — ` +
      `orders: ${orders.length}, in window: ${candidates.length}, ` +
      `already done: ${candidates.length - targets.length}, to mark: ${targets.length}`,
  );
  for (const o of targets) {
    console.log(`  row ${o.sheetRow}: ${o.label}, здача ${o.deliveryDateStr} (${o.daysLeft} d)`);
  }
  if (!apply) {
    console.log('[mark-done] dry run — re-run with --yes to apply');
    return;
  }
  if (targets.length === 0) {
    console.log('[mark-done] nothing to do');
    return;
  }

  await db.ensureDatabase();
  await db.ensureSchema();

  const sendDate = todayInTz(config.timezone).toISOString().slice(0, 10);
  let flagged = 0;
  let markers = 0;
  for (const o of targets) {
    // rows already exist (order was notified before) → flag them done
    const flaggedRows = await db.markOrderDone({
      sheetRow: o.sheetRow,
      deliveryDate: o.deliveryDateIso,
      doneBy: 'bulk: mark-orders-done',
    });
    if (flaggedRows > 0) {
      flagged += 1;
      continue;
    }
    // never notified → insert a done-marker so the job skips it
    for (const channel of config.channels) {
      await db.insertDoneMarker({
        sheetRow: o.sheetRow,
        deliveryDate: o.deliveryDateIso,
        orderLabel: o.label,
        daysLeft: o.daysLeft,
        channel,
        sendDate,
        doneBy: 'bulk: mark-orders-done',
      });
    }
    markers += 1;
  }
  log(`[mark-done] flagged ${flagged} order(s) on existing rows, inserted ${markers} done-marker(s)`);
  await db.closeDb();
}

main().catch((err) => {
  console.error(`[mark-done] failed: ${err.message}`);
  process.exit(1);
});
