import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { nextBackupDelayMs, uploadBackupToGitHub } from './backupService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type UploadFn = typeof uploadBackupToGitHub;

interface ChatLogRow {
  id: number | string;
  bangumi_id: number | string | null;
  timestamp: number | string;
  uid: number | string;
  nickname: string;
  avatar: string | null;
  message: string | null;
  color: string | null;
  is_html: boolean | null;
  type: string | null;
  reply_to_id: number | string | null;
  is_deleted: boolean | null;
  edited_at: string | Date | null;
  original_content: string | null;
}

type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: ChatLogRow[] }>;

interface ChatLogBackupOptions {
  enabled?: boolean;
  dir?: string;
  keepDays?: number;
  hour?: number;
  runOnStart?: boolean;
  windowDays?: number;
  tagPrefix?: string;
  github?: typeof config.githubBackup;
  queryFn?: QueryFn;
  fetchFn?: FetchFn;
  uploadFn?: UploadFn;
  now?: () => Date;
}

export interface ChatLogBackupRange {
  start: Date;
  end: Date;
  startTs: number;
  endTs: number;
}

export interface ChatLogBackupResult {
  status: 'disabled' | 'ok' | 'error';
  filePath?: string;
  messageCount?: number;
  uploadedToGitHub?: boolean;
  deletedOldBackups?: string[];
  error?: string;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function dateStamp(date: Date) {
  return date.toISOString().slice(0, 10);
}

function numberOrNull(value: number | string | null) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const defaultQueryFn: QueryFn = async (sql: string, params: unknown[]) => {
  const result = await pool.query(sql, params);
  return { rows: result.rows as ChatLogRow[] };
};

export function chatLogBackupRange(now: Date, windowDays: number): ChatLogBackupRange {
  const days = Math.max(1, Math.trunc(windowDays));
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = endMs - days * DAY_MS;
  return {
    start: new Date(startMs),
    end: new Date(endMs),
    startTs: Math.floor(startMs / 1000),
    endTs: Math.floor(endMs / 1000),
  };
}

export function chatLogBackupFileName(range: ChatLogBackupRange) {
  const start = dateStamp(range.start);
  const finalDay = new Date(range.end.getTime() - DAY_MS);
  const end = dateStamp(finalDay);
  return start === end ? `chatlog_${start}.jsonl.gz` : `chatlog_${start}_to_${end}.jsonl.gz`;
}

export function serializeChatLogRows(rows: ChatLogRow[]) {
  if (rows.length === 0) return '';
  return `${rows.map((row) => JSON.stringify({
    id: Number(row.id),
    bangumi_id: numberOrNull(row.bangumi_id),
    timestamp: Number(row.timestamp),
    uid: Number(row.uid),
    nickname: row.nickname,
    avatar: row.avatar ?? '',
    message: row.message ?? '',
    color: row.color ?? null,
    is_html: Boolean(row.is_html),
    type: row.type ?? 'text',
    reply_to_id: numberOrNull(row.reply_to_id),
    is_deleted: Boolean(row.is_deleted),
    edited_at: row.edited_at ? new Date(row.edited_at).toISOString() : null,
    original_content: row.original_content ?? null,
  })).join('\n')}\n`;
}

export async function cleanOldChatLogBackups(dir: string, keepDays: number, now = new Date()) {
  const deleted: string[] = [];
  const retentionMs = Math.max(0, keepDays) * DAY_MS;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return deleted;
    throw error;
  }

  await Promise.all(files.map(async (file) => {
    if (!file.endsWith('.jsonl.gz')) return;
    const filePath = join(dir, file);
    const stats = await stat(filePath);
    if (now.getTime() - stats.mtimeMs <= retentionMs) return;
    await unlink(filePath);
    deleted.push(file);
  }));

  deleted.sort();
  return deleted;
}

export class ChatLogBackupService {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly keepDays: number;
  private readonly hour: number;
  private readonly runOnStart: boolean;
  private readonly windowDays: number;
  private readonly tagPrefix: string;
  private readonly github: typeof config.githubBackup;
  private readonly queryFn: QueryFn;
  private readonly fetchFn: FetchFn;
  private readonly uploadFn: UploadFn;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(options: ChatLogBackupOptions = {}) {
    this.enabled = options.enabled ?? config.chatLogBackup.enabled;
    this.dir = options.dir ?? config.chatLogBackup.dir;
    this.keepDays = options.keepDays ?? config.chatLogBackup.keepDays;
    this.hour = options.hour ?? config.chatLogBackup.hour;
    this.runOnStart = options.runOnStart ?? config.chatLogBackup.runOnStart;
    this.windowDays = options.windowDays ?? config.chatLogBackup.windowDays;
    this.tagPrefix = options.tagPrefix ?? config.chatLogBackup.tagPrefix;
    this.github = options.github ?? config.githubBackup;
    this.queryFn = options.queryFn ?? defaultQueryFn;
    this.fetchFn = options.fetchFn ?? fetch;
    this.uploadFn = options.uploadFn ?? uploadBackupToGitHub;
    this.now = options.now ?? (() => new Date());
  }

  start() {
    if (!this.enabled) {
      console.info('[chat-log-backup] disabled');
      return;
    }
    if (this.timer) return;

    console.info(`[chat-log-backup] scheduler started; dir=${this.dir} hour=${this.hour}`);
    if (this.runOnStart) void this.performBackup();
    this.scheduleNext();
  }

  stop() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  async performBackup(): Promise<ChatLogBackupResult> {
    if (!this.enabled) return { status: 'disabled' };
    if (this.running) return { status: 'error', error: 'Chat log backup already running' };

    this.running = true;
    try {
      await mkdir(this.dir, { recursive: true });
      const range = chatLogBackupRange(this.now(), this.windowDays);
      const filePath = join(this.dir, chatLogBackupFileName(range));
      const { rows } = await this.queryFn(
        `SELECT id, bangumi_id, "timestamp", uid, nickname, avatar, message, color,
                is_html, type, reply_to_id, is_deleted, edited_at, original_content
         FROM messages
         WHERE "timestamp" >= $1 AND "timestamp" < $2
         ORDER BY "timestamp" ASC, id ASC`,
        [range.startTs, range.endTs],
      );

      const payload = serializeChatLogRows(rows);
      await writeFile(filePath, gzipSync(Buffer.from(payload, 'utf-8')));
      const uploadedToGitHub = await this.uploadFn(
        filePath,
        { ...this.github, tagPrefix: this.tagPrefix },
        this.fetchFn,
        range.start,
      );
      const deletedOldBackups = await cleanOldChatLogBackups(this.dir, this.keepDays, this.now());
      console.info(`[chat-log-backup] completed ${basename(filePath)} messages=${rows.length}`);

      return {
        status: 'ok',
        filePath,
        messageCount: rows.length,
        uploadedToGitHub,
        deletedOldBackups,
      };
    } catch (error) {
      console.error('[chat-log-backup] failed:', errorMessage(error));
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

export const chatLogBackupService = new ChatLogBackupService();
