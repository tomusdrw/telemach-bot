// src/bot/forward.ts
import type { Api, Context } from 'grammy';
import type { Message } from 'grammy/types';
import { UserRepo } from '../db/users';
import { withRetry, FatalError, TransientError } from '../lib/errors';
import { logger } from '../lib/logger';
import { composeEmail, type EmailAttachment } from './email-composer';
import { sanitizeSubject, fallbackSubject } from './subject-prompt';
import { MediaGroupBuffer } from './media-group';
import { markReceived, markWorking, markDone, markFailed } from './reactions';
import type { ResendSender } from '../services/resend';
import type { WhisperClient } from '../services/whisper';
import type { SubjectClient } from '../services/subject';

export interface ForwardDeps {
  repo: UserRepo;
  fromEmail: string;
  botToken: string;
  api: Api;
  subject: SubjectClient;
  whisper: WhisperClient;
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
    return { fileId: msg.video.file_id, filenameHint: msg.video.file_name ?? 'video.mp4', isVoice: false, text: msg.caption ?? '' };
  }
  if (msg.audio) {
    return { fileId: msg.audio.file_id, filenameHint: msg.audio.file_name ?? 'audio.mp3', isVoice: false, text: msg.caption ?? '' };
  }
  if (msg.animation) {
    return { fileId: msg.animation.file_id, filenameHint: msg.animation.file_name ?? 'animation.mp4', isVoice: false, text: msg.caption ?? '' };
  }
  if (msg.sticker) {
    return { fileId: msg.sticker.file_id, filenameHint: msg.sticker.is_animated ? 'sticker.tgs' : 'sticker.webp', isVoice: false, text: '' };
  }
  return { fileId: null, filenameHint: null, isVoice: false, text: msg.text ?? msg.caption ?? '' };
}

export function makeForwardHandler(deps: ForwardDeps) {
  type Pending = { ctx: Context; user: { email: string; username: string | null } };
  const buffer = new MediaGroupBuffer<Pending>(deps.mediaGroupFlushMs, async (groupId, items) => {
    try {
      await processGroup(items);
    } catch (err) {
      logger.error({ err, groupId }, 'media-group flush failed');
      for (const it of items) await markFailed(it.ctx as any);
    }
  });

  async function processGroup(items: Pending[]): Promise<void> {
    if (items.length === 0) return;
    const first = items[0]!;
    for (const it of items) await markWorking(it.ctx as any);

    const attachments: EmailAttachment[] = [];
    const captions: string[] = [];
    for (const it of items) {
      const msg = it.ctx.message;
      if (!msg) continue;
      const kind = classify(msg);
      if (kind.fileId) {
        const dl = await withRetry(
          () => deps.download({ api: deps.api, botToken: deps.botToken, fileId: kind.fileId! }),
          { delaysMs: deps.retryDelays }
        );
        attachments.push({ filename: kind.filenameHint ?? dl.filename, content: dl.buffer });
      }
      if (kind.text) captions.push(kind.text);
    }
    const body = captions.join('\n\n');
    const subjectInput = body || `(${attachments.length} attachments)`;
    const rawSubject = await deps.subject.generateSubject(subjectInput);
    const subject = rawSubject ? (sanitizeSubject(rawSubject) || fallbackSubject(first.user.username))
                               : fallbackSubject(first.user.username);

    const payload = composeEmail({
      fromEmail: deps.fromEmail,
      toEmail: first.user.email,
      username: first.user.username,
      subject,
      body,
      attachments,
      sentAt: new Date(),
    });
    await withRetry(() => deps.resend.send(payload), { delaysMs: deps.retryDelays });

    for (const it of items) await markDone(it.ctx as any);
    deps.repo.logAudit({
      telegramId: first.ctx.from?.id ?? 0,
      chatMessageId: first.ctx.message?.message_id ?? null,
      event: 'emailed',
      details: JSON.stringify({ group: items.length, attachments: attachments.length }),
    });
  }

  return async function handle(ctx: Context): Promise<void> {
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

    await markReceived(ctx as any);

    if (msg.media_group_id) {
      buffer.add(msg.media_group_id, { ctx, user: { email: user.email, username: user.username } });
      return;
    }

    try {
      await markWorking(ctx as any);
      const kind = classify(msg);

      const attachments: EmailAttachment[] = [];
      let body = kind.text;

      if (kind.fileId && !kind.isVoice) {
        const dl = await withRetry(
          () => deps.download({ api: deps.api, botToken: deps.botToken, fileId: kind.fileId! }),
          { delaysMs: deps.retryDelays }
        );
        attachments.push({ filename: kind.filenameHint ?? dl.filename, content: dl.buffer });
      } else if (kind.fileId && kind.isVoice) {
        const dl = await withRetry(
          () => deps.download({ api: deps.api, botToken: deps.botToken, fileId: kind.fileId! }),
          { delaysMs: deps.retryDelays }
        );
        body = await withRetry(
          () => deps.whisper.transcribe({ audio: dl.buffer, filename: dl.filename }),
          { delaysMs: deps.retryDelays }
        );
        deps.repo.logAudit({
          telegramId: ctx.from.id,
          chatMessageId: msg.message_id,
          event: 'transcribed',
          details: null,
        });
      }

      const subjectInput = body || (attachments.length > 0 ? `(${attachments.length} attachment)` : '(no text)');
      const rawSubject = await deps.subject.generateSubject(subjectInput);
      const subject = rawSubject ? (sanitizeSubject(rawSubject) || fallbackSubject(user.username))
                                 : fallbackSubject(user.username);

      const payload = composeEmail({
        fromEmail: deps.fromEmail,
        toEmail: user.email,
        username: user.username,
        subject,
        body,
        attachments,
        sentAt: new Date(),
      });
      await withRetry(() => deps.resend.send(payload), { delaysMs: deps.retryDelays });
      await markDone(ctx as any);
      deps.repo.logAudit({
        telegramId: ctx.from.id,
        chatMessageId: msg.message_id,
        event: 'emailed',
        details: null,
      });
    } catch (err) {
      const cls = err instanceof TransientError ? 'TransientError'
                : err instanceof FatalError ? 'FatalError' : 'Unknown';
      logger.error({ err, cls, msgId: msg.message_id }, 'forward failed');
      await markFailed(ctx as any);
      deps.repo.logAudit({
        telegramId: ctx.from.id,
        chatMessageId: msg.message_id,
        event: 'error',
        details: JSON.stringify({ class: cls, message: (err as Error)?.message }),
      });
    }
  };
}
