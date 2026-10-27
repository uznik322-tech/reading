import { test } from 'node:test';
import assert from 'node:assert/strict';
import { format_progress, read_progress_message, match_progress_books, find_progress_block } from './telegram.js';

const book_id = 'a'.repeat(64);
const payload = { title: 'Тестовая книга', author: 'Тестовый автор', percent: 37.2, chapter: 'Глава 8', excerpt: 'Он открыл окно. «Уже утро», — подумал он.', anchor: { book_id, block: 12, offset: 0.25 } };

test('Новое сообщение бота сохраняет метку и фрагмент при чтении', () => {
  const parsed = read_progress_message(format_progress(payload));
  assert.equal(parsed.title, payload.title); assert.equal(parsed.author, payload.author);
  assert.equal(parsed.percent, payload.percent); assert.equal(parsed.chapter, payload.chapter);
  assert.equal(parsed.excerpt, payload.excerpt); assert.deepEqual(parsed.anchor, payload.anchor);
});

test('Старое сообщение, запятая и пересланный заголовок поддерживаются', () => {
  const parsed = read_progress_message('Переслано от моего бота\n\n' + format_progress({ ...payload, anchor: undefined }).replace('37.2%', '37,2%'));
  assert.equal(parsed.percent, 37.2); assert.equal(parsed.title, payload.title);
  assert.equal(parsed.excerpt, payload.excerpt); assert.equal(parsed.anchor, null);
});

test('Неверный процент и несколько сообщений не принимаются', () => {
  assert.throws(() => read_progress_message('случайный текст'));
  assert.throws(() => read_progress_message(format_progress(payload).replace('37.2%', '100.1%')));
  assert.throws(() => read_progress_message(format_progress(payload) + '\n' + format_progress(payload)));
});

test('Книга выбирается по метке, иначе по названию и автору; издания не смешиваются', () => {
  const books = [{ id: book_id, title: payload.title, author: payload.author }, { id: 'b'.repeat(64), title: payload.title, author: 'Другой автор' }];
  assert.equal(match_progress_books(books, payload)[0].id, book_id);
  assert.equal(match_progress_books(books, { ...payload, anchor: null }).length, 1);
  assert.equal(match_progress_books(books, { ...payload, author: '', anchor: null }).length, 2);
  assert.equal(match_progress_books(books, { ...payload, title: 'Другая книга', anchor: null }).length, 0);
});

test('Метка восстанавливает блок независимо от процента и повторяющегося текста', () => {
  const entries = Array.from({ length: 15 }, (_, i) => ({ text: payload.excerpt, chapter: payload.chapter, percent: i * 6 }));
  assert.deepEqual(find_progress_block(entries, payload, book_id), { index: 12, offset: 0.25, method: 'anchor' });
});

test('Для старых сообщений фрагмент ищется в нужной главе', () => {
  const entries = [{ text: 'Он открыл окно.', chapter: 'Глава 1', percent: 10 }, { text: 'Он открыл окно.', chapter: 'Глава 8', percent: 80 }];
  assert.deepEqual(find_progress_block(entries, { ...payload, anchor: null, excerpt: 'Он открыл окно.' }, book_id), { index: 1, offset: 0, method: 'excerpt' });
  assert.equal(find_progress_block(entries, { ...payload, anchor: null, excerpt: 'Другой фрагмент' }, book_id), null);
});

test('Метка другого FB2 и повреждённый индекс не используются', () => {
  const entries = [{ text: payload.excerpt, chapter: payload.chapter, percent: 20 }];
  assert.equal(find_progress_block(entries, payload, 'b'.repeat(64)).method, 'excerpt');
  assert.equal(find_progress_block(entries, payload, book_id).method, 'excerpt');
});

test('Повторяющийся фрагмент считается приблизительным и выбирается рядом с процентом', () => {
  const entries = [{ text: payload.excerpt, chapter: payload.chapter, percent: 10 }, { text: payload.excerpt, chapter: payload.chapter, percent: 38 }];
  assert.deepEqual(find_progress_block(entries, { ...payload, anchor: null }, book_id), { index: 1, offset: 0, method: 'approximate' });
});

test('Обрезанное сообщение без фрагмента использует процент, неверная метка игнорируется', () => {
  const parsed = read_progress_message('📖 Книга\n\nПрочитано: 0%\n\nМетка места: ' + book_id + '/-1/2');
  assert.equal(parsed.author, ''); assert.equal(parsed.percent, 0); assert.equal(parsed.anchor, null);
  assert.equal(find_progress_block([], parsed, book_id), null);
});
