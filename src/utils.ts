/**
 * Escapes characters that have special meaning in HTML (&, <, >).
 * Used to prevent HTML injection/parsing errors for error logs and dynamic texts.
 */
export function escapeHTML(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getPositiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }

  return parsed;
}

export function redactTelegramFileUrl(url: string): string {
  return url.replace(/\/bot[^/]+/g, '/bot<redacted>');
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Converts basic markdown formatting (headers, bold, italic, code blocks, inline code)
 * into Telegram-compatible HTML tags.
 */
export function convertMarkdownToHTML(text: string): string {
  if (!text) return "";

  let result = text;
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Stash code blocks: ```code```
  result = result.replace(/```([\s\S]*?)```/g, (match, code) => {
    codeBlocks.push(code);
    return `@@CODE_BLOCK_PLACEHOLDER_${codeBlocks.length - 1}@@`;
  });

  // 2. Stash inline code: `code`
  result = result.replace(/`([^`\n]+)`/g, (match, code) => {
    inlineCodes.push(code);
    return `@@INLINE_CODE_PLACEHOLDER_${inlineCodes.length - 1}@@`;
  });

  // 3. Bold: **text** or __text__ -> <b>text</b>
  result = result.replace(/\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*/g, '<b>$1</b>');
  result = result.replace(/(?<![A-Za-z0-9_])__([^\s_](?:[^_]*?[^\s_])?)__(?![A-Za-z0-9_])/g, '<b>$1</b>');

  // 4. Italic: *text* or _text_ -> <i>text</i>
  result = result.replace(/(?<!\*)\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\*)/g, '<i>$1</i>');
  result = result.replace(/(?<![A-Za-z0-9_])_([^\s_](?:[^_]*?[^\s_])?)_(?![A-Za-z0-9_])/g, '<i>$1</i>');

  // 5. Headers: ^###+ header -> <b>header</b>
  result = result.replace(/^[ \t]*#+[ \t]+(.+)$/gm, '<b>$1</b>');

  // 6. Restore inline code
  result = result.replace(/@@INLINE_CODE_PLACEHOLDER_(\d+)@@/g, (match, index) => {
    const code = inlineCodes[parseInt(index, 10)];
    return `<code>${code}</code>`;
  });

  // 7. Restore code blocks
  result = result.replace(/@@CODE_BLOCK_PLACEHOLDER_(\d+)@@/g, (match, index) => {
    const code = codeBlocks[parseInt(index, 10)];
    return `<pre>${code}</pre>`;
  });

  return result;
}

/**
 * Sanitizes HTML output. Escapes all `<`, `>`, and `&` characters
 * except for whitelisted safe Telegram formatting tags: b, i, code, pre.
 */
export function sanitizeHTML(input: string): string {
  if (!input) return "";

  // Convert markdown to HTML before sanitization
  const convertedInput = convertMarkdownToHTML(input);

  // Split string by HTML tags: </?[tagName] ...>
  const parts = convertedInput.split(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g);
  
  // Whitelisted tags that are safe for Telegram.
  const allowedTags = new Set(['b', 'i', 'code', 'pre', '/b', '/i', '/code', '/pre']);

  const openTags: string[] = [];

  const mapped = parts.map((part, index) => {
    // Odd indices correspond to matched tag tokens
    if (index % 2 === 1) {
      const match = part.match(/^<\/?([a-zA-Z0-9]+)/);
      if (match) {
        const tagName = match[1].toLowerCase();
        const fullTagName = part.startsWith('</') ? `/${tagName}` : tagName;
        
        if (allowedTags.has(fullTagName)) {
          const isClose = part.startsWith('</');
          if (isClose) {
            const lastIdx = openTags.lastIndexOf(tagName);
            if (lastIdx !== -1) {
              openTags.splice(lastIdx, 1);
              return `</${tagName}>`;
            }
            return "";
          } else {
            if (openTags.includes(tagName)) {
              return "";
            }
            openTags.push(tagName);
            return `<${tagName}>`;
          }
        }
      }
      // If tag is not whitelisted, treat it as plain text and escape
      return escapeHTML(part);
    } else {
      // Plain text token
      return escapeHTML(part);
    }
  }).join('');

  if (openTags.length > 0) {
    const closeTags = [...openTags].reverse().map(tag => `</${tag}>`).join('');
    return mapped + closeTags;
  }
  return mapped;
}

// In-memory store for tracking chat rate limits
interface RateLimitInfo {
  timestamps: number[];
}
const rateLimits = new Map<number, RateLimitInfo>();

/**
 * Checks if a chat is rate-limited based on configuration in .env.
 * If limited, returns { limited: true, retryAfter: seconds }.
 * Otherwise, records the timestamp and returns { limited: false }.
 */
export function isRateLimited(chatId: number): { limited: boolean; retryAfter?: number } {
  const maxRequestsStr = process.env.RATE_LIMIT_MAX_REQUESTS;
  if (maxRequestsStr === undefined || maxRequestsStr === "" || maxRequestsStr.trim() === "0") {
    return { limited: false };
  }
  const maxRequests = parseInt(maxRequestsStr, 10);
  if (isNaN(maxRequests) || maxRequests < 0) {
    log("WARN", `Invalid RATE_LIMIT_MAX_REQUESTS value: "${maxRequestsStr}". Rate limiting all requests as a safety measure.`);
    return { limited: true, retryAfter: 3600 };
  }

  const windowSecStr = process.env.RATE_LIMIT_WINDOW_SEC;
  let windowSec = 3600;
  if (windowSecStr !== undefined && windowSecStr !== "") {
    const parsedWindow = parseInt(windowSecStr, 10);
    if (isNaN(parsedWindow) || parsedWindow <= 0) {
      windowSec = 3600;
    } else {
      windowSec = parsedWindow;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSec;

  let info = rateLimits.get(chatId);
  if (!info) {
    info = { timestamps: [] };
    rateLimits.set(chatId, info);
  }

  // Filter out timestamps older than the window
  info.timestamps = info.timestamps.filter(ts => ts > cutoff);

  if (info.timestamps.length >= maxRequests) {
    const oldestTs = info.timestamps[0];
    const retryAfter = (oldestTs + windowSec) - now;
    return { limited: true, retryAfter: retryAfter > 0 ? retryAfter : 1 };
  }

  // Record current request
  info.timestamps.push(now);
  return { limited: false };
}

/**
 * Safely extracts error details from a Telegram API error (or normal error)
 * without leaking sensitive/private chat logs or tokens to the server log.
 */
export function safeErrorForLog(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as any;
    const isTelegramErr = !!(
      (e.response && (e.response.error_code !== undefined || e.response.description !== undefined)) ||
      (e.on && (e.on.payload !== undefined || e.on.method !== undefined))
    );

    if (isTelegramErr) {
      const code = e.response?.error_code || e.code;
      const desc = e.response?.description || e.description || e.message;
      const method = e.on?.method;
      const methodStr = method ? ` (method: ${method})` : '';
      const params = e.response?.parameters;
      const paramsStr = params ? ` (parameters: ${JSON.stringify(params)})` : '';
      return `Telegram API Error: [${code}] ${desc}${methodStr}${paramsStr}`;
    }
    return e.message || String(err);
  }
  return String(err);
}

/**
 * Resets the in-memory rate limits tracker (useful for tests).
 */
export function resetRateLimits(): void {
  rateLimits.clear();
}

// Cached allowed chats set for O(1) lookup
let cachedAllowedChats: Set<number> | null = null;
let cachedAllowedChatsRaw: string | undefined = undefined;

/**
 * Validates if the chat is authorized to use the bot based on whitelist in .env.
 * If ALLOW_ALL_CHATS is 'true', all chats are allowed.
 * Otherwise, if ALLOWED_CHATS is undefined or empty string, authorization fails (fail-closed).
 */
export function isChatAuthorized(chatId: number): boolean {
  if (process.env.ALLOW_ALL_CHATS === 'true') {
    return true;
  }

  const raw = process.env.ALLOWED_CHATS;

  if (raw === undefined || raw === "") {
    cachedAllowedChats = null;
    cachedAllowedChatsRaw = raw;
    return false;
  }

  // Re-parse only if the env value changed
  if (raw !== cachedAllowedChatsRaw) {
    cachedAllowedChatsRaw = raw;
    cachedAllowedChats = new Set(
      raw.split(',')
        .map(s => s.trim())
        .filter(s => s !== '')
        .map(s => Number(s))
        .filter(n => !isNaN(n))
    );
  }

  return cachedAllowedChats ? cachedAllowedChats.has(chatId) : false;
}

// Cached allowed users set for O(1) lookup
let cachedAllowedUsers: Set<number> | null = null;
let cachedAllowedUsersRaw: string | undefined = undefined;

/**
 * Validates if the user is authorized to use the bot in private messages (DMs) based on .env whitelist.
 * If ALLOW_ALL_USERS is not 'false' (default true), all users are allowed.
 * Otherwise, checks the sender's userId against the ALLOWED_USERS comma-separated list.
 */
export function isUserAuthorized(userId: number): boolean {
  if (process.env.ALLOW_ALL_USERS !== 'false') {
    return true;
  }

  const raw = process.env.ALLOWED_USERS;

  if (raw === undefined || raw === "") {
    cachedAllowedUsers = null;
    cachedAllowedUsersRaw = raw;
    return false;
  }

  // Re-parse only if the env value changed
  if (raw !== cachedAllowedUsersRaw) {
    cachedAllowedUsersRaw = raw;
    cachedAllowedUsers = new Set(
      raw.split(',')
        .map(s => s.trim())
        .filter(s => s !== '')
        .map(s => Number(s))
        .filter(n => !isNaN(n))
    );
  }

  return cachedAllowedUsers ? cachedAllowedUsers.has(userId) : false;
}

/**
 * Safely truncates HTML text to a maximum character length, ensuring that tags are closed
 * and not cut in half, and preventing duplicate tag types in the open stack.
 */
function truncateHTMLToLength(html: string, maxLen: number): string {
  if (html.length <= maxLen) return html;

  const parts = html.split(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g);
  let current = "";
  const open: string[] = [];
  let bestFit = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    const isTag = i % 2 === 1;
    if (isTag) {
      const match = part.match(/^<\/?([a-zA-Z0-9]+)/);
      const tagName = match ? match[1].toLowerCase() : "";
      const isClose = part.startsWith('</');

      const nextOpen = [...open];
      if (tagName) {
        if (isClose) {
          const lastIdx = nextOpen.lastIndexOf(tagName);
          if (lastIdx !== -1) nextOpen.splice(lastIdx, 1);
        } else {
          if (!nextOpen.includes(tagName)) {
            nextOpen.push(tagName);
          }
        }
      }

      const closeTagsStr = nextOpen.map(t => `</${t}>`).reverse().join('');
      const potential = current + part + closeTagsStr;
      if (potential.length <= maxLen) {
        current += part;
        if (tagName) {
          if (isClose) {
            const lastIdx = open.lastIndexOf(tagName);
            if (lastIdx !== -1) open.splice(lastIdx, 1);
          } else {
            if (!open.includes(tagName)) {
              open.push(tagName);
            }
          }
        }
        bestFit = potential;
      } else {
        break;
      }
    } else {
      let added = "";
      for (let j = 0; j < part.length; j++) {
        const char = part[j];
        const closeTagsStr = open.map(t => `</${t}>`).reverse().join('');
        const potential = current + added + char + closeTagsStr;
        if (potential.length <= maxLen) {
          added += char;
          bestFit = potential;
        } else {
          break;
        }
      }
      if (added.length < part.length) {
        break;
      }
      current += part;
    }
  }

  return bestFit;
}

/**
 * Splits HTML text into chunks of maximum character length, ensuring that HTML tags
 * are not cut in half, and that any tags open at the end of a chunk are closed
 * and then reopened at the start of the next chunk.
 */
export function splitHTMLText(text: string, maxLength = 4000): string[] {
  text = sanitizeHTML(text);
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const parts = text.split(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g);
  const chunks: string[] = [];
  let currentChunk = "";
  const openTags: string[] = []; // Stack of currently open tags

  // Helper to compute size of closing tags for openTags stack
  const getCloseTagsString = () => openTags.map(tag => `</${tag}>`).reverse().join('');
  // Helper to compute size of opening tags for openTags stack
  const getOpenTagsString = () => openTags.map(tag => `<${tag}>`).join('');

  const safePush = (chunk: string) => {
    // Only push if it has text content other than HTML tags
    if (chunk.replace(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g, '').trim().length === 0) {
      return;
    }
    if (chunk.length <= maxLength) {
      chunks.push(chunk);
    } else {
      const truncated = truncateHTMLToLength(chunk, maxLength);
      if (truncated.replace(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g, '').trim().length > 0) {
        chunks.push(truncated);
      }
    }
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    // Check if it is a tag
    const isTag = i % 2 === 1;
    let tagName = "";
    let isCloseTag = false;

    if (isTag) {
      const match = part.match(/^<\/?([a-zA-Z0-9]+)/);
      if (match) {
        tagName = match[1].toLowerCase();
        isCloseTag = part.startsWith('</');
      }
    }

    if (!isTag) {
      // Split the text token into words and spaces to allow fine-grained splitting
      const words = part.split(/(\s+)/);
      for (const word of words) {
        if (!word) continue;

        const closeTagsStr = getCloseTagsString();
        const potentialLength = currentChunk.length + word.length + closeTagsStr.length;

        // Check if the current chunk has text content before deciding to push it.
        const hasTextContent = currentChunk.replace(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g, '').trim().length > 0;

        if (potentialLength > maxLength && hasTextContent) {
          safePush(currentChunk + closeTagsStr);
          currentChunk = getOpenTagsString();
        }

        // If the single word itself is still longer than maxLength (even when starting a fresh chunk),
        // we have to split it by characters.
        if (currentChunk.length + word.length + getCloseTagsString().length > maxLength) {
          let wordRemaining = word;
          while (wordRemaining.length > 0) {
            const currentCloseTags = getCloseTagsString();
            const currentOpenTags = getOpenTagsString();
            const spaceLeft = maxLength - currentChunk.length - currentCloseTags.length;

            const currentHasText = currentChunk.replace(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g, '').trim().length > 0;

            if (spaceLeft <= 0 || (!currentHasText && spaceLeft < maxLength / 2)) {
              if (currentHasText) {
                safePush(currentChunk + currentCloseTags);
              }
              // Guard against infinite loop: force at least 1 character of progress
              if (!currentHasText && spaceLeft <= 0) {
                const forceLen = Math.min(wordRemaining.length, Math.max(1, maxLength - currentOpenTags.length - currentCloseTags.length));
                currentChunk = currentOpenTags + wordRemaining.substring(0, forceLen);
                wordRemaining = wordRemaining.substring(forceLen);
                if (wordRemaining.length > 0) {
                  safePush(currentChunk + currentCloseTags);
                  currentChunk = currentOpenTags;
                }
                continue;
              }
              currentChunk = currentOpenTags;
              continue;
            }

            const sliceLen = Math.min(wordRemaining.length, spaceLeft);
            currentChunk += wordRemaining.substring(0, sliceLen);
            wordRemaining = wordRemaining.substring(sliceLen);

            if (wordRemaining.length > 0) {
              safePush(currentChunk + getCloseTagsString());
              currentChunk = getOpenTagsString();
            }
          }
        } else {
          currentChunk += word;
        }
      }
      continue;
    }

    // Processing tag tokens
    const closeTagsStr = getCloseTagsString();
    let tagOverhead = 0;
    if (isTag && tagName) {
      if (isCloseTag) {
        if (openTags.includes(tagName)) {
          tagOverhead = -part.length;
        }
      } else {
        if (!openTags.includes(tagName)) {
          tagOverhead = `</${tagName}>`.length;
        }
      }
    }
    const potentialLength = currentChunk.length + part.length + closeTagsStr.length + tagOverhead;
    const hasTextContent = currentChunk.replace(/(<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>)/g, '').trim().length > 0;

    if (potentialLength > maxLength && hasTextContent) {
      safePush(currentChunk + closeTagsStr);
      currentChunk = getOpenTagsString();
    }

    currentChunk += part;

    if (isTag && tagName) {
      if (isCloseTag) {
        const lastIdx = openTags.lastIndexOf(tagName);
        if (lastIdx !== -1) {
          openTags.splice(lastIdx, 1);
        }
      } else {
        if (!openTags.includes(tagName)) {
          openTags.push(tagName);
        }
      }
    }
  }

  if (currentChunk.trim().length > 0 || openTags.length > 0) {
    const finalCloseTags = getCloseTagsString();
    const finalStr = currentChunk + finalCloseTags;
    safePush(finalStr);
  }

  return chunks;
}

/**
 * Standard log function that filters out DEBUG messages unless debug mode is enabled.
 */
export function log(level: string, message: string, ...args: unknown[]): void {
  if (level.toUpperCase() === 'DEBUG') {
    const isDebugMode = process.env.DEBUG === 'true' || process.env.DEBUG === '1' || process.env.LOG_LEVEL?.toLowerCase() === 'debug';
    if (!isDebugMode) {
      return;
    }
  }
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${message}`, ...args);
}
