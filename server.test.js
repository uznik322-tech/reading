import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

test('Доступ, синхронизация и защита от перезаписи прогресса', async () => {
  // Проверка использует отдельную временную копию и не затрагивает библиотеку.
  const folder = await mkdtemp(fileURLToPath(new URL('./.test-', import.meta.url)));
  await cp(new URL('./server.js', import.meta.url), path.join(folder, 'server.mjs'));
  await cp(new URL('./index.html', import.meta.url), path.join(folder, 'index.html'));
  const child = spawn(process.execPath, [path.join(folder, 'server.mjs')], { env: { ...process.env, PORT: '3097', HOST: '127.0.0.1', READING_PASSWORD: 'test-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('Сервер не запустился')), 5000).unref())]);
    const base = 'http://127.0.0.1:3097';
    assert.equal((await fetch(`${base}/api/books`)).status, 401);
    const login = await fetch(`${base}/api/session`, { method: 'POST', body: JSON.stringify({ password: 'test-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const request = (url, value) => fetch(`${base}${url}`, { method: value ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: value ? JSON.stringify(value) : undefined });
    const book = { id: 'a'.repeat(64), title: 'Книга', xml: '<FictionBook/>', author: 'Автор' };
    assert.equal((await request('/api/books', { book })).status, 200);
    const progress = { block: 3, offset: 0.2, percent: 15 };
    const saved = await request('/api/progress', { id: book.id, revision: 0, progress });
    assert.equal((await saved.json()).book.revision, 1);
    const conflict = await request('/api/progress', { id: book.id, revision: 0, progress: { ...progress, percent: 5 } });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).book.progress.percent, 15);
    const catalog = await request('/api/books');
    assert.equal((await catalog.json())[book.id].progress.block, 3);
    assert.equal((await fetch(`${base}/data/library.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/books`, { headers: { Cookie: cookie, Origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/session`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);
    assert.equal((await request('/api/books')).status, 401);
  } finally {
    child.kill(); await once(child, 'exit');
    await rm(folder, { recursive: true, force: true });
  }
});
