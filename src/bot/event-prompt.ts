// src/bot/event-prompt.ts
import { z } from 'zod';

export interface EventData {
  summary: string;
  allDay: boolean;
  start: string;
  end: string;
  location: string | null;
  description: string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const rawEventSchema = z.object({
  summary: z.string(),
  allDay: z.boolean(),
  start: z.string(),
  end: z.string().optional(),
  location: z.string().nullable(),
  description: z.string().nullable(),
});

const envelopeSchema = z.object({
  event: rawEventSchema.nullable(),
});

export function buildEventPrompt(input: { body: string; nowInTz: string; timezone: string }): string {
  return `You extract a single calendar event from a chat message. Return JSON only.

Current local time: ${input.nowInTz}
Timezone: ${input.timezone}

Rules:
- Interpret all extracted times as local to the timezone above (no conversion).
- Resolve relative dates ("tomorrow", "next weekend", "w czwartek") relative to the current local time.
- If the message has no date or you are not confident, return {"event": null}.
- "summary" should be the concise apparent subject of the message (e.g. "Turnus", "Spotkanie"), not the whole body.
- "allDay" is true unless an explicit clock time is present in the message.
- All-day "start" and "end" are dates only: "YYYY-MM-DD". For a single-day event, set end = start.
- Timed "start" and "end" are local-naive: "YYYY-MM-DDTHH:mm". If no explicit end time was given, omit "end".
- For weekend phrases, use Saturday as start and Sunday as inclusive end.
- "end" is INCLUSIVE for all-day events (e.g. "14.05–16.05" → start=2026-05-14, end=2026-05-16).
- "location" and "description" are null if not present.

Schema:
{
  "event": null | {
    "summary": string,
    "allDay": boolean,
    "start": string,
    "end"?: string,
    "location": string | null,
    "description": string | null
  }
}

MESSAGE:
${input.body}`;
}

function addOneHourLocalNaive(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  dt.setUTCHours(dt.getUTCHours() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

export function parseEventResponse(input: unknown): EventData | null {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) return null;
  const raw = parsed.data.event;
  if (raw === null) return null;
  if (raw.summary.trim() === '') return null;

  let end = raw.end;
  if (raw.allDay) {
    if (!DATE_ONLY.test(raw.start)) return null;
    if (end === undefined) end = raw.start;
    if (!DATE_ONLY.test(end)) return null;
  } else {
    if (!DATE_TIME.test(raw.start)) return null;
    if (end === undefined) end = addOneHourLocalNaive(raw.start);
    if (!DATE_TIME.test(end)) return null;
  }

  if (end < raw.start) return null;

  return {
    summary: raw.summary,
    allDay: raw.allDay,
    start: raw.start,
    end,
    location: raw.location,
    description: raw.description,
  };
}
