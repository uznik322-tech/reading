export function format_progress(input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || typeof input.percent !== 'number' || !Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100) throw new Error('Некорректный прогресс');
  const text = (value, limit) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const lines = ['📖 ' + text(input.title, 300), text(input.author, 200), `Прочитано: ${input.percent.toFixed(1)}%`];
  if (text(input.chapter, 300)) lines.push(text(input.chapter, 300));
  if (text(input.excerpt, 600)) lines.push(`Место в тексте: «${text(input.excerpt, 600)}»`);
  lines.push('На другом устройстве нажми «Вставить прогресс» и вставь это сообщение целиком. Если такой кнопки ещё нет, открой книгу и введи процент вручную: он приблизительный.');
  const anchor = format_progress_anchor(input.anchor);
  if (anchor) lines.push(anchor);
  return lines.filter(Boolean).join('\n\n');
}

export function format_progress_anchor(anchor) {
  if (!anchor || !/^[a-f0-9]{64}$/.test(anchor.book_id || '') || !Number.isInteger(anchor.block) || anchor.block < 0 || anchor.block > 10000000 || !Number.isFinite(anchor.offset) || anchor.offset < 0 || anchor.offset > 1) return '';
  return `Метка места: ${anchor.book_id}/${anchor.block}/${anchor.offset.toFixed(6)}`;
}

export function normalize_progress_text(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
}

export function read_progress_message(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 10000) throw new Error('Вставь одно сообщение бота с прогрессом чтения.');
  const text = message.replace(/\r\n?/g, '\n').trim();
  const matches = [...text.matchAll(/^\s*Прочитано:\s*(\d+(?:[.,]\d+)?)\s*%\s*$/gm)];
  if (matches.length !== 1) throw new Error('Нужно одно сообщение со строкой «Прочитано: 37.2%».');
  const percent = Number(matches[0][1].replace(',', '.'));
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Процент должен быть от 0 до 100.');
  const before = text.slice(0, matches[0].index).split('\n').map(line => line.trim()).filter(Boolean);
  const book_line = before.findIndex(line => /^📖\s*/u.test(line));
  const title_index = book_line >= 0 ? book_line : 0;
  const title = before[title_index]?.replace(/^📖\s*/u, '').trim();
  const author = before[title_index + 1] || '';
  if (!title || title.length > 500) throw new Error('В сообщении не найдено название книги.');
  const after = text.slice(matches[0].index + matches[0][0].length).trim();
  const excerpt_match = /^Место в тексте:\s*[«"]([\s\S]*?)[»"]\s*(?=\n\s*\n|$)/m.exec(after);
  const excerpt = excerpt_match?.[1]?.trim() || '';
  const first_line = after.split('\n').map(line => line.trim()).find(Boolean) || '';
  const chapter = /^(Место в тексте:|На другом устройстве|Метка места:)/.test(first_line) ? '' : first_line;
  const anchor_match = /^Метка места:\s*([a-f0-9]{64})\/(\d{1,8})\/(0(?:\.\d+)?|1(?:\.0+)?)\s*$/m.exec(text);
  const anchor = anchor_match ? { book_id: anchor_match[1], block: Number(anchor_match[2]), offset: Number(anchor_match[3]) } : null;
  return { title, author, percent, chapter, excerpt, anchor };
}

export function match_progress_books(books, progress) {
  // Метка однозначно определяет тот же FB2 даже при одинаковых названиях изданий.
  if (progress.anchor) {
    const exact = books.filter(book => book.id === progress.anchor.book_id);
    if (exact.length) return exact;
  }
  return books.filter(book => normalize_progress_text(book.title) === normalize_progress_text(progress.title) && (!progress.author || normalize_progress_text(book.author) === normalize_progress_text(progress.author)));
}

export function find_progress_block(entries, progress, book_id) {
  const excerpt = normalize_progress_text(progress.excerpt);
  const anchor = progress.anchor;
  if (anchor?.book_id === book_id && entries[anchor.block] && (!excerpt || normalize_progress_text(entries[anchor.block].text).includes(excerpt))) {
    return { index: anchor.block, offset: anchor.offset, method: 'anchor' };
  }
  if (!excerpt) return null;
  let candidates = entries.map((entry, index) => ({ ...entry, index })).filter(entry => normalize_progress_text(entry.text).includes(excerpt));
  if (!candidates.length) return null;
  const chapter = normalize_progress_text(progress.chapter);
  const in_chapter = chapter ? candidates.filter(entry => normalize_progress_text(entry.chapter) === chapter) : [];
  if (in_chapter.length) candidates = in_chapter;
  candidates.sort((a, b) => Math.abs(a.percent - progress.percent) - Math.abs(b.percent - progress.percent));
  return { index: candidates[0].index, offset: 0, method: candidates.length === 1 ? 'excerpt' : 'approximate' };
}

export async function telegram_call(token, method, payload = {}, request = fetch) {
  // Не передаём исходную сетевую ошибку: её URL может содержать токен.
  try {
    const response = await request(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(method === 'getUpdates' ? 25000 : 12000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      if (result.error_code === 401) throw new Error('Telegram: проверь токен бота в .env.');
      if (result.error_code === 403) throw new Error('Telegram: открой бота, нажми «Начать» и убедись, что он не заблокирован.');
      if (result.error_code === 409) throw new Error('Telegram: останови другие подключения getUpdates или webhook для этого бота.');
      throw new Error('Telegram: запрос отклонён. Проверь настройку бота и повтори позже.');
    }
    return result.result;
  } catch (error) {
    if (error.message.startsWith('Telegram:')) throw error;
    throw new Error('Telegram: нет ответа. Проверь интернет и повтори отправку. Сообщение могло быть доставлено.');
  }
}

export async function send_progress(input, config, request = fetch) {
  if (!config.token || !/^[1-9]\d*$/.test(config.chat_id || '')) throw new Error('Бот не настроен. Заполни .env и выполни node setup-bot.js.');
  return telegram_call(config.token, 'sendMessage', {
    // Получатель задаётся только на сервере, браузер не может его заменить.
    chat_id: config.chat_id, text: format_progress(input), protect_content: false
  }, request);
}
