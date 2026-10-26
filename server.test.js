import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

test('Без настройки бот недоступен, секреты закрыты, старого API нет', async () => {
  // Изолированная копия без настоящих ключей и пользовательских книг.
  const folder = await mkdtemp(fileURLToPath(new URL('./.test-', import.meta.url)));
  for (const file of ['server.js', 'env.js', 'telegram.js', 'index.html', 'package.json']) await cp(new URL(file, import.meta.url), path.join(folder, file));
  const child = spawn(process.execPath, [path.join(folder, 'server.js')], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', READING_ORIGIN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [output] = await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('Сервер не запустился')), 5000).unref())]);
    const base = /http:\/\/127\.0\.0\.1:\d+/.exec(output.toString())[0];
    const status = await fetch(base + '/api/telegram/status');
    assert.deepEqual(await status.json(), { ready: false });
    assert.equal((await fetch(base + '/api/telegram/progress', { method: 'POST', body: '{}' })).status, 503);
    assert.equal((await fetch(base + '/api/telegram/progress')).status, 405);
    assert.equal((await fetch(base + '/api/telegram/status', { headers: { Origin: 'https://foreign.example' } })).status, 403);
    for (const file of ['.env', '.env.example', 'data/library.json', 'env.js', 'telegram.js', 'setup-bot.js', 'api/books', 'api/session', 'api/progress']) {
      assert.equal((await fetch(base + '/' + file)).status, 404);
    }
    assert.equal((await fetch(base)).status, 200);
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, 'exit');
    await rm(folder, { recursive: true, force: true });
  }
});
