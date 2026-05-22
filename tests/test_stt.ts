import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { initDb, closeDb, getCachedTranscription, cacheTranscription, updateCachedPolishedText } from '../src/db.js';
import { cleanupFile } from '../src/audio.js';
import { shouldPolishTranscript } from '../src/polisher.js';
import { determineMessageRouting } from '../src/routing.js';
import { getLocale } from '../src/locales.js';
import {
  escapeHTML,
  sanitizeHTML,
  splitHTMLText,
  isChatAuthorized,
  isUserAuthorized,
  isRateLimited,
  resetRateLimits
} from '../src/utils.js';

function captureEnv(names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function runTests() {
  console.log("🚀 Starting unit tests for Telegram STT Bot...\n");

  // --- Test 1: HTML Escaping & Sanitizing ---
  console.log("🧪 Test 1: HTML Escaping and Sanitizing");
  
  assert.strictEqual(escapeHTML("hello <world> & friends"), "hello &lt;world&gt; &amp; friends");
  assert.strictEqual(escapeHTML(`Tom's "cat"`), "Tom&#39;s &quot;cat&quot;");
  
  const untrusted = "Hello <b>world</b> <script>alert(1)</script> and <i>italic</i>";
  const sanitized = sanitizeHTML(untrusted);
  assert.ok(sanitized.includes("<b>world</b>"));
  assert.ok(!sanitized.includes("<script>"));
  assert.ok(sanitized.includes("&lt;script&gt;"));
  assert.ok(sanitized.includes("<i>italic</i>"));

  const sanitizedCode = sanitizeHTML("`<b>x</b>`");
  assert.strictEqual(sanitizedCode, "<code>&lt;b&gt;x&lt;/b&gt;</code>");

  const nestedCodeTags = sanitizeHTML("<code><b>x</b></code>");
  assert.strictEqual(nestedCodeTags, "<code>&lt;b&gt;x&lt;/b&gt;</code>");

  const crossingTags = sanitizeHTML("<b><i>x</b>y</i>");
  assert.strictEqual(crossingTags, "<b><i>x&lt;/b&gt;y</i></b>");

  const localeEnv = captureEnv(['BOT_LANGUAGE']);
  try {
    process.env.BOT_LANGUAGE = 'en';
    const genericError = getLocale().transcriptionError();
    assert.ok(!genericError.includes('Details'));
    assert.ok(!genericError.includes('Deepgram'));

    process.env.BOT_LANGUAGE = 'ru';
    assert.ok(!getLocale().transcriptionError().includes('Детали'));
  } finally {
    restoreEnv(localeEnv);
  }
  console.log("   ✅ HTML Escaping and Sanitizing passed.");

  // --- Test 2: HTML Splitting ---
  console.log("🧪 Test 2: HTML Text Splitting");
  const longText = "<b>Start " + "a".repeat(4500) + " End</b>";
  const chunks = splitHTMLText(longText, 2000);
  console.log("   DEBUG: chunks generated:", chunks.length);
  chunks.forEach((c, idx) => console.log(`     Chunk ${idx}: length=${c.length}`));
  
  assert.ok(chunks.length >= 3);
  assert.ok(chunks[0].startsWith("<b>"));
  assert.ok(chunks[0].endsWith("</b>"));
  assert.ok(chunks[1].startsWith("<b>"));
  assert.ok(chunks[1].endsWith("</b>"));
  assert.ok(chunks[chunks.length - 1].startsWith("<b>"));
  assert.ok(chunks[chunks.length - 1].endsWith("End</b>")); // Re-opened and closed properly

  const safeHTML = "<b>Header</b>" + sanitizeHTML("A & B <x>");
  assert.strictEqual(splitHTMLText(safeHTML, 4000, false)[0], "<b>Header</b>A &amp; B &lt;x&gt;");
  console.log(`   ✅ HTML text splitting passed. Split into ${chunks.length} chunks.`);

  // --- Test 3: Chat Authorization (Fail-Closed) ---
  console.log("🧪 Test 3: Fail-Closed Chat Authorization");
  const chatAuthEnv = captureEnv(['ALLOW_ALL_CHATS', 'ALLOWED_CHATS']);
  try {
    // Test scenario A: Whitelist is empty
    delete process.env.ALLOW_ALL_CHATS;
    delete process.env.ALLOWED_CHATS;
    assert.strictEqual(isChatAuthorized(12345), false);

    // Test scenario B: Whitelist contains values
    process.env.ALLOWED_CHATS = "12345, -100987654";
    assert.strictEqual(isChatAuthorized(12345), true);
    assert.strictEqual(isChatAuthorized(-100987654), true);
    assert.strictEqual(isChatAuthorized(99999), false);

    // Test scenario C: Allow all chats
    process.env.ALLOW_ALL_CHATS = "true";
    assert.strictEqual(isChatAuthorized(99999), true);
    console.log("   ✅ Fail-Closed Chat Authorization passed.");
  } finally {
    restoreEnv(chatAuthEnv);
  }

  // --- Test 4: Rate Limiting ---
  console.log("🧪 Test 4: Rate Limiting");
  const rateLimitEnv = captureEnv([
    'ALLOW_ALL_CHATS',
    'ALLOWED_CHATS',
    'RATE_LIMIT_MAX_REQUESTS',
    'RATE_LIMIT_WINDOW_SEC'
  ]);
  try {
    delete process.env.ALLOW_ALL_CHATS;
    process.env.RATE_LIMIT_MAX_REQUESTS = "3";
    process.env.RATE_LIMIT_WINDOW_SEC = "10";
    resetRateLimits();

    // First 3 requests should succeed
    assert.strictEqual(isRateLimited(100).limited, false);
    assert.strictEqual(isRateLimited(100).limited, false);
    assert.strictEqual(isRateLimited(100).limited, false);
    
    // 4th request should be limited
    const limitCheck = isRateLimited(100);
    assert.strictEqual(limitCheck.limited, true);
    assert.ok((limitCheck.retryAfter ?? 0) > 0);
    
    // Request from another chat should NOT be limited
    assert.strictEqual(isRateLimited(200).limited, false);
    console.log("   ✅ Rate Limiting passed.");
  } finally {
    resetRateLimits();
    restoreEnv(rateLimitEnv);
  }

  // --- Test 5: Database Caching ---
  console.log("🧪 Test 5: Database Caching");
  const originalDbFile = process.env.DB_FILE;
  const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-stt-bot-test-'));
  const testDbFile = path.join(testDbDir, 'test_db.sqlite');
  const legacyDbFile = path.join(testDbDir, 'test_legacy_db.sqlite');

  try {
    process.env.DB_FILE = testDbFile;
    await initDb();
    assert.strictEqual(fs.statSync(testDbDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(testDbFile).mode & 0o777, 0o600);

    const fileUniqueId = "test_unique_id_123";
    const chatId = 777;
    const userId = 888;
    const duration = 15;
    const transcript = "This is a cached speech-to-text response.";

    // Verify not cached yet
    const firstLookup = await getCachedTranscription(fileUniqueId);
    assert.strictEqual(firstLookup, null);

    // Cache raw only
    await cacheTranscription(fileUniqueId, chatId, userId, duration, transcript);

    // Retrieve raw only
    const secondLookup = await getCachedTranscription(fileUniqueId);
    assert.ok(secondLookup !== null);
    assert.strictEqual(secondLookup.rawText, transcript);
    assert.strictEqual(secondLookup.polishedText, null);

    // Cache raw and polished
    const polishedTranscript = "This is a polished speech-to-text response.";
    await cacheTranscription(fileUniqueId, chatId, userId, duration, transcript, polishedTranscript);

    // Retrieve raw and polished
    const thirdLookup = await getCachedTranscription(fileUniqueId);
    assert.ok(thirdLookup !== null);
    assert.strictEqual(thirdLookup.rawText, transcript);
    assert.strictEqual(thirdLookup.polishedText, polishedTranscript);

    const updatedPolishedTranscript = "Updated polished response.";
    await updateCachedPolishedText(fileUniqueId, updatedPolishedTranscript);
    const fourthLookup = await getCachedTranscription(fileUniqueId);
    assert.ok(fourthLookup !== null);
    assert.strictEqual(fourthLookup.polishedText, updatedPolishedTranscript);

    const rawOnlyOverwrite = "Raw transcript after polished text exists.";
    await cacheTranscription(fileUniqueId, chatId, userId, duration, rawOnlyOverwrite);
    const fifthLookup = await getCachedTranscription(fileUniqueId);
    assert.ok(fifthLookup !== null);
    assert.strictEqual(fifthLookup.rawText, rawOnlyOverwrite);
    assert.strictEqual(fifthLookup.polishedText, updatedPolishedTranscript);

    const replacementPolishedTranscript = "Replacement polished response.";
    await cacheTranscription(fileUniqueId, chatId, userId, duration, rawOnlyOverwrite, replacementPolishedTranscript);
    const sixthLookup = await getCachedTranscription(fileUniqueId);
    assert.ok(sixthLookup !== null);
    assert.strictEqual(sixthLookup.polishedText, replacementPolishedTranscript);

    await closeDb();

    const legacyDb = await open({
      filename: legacyDbFile,
      driver: sqlite3.Database
    });
    await legacyDb.exec(`
      CREATE TABLE transcriptions (
        file_unique_id TEXT PRIMARY KEY,
        chat_id INTEGER,
        user_id INTEGER,
        audio_duration INTEGER,
        transcription_text TEXT,
        timestamp INTEGER
      );
    `);
    const legacyTranscript = "Legacy transcription text.";
    await legacyDb.run(
      `INSERT INTO transcriptions (file_unique_id, chat_id, user_id, audio_duration, transcription_text, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["legacy_unique_id", chatId, userId, duration, legacyTranscript, 123456]
    );
    await legacyDb.close();

    process.env.DB_FILE = legacyDbFile;
    const migratedDb = await initDb();
    const migratedColumns = await migratedDb.all<{ name: string }[]>(`PRAGMA table_info(transcriptions);`);
    const migratedColumnNames = migratedColumns.map((column) => column.name);
    assert.ok(migratedColumnNames.includes('raw_text'));
    assert.ok(migratedColumnNames.includes('polished_text'));

    const legacyLookup = await getCachedTranscription("legacy_unique_id");
    assert.ok(legacyLookup !== null);
    assert.strictEqual(legacyLookup.rawText, legacyTranscript);
    assert.strictEqual(legacyLookup.polishedText, null);
    await closeDb();

    await assert.rejects(
      () => getCachedTranscription("after_close"),
      /Database not initialized/
    );
  } finally {
    await closeDb();
    if (originalDbFile === undefined) {
      delete process.env.DB_FILE;
    } else {
      process.env.DB_FILE = originalDbFile;
    }
    fs.rmSync(testDbDir, { recursive: true, force: true });
  }
  console.log("   ✅ Database Caching passed.");

  // --- Test 7: Gemini Polisher Failure Signal ---
  console.log("🧪 Test 7: Gemini Polisher Failure Signal");
  const { polishTranscript } = await import('../src/polisher.js');
  
  // Temporarily unset keys to test fallback
  const oldGeminiKey = process.env.GEMINI_API_KEY;
  const oldGoogleKey = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  const rawSample = "hello um this is raw speech like you know";
  await assert.rejects(
    () => polishTranscript(rawSample),
    /GEMINI_API_KEY|GOOGLE_API_KEY/
  );
  
  // Restore keys
  if (oldGeminiKey) process.env.GEMINI_API_KEY = oldGeminiKey;
  if (oldGoogleKey) process.env.GOOGLE_API_KEY = oldGoogleKey;
  
  console.log("   ✅ Gemini Polisher failure signal passed.");

  // --- Test 6: Direct Appeal and Reply Decision Logic ---
  console.log("🧪 Test 6: Direct Appeal & Reply Decision Logic");
  
  const botUsername = "stt_test_bot";
  const botId = 12345;

  const determineTargetMessage = (msg: any, isPrivateChat: boolean) =>
    determineMessageRouting(msg, { isPrivateChat, botUsername, botId });
  const summarizeRouting = (decision: any) => ({
    action: decision.action,
    targetIsVoice: decision.targetIsVoice,
    fileId: decision.fileId,
    fileUniqueId: decision.fileUniqueId,
    duration: decision.duration,
    userId: decision.userId
  });

  // Scenario 1: Normal text message in a group (not private chat) -> should ignore
  const res1 = determineTargetMessage({ text: "Hello guys" }, false);
  assert.strictEqual(res1.action, 'ignore');

  // Scenario 2: Direct voice message in a group -> should transcribe direct voice
  const res2 = determineTargetMessage({
    voice: { file_id: "v1", file_unique_id: "vu1", duration: 10 },
    from: { id: 999 }
  }, false);
  assert.deepStrictEqual(summarizeRouting(res2), {
    action: 'transcribe',
    targetIsVoice: true,
    fileId: "v1",
    fileUniqueId: "vu1",
    duration: 10,
    userId: 999
  });

  // Scenario 3: Mention in group, no reply -> should process as command
  const res3 = determineTargetMessage({ text: `@${botUsername} /help` }, false);
  assert.strictEqual(res3.action, 'command');

  // Scenario 4: Mention matching is exact and case-insensitive
  const resMentionSuffix = determineTargetMessage({
    text: `@${botUsername}_backup transcribe this`,
    reply_to_message: {
      voice: { file_id: "v_suffix", file_unique_id: "vu_suffix", duration: 25 },
      from: { id: 888 }
    }
  }, false);
  assert.strictEqual(resMentionSuffix.action, 'ignore');

  const resMentionUpper = determineTargetMessage({ text: `@${botUsername.toUpperCase()} /help` }, false);
  assert.strictEqual(resMentionUpper.action, 'command');

  // Scenario 5: Mention in group in reply to a voice message -> should transcribe replied voice
  const res4 = determineTargetMessage({
    text: `@${botUsername} transcribe this`,
    reply_to_message: {
      voice: { file_id: "v2", file_unique_id: "vu2", duration: 25 },
      from: { id: 888 }
    }
  }, false);
  assert.deepStrictEqual(summarizeRouting(res4), {
    action: 'transcribe',
    targetIsVoice: true,
    fileId: "v2",
    fileUniqueId: "vu2",
    duration: 25,
    userId: 888
  });

  // Scenario 6: Reply to another user's video note without mention -> should ignore
  const res5 = determineTargetMessage({
    text: "please transcribe",
    reply_to_message: {
      video_note: { file_id: "vid1", file_unique_id: "vidu1", duration: 60 },
      from: { id: 777 }
    }
  }, false);
  assert.strictEqual(res5.action, 'ignore');

  // Scenario 7: Text reply to a bot-authored video note -> should transcribe replied video note
  const res6 = determineTargetMessage({
    text: "do it",
    reply_to_message: {
      video_note: { file_id: "vid1", file_unique_id: "vidu1", duration: 60 },
      from: { id: botId } // The replied message is from the bot
    }
  }, false);
  assert.deepStrictEqual(summarizeRouting(res6), {
    action: 'transcribe',
    targetIsVoice: false,
    fileId: "vid1",
    fileUniqueId: "vidu1",
    duration: 60,
    userId: botId
  });

  console.log("   ✅ Direct Appeal & Reply Decision Logic passed.");

  // --- Test 8: Gemini Polishing Decision Logic ---
  console.log("🧪 Test 8: Gemini Polishing Decision Logic (Toggles & Video Notes)");

  // Case 1: Disabled globally
  assert.strictEqual(shouldPolishTranscript({ duration: 50, targetIsVoice: true, polishEnabled: false, polishVideo: true, minDuration: 45 }), false);
  assert.strictEqual(shouldPolishTranscript({ duration: 50, targetIsVoice: false, polishEnabled: false, polishVideo: true, minDuration: 45 }), false);

  // Case 2: Enabled globally, duration below or equal to threshold
  assert.strictEqual(shouldPolishTranscript({ duration: 45, targetIsVoice: true, polishEnabled: true, polishVideo: true, minDuration: 45 }), false);
  assert.strictEqual(shouldPolishTranscript({ duration: 10, targetIsVoice: true, polishEnabled: true, polishVideo: true, minDuration: 45 }), false);

  // Case 3: Voice message, above threshold
  assert.strictEqual(shouldPolishTranscript({ duration: 50, targetIsVoice: true, polishEnabled: true, polishVideo: false, minDuration: 45 }), true);
  assert.strictEqual(shouldPolishTranscript({ duration: 50, targetIsVoice: true, polishEnabled: true, polishVideo: true, minDuration: 45 }), true);

  // Case 4: Video note, above threshold, video polishing disabled
  assert.strictEqual(shouldPolishTranscript({ duration: 50, targetIsVoice: false, polishEnabled: true, polishVideo: false, minDuration: 45 }), false);

  // Case 5: Video note, above threshold, video polishing enabled
  assert.strictEqual(shouldPolishTranscript({ duration: 50, targetIsVoice: false, polishEnabled: true, polishVideo: true, minDuration: 45 }), true);

  console.log("   ✅ Gemini Polishing Decision Logic passed.");

  // --- Test 9: Temp Audio Cleanup Signal ---
  console.log("🧪 Test 9: Temp Audio Cleanup Signal");

  const cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-stt-bot-cleanup-'));
  try {
    const cleanupTarget = path.join(cleanupDir, 'audio.ogg');
    fs.writeFileSync(cleanupTarget, 'temporary audio');
    assert.strictEqual(cleanupFile(cleanupTarget), true);
    assert.strictEqual(fs.existsSync(cleanupTarget), false);
    assert.strictEqual(cleanupFile(path.join(cleanupDir, 'missing.ogg')), true);
    assert.strictEqual(cleanupFile(cleanupDir), false);
  } finally {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
  }

  console.log("   ✅ Temp Audio Cleanup Signal passed.");

  // --- Test 10: User Authorization (Private Messages / DMs) ---
  console.log("🧪 Test 10: User Authorization (Private Messages)");

  // Scenario A: Allow all users must be explicit
  delete process.env.ALLOW_ALL_USERS;
  delete process.env.ALLOWED_USERS;
  assert.strictEqual(isUserAuthorized(11111), false);

  // Scenario B: Allow all users is true
  process.env.ALLOW_ALL_USERS = "true";
  delete process.env.ALLOWED_USERS;
  assert.strictEqual(isUserAuthorized(11111), true);

  // Scenario C: Allow all users is false, whitelist empty
  process.env.ALLOW_ALL_USERS = "false";
  assert.strictEqual(isUserAuthorized(11111), false);

  // Scenario D: Allow all users is false, whitelist has values
  process.env.ALLOW_ALL_USERS = "false";
  process.env.ALLOWED_USERS = "11111, 22222";
  assert.strictEqual(isUserAuthorized(11111), true);
  assert.strictEqual(isUserAuthorized(22222), true);
  assert.strictEqual(isUserAuthorized(33333), false);

  // Clean up env vars
  delete process.env.ALLOW_ALL_USERS;
  delete process.env.ALLOWED_USERS;

  console.log("   ✅ User Authorization passed.");

  console.log("\n🎉 All tests passed successfully!");
}

runTests().catch(err => {
  console.error("\n❌ Test suite failed with error:", err);
  process.exit(1);
});
