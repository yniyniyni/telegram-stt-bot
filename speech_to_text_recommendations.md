# Architecture and Implementation Guidance: Speech-to-Text Telegram Bot

This document outlines key recommendations, reusable modules, and specific implementations for developers or AI agents building the new **Speech-to-Text (STT) Telegram Bot** using the same TypeScript, Telegraf, and SQLite stack.

---

## 1. Core Tech Stack and Extensions

The stack remains highly consistent with the current project:
- **Language**: TypeScript (`tsconfig.json`, `tsx` for running dev/scripts).
- **Framework**: `telegraf` (Telegram Bot API wrapper).
- **Database**: SQLite (`sqlite` & `sqlite3`) for audit logs, rate limits, or transcribing cache.
- **Config**: `dotenv` for environment variables.

### Dependencies:
1. **Speech-to-Text AI API**: E.g., `openai` (Whisper API), `@deepgram/sdk`, or `assemblyai`.
2. **Gemini SDK (For Polishing)**: `@google/genai` (same version: `^2.5.0` as current project).
3. **Audio Downloading**: `axios` or Node's native `fetch` / streams.
4. **FFmpeg (Optional but Recommended)**: Telegram voice messages are stored in Opus-encoded OGG format (`.ogg`). If the target STT API does not support `.ogg` directly, or if you want to support arbitrary audio uploads (like `.mp3`, `.wav`, `.m4a`), you will need to process them.
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
2. **Caching**: Storing transcription results indexed by Telegram `file_unique_id`. If the same voice message is forwarded or requested again, you can reply instantly from SQLite instead of hitting the AI API.

### Suggested SQLite Table structure:
```sql
CREATE TABLE IF NOT EXISTS transcriptions (
  file_unique_id TEXT PRIMARY KEY,
  chat_id INTEGER,
  user_id INTEGER,
  audio_duration INTEGER, -- in seconds
  raw_text TEXT,
  polished_text TEXT,     -- null if file_duration <= 45 seconds or polishing skipped
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

## 4. Transcript Polishing via Gemini (for > 45s files)

If the audio duration exceeds **45 seconds**, the transcript can be hard to read due to speech irregularities, lack of punctuation, filler words, or chaotic structure. Running it through Gemini with `gemini-3.1-flash-lite` provides a clean, polished read.

### A. Gemini SDK Initialization (`polisher.ts`)
Set up a polisher module that reuses the Google Gen AI client initialization:

```typescript
import { GoogleGenAI } from '@google/genai';
import { log } from './utils.js';

let aiInstance: GoogleGenAI | null = null;

function getAIClient(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("FATAL: Neither GEMINI_API_KEY nor GOOGLE_API_KEY is set. Cannot initialize AI client.");
    }
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}
```

### B. Gemini Polishing Handler (`polisher.ts`)
```typescript
import { getLocale } from './locales.js';
import { sanitizeHTML } from './utils.js';

export async function polishTranscript(rawText: string): Promise<string> {
  const locale = getLocale();
  const systemInstruction = 
    "You are an expert editor. Your task is to polish the provided raw speech-to-text transcription. " +
    "Fix grammatical errors, add correct punctuation, remove filler words (like 'um', 'uh', 'типа', 'как бы'), " +
    "and structure the text into readable paragraphs while fully preserving all original facts, numbers, and intent. " +
    "Do not summarize or shorten the details significantly. " +
    "Format the output exclusively using Telegram HTML tags: <b>text</b> (bold), <i>text</i> (italic), <code>text</code> (monospace). " +
    "Do not use markdown formatting (like #, **, _, `).";

  const userPrompt = `Please polish this raw transcript:\n\n${rawText}`;

  try {
    const aiClient = getAIClient();
    log("DEBUG", "Requesting transcript polishing via gemini-3.1-flash-lite...");
    
    const response = await aiClient.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.2
      }
    });

    const resultText = response.text || rawText;
    return sanitizeHTML(resultText);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Failed to polish transcript using Gemini: ${errMsg}`);
    return rawText; // Fallback to raw text if Gemini fails
  }
}
```

### C. Integrating Polishing Flow into Message Processing (`main.ts`)
```typescript
const duration = ctx.message.voice.duration; // duration in seconds
let rawTranscript = await transcribeAudio(localFilePath);

let finalResponse = `<b>🎙 Транскрипция:</b>\n\n${rawTranscript}`;

if (duration > 45) {
  try {
    // Notify user we are polishing
    const statusMsg = await ctx.reply("✍ <i>Длинное аудио. Полирую текст с помощью Gemini...</i>", { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id });
    
    const polished = await polishTranscript(rawTranscript);
    
    finalResponse = `<b>🎙 Транскрипция (Полированная):</b>\n\n${polished}`;
    
    // Clean up status message
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (err) {
    log("WARN", "Failed polishing step, falling back to raw transcript");
  }
}

// Send final response using splitHTMLText in case it exceeds 4000 chars
const chunks = splitHTMLText(finalResponse);
for (const chunk of chunks) {
  await ctx.reply(chunk, { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id });
}
```

---

## 5. Key Recommendations and Implementation Workflow for AI Agents

When instructing an AI agent to build the Speech-to-Text bot, request the implementation in the following sequential stages:

### Step 1: Environment & Initialization
1. Establish standard `.env.example` containing:
   - `TELEGRAM_BOT_TOKEN`
   - `STT_API_KEY`
   - `GEMINI_API_KEY` / `GOOGLE_API_KEY`
   - `ALLOWED_CHATS` & `ALLOW_ALL_CHATS`
   - `RATE_LIMIT_MAX_REQUESTS` & `RATE_LIMIT_WINDOW_SEC`
   - `BOT_LANGUAGE` (default: `ru`)
   - `MAX_AUDIO_DURATION_SEC` (protect bot from translating multi-hour files)
2. Setup the entrypoint (`main.ts`) implementing check validation, setup logs, and system signal interception (`SIGINT`, `SIGTERM`) for clean database closure.

### Step 2: Database Layer (`db.ts`)
1. Implement helper routines to save a successful transcription cache (storing both raw and polished text).
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
   ```
3. Implement file downloader:
   - Write file stream safely to a temporary workspace directory (e.g. `data/temp/`).
   - Clean up temporary files immediately inside a `finally` block of the handler.

### Step 4: AI Transcription & Gemini Polishing Service
1. Implement the API client calling the transcription endpoint, handling timeouts, and retries.
2. Implement the `polishTranscript` helper using the Gemini SDK to process texts when audio duration is >45s.

### Step 5: Telegram Formatting and Delivery (`main.ts`)
1. Inform user when transcription starts: `⏳ Transcribing audio...`
2. Perform transcription. If length > 45s, perform polishing and notify the user about it.
3. On completion, parse the raw/polished text. Ensure characters are escaped if using HTML tags to format details.
4. Use `splitHTMLText` to send chunked Telegram messages if the output exceeds 4000 characters.
5. Support reply formatting, replying directly to the voice message request.

---

## 6. Verification Plan

Ensure your agents build the following test suites (modeled after `test_utils.ts` / `test_main.ts`):
- **Local Transcriber & Gemini Mocking**: Test formatting code blocks, chunk splitting, and ensure polishing function is invoked only when duration is above 45.
- **Database transaction checks**: Verify that transcription caching works correctly and handles duplicate `file_unique_id` requests (saving/loading raw and polished states).
- **Rate limiting validation**: Simulate consecutive requests to ensure rate-limiting triggers appropriately.
- **Fail-closed authorization checks**: Verify that requests from non-whitelisted chats are strictly ignored.
