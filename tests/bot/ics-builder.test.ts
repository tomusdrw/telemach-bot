// tests/bot/ics-builder.test.ts
import { describe, expect, it } from 'vitest';
import type { EventData } from '../../src/bot/event-prompt';
import { buildIcs } from '../../src/bot/ics-builder';

const now = new Date('2026-05-19T09:00:00Z');

function build(overrides: Partial<EventData> = {}, opts: Partial<Parameters<typeof buildIcs>[0]> = {}) {
  const event: EventData = {
    summary: 'Turnus',
    allDay: true,
    start: '2026-05-14',
    end: '2026-05-14',
    location: null,
    description: null,
    ...overrides,
  };
  return buildIcs({
    event,
    timezone: 'Europe/Warsaw',
    organizerEmail: 'bot@example.com',
    attendeeEmail: 'me@example.com',
    now,
    chatId: 7,
    messageId: 1001,
    ...opts,
  });
}

describe('buildIcs', () => {
  it('filename and contentType', () => {
    const r = build();
    expect(r.filename).toBe('event.ics');
    expect(r.contentType).toBe('text/calendar; method=PUBLISH; charset=UTF-8');
  });

  it('uses CRLF line endings', () => {
    const ics = build().content.toString('utf8');
    expect(ics).toContain('\r\n');
    expect(ics.split('\n').filter((l) => l && !l.endsWith('\r')).length).toBe(0);
  });

  it('declares METHOD:PUBLISH', () => {
    const ics = build().content.toString('utf8');
    expect(ics).toContain('METHOD:PUBLISH');
  });

  it('all-day single day → DTSTART/DTEND date-only, end exclusive (+1 day)', () => {
    const ics = build({ allDay: true, start: '2026-05-14', end: '2026-05-14' }).content.toString('utf8');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260514');
    expect(ics).toContain('DTEND;VALUE=DATE:20260515');
  });

  it('all-day range "14.05–16.05" → DTEND=20260517 (inclusive→exclusive)', () => {
    const ics = build({ allDay: true, start: '2026-05-14', end: '2026-05-16' }).content.toString('utf8');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260514');
    expect(ics).toContain('DTEND;VALUE=DATE:20260517');
  });

  it('timed event uses TZID and emits VTIMEZONE block', () => {
    const ics = build({
      allDay: false,
      start: '2026-05-21T14:10',
      end: '2026-05-21T15:10',
    }).content.toString('utf8');
    expect(ics).toContain('TZID');
    expect(ics).toContain('Europe/Warsaw');
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toContain('END:VTIMEZONE');
    expect(ics).toContain('DTSTART;TZID=Europe/Warsaw:20260521T141000');
    expect(ics).toContain('DTEND;TZID=Europe/Warsaw:20260521T151000');
  });

  it('escapes commas, semicolons, newlines, backslashes in SUMMARY', () => {
    const ics = build({ summary: 'A, B; C\nD\\E' }).content.toString('utf8');
    // RFC 5545 escaping: \, \; \n \\
    expect(ics).toMatch(/SUMMARY:[^\r\n]*A\\, B\\; C\\nD\\\\E/);
  });

  it('omits LOCATION when location is null', () => {
    const ics = build({ location: null }).content.toString('utf8');
    expect(ics).not.toMatch(/^LOCATION:/m);
  });

  it('includes LOCATION when present', () => {
    const ics = build({ location: 'Warsaw, ul. Marszałkowska 1' }).content.toString('utf8');
    expect(ics).toContain('LOCATION:');
    expect(ics).toContain('Marsza');
  });

  it('UID is stable for same inputs', () => {
    const a = build().content.toString('utf8');
    const b = build().content.toString('utf8');
    const uidOf = (s: string) => /UID:([^\r\n]+)/.exec(s)?.[1];
    expect(uidOf(a)).toBe(uidOf(b));
  });

  it('UID differs when chatId or messageId differs', () => {
    const a = build({}, { chatId: 7, messageId: 1001 }).content.toString('utf8');
    const b = build({}, { chatId: 7, messageId: 1002 }).content.toString('utf8');
    const uidOf = (s: string) => /UID:([^\r\n]+)/.exec(s)?.[1];
    expect(uidOf(a)).not.toBe(uidOf(b));
  });

  it('UID ends with @telemach-bot', () => {
    const ics = build().content.toString('utf8');
    expect(ics).toMatch(/UID:[^\r\n]+@telemach-bot/);
  });

  it('long SUMMARY is folded at 75 octets per RFC 5545', () => {
    const long = 'x'.repeat(200);
    const ics = build({ summary: long }).content.toString('utf8');
    const lines = ics.split('\r\n');
    for (const line of lines) {
      // Continuation lines start with a space; folded line length ≤ 75 octets
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
  });
});
