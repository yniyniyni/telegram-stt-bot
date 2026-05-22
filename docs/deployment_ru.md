# Руководство по развертыванию на Linux

Это руководство содержит пошаговые инструкции по развертыванию Telegram Speech-to-Text Bot на серверах Linux: **Debian/Ubuntu** (на базе APT) и **AlmaLinux/Rocky Linux** (на базе YUM/DNF).

---

## 📋 Предварительные требования

### 1. Установка Node.js (v20.17.0+)

Рекомендуется использовать версию Node.js v20 LTS.

#### Debian / Ubuntu:
```bash
# Подключение репозитория NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### AlmaLinux / Rocky Linux:
```bash
# Включение потока модуля Node.js (версия 20)
sudo dnf module enable -y nodejs:20
sudo dnf install -y nodejs
```

### 2. Установка SQLite и инструментов сборки
Поскольку бот использует базу данных SQLite (пакет `sqlite3` для npm компилирует нативные C++ компоненты при установке), на сервере необходимы инструменты сборки и библиотеки разработки SQLite.

#### Debian / Ubuntu:
```bash
sudo apt-get update
sudo apt-get install -y sqlite3 build-essential
```

#### AlmaLinux / Rocky Linux:
```bash
sudo dnf groupinstall -y "Development Tools"
sudo dnf install -y sqlite sqlite-devel
```

---

## 🚀 Установка и сборка

### 1. Клонирование репозитория и установка зависимостей
Клонируйте репозиторий в выбранную папку для развертывания (например, `/opt/telegram-stt-bot`):

```bash
sudo git clone https://github.com/yniyniyni/telegram-stt-bot /opt/telegram-stt-bot
cd /opt/telegram-stt-bot

# Смена владельца папки на вашего текущего непривилегированного пользователя
sudo chown -R $USER:$USER /opt/telegram-stt-bot

# Установка пакетов
npm install
```

### 2. Настройка переменных окружения
Создайте файл конфигурации `.env` на основе примера:
```bash
cp .env.example .env
nano .env
```
Заполните параметры конфигурации:
```ini
# Токен Telegram-бота от @BotFather
TELEGRAM_BOT_TOKEN=ваш_реальный_токен_telegram_бота

# API-ключ Deepgram (с сайта console.deepgram.com)
DEEPGRAM_API_KEY=ваш_реальный_api_ключ_deepgram

# Модель распознавания Deepgram (по умолчанию: nova-2)
DEEPGRAM_MODEL=nova-2

# Smart Format улучшает читаемость, добавляя знаки препинания, абзацы,
# а также форматируя даты, время и числа.
DEEPGRAM_SMART_FORMAT=true

# Контроль доступа
# Установите в 'true', чтобы разрешить доступ любым чатам/пользователям.
# Установите в 'false', чтобы включить белый список ALLOWED_CHATS.
ALLOW_ALL_CHATS=false
# Список ID чатов Telegram через запятую, которым разрешено использовать бота
ALLOWED_CHATS=-100123456789,987654321

# Установите в 'true', чтобы разрешить любым пользователям писать боту в ЛС.
ALLOW_ALL_USERS=false
ALLOWED_USERS=

# Лимиты частоты запросов (на один чат)
# Максимальное количество запросов на расшифровку в рамках временного окна
RATE_LIMIT_MAX_REQUESTS=10
# Плавающее окно в секундах (например, 3600 = 1 час)
RATE_LIMIT_WINDOW_SEC=3600

# Языковые настройки (по умолчанию: auto для автоопределения Deepgram)
DEEPGRAM_LANGUAGE=auto

# Язык интерфейса бота (для ответов и ошибок пользователю): 'ru' или 'en'
BOT_LANGUAGE=ru

# Ограничения безопасности
# Максимальная длительность аудио/видео сообщения для обработки (в секундах).
MAX_AUDIO_DURATION_SEC=600
# Максимальный размер медиафайла Telegram для скачивания и распознавания (байты). По умолчанию: 50 МБ.
MAX_TELEGRAM_FILE_BYTES=52428800
# Максимальное количество одновременных задач распознавания.
MAX_CONCURRENT_TRANSCRIPTIONS=2
# Таймаут скачивания медиафайлов Telegram (миллисекунды).
TELEGRAM_DOWNLOAD_TIMEOUT_MS=60000
# Таймаут запросов к Deepgram API (миллисекунды).
DEEPGRAM_TIMEOUT_MS=120000

# Путь к базе данных (для продакшна рекомендуется указывать абсолютный путь)
DB_FILE=/opt/telegram-stt-bot/data/db.sqlite

# Логирование
DEBUG=false

# Интеграция с Gemini API (для улучшения текстов длительностью > 45 сек)
# Установите в 'false', чтобы полностью отключить улучшение текста через Gemini.
GEMINI_POLISH_ENABLED=true
# Установите в 'false', чтобы отключить полишинг только для видеосообщений (кружков).
GEMINI_POLISH_VIDEO=true
# API-ключ Gemini (из Google AI Studio).
GEMINI_API_KEY=ваш_реальный_api_ключ_gemini
# Используемая модель Gemini. По умолчанию: gemini-3.1-flash-lite
GEMINI_MODEL=gemini-3.1-flash-lite
# Таймаут запросов полишинга к Gemini (миллисекунды).
GEMINI_TIMEOUT_MS=120000
# Максимальное количество выходных токенов Gemini для полированного текста.
GEMINI_MAX_OUTPUT_TOKENS=8192
# Минимальная длительность сообщения в секундах для запуска улучшения текста.
POLISH_MIN_DURATION_SEC=45
```

### 3. Сборка приложения
Скомпилируйте исходный код TypeScript в JavaScript:
```bash
npm run build
```

Убедитесь, что скомпилированные файлы JavaScript появились в папке `dist`:
```bash
ls dist/
```

---

## ⚙️ Запуск в качестве системной службы (systemd)

В продакшн-окружении запуск бота в качестве службы `systemd` гарантирует, что он будет работать в фоновом режиме, записывать логи в системный журнал и автоматически перезапускаться в случае сбоя или перезагрузки сервера.

### 1. Создание файла службы systemd

Создайте файл службы `/etc/systemd/system/telegram-stt-bot.service`:
```bash
sudo nano /etc/systemd/system/telegram-stt-bot.service
```

Вставьте следующую конфигурацию (замените `youruser` на имя системного пользователя, который будет запускать бота, например, ваше имя пользователя или имя выделенного пользователя службы `telegram-bot`):

```ini
[Unit]
Description=Telegram Speech-to-Text Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/telegram-stt-bot
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> [!NOTE]
> Если вы не знаете имя вашего пользователя или путь к node, выполните команды `whoami` и `which node` для проверки.

### 2. Активация и запуск службы

```bash
# Перезагрузка конфигурации диспетчера systemd
sudo systemctl daemon-reload

# Запуск службы бота
sudo systemctl start telegram-stt-bot

# Включение автозапуска службы при загрузке системы
sudo systemctl enable telegram-stt-bot
```

### 3. Мониторинг и логи

Проверить текущий статус службы можно с помощью команды:
```bash
sudo systemctl status telegram-stt-bot
```

Для просмотра логов бота в реальном времени используйте:
```bash
sudo journalctl -u telegram-stt-bot -f -o cat
```

Если в файле `.env` вы настроили `DEBUG=true`, то сообщения отладки также будут отображаться здесь.
