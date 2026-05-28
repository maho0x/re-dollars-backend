import { describe, expect, it } from 'bun:test';
import { config } from '../config/env.js';
import { getUserForToken, resolveOAuthRedirectUri } from './authService.js';

interface QueryRecord {
  sql: string;
  params: unknown[];
}

class QueryPool {
  public queries: QueryRecord[] = [];

  constructor(private readonly rows: unknown[] = [], private readonly fail = false) {}

  query<Row>(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    if (this.fail) throw new Error('unavailable');
    return Promise.resolve({ rows: this.rows as Row[] });
  }
}

describe('getUserForToken', () => {
  it('returns null for missing or expired tokens without querying profile caches', async () => {
    const tokenPool = new QueryPool([]);
    const searchProfilePool = new QueryPool([
      { uid: 42, username: 'alice', nickname: 'Alice', avatar_url: 'https://avatar/alice.jpg' },
    ]);
    const localProfilePool = new QueryPool([
      { uid: 42, username: 'alice-local', nickname: 'Alice Local', avatar_url: '' },
    ]);

    const result = await getUserForToken('missing-token', {
      tokenPool,
      searchProfilePool,
      localProfilePool,
    });

    expect(result).toBeNull();
    expect(tokenPool.queries).toHaveLength(1);
    expect(searchProfilePool.queries).toHaveLength(0);
    expect(localProfilePool.queries).toHaveLength(0);
  });

  it('resolves authenticated users from cached profiles only', async () => {
    const tokenPool = new QueryPool([{ user_id: 42 }]);
    const searchProfilePool = new QueryPool([
      { uid: 42, username: 'alice', nickname: 'Alice', avatar_url: 'https://avatar/alice.jpg' },
    ]);
    const localProfilePool = new QueryPool([
      { uid: 42, username: 'alice-local', nickname: 'Alice Local', avatar_url: '' },
    ]);

    const result = await getUserForToken('valid-token', {
      tokenPool,
      searchProfilePool,
      localProfilePool,
    });

    expect(result).toEqual({
      id: 42,
      nickname: 'Alice',
      avatar: 'https://avatar/alice.jpg',
    });
    expect(searchProfilePool.queries[0]?.sql).toContain('FROM users');
    expect(searchProfilePool.queries[0]?.params).toEqual([42]);
    expect(localProfilePool.queries).toHaveLength(0);
  });

  it('falls back to local profiles and then uid without external lookups', async () => {
    const tokenPool = new QueryPool([{ user_id: 42 }]);
    const searchProfilePool = new QueryPool([], true);
    const localProfilePool = new QueryPool([
      { uid: 42, username: 'alice-local', nickname: null, avatar_url: null },
    ]);

    const localResult = await getUserForToken('valid-token', {
      tokenPool,
      searchProfilePool,
      localProfilePool,
    });

    expect(localResult).toEqual({ id: 42, nickname: 'alice-local', avatar: '' });
    expect(localProfilePool.queries[0]?.sql).toContain('FROM user_profiles');

    const uidOnlyResult = await getUserForToken('valid-token', {
      tokenPool: new QueryPool([{ user_id: 84 }]),
      searchProfilePool: new QueryPool([]),
      localProfilePool: new QueryPool([]),
    });

    expect(uidOnlyResult).toEqual({ id: 84, nickname: '84', avatar: '' });
  });
});

describe('resolveOAuthRedirectUri', () => {
  it('uses the legacy callback URL for old userscript requests', () => {
    expect(resolveOAuthRedirectUri(new URL('http://bgmchat.ry.mk/api/auth/callback?code=abc'))).toBe(
      'https://bgmchat.ry.mk/api/auth/callback',
    );
  });

  it('uses forwarded host and proto from a reverse proxy', () => {
    const request = new Request('http://127.0.0.1/api/auth/callback?code=abc', {
      headers: {
        'x-forwarded-host': 'bgmchat.ry.mk',
        'x-forwarded-proto': 'https',
      },
    });

    expect(resolveOAuthRedirectUri(new URL(request.url), request)).toBe(
      'https://bgmchat.ry.mk/api/auth/callback',
    );
  });

  it('keeps the configured callback for local development requests', () => {
    expect(resolveOAuthRedirectUri(new URL('http://127.0.0.1:13032/api/auth/callback?code=abc'))).toBe(
      config.bgm.callbackUrl,
    );
  });
});
