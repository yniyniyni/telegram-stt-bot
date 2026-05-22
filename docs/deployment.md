# Linux Deployment Guide

This guide provides step-by-step instructions for deploying the Telegram Speech-to-Text Bot on Linux servers: **Debian/Ubuntu** (APT-based) and **AlmaLinux/Rocky Linux** (YUM/DNF-based).

---

## 📋 Prerequisites

### 1. Install Node.js (v20.17.0+)

We recommend installing Node.js v20 LTS.

#### Debian / Ubuntu:
```bash
# Install NodeSource repository
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### AlmaLinux / Rocky Linux:
```bash
# Enable Node.js module stream (version 20)
sudo dnf module enable -y nodejs:20
sudo dnf install -y nodejs
```

### 2. Install SQLite & Build Essentials
Since the bot utilizes SQLite (`sqlite3` npm package which compiles native C++ bindings during installation), build tools and SQLite development libraries are required.

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

## 🚀 Installation & Build

### 1. Clone the Repository & Install Dependencies
Clone the repository to a preferred deployment folder (e.g., `/opt/telegram-stt-bot`):

```bash
sudo git clone https://github.com/yniyniyni/telegram-stt-bot /opt/telegram-stt-bot
cd /opt/telegram-stt-bot

# Change folder ownership to your current non-root user
sudo chown -R $USER:$USER /opt/telegram-stt-bot

# Install packages exactly as pinned in package-lock.json
npm ci
```

### 2. Configure Environment Variables
Create the production `.env` file from the example:
```bash
cp .env.example .env
nano .env
```
Fill in the configuration details:
```ini
# Telegram Bot Token from @BotFather
TELEGRAM_BOT_TOKEN=your_real_telegram_bot_token

# Deepgram API Key (from console.deepgram.com)
DEEPGRAM_API_KEY=your_real_deepgram_api_key

# Deepgram transcription model (e.g. nova-3, nova-2, etc. Default: nova-3)
DEEPGRAM_MODEL=nova-3

# Smart Format improves readability by applying additional formatting.
DEEPGRAM_SMART_FORMAT=true

# Access Control
# Fail-closed default: keep false unless you intentionally allow all group/supergroup chats.
ALLOW_ALL_CHATS=false
# Comma-separated list of Telegram Chat IDs allowed to use the bot
ALLOWED_CHATS=-100123456789,987654321

# Fail-closed default: keep false unless you intentionally allow all private-message users.
# When false or unset, only ALLOWED_USERS can use the bot in DMs.
ALLOW_ALL_USERS=false
ALLOWED_USERS=

# Rate Limiting (per chat)
# Maximum number of transcription requests in the rolling window
RATE_LIMIT_MAX_REQUESTS=10
# Rolling window in seconds (e.g. 3600 = 1 hour)
RATE_LIMIT_WINDOW_SEC=3600

# Language settings (default: auto)
DEEPGRAM_LANGUAGE=auto

# Bot Interface Language (for user replies/errors): 'ru' or 'en'
BOT_LANGUAGE=ru

# Safety limits
# Max voice/video-note duration to process (in seconds). Prevents abuse/cost spikes.
MAX_AUDIO_DURATION_SEC=600
# Max Telegram media file size to download/transcribe (bytes). Default: 50 MB.
MAX_TELEGRAM_FILE_BYTES=52428800
# Max simultaneous transcription jobs. Extra requests receive a busy response.
MAX_CONCURRENT_TRANSCRIPTIONS=2
# Timeout for downloading Telegram media files (milliseconds).
TELEGRAM_DOWNLOAD_TIMEOUT_MS=60000
# Timeout for Deepgram transcription API calls (milliseconds).
DEEPGRAM_TIMEOUT_MS=120000

# Database path (absolute path recommended for production)
DB_FILE=/opt/telegram-stt-bot/data/db.sqlite

# Logging
DEBUG=false

# Gemini API Integration (For polishing transcripts > 45s)
# Set to 'true' to enable Gemini polishing functionality.
GEMINI_POLISH_ENABLED=false
# Set to 'false' to disable Gemini polishing specifically for video messages (video notes).
GEMINI_POLISH_VIDEO=true
# Gemini API Key (from Google AI Studio).
GEMINI_API_KEY=your_real_gemini_api_key
# Gemini model to use. Default: gemini-3.1-flash-lite
GEMINI_MODEL=gemini-3.1-flash-lite
# Timeout for Gemini polishing calls (milliseconds).
GEMINI_TIMEOUT_MS=120000
# Max Gemini output tokens for polished transcript.
GEMINI_MAX_OUTPUT_TOKENS=8192
# Minimum voice/video duration in seconds to trigger polishing. Default: 45
POLISH_MIN_DURATION_SEC=45
```

### 3. Build the Application
Compile TypeScript sources to JavaScript:
```bash
npm run build
```

After every dependency or code change, run the production install and build again before restarting the service:
```bash
npm ci && npm run build
```

Verify that the compiled JavaScript files are present in the `dist` folder:
```bash
ls dist/
```

---

## ⚙️ Running as a System Service (systemd)

For production environments, running the bot as a `systemd` service ensures that it runs in the background, logs output to the system journal, and automatically restarts if it crashes or the server reboots.

### 1. Create a systemd Service File

Create a service file `/etc/systemd/system/telegram-stt-bot.service`:
```bash
sudo nano /etc/systemd/system/telegram-stt-bot.service
```

Paste the following configuration (replace `youruser` with the name of the system user running the bot, e.g., your own username or a dedicated `telegram-bot` service user):

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
UMask=0077

[Install]
WantedBy=multi-user.target
```

> [!NOTE]
> If you don't know your user or node path, you can run `whoami` and `which node` to verify.

`UMask=0077` makes files created by the service readable only by the service user. This helps protect `.env`, logs, temporary files, and the SQLite database from other local users.

### 2. Enable and Start the Service

```bash
# Reload systemd manager configuration
sudo systemctl daemon-reload

# Start the bot service
sudo systemctl start telegram-stt-bot

# Enable the service to start automatically on system boot
sudo systemctl enable telegram-stt-bot
```

### 3. Monitoring & Logs

You can check the current status of the service using:
```bash
sudo systemctl status telegram-stt-bot
```

To view real-time log outputs generated by the bot:
```bash
sudo journalctl -u telegram-stt-bot -f -o cat
```

If you configured `DEBUG=true` in `.env`, debug messages will also be visible here.

## Privacy & Data Handling

- The SQLite database stores transcript text in plaintext by default. Use strict ownership, `UMask=0077`, restricted backups, and disk/filesystem encryption if transcripts may contain sensitive data.
- Gemini polishing is optional third-party processing and is disabled by default. When `GEMINI_POLISH_ENABLED=true`, eligible transcript text is sent to Google's Gemini API; keep it `false` to disable that extra processing path.
