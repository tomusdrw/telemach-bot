export function buildSubjectPrompt(body: string): string {
  return `Generate a concise, descriptive email subject for the message below.

Rules:
- Write the subject in the SAME LANGUAGE as the message. Do NOT translate it. A Polish message gets a Polish subject, an English message gets an English subject, and so on — match whatever language the message is written in.
- Max 80 chars. No surrounding quotes, no trailing punctuation.
- Reply with the subject only, no preamble.

MESSAGE:
${body}`;
}

export function sanitizeSubject(raw: string): string {
  let s = raw.replace(/[\r\n\t\f\v]+/g, ' ').trim();
  if (s.length === 0) return '';
  // strip a single pair of wrapping quotes (matching " or ')
  const m = /^(['"])(.*)\1$/s.exec(s);
  if (m) s = m[2]!.trim();
  // strip ONE trailing punctuation char from the set [. ! ? , ;]
  s = s.replace(/[.!?,;]+$/u, '');
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

export function fallbackSubject(username: string | null): string {
  return username ? `Telegram message from @${username}` : 'Telegram message';
}

const SUBJECT_MAX = 80;

/**
 * A message text is "short" — and thus used verbatim as the subject — when,
 * after trimming, it is a single non-empty line no longer than the subject cap.
 */
export function isShortSubject(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (/[\r\n]/.test(t)) return false;
  return t.length <= SUBJECT_MAX;
}

/**
 * The literal message used as an email subject. Only trims and hard-caps at the
 * subject length; unlike {@link sanitizeSubject} it keeps the user's exact
 * punctuation and quotes.
 */
export function verbatimSubject(text: string): string {
  const t = text.trim();
  return t.length > SUBJECT_MAX ? t.slice(0, SUBJECT_MAX) : t;
}
