// src/bot/ics-builder.ts
import { createHash } from 'node:crypto';
import { getVtimezoneComponent } from '@touch4it/ical-timezones';
import ical, { ICalCalendarMethod } from 'ical-generator';
import type { EventData } from './event-prompt.js';

export interface IcsInput {
  event: EventData;
  timezone: string;
  now: Date;
  chatId: number;
  messageId: number;
}

export interface IcsOutput {
  content: Buffer;
  filename: string;
  contentType: string;
}

function validateLocalNaive(iso: string, kind: 'date' | 'datetime'): void {
  const re = kind === 'date' ? /^(\d{4})-(\d{2})-(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
  const m = re.exec(iso);
  if (!m) throw new Error(`invalid ${kind}: ${iso}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const date = new Date(y, mo, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) {
    throw new Error(`invalid ${kind} (rollover): ${iso}`);
  }
  if (kind === 'datetime') {
    const h = Number(m[4]);
    const mi = Number(m[5]);
    if (h > 23 || mi > 59) throw new Error(`invalid ${kind} (out of range): ${iso}`);
  }
}

function parseAllDayDate(iso: string): Date {
  // YYYY-MM-DD → Date at 00:00:00 LOCAL time.
  // ical-generator calls getDate()/getMonth()/getFullYear() (local-time methods) when
  // formatting VALUE=DATE properties with a timezone set on the calendar, so we must
  // store the wall-clock date in local components to be host-TZ independent.
  // Caller must have already called validateLocalNaive(iso, 'date').
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)!;
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

function addOneDay(d: Date): Date {
  // Use local-time setDate so the day arithmetic matches parseAllDayDate's local construction.
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + 1);
  return r;
}

function stableUid(input: IcsInput): string {
  const h = createHash('sha256');
  h.update(`${input.chatId}:${input.messageId}:${input.event.start}:${input.event.summary}`);
  return `${h.digest('hex').slice(0, 32)}@telemach-bot`;
}

export function buildIcs(input: IcsInput): IcsOutput {
  if (input.event.allDay) {
    validateLocalNaive(input.event.start, 'date');
    validateLocalNaive(input.event.end, 'date');
  } else {
    validateLocalNaive(input.event.start, 'datetime');
    validateLocalNaive(input.event.end, 'datetime');
  }

  const cal = ical({
    prodId: { company: 'telemach-bot', product: 'telemach-bot', language: 'EN' },
    method: ICalCalendarMethod.PUBLISH,
    timezone: { name: input.timezone, generator: getVtimezoneComponent },
  });

  if (input.event.allDay) {
    const startDate = parseAllDayDate(input.event.start);
    const endDateInclusive = parseAllDayDate(input.event.end);
    const endDateExclusive = addOneDay(endDateInclusive);

    cal.createEvent({
      id: stableUid(input),
      start: startDate,
      end: endDateExclusive,
      allDay: true,
      summary: input.event.summary,
      description: input.event.description ?? undefined,
      location: input.event.location ?? undefined,
      stamp: input.now,
      timezone: undefined,
    });
  } else {
    // Pass ISO strings directly. `new Date('YYYY-MM-DDTHH:mm')` is parsed as LOCAL time
    // in JS, so ical-generator's local-time accessors yield the original wall clock.
    cal.createEvent({
      id: stableUid(input),
      start: input.event.start,
      end: input.event.end,
      allDay: false,
      summary: input.event.summary,
      description: input.event.description ?? undefined,
      location: input.event.location ?? undefined,
      stamp: input.now,
      timezone: input.timezone,
    });
  }

  // ical-generator does not append a trailing CRLF; we add one so every
  // logical line (including the final END:VCALENDAR) ends with \r\n.
  const content = Buffer.from(`${cal.toString()}\r\n`, 'utf8');
  return {
    content,
    filename: 'event.ics',
    contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
  };
}
