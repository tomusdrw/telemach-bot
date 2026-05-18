// tests/bot/email-composer.test.ts
import { describe, expect, it } from 'vitest';
import { type ComposeInput, composeEmail } from '../../src/bot/email-composer';

const base: ComposeInput = {
  fromEmail: 'bot@example.com',
  toEmail: 'me@example.com',
  username: 'alice',
  firstName: 'Alice',
  telegramId: 7,
  subject: 'Hello',
  body: 'plain text body',
  attachments: [],
  sentAt: new Date('2026-01-02T03:04:05Z'),
};

describe('composeEmail', () => {
  it('builds payload with attribution header and no subject prefix', () => {
    const p = composeEmail(base);
    expect(p.from).toBe('bot@example.com');
    expect(p.to).toBe('me@example.com');
    expect(p.subject).toBe('Hello');
    expect(p.text).toContain('Sent by @alice (Telegram) at 2026-01-02 03:04:05 UTC');
    expect(p.text).toContain('plain text body');
    expect(p.html).toContain('Sent by @alice (Telegram)');
    expect(p.html).toContain('plain text body');
    expect(p.attachments).toEqual([]);
  });

  it('escapes HTML in body', () => {
    const p = composeEmail({ ...base, body: '<script>alert(1)</script> & "quotes"' });
    expect(p.html).not.toContain('<script>');
    expect(p.html).toContain('&lt;script&gt;');
    expect(p.html).toContain('&amp;');
    expect(p.html).toContain('&quot;');
  });

  it('falls back to "(no text)" when body is empty', () => {
    const p = composeEmail({ ...base, body: '' });
    expect(p.text).toContain('(no text)');
    expect(p.html).toContain('(no text)');
  });

  it('falls back to firstName when username is null', () => {
    const p = composeEmail({ ...base, username: null });
    expect(p.text).toContain('Sent by Alice (Telegram)');
    expect(p.text).not.toContain('unknown');
  });

  it('falls back to "user <telegramId>" when both username and firstName are null', () => {
    const p = composeEmail({ ...base, username: null, firstName: null });
    expect(p.text).toContain('Sent by user 7 (Telegram)');
    expect(p.text).not.toContain('unknown');
  });

  it('formats sentAt as YYYY-MM-DD HH:mm:ss UTC (no milliseconds, no T)', () => {
    const p = composeEmail({ ...base, sentAt: new Date('2026-05-18T18:05:41.377Z') });
    expect(p.text).toContain('2026-05-18 18:05:41 UTC');
    expect(p.text).not.toContain('.377');
    expect(p.text).not.toContain('T18:05');
  });

  it('passes attachments through as-is', () => {
    const att = [{ filename: 'a.jpg', content: Buffer.from([1, 2, 3]) }];
    const p = composeEmail({ ...base, attachments: att });
    expect(p.attachments).toEqual(att);
  });
});
