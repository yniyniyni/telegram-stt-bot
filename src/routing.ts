export interface RoutingOptions {
  isPrivateChat: boolean;
  botUsername: string;
  botId: number;
}

export type MessageRoutingDecision =
  | {
      action: 'ignore' | 'command';
      isVoice: boolean;
      isVideoNote: boolean;
      isDirectAppeal: boolean;
      shouldTranscribeReplied: boolean;
    }
  | {
      action: 'transcribe';
      isVoice: boolean;
      isVideoNote: boolean;
      isDirectAppeal: boolean;
      shouldTranscribeReplied: boolean;
      targetMsg: any;
      targetIsVoice: boolean;
      fileId: string;
      fileUniqueId: string;
      duration: number;
      fileSize?: number;
      userId: number;
      username?: string;
      fullName: string;
    };

export function determineMessageRouting(msg: any, options: RoutingOptions): MessageRoutingDecision {
  const isVoice = 'voice' in msg;
  const isVideoNote = 'video_note' in msg;

  let isDirectAppeal = false;
  if (options.isPrivateChat) {
    isDirectAppeal = true;
  } else if ('text' in msg) {
    const text = msg.text || '';
    const hasMention = text.includes(`@${options.botUsername}`);
    const isReplyToBot = msg.reply_to_message?.from?.id === options.botId;
    if (hasMention || isReplyToBot) {
      isDirectAppeal = true;
    }
  }

  const repliedMsg = msg.reply_to_message;
  const isRepliedVoice = !!(repliedMsg && 'voice' in repliedMsg);
  const isRepliedVideoNote = !!(repliedMsg && 'video_note' in repliedMsg);
  const shouldTranscribeReplied = isDirectAppeal && (isRepliedVoice || isRepliedVideoNote);

  if (!isVoice && !isVideoNote && !isDirectAppeal) {
    return { action: 'ignore', isVoice, isVideoNote, isDirectAppeal, shouldTranscribeReplied };
  }

  if (isDirectAppeal && !isVoice && !isVideoNote && !shouldTranscribeReplied) {
    return { action: 'command', isVoice, isVideoNote, isDirectAppeal, shouldTranscribeReplied };
  }

  const targetMsg = shouldTranscribeReplied ? repliedMsg : msg;
  const targetIsVoice = shouldTranscribeReplied ? isRepliedVoice : isVoice;
  const media = targetIsVoice ? targetMsg.voice : targetMsg.video_note;

  return {
    action: 'transcribe',
    isVoice,
    isVideoNote,
    isDirectAppeal,
    shouldTranscribeReplied,
    targetMsg,
    targetIsVoice,
    fileId: media.file_id,
    fileUniqueId: media.file_unique_id,
    duration: media.duration,
    fileSize: media.file_size,
    userId: targetMsg.from?.id || 0,
    username: targetMsg.from?.username,
    fullName: [targetMsg.from?.first_name, targetMsg.from?.last_name].filter(Boolean).join(' ')
  };
}
