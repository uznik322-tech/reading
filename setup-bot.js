import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { env_path } from './env.js';
import { telegram_call } from './telegram.js';

try {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Сначала заполни TELEGRAM_BOT_TOKEN в .env. Если файла нет, скопируй .env.example.');
  const bot = await telegram_call(token, 'getMe');
  const code = 'reading-' + randomBytes(8).toString('hex');
  console.log(`Открой https://t.me/${bot.username}, нажми «Начать» и отправь в личный чат это сообщение:\n${code}\nОжидаю до двух минут…`);
  const deadline = Date.now() + 120000;
  let offset = 0;
  let chat_id;
  while (Date.now() < deadline && !chat_id) {
    const updates = await telegram_call(token, 'getUpdates', { offset, timeout: 15, allowed_updates: ['message'] });
    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message?.chat.type === 'private' && update.message.text?.trim() === code) chat_id = String(update.message.chat.id);
    }
  }
  if (!chat_id) throw new Error('Код не получен. Запусти настройку снова.');
  let content;
  try { content = await readFile(env_path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; content = ''; }
  if (/^TELEGRAM_CHAT_ID\s*=/m.test(content)) content = content.replace(/^TELEGRAM_CHAT_ID\s*=.*$/m, `TELEGRAM_CHAT_ID=${chat_id}`);
  else content += `\nTELEGRAM_CHAT_ID=${chat_id}\n`;
  await writeFile(env_path, content, { mode: 0o600 });
  console.log('Готово: личный чат привязан в .env. Перезапусти сервер и отправь прогресс кнопкой в читалке.');
} catch (error) {
  console.error(error.message.startsWith('Telegram:') || /^(Сначала|Код не получен|Не удалось загрузить)/.test(error.message) ? error.message : 'Не удалось завершить настройку. Проверь .env и доступ к Telegram.');
  process.exitCode = 1;
}
