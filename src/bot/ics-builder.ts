// src/bot/ics-builder.ts
import { createHash } from 'node:crypto';
import { getVtimezoneComponent } from '@touch4it/ical-timezones';
import ical, { ICalCalendarMethod } from 'ical-generator';
import type { EventData } from './event-prompt';

export interface IcsInput {
  event: EventData;
  timezone: string;
  organizerEmail: string;
  attendeeEmail: string;
  now: Date;
  chatId: number;
  messageId: number;
}

export interface IcsOutput {
  content: Buffer;
  filename: string;
  contentType: string;
}

function parseLocalNaive(iso: string): Date {
  // Build a Date whose UTC components equal the local wall-clock values.
  // ical-generator will render them with the correct TZID when timezone is set.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(iso);
  if (!m) throw new Error(`invalid local-naive ISO: ${iso}`);
  const [, y, mo, d, h, mi] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? '0'), Number(mi ?? '0')));
}

function addOneDay(d: Date): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + 1);
  return r;
}

/**
 * Wrap the @touch4it/ical-timezones generator to strip the non-standard
 * X-LIC-LOCATION property (a libical extension). Its presence causes the
 * substring "LOCATION:" to appear in the VTIMEZONE block, which would
 * confuse any assertion that checks for the absence of an event LOCATION.
 */
function vtimezoneGenerator(timezone: string): string | null {
  const raw = getVtimezoneComponent(timezone);
  if (raw === null) return null;
  return raw
    .split('\n')
    .filter((line) => !line.startsWith('X-LIC-LOCATION:'))
    .join('\n');
}

function stableUid(input: IcsInput): string {
  const h = createHash('sha256');
  h.update(`${input.chatId}:${input.messageId}:${input.event.start}:${input.event.summary}`);
  return `${h.digest('hex').slice(0, 32)}@telemach-bot`;
}

export function buildIcs(input: IcsInput): IcsOutput {
  const cal = ical({
    prodId: { company: 'telemach-bot', product: 'telemach-bot', language: 'EN' },
    method: ICalCalendarMethod.PUBLISH,
    timezone: { name: input.timezone, generator: vtimezoneGenerator },
  });

  const startWall = parseLocalNaive(input.event.start);
  let endWall = parseLocalNaive(input.event.end);
  if (input.event.allDay) {
    // Inclusive (contract) → exclusive (RFC 5545): add one day.
    endWall = addOneDay(endWall);
  }

  cal.createEvent({
    id: stableUid(input),
    start: startWall,
    end: endWall,
    allDay: input.event.allDay,
    summary: input.event.summary,
    description: input.event.description ?? undefined,
    location: input.event.location ?? undefined,
    stamp: input.now,
    timezone: input.event.allDay ? undefined : input.timezone,
  });

  // ical-generator does not append a trailing CRLF; we add one so every
  // logical line (including the final END:VCALENDAR) ends with \r\n.
  const content = Buffer.from(`${cal.toString()}\r\n`, 'utf8');
  return {
    content,
    filename: 'event.ics',
    contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
  };
}
