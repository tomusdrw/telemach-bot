import { describe, expect, it } from 'vitest';
import {
  buildSubjectPrompt,
  fallbackSubject,
  isShortSubject,
  sanitizeSubject,
  verbatimSubject,
} from '../../src/bot/subject-prompt.js';

describe('subject prompt', () => {
  it('builds a prompt that contains the body verbatim', () => {
    const p = buildSubjectPrompt('hello world');
    expect(p).toContain('hello world');
    expect(p).toMatch(/concise/i);
    expect(p).toMatch(/max 80 chars/i);
  });

  it('instructs the model to match the body language and never translate', () => {
    const p = buildSubjectPrompt('cześć świecie');
    expect(p).toMatch(/same language/i);
    // A single "use the same language" clause was not enough for small models
    // (see #25): the rule must be explicit that the subject is NOT translated.
    expect(p).toMatch(/translate/i);
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

describe('isShortSubject', () => {
  it('is true for a non-empty single line up to 80 chars', () => {
    expect(isShortSubject('kup mleko')).toBe(true);
    expect(isShortSubject('a'.repeat(80))).toBe(true);
  });

  it('trims before measuring', () => {
    expect(isShortSubject('   kup mleko   ')).toBe(true);
    expect(isShortSubject(`  ${'a'.repeat(80)}  `)).toBe(true);
  });

  it('is false above 80 chars (after trim)', () => {
    expect(isShortSubject('a'.repeat(81))).toBe(false);
  });

  it('is false when it contains a newline', () => {
    expect(isShortSubject('line one\nline two')).toBe(false);
    expect(isShortSubject('line one\r\nline two')).toBe(false);
  });

  it('is false for empty / whitespace-only', () => {
    expect(isShortSubject('')).toBe(false);
    expect(isShortSubject('   ')).toBe(false);
  });
});

describe('verbatimSubject', () => {
  it('trims and returns the literal text', () => {
    expect(verbatimSubject('  kup mleko  ')).toBe('kup mleko');
  });

  it('preserves trailing punctuation and quotes (unlike sanitizeSubject)', () => {
    expect(verbatimSubject('Gdzie jesteś?')).toBe('Gdzie jesteś?');
    expect(verbatimSubject('"cytat"')).toBe('"cytat"');
  });

  it('hard-caps at 80 chars', () => {
    expect(verbatimSubject('a'.repeat(120)).length).toBe(80);
  });
});
