import { randomBytes } from 'node:crypto';
import { config } from '../config/env.js';
import { pool, searchPool } from '../db/pool.js';
import type { AuthUser } from '../types.js';
import { ApiError } from '../utils/http.js';
import { fetchBangumiApi } from '../utils/bangumi.js';

interface QueryResult<Row> {
  rows: Row[];
}

interface QueryPool {
  query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

interface AuthLookupPools {
  tokenPool?: QueryPool;
  searchProfilePool?: QueryPool;
  localProfilePool?: QueryPool;
}

interface ProfileRow {
  uid: number | string;
  username: string | null;
  nickname: string | null;
  avatar_url: string | null;
}

interface BangumiMe {
  id: number;
  username?: string;
  nickname?: string;
  avatar?: {
    large?: string;
    medium?: string;
    small?: string;
  };
  sign?: string;
}

function firstHeaderValue(value: string | null) {
  return value?.split(',')[0]?.trim() || undefined;
}

function isLocalHost(host: string) {
  let hostname = host;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    hostname = host.split(':')[0] ?? host;
  }
  hostname = hostname.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return hostname === 'localhost' || hostname === '::1' || hostname?.startsWith('127.');
}

export function resolveOAuthRedirectUri(url: URL, request?: Request) {
  const forwardedHost = firstHeaderValue(request?.headers.get('x-forwarded-host') ?? null);
  const host = forwardedHost ?? request?.headers.get('host') ?? url.host;
  if (!host || isLocalHost(host)) return config.bgm.callbackUrl;

  const forwardedProto = firstHeaderValue(request?.headers.get('x-forwarded-proto') ?? null);
  const protocol = ((forwardedProto ?? url.protocol.replace(/:$/, '')) || 'https').replace(/:$/, '');
  const publicProtocol = protocol === 'http' ? 'https' : protocol;
  return `${publicProtocol}://${host}${url.pathname}`;
}

function authUserFromProfile(userId: number, profile?: ProfileRow): AuthUser {
  const fallbackName = profile?.username || String(userId);
  return {
    id: userId,
    nickname: profile?.nickname || fallbackName,
    avatar: profile?.avatar_url || '',
  };
}

async function getCachedProfile(userId: number, pools: AuthLookupPools = {}) {
  const profilePools = [
    {
      pool: pools.searchProfilePool ?? searchPool,
      sql: 'SELECT uid, username, nickname, avatar_url FROM users WHERE uid = $1 LIMIT 1',
    },
    {
      pool: pools.localProfilePool ?? pool,
      sql: 'SELECT uid, username, nickname, avatar_url FROM user_profiles WHERE uid = $1 LIMIT 1',
    },
  ];

  for (const item of profilePools) {
    try {
      const { rows } = await item.pool.query<ProfileRow>(item.sql, [userId]);
      if (rows[0]) return rows[0];
    } catch {
      // Profile caches are optional during migration; auth must stay fast.
    }
  }

  return null;
}

async function persistAuthProfile(user: BangumiMe) {
  const username = user.username ?? String(user.id);
  const nickname = user.nickname ?? username;
  const avatarUrl = user.avatar?.large ?? user.avatar?.medium ?? user.avatar?.small ?? '';
  const sign = user.sign ?? '';
  const params = [user.id, username, nickname, avatarUrl, sign];

  await Promise.allSettled([
    pool.query(
      `INSERT INTO user_profiles (uid, username, nickname, avatar_url, sign, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (uid) DO UPDATE SET username = EXCLUDED.username, nickname = EXCLUDED.nickname,
         avatar_url = EXCLUDED.avatar_url, sign = EXCLUDED.sign, updated_at = NOW()`,
      params,
    ),
    searchPool.query(
      `INSERT INTO users (uid, username, nickname, avatar_url, sign, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (uid) DO UPDATE SET username = EXCLUDED.username, nickname = EXCLUDED.nickname,
         avatar_url = EXCLUDED.avatar_url, sign = EXCLUDED.sign, updated_at = NOW()`,
      params,
    ),
  ]);
}

export async function getUserForToken(
  token: string,
  pools: AuthLookupPools = {},
): Promise<AuthUser | null> {
  const tokenPool = pools.tokenPool ?? pool;
  const { rows } = await tokenPool.query<{ user_id: number | string }>(
    'SELECT user_id FROM auth_tokens WHERE token = $1 AND expires_at > NOW()',
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  const userId = Number(row.user_id);
  const profile = Number.isFinite(userId) ? await getCachedProfile(userId, pools) : null;
  return authUserFromProfile(userId, profile ?? undefined);
}

export async function tokenLogin(body: unknown) {
  const token = String((body as { token?: string }).token ?? '').trim();
  if (!token) throw new ApiError(400, 'No token provided');
  const user = await getUserForToken(token);
  if (!user) return { status: false, message: 'Invalid or expired token' };
  return { status: true, user, token };
}

export async function me(user: AuthUser | null) {
  if (!user) return { status: false };
  return { status: true, user };
}

export async function logout(token: string | null) {
  if (token) {
    await pool.query('DELETE FROM auth_tokens WHERE token = $1', [token]);
  }
  return { status: true };
}

export async function oauthCallback(url: URL, request?: Request) {
  const code = url.searchParams.get('code');
  if (!code) throw new ApiError(400, 'No code provided');
  if (!config.bgm.appId || !config.bgm.appSecret) {
    throw new ApiError(500, 'Bangumi OAuth is not configured');
  }

  const tokenResponse = await fetch('https://bgm.tv/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.bgm.appId,
      client_secret: config.bgm.appSecret,
      code,
      redirect_uri: resolveOAuthRedirectUri(url, request),
    }),
  });

  if (!tokenResponse.ok) throw new ApiError(502, 'Bangumi OAuth token exchange failed');
  const tokenData = await tokenResponse.json() as { access_token?: string };
  if (!tokenData.access_token) throw new ApiError(502, 'Bangumi OAuth token response was invalid');

  const meResponse = await fetchBangumiApi('/me', {
    headers: { authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!meResponse.ok) throw new ApiError(502, 'Bangumi user lookup failed');
  const user = await meResponse.json() as BangumiMe;

  const longLivedToken = randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  await pool.query('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)', [
    longLivedToken,
    user.id,
    expiresAt,
  ]);
  await persistAuthProfile(user);

  return new Response(
    `<script>
      window.opener && window.opener.postMessage({ type: "bgm_login_success", token: ${JSON.stringify(longLivedToken)} }, "*");
      window.close();
    </script>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `dollars_auth=${encodeURIComponent(longLivedToken)}; Path=/; Max-Age=31536000; SameSite=None; Secure; HttpOnly`,
      },
    },
  );
}
