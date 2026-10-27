import { mkdir, copyFile, readFile, writeFile, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { packager } from '@electron/packager';

const root = path.dirname(fileURLToPath(import.meta.url));
const id = new Date().toISOString().replace(/[:.]/g, '-');
const tools = path.join(root, '.tools/windows-build');
const stage = path.join(tools, id, 'source');
const output = path.join(tools, id, 'output');
const artifacts = path.join(root, 'artifacts/windows');
const version = '1.0.0';
await mkdir(path.join(stage, 'desktop'), { recursive: true });
await mkdir(path.join(stage, 'web'), { recursive: true });
execFileSync(process.execPath, ['build-web.js'], { cwd: root, stdio: 'inherit' });
// Явный список исключает .env, SDK, ключи, книги пользователя и зависимости сервера.
const web_assets = ['index.html', 'app.js', 'platform.js', 'telegram.js', 'style.css', 'icon.svg', 'icon-192.png', 'icon-512.png', 'sample.fb2'];
for (const name of web_assets) await copyFile(path.join(root, 'www', name), path.join(stage, 'web', name));
for (const name of ['main.cjs', 'preload.cjs', 'service.mjs']) await copyFile(path.join(root, 'desktop', name), path.join(stage, 'desktop', name));
await copyFile(path.join(root, 'telegram.js'), path.join(stage, 'telegram.js'));
await writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'reading', productName: 'Между строк', version, private: true, type: 'module', main: 'desktop/main.cjs', description: 'Личная читалка FB2', author: 'uznik322-tech' }, null, 2));
const png = await readFile(path.join(root, 'icon-192.png'));
const ico = Buffer.alloc(22 + png.length);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 192; ico[7] = 192; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18); png.copy(ico, 22);
const icon = path.join(tools, id, 'icon.ico');
await writeFile(icon, ico);
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const folders = await packager({
  dir: stage, name: 'reading', executableName: 'reading', platform: 'win32', arch: 'x64', out: output,
  electronVersion: metadata.devDependencies.electron, appVersion: version, buildVersion: version,
  asar: true, overwrite: false, prune: false, icon,
  download: { cacheRoot: path.join(root, '.tools/electron-cache') }, tmpdir: path.join(tools, id, 'temp'),
  win32metadata: { CompanyName: 'uznik322-tech', FileDescription: 'Между строк — читалка FB2', ProductName: 'Между строк' }
});
await mkdir(artifacts, { recursive: true });
const destination = path.join(artifacts, 'reading-win32-x64');
// Копируем только файлы новой сборки; существующий reading-data не удаляем.
await cp(folders[0], destination, { recursive: true });
const readme = 'Между строк — Windows\r\n\r\nЗапуск: reading.exe\r\nКниги и настройки: reading-data рядом с программой.\r\nДля обновления закрыть программу и заменить файлы, сохранив reading-data.\r\nТокен Telegram нужно привязать отдельно; .env в сборку не входит.\r\n';
await writeFile(path.join(destination, 'readme.txt'), readme, 'utf8');
const zip = path.join(root, 'artifacts/reading-windows.zip');
// Архивируем чистую сборку, а не рабочую папку, где могли появиться личные данные.
await writeFile(path.join(folders[0], 'readme.txt'), readme, 'utf8');
const environment = { ...process.env, READING_ZIP_SOURCE: folders[0], READING_ZIP_DESTINATION: zip };
execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -LiteralPath $env:READING_ZIP_SOURCE -DestinationPath $env:READING_ZIP_DESTINATION -Force'], { cwd: root, env: environment, stdio: 'inherit' });
console.log('Windows-программа: ' + path.join(destination, 'reading.exe'));
console.log('Архив для переноса: ' + zip);
