import { describe, expect, it } from 'bun:test';
import { searchUsers } from './userService.js';

interface QueryRecord {
  sql: string;
  params: unknown[];
}

class QueryPool {
  public queries: QueryRecord[] = [];

  constructor(
    private readonly rows: Array<{
      uid: number;
      username: string | null;
      nickname: string | null;
      avatar_url: string | null;
      sign?: string | null;
    }>,
    private readonly fail = false,
  ) {}

  query<Row>(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    if (this.fail) throw new Error('unavailable');
    return Promise.resolve({ rows: this.rows as Row[] });
  }
}

describe('searchUsers', () => {
  it('returns legacy autocomplete-shaped results from the search profile table', async () => {
    const searchPool = new QueryPool([
      { uid: 10, username: 'alice', nickname: 'Alice', avatar_url: 'https://avatar/10.jpg', sign: 'hi' },
      { uid: 11, username: null, nickname: null, avatar_url: null, sign: null },
    ]);
    const profilePool = new QueryPool([]);

    const result = await searchUsers(new URL('https://example.test/api/v1/users/search?q=ali&limit=2'), {
      searchPool,
      profilePool,
    });

    expect(result).toEqual({
      status: true,
      data: [
        {
          id: 10,
          uid: 10,
          username: 'alice',
          nickname: 'Alice',
          avatar_url: 'https://avatar/10.jpg',
          sign: 'hi',
        },
        {
          id: 11,
          uid: 11,
          username: '11',
          nickname: '11',
          avatar_url: '',
        },
      ],
    });
    expect(searchPool.queries[0]?.params).toEqual(['%ali%', 'ali', 'ali%', null, 2]);
    expect(profilePool.queries).toEqual([]);
  });

  it('falls back to local profiles and deduplicates users', async () => {
    const searchPool = new QueryPool([
      { uid: 10, username: 'alice', nickname: 'Alice', avatar_url: 'https://avatar/10.jpg' },
    ]);
    const profilePool = new QueryPool([
      { uid: 10, username: 'alice', nickname: 'Alice Local', avatar_url: 'https://avatar/local.jpg' },
      { uid: 12, username: 'alicia', nickname: 'Alicia', avatar_url: null },
    ]);

    const result = await searchUsers(new URL('https://example.test/api/v1/users/search?q=ali&limit=3'), {
      searchPool,
      profilePool,
    });

    expect(result.data).toEqual([
      {
        id: 10,
        uid: 10,
        username: 'alice',
        nickname: 'Alice',
        avatar_url: 'https://avatar/10.jpg',
      },
      {
        id: 12,
        uid: 12,
        username: 'alicia',
        nickname: 'Alicia',
        avatar_url: '',
      },
    ]);
    expect(profilePool.queries[0]?.params.at(-1)).toBe(2);
  });

  it('bounds empty and large searches', async () => {
    const searchPool = new QueryPool([]);
    const profilePool = new QueryPool([]);

    expect(await searchUsers(new URL('https://example.test/api/v1/users/search?q='), {
      searchPool,
      profilePool,
    })).toEqual({ status: true, data: [] });

    await searchUsers(new URL('https://example.test/api/v1/users/search?q=42&limit=500'), {
      searchPool,
      profilePool,
    });

    expect(searchPool.queries[0]?.params).toEqual(['%42%', '42', '42%', 42, 50]);
  });
});
