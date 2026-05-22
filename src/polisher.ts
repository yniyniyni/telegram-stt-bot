import { GoogleGenAI } from '@google/genai';
import { getPositiveIntegerEnv, log } from './utils.js';

let aiInstance: GoogleGenAI | null = null;

/**
 * Initializes and retrieves the Google Gen AI client.
 * Throws an error if neither GEMINI_API_KEY nor GOOGLE_API_KEY is set.
 */
function getAIClient(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("Neither GEMINI_API_KEY nor GOOGLE_API_KEY is set in the environment variables.");
    }
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

/**
 * Polishes raw speech-to-text transcript using Gemini.
 * It corrects grammar, punctuation, and obviously misrecognized words while:
 * 1. Strictly keeping word and sentence order.
 * 2. Not changing the core meaning/intent.
 * 3. Cleaning speech filler words.
 * 4. Formatting only using Telegram HTML tags.
 */
export async function polishTranscript(rawText: string): Promise<string> {
  if (!rawText || !rawText.trim()) {
    return rawText;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const timeoutMs = getPositiveIntegerEnv('GEMINI_TIMEOUT_MS', 120_000);
  const maxOutputTokens = getPositiveIntegerEnv('GEMINI_MAX_OUTPUT_TOKENS', 8192);
  
  const systemInstruction = 
    "You are an expert editor specializing in refining speech-to-text transcriptions.\n" +
    "Your goal is to polish the provided raw speech-to-text transcript. Follow these strict rules:\n" +
    "1. Do NOT change the order of words or sentences. Keep the original structure and flow of the speech intact.\n" +
    "2. Do NOT change the core meaning, intent, or details of the transcript. Preserve all original facts, names, and numbers.\n" +
    "3. You CAN and should correct/replace words that were clearly misrecognized by the speech-to-text engine (e.g., words that are phonetically similar but do not fit the semantic context of the speech, or gibberish words).\n" +
    "4. Add correct punctuation and capitalization.\n" +
    "5. Fix grammatical and spelling errors.\n" +
    "6. Remove speech filler words (such as 'um', 'uh', 'like', 'типа', 'как бы', 'этот', 'ну') only when they distract from readability, but do not reorganize sentences to do so.\n" +
    "7. Format the output exclusively using Telegram HTML tags: <b>text</b> (bold), <i>text</i> (italic), <code>text</code> (monospace). Do not use markdown formatting (such as #, **, _, `).\n" +
    "8. Return only the polished transcript, without any introductory or concluding remarks (e.g., do not say 'Here is the polished text:').";

  const userPrompt = `Please polish this raw transcript:\n\n${rawText}`;

  try {
    const aiClient = getAIClient();
    log("DEBUG", `Requesting transcript polishing via Gemini model '${model}'...`);

    const response = await aiClient.models.generateContent({
      model: model,
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.2,
        maxOutputTokens,
        httpOptions: {
          timeout: timeoutMs
        }
      }
    });

    const resultText = response.text || rawText;
    return resultText;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Failed to polish transcript using Gemini: ${errMsg}`);
    throw err;
  }
}
