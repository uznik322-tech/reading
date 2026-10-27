const { app, BrowserWindow, protocol, ipcMain, dialog, shell, safeStorage, session } = require('electron');
const { mkdirSync } = require('node:fs');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');

const origin = 'reading://app';
const root = path.resolve(__dirname, '..');
const smoke_test = process.argv.includes('--reading-smoke-test');
// Профиль задаём до ready: Chromium не создаёт данные в системном AppData.
const profile = smoke_test ? app.isPackaged ? path.join(path.dirname(process.execPath), 'smoke-profile') : path.join(root, '.tools/desktop-smoke-profile') : app.isPackaged ? path.join(path.dirname(process.execPath), 'reading-data') : path.join(root, '.tools/desktop-profile');
mkdirSync(profile, { recursive: true });
for (const name of ['session', 'logs', 'crashes']) mkdirSync(path.join(profile, name), { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.setPath('logs', path.join(profile, 'logs'));
app.setPath('crashDumps', path.join(profile, 'crashes'));
app.setName('Между строк');
app.setAppUserModelId('tech.uznik322.reading');
protocol.registerSchemesAsPrivileged([{ scheme: 'reading', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let window;
let quitting = false;
const allowed_assets = new Set(['index.html', 'app.js', 'platform.js', 'telegram.js', 'style.css', 'icon.svg', 'icon-192.png', 'icon-512.png', 'sample.fb2']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.fb2': 'application/xml' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function trusted(url) {
  try { const value = new URL(url); return value.protocol === 'reading:' && value.hostname === 'app' && !value.port && !value.username && !value.password; } catch { return false; }
}
function open_bot(url) {
  try {
    const value = new URL(url);
    if (value.protocol === 'https:' && value.hostname === 't.me' && !value.port && !value.username && !value.password && /^\/[A-Za-z0-9_]{5,32}$/.test(value.pathname) && !value.search && !value.hash) void shell.openExternal(value.href).catch(() => {});
  } catch {}
}
function handle(name, fn) {
  ipcMain.handle('reading:' + name, async (event, input) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted(event.senderFrame.url)) throw new Error('Недопустимый источник запроса');
    try { return await fn(input); }
    catch (error) { throw new Error(error.message.replace('в .env.', 'в настройках программы.')); }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    const { bot_store } = await import('./service.mjs');
    const store = new bot_store({
      file: path.join(profile, 'telegram.bin'),
      encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes),
      available: () => safeStorage.isEncryptionAvailable()
    });
    protocol.handle('reading', async request => {
      const url = new URL(request.url);
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!trusted(request.url) || !['GET', 'HEAD'].includes(request.method) || !allowed_assets.has(name)) return new Response('Не найдено', { status: 404 });
      try {
        const bytes = await readFile(path.join(root, 'web', name));
        return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'Content-Type': types[path.extname(name)], 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
      } catch { return new Response('Не удалось открыть ресурс', { status: 404 }); }
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !trusted(details.url) && !details.url.startsWith('data:') && !details.url.startsWith('blob:') }));
    handle('get_state', () => store.get_state());
    handle('start_pairing', input => store.start_pairing(input));
    handle('finish_pairing', () => store.finish_pairing());
    handle('clear_config', () => store.clear_config());
    handle('send_progress', payload => store.send_progress(payload));
    ipcMain.on('reading:pause_done', (event, reason) => {
      if (quitting && reason === 'close' && window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && trusted(event.senderFrame.url)) app.quit();
    });
    handle('pick_book', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Выбери книгу FB2', properties: ['openFile'], filters: [{ name: 'Книги FB2', extensions: ['fb2'] }] });
      if (result.canceled || result.filePaths.length !== 1) return { cancelled: true };
      const file = result.filePaths[0];
      if (path.extname(file).toLowerCase() !== '.fb2' || (await stat(file)).size > 16 * 1024 * 1024) throw new Error('Выбери FB2 размером до 16 МБ.');
      const bytes = await readFile(file);
      if (bytes.length > 16 * 1024 * 1024) throw new Error('Книга больше 16 МБ.');
      return { name: path.basename(file), data: bytes.toString('base64') };
    });
    window = new BrowserWindow({ width: 1200, height: 850, minWidth: 650, minHeight: 500, show: false, backgroundColor: '#f4f1ea', icon: path.join(root, 'web/icon-192.png'), autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false, spellcheck: false }
    });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(({ url }) => { open_bot(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) { event.preventDefault(); open_bot(url); } });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.on('blur', () => { if (!window.isDestroyed()) window.webContents.send('reading:pause'); });
    window.on('close', event => {
      if (!quitting) {
        event.preventDefault(); quitting = true;
        // Даём IndexedDB завершить запись перед закрытием окна.
        window.webContents.send('reading:pause', 'close');
        setTimeout(() => app.quit(), 5000).unref();
      }
    });
    window.once('ready-to-show', () => { if (!smoke_test) window.show(); });
    await window.loadURL(origin + '/');
    if (smoke_test) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище Windows недоступно');
      const encrypted = safeStorage.encryptString('reading-smoke-check');
      if (encrypted.includes(Buffer.from('reading-smoke-check')) || safeStorage.decryptString(encrypted) !== 'reading-smoke-check') throw new Error('Не пройдена проверка шифрования');
      const result = await window.webContents.executeJavaScript(`(async () => {
        const bridge = window.reading_desktop;
        if (!bridge || bridge.platform !== 'windows') throw new Error('Не загружен мост Windows');
        const platform = await import('/platform.js');
        if (!platform.is_desktop || !platform.is_local) throw new Error('Не определена платформа');
        const state = await platform.telegram_status();
        if (state.ready) throw new Error('В тестовый профиль попали секреты');
        const content = await (await fetch('/sample.fb2')).text();
        const xml = new DOMParser().parseFromString(content, 'application/xml');
        if (xml.querySelector('parsererror')) throw new Error('Не прочитан FB2');
        if (!crypto.subtle) throw new Error('Нет безопасного контекста');
        const db = await new Promise((resolve, reject) => { const req = indexedDB.open('desktop-check', 1); req.onupgradeneeded = () => req.result.createObjectStore('check'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        await new Promise((resolve, reject) => { const tx = db.transaction('check', 'readwrite'); tx.objectStore('check').put('saved', 'position'); tx.oncomplete = resolve; tx.onerror = reject; });
        db.close();
        const wait = async predicate => { const until = Date.now() + 5000; while (!predicate()) { if (Date.now() > until) throw new Error('Интерфейс не готов'); await new Promise(resolve => setTimeout(resolve, 50)); } };
        document.getElementById('sample-button').click();
        await wait(() => document.querySelector('#books .book'));
        document.querySelector('#books .book').click();
        await wait(() => !document.getElementById('reader-view').hidden);
        await new Promise(resolve => setTimeout(resolve, 150));
        if (!document.getElementById('reader-content').textContent.includes('Тихое утро')) throw new Error('Не открыт текст FB2');
        document.getElementById('jump-percent').value = '37.2';
        document.getElementById('jump-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 200));
        if (!/^\\d+,\\d%$/.test(document.getElementById('reader-percent').textContent)) throw new Error('Не отображаются десятые процента');
        document.getElementById('back-button').click();
        await wait(() => !document.getElementById('library-view').hidden);
        const messages = await import('/telegram.js');
        const sample_id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))).map(byte => byte.toString(16).padStart(2, '0')).join('');
        const resume_message = messages.format_progress({ title: 'В своём ритме', author: 'Тестовая библиотека', percent: 37.2, excerpt: 'Тихое утро начиналось с открытого окна.', anchor: { book_id: sample_id, block: 10, offset: 0.25 } });
        document.getElementById('resume-button').click();
        document.getElementById('resume-message').value = resume_message;
        document.getElementById('resume-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await wait(() => document.getElementById('toast').textContent.includes('по метке'));
        if (document.getElementById('reader-view').hidden) throw new Error('Не открыто место из сообщения');
        document.getElementById('back-button').click();
        await wait(() => !document.getElementById('library-view').hidden);
        document.getElementById('telegram-button').click();
        await wait(() => document.getElementById('telegram-dialog').open);
        if (document.getElementById('native-config').hidden) throw new Error('Не открыта настройка Telegram');
        if (typeof require !== 'undefined' || typeof process !== 'undefined') throw new Error('Node.js доступен интерфейсу');
        return { bridge: true, fb2: true, indexeddb: true, secure: true, sandbox: true, crypto: true, resume: true };
      })()`);
      await write_smoke(result);
      window.close();
    }
  }).catch(async () => { if (smoke_test) await write_smoke({ error: 'Проверка запуска не пройдена' }); else dialog.showErrorBox('Между строк', 'Не удалось запустить программу. Проверь доступ на запись к папке reading-data.'); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
async function write_smoke(result) { const { writeFile } = require('node:fs/promises'); await writeFile(path.join(profile, 'smoke-result.json'), JSON.stringify(result)); }
