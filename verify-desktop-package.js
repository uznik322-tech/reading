import { listPackage, extractFile } from '@electron/asar';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const archive = path.join(root, 'artifacts/windows/reading-win32-x64/resources/app.asar');
const names = listPackage(archive).map(name => name.replace(/^[/\\]/, '').replaceAll('\\', '/'));
const expected = ['package.json', 'telegram.js', 'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/service.mjs', 'web/index.html', 'web/app.js', 'web/platform.js', 'web/telegram.js', 'web/style.css', 'web/icon.svg', 'web/icon-192.png', 'web/icon-512.png', 'web/sample.fb2'];
const secrets = [process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID].filter(Boolean).map(value => Buffer.from(value));
let files = 0;
for (const name of names) {
  if (['desktop', 'web'].includes(name)) continue;
  if (!expected.includes(name)) throw new Error('Посторонний файл в сборке: ' + name);
  const bytes = extractFile(archive, name);
  if (secrets.some(secret => bytes.includes(secret))) throw new Error('В сборку попали настройки Telegram: ' + name);
  files++;
}
if (files !== expected.length) throw new Error('Неполная Windows-сборка');
// Проверяем имена всех записей ZIP, включая сжатые файлы: профиля в архиве быть не должно.
const zip = await readFile(path.join(root, 'artifacts/reading-windows.zip'));
let end = -1;
for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) { if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; } }
if (end < 0) throw new Error('Не найден каталог ZIP');
const count = zip.readUInt16LE(end + 10);
let cursor = zip.readUInt32LE(end + 16);
for (let i = 0; i < count; i++) {
  if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Повреждён ZIP');
  const length = zip.readUInt16LE(cursor + 28);
  const name = zip.toString('utf8', cursor + 46, cursor + 46 + length).replaceAll('\\', '/');
  if (/(^|\/)(reading-data|smoke-profile|\.env|\.tools|node_modules)(\/|$)/.test(name) || /(^|\/)telegram\.bin$|\.keystore$/.test(name)) throw new Error('В ZIP попали личные данные: ' + name);
  cursor += 46 + length + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
}
console.log(`Windows-сборка проверена: ${files} файлов приложения; секреты и пользовательский профиль не включены в ZIP.`);
