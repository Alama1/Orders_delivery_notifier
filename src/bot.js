import { log, logError } from './logger.js';
import * as telegram from './channels/telegram.js';
import { addRecipient, deactivateRecipient } from './db.js';

const HELP_TEXT = [
  '<b>🤖 Бот сповіщень про здачу замовлень</b>',
  '',
  'Надсилає нагадування в Telegram, коли до дати здачі замовлення',
  'залишається вказана кількість днів (див. вкладку «Налаштування» у таблиці).',
  '',
  '<b>Команди:</b>',
  '/add — додати цей чат (особистий або групу) до списку сповіщень',
  '/remove — вимкнути сповіщення для цього чату',
  '/help — довідка',
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

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.chat || !msg.text) return;

  const command = parseCommand(msg.text);
  if (!command) return; // ignore ordinary messages

  const chatId = String(msg.chat.id);
  const name = chatName(msg.chat, msg.from);
  const username = msg.from?.username || null;

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

    default:
      await telegram.sendMessage(chatId, `Невідома команда. Доступні: /add, /remove, /help`);
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
