import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const executable = path.join(root, 'artifacts/windows/reading-win32-x64/reading.exe');
const result_path = path.join(root, 'artifacts/windows/reading-win32-x64/smoke-profile/smoke-result.json');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ['--reading-smoke-test'], { cwd: path.dirname(executable), env: environment, windowsHide: true, stdio: 'ignore' });
const timeout = setTimeout(() => { child.kill(); }, 30000);
const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
clearTimeout(timeout);
if (code !== 0) throw new Error('Windows-программа не прошла проверку запуска');
const result = JSON.parse(await readFile(result_path, 'utf8'));
if (result.error || !result.bridge || !result.fb2 || !result.indexeddb || !result.secure || !result.sandbox || !result.crypto) throw new Error('Проверка запуска не пройдена');
console.log('Windows EXE запущен: импорт и чтение FB2, IndexedDB, безопасный контекст, изоляция Node.js и шифрование Windows проверены.');
