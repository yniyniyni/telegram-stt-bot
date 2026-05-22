import fs from 'fs';
import path from 'path';
import { log } from './utils.js';

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
      }>;
    }>;
  };
}

/**
 * Transcribes an audio/video file using the Deepgram REST API.
 * Returns the transcribed text string.
 */
export async function transcribeFile(filePath: string): Promise<string> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is not defined in the environment variables.");
  }

  const stats = fs.statSync(filePath);
  log("DEBUG", `Preparing transcription for file: ${filePath} (${stats.size} bytes)`);

  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  // Determine Mime Type
  let contentType = 'application/octet-stream';
  if (ext === '.ogg') {
    contentType = 'audio/ogg';
  } else if (ext === '.mp3') {
    contentType = 'audio/mp3';
  } else if (ext === '.wav') {
    contentType = 'audio/wav';
  } else if (ext === '.mp4' || ext === '.mpeg') {
    contentType = 'video/mp4';
  }

  // Build query parameters
  const params = new URLSearchParams();
  const model = process.env.DEEPGRAM_MODEL || 'nova-2';
  params.append('model', model);

  const useSmartFormat = (process.env.DEEPGRAM_SMART_FORMAT || 'true') === 'true';
  if (useSmartFormat) {
    params.append('smart_format', 'true');
    params.append('punctuate', 'true');
    params.append('numerals', 'true');
  }

  const envLang = process.env.DEEPGRAM_LANGUAGE || 'auto';
  if (envLang.toLowerCase() === 'auto') {
    params.append('detect_language', 'true');
  } else {
    params.append('language', envLang.toLowerCase());
  }

  const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;
  log("DEBUG", `Sending request to Deepgram API: ${url} (Content-Type: ${contentType})`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': contentType,
    },
    body: fileBuffer
  });

  if (!response.ok) {
    let errText = '';
    try {
      errText = await response.text();
    } catch {
      errText = response.statusText;
    }
    throw new Error(`Deepgram API error (HTTP ${response.status}): ${errText}`);
  }

  const data = (await response.json()) as DeepgramResponse;
  
  // Extract transcript
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (transcript === undefined) {
    log("WARN", `Deepgram returned response but no transcript structure: ${JSON.stringify(data)}`);
    return "";
  }

  return transcript.trim();
}
