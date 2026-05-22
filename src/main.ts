import dotenv from 'dotenv';
dotenv.config();

import { Telegraf } from 'telegraf';
import { initDb, closeDb, getCachedTranscription, cacheTranscription, updateCachedPolishedText } from './db.js';
import { downloadTelegramFile, cleanupFile } from './audio.js';
import { transcribeFile } from './transcriber.js';
import { polishTranscript, shouldPolishTranscript } from './polisher.js';
import { determineMessageRouting } from './routing.js';
import {
  getPositiveIntegerEnv,
  isChatAuthorized,
  isUserAuthorized,
  isRateLimited,
  safeErrorForLog,
  splitHTMLText,
  sanitizeHTML,
  log
} from './utils.js';
import { getLocale } from './locales.js';

// Validate environment variables
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

if (!botToken) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN is not defined in environment variables.");
  process.exit(1);
}
if (!deepgramApiKey) {
  console.error("FATAL: DEEPGRAM_API_KEY is not defined in environment variables.");
  process.exit(1);
}

// Initialize Telegraf Bot
const bot = new Telegraf(botToken);

bot.catch((err) => {
  log("ERROR", `Unhandled bot error: ${safeErrorForLog(err)}`);
});

// Safety limits
const MAX_DURATION = getPositiveIntegerEnv('MAX_AUDIO_DURATION_SEC', 600);
const POLISH_MIN_DURATION = getPositiveIntegerEnv('POLISH_MIN_DURATION_SEC', 45);
const MAX_FILE_BYTES = getPositiveIntegerEnv('MAX_TELEGRAM_FILE_BYTES', 50 * 1024 * 1024);
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = getPositiveIntegerEnv('TELEGRAM_DOWNLOAD_TIMEOUT_MS', 60_000);
const MAX_CONCURRENT_TRANSCRIPTIONS = getPositiveIntegerEnv('MAX_CONCURRENT_TRANSCRIPTIONS', 2);
const POLISH_REQUESTED = process.env.GEMINI_POLISH_ENABLED === 'true';
const HAS_GEMINI_KEY = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const POLISH_ENABLED = POLISH_REQUESTED && HAS_GEMINI_KEY;
const POLISH_VIDEO = process.env.GEMINI_POLISH_VIDEO !== 'false';

if (POLISH_REQUESTED && !HAS_GEMINI_KEY) {
  log("WARN", "Gemini polishing is enabled, but GEMINI_API_KEY/GOOGLE_API_KEY is missing. Polishing will be skipped.");
}

class TranscriptionLimiter {
  private active = 0;

  constructor(private readonly maxActive: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.maxActive) {
      return false;
    }
    this.active += 1;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }
}

const transcriptionLimiter = new TranscriptionLimiter(MAX_CONCURRENT_TRANSCRIPTIONS);
const polishingLimiter = new TranscriptionLimiter(MAX_CONCURRENT_TRANSCRIPTIONS);

/**
 * Main message handler middleware.
 * Implements strict filtering: ignores all messages except voice, video note, and direct appeals.
 */
bot.on('message', async (ctx, next) => {
  const msg = ctx.message;
  const anyMsg = msg as any;
  const locale = getLocale();
  const chatId = ctx.chat.id;

  // Handle bot being added to a chat (group / supergroup)
  if (msg && 'new_chat_members' in msg) {
    const newMembers = anyMsg.new_chat_members || [];
    const botId = ctx.botInfo.id;
    const addedBot = newMembers.some((member: any) => member.id === botId);
    if (addedBot) {
      if (isChatAuthorized(chatId)) {
        try {
          await ctx.replyWithHTML(locale.unknownCommand);
        } catch (err) {
          log("ERROR", `Failed to send welcome message on add: ${safeErrorForLog(err)}`);
        }
      } else {
        log("WARN", `Unauthorized chat access attempt on add. Chat ID: ${chatId}`);
        try {
          await ctx.replyWithHTML(locale.chatNotAuthorized);
        } catch (err) {
          log("ERROR", `Failed to send auth warning on add: ${safeErrorForLog(err)}`);
        }
      }
    }
    return;
  }

  const isPrivate = ctx.chat.type === 'private';
  const routing = determineMessageRouting(msg, {
    isPrivateChat: isPrivate,
    botUsername: ctx.botInfo.username,
    botId: ctx.botInfo.id
  });

  // If the message is not a voice message, video note, or a direct appeal, ignore it completely
  if (routing.action === 'ignore') {
    return;
  }

  // 2. Enforce fail-closed authorization: private chats use user whitelist, groups use chat whitelist.
  const senderId = msg.from?.id || 0;
  if (isPrivate && !isUserAuthorized(senderId)) {
    log("WARN", `Unauthorized user private chat access attempt. User ID: ${senderId}`);
    if (routing.isDirectAppeal || routing.isVoice || routing.isVideoNote) {
      try {
        await ctx.replyWithHTML(locale.chatNotAuthorized, { reply_to_message_id: msg.message_id } as any);
      } catch (err) {
        log("ERROR", `Failed to send auth warning: ${safeErrorForLog(err)}`);
      }
    }
    return;
  }

  if (!isPrivate && !isChatAuthorized(chatId)) {
    log("WARN", `Unauthorized chat access attempt. Chat ID: ${chatId}`);
    if (routing.isDirectAppeal || routing.isVoice || routing.isVideoNote) {
      try {
        await ctx.replyWithHTML(locale.chatNotAuthorized, { reply_to_message_id: msg.message_id } as any);
      } catch (err) {
        log("ERROR", `Failed to send auth warning: ${safeErrorForLog(err)}`);
      }
    }
    return;
  }

  // 3. Process direct appeals (text commands/messages) that are not replies to voice/video notes
  if (routing.action === 'command') {
    if ('text' in msg) {
      const text = msg.text || '';
      const botUsername = ctx.botInfo.username;

      // Check if it's a standard command
      if (text.startsWith('/start') || text.includes(`@${botUsername} /start`)) {
        await safeReplyWithHTML(ctx, locale.welcomeMessage(botUsername), msg.message_id, "welcome message");
        return;
      }
      if (text.startsWith('/help') || text.includes(`@${botUsername} /help`)) {
        await safeReplyWithHTML(ctx, locale.helpMessage(botUsername), msg.message_id, "help message");
        return;
      }

      // Friendly response for other text appeals (only in private messages)
      if (isPrivate) {
        await safeReplyWithHTML(ctx, locale.unknownCommand, msg.message_id, "unknown command");
      }
    }
    return;
  }

  // 4. Process voice messages and video notes
  if (routing.action !== 'transcribe') {
    return;
  }
  const {
    targetIsVoice,
    fileId,
    fileUniqueId,
    duration,
    fileSize,
    userId,
    username,
    fullName
  } = routing;

  log("INFO", `Processing ${targetIsVoice ? 'voice' : 'video note'} from user ${userId} in chat ${chatId}. Duration: ${duration}s`);

  // Enforce rate limiting
  const rateLimit = isRateLimited(chatId);
  if (rateLimit.limited) {
    log("WARN", `Rate limit hit in chat ${chatId}. Retry after: ${rateLimit.retryAfter}s`);
    try {
      await ctx.replyWithHTML(locale.rateLimited(rateLimit.retryAfter || 1), { reply_to_message_id: msg.message_id } as any);
    } catch (err) {
      log("ERROR", `Failed to send rate limit message: ${safeErrorForLog(err)}`);
    }
    return;
  }

  // Enforce safety duration limits
  if (duration > MAX_DURATION) {
    log("WARN", `Audio duration ${duration}s exceeds maximum limit of ${MAX_DURATION}s in chat ${chatId}`);
    try {
      await ctx.replyWithHTML(locale.durationLimitExceeded(MAX_DURATION), { reply_to_message_id: msg.message_id } as any);
    } catch (err) {
      log("ERROR", `Failed to send duration limit error: ${safeErrorForLog(err)}`);
    }
    return;
  }

  if (typeof fileSize === 'number' && fileSize > MAX_FILE_BYTES) {
    log("WARN", `Telegram file size ${fileSize} bytes exceeds maximum limit of ${MAX_FILE_BYTES} bytes in chat ${chatId}`);
    try {
      await ctx.replyWithHTML(locale.fileSizeLimitExceeded(MAX_FILE_BYTES), { reply_to_message_id: msg.message_id } as any);
    } catch (err) {
      log("ERROR", `Failed to send file size limit error: ${safeErrorForLog(err)}`);
    }
    return;
  }

  // Check Database cache first
  let cached;
  try {
    cached = await getCachedTranscription(fileUniqueId);
  } catch (err) {
    log("ERROR", `Cache lookup failed for file ${fileUniqueId}; refusing to spend transcription quota: ${safeErrorForLog(err)}`);
    await safeReplyWithHTML(ctx, locale.transcriptionError(), msg.message_id, "cache lookup error");
    return;
  }

  if (cached !== null) {
    log("INFO", `Cache hit for file_unique_id: ${fileUniqueId}. Replying from database cache.`);
    
    const qualifiesForPolishing = shouldPolishTranscript({
      polishEnabled: POLISH_ENABLED,
      duration,
      minDuration: POLISH_MIN_DURATION,
      targetIsVoice,
      polishVideo: POLISH_VIDEO
    });
    let textToSend = (qualifiesForPolishing ? cached.polishedText : null) || cached.rawText;
    let isPolished = qualifiesForPolishing && !!cached.polishedText;

    // On-demand polishing if cached before we added polishing, and now it qualifies
    if (qualifiesForPolishing && !cached.polishedText) {
      if (!polishingLimiter.tryAcquire()) {
        log("WARN", `Polishing concurrency limit hit for cached transcript ${fileUniqueId}. Sending raw cached text.`);
      } else {
        log("INFO", `File ${fileUniqueId} qualifies for polishing but only raw text was cached. Polishing on demand...`);
        let polishStatusMsgId: number | null = null;
        try {
          const polishStatusMsg = await ctx.replyWithHTML(locale.polishing, { reply_to_message_id: msg.message_id } as any);
          polishStatusMsgId = polishStatusMsg.message_id;

          const polished = await polishTranscript(cached.rawText);
          textToSend = polished;
          isPolished = true;
          try {
            await updateCachedPolishedText(fileUniqueId, polished);
          } catch (cacheErr) {
            log("ERROR", `Failed to cache polished transcript for ${fileUniqueId}: ${safeErrorForLog(cacheErr)}`);
          }
        } catch (err) {
          log("ERROR", `Failed to polish cached transcript on demand: ${safeErrorForLog(err)}`);
        } finally {
          polishingLimiter.release();
          if (polishStatusMsgId !== null) {
            try {
              await ctx.telegram.deleteMessage(chatId, polishStatusMsgId);
            } catch (delErr) {
              log("WARN", `Failed to delete polishing status message ${polishStatusMsgId}: ${safeErrorForLog(delErr)}`);
            }
          }
        }
      }
    }

    await sendTranscriptionResult(ctx, textToSend, targetIsVoice, isPolished, username, fullName);
    return;
  }

  if (!transcriptionLimiter.tryAcquire()) {
    log("WARN", `Transcription concurrency limit hit. Max active: ${MAX_CONCURRENT_TRANSCRIPTIONS}`);
    try {
      await ctx.replyWithHTML(locale.tooManyTranscriptions, { reply_to_message_id: msg.message_id } as any);
    } catch (err) {
      log("ERROR", `Failed to send concurrency limit message: ${safeErrorForLog(err)}`);
    }
    return;
  }

  // Send temporary transcribing status message
  let statusMsgId: number | null = null;
  try {
    const statusMsg = await ctx.replyWithHTML(locale.transcribing, { reply_to_message_id: msg.message_id } as any);
    statusMsgId = statusMsg.message_id;
  } catch (err) {
    log("ERROR", `Failed to send transcribing status message: ${safeErrorForLog(err)}`);
  }

  let localTempFile: string | null = null;
  try {
    // Get file download link from Telegram
    const fileLink = await ctx.telegram.getFileLink(fileId);
    
    // Download to local temp folder
    localTempFile = await downloadTelegramFile(fileLink.href, {
      timeoutMs: TELEGRAM_DOWNLOAD_TIMEOUT_MS,
      maxBytes: MAX_FILE_BYTES
    });

    // Call Deepgram API for STT
    const transcriptText = await transcribeFile(localTempFile);

    let polishedText: string | null = null;
    let isPolished = false;

    const qualifiesForPolishing = shouldPolishTranscript({
      polishEnabled: POLISH_ENABLED,
      duration,
      minDuration: POLISH_MIN_DURATION,
      targetIsVoice,
      polishVideo: POLISH_VIDEO
    });

    // Handle polishing if qualifies
    if (qualifiesForPolishing) {
      // 1. Delete transcribing message first
      if (statusMsgId !== null) {
        try {
          await ctx.telegram.deleteMessage(chatId, statusMsgId);
          statusMsgId = null;
        } catch (delErr) {
          log("WARN", `Failed to delete transcribing status: ${safeErrorForLog(delErr)}`);
        }
      }

      // 2. Send polishing message
      let polishStatusMsg: any = null;
      try {
        polishStatusMsg = await ctx.replyWithHTML(locale.polishing, { reply_to_message_id: msg.message_id } as any);
      } catch (err) {
        log("ERROR", `Failed to send polishing status message: ${safeErrorForLog(err)}`);
      }

      try {
        polishedText = await polishTranscript(transcriptText);
        isPolished = true;
      } catch (err) {
        log("ERROR", `Polishing step failed: ${safeErrorForLog(err)}`);
      } finally {
        if (polishStatusMsg !== null) {
          try {
            await ctx.telegram.deleteMessage(chatId, polishStatusMsg.message_id);
          } catch (delErr) {
            log("WARN", `Failed to delete polishing status: ${safeErrorForLog(delErr)}`);
          }
        }
      }
    }

    // Reply with the transcription text
    const finalToSend = isPolished && polishedText ? polishedText : transcriptText;
    try {
      await cacheTranscription(fileUniqueId, chatId, userId, duration, transcriptText, polishedText);
    } catch (cacheErr) {
      log("ERROR", `Failed to cache transcript for ${fileUniqueId}; sending result anyway: ${safeErrorForLog(cacheErr)}`);
    }
    await sendTranscriptionResult(ctx, finalToSend, targetIsVoice, isPolished, username, fullName);

  } catch (err) {
    const errorMsg = safeErrorForLog(err);
    log("ERROR", `Transcription failed for file ${fileUniqueId}: ${errorMsg}`);
    try {
      await ctx.replyWithHTML(locale.transcriptionError(), { reply_to_message_id: msg.message_id } as any);
    } catch (sendErr) {
      log("ERROR", `Failed to send transcription error: ${safeErrorForLog(sendErr)}`);
    }
  } finally {
    transcriptionLimiter.release();

    // 1. Delete local temp file (never keep audio files on the host after completion/failure)
    if (localTempFile) {
      const cleanupSucceeded = cleanupFile(localTempFile);
      if (!cleanupSucceeded) {
        log("ERROR", `TEMP_AUDIO_CLEANUP_FAILED path=${localTempFile}`);
      }
    }
    
    // 2. Delete temporary transcribing status message if still exists
    if (statusMsgId !== null) {
      try {
        await ctx.telegram.deleteMessage(chatId, statusMsgId);
      } catch (deleteErr) {
        log("WARN", `Failed to delete status message ${statusMsgId}: ${safeErrorForLog(deleteErr)}`);
      }
    }
  }
});

/**
 * Formats and sends transcription results to the chat (handles long texts via chunks).
 */
async function sendTranscriptionResult(
  ctx: any,
  rawText: string,
  isVoice: boolean,
  isPolished: boolean,
  username?: string,
  fullName?: string
): Promise<void> {
  const locale = getLocale();
  const msg = ctx.message;
  
  if (!rawText.trim()) {
    await safeReplyWithHTML(ctx, locale.emptyTranscription, msg.message_id, "empty transcription");
    return;
  }

  // Format header depending on whether it is polished
  let header = "";
  if (isPolished) {
    header = isVoice
      ? locale.transcriptionHeaderVoicePolished(username, fullName)
      : locale.transcriptionHeaderVideoNotePolished(username, fullName);
  } else {
    header = isVoice
      ? locale.transcriptionHeaderVoice(username, fullName)
      : locale.transcriptionHeaderVideoNote(username, fullName);
  }

  // Combine header and sanitized text
  const fullHTML = header + sanitizeHTML(rawText);

  // Split into chunks if necessary (Telegram character limit is 4096)
  const chunks = splitHTMLText(fullHTML, 4000, false);

  for (let i = 0; i < chunks.length; i++) {
    const sent = await safeReplyWithHTML(ctx, chunks[i], msg.message_id, `transcription chunk ${i + 1}/${chunks.length}`);
    if (!sent) {
      break;
    }
  }
}

async function safeReplyWithHTML(
  ctx: any,
  html: string,
  replyToMessageId: number | undefined,
  description: string
): Promise<boolean> {
  try {
    if (replyToMessageId !== undefined) {
      await ctx.replyWithHTML(html, { reply_to_message_id: replyToMessageId } as any);
    } else {
      await ctx.replyWithHTML(html);
    }
    return true;
  } catch (err) {
    log("ERROR", `Failed to send ${description}: ${safeErrorForLog(err)}`);
    return false;
  }
}

// Global initialization
async function startApp() {
  try {
    // 1. Initialize DB
    await initDb();

    // 2. Launch Telegram Bot
    await bot.launch();
    log("INFO", `Bot @${bot.botInfo!.username} started successfully.`);

    // Enable graceful stop
    const handleShutdown = async (signal: string) => {
      log("INFO", `Received signal ${signal}. Shutting down...`);
      bot.stop(signal);
      await closeDb();
      process.exit(0);
    };

    process.once('SIGINT', () => handleShutdown('SIGINT'));
    process.once('SIGTERM', () => handleShutdown('SIGTERM'));

  } catch (err) {
    log("ERROR", "Failed to start application:", err);
    process.exit(1);
  }
}

startApp();
