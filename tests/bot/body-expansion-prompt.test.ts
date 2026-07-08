import { describe, expect, it } from 'vitest';
import {
  buildExpansionPrompt,
  isDuplicateRendition,
  sanitizeExpansion,
} from '../../src/bot/body-expansion-prompt.js';

describe('body-expansion prompt', () => {
  it('contains the message verbatim', () => {
    const p = buildExpansionPrompt('kup mleko');
    expect(p).toContain('kup mleko');
  });

  it('instructs the model to keep the message language and never translate', () => {
    const p = buildExpansionPrompt('cześć');
    expect(p).toMatch(/same language/i);
    expect(p).toMatch(/translate/i);
  });

  it('instructs the model to leave links/URLs exactly as-is', () => {
    const p = buildExpansionPrompt('see https://example.com');
    expect(p).toMatch(/link|url/i);
    // The whole point (see design): the model must not follow/summarise links.
    expect(p).toMatch(/as-is|as is|unchanged|do not/i);
  });

  it('instructs the model not to invent facts and to reply with text only', () => {
    const p = buildExpansionPrompt('x');
    expect(p).toMatch(/invent|make up|do not add/i);
    expect(p).toMatch(/only/i);
  });
});

describe('sanitizeExpansion', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeExpansion('  Kup mleko.  \n')).toBe('Kup mleko.');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeExpansion('   \n  ')).toBe('');
  });
});

describe('isDuplicateRendition', () => {
  it('is true when the rendition differs only by case/punctuation/whitespace', () => {
    expect(isDuplicateRendition('kup mleko', 'Kup mleko.')).toBe(true);
    expect(isDuplicateRendition('Cześć!', '  cześć  ')).toBe(true);
  });

  it('is false when the rendition adds words', () => {
    expect(isDuplicateRendition('dentysta', 'Wizyta u dentysty jutro.')).toBe(false);
  });
});
