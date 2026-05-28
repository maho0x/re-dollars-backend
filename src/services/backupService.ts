import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { config } from '../config/env.js';

type DbConfig = typeof config.db;

interface SpawnedProcess {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnedProcess;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface PgDumpInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  databaseName: string;
}

interface GithubReleaseAsset {
  name?: string;
  url?: string;
}

interface GithubRelease {
  upload_url?: string;
  assets?: GithubReleaseAsset[];
}

interface BackupServiceOptions {
  enabled?: boolean;
  dir?: string;
  keepDays?: number;
  hour?: number;
  runOnStart?: boolean;
  pgDumpBin?: string;
  db?: DbConfig;
  github?: typeof config.githubBackup;
  spawnProcess?: SpawnProcess;
  fetchFn?: FetchFn;
  now?: () => Date;
}

export interface BackupResult {
  status: 'disabled' | 'ok' | 'error';
  filePath?: string;
  uploadedToGitHub?: boolean;
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

export function buildPgDumpInvocation(db: DbConfig, filePath: string, pgDumpBin = 'pg_dump'): PgDumpInvocation {
  if ('connectionString' in db) {
    return {
      command: pgDumpBin,
      args: ['-F', 'p', '-f', filePath, db.connectionString],
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

function githubHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'ReDollarsNext-Backup-Service',
    'x-github-api-version': '2022-11-28',
  };
}

async function readJson(response: Response) {
  return await response.json() as GithubRelease;
}

export async function uploadBackupToGitHub(
  filePath: string,
  github: typeof config.githubBackup,
  fetchFn: FetchFn = fetch,
  now = new Date(),
) {
  if (!github.repo || !github.token) return false;

  const dateStr = now.toISOString().split('T')[0] ?? 'unknown-date';
  const tag = `${github.tagPrefix}-${dateStr}`;
  const headers = githubHeaders(github.token);
  const releasesUrl = `https://api.github.com/repos/${github.repo}/releases`;
  const releaseByTagUrl = `${releasesUrl}/tags/${encodeURIComponent(tag)}`;

  let response = await fetchFn(releaseByTagUrl, { headers });
  let release: GithubRelease;

  if (response.status === 404) {
    response = await fetchFn(releasesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tag_name: tag,
        name: `Backup ${dateStr}`,
        body: `Automated database backup for ${dateStr}.`,
        draft: false,
        prerelease: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to create GitHub release: ${response.status} ${response.statusText}`);
    }
    release = await readJson(response);
  } else {
    if (!response.ok) {
      throw new Error(`Failed to fetch GitHub release: ${response.status} ${response.statusText}`);
    }
    release = await readJson(response);
  }

  const uploadUrlBase = release.upload_url?.split('{')[0];
  if (!uploadUrlBase) throw new Error('GitHub release upload_url missing');

  const fileName = basename(filePath);
  const existingAsset = release.assets?.find((asset) => asset.name === fileName && asset.url);
  if (existingAsset?.url) {
    const deleteResponse = await fetchFn(existingAsset.url, { method: 'DELETE', headers });
    if (!deleteResponse.ok) {
      throw new Error(`Failed to delete existing GitHub asset: ${deleteResponse.status} ${deleteResponse.statusText}`);
    }
  }

  const file = await readFile(filePath);
  const uploadResponse = await fetchFn(`${uploadUrlBase}?name=${encodeURIComponent(fileName)}`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'content-length': String(file.byteLength),
    },
    body: file,
  });

  if (!uploadResponse.ok) {
    const message = await uploadResponse.text().catch(() => uploadResponse.statusText);
    throw new Error(`GitHub backup upload failed: ${uploadResponse.status} ${message}`);
  }

  return true;
}

export class BackupService {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly keepDays: number;
  private readonly hour: number;
  private readonly runOnStart: boolean;
  private readonly pgDumpBin: string;
  private readonly db: DbConfig;
  private readonly github: typeof config.githubBackup;
  private readonly spawnProcess: SpawnProcess;
  private readonly fetchFn: FetchFn;
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
    this.db = options.db ?? config.db;
    this.github = options.github ?? config.githubBackup;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.fetchFn = options.fetchFn ?? fetch;
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
      const draftInvocation = buildPgDumpInvocation(this.db, '', this.pgDumpBin);
      const timestamp = this.now().toISOString().replace(/[:.]/g, '-');
      const filePath = join(this.dir, `${safeBackupStem(draftInvocation.databaseName)}_backup_${timestamp}.sql`);
      const invocation = buildPgDumpInvocation(this.db, filePath, this.pgDumpBin);

      console.info(`[backup] starting ${basename(filePath)}`);
      await runPgDump(invocation, this.spawnProcess);
      const uploadedToGitHub = await uploadBackupToGitHub(filePath, this.github, this.fetchFn, this.now());
      const deletedOldBackups = await cleanOldBackups(this.dir, this.keepDays, this.now());
      console.info(`[backup] completed ${filePath}`);

      return {
        status: 'ok',
        filePath,
        uploadedToGitHub,
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
