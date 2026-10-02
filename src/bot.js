import { log, logError } from './logger.js';
import * as telegram from './channels/telegram.js';
import {
  addRecipient,
  deactivateRecipient,
  findOrderByMessageId,
  markOrderDone,
  storeAckMessage,
  undoOrderDone,
  getDoneOrdersDetailed,
} from './db.js';
import { escapeHtml } from './message.js';
import { formatDate } from './orders.js';

const HELP_TEXT = [
  '<b>🤖 Бот сповіщень про здачу замовлень</b>',
  '',
  'Надсилає нагадування в Telegram, коли до дати здачі замовлення',
  'залишається вказана кількість днів (див. вкладку «Налаштування» у таблиці).',
  'Нагадування повторюються кожного дозволеного дня, доки замовлення',
  'не позначать виконаним.',
  '',
  '<b>Команди:</b>',
  '/add — додати цей чат (особистий або групу) до списку сповіщень',
  '/remove — вимкнути сповіщення для цього чату',
  '/undo — поновити нагадування для виконаного замовлення',
  '/help — довідка',
  '',
  '<b>Позначити замовлення виконаним:</b> відповідьте на нагадування',
  'чимось на кшталт «Готово», «Виконано», «+» — бот підтвердить і зупинить',
  'сповіщення по цьому замовленню для всіх.',
  '',
  '<b>Поновити нагадування:</b> /undo зі списком, /undo &lt;рядок&gt;,',
  'або відповідайте /undo на нагадування цього замовлення.',
].join('\n');

function chatName(chat, from) {
  if (chat.title) return chat.title; // groups
  return [from?.first_name, from?.last_name].filter(Boolean).join(' ') || chat.username || null;
}

function parseCommand(text) {
  // supports "/add", "/add@MyBotName"
  const raw = text.trim().split(/\s+/)[0];
  if (!raw.startsWith('/')) return null;
  return raw.slice(1).split('@')[0].toLowerCase();
}

// Words that count as "order done" when replied to a reminder.
const CONFIRM_EXACT = new Set([
  '+', 'ок', 'ok', 'окей', 'okay', 'да', 'так', 'yes', 'yep', 'done', '✅', '👍',
]);
// Past-tense/participle forms only, so «заберемо завтра»/«віддам» don't confirm.
const CONFIRM_PREFIX = /^(готов|виконан|забрал|видан|вида[нл]|відда[нл]|отрима[нлв]|получ[ил]|переда[нл])/;

/** True for confirmation-like text: «Готово», «Виконано», «+», «Ок»… */
export function isConfirmationText(text) {
  const first = String(text).trim().split(/\s+/)[0]?.toLowerCase().replace(/[.,!?:;'"()]+$/, '') ?? '';
  return first.startsWith('+') || CONFIRM_EXACT.has(first) || CONFIRM_PREFIX.test(first);
}

/**
 * A reply to a reminder message with confirmation-like text marks the order
 * as done — for every recipient — and gets an acknowledgment back.
 */
async function handleReminderReply(msg, chatId, who) {
  const reply = msg.reply_to_message;
  if (!reply || !isConfirmationText(msg.text)) return; // ordinary chatter — ignore

  const order = await findOrderByMessageId({ channel: 'telegram', chatId, messageId: reply.message_id });
  if (!order) return; // reply to a non-reminder bot message — ignore

  const label = escapeHtml(order.orderLabel);
  const due = formatDate(new Date(`${order.deliveryDate}T00:00:00Z`));
  let alreadyDone = Boolean(order.done);
  if (!alreadyDone) {
    // another recipient may have confirmed the same order in parallel
    alreadyDone = (await markOrderDone({
      sheetRow: order.sheetRow,
      deliveryDate: order.deliveryDate,
      doneBy: who ? `${who} (${chatId})` : chatId,
    })) === 0;
  }

  const text = alreadyDone
    ? `ℹ️ Замовлення ${label} (здача ${due}) вже було позначено виконаним.`
    : `✅ Замовлення ${label} (здача ${due}) позначено <b>виконаним</b> — нагадування по ньому більше надсилатися не будуть.\n(Поновити: /undo)`;
  const ackId = await telegram.sendMessage(chatId, text, { replyTo: msg.message_id });
  await storeAckMessage({
    channel: 'telegram', chatId, messageId: ackId,
    sheetRow: order.sheetRow, deliveryDate: order.deliveryDate, orderLabel: order.orderLabel,
  });
  log(`[bot] confirmation from ${chatId} ("${who}") for row ${order.sheetRow} (${order.orderLabel}) -> ${alreadyDone ? 'already done' : 'marked done'}`);
}

/** Clears the done flag for one order and confirms back to the chat. */
async function undoAndConfirm(sheetRow, chatId) {
  // label for the reply — from the done rows themselves
  const known = (await getDoneOrdersDetailed(500)).find((o) => o.sheetRow === sheetRow);
  if (!known) {
    await telegram.sendMessage(chatId, `ℹ️ Серед позначених виконаними замовлень за рядком ${sheetRow} не знайдено.`);
    return;
  }
  await undoOrderDone(sheetRow);
  const label = escapeHtml(known.orderLabel);
  const due = formatDate(new Date(`${known.deliveryDate}T00:00:00Z`));
  const ackId = await telegram.sendMessage(
    chatId,
    `🔓 Нагадування для ${label} (здача ${due}, рядок ${sheetRow}) <b>поновлено</b> — ` +
      'наступного дозволеного дня вони надійдуть знову.',
  );
  await storeAckMessage({
    channel: 'telegram', chatId, messageId: ackId,
    sheetRow, deliveryDate: known.deliveryDate, orderLabel: known.orderLabel,
  });
  log(`[bot] /undo ${chatId} -> row ${sheetRow} (${known.orderLabel}) resumed`);
}

/** /undo [row] — resume reminders; without args shows the done list. */
async function handleUndo(msg, chatId) {
  const reply = msg.reply_to_message;
  if (reply) {
    const order = await findOrderByMessageId({ channel: 'telegram', chatId, messageId: reply.message_id });
    if (!order) {
      await telegram.sendMessage(chatId, 'ℹ️ Це не нагадування про замовлення. Скористайтеся /undo без аргументів.');
      return;
    }
    await undoAndConfirm(order.sheetRow, chatId);
    return;
  }

  const arg = msg.text.trim().split(/\s+/)[1];
  if (arg && /^\d+$/.test(arg)) {
    await undoAndConfirm(Number.parseInt(arg, 10), chatId);
    return;
  }

  const done = await getDoneOrdersDetailed(15);
  if (done.length === 0) {
    await telegram.sendMessage(chatId, 'ℹ️ Позначених виконаними замовлень поки немає.');
    return;
  }
  const lines = done.map((o) => {
    const due = formatDate(new Date(`${o.deliveryDate}T00:00:00Z`));
    const by = o.doneBy ? ` — ${escapeHtml(o.doneBy)}` : '';
    return `${o.sheetRow} — ${escapeHtml(o.orderLabel)}, здача ${due}${by}`;
  });
  await telegram.sendMessage(
    chatId,
    [
      '<b>🔓 Позначені виконаними</b> (поновити: /undo &lt;рядок&gt;):',
      '',
      ...lines,
      '',
      done.length >= 15 ? 'Список обмежено 15 останніми.' : '',
    ].filter(Boolean).join('\n'),
  );
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.chat || !msg.text) return;

  const chatId = String(msg.chat.id);
  const name = chatName(msg.chat, msg.from);
  const username = msg.from?.username || null;

  const command = parseCommand(msg.text);
  if (!command) {
    await handleReminderReply(msg, chatId, name || username); // replies to reminders (e.g. «Готово»)
    return; // ignore ordinary messages
  }

  switch (command) {
    case 'start':
    case 'help':
      await telegram.sendMessage(chatId, HELP_TEXT);
      break;

    case 'add': {
      const result = await addRecipient({ channel: 'telegram', chatId, name, username });
      const reply = {
        added: '✅ Цей чат додано до списку сповіщень про здачу замовлень.',
        reactivated: '✅ Сповіщення для цього чату знову увімкнено.',
        exists: 'ℹ️ Цей чат вже є у списку сповіщень.',
      }[result];
      await telegram.sendMessage(chatId, reply);
      log(`[bot] /add ${chatId} ("${name}") -> ${result}`);
      break;
    }

    case 'remove': {
      const removed = await deactivateRecipient('telegram', chatId);
      await telegram.sendMessage(
        chatId,
        removed
          ? '🔕 Сповіщення для цього чату вимкнено.'
          : 'ℹ️ Цього чату немає в списку (або сповіщення вже вимкнено).',
      );
      log(`[bot] /remove ${chatId} -> ${removed ? 'deactivated' : 'not found'}`);
      break;
    }

    case 'undo':
      await handleUndo(msg, chatId);
      break;

    default:
      await telegram.sendMessage(chatId, `Невідома команда. Доступні: /add, /remove, /undo, /help`);
      break;
  }
}

/**
 * Long-polling loop that processes bot commands.
 * Resolves when abortSignal fires; designed to run in the background.
 */
export async function runPoller(abortSignal) {
  try {
    await telegram.setMyCommands();
  } catch (err) {
    log(`[bot] setMyCommands failed (non-fatal): ${err.message}`);
  }

  let offset = 0;
  log('[bot] polling for commands…');

  while (!abortSignal.aborted) {
    let updates;
    try {
      updates = await telegram.getUpdates(offset > 0 ? offset : undefined, 25);
    } catch (err) {
      if (abortSignal.aborted) break;
      logError(`[bot] getUpdates failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      try {
        await handleUpdate(update);
      } catch (err) {
        logError(`[bot] failed to handle update ${update.update_id}: ${err.message}`);
      }
    }
  }

  log('[bot] poller stopped');
}
