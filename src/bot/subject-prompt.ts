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
