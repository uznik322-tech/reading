import http from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.join(root, 'data');
await mkdir(data, { recursive: true });
const password = process.env.READING_PASSWORD;
const sessions = new Map();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3188);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.fb2': 'application/xml; charset=utf-8' };
let queue = Promise.resolve();

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('Файл слишком большой: максимум 32 МБ');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function library() {
  try { return JSON.parse(await readFile(path.join(data, 'library.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function mutate(fn) {
  const task = queue.then(async () => {
    const books = await library();
    const result = fn(books);
    await writeFile(path.join(data, 'library.tmp'), JSON.stringify(books));
    await rename(path.join(data, 'library.tmp'), path.join(data, 'library.json'));
    return result;
  });
  queue = task.catch(() => {});
  return task;
}
const attempts = new Map();
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}` && req.headers.origin !== process.env.READING_ORIGIN)) return reply(res, 403, { error: 'Недопустимый источник запроса' });
      if (url.pathname === '/api/session' && req.method === 'POST') {
        if (!password) return reply(res, 503, { error: 'На сервере не задан READING_PASSWORD. Локальная библиотека доступна без входа.' });
        const ip = req.socket.remoteAddress;
        const attempt = attempts.get(ip) || { count: 0, until: Date.now() + 60000 };
        if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 60000; }
        if (++attempt.count > 10) return reply(res, 429, { error: 'Слишком много попыток. Подожди минуту.' });
        attempts.set(ip, attempt);
        const input = await body(req);
        const hash = value => createHash('sha256').update(value).digest();
        if (typeof input.password !== 'string' || !timingSafeEqual(hash(input.password), hash(password))) return reply(res, 401, { error: 'Неверный пароль' });
        const token = randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + 7 * 86400000);
        res.setHeader('Set-Cookie', `reading_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
        return reply(res, 200, { ok: true });
      }
      const token = /(?:^|;\s*)reading_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
      if (!sessions.has(token) || sessions.get(token) < Date.now()) return reply(res, 401, { error: 'Войди для синхронизации' });
      if (url.pathname === '/api/session' && req.method === 'DELETE') {
        sessions.delete(token);
        res.setHeader('Set-Cookie', 'reading_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return reply(res, 200, { ok: true });
      }
      if (url.pathname === '/api/books' && req.method === 'GET') return reply(res, 200, await library());
      if (url.pathname === '/api/books' && req.method === 'POST') {
        const input = await body(req);
        const book = input.book;
        if (!book || !/^[a-f0-9]{64}$/.test(book.id) || typeof book.xml !== 'string' || book.xml.length > 24000000 || typeof book.title !== 'string') return reply(res, 400, { error: 'Некорректная книга' });
        const result = await mutate(books => {
          if (!books[book.id]) books[book.id] = { id: book.id, title: book.title.slice(0, 500), author: String(book.author || '').slice(0, 500), xml: book.xml, progress: null, revision: 0 };
          return books[book.id];
        });
        return reply(res, 200, result);
      }
      if (url.pathname === '/api/progress' && req.method === 'POST') {
        const input = await body(req);
        const result = await mutate(books => {
          const book = books[input.id];
          if (!book) return { missing: true };
          if (input.revision !== book.revision) return { conflict: true, book };
          const p = input.progress;
          if (!p || !Number.isInteger(p.block) || p.block < 0 || !Number.isFinite(p.offset) || p.offset < 0 || p.offset > 1) return { invalid: true };
          book.progress = { block: p.block, offset: p.offset, percent: Math.min(100, Math.max(0, Number(p.percent) || 0)), updated: Date.now() };
          book.revision++;
          return { book };
        });
        return reply(res, result.conflict ? 409 : result.missing ? 404 : result.invalid ? 400 : 200, result);
      }
      return reply(res, 404, { error: 'Не найдено' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: 'Метод не поддерживается' });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'sw.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'sample.fb2'].includes(name)) return reply(res, 404, { error: 'Не найдено' });
    const content = await readFile(path.join(root, name));
    res.writeHead(200, { 'Content-Type': types[path.extname(name)] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent) reply(res, 400, { error: 'Не удалось обработать запрос' });
    else res.end();
  }
});
server.listen(port, host, () => console.log(`Читалка: http://${host}:${port}${password ? '' : '\nСинхронизация выключена: задай READING_PASSWORD.'}`));
