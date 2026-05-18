import { describe, it, expect } from 'vitest';
import { buildSubjectPrompt, sanitizeSubject, fallbackSubject } from '../../src/bot/subject-prompt';

describe('subject prompt', () => {
  it('builds a prompt that contains the body verbatim', () => {
    const p = buildSubjectPrompt('hello world');
    expect(p).toContain('hello world');
    expect(p).toMatch(/concise/i);
    expect(p).toMatch(/max 80 chars/i);
  });

  it('sanitizes: trims, strips wrapping quotes, removes trailing punctuation', () => {
    expect(sanitizeSubject('  "Hello world."  ')).toBe('Hello world');
    expect(sanitizeSubject(`'It's working!'`)).toBe(`It's working`);
    expect(sanitizeSubject('Subject: foo')).toBe('Subject: foo');
  });

  it('sanitizes: truncates to 80 chars', () => {
    const long = 'a'.repeat(120);
    expect(sanitizeSubject(long).length).toBe(80);
  });

  it('sanitizes empty input → empty string', () => {
    expect(sanitizeSubject('')).toBe('');
    expect(sanitizeSubject('   ')).toBe('');
  });

  it('sanitizes: collapses control whitespace (newlines, tabs) to single spaces', () => {
    expect(sanitizeSubject('Foo\nBar')).toBe('Foo Bar');
    expect(sanitizeSubject('A\r\nB\tC')).toBe('A B C');
    expect(sanitizeSubject('\n\nLeading newlines')).toBe('Leading newlines');
  });

  it('fallbackSubject formats with username', () => {
    expect(fallbackSubject('alice')).toBe('Telegram message from @alice');
    expect(fallbackSubject(null)).toBe('Telegram message');
  });
});
