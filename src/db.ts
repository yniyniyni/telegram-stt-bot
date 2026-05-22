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

  // Migrate schema to add raw_text and polished_text if they are missing
  try {
    const tableInfo = await db.all(`PRAGMA table_info(transcriptions);`);
    const columns = tableInfo.map((col: any) => col.name);
    
    if (!columns.includes('raw_text')) {
      log("INFO", "Migrating database: Adding raw_text column to transcriptions table...");
      await db.exec(`ALTER TABLE transcriptions ADD COLUMN raw_text TEXT;`);
      // Copy existing transcription_text to raw_text
      await db.exec(`UPDATE transcriptions SET raw_text = transcription_text;`);
    }
    if (!columns.includes('polished_text')) {
      log("INFO", "Migrating database: Adding polished_text column to transcriptions table...");
      await db.exec(`ALTER TABLE transcriptions ADD COLUMN polished_text TEXT;`);
    }
  } catch (err) {
    log("ERROR", "Database schema migration failed:", err);
  }

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

export interface CachedTranscription {
  rawText: string;
  polishedText: string | null;
}

/**
 * Checks if a transcription already exists in the cache by file_unique_id.
 */
export async function getCachedTranscription(fileUniqueId: string): Promise<CachedTranscription | null> {
  try {
    const database = getDb();
    const result = await database.get<{ raw_text: string; polished_text: string | null; transcription_text: string }>(
      `SELECT raw_text, polished_text, transcription_text FROM transcriptions WHERE file_unique_id = ?`,
      [fileUniqueId]
    );
    if (!result) return null;

    // For backwards compatibility:
    const rawText = result.raw_text !== null ? result.raw_text : result.transcription_text;
    return {
      rawText: rawText || "",
      polishedText: result.polished_text
    };
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
  rawText: string,
  polishedText: string | null = null
): Promise<void> {
  try {
    const database = getDb();
    const now = Math.floor(Date.now() / 1000);
    await database.run(
      `INSERT OR REPLACE INTO transcriptions (file_unique_id, chat_id, user_id, audio_duration, transcription_text, raw_text, polished_text, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [fileUniqueId, chatId, userId, audioDuration, rawText, rawText, polishedText, now]
    );
    log("DEBUG", `Successfully cached transcription for file_unique_id: ${fileUniqueId}`);
  } catch (err) {
    log("ERROR", `Failed to cache transcription for ${fileUniqueId}:`, err);
  }
}

/**
 * Updates the polished text in the cache for an existing file.
 */
export async function updateCachedPolishedText(
  fileUniqueId: string,
  polishedText: string
): Promise<void> {
  try {
    const database = getDb();
    await database.run(
      `UPDATE transcriptions SET polished_text = ? WHERE file_unique_id = ?`,
      [polishedText, fileUniqueId]
    );
    log("DEBUG", `Successfully updated polished text cache for file_unique_id: ${fileUniqueId}`);
  } catch (err) {
    log("ERROR", `Failed to update polished text cache for ${fileUniqueId}:`, err);
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
