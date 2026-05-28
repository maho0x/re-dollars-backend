import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { config } from '../config/env.js';

type DbConfig = typeof config.db;
type R2Config = typeof config.r2Backup;

interface SpawnedProcess {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnedProcess;

interface PgDumpInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  databaseName: string;
}

interface BackupServiceOptions {
  enabled?: boolean;
  dir?: string;
  keepDays?: number;
  hour?: number;
  runOnStart?: boolean;
  pgDumpBin?: string;
  excludeTableData?: string[];
  db?: DbConfig;
  r2?: R2Config;
  spawnProcess?: SpawnProcess;
  now?: () => Date;
}

export interface BackupResult {
  status: 'disabled' | 'ok' | 'error';
  filePath?: string;
  uploadedToR2?: boolean;
  deletedOldBackups?: string[];
  error?: string;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function databaseNameFromConnectionString(connectionString: string) {
  try {
    const parsed = new URL(connectionString);
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? 'database');
  } catch {
    return 'database';
  }
}

export function safeBackupStem(databaseName: string) {
  return databaseName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'database';
}

export function nextBackupDelayMs(now: Date, hour: number) {
  const boundedHour = Math.min(Math.max(Math.trunc(hour), 0), 23);
  const next = new Date(now);
  next.setHours(boundedHour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function buildPgDumpInvocation(
  db: DbConfig,
  filePath: string,
  pgDumpBin = 'pg_dump',
  excludeTableData: string[] = [],
): PgDumpInvocation {
  const excludeArgs = excludeTableData.map((table) => `--exclude-table-data=${table}`);
  if ('connectionString' in db) {
    return {
      command: pgDumpBin,
      args: ['-F', 'p', ...excludeArgs, '-f', filePath, db.connectionString],
      env: {},
      databaseName: databaseNameFromConnectionString(db.connectionString),
    };
  }

  const env: Record<string, string> = {};
  if (db.password) env.PGPASSWORD = db.password;

  return {
    command: pgDumpBin,
    args: [
      '-h', db.host,
      '-p', String(db.port),
      '-U', db.user,
      '-d', db.database,
      '-F', 'p',
      ...excludeArgs,
      '-f', filePath,
    ],
    env,
    databaseName: db.database,
  };
}

async function runPgDump(invocation: PgDumpInvocation, spawnProcess: SpawnProcess) {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(invocation.command, invocation.args, {
      env: { ...process.env, ...invocation.env },
      stdio: 'ignore',
    });

    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code, signal) => settle(() => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pg_dump exited with ${code ?? signal ?? 'unknown status'}`));
    }));
  });
}

async function runCommand(command: string, args: string[], spawnProcess: SpawnProcess) {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: 'ignore' });

    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code, signal) => settle(() => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    }));
  });
}

export async function cleanOldBackups(dir: string, keepDays: number, now = new Date()) {
  const deleted: string[] = [];
  const retentionMs = Math.max(0, keepDays) * 24 * 60 * 60 * 1000;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return deleted;
    throw error;
  }

  await Promise.all(files.map(async (file) => {
    if (!file.endsWith('.sql')) return;
    const filePath = join(dir, file);
    const stats = await stat(filePath);
    if (now.getTime() - stats.mtimeMs <= retentionMs) return;
    await unlink(filePath);
    deleted.push(file);
  }));

  deleted.sort();
  return deleted;
}

export async function uploadBackupToR2(
  filePath: string,
  r2: R2Config,
  spawnProcess: SpawnProcess = spawn,
) {
  if (!r2.remote) return false;
  const fileName = basename(filePath);
  await runCommand(r2.rcloneBin, ['copyto', filePath, `${r2.remote.replace(/\/+$/, '')}/${fileName}`], spawnProcess);
  return true;
}

export async function cleanOldR2Backups(
  r2: R2Config,
  keepDays: number,
  includePattern: string,
  spawnProcess: SpawnProcess = spawn,
) {
  if (!r2.remote) return false;
  await runCommand(
    r2.rcloneBin,
    ['delete', '--min-age', `${Math.max(0, keepDays)}d`, r2.remote, `--include=${includePattern}`],
    spawnProcess,
  );
  return true;
}

export class BackupService {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly keepDays: number;
  private readonly hour: number;
  private readonly runOnStart: boolean;
  private readonly pgDumpBin: string;
  private readonly excludeTableData: string[];
  private readonly db: DbConfig;
  private readonly r2: R2Config;
  private readonly spawnProcess: SpawnProcess;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(options: BackupServiceOptions = {}) {
    this.enabled = options.enabled ?? config.backup.enabled;
    this.dir = options.dir ?? config.backup.dir;
    this.keepDays = options.keepDays ?? config.backup.keepDays;
    this.hour = options.hour ?? config.backup.hour;
    this.runOnStart = options.runOnStart ?? config.backup.runOnStart;
    this.pgDumpBin = options.pgDumpBin ?? config.backup.pgDumpBin;
    this.excludeTableData = options.excludeTableData ?? config.backup.excludeTableData;
    this.db = options.db ?? config.db;
    this.r2 = options.r2 ?? config.r2Backup;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? (() => new Date());
  }

  start() {
    if (!this.enabled) {
      console.info('[backup] disabled');
      return;
    }
    if (this.timer) return;

    console.info(`[backup] scheduler started; dir=${this.dir} hour=${this.hour}`);
    if (this.runOnStart) void this.performBackup();
    this.scheduleNext();
  }

  stop() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  async performBackup(): Promise<BackupResult> {
    if (!this.enabled) return { status: 'disabled' };
    if (this.running) return { status: 'error', error: 'Backup already running' };

    this.running = true;
    try {
      await mkdir(this.dir, { recursive: true });
      const draftInvocation = buildPgDumpInvocation(this.db, '', this.pgDumpBin, this.excludeTableData);
      const timestamp = this.now().toISOString().replace(/[:.]/g, '-');
      const filePath = join(this.dir, `${safeBackupStem(draftInvocation.databaseName)}_backup_${timestamp}.sql`);
      const invocation = buildPgDumpInvocation(this.db, filePath, this.pgDumpBin, this.excludeTableData);

      console.info(`[backup] starting ${basename(filePath)}`);
      await runPgDump(invocation, this.spawnProcess);
      const uploadedToR2 = await uploadBackupToR2(filePath, this.r2, this.spawnProcess);
      const deletedOldBackups = await cleanOldBackups(this.dir, this.keepDays, this.now());
      await cleanOldR2Backups(this.r2, this.keepDays, `${safeBackupStem(draftInvocation.databaseName)}_backup_*.sql`, this.spawnProcess);
      console.info(`[backup] completed ${filePath}`);

      return {
        status: 'ok',
        filePath,
        uploadedToR2,
        deletedOldBackups,
      };
    } catch (error) {
      console.error('[backup] failed:', errorMessage(error));
      return { status: 'error', error: errorMessage(error) };
    } finally {
      this.running = false;
    }
  }

  private scheduleNext() {
    this.stop();
    const delayMs = nextBackupDelayMs(this.now(), this.hour);
    this.timer = setTimeout(() => {
      void this.performBackup().finally(() => this.scheduleNext());
    }, delayMs);
  }
}

export const backupService = new BackupService();
