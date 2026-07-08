export function buildExpansionPrompt(body: string): string {
  return `You rewrite a short chat message into a clean, readable version for an email body.

Rules:
- Fix typos and obvious mistakes. Expand terse phrasing (e.g. a couple of words) into a simple, complete sentence.
- Write in the SAME LANGUAGE as the message. Do NOT translate it.
- Stay faithful: do NOT invent facts, names, dates, or details that are not in the message.
- Leave links/URLs exactly AS-IS. Do NOT follow, interpret, summarise, shorten, or reword them — copy each URL verbatim.
- Reply with the rewritten text only, no preamble, no quotes, no commentary.

MESSAGE:
${body}`;
}

export function sanitizeExpansion(raw: string): string {
  return raw.trim();
}

function normalizeForDup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .normalize('NFC');
}

/**
 * True when the rewritten rendition adds nothing over the original — it differs
 * only by case, punctuation, or whitespace. Used to skip appending a pure
 * duplicate (common for very short messages).
 */
export function isDuplicateRendition(original: string, rendition: string): boolean {
  return normalizeForDup(original) === normalizeForDup(rendition);
}
