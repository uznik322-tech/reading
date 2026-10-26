package tech.uznik322.reading;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name = "ReadingNative")
public class readingplugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private String pairing_token;
    private String pairing_code;
    private String pairing_name;
    private long pairing_until;
    private long next_send;
    private static final String key_alias = "reading_telegram_v1";

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("reading_private", Context.MODE_PRIVATE);
    }

    private SecretKey secret_key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(key_alias)) return (SecretKey) store.getKey(key_alias, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(key_alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private JSONObject read_config() throws Exception {
        String saved = preferences().getString("telegram", null);
        if (saved == null) return null;
        try {
            String[] parts = saved.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secret_key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception error) { throw new Exception("Не удалось прочитать настройки. Отключи бота и привяжи заново."); }
    }

    private void write_config(String token, String chat_id) throws Exception {
        JSONObject config = new JSONObject().put("token", token).put("chat_id", chat_id);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secret_key());
        String saved = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(config.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!preferences().edit().putString("telegram", saved).commit()) throw new Exception("Не удалось сохранить настройки на устройстве.");
    }

    private JSONObject request(String token, String method, JSONObject payload) throws Exception {
        HttpsURLConnection connection = null;
        try {
            connection = (HttpsURLConnection) new URL("https://api.telegram.org/bot" + token + "/" + method).openConnection();
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(15000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (var output = connection.getOutputStream()) { output.write(payload.toString().getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            if (status == 401) throw new Exception("Неверный токен бота.");
            if (status == 403) throw new Exception("Открой бота в Telegram, нажми «Начать» и проверь, что он не заблокирован.");
            if (status == 409) throw new Exception("Бот занят другой привязкой. Останови setup-bot.js на компьютере и повтори.");
            if (status == 429) throw new Exception("Telegram просит подождать. Повтори отправку позже.");
            if (status != 200) throw new Exception("Telegram отклонил запрос. Проверь настройки бота.");
            byte[] bytes;
            try (InputStream input = connection.getInputStream()) { bytes = read_limited(input, 2 * 1024 * 1024); }
            JSONObject result = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            if (!result.optBoolean("ok")) throw new Exception("Telegram отклонил запрос. Проверь настройки бота.");
            return result;
        } catch (java.io.IOException error) {
            // Исходная ошибка может содержать URL с токеном; её не возвращаем в интерфейс.
            throw new Exception("Нет ответа от Telegram. Проверь интернет. Перед повтором проверь чат: сообщение могло дойти.");
        } finally { if (connection != null) connection.disconnect(); }
    }

    private byte[] read_limited(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (bytes.size() + count > limit) throw new Exception("Файл или ответ слишком большой.");
            bytes.write(buffer, 0, count);
        }
        return bytes.toByteArray();
    }

    private JSObject state() throws Exception {
        JSObject result = new JSObject();
        result.put("ready", read_config() != null);
        if (pairing_token != null && System.currentTimeMillis() < pairing_until) {
            result.put("code", pairing_code);
            result.put("username", pairing_name);
        }
        return result;
    }

    @PluginMethod
    public void get_state(PluginCall call) {
        worker.execute(() -> { try { call.resolve(state()); } catch (Exception error) { call.reject(error.getMessage()); } });
    }

    @PluginMethod
    public void start_pairing(PluginCall call) {
        final String token = call.getString("token", "").trim();
        if (!token.matches("[0-9]{5,}:[A-Za-z0-9_-]{20,}")) { call.reject("Введи полный токен от BotFather."); return; }
        worker.execute(() -> {
            try {
                JSONObject bot = request(token, "getMe", new JSONObject()).getJSONObject("result");
                pairing_name = bot.getString("username");
                pairing_code = "reading-" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
                pairing_token = token;
                pairing_until = System.currentTimeMillis() + 10 * 60 * 1000;
                call.resolve(state());
            } catch (Exception error) { call.reject(error.getMessage()); }
        });
    }

    @PluginMethod
    public void finish_pairing(PluginCall call) {
        worker.execute(() -> {
            try {
                if (pairing_token == null || System.currentTimeMillis() > pairing_until) throw new Exception("Привязка истекла. Введи токен заново.");
                long offset = 0;
                for (int page = 0; page < 5; page++) {
                    JSONObject payload = new JSONObject().put("offset", offset).put("timeout", 0).put("allowed_updates", new JSONArray().put("message"));
                    JSONArray updates = request(pairing_token, "getUpdates", payload).getJSONArray("result");
                    for (int i = 0; i < updates.length(); i++) {
                        JSONObject update = updates.getJSONObject(i);
                        offset = update.getLong("update_id") + 1;
                        JSONObject message = update.optJSONObject("message");
                        if (message == null) continue;
                        JSONObject chat = message.optJSONObject("chat");
                        if (chat != null && "private".equals(chat.optString("type")) && pairing_code.equals(message.optString("text").trim())) {
                            write_config(pairing_token, Long.toString(chat.getLong("id")));
                            pairing_token = null; pairing_code = null; pairing_name = null;
                            call.resolve(state()); return;
                        }
                    }
                    if (updates.length() < 100) break;
                }
                throw new Exception("Код пока не получен. Отправь его в личный чат с ботом и нажми «Проверить код».");
            } catch (Exception error) { call.reject(error.getMessage()); }
        });
    }

    @PluginMethod
    public void clear_config(PluginCall call) {
        worker.execute(() -> {
            pairing_token = null; pairing_code = null; pairing_name = null;
            if (!preferences().edit().remove("telegram").commit()) { call.reject("Не удалось убрать настройки."); return; }
            call.resolve(new JSObject().put("ready", false));
        });
    }

    @PluginMethod
    public void send_progress(PluginCall call) {
        final String text = call.getString("text", "");
        if (text.trim().isEmpty() || text.length() > 2500) { call.reject("Некорректное сообщение."); return; }
        worker.execute(() -> {
            try {
                JSONObject config = read_config();
                if (config == null) throw new Exception("Сначала подключи бота на этом устройстве.");
                if (System.currentTimeMillis() < next_send) throw new Exception("Подожди 10 секунд перед повторной отправкой.");
                next_send = System.currentTimeMillis() + 10000;
                JSONObject payload = new JSONObject().put("chat_id", config.getString("chat_id")).put("text", text);
                request(config.getString("token"), "sendMessage", payload);
                call.resolve(new JSObject().put("ok", true));
            } catch (Exception error) { call.reject(error.getMessage()); }
        });
    }

    @PluginMethod
    public void pick_book(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, intent, "book_selected");
    }

    @ActivityCallback
    private void book_selected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("Выбор отменён", "cancelled"); return; }
        final var uri = result.getData().getData();
        worker.execute(() -> {
            try {
                String name = "book.fb2";
                try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
                }
                if (name == null || !name.toLowerCase(java.util.Locale.ROOT).endsWith(".fb2")) throw new Exception("Выбери файл с расширением .fb2");
                byte[] bytes;
                try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                    if (input == null) throw new Exception("Не удалось открыть файл");
                    bytes = read_limited(input, 16 * 1024 * 1024);
                }
                JSObject value = new JSObject();
                value.put("name", name); value.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(value);
            } catch (Exception error) { call.reject("Не удалось импортировать FB2. Проверь файл и размер до 16 МБ."); }
        });
    }

    @Override
    protected void handleOnPause() { notifyListeners("pause", new JSObject()); }
}
