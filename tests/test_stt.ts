import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { initDb, closeDb, getCachedTranscription, cacheTranscription } from '../src/db.js';
import {
  escapeHTML,
  sanitizeHTML,
  splitHTMLText,
  isChatAuthorized,
  isRateLimited,
  resetRateLimits
} from '../src/utils.js';

async function runTests() {
  console.log("🚀 Starting unit tests for Telegram STT Bot...\n");

  // --- Test 1: HTML Escaping & Sanitizing ---
  console.log("🧪 Test 1: HTML Escaping and Sanitizing");
  
  assert.strictEqual(escapeHTML("hello <world> & friends"), "hello &lt;world&gt; &amp; friends");
  
  const untrusted = "Hello <b>world</b> <script>alert(1)</script> and <i>italic</i>";
  const sanitized = sanitizeHTML(untrusted);
  assert.ok(sanitized.includes("<b>world</b>"));
  assert.ok(!sanitized.includes("<script>"));
  assert.ok(sanitized.includes("&lt;script&gt;"));
  assert.ok(sanitized.includes("<i>italic</i>"));
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
  console.log(`   ✅ HTML text splitting passed. Split into ${chunks.length} chunks.`);

  // --- Test 3: Chat Authorization (Fail-Closed) ---
  console.log("🧪 Test 3: Fail-Closed Chat Authorization");
  
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

  // --- Test 4: Rate Limiting ---
  console.log("🧪 Test 4: Rate Limiting");
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

  // --- Test 5: Database Caching ---
  console.log("🧪 Test 5: Database Caching");
  const testDbFile = "data/test_db.sqlite";
  if (fs.existsSync(testDbFile)) {
    fs.unlinkSync(testDbFile);
  }
  process.env.DB_FILE = testDbFile;

  await initDb();
  
  const fileUniqueId = "test_unique_id_123";
  const chatId = 777;
  const userId = 888;
  const duration = 15;
  const transcript = "This is a cached speech-to-text response.";

  // Verify not cached yet
  const firstLookup = await getCachedTranscription(fileUniqueId);
  assert.strictEqual(firstLookup, null);

  // Cache it
  await cacheTranscription(fileUniqueId, chatId, userId, duration, transcript);

  // Retrieve it
  const secondLookup = await getCachedTranscription(fileUniqueId);
  assert.strictEqual(secondLookup, transcript);

  // Close and clean up test db file
  await closeDb();
  if (fs.existsSync(testDbFile)) {
    fs.unlinkSync(testDbFile);
  }
  console.log("   ✅ Database Caching passed.");

  console.log("\n🎉 All tests passed successfully!");
}

runTests().catch(err => {
  console.error("\n❌ Test suite failed with error:", err);
  process.exit(1);
});
