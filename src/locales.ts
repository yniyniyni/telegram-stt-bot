import { escapeHTML } from './utils.js';

export interface Locales {
  chatNotAuthorized: string;
  rateLimited: (retryAfter: number) => string;
  welcomeMessage: (botUsername: string) => string;
  helpMessage: (botUsername: string) => string;
  transcribing: string;
  emptyTranscription: string;
  transcriptionHeaderVoice: (username?: string, fullName?: string) => string;
  transcriptionHeaderVideoNote: (username?: string, fullName?: string) => string;
  transcriptionError: (err: string) => string;
  durationLimitExceeded: (maxSec: number) => string;
  unknownCommand: string;
}

const ruLocale: Locales = {
  chatNotAuthorized: "⚠️ Этот чат не авторизован для использования бота.",
  rateLimited: (retryAfter) => `⚠️ Превышен лимит запросов. Пожалуйста, подождите ${retryAfter} сек. перед следующей попыткой.`,
  welcomeMessage: (botUsername) =>
    `👋 <b>Привет! Я бот для автоматической расшифровки голосовых сообщений и видеокружков.</b>\n\n` +
    `Я могу работать как в личных сообщениях, так и в группах:\n` +
    `1. Добавьте меня в группу.\n` +
    `2. Дайте доступ к сообщениям (сделайте администратором или отключите Group Privacy у @BotFather).\n` +
    `3. Отправьте голосовое сообщение или видеокружок, и я автоматически пришлю расшифровку!\n\n` +
    `<i>Обратите внимание: чат должен быть добавлен в белый список ALLOWED_CHATS в конфигурации бота.</i>`,
  helpMessage: (botUsername) =>
    `ℹ️ <b>Как пользоваться ботом:</b>\n\n` +
    `• Просто отправьте голосовое сообщение (voice) или видеокружок (video note) в этот чат — я автоматически расшифрую его и пришлю текст.\n` +
    `• Все обычные текстовые сообщения в чате я игнорирую, если они не являются обращением ко мне (прямое сообщение в ЛС или упоминание бота через @${botUsername}).`,
  transcribing: "⏳ <i>Расшифровываю аудио...</i>",
  emptyTranscription: "🤷‍♂️ <i>Не удалось распознать речь (пустой результат).</i>",
  transcriptionHeaderVoice: (username, fullName) => {
    const name = fullName ? escapeHTML(fullName) : "Пользователь";
    const userLink = username ? ` (@${escapeHTML(username)})` : "";
    return `🗣️ <b>Голосовое сообщение от ${name}${userLink}:</b>\n\n`;
  },
  transcriptionHeaderVideoNote: (username, fullName) => {
    const name = fullName ? escapeHTML(fullName) : "Пользователь";
    const userLink = username ? ` (@${escapeHTML(username)})` : "";
    return `📹 <b>Видеосообщение от ${name}${userLink}:</b>\n\n`;
  },
  transcriptionError: (err) => `❌ Ошибка расшифровки: <code>${escapeHTML(err)}</code>`,
  durationLimitExceeded: (maxSec) => `⚠️ Длительность сообщения превышает лимит (${maxSec} сек.). Расшифровка отклонена.`,
  unknownCommand: "🤖 Я умею автоматически расшифровывать голосовые сообщения и видеокружки. Просто отправьте их сюда!"
};

const enLocale: Locales = {
  chatNotAuthorized: "⚠️ This chat is not authorized to use this bot.",
  rateLimited: (retryAfter) => `⚠️ Rate limit exceeded. Please wait ${retryAfter}s before trying again.`,
  welcomeMessage: (botUsername) =>
    `👋 <b>Hello! I am a bot that automatically transcribes voice messages and video notes.</b>\n\n` +
    `I can work in private chats and groups:\n` +
    `1. Add me to a group.\n` +
    `2. Give me access to messages (make me an admin or disable Group Privacy via @BotFather).\n` +
    `3. Send a voice message or a video note, and I will automatically reply with the transcription!\n\n` +
    `<i>Note: the chat must be whitelisted in ALLOWED_CHATS in the bot configuration.</i>`,
  helpMessage: (botUsername) =>
    `ℹ️ <b>How to use the bot:</b>\n\n` +
    `• Simply send a voice message or a video note to this chat — I will automatically transcribe it.\n` +
    `• I ignore ordinary text messages in the chat unless they are addressed to me (a direct private message or a mention @${botUsername}).`,
  transcribing: "⏳ <i>Transcribing audio...</i>",
  emptyTranscription: "🤷‍♂️ <i>Could not recognize speech (empty transcript).</i>",
  transcriptionHeaderVoice: (username, fullName) => {
    const name = fullName ? escapeHTML(fullName) : "User";
    const userLink = username ? ` (@${escapeHTML(username)})` : "";
    return `🗣️ <b>Voice message from ${name}${userLink}:</b>\n\n`;
  },
  transcriptionHeaderVideoNote: (username, fullName) => {
    const name = fullName ? escapeHTML(fullName) : "User";
    const userLink = username ? ` (@${escapeHTML(username)})` : "";
    return `📹 <b>Video message from ${name}${userLink}:</b>\n\n`;
  },
  transcriptionError: (err) => `❌ Transcription error: <code>${escapeHTML(err)}</code>`,
  durationLimitExceeded: (maxSec) => `⚠️ Message duration exceeds the limit of ${maxSec}s. Transcription rejected.`,
  unknownCommand: "🤖 I automatically transcribe voice messages and video notes. Just send them here!"
};

export function getLocale(): Locales {
  const lang = (process.env.BOT_LANGUAGE || 'ru').toLowerCase();
  return lang === 'ru' ? ruLocale : enLocale;
}
