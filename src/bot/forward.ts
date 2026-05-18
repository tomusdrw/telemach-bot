// src/bot/forward.ts
import type { Api, Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { UserRepo } from '../db/users';
import { FatalError, TransientError, withRetry } from '../lib/errors';
import { logger } from '../lib/logger';
import type { ResendSender } from '../services/resend';
import type { SubjectClient } from '../services/subject';
import type { TranscriptionClient } from '../services/transcription';
import { composeEmail, type EmailAttachment } from './email-composer';
import { MediaGroupBuffer } from './media-group';
import { markDone, markFailed, markReceived, markWorking } from './reactions';
import { fallbackSubject, sanitizeSubject } from './subject-prompt';

export interface ForwardDeps {
  repo: UserRepo;
  fromEmail: string;
  botToken: string;
  api: Api;
  subject: SubjectClient;
  transcription: TranscriptionClient;
  resend: ResendSender;
  download: (input: { api: Api; botToken: string; fileId: string }) => Promise<{
    buffer: Buffer;
    filename: string;
    mimeType: string | null;
  }>;
  mediaGroupFlushMs: number;
  retryDelays: number[];
}

interface MsgKind {
  fileId: string | null;
  filenameHint: string | null;
  isVoice: boolean;
  text: string;
}

function classify(msg: Message): MsgKind {
  if (msg.voice) {
    return { fileId: msg.voice.file_id, filenameHint: 'voice.ogg', isVoice: true, text: '' };
  }
  if (msg.photo && msg.photo.length > 0) {
    const largest = [...msg.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]!;
    return { fileId: largest.file_id, filenameHint: 'photo.jpg', isVoice: false, text: msg.caption ?? '' };
  }
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      filenameHint: msg.document.file_name ?? 'document',
      isVoice: false,
      text: msg.caption ?? '',
    };
  }
  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      filenameHint: msg.video.file_name ?? 'video.mp4',
      isVoice: false,
      text: msg.caption ?? '',
    };
  }
  if (msg.audio) {
    return {
      fileId: msg.audio.file_id,
      filenameHint: msg.audio.file_name ?? 'audio.mp3',
      isVoice: false,
      text: msg.caption ?? '',
    };
  }
  if (msg.animation) {
    return {
      fileId: msg.animation.file_id,
      filenameHint: msg.animation.file_name ?? 'animation.mp4',
      isVoice: false,
      text: msg.caption ?? '',
    };
  }
  if (msg.sticker) {
    const ext = msg.sticker.is_video ? 'webm' : msg.sticker.is_animated ? 'tgs' : 'webp';
    return { fileId: msg.sticker.file_id, filenameHint: `sticker.${ext}`, isVoice: false, text: '' };
  }
  return { fileId: null, filenameHint: null, isVoice: false, text: msg.text ?? msg.caption ?? '' };
}

function attachmentCountLabel(n: number): string {
  return n === 1 ? '(1 attachment)' : `(${n} attachments)`;
}

/**
 * What we persist per message in `media_group_pending.payload_json` and what
 * flows through the work pipeline. Replay reconstructs these from the DB.
 */
interface PersistedPayload {
  kind: MsgKind;
  user: { email: string; username: string | null; firstName: string | null; telegramId: number };
}

interface WorkItem {
  ctx: Context | null; // null only on startup replay
  chatId: number;
  messageId: number;
  telegramId: number;
  payload: PersistedPayload;
}

// Reaction helpers that pick ctx-based or api-based depending on path.
async function reactWorking(item: WorkItem, api: Api): Promise<void> {
  if (item.ctx) return markWorking(item.ctx);
  await safeApiReact(api, item.chatId, item.messageId, '✍');
}
async function reactDone(item: WorkItem, api: Api): Promise<void> {
  if (item.ctx) return markDone(item.ctx);
  await safeApiReact(api, item.chatId, item.messageId, '👍');
}
async function reactFailed(item: WorkItem, api: Api): Promise<void> {
  if (item.ctx) return markFailed(item.ctx);
  await safeApiReact(api, item.chatId, item.messageId, '💩');
}

async function safeApiReact(api: Api, chatId: number, messageId: number, emoji: string): Promise<void> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: grammy's reaction emoji union is narrower than our 4-emoji set
    await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: emoji as any }]);
  } catch (err) {
    logger.warn({ err, emoji, chatId, messageId }, 'failed to set reaction via api (ignored)');
  }
}

export interface ForwardHandler {
  (ctx: Context): Promise<void>;
  replayPending(): Promise<void>;
}

export function makeForwardHandler(deps: ForwardDeps): ForwardHandler {
  async function buildAndSend(items: WorkItem[]): Promise<void> {
    if (items.length === 0) return;
    const first = items[0]!;

    const attachments: EmailAttachment[] = [];
    const captions: string[] = [];
    let transcribedBody: string | null = null;

    for (const it of items) {
      const kind = it.payload.kind;
      if (!kind.fileId) {
        if (kind.text) captions.push(kind.text);
        continue;
      }
      const dl = await withRetry(
        () => deps.download({ api: deps.api, botToken: deps.botToken, fileId: kind.fileId! }),
        { delaysMs: deps.retryDelays },
      );
      if (kind.isVoice) {
        transcribedBody = await withRetry(
          () => deps.transcription.transcribe({ audio: dl.buffer, filename: dl.filename }),
          { delaysMs: deps.retryDelays },
        );
        deps.repo.logAudit({
          telegramId: it.telegramId,
          chatMessageId: it.messageId,
          event: 'transcribed',
          details: null,
        });
      } else {
        attachments.push({ filename: kind.filenameHint ?? dl.filename, content: dl.buffer });
      }
      if (kind.text) captions.push(kind.text);
    }

    const body = transcribedBody ?? captions.join('\n\n');
    const subjectInput =
      body || (attachments.length > 0 ? attachmentCountLabel(attachments.length) : '(no text)');
    const rawSubject = await deps.subject.generateSubject(subjectInput);
    const subject = rawSubject
      ? sanitizeSubject(rawSubject) || fallbackSubject(first.payload.user.username)
      : fallbackSubject(first.payload.user.username);

    const payload = composeEmail({
      fromEmail: deps.fromEmail,
      toEmail: first.payload.user.email,
      username: first.payload.user.username,
      firstName: first.payload.user.firstName,
      telegramId: first.payload.user.telegramId,
      subject,
      body,
      attachments,
      sentAt: new Date(),
    });
    await withRetry(() => deps.resend.send(payload), { delaysMs: deps.retryDelays });

    deps.repo.logAudit({
      telegramId: first.telegramId,
      chatMessageId: first.messageId,
      event: 'emailed',
      details:
        items.length > 1 ? JSON.stringify({ group: items.length, attachments: attachments.length }) : null,
    });
  }

  async function processGroup(groupId: string, items: WorkItem[]): Promise<void> {
    try {
      for (const it of items) await reactWorking(it, deps.api);
      await buildAndSend(items);
      for (const it of items) await reactDone(it, deps.api);
    } catch (err) {
      logger.error({ err, groupId }, 'media-group flush failed');
      for (const it of items) await reactFailed(it, deps.api);
    } finally {
      deps.repo.deleteMediaGroupRows(groupId);
    }
  }

  const buffer = new MediaGroupBuffer<WorkItem>(deps.mediaGroupFlushMs, async (groupId, items) => {
    await processGroup(groupId, items);
  });

  const handler: ForwardHandler = async (ctx: Context): Promise<void> => {
    const msg = ctx.message;
    if (!msg || !ctx.from) return;
    const user = deps.repo.findById(ctx.from.id);
    if (!user || user.status !== 'APPROVED' || !user.email) return;

    deps.repo.logAudit({
      telegramId: ctx.from.id,
      chatMessageId: msg.message_id,
      event: 'received',
      details: null,
    });

    await markReceived(ctx);

    const kind = classify(msg);
    const payload: PersistedPayload = {
      kind,
      user: {
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        telegramId: user.telegramId,
      },
    };
    const item: WorkItem = {
      ctx,
      chatId: ctx.chat?.id ?? ctx.from.id,
      messageId: msg.message_id,
      telegramId: ctx.from.id,
      payload,
    };

    if (msg.media_group_id) {
      deps.repo.addMediaGroupItem({
        groupId: msg.media_group_id,
        telegramId: item.telegramId,
        chatId: item.chatId,
        messageId: item.messageId,
        payloadJson: JSON.stringify(payload),
      });
      buffer.add(msg.media_group_id, item);
      return;
    }

    try {
      await markWorking(ctx);
      await buildAndSend([item]);
      await markDone(ctx);
    } catch (err) {
      const cls =
        err instanceof TransientError
          ? 'TransientError'
          : err instanceof FatalError
            ? 'FatalError'
            : 'Unknown';
      logger.error({ err, cls, msgId: msg.message_id }, 'forward failed');
      await markFailed(ctx);
      deps.repo.logAudit({
        telegramId: ctx.from.id,
        chatMessageId: msg.message_id,
        event: 'error',
        details: JSON.stringify({ class: cls, message: (err as Error)?.message }),
      });
    }
  };

  handler.replayPending = async (): Promise<void> => {
    const groups = deps.repo.listAllPendingMediaGroups();
    if (groups.length === 0) return;
    logger.info({ groups: groups.length }, 'replaying pending media groups from previous run');
    for (const { groupId, items: rows } of groups) {
      const items: WorkItem[] = [];
      for (const r of rows) {
        try {
          const payload = JSON.parse(r.payloadJson) as PersistedPayload;
          items.push({
            ctx: null,
            chatId: r.chatId,
            messageId: r.messageId,
            telegramId: r.telegramId,
            payload,
          });
        } catch (err) {
          logger.warn(
            { err, groupId, messageId: r.messageId },
            'pending media-group payload unparseable; dropping',
          );
        }
      }
      if (items.length === 0) {
        deps.repo.deleteMediaGroupRows(groupId);
        continue;
      }
      await processGroup(groupId, items);
    }
  };

  return handler;
}
