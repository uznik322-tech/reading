import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import './env.js';

const path = new URL('./artifacts/reading-debug.apk', import.meta.url);
const zip = await readFile(path);
let directory = -1;
for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) {
  if (zip.readUInt32LE(offset) === 0x06054b50) { directory = offset; break; }
}
if (directory < 0) throw new Error('APK не является корректным ZIP-архивом');
const count = zip.readUInt16LE(directory + 10);
let cursor = zip.readUInt32LE(directory + 16);
const names = [];
let native_found = false;
const secrets = [process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID].filter(Boolean).map(value => Buffer.from(value));
for (let index = 0; index < count; index++) {
  if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Некорректный каталог APK');
  const method = zip.readUInt16LE(cursor + 10);
  const size = zip.readUInt32LE(cursor + 20);
  const name_length = zip.readUInt16LE(cursor + 28);
  const extra_length = zip.readUInt16LE(cursor + 30);
  const comment_length = zip.readUInt16LE(cursor + 32);
  const name = zip.toString('utf8', cursor + 46, cursor + 46 + name_length);
  const offset = zip.readUInt32LE(cursor + 42);
  names.push(name);
  if (/(^|\/)\.env(?:\.|$)|\.keystore$|\.jks$|(^|\/)server\.js$|(^|\/)node_modules\//.test(name)) throw new Error('В APK обнаружен закрытый файл: ' + name);
  const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
  const packed = zip.subarray(start, start + size);
  const bytes = method === 8 ? inflateRawSync(packed) : method === 0 ? packed : null;
  if (!bytes) throw new Error('Неизвестный метод упаковки: ' + name);
  if (secrets.some(secret => bytes.includes(secret))) throw new Error('Настройки Telegram попали в APK: ' + name);
  if (name === 'assets/capacitor.config.json') {
    const config = JSON.parse(bytes.toString('utf8'));
    if (config.server?.url || config.server?.androidScheme !== 'https') throw new Error('APK должен использовать встроенные ресурсы и безопасный локальный origin');
  }
  if (/classes\d*\.dex$/.test(name) && bytes.includes(Buffer.from('Ltech/uznik322/reading/readingplugin;'))) native_found = true;
  cursor += 46 + name_length + extra_length + comment_length;
}
for (const file of ['index.html', 'app.js', 'platform.js', 'telegram.js', 'capacitor-core.js', 'sample.fb2']) {
  if (!names.includes('assets/public/' + file)) throw new Error('В APK нет ресурса: ' + file);
}
if (!native_found) throw new Error('В APK не найден нативный модуль читалки');
console.log(`APK проверен: ${count} файлов, ${Math.round(zip.length / 1024 / 1024 * 10) / 10} МБ. Нативный модуль присутствует. Серверные секреты не обнаружены.`);
