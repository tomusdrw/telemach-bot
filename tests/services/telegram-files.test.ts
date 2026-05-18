import { describe, it, expect, vi } from 'vitest';
import { downloadTelegramFile, TELEGRAM_FILE_MAX_BYTES } from '../../src/services/telegram-files';
import { FatalError } from '../../src/lib/errors';

function mockFetch(status: number, body?: ArrayBuffer) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body ?? new ArrayBuffer(0),
  });
}

describe('downloadTelegramFile', () => {
  it('downloads a file under the limit', async () => {
    const api = {
      getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file.ogg', file_size: 100 }),
    };
    const fetchImpl = mockFetch(200, new Uint8Array([1, 2, 3]).buffer);
    const result = await downloadTelegramFile({
      api: api as any,
      botToken: 'TOK',
      fileId: 'F',
      fetchImpl,
    });
    expect(result.buffer.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(result.filename).toBe('file.ogg');
    expect(api.getFile).toHaveBeenCalledWith('F');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.telegram.org/file/botTOK/voice/file.ogg'
    );
  });

  it('throws FatalError when file_size exceeds limit', async () => {
    const api = {
      getFile: vi.fn().mockResolvedValue({
        file_path: 'big.bin',
        file_size: TELEGRAM_FILE_MAX_BYTES + 1,
      }),
    };
    await expect(
      downloadTelegramFile({
        api: api as any,
        botToken: 'TOK',
        fileId: 'F',
        fetchImpl: mockFetch(200),
      })
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('throws FatalError on 4xx from Telegram CDN', async () => {
    const api = {
      getFile: vi.fn().mockResolvedValue({ file_path: 'x', file_size: 10 }),
    };
    await expect(
      downloadTelegramFile({
        api: api as any,
        botToken: 'TOK',
        fileId: 'F',
        fetchImpl: mockFetch(404),
      })
    ).rejects.toBeInstanceOf(FatalError);
  });
});
