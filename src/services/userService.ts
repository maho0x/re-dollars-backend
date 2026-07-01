import { pool, searchPool } from '../db/pool.js';
import { fetchBangumiApi } from '../utils/bangumi.js';
import { searchSyncService, type SearchUserProfile } from './searchSyncService.js';

interface QueryResult<Row> {
  rows: Row[];
}

interface QueryPool {
  query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

interface ProfileRow {
  uid: number;
  username: string | null;
  nickname: string | null;
  avatar_url: string | null;
  sign?: string | null;
  updated_at?: string | Date | null;
}

interface UserProfile {
  id: number;
  username: string;
  nickname: string;
  avatar: {
    large: string;
    medium: string;
    small: string;
  };
  sign: string;
}

export interface UserSearchResult {
  id: number;
  uid: number;
  username: string;
  nickname: string;
  avatar_url: string;
  sign?: string;
}

function normalizeProfile(row: ProfileRow) {
  const username = row.username ?? String(row.uid);
  const avatarUrl = row.avatar_url ?? '';
  return {
    id: Number(row.uid),
    username,
    nickname: row.nickname ?? username,
    avatar: {
      large: avatarUrl,
      medium: avatarUrl,
      small: avatarUrl,
    },
    sign: row.sign ?? '',
  };
}

function normalizeSearchProfile(row: SearchUserProfile): UserProfile {
  return {
    id: Number(row.uid),
    username: row.username ?? String(row.uid),
    nickname: row.nickname ?? row.username ?? String(row.uid),
    avatar: {
      large: row.avatar_url ?? '',
      medium: row.avatar_url ?? '',
      small: row.avatar_url ?? '',
    },
    sign: row.sign ?? '',
  };
}

function parseStats(row: { cnt?: string; f?: number | string | null; l?: number | string | null }) {
  const count = Number(row.cnt ?? 0);
  if (!count || row.f == null || row.l == null) {
    return { message_count: 0, average_messages_per_day: 0, first_message_time: null, last_message_time: null };
  }
  const first = Number(row.f);
  const last = Number(row.l);
  const days = Math.max(1, Math.floor((last - first) / 86400) + 1);
  return {
    message_count: count,
    average_messages_per_day: Number((count / days).toFixed(2)),
    first_message_time: new Date(first * 1000).toISOString(),
    last_message_time: new Date(last * 1000).toISOString(),
  };
}

function parseSearchLimit(value: string | null) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed)) return 10;
  return Math.min(Math.max(parsed, 1), 50);
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function normalizeSearchResult(row: ProfileRow): UserSearchResult {
  const uid = Number(row.uid);
  const username = row.username ?? String(uid);
  return {
    id: uid,
    uid,
    username,
    nickname: row.nickname ?? username,
    avatar_url: row.avatar_url ?? '',
    ...(row.sign ? { sign: row.sign } : {}),
  };
}

async function queryUserSearchTable(
  queryPool: QueryPool,
  table: 'users' | 'user_profiles',
  query: string,
  limit: number,
) {
  const escaped = escapeLikePattern(query);
  const containsPattern = `%${escaped}%`;
  const prefixPattern = `${escaped}%`;
  const parsedUid = /^\d+$/.test(query) ? Number(query) : null;
  const numericUid = parsedUid !== null && Number.isSafeInteger(parsedUid) && parsedUid <= 2147483647
    ? parsedUid
    : null;

  const { rows } = await queryPool.query<ProfileRow>(
    `SELECT uid, username, nickname, avatar_url, sign
     FROM ${table}
     WHERE username ILIKE $1 ESCAPE '\\'
       OR nickname ILIKE $1 ESCAPE '\\'
       OR ($4::int IS NOT NULL AND uid = $4::int)
     ORDER BY
       CASE
         WHEN $4::int IS NOT NULL AND uid = $4::int THEN 0
         WHEN lower(username) = lower($2) THEN 1
         WHEN lower(nickname) = lower($2) THEN 2
         WHEN username ILIKE $3 ESCAPE '\\' THEN 3
         WHEN nickname ILIKE $3 ESCAPE '\\' THEN 4
         ELSE 5
       END,
       updated_at DESC NULLS LAST,
       uid DESC
     LIMIT $5`,
    [containsPattern, query, prefixPattern, numericUid, limit],
  );

  return rows.map(normalizeSearchResult);
}

export async function searchUsers(
  url: URL,
  pools: { searchPool?: QueryPool; profilePool?: QueryPool } = {},
) {
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
  if (!query) return { status: true, data: [] };

  const limit = parseSearchLimit(url.searchParams.get('limit'));
  const results: UserSearchResult[] = [];
  const seen = new Set<number>();

  const append = (rows: UserSearchResult[]) => {
    for (const row of rows) {
      if (seen.has(row.uid)) continue;
      seen.add(row.uid);
      results.push(row);
      if (results.length >= limit) break;
    }
  };

  try {
    append(await queryUserSearchTable(pools.searchPool ?? searchPool, 'users', query, limit));
  } catch {
    // The search profile database is optional during migration.
  }

  if (results.length < limit) {
    try {
      append(await queryUserSearchTable(pools.profilePool ?? pool, 'user_profiles', query, limit - results.length));
    } catch {
      // The local profile cache may not exist in partially migrated databases.
    }
  }

  return { status: true, data: results };
}

async function getLocalProfile(
  identifier: string,
  isUid: boolean,
): Promise<{ profile: UserProfile; updatedAt: ProfileRow['updated_at'] } | null> {
  const query = isUid
    ? 'SELECT uid, username, nickname, avatar_url, sign, updated_at FROM users WHERE uid = $1'
    : 'SELECT uid, username, nickname, avatar_url, sign, updated_at FROM users WHERE username = $1';

  try {
    const { rows } = await searchPool.query<ProfileRow>(query, [isUid ? Number(identifier) : identifier]);
    if (rows[0]) return { profile: normalizeProfile(rows[0]), updatedAt: rows[0].updated_at };
  } catch {
    // optional search DB
  }

  const fallback = isUid
    ? 'SELECT uid, username, nickname, avatar_url, sign, updated_at FROM user_profiles WHERE uid = $1'
    : 'SELECT uid, username, nickname, avatar_url, sign, updated_at FROM user_profiles WHERE username = $1';
  try {
    const { rows } = await pool.query<ProfileRow>(fallback, [isUid ? Number(identifier) : identifier]);
    if (rows[0]) return { profile: normalizeProfile(rows[0]), updatedAt: rows[0].updated_at };
  } catch {
    // optional local table
  }

  return null;
}

async function persistProfile(user: { id: number; username?: string; nickname?: string; avatar?: { large?: string }; sign?: string }) {
  const params = [user.id, user.username ?? '', user.nickname ?? '', user.avatar?.large ?? '', user.sign ?? ''];
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

// Local user profiles (incl. sign) are a cache; refresh from Bangumi once stale.
const PROFILE_FRESH_TTL_MS = 24 * 60 * 60 * 1000;

function isStale(updatedAt: ProfileRow['updated_at']): boolean {
  if (!updatedAt) return true;
  const ts = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(String(updatedAt));
  return Number.isNaN(ts) || Date.now() - ts > PROFILE_FRESH_TTL_MS;
}

async function fetchProfileFromBangumi(identifier: string): Promise<UserProfile | null> {
  const apiPath = identifier === '0' || identifier === 'bangumi' ? '/users/bangumi' : `/users/${encodeURIComponent(identifier)}`;
  const response = await fetchBangumiApi(apiPath);
  if (!response.ok) return null;
  const remote = await response.json() as {
    id: number;
    username?: string;
    nickname?: string;
    avatar?: { large?: string; medium?: string; small?: string };
    sign?: string;
  };
  const user: UserProfile = {
    id: remote.id,
    username: remote.username ?? String(remote.id),
    nickname: remote.nickname ?? remote.username ?? String(remote.id),
    avatar: {
      large: remote.avatar?.large ?? remote.avatar?.medium ?? remote.avatar?.small ?? '',
      medium: remote.avatar?.medium ?? remote.avatar?.large ?? remote.avatar?.small ?? '',
      small: remote.avatar?.small ?? remote.avatar?.medium ?? remote.avatar?.large ?? '',
    },
    sign: remote.sign ?? '',
  };
  await persistProfile(user).catch(() => undefined);
  return user;
}

export async function getUser(identifier: string) {
  const isUid = identifier === '0' || /^\d+$/.test(identifier);
  const local = await getLocalProfile(identifier === 'bangumi' ? '0' : identifier, isUid || identifier === 'bangumi');
  let user: UserProfile | null = local?.profile ?? null;
  let source: 'local' | 'remote-search' | 'bangumi' = local ? 'local' : 'bangumi';

  // Cached profile (incl. sign) past its TTL: refresh from Bangumi, but keep
  // the stale copy if the refresh fails.
  if (local && isStale(local.updatedAt)) {
    const fresh = await fetchProfileFromBangumi(identifier === 'bangumi' ? '0' : identifier).catch(() => null);
    if (fresh) {
      user = fresh;
      source = 'bangumi';
    }
  }

  if (!user) {
    const remoteProfile = isUid || identifier === 'bangumi'
      ? await searchSyncService.getRemoteUserProfile(identifier === 'bangumi' ? 0 : Number(identifier))
      : await searchSyncService.getRemoteUserProfileByUsername(identifier);
    if (remoteProfile) {
      user = normalizeSearchProfile(remoteProfile);
      source = 'remote-search';
    }
  }

  if (!user) {
    user = await fetchProfileFromBangumi(identifier);
    if (user) source = 'bangumi';
  }

  if (!user) return null;

  const { rows } = await pool.query(
    'SELECT COUNT(*) as cnt, MIN("timestamp") as f, MAX("timestamp") as l FROM messages WHERE uid = $1',
    [user.id],
  );

  return {
    source,
    data: {
      ...user,
      url: `/user/${user.username || user.id}`,
      stats: parseStats(rows[0] ?? {}),
    },
  };
}

export async function resolveUserIdentifier(identifier: string): Promise<number | null> {
  if (['0', 'bangumi', 'Bangumi娘'].includes(identifier)) return 0;
  if (/^\d+$/.test(identifier)) return Number(identifier);

  try {
    const { rows } = await pool.query('SELECT user_id FROM user_lookup_cache WHERE username = $1', [identifier]);
    if (rows[0]) return Number(rows[0].user_id);
  } catch {
    // optional cache
  }

  const result = await getUser(identifier);
  return result?.data?.id ?? null;
}

export async function lookupByNames(usernames: string[]) {
  const names = [...new Set(usernames.map((name) => String(name).trim()).filter(Boolean))];
  if (!names.length) return {};

  const result: Record<string, { id: number; nickname: string } | null> = {};
  const { rows } = await pool.query('SELECT user_id, username, nickname FROM user_lookup_cache WHERE username = ANY($1)', [names]);
  for (const row of rows) {
    result[row.username] = { id: Number(row.user_id), nickname: row.nickname };
  }

  const missing = names.filter((name) => !(name in result));
  await Promise.all(missing.map(async (name) => {
    const user = await getUser(name);
    if (!user) {
      result[name] = null;
      return;
    }
    result[name] = { id: user.data.id, nickname: user.data.nickname };
    await pool.query(
      `INSERT INTO user_lookup_cache (username, user_id, nickname)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET user_id = EXCLUDED.user_id, nickname = EXCLUDED.nickname`,
      [user.data.username || name, user.data.id, user.data.nickname],
    ).catch(() => undefined);
  }));

  return result;
}

export async function mapUidToUsername(uid: number) {
  const { rows } = await pool.query('SELECT username, nickname FROM user_lookup_cache WHERE user_id = $1', [uid]);
  if (rows[0]) return { source: 'cache', uid, username: rows[0].username, nickname: rows[0].nickname };

  const user = await getUser(String(uid));
  if (!user) return null;
  return { source: 'profile', uid, username: user.data.username, nickname: user.data.nickname };
}
