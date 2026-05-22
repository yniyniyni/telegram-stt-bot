# Architecture and Implementation Guidance: Speech-to-Text Telegram Bot

This document outlines key recommendations, reusable modules, and specific implementations for developers or AI agents building the new **Speech-to-Text (STT) Telegram Bot** using the same TypeScript, Telegraf, and SQLite stack.

---

## 1. Core Tech Stack and Extensions

The stack remains highly consistent with the current project:
- **Language**: TypeScript (`tsconfig.json`, `tsx` for running dev/scripts).
- **Framework**: `telegraf` (Telegram Bot API wrapper).
- **Database**: SQLite (`sqlite` & `sqlite3`) for audit logs, rate limits, or transcribing cache.
- **Config**: `dotenv` for environment variables.

### New Dependencies Required for STT:
To handle speech-to-text, you will need a few extra tools:
1. **AI SDK**: Depending on the chosen AI provider (e.g., `openai` for Whisper API, `@deepgram/sdk`, `assemblyai`, or a simple HTTP client like `axios` / native `fetch` for direct REST requests).
2. **Audio Downloading**: A utility to download audio files from Telegram servers (`axios` or Node's native `stream/promises` / `fetch`).
3. **FFmpeg (Optional but Recommended)**: Telegram voice messages are stored in Opus-encoded OGG format (`.ogg`). If the target AI API does not support `.ogg` directly, or if you want to support arbitrary audio uploads (like `.mp3`, `.wav`, `.m4a`), you will need to process them.
   - npm package: `fluent-ffmpeg`
   - system requirement: `ffmpeg` binary must be installed on the host.

---

## 2. Best Solutions to Copy (Reusable Assets)

You should directly copy and adapt the following robust solutions from the current bot codebase:

### A. Fail-Closed Chat Authorization (`utils.ts`)
Transcribing audio is computationally and financially expensive. You must copy the whitelist-based authorization to prevent unauthorized chats from consuming API balance:

```typescript
// Copy from utils.ts
let cachedAllowedChats: Set<number> | null = null;
let cachedAllowedChatsRaw: string | undefined = undefined;

export function isChatAuthorized(chatId: number): boolean {
  if (process.env.ALLOW_ALL_CHATS === 'true') return true;

  const raw = process.env.ALLOWED_CHATS;
  if (raw === undefined || raw === "") {
    return false; // Fail-closed
  }

  if (raw !== cachedAllowedChatsRaw) {
    cachedAllowedChatsRaw = raw;
    cachedAllowedChats = new Set(
      raw.split(',')
        .map(s => s.trim())
        .filter(s => s !== '')
        .map(s => Number(s))
        .filter(n => !isNaN(n))
    );
  }
  return cachedAllowedChats ? cachedAllowedChats.has(chatId) : false;
}
```

### B. Rate Limiting (`utils.ts`)
To prevent DOS attacks or cost spikes from infinite loops/spammers, use the in-memory rolling window rate limiter:

```typescript
interface RateLimitInfo {
  timestamps: number[];
}
const rateLimits = new Map<number, RateLimitInfo>();

export function isRateLimited(chatId: number): { limited: boolean; retryAfter?: number } {
  const maxRequestsStr = process.env.RATE_LIMIT_MAX_REQUESTS;
  if (!maxRequestsStr || maxRequestsStr.trim() === "0") return { limited: false };

  const maxRequests = parseInt(maxRequestsStr, 10);
  const windowSec = parseInt(process.env.RATE_LIMIT_WINDOW_SEC || "3600", 10);
  
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSec;

  let info = rateLimits.get(chatId);
  if (!info) {
    info = { timestamps: [] };
    rateLimits.set(chatId, info);
  }

  info.timestamps = info.timestamps.filter(ts => ts > cutoff);

  if (info.timestamps.length >= maxRequests) {
    const oldestTs = info.timestamps[0];
    const retryAfter = (oldestTs + windowSec) - now;
    return { limited: true, retryAfter: retryAfter > 0 ? retryAfter : 1 };
  }

  info.timestamps.push(now);
  return { limited: false };
}
```

### C. Message Splitting and HTML Sanitization (`utils.ts`)
Telegram limits text messages to **4096 characters**. Long audio transcriptions will easily break this limit. Reusing the HTML splitting utility prevents syntax issues when sending chunked messages back to Telegram:
- **Reuse**: [splitHTMLText](file:///Users/yni/.gemini/antigravity/worktrees/brave-bohr/telegram-gemini-summarizer-bot/utils.ts#L330-L487)
- **Reuse**: [sanitizeHTML](file:///Users/yni/.gemini/antigravity/worktrees/brave-bohr/telegram-gemini-summarizer-bot/utils.ts#L68-L122)
- **Reuse**: [escapeHTML](file:///Users/yni/.gemini/antigravity/worktrees/brave-bohr/telegram-gemini-summarizer-bot/utils.ts#L5-L13)

### D. Localization Architecture (`locales.ts`)
Follow the standard `getLocale()` strategy to support multilingual responses (e.g., Russian and English). The `BOT_LANGUAGE` environment variable decides the language mapping dynamically.

### E. Safe API Error Logging (`utils.ts`)
Prevent logs from leaking secret tokens, usernames, or message content when network calls to Telegraf or AI APIs fail:
- **Reuse**: [safeErrorForLog](file:///Users/yni/.gemini/antigravity/worktrees/brave-bohr/telegram-gemini-summarizer-bot/utils.ts#L184-L204)

---

## 3. Database Schema Suggestions

For a Speech-to-Text bot, your `db.ts` SQLite database should focus on:
1. **Audit Logs**: Storing usage statistics (user ID, audio length, transcription token cost, timestamps).
2. **Caching (Optional)**: Storing transcription results indexed by Telegram `file_unique_id`. If the same voice message is forwarded or requested again, you can reply instantly from SQLite instead of hitting the AI API.

### Suggested SQLite Table structure:
```sql
CREATE TABLE IF NOT EXISTS transcriptions (
  file_unique_id TEXT PRIMARY KEY,
  chat_id INTEGER,
  user_id INTEGER,
  audio_duration INTEGER, -- in seconds
  transcription_text TEXT,
  timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  chat_id INTEGER,
  action_type TEXT, -- "voice", "audio"
  duration INTEGER,
  cost_estimate REAL,
  timestamp INTEGER
);
```

---

## 4. Key Recommendations and Implementation Workflow for AI Agents

When instructing an AI agent to build the Speech-to-Text bot, request the implementation in the following sequential stages:

### Step 1: Environment & Initialization
1. Establish standard `.env.example` containing:
   - `TELEGRAM_BOT_TOKEN`
   - `STT_API_KEY` / `OPENAI_API_KEY` / `DEEPGRAM_API_KEY`
   - `ALLOWED_CHATS` & `ALLOW_ALL_CHATS`
   - `RATE_LIMIT_MAX_REQUESTS` & `RATE_LIMIT_WINDOW_SEC`
   - `BOT_LANGUAGE` (default: `ru`)
   - `MAX_AUDIO_DURATION_SEC` (protect bot from translating multi-hour files)
2. Setup the entrypoint (`main.ts`) implementing check validation, setup logs, and system signal interception (`SIGINT`, `SIGTERM`) for clean database closure.

### Step 2: Database Layer (`db.ts`)
1. Implement helper routines to save a successful transcription cache.
2. Implement utility functions to fetch cached text based on `file_unique_id`.
3. Add a log aggregator to track total transcribed seconds per user for quotas.

### Step 3: Audio File Management (`audio.ts` - New Module)
1. Listen for `voice` and `audio` types in Telegraf:
   ```typescript
   bot.on(['voice', 'audio'], async (ctx) => { ... });
   ```
2. Retrieve the Telegram file path using:
   ```typescript
   const fileId = ctx.message.voice.file_id;
   const fileLink = await ctx.telegram.getFileLink(fileId);
   // fileLink.href will contain the direct download URL
   ```
3. Implement file downloader:
   - Write file stream safely to a temporary workspace directory (e.g. `data/temp/`).
   - Clean up temporary files immediately inside a `finally` block of the handler.

### Step 4: AI Transcription Service (`transcriber.ts` - New Module)
1. Choose the target API:
   - **OpenAI Whisper / Groq Whisper**: Accepts `.ogg` natively. Fast and accurate.
   - **AssemblyAI / Deepgram**: Great options for long form and speaker diarization.
2. Check if conversion to `.mp3` is required. If yes, write a helper using `fluent-ffmpeg`:
   ```typescript
   import ffmpeg from 'fluent-ffmpeg';
   // convert inputPath (.ogg) to outputPath (.mp3)
   ```
3. Implement the API client calling the transcription endpoint, handling timeouts, and retries.

### Step 5: Telegram Formatting and Delivery (`main.ts`)
1. Inform user when transcription starts: `⏳ Transcribing audio...`
2. Perform transcription.
3. On completion, parse the raw text. Ensure characters are escaped if using HTML tags to format details (like `<b>[Speaker 1]:</b>`).
4. If transcription is empty, return a localized message: `Could not hear any speech.`
5. Use `splitHTMLText` to send chunked Telegram messages if the output exceeds 4000 characters.
6. Support reply formatting, e.g., reply directly to the voice message request.

---

## 5. Verification Plan

Ensure your agents build the following test suites (modeled after `test_utils.ts` / `test_main.ts`):
- **Local Transcriber Mocking**: Test formatting code blocks and chunk splitting using pre-set transcript outputs.
- **Database transaction checks**: Verify that transcription caching works correctly and handles duplicate `file_unique_id` requests.
- **Rate limiting validation**: Simulate consecutive requests to ensure rate-limiting triggers appropriately.
- **Fail-closed authorization checks**: Verify that requests from non-whitelisted chats are strictly ignored.
