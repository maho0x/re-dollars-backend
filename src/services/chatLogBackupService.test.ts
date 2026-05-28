import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  chatLogBackupFileName,
  chatLogBackupRange,
  ChatLogBackupService,
  cleanOldChatLogBackups,
  serializeChatLogRows,
} from './chatLogBackupService.js';

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 're-dollars-chat-log-backup-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
  }));
});

describe('chat log backup helpers', () => {
  it('exports the previous complete UTC day by default', () => {
    const range = chatLogBackupRange(new Date('2026-05-28T04:30:00.000Z'), 1);

    expect(range.start.toISOString()).toBe('2026-05-27T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-05-28T00:00:00.000Z');
    expect(range.startTs).toBe(1_779_840_000);
    expect(range.endTs).toBe(1_779_926_400);
    expect(chatLogBackupFileName(range)).toBe('chatlog_2026-05-27.jsonl.gz');
  });

  it('serializes chat rows as newline-delimited JSON', () => {
    const serialized = serializeChatLogRows([
      {
        id: '1',
        bangumi_id: '1001',
        timestamp: '1779840001',
        uid: '42',
        nickname: 'Alice',
        avatar: null,
        message: 'hello',
        color: null,
        is_html: false,
        type: 'text',
        reply_to_id: null,
        is_deleted: false,
        edited_at: null,
        original_content: null,
      },
    ]);

    expect(serialized).toBe(`${JSON.stringify({
      id: 1,
      bangumi_id: 1001,
      timestamp: 1_779_840_001,
      uid: 42,
      nickname: 'Alice',
      avatar: '',
      message: 'hello',
      color: null,
      is_html: false,
      type: 'text',
      reply_to_id: null,
      is_deleted: false,
      edited_at: null,
      original_content: null,
    })}\n`);
  });

  it('deletes only expired chat log archives', async () => {
    const dir = await tempDir();
    const oldArchive = join(dir, 'old.jsonl.gz');
    const freshArchive = join(dir, 'fresh.jsonl.gz');
    const oldSql = join(dir, 'old.sql');
    await writeFile(oldArchive, 'old');
    await writeFile(freshArchive, 'fresh');
    await writeFile(oldSql, 'old sql');

    const oldDate = new Date('2026-05-01T00:00:00.000Z');
    await Promise.all([
      utimes(oldArchive, oldDate, oldDate),
      utimes(oldSql, oldDate, oldDate),
    ]);

    const deleted = await cleanOldChatLogBackups(dir, 7, new Date('2026-05-28T00:00:00.000Z'));

    expect(deleted).toEqual(['old.jsonl.gz']);
    await expect(stat(oldArchive)).rejects.toThrow();
    expect((await stat(freshArchive)).isFile()).toBe(true);
    expect((await stat(oldSql)).isFile()).toBe(true);
  });
});

describe('ChatLogBackupService', () => {
  it('writes a gzipped JSONL archive and uploads it with the chat-log tag prefix', async () => {
    const dir = await tempDir();
    const uploads: Array<{ filePath: string; tagPrefix: string; date: string }> = [];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const service = new ChatLogBackupService({
      enabled: true,
      dir,
      keepDays: 30,
      windowDays: 1,
      github: { repo: 'acme/backups', token: 'token', tagPrefix: 'backup' },
      queryFn: async (sql, params) => {
        queries.push({ sql, params });
        return {
          rows: [
            {
              id: 1,
              bangumi_id: 1001,
              timestamp: 1_779_840_001,
              uid: 42,
              nickname: 'Alice',
              avatar: '',
              message: 'hello',
              color: null,
              is_html: false,
              type: 'text',
              reply_to_id: null,
              is_deleted: false,
              edited_at: null,
              original_content: null,
            },
          ],
        };
      },
      uploadFn: async (filePath, github, _fetchFn, now) => {
        uploads.push({ filePath, tagPrefix: github.tagPrefix, date: now?.toISOString() ?? '' });
        return true;
      },
      now: () => new Date('2026-05-28T04:30:00.000Z'),
    });

    const result = await service.performBackup();

    expect(result.status).toBe('ok');
    expect(result.messageCount).toBe(1);
    expect(result.uploadedToGitHub).toBe(true);
    expect(result.filePath?.endsWith('chatlog_2026-05-27.jsonl.gz')).toBe(true);
    expect(queries[0]?.params).toEqual([1_779_840_000, 1_779_926_400]);
    expect(uploads).toEqual([
      {
        filePath: result.filePath!,
        tagPrefix: 'chat-log',
        date: '2026-05-27T00:00:00.000Z',
      },
    ]);

    const archive = await readFile(result.filePath!);
    const jsonl = gunzipSync(archive).toString('utf-8');
    expect(jsonl).toContain('"message":"hello"');
    expect(jsonl.endsWith('\n')).toBe(true);
  });
});
