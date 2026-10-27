import { is_native, is_desktop, is_local, telegram_status, send_telegram, start_pairing, finish_pairing, forget_telegram, pick_book, on_native_pause, native_theme } from './platform.js';

const $ = selector => document.querySelector(selector);
const db = await new Promise((resolve, reject) => {
  const request = indexedDB.open('reading', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('books', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
function storage(mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('books', mode);
    const request = action(transaction.objectStore('books'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
const put = book => storage('readwrite', store => store.put(book));
let books = await storage('readonly', store => store.getAll());
let current = null;
let blocks = [];
let restoring = false;
let telegram_payload = null;
let toast_timer;
let save_timer;
let settings;
try { settings = JSON.parse(localStorage.getItem('reading-settings')) || {}; } catch { settings = {}; }
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toast_timer); toast_timer = setTimeout(() => $('#toast').hidden = true, 5500);
}
function node(tag, text, class_name) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (class_name) element.className = class_name;
  return element;
}
const children = (element, name) => [...element.children].filter(child => child.localName === name);
function parse(xml) {
  const document_xml = new DOMParser().parseFromString(xml, 'application/xml');
  if (document_xml.querySelector('parsererror') || document_xml.documentElement.localName !== 'FictionBook') throw new Error('Не удалось прочитать FB2. Проверь формат файла.');
  if (document_xml.doctype) throw new Error('FB2 с DTD не поддерживается.');
  const all = name => [...document_xml.getElementsByTagNameNS('*', name)];
  const info = all('title-info')[0];
  const title = info?.getElementsByTagNameNS('*', 'book-title')[0]?.textContent.trim() || 'Без названия';
  const author = info ? [...info.getElementsByTagNameNS('*', 'author')].map(author_node => ['first-name', 'middle-name', 'last-name'].map(name => author_node.getElementsByTagNameNS('*', name)[0]?.textContent.trim()).filter(Boolean).join(' ')).filter(Boolean).join(', ') : '';
  const binaries = new Map();
  for (const binary of all('binary')) {
    const type = binary.getAttribute('content-type');
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) binaries.set(binary.id || binary.getAttribute('id'), `data:${type};base64,${binary.textContent.replace(/\s/g, '')}`);
  }
  const href = element => element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || element.getAttribute('href') || '';
  const cover_image = info?.getElementsByTagNameNS('*', 'coverpage')[0]?.getElementsByTagNameNS('*', 'image')[0];
  return { document_xml, title, author: author || 'Автор не указан', binaries, href, cover: cover_image ? binaries.get(href(cover_image).slice(1)) : null, bodies: children(document_xml.documentElement, 'body') };
}
function cover(book) {
  const element = node('div', '', 'cover');
  const palette = ['#536454', '#76604f', '#555e6c', '#7b7660', '#715655'];
  element.style.backgroundColor = palette[parseInt(book.id.slice(0, 2), 16) % palette.length];
  if (book.cover) { const img = node('img'); img.src = book.cover; img.alt = ''; element.append(img); }
  else { element.append(node('small', book.author), node('span', book.title)); }
  return element;
}
function progress_bar(value) {
  const track = node('div', '', 'progress-track');
  const fill = node('div', '', 'progress-fill'); fill.style.width = `${value || 0}%`; track.append(fill); return track;
}
function render_library() {
  const query = $('#search').value.toLocaleLowerCase('ru').trim();
  const sorted = [...books].sort((a, b) => (b.opened || b.added || 0) - (a.opened || a.added || 0));
  const filtered = sorted.filter(book => `${book.title} ${book.author}`.toLocaleLowerCase('ru').includes(query));
  $('#books').replaceChildren();
  $('#book-count').textContent = books.length;
  $('#empty').hidden = books.length > 0;
  $('#no-results').hidden = !books.length || filtered.length > 0;
  for (const book of filtered) {
    const button = node('button', '', 'book');
    button.append(cover(book), node('h3', book.title), node('p', book.author));
    if (book.progress) button.append(progress_bar(book.progress.percent), node('p', `${Math.round(book.progress.percent)}% прочитано`, 'book-percent'));
    button.addEventListener('click', () => open_book(book));
    $('#books').append(button);
  }
  const last = sorted.find(book => book.opened);
  $('#continue-section').hidden = !last;
  if (last) {
    const card = $('#continue-card'); card.replaceChildren(cover(last));
    const info = node('div', '', 'continue-info');
    info.append(node('div', 'ТВОЯ ТЕКУЩАЯ ИСТОРИЯ', 'eyebrow'), node('h2', last.title), node('p', `${last.author} · ${Math.round(last.progress?.percent || 0)}% прочитано`), progress_bar(last.progress?.percent));
    card.append(info, node('span', 'Продолжить чтение →', 'continue-action'));
    card.onclick = () => open_book(last);
  }
}
async function import_book(file) {
  if (!file || !/\.fb2$/i.test(file.name)) return toast('Выбери файл с расширением .fb2');
  if (file.size > 16 * 1024 * 1024) return toast('Книга слишком большая. Максимум — 16 МБ.');
  $('#import-button').disabled = true;
  try {
    const bytes = await file.arrayBuffer();
    const head = new TextDecoder('ascii').decode(bytes.slice(0, 200));
    const encoding = /encoding\s*=\s*["']([^"']+)/i.exec(head)?.[1] || ((new Uint8Array(bytes)[0] === 255 || new Uint8Array(bytes)[0] === 254) ? 'utf-16' : 'utf-8');
    const xml = new TextDecoder(encoding).decode(bytes).replace(/encoding\s*=\s*["'][^"']+["']/i, 'encoding="utf-8"');
    const parsed = parse(xml);
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(xml)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (books.some(book => book.id === id)) return toast('Эта книга уже в библиотеке');
    const book = { id, xml, title: parsed.title, author: parsed.author, cover: parsed.cover, added: Date.now(), progress: null };
    await put(book); books.push(book); render_library(); toast('Книга добавлена. Можно читать без интернета.');
  } catch (error) { toast(error.message || 'Не удалось добавить книгу'); }
  finally { $('#import-button').disabled = false; $('#file-input').value = ''; }
}
function build_content(parsed) {
  const fragment = document.createDocumentFragment();
  const contents = [];
  let section_index = 0;
  const convert = (source, parent) => {
    if (source.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(source.textContent)); return; }
    if (source.nodeType !== Node.ELEMENT_NODE) return;
    const name = source.localName;
    if (['binary', 'stylesheet', 'description'].includes(name)) return;
    if (name === 'image') {
      const src = parsed.binaries.get(parsed.href(source).slice(1));
      if (src) { const img = node('img'); img.src = src; img.alt = source.getAttribute('alt') || ''; parent.append(img); }
      return;
    }
    const mapping = { section: 'section', title: 'h2', subtitle: 'h3', p: 'p', emphasis: 'em', strong: 'strong', strikethrough: 's', sub: 'sub', sup: 'sup', a: 'a', cite: 'blockquote', epigraph: 'blockquote', poem: 'div', stanza: 'div', v: 'p', 'text-author': 'p', 'empty-line': 'br', table: 'table', tr: 'tr', td: 'td', th: 'th' };
    const target = node(mapping[name] || 'div');
    const source_id = source.getAttribute('id');
    if (source_id) target.id = `fb-${source_id}`;
    if (name === 'poem') target.className = 'poem';
    if (name === 'a') {
      const link = parsed.href(source);
      if (link.startsWith('#')) target.setAttribute('href', `#fb-${link.slice(1)}`);
    }
    // Заголовки FB2 содержат абзацы: переносим текст без вложенных p внутри h2.
    if (name === 'title') {
      target.textContent = source.textContent.trim();
      if (!target.id) target.id = `chapter-${section_index++}`;
      contents.push({ id: target.id, title: target.textContent });
    } else for (const child of source.childNodes) convert(child, target);
    parent.append(target);
  };
  fragment.append(node('h1', parsed.title, 'book-heading'), node('p', parsed.author, 'annotation'));
  for (const body of parsed.bodies) {
    if (body.getAttribute('name')) fragment.append(node('h2', 'Примечания'));
    for (const child of body.childNodes) convert(child, fragment);
  }
  $('#reader-content').replaceChildren(fragment);
  $('#contents').replaceChildren();
  for (const chapter of contents) {
    const button = node('button', chapter.title);
    button.onclick = () => { document.getElementById(chapter.id)?.scrollIntoView(); $('#contents-dialog').close(); };
    $('#contents').append(button);
  }
  if (!contents.length) $('#contents').append(node('p', 'В этой книге нет оглавления.'));
  blocks = [...$('#reader-content').querySelectorAll('p,h1,h2,h3,img,blockquote,br')];
}
async function open_book(book) {
  try {
    current = book; restoring = true;
    build_content(parse(book.xml));
    $('#library-view').hidden = true; $('#reader-view').hidden = false;
    $('#reader-title').textContent = book.title; document.title = `${book.title} — Между строк`;
    book.opened = Date.now(); await put(book);
    await Promise.all([...document.querySelectorAll('#reader-content img')].map(img => img.decode().catch(() => {})));
    await document.fonts.ready;
    restore(book.progress); restoring = false; update_meter();
  } catch (error) { restoring = false; toast(error.message); }
}
function restore(progress) {
  restoring = true;
  if (progress && blocks.length) {
    const block = blocks[Math.min(progress.block, blocks.length - 1)];
    const top = block.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top + block.getBoundingClientRect().height * progress.offset - 80));
  } else window.scrollTo(0, 0);
  requestAnimationFrame(() => { restoring = false; update_meter(); });
}
function position() {
  const line = 80;
  let index = 0;
  for (let i = 0; i < blocks.length; i++) { if (blocks[i].getBoundingClientRect().top <= line) index = i; else break; }
  const rect = blocks[index]?.getBoundingClientRect();
  const percent = Math.min(100, Math.max(0, window.scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight) * 100));
  return { block: index, offset: rect ? Math.min(1, Math.max(0, (line - rect.top) / Math.max(1, rect.height))) : 0, percent, updated: Date.now() };
}
function update_meter() {
  if (!current) return;
  const percent = position().percent;
  $('#reader-percent').textContent = `${Math.round(percent)}%`;
  $('#seek').value = percent;
}
async function save_position() {
  if (!current || restoring) return;
  current.progress = position();
  try { await put(current); $('#save-status').textContent = 'Место сохранено'; }
  catch { $('#save-status').textContent = 'Ошибка сохранения'; toast('Не удалось сохранить место. Проверь свободное место на устройстве.'); }
}
async function show_telegram() {
  // Снимок снимаем до открытия диалога: его фокус не должен менять место отправки.
  telegram_payload = current ? progress_payload() : null;
  $('#telegram-dialog').showModal();
  $('#telegram-send').hidden = !current;
  $('#telegram-preview').textContent = telegram_payload ? progress_preview(telegram_payload) : 'Открой книгу и нажми Telegram в читалке, чтобы отправить место остановки.';
  $('#telegram-message').textContent = 'Проверяем подключение…';
  try {
    const status = await telegram_status();
    $('#telegram-message').textContent = status.ready ? 'Бот настроен. Для отправки нужен интернет.' : is_local ? 'Подключи своего бота ниже. На каждом устройстве нужна отдельная привязка.' : 'Бот ещё не подключён. Инструкция по настройке — в readme.md проекта.';
    $('#telegram-send').disabled = !status.ready;
    if (is_local) {
      $('#native-config').open = !status.ready;
      $('#native-forget').hidden = !status.ready;
      render_pairing(status);
    }
  } catch {
    $('#telegram-message').textContent = is_local ? 'Не удалось прочитать настройки бота. Отключи его и привяжи заново.' : 'Сервер недоступен. Для отправки нужен интернет и работающий сервер. Место чтения сохранено на устройстве.';
    $('#telegram-send').disabled = true;
    if (is_local) $('#native-forget').hidden = false;
  }
}
function progress_payload() {
  const progress = position();
  const active = blocks[progress.block];
  let chapter = '';
  for (const heading of document.querySelectorAll('#reader-content h2')) {
    if (heading.getBoundingClientRect().top <= 120) chapter = heading.textContent;
  }
  const excerpt = active?.textContent?.trim() || active?.nextElementSibling?.textContent?.trim() || '';
  return { title: current.title, author: current.author, percent: Number(progress.percent.toFixed(1)), chapter, excerpt: excerpt.slice(0, 600) };
}
function progress_preview(payload) {
  return [payload.title, payload.author, 'Прочитано: ' + payload.percent + '%', payload.chapter, payload.excerpt ? 'Место в тексте: «' + payload.excerpt + '»' : ''].filter(Boolean).join('\n\n');
}
$('#telegram-send').onclick = async () => {
  if (!telegram_payload) return;
  const button = $('#telegram-send'); button.disabled = true;
  $('#telegram-message').textContent = 'Отправляем…';
  try {
    await save_position();
    await send_telegram(telegram_payload);
    $('#telegram-message').textContent = 'Прогресс отправлен в твой личный чат с ботом.';
    toast('Прогресс отправлен в Telegram');
  } catch (error) {
    $('#telegram-message').textContent = error.name === 'TypeError' || error.name === 'TimeoutError' ? 'Нет ответа от сервера. Место сохранено здесь. Проверь чат перед повторной отправкой.' : error.message;
  } finally { button.disabled = false; }
};
function apply_settings() {
  const anchor = current ? position() : null;
  document.body.dataset.theme = settings.theme || 'paper';
  native_theme(settings.theme || 'paper');
  document.documentElement.style.setProperty('--reader-size', `${settings.font || 20}px`);
  document.documentElement.style.setProperty('--reader-height', settings.height || '1.85');
  $('#font-size').value = settings.font || 20; $('#font-output').value = settings.font || 20;
  $('#line-height').value = settings.height || '1.85'; $('#theme').value = settings.theme || 'paper';
  localStorage.setItem('reading-settings', JSON.stringify(settings));
  if (anchor) restore(anchor);
}
$('#import-button').onclick = $('#empty-import').onclick = async () => {
  if (!is_local) return $('#file-input').click();
  try { await import_book(await pick_book()); }
  catch (error) { if (error.code !== 'cancelled') toast(error.message || 'Не удалось открыть файл'); }
};
$('#file-input').onchange = event => void import_book(event.target.files[0]);
$('#sample-button').onclick = async () => {
  try {
    const response = await fetch('/sample.fb2');
    if (!response.ok) throw new Error('Тестовая книга недоступна. Попробуй после подключения к сети.');
    await import_book(new File([await response.arrayBuffer()], 'sample.fb2'));
  } catch (error) { toast(error.message); }
};
$('#search').oninput = render_library;
$('#telegram-button').onclick = $('#reader-telegram').onclick = show_telegram;
$('#settings-button').onclick = () => $('#settings-dialog').showModal();
$('#contents-button').onclick = () => $('#contents-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#back-button').onclick = async () => {
  clearTimeout(save_timer); await save_position(); current = null;
  $('#reader-view').hidden = true; $('#library-view').hidden = false; document.title = 'Между строк — личная библиотека';
  window.scrollTo(0, 0); render_library();
};
$('#font-size').oninput = event => { settings.font = Number(event.target.value); apply_settings(); };
$('#line-height').onchange = event => { settings.height = event.target.value; apply_settings(); };
$('#theme').onchange = event => { settings.theme = event.target.value; apply_settings(); };
$('#seek').oninput = event => { window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * Number(event.target.value) / 100); };
window.addEventListener('scroll', () => {
  if (!current || restoring) return;
  update_meter(); clearTimeout(save_timer); save_timer = setTimeout(save_position, 250);
}, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(save_timer); void save_position(); } });
window.addEventListener('online', () => $('#connection').textContent = 'На устройстве');
window.addEventListener('offline', () => $('#connection').textContent = 'Без интернета');
window.addEventListener('resize', () => { if (current?.progress) restore(current.progress); });
apply_settings(); render_library();
if (!is_local && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?version=desktop-1', { updateViaCache: 'none' }).then(registration => registration.update()).catch(() => {});
if (is_local) {
  document.body.classList.add(is_desktop ? 'desktop-app' : 'native-app');
  $('#native-config').hidden = false;
  on_native_pause(() => { clearTimeout(save_timer); return save_position(); }).catch(() => {});
}

$('#jump-button').onclick = () => { $('#jump-percent').value = position().percent.toFixed(1); $('#jump-dialog').showModal(); };
$('#jump-form').onsubmit = event => {
  event.preventDefault();
  const percent = Number($('#jump-percent').value);
  if (!current || !Number.isFinite(percent) || percent < 0 || percent > 100) return;
  $('#jump-dialog').close();
  window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * percent / 100);
  update_meter(); clearTimeout(save_timer); save_timer = setTimeout(save_position, 100);
};

function render_pairing(status) {
  const pending = Boolean(status.code && status.username);
  $('#native-pairing').hidden = !pending;
  if (pending) {
    $('#native-code').textContent = status.code;
    $('#native-bot-link').href = 'https://t.me/' + encodeURIComponent(status.username);
    $('#native-bot-link').textContent = '@' + status.username;
  }
}
$('#native-start').onclick = async () => {
  const button = $('#native-start'); button.disabled = true;
  $('#native-message').textContent = 'Проверяем токен…';
  try {
    const status = await start_pairing($('#native-token').value.trim());
    $('#native-token').value = '';
    render_pairing(status);
    $('#native-message').textContent = 'Открой бота, нажми «Начать», отправь код и вернись сюда. Код действует 10 минут.';
  } catch (error) { $('#native-message').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#native-check').onclick = async () => {
  const button = $('#native-check'); button.disabled = true;
  $('#native-message').textContent = 'Ищем код…';
  try {
    await finish_pairing();
    $('#native-message').textContent = 'Бот подключён на этом устройстве.';
    $('#telegram-message').textContent = 'Бот настроен. Можно отправить прогресс.';
    $('#telegram-send').disabled = false;
    $('#native-forget').hidden = false; $('#native-pairing').hidden = true;
  } catch (error) { $('#native-message').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#native-forget').onclick = async () => {
  try {
    await forget_telegram();
    $('#native-token').value = ''; $('#native-code').textContent = '';
    $('#native-pairing').hidden = true; $('#native-forget').hidden = true;
    $('#telegram-send').disabled = true;
    $('#native-message').textContent = 'Настройки бота убраны с устройства. Книги и место чтения сохранены.';
  } catch (error) { $('#native-message').textContent = error.message; }
};
