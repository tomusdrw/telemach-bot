// tests/bot/email-composer.test.ts
import { describe, it, expect } from 'vitest';
import { composeEmail, type ComposeInput } from '../../src/bot/email-composer';

const base: ComposeInput = {
  fromEmail: 'bot@example.com',
  toEmail: 'me@example.com',
  username: 'alice',
  subject: 'Hello',
  body: 'plain text body',
  attachments: [],
  sentAt: new Date('2026-01-02T03:04:05Z'),
};

describe('composeEmail', () => {
  it('builds payload with [TG] prefix and attribution header', () => {
    const p = composeEmail(base);
    expect(p.from).toBe('bot@example.com');
    expect(p.to).toBe('me@example.com');
    expect(p.subject).toBe('[TG] Hello');
    expect(p.text).toContain('Sent by @alice (Telegram) at 2026-01-02T03:04:05.000Z');
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

  it('uses "unknown sender" when username is null', () => {
    const p = composeEmail({ ...base, username: null });
    expect(p.text).toContain('Sent by unknown sender');
  });

  it('passes attachments through as-is', () => {
    const att = [{ filename: 'a.jpg', content: Buffer.from([1, 2, 3]) }];
    const p = composeEmail({ ...base, attachments: att });
    expect(p.attachments).toEqual(att);
  });
});
