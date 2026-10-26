import { format_progress } from './telegram.js';

export const is_native = Boolean(globalThis.Capacitor?.isNativePlatform());
let native = null;
let system_bars = null;
if (is_native) {
  // Встроенный мост Android дополняется официальным JS-runtime Capacitor.
  const runtime = await import('./capacitor-core.js');
  native = runtime.registerPlugin('ReadingNative');
  system_bars = runtime.SystemBars;
}

export async function telegram_status() {
  if (is_native) return native.get_state();
  const response = await fetch('/api/telegram/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Сервер недоступен');
  return response.json();
}

export async function send_telegram(payload) {
  if (is_native) return native.send_progress({ text: format_progress(payload) });
  const response = await fetch('/api/telegram/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось отправить прогресс');
  return result;
}

export async function start_pairing(token) {
  if (!is_native) throw new Error('Настройка на устройстве доступна в APK');
  return native.start_pairing({ token });
}
export async function finish_pairing() { return native.finish_pairing(); }
export async function forget_telegram() { return native.clear_config(); }

export async function pick_book() {
  const result = await native.pick_book();
  const binary = atob(result.data);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new File([bytes], result.name, { type: 'application/xml' });
}

export function on_native_pause(callback) {
  if (is_native) return native.addListener('pause', callback);
}

export function native_theme(theme) {
  if (is_native) system_bars.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' }).catch(() => {});
}
