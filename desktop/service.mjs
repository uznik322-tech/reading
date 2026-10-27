import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { telegram_call, format_progress } from '../telegram.js';

export class bot_store {
  constructor({ file, encrypt, decrypt, available, request = telegram_call, clock = Date.now }) {
    Object.assign(this, { file, encrypt, decrypt, available, request, clock });
    this.pending = null;
    this.next_send = 0;
  }
  async read_config() {
    let bytes;
    try { bytes = await readFile(this.file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Не удалось открыть настройки Telegram.'); }
    try {
      if (!this.available() || bytes.length > 8192) throw new Error();
      const config = JSON.parse(this.decrypt(bytes));
      if (!/^[1-9]\d*$/.test(config.chat_id) || typeof config.token !== 'string') throw new Error();
      return config;
    } catch { throw new Error('Не удалось расшифровать настройки. Отключи бота и привяжи заново на этом компьютере.'); }
  }
  async get_state() {
    const state = { ready: Boolean(await this.read_config()) };
    if (this.pending && this.clock() < this.pending.until) Object.assign(state, { code: this.pending.code, username: this.pending.username });
    return state;
  }
  async start_pairing({ token } = {}) {
    if (typeof token !== 'string' || !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token.trim())) throw new Error('Введи полный токен от BotFather.');
    if (!this.available()) throw new Error('Защищённое хранилище Windows недоступно. Токен не сохранён.');
    token = token.trim();
    const bot = await this.request(token, 'getMe');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(bot.username || '')) throw new Error('Не удалось определить имя бота.');
    this.pending = { token, username: bot.username, code: 'reading-' + randomBytes(8).toString('hex'), until: this.clock() + 600000 };
    return this.get_state();
  }
  async finish_pairing() {
    const pending = this.pending;
    if (!pending || this.clock() >= pending.until) throw new Error('Привязка истекла. Введи токен заново.');
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const updates = await this.request(pending.token, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        if (message?.chat.type === 'private' && message.text?.trim() === pending.code && /^[1-9]\d*$/.test(String(message.chat.id))) {
          const encrypted = this.encrypt(JSON.stringify({ token: pending.token, chat_id: String(message.chat.id) }));
          await mkdir(path.dirname(this.file), { recursive: true });
          await writeFile(this.file + '.tmp', encrypted);
          await rename(this.file + '.tmp', this.file);
          this.pending = null;
          return { ready: true };
        }
      }
      if (updates.length < 100) break;
    }
    throw new Error('Код пока не получен. Отправь его в личный чат с ботом и нажми «Проверить код».');
  }
  async clear_config() {
    try { await unlink(this.file); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Не удалось убрать настройки бота.'); }
    this.pending = null;
    return { ready: false };
  }
  async send_progress(payload) {
    format_progress(payload);
    const config = await this.read_config();
    if (!config) throw new Error('Сначала подключи бота в настройках программы.');
    if (this.clock() < this.next_send) throw new Error('Подожди 10 секунд перед повторной отправкой.');
    this.next_send = this.clock() + 10000;
    await this.request(config.token, 'sendMessage', { chat_id: config.chat_id, text: format_progress(payload) });
    return { ok: true };
  }
}
