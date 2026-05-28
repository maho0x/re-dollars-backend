import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  BackupService,
  buildPgDumpInvocation,
  cleanOldBackups,
  cleanOldR2Backups,
  nextBackupDelayMs,
  safeBackupStem,
  uploadBackupToR2,
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

describe('R2 backup helpers', () => {
  it('uploads a backup with rclone copyto when configured', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'bgmchat_backup.sql');
    await writeFile(filePath, 'backup sql');
    const spawned: Array<{ command: string; args: string[] }> = [];
    const spawnProcess = (command: string, args: string[]) => {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child as never;
    };

    const uploaded = await uploadBackupToR2(filePath, { remote: 'r2:bangumi-status', rcloneBin: 'rclone' }, spawnProcess as never);

    expect(uploaded).toBe(true);
    expect(spawned).toEqual([
      { command: 'rclone', args: ['copyto', filePath, 'r2:bangumi-status/bgmchat_backup.sql'] },
    ]);
  });

  it('cleans old R2 backups with rclone delete', async () => {
    const spawned: Array<{ command: string; args: string[] }> = [];
    const spawnProcess = (command: string, args: string[]) => {
      spawned.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child as never;
    };

    const cleaned = await cleanOldR2Backups(
      { remote: 'r2:bangumi-status', rcloneBin: 'rclone' },
      7,
      'bgmchat_backup_*.sql',
      spawnProcess as never,
    );

    expect(cleaned).toBe(true);
    expect(spawned).toEqual([
      {
        command: 'rclone',
        args: ['delete', '--min-age', '7d', 'r2:bangumi-status', '--include=bgmchat_backup_*.sql'],
      },
    ]);
  });

  it('skips R2 upload and cleanup when no remote is configured', async () => {
    const uploaded = await uploadBackupToR2('/tmp/missing.sql', { remote: undefined, rcloneBin: 'rclone' });
    const cleaned = await cleanOldR2Backups({ remote: undefined, rcloneBin: 'rclone' }, 7, '*.sql');
    expect(uploaded).toBe(false);
    expect(cleaned).toBe(false);
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
        if (command !== 'pg_dump') {
          child.emit('close', 0, null);
          return;
        }
        const outputPath = args[args.indexOf('-f') + 1];
        if (typeof outputPath === 'string') void writeFile(outputPath, 'dump').then(() => child.emit('close', 0, null));
      });
      return child as never;
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
      r2: { remote: 'r2:bangumi-status', rcloneBin: 'rclone' },
      excludeTableData: ['auth_tokens'],
      spawnProcess: spawnProcess as never,
      now: () => new Date('2026-05-26T12:00:00.000Z'),
    });

    const result = await service.performBackup();

    expect(result.status).toBe('ok');
    expect(result.uploadedToR2).toBe(true);
    expect(result.deletedOldBackups).toEqual(['old.sql']);
    expect(spawned[0]?.command).toBe('pg_dump');
    expect(spawned[0]?.args).toContain('bgmchat');
    expect(spawned[0]?.args).toContain('--exclude-table-data=auth_tokens');
    expect(spawned[1]).toEqual({
      command: 'rclone',
      args: ['copyto', result.filePath!, `r2:bangumi-status/${result.filePath!.split('/').pop()}`],
    });
    expect(spawned[2]).toEqual({
      command: 'rclone',
      args: ['delete', '--min-age', '7d', 'r2:bangumi-status', '--include=bgmchat_backup_*.sql'],
    });
    expect(result.filePath?.endsWith('bgmchat_backup_2026-05-26T12-00-00-000Z.sql')).toBe(true);
  });
});
