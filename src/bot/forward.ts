// src/bot/forward.ts
import type { Api, Context } from 'grammy';
import type { Message } from 'grammy/types';
import type { UserRepo } from '../db/users';
import { FatalError, TransientError, withRetry } from '../lib/errors';
import { logger } from '../lib/logger';
import type { EventExtractionClient } from '../services/event-extraction';
import type { ResendSender } from '../services/resend';
import type { SubjectClient } from '../services/subject';
import type { TranscriptionClient } from '../services/transcription';
import { composeEmail, type EmailAttachment } from './email-composer';
import type { EventData } from './event-prompt';
import { buildIcs } from './ics-builder';
import { MediaGroupBuffer } from './media-group';
import { markDone, markEventAttached, markFailed, markReceived, markWorking } from './reactions';
import { fallbackSubject, sanitizeSubject } from './subject-prompt';

export interface ForwardDeps {
  repo: UserRepo;
  fromEmail: string;
  botToken: string;
  api: Api;
  subject: SubjectClient;
  transcription: TranscriptionClient;
  events: EventExtractionClient;
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
  timezone: string;
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

async function tryOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err }, 'tryOrNull caught (degraded to null)');
    return null;
  }
}

function formatNowInTz(d: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatEventNote(event: EventData, timezone: string): string {
  // To display wall-clock values verbatim regardless of the formatter's host TZ,
  // we parse the local-naive ISO as UTC (`...Z`) and format with `timeZone: 'UTC'`.
  // This decouples display from host environment and from the user's actual timezone
  // (the actual TZ string is appended in parentheses for clarity in the timed case).
  if (event.allDay) {
    const fmtFullUtc = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const fmtDayUtc = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'long',
    });
    const startDate = new Date(`${event.start}T00:00:00Z`);
    const endDate = new Date(`${event.end}T00:00:00Z`);
    if (event.start === event.end) {
      return `📅 Event attached: ${event.summary}, ${fmtFullUtc.format(startDate)}`;
    }
    return `📅 Event attached: ${event.summary}, ${fmtDayUtc.format(startDate)}–${fmtDayUtc.format(endDate)} ${startDate.getUTCFullYear()}`;
  }
  const fmtFullUtc = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const fmtTimeUtc = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const startDate = new Date(`${event.start}:00Z`);
  const endDate = new Date(`${event.end}:00Z`);
  return `📅 Event attached: ${event.summary}, ${fmtFullUtc.format(startDate)}, ${fmtTimeUtc.format(startDate)}–${fmtTimeUtc.format(endDate)} (${timezone})`;
}

export interface ForwardHandler {
  (ctx: Context): Promise<void>;
  replayPending(): Promise<void>;
}

export function makeForwardHandler(deps: ForwardDeps): ForwardHandler {
  async function buildAndSend(items: WorkItem[]): Promise<{ eventAttached: boolean }> {
    if (items.length === 0) return { eventAttached: false };
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

    const userTz = first.payload.timezone;
    const nowInTz = formatNowInTz(new Date(), userTz);

    const [rawSubject, event] = await Promise.all([
      tryOrNull(() => deps.subject.generateSubject(subjectInput)),
      body
        ? tryOrNull(() => deps.events.extract({ body, nowInTz, timezone: userTz }))
        : Promise.resolve(null),
    ]);

    const subject = rawSubject
      ? sanitizeSubject(rawSubject) || fallbackSubject(first.payload.user.username)
      : fallbackSubject(first.payload.user.username);

    let bodyForEmail = body;
    let eventAttached = false;
    if (event) {
      deps.repo.logAudit({
        telegramId: first.telegramId,
        chatMessageId: first.messageId,
        event: 'event_extracted',
        details: JSON.stringify({
          summary: event.summary,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
        }),
      });
      try {
        const ics = buildIcs({
          event,
          timezone: userTz,
          organizerEmail: deps.fromEmail,
          attendeeEmail: first.payload.user.email,
          now: new Date(),
          chatId: first.chatId,
          messageId: first.messageId,
        });
        attachments.push({
          filename: ics.filename,
          content: ics.content,
          contentType: ics.contentType,
        });
        const note = formatEventNote(event, userTz);
        bodyForEmail = body ? `${body}\n\n${note}` : note;
        eventAttached = true;
      } catch (err) {
        logger.error({ err }, 'ics-builder failed; email will send without .ics');
      }
    }

    const payload = composeEmail({
      fromEmail: deps.fromEmail,
      toEmail: first.payload.user.email,
      username: first.payload.user.username,
      firstName: first.payload.user.firstName,
      telegramId: first.payload.user.telegramId,
      subject,
      body: bodyForEmail,
      attachments,
      sentAt: new Date(),
    });
    await withRetry(() => deps.resend.send(payload), { delaysMs: deps.retryDelays });

    // One audit row per message so per-message_id lookups never lose a hit.
    // For groups, every row's `details` carries the group size + total
    // attachments so the operator can see "this was part of an N-item group".
    const groupDetails =
      items.length > 1 ? JSON.stringify({ group: items.length, attachments: attachments.length }) : null;
    for (const it of items) {
      deps.repo.logAudit({
        telegramId: it.telegramId,
        chatMessageId: it.messageId,
        event: 'emailed',
        details: groupDetails,
      });
    }

    if (eventAttached && event) {
      deps.repo.logAudit({
        telegramId: first.telegramId,
        chatMessageId: first.messageId,
        event: 'event_attached',
        details: JSON.stringify({
          summary: event.summary,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
        }),
      });
    }

    return { eventAttached };
  }

  async function processGroup(groupId: string, items: WorkItem[]): Promise<void> {
    try {
      for (const it of items) await reactWorking(it, deps.api);
      const result = await buildAndSend(items);
      for (const it of items) await reactDone(it, deps.api);
      if (result.eventAttached) {
        for (const it of items) {
          if (it.ctx) await markEventAttached(it.ctx);
          else await safeApiReact(deps.api, it.chatId, it.messageId, '📅');
        }
      }
    } catch (err) {
      const cls =
        err instanceof TransientError
          ? 'TransientError'
          : err instanceof FatalError
            ? 'FatalError'
            : 'Unknown';
      logger.error({ err, groupId, cls }, 'media-group flush failed');
      const details = JSON.stringify({ class: cls, message: (err as Error)?.message, groupId });
      for (const it of items) {
        await reactFailed(it, deps.api);
        deps.repo.logAudit({
          telegramId: it.telegramId,
          chatMessageId: it.messageId,
          event: 'error',
          details,
        });
      }
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
      timezone: user.timezone,
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
      const result = await buildAndSend([item]);
      await markDone(ctx);
      if (result.eventAttached) await markEventAttached(ctx);
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
          if (typeof payload.timezone !== 'string') payload.timezone = 'Europe/Warsaw';
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
