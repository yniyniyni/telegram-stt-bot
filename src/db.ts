import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { log } from './utils.js';

let db: Database | null = null;

/**
 * Initializes the SQLite database.
 * Creates the database directory and tables if they don't exist.
 */
export async function initDb(): Promise<Database> {
  if (db) return db;

  const dbPath = process.env.DB_FILE || 'data/db.sqlite';
  const dbDir = path.dirname(dbPath);

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    log("INFO", `Created database directory: ${dbDir}`);
  }

  log("INFO", `Initializing database at: ${dbPath}`);
  
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Create transcriptions table (caching transcripts by Telegram's file_unique_id)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      file_unique_id TEXT PRIMARY KEY,
      chat_id INTEGER,
      user_id INTEGER,
      audio_duration INTEGER,
      transcription_text TEXT,
      timestamp INTEGER
    );
  `);

  log("INFO", "Database tables initialized successfully.");
  return db;
}

/**
 * Gets the active database connection.
 * Throws an error if the database has not been initialized.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

/**
 * Checks if a transcription already exists in the cache by file_unique_id.
 */
export async function getCachedTranscription(fileUniqueId: string): Promise<string | null> {
  try {
    const database = getDb();
    const result = await database.get<{ transcription_text: string }>(
      `SELECT transcription_text FROM transcriptions WHERE file_unique_id = ?`,
      [fileUniqueId]
    );
    return result ? result.transcription_text : null;
  } catch (err) {
    log("ERROR", `Failed to query cached transcription for ${fileUniqueId}:`, err);
    return null;
  }
}

/**
 * Caches a transcription in the database.
 */
export async function cacheTranscription(
  fileUniqueId: string,
  chatId: number,
  userId: number,
  audioDuration: number,
  transcriptionText: string
): Promise<void> {
  try {
    const database = getDb();
    const now = Math.floor(Date.now() / 1000);
    await database.run(
      `INSERT OR REPLACE INTO transcriptions (file_unique_id, chat_id, user_id, audio_duration, transcription_text, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [fileUniqueId, chatId, userId, audioDuration, transcriptionText, now]
    );
    log("DEBUG", `Successfully cached transcription for file_unique_id: ${fileUniqueId}`);
  } catch (err) {
    log("ERROR", `Failed to cache transcription for ${fileUniqueId}:`, err);
  }
}

/**
 * Closes the database connection.
 */
export async function closeDb(): Promise<void> {
  if (db) {
    log("INFO", "Closing database connection...");
    await db.close();
    db = null;
    log("INFO", "Database connection closed.");
  }
}
