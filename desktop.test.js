import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bot_store } from './desktop/service.mjs';

await mkdir(new URL('./.tools/', import.meta.url), { recursive: true });

test('Привязка Windows сохраняет только подтверждённый личный чат и отправляет прогресс ему', async () => {
  const folder = await mkdtemp(fileURLToPath(new URL('./.tools/desktop-test-', import.meta.url)));
  const file = path.join(folder, 'telegram.bin');
  const calls = [];
  let code;
  let now = 1000;
  const store = new bot_store({ file, available: () => true, clock: () => now,
    // Подмена шифрования для теста логики; в программе используется safeStorage Windows.
    encrypt: value => Buffer.from(value).reverse(), decrypt: bytes => Buffer.from(bytes).reverse().toString(),
    request: async (token, method, payload) => {
      calls.push({ token, method, payload });
      if (method === 'getMe') return { username: 'reading_test_bot' };
      if (method === 'getUpdates') return [
        { update_id: 1, message: { text: code, chat: { type: 'group', id: -123 } } },
        { update_id: 2, message: { text: code, chat: { type: 'private', id: 123 } } }
      ];
      return { message_id: 1 };
    }
  });
  const token = '123456:fake_token_for_desktop_test_123';
  try {
    assert.deepEqual(await store.get_state(), { ready: false });
    const pending = await store.start_pairing({ token }); code = pending.code;
    assert.ok(!JSON.stringify(pending).includes(token));
    await store.finish_pairing();
    assert.ok(!(await readFile(file)).includes(Buffer.from(token)));
    assert.deepEqual(await store.get_state(), { ready: true });
    await store.send_progress({ title: 'Книга', percent: 42.5, chat_id: '999' });
    const sent = calls.find(call => call.method === 'sendMessage');
    assert.equal(sent.payload.chat_id, '123');
    assert.match(sent.payload.text, /42\.5%/);
    await assert.rejects(store.send_progress({ title: 'Книга', percent: 1 }), /10 секунд/);
    now += 11000;
    await store.clear_config();
    assert.deepEqual(await store.get_state(), { ready: false });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Windows не сохраняет токен без защищённого хранилища и не раскрывает повреждённые данные', async () => {
  const folder = await mkdtemp(fileURLToPath(new URL('./.tools/desktop-test-', import.meta.url)));
  try {
    const file = path.join(folder, 'telegram.bin');
    const store = new bot_store({ file, available: () => false });
    await assert.rejects(store.start_pairing({ token: '123456:fake_token_for_desktop_test_123' }), /хранилище Windows/);
    await writeFile(file, 'corrupted');
    await assert.rejects(store.get_state(), /расшифровать/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Windows-адаптер использует закрытый мост, сохраняя FB2 и сообщения локально', async () => {
  const original = globalThis.reading_desktop;
  const original_fetch = globalThis.fetch;
  const calls = [];
  globalThis.reading_desktop = {
    platform: 'windows', get_state: async () => ({ ready: true }),
    send_progress: async payload => { calls.push(payload); return { ok: true }; },
    pick_book: async () => ({ name: 'test.fb2', data: Buffer.from('<FictionBook/>').toString('base64') }),
    on_pause: () => () => {}
  };
  globalThis.fetch = () => { throw new Error('Не должно быть запроса к серверу'); };
  try {
    const platform = await import('./platform.js?desktop-test');
    assert.equal(platform.is_desktop, true); assert.equal(platform.is_local, true);
    assert.deepEqual(await platform.telegram_status(), { ready: true });
    await platform.send_telegram({ title: 'Книга', percent: 10 });
    assert.equal(calls[0].percent, 10);
    assert.equal(await (await platform.pick_book()).text(), '<FictionBook/>');
  } finally { globalThis.reading_desktop = original; globalThis.fetch = original_fetch; }
});
