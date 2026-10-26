import { mkdir, readFile, writeFile, copyFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, 'www');
// Только публичные ресурсы: .env, сервер и пользовательские книги не попадают в APK.
export const assets = ['index.html', 'app.js', 'platform.js', 'telegram.js', 'capacitor-core.js', 'style.css', 'icon.svg', 'icon-192.png', 'icon-512.png', 'sample.fb2'];
await mkdir(output, { recursive: true });
if ((await lstat(output)).isSymbolicLink()) throw new Error('Папка www не должна быть символической ссылкой');
for (const entry of await readdir(output, { withFileTypes: true })) {
  if (!assets.includes(entry.name) || !entry.isFile()) throw new Error('В www есть посторонний файл: ' + entry.name + '. Перенеси его перед сборкой.');
}
for (const name of assets) {
  if (name === 'index.html') {
    const html = (await readFile(path.join(root, name), 'utf8')).replace('<link rel="manifest" href="/manifest.webmanifest">', '');
    await writeFile(path.join(output, name), html);
  } else await copyFile(name === 'capacitor-core.js' ? path.join(root, 'node_modules/@capacitor/core/dist/index.js') : path.join(root, name), path.join(output, name));
}
console.log('Ресурсы Android подготовлены в reading/www. Секреты не включены.');
