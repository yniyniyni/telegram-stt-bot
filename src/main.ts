import dotenv from 'dotenv';
dotenv.config();

import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { initDb, closeDb, getCachedTranscription, cacheTranscription } from './db.js';
import { downloadTelegramFile, cleanupFile } from './audio.js';
import { transcribeFile } from './transcriber.js';
import {
  isChatAuthorized,
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

// Determine max audio duration (default: 10 minutes)
const MAX_DURATION = parseInt(process.env.MAX_AUDIO_DURATION_SEC || '600', 10);

/**
 * Main message handler middleware.
 * Implements strict filtering: ignores all messages except voice, video note, and direct appeals.
 */
bot.on('message', async (ctx, next) => {
  const msg = ctx.message;
  const anyMsg = msg as any;
  const locale = getLocale();
  const chatId = ctx.chat.id;

  // 1. Identify content type
  const isVoice = 'voice' in msg;
  const isVideoNote = 'video_note' in msg;
  
  // Check if it's a direct appeal to the bot
  let isDirectAppeal = false;
  const isPrivate = ctx.chat.type === 'private';
  
  if (isPrivate) {
    isDirectAppeal = true;
  } else if ('text' in msg) {
    const text = msg.text || '';
    const botUsername = ctx.botInfo.username;
    
    // Check for mention
    const hasMention = text.includes(`@${botUsername}`);
    
    // Check if it's a reply to the bot's own message
    const isReplyToBot = anyMsg.reply_to_message?.from?.id === ctx.botInfo.id;
    
    if (hasMention || isReplyToBot) {
      isDirectAppeal = true;
    }
  }

  // Check if the appeal is a reply to a voice message or video note
  const repliedMsg = anyMsg.reply_to_message;
  const isRepliedVoice = !!(repliedMsg && 'voice' in repliedMsg);
  const isRepliedVideoNote = !!(repliedMsg && 'video_note' in repliedMsg);
  const shouldTranscribeReplied = isDirectAppeal && (isRepliedVoice || isRepliedVideoNote);

  // If the message is not a voice message, video note, or a direct appeal, ignore it completely
  if (!isVoice && !isVideoNote && !isDirectAppeal) {
    return;
  }

  // 2. Enforce fail-closed chat authorization
  if (!isChatAuthorized(chatId)) {
    log("WARN", `Unauthorized chat access attempt. Chat ID: ${chatId}`);
    // If it's a direct appeal or we want to inform the user, send unauthorized message
    if (isDirectAppeal || isVoice || isVideoNote) {
      try {
        await ctx.replyWithHTML(locale.chatNotAuthorized, { reply_to_message_id: msg.message_id } as any);
      } catch (err) {
        log("ERROR", `Failed to send auth warning: ${safeErrorForLog(err)}`);
      }
    }
    return;
  }

  // 3. Process direct appeals (text commands/messages) that are not replies to voice/video notes
  if (isDirectAppeal && !isVoice && !isVideoNote && !shouldTranscribeReplied) {
    if ('text' in msg) {
      const text = msg.text || '';
      const botUsername = ctx.botInfo.username;
      
      // Check if it's a standard command
      if (text.startsWith('/start') || text.includes(`@${botUsername} /start`)) {
        await ctx.replyWithHTML(locale.welcomeMessage(botUsername));
        return;
      }
      if (text.startsWith('/help') || text.includes(`@${botUsername} /help`)) {
        await ctx.replyWithHTML(locale.helpMessage(botUsername));
        return;
      }
      
      // Friendly response for other text appeals
      await ctx.replyWithHTML(locale.unknownCommand);
    }
    return;
  }

  // 4. Process voice messages and video notes
  const targetMsg = shouldTranscribeReplied ? repliedMsg! : msg;
  const targetIsVoice = shouldTranscribeReplied ? isRepliedVoice : isVoice;
  
  const anyTargetMsg = targetMsg as any;
  const fileId = targetIsVoice ? anyTargetMsg.voice.file_id : anyTargetMsg.video_note.file_id;
  const fileUniqueId = targetIsVoice ? anyTargetMsg.voice.file_unique_id : anyTargetMsg.video_note.file_unique_id;
  const duration = targetIsVoice ? anyTargetMsg.voice.duration : anyTargetMsg.video_note.duration;
  const userId = targetMsg.from?.id || 0;
  const username = targetMsg.from?.username;
  const fullName = [targetMsg.from?.first_name, targetMsg.from?.last_name].filter(Boolean).join(' ');

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

  // Check Database cache first
  const cachedText = await getCachedTranscription(fileUniqueId);
  if (cachedText !== null) {
    log("INFO", `Cache hit for file_unique_id: ${fileUniqueId}. Replying from database cache.`);
    await sendTranscriptionResult(ctx, cachedText, targetIsVoice, username, fullName);
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
    localTempFile = await downloadTelegramFile(fileLink.href);

    // Call Deepgram API for STT
    const transcriptText = await transcribeFile(localTempFile);

    // Cache the successful transcript in the database
    await cacheTranscription(fileUniqueId, chatId, userId, duration, transcriptText);

    // Reply with the transcription text
    await sendTranscriptionResult(ctx, transcriptText, targetIsVoice, username, fullName);

  } catch (err) {
    const errorMsg = safeErrorForLog(err);
    log("ERROR", `Transcription failed for file ${fileUniqueId}:`, err);
    try {
      await ctx.replyWithHTML(locale.transcriptionError(errorMsg), { reply_to_message_id: msg.message_id } as any);
    } catch (sendErr) {
      log("ERROR", `Failed to send transcription error: ${safeErrorForLog(sendErr)}`);
    }
  } finally {
    // 1. Delete local temp file (never keep audio files on the host after completion/failure)
    if (localTempFile) {
      cleanupFile(localTempFile);
    }
    
    // 2. Delete temporary transcribing status message
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
  username?: string,
  fullName?: string
): Promise<void> {
  const locale = getLocale();
  const msg = ctx.message;
  
  if (!rawText.trim()) {
    await ctx.replyWithHTML(locale.emptyTranscription, { reply_to_message_id: msg.message_id } as any);
    return;
  }

  // Format header
  const header = isVoice
    ? locale.transcriptionHeaderVoice(username, fullName)
    : locale.transcriptionHeaderVideoNote(username, fullName);

  // Combine header and sanitized text
  const fullHTML = header + sanitizeHTML(rawText);

  // Split into chunks if necessary (Telegram character limit is 4096)
  const chunks = splitHTMLText(fullHTML, 4000);

  for (const chunk of chunks) {
    await ctx.replyWithHTML(chunk, { reply_to_message_id: msg.message_id } as any);
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
