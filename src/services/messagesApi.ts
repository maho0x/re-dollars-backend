import { pool, searchPool } from '../db/pool.js';
import type { DbMessage, EnrichedMessage, RequestContext } from '../types.js';
import { ApiError, parseIntParam, requireAuth } from '../utils/http.js';
import { enrichMessages } from './messageService.js';
import { resolveUserIdentifier } from './userService.js';
import type { WsHub } from '../ws/hub.js';

const MAX_SYNC_MESSAGES = 200;
const reactionPattern = /^(\(bgm\d+\)|\(bmo\d+\)|\p{Emoji_Presentation}|\p{Emoji}\uFE0F?)$/u;

interface QueryablePool {
  query<Row = unknown>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

type MessageEnricher = (
  messages: DbMessage[],
  options?: { fetchMissingPreviews?: boolean },
) => Promise<EnrichedMessage[]>;

interface ConfirmMessageOptions {
  queryPool?: QueryablePool;
  enrich?: MessageEnricher;
  now?: () => number;
}

async function resolveReactionAvatar(userId: number, localPool: QueryablePool = pool) {
  try {
    const { rows } = await searchPool.query<{ avatar_url?: string | null }>(
      'SELECT avatar_url FROM users WHERE uid = $1 LIMIT 1',
      [userId],
    );
    const avatar = rows[0]?.avatar_url?.trim();
    if (avatar) return avatar;
  } catch {
    // optional profile database
  }

  try {
    const { rows } = await localPool.query<{ avatar_url?: string | null }>(
      `SELECT avatar_url FROM user_profiles WHERE uid = $1 AND COALESCE(avatar_url, '') <> ''
       UNION ALL
       SELECT avatar_url FROM users WHERE uid = $1 AND COALESCE(avatar_url, '') <> ''
       LIMIT 1`,
      [userId],
    );
    const avatar = rows[0]?.avatar_url?.trim();
    return avatar || null;
  } catch {
    return null;
  }
}

export async function listMessages(url: URL) {
  const limit = parseIntParam(url.searchParams.get('limit'), 30, 1, 100);
  const includeIds = url.searchParams.get('include_ids');
  const sinceDbId = url.searchParams.get('since_db_id');
  const beforeId = url.searchParams.get('before_id');
  const sinceBangumiId = url.searchParams.get('since_id');

  let sql = 'SELECT * FROM messages WHERE 1=1';
  const params: unknown[] = [];
  let order: 'ASC' | 'DESC' | 'ASC_TS' = 'DESC';

  if (includeIds) {
    params.push(includeIds.split(',').map((id) => Number(id)).filter((id) => Number.isFinite(id)));
    sql += ` AND id = ANY($${params.length})`;
    order = 'ASC';
  } else if (sinceDbId) {
    params.push(Number(sinceDbId));
    sql += ` AND id > $${params.length}`;
    order = 'ASC';
  } else if (beforeId) {
    params.push(Number(beforeId));
    sql += ` AND id < $${params.length}`;
    order = 'DESC';
  } else if (sinceBangumiId) {
    params.push(Number(sinceBangumiId));
    sql += ` AND bangumi_id > $${params.length}`;
    order = 'ASC_TS';
  }

  params.push(limit);
  const sortSql = order === 'ASC_TS' ? 'ORDER BY "timestamp" ASC, id ASC' : `ORDER BY id ${order}`;
  const { rows } = await pool.query<DbMessage>(`${sql} ${sortSql} LIMIT $${params.length}`, params);
  return enrichMessages(order === 'DESC' ? rows.reverse() : rows);
}

export async function getUnreadCount(url: URL) {
  const sinceId = Number(url.searchParams.get('since_db_id'));
  const uid = Number(url.searchParams.get('uid'));
  if (!Number.isFinite(sinceId) || !Number.isFinite(uid)) {
    throw new ApiError(400, 'since_db_id and uid are required');
  }

  const [count, latest] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM messages WHERE id > $1 AND uid != $2', [sinceId, uid]),
    pool.query('SELECT id FROM messages ORDER BY id DESC LIMIT 1'),
  ]);

  return {
    status: true,
    count: Number(count.rows[0]?.count ?? 0),
    latest_id: Number(latest.rows[0]?.id ?? 0),
  };
}

export async function getMessageContext(messageId: number, url: URL) {
  if (!Number.isFinite(messageId)) throw new ApiError(400, 'Invalid message id');

  const before = parseIntParam(url.searchParams.get('before'), 30, 1, 100);
  const after = parseIntParam(url.searchParams.get('after'), 30, 1, 100);
  const { rows: targetRows } = await pool.query<DbMessage>('SELECT * FROM messages WHERE id = $1', [messageId]);
  const target = targetRows[0];
  if (!target) throw new ApiError(404, 'Message not found');

  const [beforeRows, afterRows] = await Promise.all([
    pool.query<DbMessage>('SELECT * FROM messages WHERE id < $1 ORDER BY id DESC LIMIT $2', [messageId, before]),
    pool.query<DbMessage>('SELECT * FROM messages WHERE id > $1 ORDER BY id ASC LIMIT $2', [messageId, after]),
  ]);

  const messages = await enrichMessages([...beforeRows.rows.reverse(), target, ...afterRows.rows]);

  if (url.searchParams.has('extended')) {
    return {
      messages,
      target_id: messageId,
      target_index: beforeRows.rows.length,
      has_more_before: beforeRows.rows.length >= before,
      has_more_after: afterRows.rows.length >= after,
    };
  }

  return messages;
}

export async function getFirstMessageByDate(url: URL) {
  const date = url.searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, 'Invalid date format');
  }

  const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000) - 8 * 3600;

  if (url.searchParams.has('first_id_only')) {
    const { rows } = await pool.query(
      'SELECT id FROM messages WHERE "timestamp" >= $1 AND "timestamp" < $2 ORDER BY "timestamp" ASC LIMIT 1',
      [start, start + 86400],
    );
    return { status: true, id: rows[0]?.id ?? null };
  }

  const { rows } = await pool.query<DbMessage>(
    'SELECT * FROM messages WHERE "timestamp" >= $1 AND "timestamp" < $2 ORDER BY "timestamp" ASC',
    [start, start + 86400],
  );
  return enrichMessages(rows);
}

export async function searchMessages(url: URL) {
  const rawQuery = (url.searchParams.get('q') ?? '').trim();
  const limit = parseIntParam(url.searchParams.get('limit'), 50, 1, 100);
  const offset = parseIntParam(url.searchParams.get('offset'), 0, 0, 100000);
  if (!rawQuery) return { status: true, results: [], hasMore: false };

  let text = rawQuery;
  let uid: number | null = null;
  const userMatch = rawQuery.match(/(?:user|from|in):(\S+)/);
  if (userMatch?.[1]) {
    text = rawQuery.replace(userMatch[0], '').trim();
    uid = await resolveUserIdentifier(userMatch[1]);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (text) {
    params.push(`%${text}%`);
    conditions.push(`message ILIKE $${params.length}`);
  }
  if (uid !== null) {
    params.push(uid);
    conditions.push(`uid = $${params.length}`);
  }
  if (conditions.length === 0) return { status: true, results: [], hasMore: false };

  params.push(limit + 1, offset);
  const { rows } = await pool.query<DbMessage>(
    `SELECT * FROM messages WHERE ${conditions.join(' AND ')}
     ORDER BY "timestamp" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, -1) : rows;
  return { status: true, results: await enrichMessages(visibleRows), hasMore };
}

export async function toggleReaction(messageId: number, body: unknown, hub: WsHub) {
  if (!Number.isFinite(messageId)) throw new ApiError(400, 'Invalid message id');
  const input = body as { user_id?: number | string; nickname?: string; emoji?: string };
  const userId = Number(input.user_id);
  const nickname = String(input.nickname ?? '').trim();
  const emoji = String(input.emoji ?? '').trim();

  if (!Number.isFinite(userId) || !nickname || !emoji) {
    throw new ApiError(400, 'user_id, nickname and emoji are required');
  }
  if (!reactionPattern.test(emoji)) {
    throw new ApiError(400, 'Invalid emoji format');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      'SELECT id, emoji FROM message_reactions WHERE message_id = $1 AND user_id = $2 ORDER BY id ASC LIMIT 1',
      [messageId, userId],
    );

    const current = existing[0];
    if (current) {
      await client.query('DELETE FROM message_reactions WHERE id = $1', [current.id]);
      hub.broadcast({
        type: 'reaction_remove',
        payload: { message_id: messageId, user_id: userId, nickname, emoji: current.emoji },
      });

      if (current.emoji === emoji) {
        await client.query('COMMIT');
        return { status: true, action: 'removed' };
      }
    }

    const avatar = await resolveReactionAvatar(userId, client);
    const { rows } = await client.query(
      `INSERT INTO message_reactions (message_id, user_id, nickname, avatar, emoji)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING message_id, user_id, nickname, avatar, emoji`,
      [messageId, userId, nickname, avatar, emoji],
    );
    const reaction = rows[0];
    hub.broadcast({ type: 'reaction_add', payload: { message_id: messageId, reaction } });
    await client.query('COMMIT');
    return { status: true, action: current ? 'replaced' : 'added', data: reaction };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteMessage(messageId: number, ctx: RequestContext, hub: WsHub) {
  const user = requireAuth(ctx);
  const { rows } = await pool.query('SELECT uid FROM messages WHERE id = $1', [messageId]);
  if (!rows[0]) throw new ApiError(404, 'Message not found');
  if (String(rows[0].uid) !== String(user.id)) throw new ApiError(403, 'Forbidden');

  await pool.query("UPDATE messages SET is_deleted = TRUE, message = '', edited_at = NOW() WHERE id = $1", [messageId]);
  hub.broadcast({ type: 'message_delete', payload: { id: messageId } });
  return { status: true };
}

export async function editMessage(messageId: number, body: unknown, ctx: RequestContext, hub: WsHub) {
  const user = requireAuth(ctx);
  const content = String((body as { content?: string }).content ?? '').trim();
  if (!content) throw new ApiError(400, 'content is required');

  const { rows } = await pool.query<DbMessage>('SELECT uid, message, is_deleted FROM messages WHERE id = $1', [messageId]);
  const existing = rows[0];
  if (!existing || existing.is_deleted) throw new ApiError(400, 'Message is not editable');
  if (String(existing.uid) !== String(user.id)) throw new ApiError(403, 'Forbidden');

  await pool.query('UPDATE messages SET message = $1, edited_at = NOW(), original_content = $2 WHERE id = $3', [
    content,
    existing.message,
    messageId,
  ]);

  const { rows: updatedRows } = await pool.query<DbMessage>('SELECT * FROM messages WHERE id = $1', [messageId]);
  const [message] = await enrichMessages(updatedRows);
  if (message) hub.broadcast({ type: 'message_edit', payload: message });
  return { status: true };
}

export async function syncMessages(url: URL) {
  const sinceId = Number(url.searchParams.get('since_db_id'));
  const knownIds = url.searchParams.get('known_ids');
  const limit = parseIntParam(url.searchParams.get('limit'), 100, 1, MAX_SYNC_MESSAGES);

  if (Number.isFinite(sinceId)) {
    const [latestResult, rowsResult] = await Promise.all([
      pool.query('SELECT id FROM messages ORDER BY id DESC LIMIT 1'),
      pool.query<DbMessage>('SELECT * FROM messages WHERE id > $1 ORDER BY id ASC LIMIT $2', [sinceId, limit]),
    ]);
    const latestId = Number(latestResult.rows[0]?.id ?? 0);
    const messages = await enrichMessages(rowsResult.rows);
    return {
      status: true,
      messages,
      has_more: rowsResult.rows.length === limit && Number(rowsResult.rows.at(-1)?.id ?? 0) < latestId,
      latest_id: latestId,
      next_cursor: Number(rowsResult.rows.at(-1)?.id ?? sinceId),
    };
  }

  if (knownIds) {
    const ids = knownIds.split(',').map(Number).filter(Number.isFinite);
    if (!ids.length) throw new ApiError(400, 'Invalid known_ids');
    const minId = Math.min(...ids);
    const maxId = Math.max(...ids);
    const known = new Set(ids);
    const { rows: allRows } = await pool.query('SELECT id FROM messages WHERE id >= $1 AND id <= $2 ORDER BY id ASC', [minId, maxId]);
    const missing = allRows.map((row) => Number(row.id)).filter((id) => !known.has(id));
    const idsToFetch = missing.slice(0, limit);
    const messages = idsToFetch.length
      ? await enrichMessages((await pool.query<DbMessage>('SELECT * FROM messages WHERE id = ANY($1) ORDER BY id ASC', [idsToFetch])).rows)
      : [];
    return {
      status: true,
      messages,
      missing_count: missing.length,
      fetched_count: idsToFetch.length,
      has_more: missing.length > limit,
    };
  }

  throw new ApiError(400, 'Missing required parameter: since_db_id or known_ids');
}

export async function getMessageStatus(url: URL) {
  const sinceId = Number(url.searchParams.get('since_db_id'));
  const [latestResult, countResult] = await Promise.all([
    pool.query('SELECT id, "timestamp" FROM messages ORDER BY id DESC LIMIT 1'),
    Number.isFinite(sinceId)
      ? pool.query('SELECT COUNT(*) as count FROM messages WHERE id > $1', [sinceId])
      : Promise.resolve({ rows: [{ count: '0' }] }),
  ]);
  const latest = latestResult.rows[0];
  return {
    status: true,
    latest_id: latest?.id ?? 0,
    latest_timestamp: latest?.timestamp ?? 0,
    new_count: Number(countResult.rows[0]?.count ?? 0),
    server_time: Math.floor(Date.now() / 1000),
  };
}

export async function confirmMessage(body: unknown, options: ConfirmMessageOptions = {}) {
  const input = body as { uid?: number | string; message?: string };
  const uid = Number(input.uid);
  const message = String(input.message ?? '').trim();
  if (!Number.isFinite(uid) || !message) throw new ApiError(400, 'uid and message are required');

  const queryPool = options.queryPool ?? pool;
  const enrich = options.enrich ?? enrichMessages;
  const cutoff = Math.floor((options.now ?? Date.now)() / 1000) - 20;
  const { rows } = await queryPool.query<DbMessage>(
    `SELECT * FROM messages WHERE uid = $1 AND "timestamp" > $2 ORDER BY "timestamp" DESC LIMIT 20`,
    [uid, cutoff],
  );
  const normalized = message.replace(/\s+/g, ' ').trim();
  const found = rows.find((row) => (row.message ?? '').replace(/\s+/g, ' ').trim() === normalized);
  const [enriched] = found ? await enrich([found], { fetchMissingPreviews: false }) : [];
  return { status: true, found: Boolean(found), message: enriched ?? found ?? null };
}

export async function getLatestMessageId() {
  const { rows } = await pool.query('SELECT id FROM messages ORDER BY id DESC LIMIT 1');
  return Number(rows[0]?.id ?? 0);
}

export async function getMessagesAfter(id: number, limit: number): Promise<EnrichedMessage[]> {
  const { rows } = await pool.query<DbMessage>('SELECT * FROM messages WHERE id > $1 ORDER BY id ASC LIMIT $2', [id, limit]);
  return enrichMessages(rows);
}
