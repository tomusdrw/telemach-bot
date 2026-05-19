import type { Api } from 'grammy';
import { FatalError, TransientError } from '../lib/errors.js';

export const TELEGRAM_FILE_MAX_BYTES = 20 * 1024 * 1024;

export interface DownloadInput {
  api: Api;
  botToken: string;
  fileId: string;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  buffer: Buffer;
  filename: string;
  mimeType: string | null;
}

export async function downloadTelegramFile(input: DownloadInput): Promise<DownloadResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  let file: { file_path?: string; file_size?: number };
  try {
    file = await input.api.getFile(input.fileId);
  } catch (err) {
    throw new TransientError('getFile failed', { provider: 'telegram', detail: err });
  }
  if (!file.file_path) {
    throw new FatalError('telegram returned no file_path', { provider: 'telegram', detail: file });
  }
  if (typeof file.file_size === 'number' && file.file_size > TELEGRAM_FILE_MAX_BYTES) {
    throw new FatalError(`file too large (${file.file_size} > ${TELEGRAM_FILE_MAX_BYTES})`, {
      provider: 'telegram',
      detail: file,
    });
  }

  const url = `https://api.telegram.org/file/bot${input.botToken}/${file.file_path}`;
  let res: Awaited<ReturnType<typeof fetchImpl>>;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new TransientError('telegram cdn fetch failed', { provider: 'telegram', detail: err });
  }
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`telegram cdn ${res.status}`, { provider: 'telegram' });
    }
    throw new FatalError(`telegram cdn ${res.status}`, { provider: 'telegram' });
  }
  let ab: ArrayBuffer;
  try {
    ab = await res.arrayBuffer();
  } catch (err) {
    throw new TransientError('telegram cdn body read failed', { provider: 'telegram', detail: err });
  }
  if (ab.byteLength > TELEGRAM_FILE_MAX_BYTES) {
    throw new FatalError('downloaded file exceeded size limit', { provider: 'telegram' });
  }
  const buffer = Buffer.from(ab);
  const filename = file.file_path.split('/').pop() ?? 'file.bin';
  return { buffer, filename, mimeType: null };
}
