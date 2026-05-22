# Telegram Speech-to-Text Bot

[Русская версия (Russian Version)](docs/README_ru.md)

An automated Speech-to-Text (STT) Telegram bot built using **Node.js**, **TypeScript**, **SQLite**, and the **Deepgram API** (Nova-2 model). 

It automatically transcribes voice messages and video notes (circles) in authorized Telegram chats, provides intelligent caching to reduce API costs, and strictly ignores all unrelated messages to preserve privacy.

## Features

- **Automated STT**: Transcribes voice messages (`.ogg`) and video notes (`.mp4` circles) automatically when sent to the chat.
- **Direct Video Note Transcription**: Transcribes video notes directly through the Deepgram API without needing local `ffmpeg` system binary extraction on the host.
- **Strict Privacy**: No messages are saved in the database other than voice/video-note metadata and their text transcripts. Audio files are deleted from the host immediately after transcription.
- **Fail-Closed Authorization**: A whitelist-based access control checking `ALLOWED_CHATS` in `.env` to prevent unauthorized usage and protect API budgets.
- **Rate Limiting**: Custom rolling-window rate-limiting per chat to block spam and DOS attacks.
- **Smart Formatting**: Integrates Deepgram's `smart_format`, `punctuate`, and `numerals` configurations to automatically format punctuation, paragraphs, dates, numbers, and currency for readability.
- **Multilingual Support**: Bot UI and headers support both Russian (`ru`) and English (`en`) based on `BOT_LANGUAGE`.
- **HTML Message Splitting**: Sanitizes and splits long transcripts into chunks of under 4000 characters to prevent Telegram API errors while keeping HTML tags balanced.
- **AI-Powered Polishing (Gemini)**: Integrates Gemini AI (`gemini-3.1-flash-lite` by default) to polish long transcripts (default >45s). It automatically corrects spelling, grammar, removes verbal fillers, and fixes misrecognized words using context while preserving the exact word order and original meaning.
- **Granular Polishing Controls**: Flexible configuration options to turn off polishing completely or disable it specifically for video messages (video notes / circles) via `.env` toggles.

---

## Technical Stack

- **Language**: TypeScript
- **Runtime**: Node.js (v18+)
- **Framework**: Telegraf (Telegram Bot API wrapper)
- **Database**: SQLite (via `sqlite` and `sqlite3` packages)
- **STT Engine**: Deepgram REST API (Nova-2 model)
- **AI Polisher**: Google Gemini API (via `@google/genai` SDK)

---

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- A Telegram Bot Token (obtained from [@BotFather](https://t.me/BotFather))
- A Deepgram API Key (obtained from [console.deepgram.com](https://console.deepgram.com/))
- A Google Gemini API Key (obtained from [Google AI Studio](https://aistudio.google.com/)) (Optional: Only if transcription polishing is enabled)

### Installation

1. Clone the repository and navigate to the project directory:
   ```bash
   cd telegram-stt-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create your `.env` configuration:
   ```bash
   cp .env.example .env
   ```
   Fill in your tokens, adjust your authorized chat IDs, rate limits, and language settings.

---

## Configuration (`.env`)

Refer to [.env.example](.env.example) for details:

- `TELEGRAM_BOT_TOKEN`: Your Telegram Bot Token.
- `DEEPGRAM_API_KEY`: Your Deepgram API Token.
- `DEEPGRAM_MODEL`: The Deepgram model to use (default: `nova-2`).
- `DEEPGRAM_SMART_FORMAT`: Toggle formatting features (default: `true`).
- `ALLOW_ALL_CHATS`: If set to `true`, anyone can use the bot. If `false`, only chats in `ALLOWED_CHATS` are whitelisted.
- `ALLOWED_CHATS`: Comma-separated Telegram Chat IDs (e.g. `-100123456789,987654321`).
- `ALLOW_ALL_USERS`: If set to `true`, anyone can message the bot in private messages (DMs). If `false`, only user IDs in `ALLOWED_USERS` are allowed (default: `true`).
- `ALLOWED_USERS`: Comma-separated Telegram User IDs allowed to use the bot in private messages (DMs).
- `RATE_LIMIT_MAX_REQUESTS`: Max transcriptions allowed within the rolling window.
- `RATE_LIMIT_WINDOW_SEC`: Rolling window duration in seconds.
- `BOT_LANGUAGE`: Interface language (`ru` or `en`).
- `MAX_AUDIO_DURATION_SEC`: Max allowed duration for voice messages.
- `DB_FILE`: Path to SQLite database file.
- `DEBUG`: Turn on detailed debug logging.
- `GEMINI_POLISH_ENABLED`: Set to `false` to completely disable Gemini polishing (default: `true`).
- `GEMINI_POLISH_VIDEO`: Set to `false` to disable Gemini polishing specifically for video messages (default: `true`).
- `GEMINI_API_KEY`: Your Google Gemini API key.
- `GEMINI_MODEL`: Gemini model name (default: `gemini-3.1-flash-lite`).
- `POLISH_MIN_DURATION_SEC`: Minimum audio duration in seconds to trigger polishing (default: `45`).

---

## Available Scripts

- **Run in Development (Watch mode)**:
  ```bash
  npm run dev
  ```
- **Build the Project**:
  ```bash
  npm run build
  ```
- **Start Production Build**:
  ```bash
  npm start
  ```
- **Run Automated Tests**:
  ```bash
  npm run test
  ```
