// tests/bot/event-prompt.test.ts
import { describe, expect, it } from 'vitest';
import { buildEventPrompt, parseEventResponse } from '../../src/bot/event-prompt';

describe('buildEventPrompt', () => {
  it('includes timezone and nowInTz verbatim', () => {
    const p = buildEventPrompt({
      body: 'Spotkanie w czwartek o 14:10',
      nowInTz: '2026-05-19 09:00',
      timezone: 'Europe/Warsaw',
    });
    expect(p).toContain('Europe/Warsaw');
    expect(p).toContain('2026-05-19 09:00');
    expect(p).toContain('Spotkanie w czwartek o 14:10');
  });

  it('instructs the model to return JSON with "event": null when unsure', () => {
    const p = buildEventPrompt({ body: 'random', nowInTz: '2026-05-19 09:00', timezone: 'UTC' });
    expect(p).toMatch(/"event"\s*:\s*null/);
  });
});

describe('parseEventResponse', () => {
  it('returns the event for a well-formed all-day single day', () => {
    const r = parseEventResponse({
      event: {
        summary: 'Turnus',
        allDay: true,
        start: '2026-05-14',
        end: '2026-05-14',
        location: null,
        description: null,
      },
    });
    expect(r).toEqual({
      summary: 'Turnus',
      allDay: true,
      start: '2026-05-14',
      end: '2026-05-14',
      location: null,
      description: null,
    });
  });

  it('returns the event for a well-formed all-day range', () => {
    const r = parseEventResponse({
      event: {
        summary: 'Turnus',
        allDay: true,
        start: '2026-05-14',
        end: '2026-05-16',
        location: null,
        description: null,
      },
    });
    expect(r?.end).toBe('2026-05-16');
  });

  it('returns the event for a timed event with explicit end', () => {
    const r = parseEventResponse({
      event: {
        summary: 'Spotkanie',
        allDay: false,
        start: '2026-05-21T14:10',
        end: '2026-05-21T15:10',
        location: null,
        description: null,
      },
    });
    expect(r?.allDay).toBe(false);
    expect(r?.end).toBe('2026-05-21T15:10');
  });

  it('fills missing end with start + 1h for timed events', () => {
    const r = parseEventResponse({
      event: {
        summary: 'Spotkanie',
        allDay: false,
        start: '2026-05-21T14:10',
        location: null,
        description: null,
      },
    });
    expect(r?.end).toBe('2026-05-21T15:10');
  });

  it('null event → null', () => {
    expect(parseEventResponse({ event: null })).toBeNull();
  });

  it('end < start → null', () => {
    const r = parseEventResponse({
      event: {
        summary: 'X',
        allDay: true,
        start: '2026-05-16',
        end: '2026-05-14',
        location: null,
        description: null,
      },
    });
    expect(r).toBeNull();
  });

  it('empty summary → null', () => {
    const r = parseEventResponse({
      event: {
        summary: '',
        allDay: true,
        start: '2026-05-14',
        end: '2026-05-14',
        location: null,
        description: null,
      },
    });
    expect(r).toBeNull();
  });

  it('malformed input → null', () => {
    expect(parseEventResponse({ event: { summary: 'x' } })).toBeNull();
    expect(parseEventResponse(null)).toBeNull();
    expect(parseEventResponse('not json')).toBeNull();
  });

  it('all-day with non-date strings → null', () => {
    const r = parseEventResponse({
      event: {
        summary: 'X',
        allDay: true,
        start: '2026-05-14T10:00',
        end: '2026-05-14T11:00',
        location: null,
        description: null,
      },
    });
    expect(r).toBeNull();
  });

  it('timed with date-only strings → null', () => {
    const r = parseEventResponse({
      event: {
        summary: 'X',
        allDay: false,
        start: '2026-05-14',
        end: '2026-05-14',
        location: null,
        description: null,
      },
    });
    expect(r).toBeNull();
  });
});
