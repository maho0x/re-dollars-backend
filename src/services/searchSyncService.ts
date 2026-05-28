import pg from 'pg';
import type { PoolConfig } from 'pg';
import { config } from '../config/env.js';
import { pool, searchPool } from '../db/pool.js';

interface QueryResult<Row> {
  rows: Row[];
}

interface QueryClient {
  query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  release(): void;
}

interface QueryPool {
  query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  connect?(): Promise<QueryClient>;
  end?(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): void;
}

export interface SearchUserProfile {
  uid: number;
  username: string | null;
  nickname: string | null;
  avatar_url: string | null;
  sign: string | null;
}

export interface SearchSyncResult {
  status: 'disabled' | 'skipped' | 'ok' | 'error';
  newUsers: number;
  recentUsers: number;
  error?: string;
}

interface SearchSyncOptions {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  batchSize?: number;
  recentLimit?: number;
  queryTimeoutMs?: number;
  remotePool?: QueryPool;
  searchTargetPool?: QueryPool;
  profilePool?: QueryPool;
}

const UPSERT_SEARCH_USER = `
INSERT INTO users (uid, username, nickname, avatar_url, sign, updated_at)
VALUES ($1, $2, $3, $4, $5, NOW())
ON CONFLICT (uid) DO UPDATE SET
  username = EXCLUDED.username,
  nickname = EXCLUDED.nickname,
  avatar_url = EXCLUDED.avatar_url,
  sign = EXCLUDED.sign,
  updated_at = NOW()`;

const UPSERT_USER_PROFILE = `
INSERT INTO user_profiles (uid, username, nickname, avatar_url, sign, updated_at)
VALUES ($1, $2, $3, $4, $5, NOW())
ON CONFLICT (uid) DO UPDATE SET
  username = EXCLUDED.username,
  nickname = EXCLUDED.nickname,
  avatar_url = EXCLUDED.avatar_url,
  sign = EXCLUDED.sign,
  updated_at = NOW()`;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeProfile(row: SearchUserProfile): SearchUserProfile {
  return {
    uid: Number(row.uid),
    username: row.username ?? '',
    nickname: row.nickname ?? row.username ?? '',
    avatar_url: row.avatar_url ?? '',
    sign: row.sign ?? '',
  };
}

function profileParams(row: SearchUserProfile) {
  const profile = normalizeProfile(row);
  return [profile.uid, profile.username, profile.nickname, profile.avatar_url, profile.sign];
}

export class SearchSyncService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly batchSize: number;
  private readonly recentLimit: number;
  private readonly remotePool: QueryPool | null;
  private readonly searchTargetPool: QueryPool;
  private readonly profilePool: QueryPool;
  private readonly ownsRemotePool: boolean;
  private checkJob: ReturnType<typeof setInterval> | null = null;
  private initialJob: ReturnType<typeof setTimeout> | null = null;
  private isSyncing = false;
  private consecutiveFailures = 0;

  constructor(options: SearchSyncOptions = {}) {
    this.intervalMs = options.intervalMs ?? config.searchSync.intervalMs;
    this.initialDelayMs = options.initialDelayMs ?? config.searchSync.initialDelayMs;
    this.batchSize = options.batchSize ?? config.searchSync.batchSize;
    this.recentLimit = options.recentLimit ?? config.searchSync.recentLimit;
    this.searchTargetPool = options.searchTargetPool ?? searchPool;
    this.profilePool = options.profilePool ?? pool;
    this.enabled = options.enabled ?? (config.searchSync.enabled && Boolean(options.remotePool ?? config.remoteSearchDb));

    if (options.remotePool) {
      this.remotePool = options.remotePool;
      this.ownsRemotePool = false;
    } else if (this.enabled && config.remoteSearchDb) {
      const queryTimeoutMs = options.queryTimeoutMs ?? config.searchSync.queryTimeoutMs;
      const poolConfig: PoolConfig & { statement_timeout?: number } = {
        ...config.remoteSearchDb,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        max: 3,
        statement_timeout: queryTimeoutMs,
      };
      this.remotePool = new pg.Pool(poolConfig);
      this.ownsRemotePool = true;
    } else {
      this.remotePool = null;
      this.ownsRemotePool = false;
    }

    this.remotePool?.on?.('error', (error) => {
      console.warn('[search-sync] remote pool background error:', error.message);
    });
  }

  start() {
    if (!this.enabled || !this.remotePool) {
      console.info('[search-sync] disabled; no remote search database configured');
      return;
    }
    if (this.checkJob || this.initialJob) return;

    console.info(`[search-sync] starting profile sync every ${this.intervalMs}ms`);
    this.initialJob = setTimeout(() => {
      this.initialJob = null;
      void this.syncOnce();
    }, this.initialDelayMs);
    this.checkJob = setInterval(() => void this.syncOnce(), this.intervalMs);
  }

  async stop() {
    if (this.initialJob) {
      clearTimeout(this.initialJob);
      this.initialJob = null;
    }
    if (this.checkJob) {
      clearInterval(this.checkJob);
      this.checkJob = null;
    }
    if (this.ownsRemotePool) {
      await this.remotePool?.end?.();
    }
  }

  async syncOnce(): Promise<SearchSyncResult> {
    if (!this.enabled || !this.remotePool) {
      return { status: 'disabled', newUsers: 0, recentUsers: 0 };
    }
    if (this.isSyncing) {
      return { status: 'skipped', newUsers: 0, recentUsers: 0 };
    }

    this.isSyncing = true;
    try {
      const { rows: localRows } = await this.searchTargetPool.query<{ max_id: number | string | null }>(
        'SELECT MAX(uid) as max_id FROM users',
      );
      const localMaxId = Number(localRows[0]?.max_id ?? 0);

      const { rows: newUsers } = await this.remotePool.query<SearchUserProfile>(
        `SELECT uid, username, nickname, avatar_url, sign
         FROM users
         WHERE uid > $1
         ORDER BY uid ASC
         LIMIT $2`,
        [localMaxId, this.batchSize],
      );
      await this.persistProfiles(newUsers);

      let recentUsers: SearchUserProfile[] = [];
      if (this.recentLimit > 0) {
        const recent = await this.remotePool.query<SearchUserProfile>(
          `SELECT uid, username, nickname, avatar_url, sign
           FROM users
           ORDER BY uid DESC
           LIMIT $1`,
          [this.recentLimit],
        );
        recentUsers = recent.rows;
        await this.persistProfiles(recentUsers);
      }

      this.consecutiveFailures = 0;
      return { status: 'ok', newUsers: newUsers.length, recentUsers: recentUsers.length };
    } catch (error) {
      this.consecutiveFailures += 1;
      console.error('[search-sync] user profile sync failed:', {
        error: errorMessage(error),
        failures: this.consecutiveFailures,
      });
      return { status: 'error', newUsers: 0, recentUsers: 0, error: errorMessage(error) };
    } finally {
      this.isSyncing = false;
    }
  }

  async getRemoteUserProfile(uid: number) {
    if (!this.enabled || !this.remotePool) return null;
    return this.fetchRemoteProfile('uid', uid);
  }

  async getRemoteUserProfileByUsername(username: string) {
    if (!this.enabled || !this.remotePool) return null;
    return this.fetchRemoteProfile('username', username);
  }

  private async fetchRemoteProfile(field: 'uid' | 'username', value: number | string) {
    try {
      const { rows } = await this.remotePool?.query<SearchUserProfile>(
        `SELECT uid, username, nickname, avatar_url, sign FROM users WHERE ${field} = $1`,
        [value],
      ) ?? { rows: [] };
      const profile = rows[0] ? normalizeProfile(rows[0]) : null;
      if (profile) {
        await this.persistProfiles([profile]).catch(() => undefined);
      }
      return profile;
    } catch {
      return null;
    }
  }

  private async persistProfiles(rows: SearchUserProfile[]) {
    if (!rows.length) return;
    const profiles = rows.map(normalizeProfile);
    await this.upsertSearchUsers(profiles);
    await Promise.allSettled(profiles.map((profile) => (
      this.profilePool.query(UPSERT_USER_PROFILE, profileParams(profile))
    )));
  }

  private async upsertSearchUsers(rows: SearchUserProfile[]) {
    const client = await this.searchTargetPool.connect?.();
    if (!client) {
      for (const row of rows) {
        await this.searchTargetPool.query(UPSERT_SEARCH_USER, profileParams(row));
      }
      return;
    }

    try {
      await client.query('BEGIN');
      for (const row of rows) {
        await client.query(UPSERT_SEARCH_USER, profileParams(row));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export const searchSyncService = new SearchSyncService();
