import { config } from '../config.js';

const API_BASE = 'https://api.telegram.org';

async function callApi(method, body, timeoutMs = 15_000) {
  const res = await fetch(`${API_BASE}/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    const description = data?.description || `HTTP ${res.status}`;
    throw new Error(`Telegram ${method} failed: ${description}`);
  }
  return data.result;
}

/**
 * Sends an HTML message to one chat.
 * Returns the Telegram message_id on success, throws on failure.
 */
export async function sendMessage(chatId, text) {
  const result = await callApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return result.message_id;
}

/** Long-poll for incoming updates (commands). Resolves with an array (possibly empty). */
export async function getUpdates(offset, timeoutSec = 25) {
  return callApi(
    'getUpdates',
    { offset, timeout: timeoutSec, allowed_updates: ['message'] },
    (timeoutSec + 10) * 1000,
  );
}

/** Registers the command menu shown in the Telegram UI. */
export async function setMyCommands() {
  return callApi('setMyCommands', {
    commands: [
      { command: 'start', description: 'Почати роботу з ботом' },
      { command: 'add', description: 'Додати цей чат до сповіщень' },
      { command: 'remove', description: 'Вимкнути сповіщення для цього чату' },
      { command: 'help', description: 'Довідка' },
    ],
  });
}
