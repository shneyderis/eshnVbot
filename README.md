# Voice → text bot (WhatsApp → Telegram → OpenAI)

Личный Telegram-бот: пересылаешь ему голосовое (из WhatsApp или любое другое), получаешь текст. Язык определяется автоматически (русский, украинский, английский и др.).

Хостинг: Vercel (serverless, без сервера). Распознавание: OpenAI `gpt-4o-transcribe`.

## Как пользоваться (iPhone)

1. В WhatsApp зажать голосовое → **Переслать** → внизу слева иконка **Поделиться** → **Telegram** → выбрать чат с ботом.
2. Через несколько секунд бот отвечает текстом (и переводом, если задан `TRANSLATE_TO`).
3. Разовый перевод на другой язык: ответить на сообщение бота командой `/tr en` (любой язык).
4. Разовый пересказ: ответить на сообщение бота командой `/sum`.

## Установка (один раз, ~10 минут)

1. **Бот в Telegram.** Написать [@BotFather](https://t.me/BotFather) → `/newbot` → сохранить токен.
2. **Ключ OpenAI.** https://platform.openai.com/api-keys → создать ключ. Нужен положительный баланс (минута речи ≈ $0.006).
3. **Деплой на Vercel.** Новый проект из этого репозитория. В Settings → Environment Variables добавить:

   | Переменная | Значение |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | токен от BotFather |
   | `OPENAI_API_KEY` | ключ OpenAI |
   | `TELEGRAM_WEBHOOK_SECRET` | любая случайная строка |
   | `ALLOWED_USER_IDS` | твой Telegram id (см. шаг 5) |

   Необязательно:
   - `TRANSLATE_TO=ru` — после текста присылать перевод на этот язык (если речь уже на нём, перевода не будет).
   - `SUMMARY=1` — после текста присылать короткий пересказ без воды. Только для сообщений длиннее 300 символов (порог: `SUMMARY_MIN_CHARS`). Пересказ на языке `TRANSLATE_TO`, если задан, иначе на языке речи.
   - `TRANSCRIBE_LANGUAGE=ru` — подсказка языка речи, по умолчанию автоопределение.
   - `TRANSCRIBE_MODEL=whisper-1`, `TRANSLATE_MODEL=gpt-4o-mini` — смена моделей.

4. **Подключить webhook** (подставить свои значения):

   ```bash
   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=https://<проект>.vercel.app/api/telegram" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
     -d "drop_pending_updates=true"
   ```

   Проверка: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`.

5. **Узнать свой id.** Написать боту `/start` — он ответит и покажет id. Вписать его в `ALLOWED_USER_IDS` и сделать Redeploy. Без этой переменной ботом сможет пользоваться кто угодно за твой счёт.

## Ограничения

- Файл до 20 МБ (лимит Telegram Bot API). Голосовое WhatsApp длиной в час ≈ 10 МБ.
- Один запрос ≤ 60 секунд (лимит Vercel). Хватает на голосовые до ~20–30 минут.

## Тест

```bash
npm test
```
