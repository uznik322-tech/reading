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
let syncing = false;
let connected = false;
let restoring = false;
let conflict = null;
let toast_timer;
let save_timer;
let sync_timer;
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
    const book = { id, xml, title: parsed.title, author: parsed.author, cover: parsed.cover, added: Date.now(), revision: 0, progress: null, dirty: false, uploaded: false };
    await put(book); books.push(book); render_library(); toast('Книга добавлена. Можно читать без интернета.'); void sync();
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
  current.progress = position(); current.dirty = true;
  try { await put(current); $('#save-status').textContent = 'Место сохранено'; }
  catch { $('#save-status').textContent = 'Ошибка сохранения'; toast('Не удалось сохранить место. Проверь свободное место на устройстве.'); }
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
  const value = await response.json();
  if (response.status === 401) { connected = false; throw new Error('Войди для синхронизации'); }
  if (!response.ok && response.status !== 409) throw new Error(value.error || 'Ошибка синхронизации');
  return value;
}
function set_connection(text) { $('#connection').textContent = text; }
function show_conflict(local, remote) {
  conflict = { local, remote };
  $('#conflict-description').textContent = `Здесь: ${Math.round(local.progress?.percent || 0)}%. На сервере: ${Math.round(remote.progress?.percent || 0)}%.`;
  if (!$('#conflict-dialog').open) $('#conflict-dialog').showModal();
}
async function sync() {
  if (syncing || conflict || !navigator.onLine) { if (!navigator.onLine) set_connection('Без интернета'); return; }
  syncing = true;
  try {
    set_connection('Синхронизация…');
    const remote_books = await api('/api/books'); connected = true;
    // Если сервер восстановлен из пустой копии, повторно отправляем локальные книги.
    for (const book of books) book.uploaded = Boolean(remote_books[book.id]);
    for (const remote of Object.values(remote_books)) {
      const local = books.find(book => book.id === remote.id);
      if (!local) {
        const parsed = parse(remote.xml);
        const book = { ...remote, cover: parsed.cover, added: Date.now(), uploaded: true, dirty: false };
        await put(book); books.push(book);
      } else {
        local.uploaded = true;
        if (remote.revision !== local.revision) {
          if (local.dirty || current?.id === local.id) { show_conflict(local, remote); break; }
          local.progress = remote.progress; local.revision = remote.revision;
        }
        await put(local);
      }
    }
    if (!conflict) for (const book of books) {
      if (!book.uploaded) {
        const remote = await api('/api/books', { method: 'POST', body: JSON.stringify({ book }) });
        book.uploaded = true;
        if (remote.revision !== book.revision && (book.dirty || remote.progress)) { show_conflict(book, remote); break; }
        book.revision = remote.revision;
      }
      if (book.dirty && book.progress) {
        // Снимок защищает новую локальную позицию от ответа на предыдущий запрос.
        const sent_progress = book.progress;
        const result = await api('/api/progress', { method: 'POST', body: JSON.stringify({ id: book.id, revision: book.revision, progress: sent_progress }) });
        if (result.conflict) { show_conflict(book, result.book); break; }
        book.revision = result.book.revision;
        book.dirty = book.progress !== sent_progress;
      }
      await put(book);
    }
    set_connection(conflict ? 'Выбери место чтения' : 'Синхронизировано');
    $('#account-message').textContent = 'Подключено. Библиотека синхронизируется автоматически.';
    if (!current) render_library();
  } catch (error) {
    set_connection(connected ? 'Нет связи с сервером' : 'На устройстве');
    if (connected) $('#save-status').textContent = 'Сохранено здесь';
  } finally { syncing = false; }
}
async function resolve_conflict(use_remote) {
  if (!conflict) return;
  const { local, remote } = conflict;
  local.revision = remote.revision; local.uploaded = true;
  if (use_remote) { local.progress = remote.progress; local.dirty = false; if (current?.id === local.id) restore(local.progress); }
  else local.dirty = Boolean(local.progress);
  await put(local); conflict = null; $('#conflict-dialog').close(); render_library(); void sync();
}
function apply_settings() {
  const anchor = current ? position() : null;
  document.body.dataset.theme = settings.theme || 'paper';
  document.documentElement.style.setProperty('--reader-size', `${settings.font || 20}px`);
  document.documentElement.style.setProperty('--reader-height', settings.height || '1.85');
  $('#font-size').value = settings.font || 20; $('#font-output').value = settings.font || 20;
  $('#line-height').value = settings.height || '1.85'; $('#theme').value = settings.theme || 'paper';
  localStorage.setItem('reading-settings', JSON.stringify(settings));
  if (anchor) restore(anchor);
}
$('#import-button').onclick = $('#empty-import').onclick = () => $('#file-input').click();
$('#file-input').onchange = event => void import_book(event.target.files[0]);
$('#sample-button').onclick = async () => {
  try {
    const response = await fetch('/sample.fb2');
    if (!response.ok) throw new Error('Тестовая книга недоступна. Попробуй после подключения к сети.');
    await import_book(new File([await response.arrayBuffer()], 'sample.fb2'));
  } catch (error) { toast(error.message); }
};
$('#search').oninput = render_library;
$('#account-button').onclick = () => $('#account-dialog').showModal();
$('#settings-button').onclick = () => $('#settings-dialog').showModal();
$('#contents-button').onclick = () => $('#contents-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#login-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('/api/session', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = ''; connected = true; await sync(); $('#account-dialog').close(); toast('Синхронизация подключена');
  } catch (error) { $('#account-message').textContent = error.message; }
};
$('#logout-button').onclick = async () => {
  try { await api('/api/session', { method: 'DELETE' }); connected = false; set_connection('На устройстве'); $('#account-dialog').close(); toast('Выход выполнен. Книги на устройстве сохранены.'); }
  catch (error) { $('#account-message').textContent = error.message; }
};
$('#use-remote').onclick = () => void resolve_conflict(true);
$('#use-local').onclick = () => void resolve_conflict(false);
$('#conflict-dialog').addEventListener('cancel', event => event.preventDefault());
$('#back-button').onclick = async () => {
  clearTimeout(save_timer); await save_position(); current = null;
  $('#reader-view').hidden = true; $('#library-view').hidden = false; document.title = 'Между строк — личная библиотека';
  window.scrollTo(0, 0); render_library(); void sync();
};
$('#font-size').oninput = event => { settings.font = Number(event.target.value); apply_settings(); };
$('#line-height').onchange = event => { settings.height = event.target.value; apply_settings(); };
$('#theme').onchange = event => { settings.theme = event.target.value; apply_settings(); };
$('#seek').oninput = event => { window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * Number(event.target.value) / 100); };
window.addEventListener('scroll', () => {
  if (!current || restoring) return;
  update_meter(); clearTimeout(save_timer); save_timer = setTimeout(save_position, 250);
  clearTimeout(sync_timer); sync_timer = setTimeout(sync, 2200);
}, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(save_timer); void save_position(); } else void sync(); });
window.addEventListener('online', () => void sync());
window.addEventListener('offline', () => set_connection('Без интернета'));
window.addEventListener('resize', () => { if (current?.progress) restore(current.progress); });
apply_settings(); render_library(); void sync();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(registration => registration.update()).catch(() => {});
