import { describe, expect, it } from 'bun:test';
import { SearchSyncService, type SearchUserProfile } from './searchSyncService.js';

class QueryClient {
  constructor(private readonly pool: QueryPool) {}

  query<Row>(sql: string, params?: unknown[]) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      this.pool.transactions.push(sql);
      return Promise.resolve({ rows: [] as Row[] });
    }
    return this.pool.query<Row>(sql, params);
  }

  release() {
    this.pool.releases += 1;
  }
}

class QueryPool {
  public inserts: unknown[][] = [];
  public lookups: unknown[][] = [];
  public transactions: string[] = [];
  public releases = 0;

  constructor(
    private readonly rowsByKind: {
      max?: Array<{ max_id: number | string | null }>;
      newUsers?: SearchUserProfile[];
      recentUsers?: SearchUserProfile[];
      lookup?: SearchUserProfile[];
    } = {},
  ) {}

  query<Row>(sql: string, params: unknown[] = []) {
    if (sql.includes('SELECT MAX(uid)')) {
      return Promise.resolve({ rows: (this.rowsByKind.max ?? [{ max_id: 0 }]) as Row[] });
    }
    if (sql.includes('WHERE uid >')) {
      this.lookups.push(params);
      return Promise.resolve({ rows: (this.rowsByKind.newUsers ?? []) as Row[] });
    }
    if (sql.includes('ORDER BY uid DESC')) {
      this.lookups.push(params);
      return Promise.resolve({ rows: (this.rowsByKind.recentUsers ?? []) as Row[] });
    }
    if (sql.includes('WHERE uid = $1') || sql.includes('WHERE username = $1')) {
      this.lookups.push(params);
      return Promise.resolve({ rows: (this.rowsByKind.lookup ?? []) as Row[] });
    }
    if (sql.includes('INSERT INTO users') || sql.includes('INSERT INTO user_profiles')) {
      this.inserts.push(params);
      return Promise.resolve({ rows: [] as Row[] });
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  connect() {
    return Promise.resolve(new QueryClient(this));
  }
}

describe('SearchSyncService', () => {
  it('copies new and recent remote profiles into search and local profile tables', async () => {
    const remotePool = new QueryPool({
      newUsers: [
        { uid: 2, username: 'alice', nickname: 'Alice', avatar_url: 'https://avatar/2.jpg', sign: 'hi' },
      ],
      recentUsers: [
        { uid: 5, username: 'bob', nickname: null, avatar_url: null, sign: null },
      ],
    });
    const searchTargetPool = new QueryPool({ max: [{ max_id: 1 }] });
    const profilePool = new QueryPool();
    const service = new SearchSyncService({
      enabled: true,
      remotePool,
      searchTargetPool,
      profilePool,
      recentLimit: 1,
    });

    const result = await service.syncOnce();

    expect(result).toEqual({ status: 'ok', newUsers: 1, recentUsers: 1 });
    expect(remotePool.lookups).toEqual([[1, 1000], [1]]);
    expect(searchTargetPool.transactions).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
    expect(searchTargetPool.releases).toBe(2);
    expect(searchTargetPool.inserts).toEqual([
      [2, 'alice', 'Alice', 'https://avatar/2.jpg', 'hi'],
      [5, 'bob', 'bob', '', ''],
    ]);
    expect(profilePool.inserts).toEqual(searchTargetPool.inserts);
  });

  it('fetches one remote profile on demand and persists it locally', async () => {
    const remotePool = new QueryPool({
      lookup: [
        { uid: 8, username: 'carol', nickname: 'Carol', avatar_url: 'https://avatar/8.jpg', sign: null },
      ],
    });
    const searchTargetPool = new QueryPool();
    const profilePool = new QueryPool();
    const service = new SearchSyncService({
      enabled: true,
      remotePool,
      searchTargetPool,
      profilePool,
    });

    const result = await service.getRemoteUserProfileByUsername('carol');

    expect(result).toEqual({
      uid: 8,
      username: 'carol',
      nickname: 'Carol',
      avatar_url: 'https://avatar/8.jpg',
      sign: '',
    });
    expect(remotePool.lookups).toEqual([['carol']]);
    expect(searchTargetPool.inserts).toEqual([[8, 'carol', 'Carol', 'https://avatar/8.jpg', '']]);
    expect(profilePool.inserts).toEqual(searchTargetPool.inserts);
  });

  it('stays disabled when no remote profile database is configured', async () => {
    const service = new SearchSyncService({ enabled: false });

    expect(await service.syncOnce()).toEqual({ status: 'disabled', newUsers: 0, recentUsers: 0 });
    expect(await service.getRemoteUserProfile(1)).toBeNull();
  });
});

