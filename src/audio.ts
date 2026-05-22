import fs from 'fs';
import path from 'path';
import { Readable, Transform, TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { getPositiveIntegerEnv, log, redactTelegramFileUrl } from './utils.js';

interface DownloadTelegramFileOptions {
  destDir?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

class ByteLimitTransform extends Transform {
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.maxBytes) {
      callback(new Error(`Telegram file exceeds max size of ${this.maxBytes} bytes`));
      return;
    }

    callback(null, chunk);
  }
}

function ensurePrivateDirectory(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    log("WARN", `Failed to set private permissions on directory ${dir}:`, err);
  }
}

/**
 * Downloads a file from a URL to a local destination directory.
 * Uses native fetch and stream pipeline for memory-efficient downloads.
 * Returns the absolute path of the downloaded file.
 */
export async function downloadTelegramFile(fileLink: string, options: DownloadTelegramFileOptions = {}): Promise<string> {
  const destDir = options.destDir || 'data/temp';
  const timeoutMs = options.timeoutMs ?? getPositiveIntegerEnv('TELEGRAM_DOWNLOAD_TIMEOUT_MS', 60_000);
  const maxBytes = options.maxBytes ?? getPositiveIntegerEnv('MAX_TELEGRAM_FILE_BYTES', 50 * 1024 * 1024);

  ensurePrivateDirectory(destDir);

  // Parse file extension from the URL (e.g., .ogg or .mp4)
  const urlObj = new URL(fileLink);
  if (urlObj.protocol !== 'https:' || urlObj.hostname !== 'api.telegram.org' || !urlObj.pathname.startsWith('/file/bot')) {
    throw new Error('Unexpected Telegram file URL');
  }

  const ext = path.extname(urlObj.pathname) || '.ogg';
  const filename = `audio_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
  const destPath = path.resolve(destDir, filename);

  log("DEBUG", `Downloading file from Telegram: ${redactTelegramFileUrl(fileLink)} -> ${destPath}`);

  const response = await fetch(fileLink, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error'
  });
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Telegram file download response body is empty');
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsedContentLength = Number(contentLength);
    if (Number.isFinite(parsedContentLength) && parsedContentLength > maxBytes) {
      throw new Error(`Telegram file is too large (${parsedContentLength} bytes, limit ${maxBytes} bytes)`);
    }
  }

  // Cast body to any to avoid TypeScript compatibility issue between web streams and node streams
  const readable = Readable.fromWeb(response.body as any);
  const writeStream = fs.createWriteStream(destPath, { mode: 0o600 });

  try {
    await pipeline(readable, new ByteLimitTransform(maxBytes), writeStream);
  } catch (err) {
    cleanupFile(destPath);
    throw err;
  }

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
