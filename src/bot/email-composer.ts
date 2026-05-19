// src/bot/email-composer.ts
export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface ComposeInput {
  fromEmail: string;
  toEmail: string;
  username: string | null;
  firstName: string | null;
  telegramId: number;
  subject: string;
  body: string;
  attachments: EmailAttachment[];
  sentAt: Date;
}

export interface EmailPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function senderLabel(input: ComposeInput): string {
  if (input.username) return `@${input.username}`;
  if (input.firstName) return input.firstName;
  return `user ${input.telegramId}`;
}

function formatUtc(d: Date): string {
  // e.g. "2026-05-18 18:05:41 UTC"
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function composeEmail(input: ComposeInput): EmailPayload {
  const attribution = `Sent by ${senderLabel(input)} (Telegram) at ${formatUtc(input.sentAt)}`;
  const body = input.body.trim() === '' ? '(no text)' : input.body;

  const text = `${attribution}\n\n${body}\n`;
  const html = `<p><em>${escapeHtml(attribution)}</em></p>\n<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(body)}</pre>`;

  return {
    from: input.fromEmail,
    to: input.toEmail,
    subject: input.subject,
    text,
    html,
    attachments: input.attachments,
  };
}
