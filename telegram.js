export function format_progress(input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || typeof input.percent !== 'number' || !Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100) throw new Error('Некорректный прогресс');
  const text = (value, limit) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const lines = ['📖 ' + text(input.title, 300), text(input.author, 200), `Прочитано: ${input.percent.toFixed(1)}%`];
  if (text(input.chapter, 300)) lines.push(text(input.chapter, 300));
  if (text(input.excerpt, 600)) lines.push(`Место в тексте: «${text(input.excerpt, 600)}»`);
  lines.push('На другом устройстве открой эту книгу, введи процент и найди фрагмент. Процент приблизительный: он зависит от оформления.');
  return lines.filter(Boolean).join('\n\n');
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
