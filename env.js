import { fileURLToPath } from 'node:url';

export const env_path = fileURLToPath(new URL('./.env', import.meta.url));
try { process.loadEnvFile(env_path); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Не удалось загрузить .env. Нужен Node.js 20.12 или новее.'); }
