import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import './env.js';
import { format_progress, send_progress } from './telegram.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3188);
const config = { token: process.env.TELEGRAM_BOT_TOKEN, chat_id: process.env.TELEGRAM_CHAT_ID };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.fb2': 'application/xml; charset=utf-8' };
const assets = new Set(['index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'sw.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'sample.fb2']);
let next_send = 0;

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('Слишком большой запрос');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const origin = `http://${req.headers.host}`;
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== process.env.READING_ORIGIN)) return reply(res, 403, { error: 'Недопустимый источник запроса' });
      if (url.pathname === '/api/telegram/status' && req.method === 'GET') return reply(res, 200, { ready: Boolean(config.token && /^[1-9]\d*$/.test(config.chat_id || '')) });
      if (url.pathname !== '/api/telegram/progress') return reply(res, 404, { error: 'Не найдено' });
      if (req.method !== 'POST') return reply(res, 405, { error: 'Метод не поддерживается' });
      if (!config.token || !/^[1-9]\d*$/.test(config.chat_id || '')) return reply(res, 503, { error: 'Бот ещё не настроен. Заполни .env и выполни node setup-bot.js.' });
      const input = await body(req);
      format_progress(input);
      if (Date.now() < next_send) return reply(res, 429, { error: 'Подожди несколько секунд перед повторной отправкой.' });
      // Ограничение общее: несколько устройств не смогут засыпать личный чат сообщениями.
      next_send = Date.now() + 10000;
      try {
        await send_progress(input, config);
        return reply(res, 200, { ok: true });
      } catch (error) { return reply(res, 502, { error: error.message }); }
    }
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: 'Метод не поддерживается' });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!assets.has(name)) return reply(res, 404, { error: 'Не найдено' });
    const content = await readFile(path.join(root, name));
    res.writeHead(200, { 'Content-Type': types[path.extname(name)] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { if (!res.headersSent) reply(res, 400, { error: 'Не удалось обработать запрос. Проверь данные прогресса.' }); else res.end(); }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Останови прежний сервер или задай другой PORT.` : 'Не удалось запустить сервер.');
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Читалка: http://${host}:${server.address().port}\nTelegram: ${config.token && config.chat_id ? 'настроен' : 'нужна настройка .env и node setup-bot.js'}`));
