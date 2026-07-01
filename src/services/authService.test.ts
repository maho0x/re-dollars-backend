import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { config } from '../config/env.js';
import {
  clearRymkAuthSessionCache,
  getUserForToken,
  resolveOAuthRedirectUri,
  tokenLogin,
  verifyRymkAuthToken,
} from './authService.js';

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

const originalFetch = globalThis.fetch;
const originalJwtSecret = config.auth.jwtSecret;

function encodeJwtPart(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signRymkAuthJwt(payload: Record<string, unknown> = {}) {
  const header = encodeJwtPart({ alg: 'HS256', typ: 'JWT' });
  const body = encodeJwtPart({
    aud: config.auth.client,
    bangumiId: 560875,
    bangumiUsername: 'blake',
    nickname: 'Blake',
    avatar: 'https://avatar/blake.jpg',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  });
  const signature = createHmac('sha256', config.auth.jwtSecret!)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
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
      remoteAuthVerifier: async () => null,
    });

    expect(result).toBeNull();
    expect(tokenPool.queries).toHaveLength(1);
    expect(searchProfilePool.queries).toHaveLength(0);
    expect(localProfilePool.queries).toHaveLength(0);
  });

  it('falls back to rymk-auth token verification when no local token exists', async () => {
    const tokenPool = new QueryPool([]);

    const result = await getUserForToken('remote-token', {
      tokenPool,
      remoteAuthVerifier: async (token) => token === 'remote-token'
        ? { id: 560875, nickname: 'Blake', avatar: 'https://avatar/blake.jpg' }
        : null,
    });

    expect(result).toEqual({
      id: 560875,
      nickname: 'Blake',
      avatar: 'https://avatar/blake.jpg',
    });
    expect(tokenPool.queries).toHaveLength(1);
  });

  it('skips local token lookup for JWT-shaped rymk-auth tokens', async () => {
    const tokenPool = new QueryPool([]);
    const result = await getUserForToken('header.payload.signature', {
      tokenPool,
      remoteAuthVerifier: async (token) => token === 'header.payload.signature'
        ? { id: 560875, nickname: 'Blake', avatar: 'https://avatar/blake.jpg' }
        : null,
    });

    expect(result).toEqual({
      id: 560875,
      nickname: 'Blake',
      avatar: 'https://avatar/blake.jpg',
    });
    expect(tokenPool.queries).toHaveLength(0);
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

describe('verifyRymkAuthToken', () => {
  beforeEach(() => {
    clearRymkAuthSessionCache();
    config.auth.jwtSecret = 'test-secret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    config.auth.jwtSecret = originalJwtSecret;
    clearRymkAuthSessionCache();
  });

  it('caches locally verified sessions when auth service is unavailable', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error('auth service unavailable');
    }) as unknown as typeof fetch;

    const token = signRymkAuthJwt();

    await expect(verifyRymkAuthToken(token)).resolves.toEqual({
      id: 560875,
      nickname: 'Blake',
      avatar: 'https://avatar/blake.jpg',
    });
    await expect(verifyRymkAuthToken(token)).resolves.toEqual({
      id: 560875,
      nickname: 'Blake',
      avatar: 'https://avatar/blake.jpg',
    });
    expect(requests).toBe(1);
  });

  it('falls open to the local user when the auth proxy returns 403 (Cloudflare challenge)', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      // A managed-challenge / proxy 403 is NOT a revocation — auth.ry.mk itself
      // always answers 200. The locally verified user must still be trusted.
      return new Response('<!DOCTYPE html>Just a moment...', { status: 403 });
    }) as unknown as typeof fetch;

    const token = signRymkAuthJwt();

    await expect(verifyRymkAuthToken(token)).resolves.toEqual({
      id: 560875,
      nickname: 'Blake',
      avatar: 'https://avatar/blake.jpg',
    });
    expect(requests).toBe(1);
  });

  it('caches explicit remote revocations', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({ authenticated: false });
    }) as unknown as typeof fetch;

    const token = signRymkAuthJwt();

    await expect(verifyRymkAuthToken(token)).resolves.toBeNull();
    await expect(verifyRymkAuthToken(token)).resolves.toBeNull();
    expect(requests).toBe(1);
  });

  it('accepts tokens without an aud claim (auth.ry.mk cookie session tokens)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('auth service unavailable');
    }) as unknown as typeof fetch;

    const token = signRymkAuthJwt({ aud: undefined });

    await expect(verifyRymkAuthToken(token)).resolves.toEqual({
      id: 560875,
      nickname: 'Blake',
      avatar: 'https://avatar/blake.jpg',
    });
  });

  it('accepts tokens minted for a sibling ry.mk client', async () => {
    globalThis.fetch = (async () => {
      throw new Error('auth service unavailable');
    }) as unknown as typeof fetch;

    const token = signRymkAuthJwt({ aud: 'rd-imghost' });

    await expect(verifyRymkAuthToken(token)).resolves.toEqual({
      id: 560875,
      nickname: 'Blake',
      avatar: 'https://avatar/blake.jpg',
    });
  });

  it('still rejects tokens signed with the wrong secret', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error('auth service unavailable');
    }) as unknown as typeof fetch;

    const [header, body] = signRymkAuthJwt().split('.');
    const forged = `${header}.${body}.${createHmac('sha256', 'wrong-secret')
      .update(`${header}.${body}`)
      .digest('base64url')}`;

    await expect(verifyRymkAuthToken(forged)).resolves.toBeNull();
    expect(requests).toBe(0);
  });
});

describe('tokenLogin', () => {
  it('issues a local token after rymk-auth client token verification', async () => {
    const result = await tokenLogin({ token: 'client-session-token' }, {
      tokenPool: new QueryPool([]),
      remoteAuthVerifier: async (token) => token === 'client-session-token'
        ? { id: 560875, nickname: 'Blake', avatar: 'https://avatar/blake.jpg' }
        : null,
      localTokenIssuer: async () => 'local-session-token',
    });

    expect(result).toEqual({
      status: true,
      token: 'local-session-token',
      user: { id: 560875, nickname: 'Blake', avatar: 'https://avatar/blake.jpg' },
    });
  });

  it('returns a soft failure when neither session nor PM token is valid', async () => {
    const result = await tokenLogin({ token: 'bad-token' }, {
      tokenPool: new QueryPool([]),
      remoteAuthVerifier: async () => null,
      localTokenIssuer: async () => 'unused-local-session-token',
    });

    expect(result).toEqual({ status: false, message: 'Invalid or expired token' });
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
