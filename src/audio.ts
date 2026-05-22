import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { log } from './utils.js';

/**
 * Downloads a file from a URL to a local destination directory.
 * Uses native fetch and stream pipeline for memory-efficient downloads.
 * Returns the absolute path of the downloaded file.
 */
export async function downloadTelegramFile(fileLink: string, destDir = 'data/temp'): Promise<string> {
  // Ensure the destination directory exists
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Parse file extension from the URL (e.g., .ogg or .mp4)
  const urlObj = new URL(fileLink);
  const ext = path.extname(urlObj.pathname) || '.ogg';
  const filename = `audio_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
  const destPath = path.resolve(destDir, filename);

  log("DEBUG", `Downloading file from Telegram: ${fileLink} -> ${destPath}`);

  const response = await fetch(fileLink);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Telegram file download response body is empty');
  }

  // Cast body to any to avoid TypeScript compatibility issue between web streams and node streams
  const readable = Readable.fromWeb(response.body as any);
  const writeStream = fs.createWriteStream(destPath);
  
  await pipeline(readable, writeStream);
  
  log("DEBUG", `Download completed successfully. File size: ${fs.statSync(destPath).size} bytes`);
  return destPath;
}

/**
 * Safely deletes a file from the disk.
 */
export function cleanupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log("DEBUG", `Cleaned up local file: ${filePath}`);
    }
  } catch (err) {
    log("ERROR", `Failed to clean up file ${filePath}:`, err);
  }
}
