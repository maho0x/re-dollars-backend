import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
  remoteAuthVerifier?: (token: string) => Promise<AuthUser | null>;
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

interface RymkAuthSessionUser {
  id?: number;
  bangumiId?: number;
  bangumiUsername?: string;
  username?: string;
  nickname?: string;
  avatar?: string;
}

interface TokenLoginOptions extends AuthLookupPools {
  localTokenIssuer?: (user: AuthUser) => Promise<string>;
}

interface RymkAuthSessionCacheEntry {
  user: AuthUser | null;
  expiresAt: number;
}

const RYMK_AUTH_SESSION_POSITIVE_TTL_MS = 60_000;
const RYMK_AUTH_SESSION_NEGATIVE_TTL_MS = 10_000;
const RYMK_AUTH_SESSION_MAX_ENTRIES = 5_000;
const rymkAuthSessionCache = new Map<string, RymkAuthSessionCacheEntry>();
const rymkAuthSessionRequests = new Map<string, Promise<AuthUser | null>>();

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

function authUserFromRymkSession(user: RymkAuthSessionUser): AuthUser | null {
  const id = Number(user.bangumiId ?? user.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const fallbackName = user.bangumiUsername || user.username || String(id);
  return {
    id,
    nickname: user.nickname || fallbackName,
    avatar: user.avatar || '',
  };
}

function decodeBase64UrlJson(value: string) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function isJwtToken(token: string) {
  const parts = token.split('.');
  return parts.length === 3 && parts.every(Boolean);
}

function verifyRymkAuthJwt(token: string): AuthUser | null {
  if (!config.auth.jwtSecret) return null;

  if (!isJwtToken(token)) return null;
  const parts = token.split('.') as [string, string, string];

  try {
    const header = decodeBase64UrlJson(parts[0]);
    if (header.alg !== 'HS256') return null;

    const expected = createHmac('sha256', config.auth.jwtSecret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest();
    const actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const payload = decodeBase64UrlJson(parts[1]) as RymkAuthSessionUser & {
      aud?: string | string[];
      exp?: number;
      nbf?: number;
    };
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp <= now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now) return null;

    // No `aud` enforcement: auth.ry.mk is the sole issuer and every ry.mk
    // client shares the same JWT secret, so the signature + exp + remote
    // revocation check already scope the token. Enforcing `aud` only rejected
    // legitimate no-aud session tokens (cookie `rymk_session`) and tokens
    // minted for sibling clients.

    return authUserFromRymkSession(payload);
  } catch {
    return null;
  }
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

async function persistRymkAuthProfile(user: RymkAuthSessionUser) {
  const authUser = authUserFromRymkSession(user);
  if (!authUser) return;

  await persistAuthProfile({
    id: authUser.id,
    username: user.bangumiUsername || user.username || String(authUser.id),
    ...(authUser.nickname ? { nickname: authUser.nickname } : {}),
    ...(authUser.avatar ? { avatar: { large: authUser.avatar } } : {}),
  });
}

async function issueLocalAuthToken(user: AuthUser) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  await pool.query('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)', [
    token,
    user.id,
    expiresAt,
  ]);

  return token;
}

function readRymkAuthSessionCache(token: string) {
  const cached = rymkAuthSessionCache.get(token);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    rymkAuthSessionCache.delete(token);
    return undefined;
  }
  return cached.user;
}

function writeRymkAuthSessionCache(token: string, user: AuthUser | null) {
  if (rymkAuthSessionCache.size >= RYMK_AUTH_SESSION_MAX_ENTRIES) {
    const oldest = rymkAuthSessionCache.keys().next().value;
    if (oldest !== undefined) rymkAuthSessionCache.delete(oldest);
  }

  rymkAuthSessionCache.set(token, {
    user,
    expiresAt: Date.now() + (user ? RYMK_AUTH_SESSION_POSITIVE_TTL_MS : RYMK_AUTH_SESSION_NEGATIVE_TTL_MS),
  });
}

export function clearRymkAuthSessionCache() {
  rymkAuthSessionCache.clear();
  rymkAuthSessionRequests.clear();
}

async function resolveRymkAuthSession(token: string, localUser: AuthUser): Promise<AuthUser | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.auth.sessionVerifyTimeoutMs);

  let resolved: AuthUser | null = localUser;

  try {
    const response = await fetch(`${config.auth.sessionVerifyUrl}/api/auth/session`, {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': config.bgm.userAgent,
      },
      signal: controller.signal,
    });

    // auth.ry.mk's /api/auth/session always answers 200 and signals the result
    // in the body (`authenticated`). It never returns 401/403 itself — those can
    // only come from Cloudflare/proxy in front of it (e.g. a managed challenge on
    // server-to-server calls). So treat ANY non-2xx as "remote unavailable" and
    // fall open to the locally verified user, rather than misreading a proxy 403
    // as a revoked token. (Mirrors rd-imghost's verifyRemoteSession.)
    if (!response.ok) return resolved;

    const data = await response.json() as {
      authenticated?: boolean;
      user?: RymkAuthSessionUser | null;
    };
    if (!data.authenticated || !data.user) {
      resolved = null;
      return resolved;
    }

    const authUser = authUserFromRymkSession(data.user);
    if (!authUser) {
      resolved = null;
      return resolved;
    }

    await persistRymkAuthProfile(data.user).catch(() => {
      // Profile persistence is best-effort; auth itself should not fail on cache writes.
    });
    resolved = authUser;
    return resolved;
  } catch {
    return resolved;
  } finally {
    clearTimeout(timer);
    writeRymkAuthSessionCache(token, resolved);
  }
}

export async function verifyRymkAuthToken(token: string): Promise<AuthUser | null> {
  if (!token) return null;
  const localUser = verifyRymkAuthJwt(token);
  if (!localUser) return null;

  const cached = readRymkAuthSessionCache(token);
  if (cached !== undefined) return cached;

  const pending = rymkAuthSessionRequests.get(token);
  if (pending) return pending;

  const request = resolveRymkAuthSession(token, localUser);
  rymkAuthSessionRequests.set(token, request);
  try {
    return await request;
  } finally {
    rymkAuthSessionRequests.delete(token);
  }
}

export async function getUserForToken(
  token: string,
  pools: AuthLookupPools = {},
): Promise<AuthUser | null> {
  if (isJwtToken(token)) {
    return (pools.remoteAuthVerifier ?? verifyRymkAuthToken)(token);
  }

  const tokenPool = pools.tokenPool ?? pool;
  const { rows } = await tokenPool.query<{ user_id: number | string }>(
    'SELECT user_id FROM auth_tokens WHERE token = $1 AND expires_at > NOW()',
    [token],
  );
  const row = rows[0];
  if (!row) return (pools.remoteAuthVerifier ?? verifyRymkAuthToken)(token);
  const userId = Number(row.user_id);
  const profile = Number.isFinite(userId) ? await getCachedProfile(userId, pools) : null;
  return authUserFromProfile(userId, profile ?? undefined);
}

export async function tokenLogin(body: unknown, options: TokenLoginOptions = {}) {
  const token = String((body as { token?: string }).token ?? '').trim();
  if (!token) throw new ApiError(400, 'No token provided');
  const user = await getUserForToken(token, options);
  if (user) {
    const localToken = /^[0-9a-f]{64}$/i.test(token)
      ? token
      : await (options.localTokenIssuer ?? issueLocalAuthToken)(user);
    return { status: true, user, token: localToken };
  }

  return { status: false, message: 'Invalid or expired token' };
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

  const tokenResponse = await fetch(`${config.bgm.origin}/oauth/access_token`, {
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
