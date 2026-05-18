// src/bot/email-composer.ts
export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export interface ComposeInput {
  fromEmail: string;
  toEmail: string;
  username: string | null;
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

export function composeEmail(input: ComposeInput): EmailPayload {
  const senderLabel = input.username ? `@${input.username}` : 'unknown sender';
  const attribution = `Sent by ${senderLabel} (Telegram) at ${input.sentAt.toISOString()}`;
  const body = input.body.trim() === '' ? '(no text)' : input.body;

  const text = `${attribution}\n\n${body}\n`;
  const html = `<p><em>${escapeHtml(attribution)}</em></p>\n<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(body)}</pre>`;

  return {
    from: input.fromEmail,
    to: input.toEmail,
    subject: `[TG] ${input.subject}`,
    text,
    html,
    attachments: input.attachments,
  };
}
