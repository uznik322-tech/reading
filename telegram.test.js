import { test } from 'node:test';
import assert from 'node:assert/strict';
import { format_progress, send_progress, telegram_call } from './telegram.js';

test('Прогресс содержит ориентиры, ограничен по длине и проверяется', () => {
  const text = format_progress({ title: 'Книга', author: 'Автор', percent: 37.2, chapter: 'Глава 8', excerpt: 'Строка '.repeat(5000) });
  assert.match(text, /37\.2%/);
  assert.match(text, /Глава 8/);
  assert.ok(text.length < 2000);
  assert.throws(() => format_progress({ title: 'Книга', percent: -1 }));
  assert.throws(() => format_progress({ title: 'Книга', percent: '37' }));
});

test('Получатель берётся с сервера, токен не попадает в сообщение', async () => {
  const token = 'fake-token';
  let sent;
  await send_progress({ title: 'Книга', percent: 25, chat_id: '999' }, { token, chat_id: '123' }, async (url, options) => {
    assert.equal(url, `https://api.telegram.org/bot${token}/sendMessage`);
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  assert.equal(sent.chat_id, '123');
  assert.ok(!sent.text.includes(token));
});

test('Сетевая ошибка не раскрывает токен; ошибка Telegram не считается успехом', async () => {
  await assert.rejects(telegram_call('secret-token', 'sendMessage', {}, async () => { throw new Error('https://api.telegram.org/botsecret-token/sendMessage'); }), error => !error.message.includes('secret-token'));
  await assert.rejects(telegram_call('test-token', 'sendMessage', {}, async () => ({ ok: false, json: async () => ({ ok: false, error_code: 403 }) })), /Начать/);
});
