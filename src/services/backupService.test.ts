import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  BackupService,
  buildPgDumpInvocation,
  cleanOldBackups,
  nextBackupDelayMs,
  safeBackupStem,
  uploadBackupToGitHub,
} from './backupService.js';

const tempDirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 're-dollars-backup-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await rm(dir, { recursive: true, force: true });
  }));
});

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('backup helpers', () => {
  it('builds pg_dump arguments without shell interpolation', () => {
    const invocation = buildPgDumpInvocation({
      host: '127.0.0.1',
      port: 5432,
      user: 'bgmchat',
      password: 'secret password',
      database: 'bgm-chat',
    }, '/tmp/out.sql');

    expect(invocation).toEqual({
      command: 'pg_dump',
      args: ['-h', '127.0.0.1', '-p', '5432', '-U', 'bgmchat', '-d', 'bgm-chat', '-F', 'p', '-f', '/tmp/out.sql'],
      env: { PGPASSWORD: 'secret password' },
      databaseName: 'bgm-chat',
    });
  });

  it('can exclude sensitive table data from pg_dump output', () => {
    const invocation = buildPgDumpInvocation({
      host: '127.0.0.1',
      port: 5432,
      user: 'bgmchat',
      password: '',
      database: 'bgm-chat',
    }, '/tmp/out.sql', 'pg_dump', ['auth_tokens', 'session']);

    expect(invocation.args).toContain('--exclude-table-data=auth_tokens');
    expect(invocation.args).toContain('--exclude-table-data=session');
    expect(invocation.args.indexOf('--exclude-table-data=auth_tokens')).toBeLessThan(invocation.args.indexOf('-f'));
  });

  it('supports DATABASE_URL dumps and safe backup file stems', () => {
    const invocation = buildPgDumpInvocation(
      { connectionString: 'postgres://user:pass@example.test:5432/bgmchat?sslmode=require' },
      '/tmp/out.sql',
      '/usr/bin/pg_dump',
    );

    expect(invocation.command).toBe('/usr/bin/pg_dump');
    expect(invocation.args).toEqual(['-F', 'p', '-f', '/tmp/out.sql', 'postgres://user:pass@example.test:5432/bgmchat?sslmode=require']);
    expect(invocation.databaseName).toBe('bgmchat');
    expect(safeBackupStem('bgm/chat;prod')).toBe('bgm_chat_prod');
  });

  it('calculates the next daily backup delay', () => {
    expect(nextBackupDelayMs(new Date('2026-05-26T03:30:00.000Z'), 4)).toBe(30 * 60 * 1000);
    expect(nextBackupDelayMs(new Date('2026-05-26T04:30:00.000Z'), 4)).toBe(23.5 * 60 * 60 * 1000);
  });

  it('deletes only expired sql backups', async () => {
    const dir = await tempDir();
    const oldSql = join(dir, 'old.sql');
    const freshSql = join(dir, 'fresh.sql');
    const oldTxt = join(dir, 'old.txt');
    await writeFile(oldSql, 'old');
    await writeFile(freshSql, 'fresh');
    await writeFile(oldTxt, 'old text');

    const oldDate = new Date('2026-05-01T00:00:00.000Z');
    await Promise.all([
      utimes(oldSql, oldDate, oldDate),
      utimes(oldTxt, oldDate, oldDate),
    ]);

    const deleted = await cleanOldBackups(dir, 7, new Date('2026-05-26T00:00:00.000Z'));

    expect(deleted).toEqual(['old.sql']);
    await expect(stat(oldSql)).rejects.toThrow();
    expect((await stat(freshSql)).isFile()).toBe(true);
    expect((await stat(oldTxt)).isFile()).toBe(true);
  });
});

describe('uploadBackupToGitHub', () => {
  it('creates a daily release and uploads the dump when configured', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'dump.sql');
    await writeFile(filePath, 'backup sql');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push(init === undefined ? { url } : { url, init });
      if (url.endsWith('/releases/tags/db-backup-2026-05-26')) return okJson({}, 404);
      if (url.endsWith('/releases')) {
        return okJson({ upload_url: 'https://uploads.github.com/repos/acme/backups/releases/1/assets{?name,label}' });
      }
      if (url.startsWith('https://uploads.github.com/')) return new Response('', { status: 201 });
      return new Response('', { status: 500 });
    };

    const uploaded = await uploadBackupToGitHub(
      filePath,
      { repo: 'acme/backups', token: 'ghp_secret', tagPrefix: 'db-backup' },
      fetchFn,
      new Date('2026-05-26T12:00:00.000Z'),
    );

    expect(uploaded).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/acme/backups/releases/tags/db-backup-2026-05-26',
      'https://api.github.com/repos/acme/backups/releases',
      'https://uploads.github.com/repos/acme/backups/releases/1/assets?name=dump.sql',
    ]);
    expect(calls[1]?.init?.method).toBe('POST');
    expect(calls[2]?.init?.method).toBe('POST');
  });

  it('skips GitHub upload when repo or token is missing', async () => {
    const uploaded = await uploadBackupToGitHub('/tmp/missing.sql', { repo: undefined, token: undefined, tagPrefix: 'backup' });
    expect(uploaded).toBe(false);
  });
});

describe('BackupService', () => {
  it('runs pg_dump, uploads, and prunes old backups', async () => {
    const dir = await tempDir();
    const oldSql = join(dir, 'old.sql');
    await writeFile(oldSql, 'old');
    const oldDate = new Date('2026-05-01T00:00:00.000Z');
    await utimes(oldSql, oldDate, oldDate);
    const spawned: Array<{ command: string; args: string[] }> = [];
    const spawnProcess = (command: string, args: string[]) => {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => {
        const outputPath = args[args.indexOf('-f') + 1];
        if (typeof outputPath === 'string') void writeFile(outputPath, 'dump').then(() => child.emit('close', 0, null));
      });
      return child as never;
    };
    const fetchFn = async (url: string) => {
      if (url.includes('/releases/tags/backup-2026-05-26')) {
        return okJson({ upload_url: 'https://uploads.github.com/repos/acme/backups/releases/1/assets{?name,label}' });
      }
      if (url.startsWith('https://uploads.github.com/')) return new Response('', { status: 201 });
      return new Response('', { status: 500 });
    };
    const service = new BackupService({
      enabled: true,
      dir,
      keepDays: 7,
      db: {
        host: 'db.local',
        port: 5432,
        user: 'bgmchat',
        password: 'secret',
        database: 'bgmchat',
      },
      github: { repo: 'acme/backups', token: 'token', tagPrefix: 'backup' },
      excludeTableData: ['auth_tokens'],
      spawnProcess: spawnProcess as never,
      fetchFn,
      now: () => new Date('2026-05-26T12:00:00.000Z'),
    });

    const result = await service.performBackup();

    expect(result.status).toBe('ok');
    expect(result.uploadedToGitHub).toBe(true);
    expect(result.deletedOldBackups).toEqual(['old.sql']);
    expect(spawned[0]?.command).toBe('pg_dump');
    expect(spawned[0]?.args).toContain('bgmchat');
    expect(spawned[0]?.args).toContain('--exclude-table-data=auth_tokens');
    expect(result.filePath?.endsWith('bgmchat_backup_2026-05-26T12-00-00-000Z.sql')).toBe(true);
  });
});
