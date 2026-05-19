export function buildSubjectPrompt(body: string): string {
  return `Generate a concise, descriptive email subject (max 80 chars, no quotes, no trailing punctuation) for the following message body. Use the same language as the BODY. Reply with the subject only, no preamble.

BODY:
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
