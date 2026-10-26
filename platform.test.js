import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

test('Android-ресурсы собираются без серверных файлов и секретов', async () => {
  execFileSync(process.execPath, ['build-web.js'], { cwd: new URL('.', import.meta.url), env: { ...process.env, TELEGRAM_BOT_TOKEN: 'do-not-bundle-this-test-secret' } });
  const files = (await readdir(new URL('./www/', import.meta.url))).sort();
  assert.deepEqual(files, ['app.js', 'capacitor-core.js', 'icon-192.png', 'icon-512.png', 'icon.svg', 'index.html', 'platform.js', 'sample.fb2', 'style.css', 'telegram.js'].sort());
  for (const file of files) assert.ok(!(await readFile(new URL('./www/' + file, import.meta.url))).includes(Buffer.from('do-not-bundle-this-test-secret')));
  assert.ok(!(await readFile(new URL('./www/index.html', import.meta.url), 'utf8')).includes('rel="manifest"'));
});

test('APK использует нативный мост вместо серверного API', async () => {
  const calls = [];
  const original_capacitor = globalThis.Capacitor;
  const original_android_bridge = globalThis.androidBridge;
  const original_fetch = globalThis.fetch;
  // Моделируем именно встроенный мост, где ещё нет registerPlugin.
  globalThis.androidBridge = {};
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    PluginHeaders: [{ name: 'ReadingNative', methods: ['get_state', 'send_progress', 'pick_book'].map(name => ({ name, rtype: 'promise' })) }],
    nativePromise: async (plugin, method, input) => {
      assert.equal(plugin, 'ReadingNative');
      if (method === 'get_state') return { ready: true };
      if (method === 'send_progress') { calls.push(input); return { ok: true }; }
      if (method === 'pick_book') return { name: 'test.fb2', data: Buffer.from('<FictionBook/>').toString('base64') };
      throw new Error('Неожиданный нативный метод');
    }
  };
  globalThis.fetch = () => { throw new Error('APK не должен обращаться к серверу'); };
  try {
    const platform = await import('./www/platform.js?native-test');
    assert.equal(platform.is_native, true);
    assert.deepEqual(await platform.telegram_status(), { ready: true });
    await platform.send_telegram({ title: 'Книга', percent: 37.2 });
    assert.match(calls[0].text, /37\.2%/);
    const file = await platform.pick_book();
    assert.equal(file.name, 'test.fb2');
    assert.equal(await file.text(), '<FictionBook/>');
  } finally { globalThis.Capacitor = original_capacitor; globalThis.androidBridge = original_android_bridge; globalThis.fetch = original_fetch; }
});

test('PWA продолжает обращаться к своему серверу', async () => {
  const original_fetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ready: true, ok: true }) }; };
  try {
    const platform = await import('./platform.js?web-test');
    assert.equal(platform.is_native, false);
    assert.equal((await platform.telegram_status()).ready, true);
    await platform.send_telegram({ title: 'Книга', percent: 20 });
    assert.deepEqual(calls.map(call => call.url), ['/api/telegram/status', '/api/telegram/progress']);
  } finally { globalThis.fetch = original_fetch; }
});
