import { readFileSync, writeFileSync } from 'node:fs';
import { config } from '../config/env.js';
import { pool, searchPool } from '../db/pool.js';
import type { DbMessage } from '../types.js';
import { ApiError, parseIntParam } from '../utils/http.js';
import type { WsHub } from '../ws/hub.js';
import { getUser, resolveUserIdentifier } from './userService.js';

interface BotMessageRow extends DbMessage {
  reply_uid?: number | string | null;
  reply_nickname?: string | null;
  reply_message?: string | null;
  reply_avatar?: string | null;
}

interface BotStreamPayload {
  type?: unknown;
  kind?: unknown;
  payload?: unknown;
  messages?: unknown;
  id?: unknown;
  user?: unknown;
  uid?: unknown;
}

const botReactionPattern = /^(\(bgm\d+\)|\(bmo(C|_)[a-zA-Z0-9_-]+\))$/;
const validBgmRanges = [
  [1, 125],
  [200, 238],
  [500, 529],
] as const;

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertInt(value: unknown, name: string) {
  const parsed = numberValue(value);
  if (parsed === null || !Number.isInteger(parsed)) throw new ApiError(400, `${name} is required`);
  return parsed;
}

function parseBodyObject(body: unknown) {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'JSON object body required');
  return body as Record<string, unknown>;
}

function isValidBotReaction(emoji: string) {
  const bgmMatch = emoji.match(/^\(bgm(\d+)\)$/);
  if (bgmMatch?.[1]) {
    const id = Number(bgmMatch[1]);
    return validBgmRanges.some(([min, max]) => id >= min && id <= max);
  }
  return botReactionPattern.test(emoji);
}

function extractFirstImageUrl(message: string) {
  const match = /\[img\](https?:\/\/[^\]]+?)\[\/img\]/i.exec(message);
  return match?.[1]?.split('?')[0];
}

function stripBBCodeForBotPrompt(text: string) {
  if (!text) return '';
  return text
    .replace(/\[quote[^\]]*\][\s\S]*?\[\/quote\]/gi, ' ')
    .replace(/\[img\](https?:\/\/[^\]]+?)\[\/img\]/gi, (_match, url: string) => `[图片: ${url}]`)
    .replace(/\[sticker[^\]]*\][\s\S]*?\[\/sticker\]/gi, ' ')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[user=[^\]]*\]([\s\S]*?)\[\/user\]/gi, '@$1')
    .replace(/\[(b|i|u|s|code|color|size|font|center|right|left)[^\]]*\]([\s\S]*?)\[\/\1\]/gi, '$2')
    .replace(/\[\/?[a-z_?]+(?:=[^\]]+)?\]/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attachBotReplyDetails(rows: BotMessageRow[]) {
  return rows.map((row) => {
    const {
      reply_uid: replyUid,
      reply_nickname: replyNickname,
      reply_message: replyMessage,
      reply_avatar: replyAvatar,
      ...message
    } = row;

    if (message.reply_to_id == null || replyUid == null) {
      return { ...message, reply_details: null };
    }

    const firstImage = extractFirstImageUrl(replyMessage ?? '');
    return {
      ...message,
      reply_details: {
        uid: Number(replyUid),
        nickname: replyNickname ?? `uid:${replyUid}`,
        content: stripBBCodeForBotPrompt(replyMessage ?? '').slice(0, 300).trim(),
        avatar: replyAvatar ?? '',
        ...(firstImage ? { firstImage } : {}),
      },
    };
  });
}

function readMemoryParts() {
  try {
    const raw = readFileSync(config.bot.memoryFile, 'utf-8');
    const match = raw.match(/^(---[\s\S]*?---\n)([\s\S]*)$/);
    if (match?.[1] != null && match[2] != null) {
      return { header: match[1], body: match[2] };
    }
    return { header: '', body: raw };
  } catch {
    return { header: '', body: '' };
  }
}

function writeMemory(header: string, body: string) {
  const normalized = body.trim();
  writeFileSync(config.bot.memoryFile, `${header}${normalized ? `${normalized}\n` : ''}`, 'utf-8');
}

function userFromPayload(payload: BotStreamPayload) {
  if (payload.user && typeof payload.user === 'object') {
    return payload.user as Record<string, unknown>;
  }
  return {};
}

export function normalizeBotStreamEvent(payload: unknown) {
  let data = payload as BotStreamPayload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload) as BotStreamPayload;
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;

  const type = data.type ?? data.kind;
  if (type === 'new_messages') {
    const messages = Array.isArray(data.messages)
      ? data.messages
      : Array.isArray(data.payload)
        ? data.payload
        : null;
    return messages ? { kind: 'new_messages', messages } : null;
  }

  if (type === 'message_delete' || type === 'message_deleted') {
    const nested = data.payload && typeof data.payload === 'object'
      ? data.payload as Record<string, unknown>
      : {};
    const id = numberValue(nested.id ?? data.id);
    return id === null ? null : { kind: 'message_deleted', id };
  }

  if (type === 'message_edit' || type === 'message_updated') {
    const payload = data.payload;
    if (Array.isArray(payload)) return { kind: 'messages_updated', messages: payload };
    if (payload && typeof payload === 'object') return { kind: 'message_updated', message: payload };
    const message = (data as Record<string, unknown>).message;
    if (message && typeof message === 'object') return { kind: 'message_updated', message };
    return null;
  }

  if (type === 'typing_start' || type === 'typing_stop') {
    const user = userFromPayload(data);
    const uid = numberValue(user.id ?? user.uid ?? data.uid);
    return uid === null ? null : { kind: type, uid };
  }

  return null;
}

export function botHealth() {
  return { ok: true, ts: Date.now() };
}

export async function getBotMaxMessageId() {
  const { rows } = await pool.query<{ max_id: number | string | null }>('SELECT MAX(id) as max_id FROM messages');
  return { maxId: Number(rows[0]?.max_id ?? 0) };
}

export async function getBotMessagesSince(url: URL) {
  const afterId = assertInt(url.searchParams.get('afterId') ?? url.searchParams.get('after_id'), 'afterId');
  const limit = parseIntParam(url.searchParams.get('limit'), 200, 1, 500);
  const { rows } = await pool.query<BotMessageRow>(
    `SELECT m.*, r.uid AS reply_uid, r.nickname AS reply_nickname,
            r.message AS reply_message, r.avatar AS reply_avatar
     FROM messages m
     LEFT JOIN messages r ON r.id = m.reply_to_id
     WHERE m.id > $1
     ORDER BY m.id ASC
     LIMIT $2`,
    [afterId, limit],
  );
  return { messages: attachBotReplyDetails(rows) };
}

export async function getBotMessagesBefore(url: URL) {
  const beforeId = assertInt(url.searchParams.get('beforeId') ?? url.searchParams.get('before_id'), 'beforeId');
  const limit = parseIntParam(url.searchParams.get('limit'), 200, 1, 200);
  const { rows } = await pool.query<BotMessageRow>(
    `SELECT m.*, r.uid AS reply_uid, r.nickname AS reply_nickname,
            r.message AS reply_message, r.avatar AS reply_avatar
     FROM messages m
     LEFT JOIN messages r ON r.id = m.reply_to_id
     WHERE m.id < $1
     ORDER BY m.id DESC
     LIMIT $2`,
    [beforeId, limit],
  );
  return { messages: attachBotReplyDetails(rows).reverse() };
}

export async function getBotMessageContext(messageId: number, url: URL) {
  const before = parseIntParam(url.searchParams.get('before'), 5, 1, 50);
  const after = parseIntParam(url.searchParams.get('after'), 5, 1, 50);
  const [beforeRows, afterRows] = await Promise.all([
    pool.query<BotMessageRow>(
      `SELECT m.*, r.uid AS reply_uid, r.nickname AS reply_nickname,
              r.message AS reply_message, r.avatar AS reply_avatar
       FROM messages m
       LEFT JOIN messages r ON r.id = m.reply_to_id
       WHERE m.id <= $1
       ORDER BY m.id DESC
       LIMIT $2`,
      [messageId, before],
    ),
    pool.query<BotMessageRow>(
      `SELECT m.*, r.uid AS reply_uid, r.nickname AS reply_nickname,
              r.message AS reply_message, r.avatar AS reply_avatar
       FROM messages m
       LEFT JOIN messages r ON r.id = m.reply_to_id
       WHERE m.id > $1
       ORDER BY m.id ASC
       LIMIT $2`,
      [messageId, after],
    ),
  ]);
  return { messages: attachBotReplyDetails([...beforeRows.rows.reverse(), ...afterRows.rows]) };
}

export async function searchBotMessages(url: URL) {
  const keyword = url.searchParams.get('keyword') ?? url.searchParams.get('q') ?? undefined;
  const limit = parseIntParam(url.searchParams.get('limit'), 20, 1, 50);
  const beforeId = numberValue(url.searchParams.get('beforeId') ?? url.searchParams.get('before_id'));
  const afterId = numberValue(url.searchParams.get('afterId') ?? url.searchParams.get('after_id'));
  const fromUser = url.searchParams.get('fromUser') ?? url.searchParams.get('from_user');
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (keyword) {
    params.push(`%${keyword}%`);
    conditions.push(`message ILIKE $${params.length}`);
  }

  if (fromUser) {
    const resolvedUid = await resolveUserIdentifier(fromUser.trim());
    if (resolvedUid !== null) {
      params.push(resolvedUid);
      conditions.push(`uid = $${params.length}`);
    }
  }

  if (beforeId !== null) {
    params.push(beforeId);
    conditions.push(`id < $${params.length}`);
  }
  if (afterId !== null) {
    params.push(afterId);
    conditions.push(`id > $${params.length}`);
  }

  if (!conditions.length) {
    return { messages: [], error: 'keyword or fromUser is required' };
  }

  params.push(limit);
  const { rows } = await pool.query<{ id: number; nickname: string; message: string; timestamp: number }>(
    `SELECT id, nickname, message, timestamp
     FROM messages
     WHERE ${conditions.join(' AND ')}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params,
  );
  return { messages: rows.reverse() };
}

export async function checkQuoteAuthor(body: unknown) {
  const input = parseBodyObject(body);
  const quoteIds = Array.isArray(input.quoteIds) ? input.quoteIds.map(Number).filter(Number.isInteger) : [];
  const botUserId = assertInt(input.botUserId, 'botUserId');
  if (quoteIds.length === 0) return { isBot: false };

  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM messages WHERE id = ANY($1) AND uid = $2',
    [quoteIds, botUserId],
  );
  return { isBot: Number(rows[0]?.count ?? 0) > 0 };
}

export async function addReactionAsBot(body: unknown, hub: WsHub) {
  if (!config.bot.userId) return { success: false, error: 'Bot user not configured' };
  const input = parseBodyObject(body);
  const messageId = assertInt(input.messageId ?? input.message_id, 'messageId');
  const emoji = String(input.emoji ?? '').trim();
  if (!emoji || !isValidBotReaction(emoji)) return { success: false, error: 'Invalid emoji format' };

  const userId = config.bot.userId;
  const nickname = config.bot.nickname || 'Bot';
  let avatar: string | null = null;
  try {
    const user = await getUser(String(userId));
    avatar = user?.data.avatar.large ?? user?.data.avatar.medium ?? null;
  } catch {
    avatar = null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query<{ id: number; emoji: string }>(
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
        return { success: true, action: 'removed' };
      }
    }

    const { rows } = await client.query(
      `INSERT INTO message_reactions (message_id, user_id, nickname, avatar, emoji)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING message_id, user_id, nickname, avatar, emoji`,
      [messageId, userId, nickname, avatar, emoji],
    );
    const reaction = rows[0];
    hub.broadcast({ type: 'reaction_add', payload: { message_id: messageId, reaction } });
    await client.query('COMMIT');
    return { success: true, action: current ? 'replaced' : 'added' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.release();
  }
}

export function getGlobalMemory() {
  const body = readMemoryParts().body.trim();
  return { memory_text: body.length > 0 ? body : null };
}

export function setGlobalMemory(body: unknown) {
  const input = parseBodyObject(body);
  const text = String(input.text ?? '');
  const { header } = readMemoryParts();
  writeMemory(header, text);
  return { success: true, message: 'Global memory updated' };
}

export async function getUserMemory(userId: number) {
  try {
    const { rows } = await pool.query<{ memory_text: string | null }>(
      'SELECT memory_text FROM user_memories WHERE user_id = $1',
      [userId],
    );
    return { memory_text: rows.length > 0 ? rows[0]?.memory_text ?? null : null };
  } catch (err) {
    return { memory_text: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setUserMemory(userId: number, body: unknown) {
  const input = parseBodyObject(body);
  const text = String(input.text ?? '');
  try {
    await pool.query(
      `INSERT INTO user_memories (user_id, memory_text, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET memory_text = $2, updated_at = NOW()`,
      [userId, text],
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function resolveBotUser(uid: number) {
  try {
    const { rows } = await searchPool.query<{ username: string | null }>(
      'SELECT username FROM users WHERE uid = $1 LIMIT 1',
      [uid],
    );
    if (rows[0]) return { username: rows[0].username ?? null };
  } catch {
    // optional search DB
  }

  const { rows } = await pool.query<{ username: string | null }>(
    `SELECT username FROM user_profiles WHERE uid = $1
     UNION
     SELECT username FROM user_lookup_cache WHERE user_id = $1
     LIMIT 1`,
    [uid],
  );
  return { username: rows[0]?.username ?? null };
}

export async function resolveBotUsers(body: unknown) {
  const input = parseBodyObject(body);
  const uids = Array.isArray(input.uids) ? input.uids.map(Number).filter(Number.isInteger).slice(0, 500) : [];
  if (uids.length === 0) return { users: [] };

  const byUid = new Map<number, { uid: number; username: string }>();
  await Promise.allSettled([
    searchPool.query<{ uid: number; username: string }>('SELECT uid, username FROM users WHERE uid = ANY($1)', [uids])
      .then(({ rows }) => {
        for (const row of rows) if (row.username) byUid.set(Number(row.uid), { uid: Number(row.uid), username: row.username });
      }),
    pool.query<{ uid: number; username: string }>(
      `SELECT uid, username FROM user_profiles WHERE uid = ANY($1)
       UNION
       SELECT user_id AS uid, username FROM user_lookup_cache WHERE user_id = ANY($1)`,
      [uids],
    ).then(({ rows }) => {
      for (const row of rows) if (row.username && !byUid.has(Number(row.uid))) byUid.set(Number(row.uid), { uid: Number(row.uid), username: row.username });
    }),
  ]);

  return { users: [...byUid.values()] };
}

export async function lookupBotUser(url: URL) {
  const uid = numberValue(url.searchParams.get('uid'));
  const username = url.searchParams.get('username') ?? undefined;
  if (uid === null && !username) return { error: 'username or uid is required' };

  const user = await getUser(uid !== null ? String(uid) : username ?? '');
  if (!user) return { error: 'User not found' };
  return {
    uid: user.data.id,
    username: user.data.username,
    nickname: user.data.nickname,
    avatar_url: user.data.avatar.large,
    sign: user.data.sign,
  };
}

export async function getRepliedPosts() {
  const { rows } = await pool.query<{ post_id: number | string }>(
    `SELECT post_id FROM bot_replied_posts WHERE replied_at > NOW() - INTERVAL '60 days'`,
  );
  return { postIds: rows.map((row) => Number(row.post_id)) };
}

export async function saveRepliedPost(body: unknown) {
  const input = parseBodyObject(body);
  const postId = assertInt(input.postId ?? input.post_id, 'postId');
  const topicId = assertInt(input.topicId ?? input.topic_id, 'topicId');
  await pool.query(
    `INSERT INTO bot_replied_posts (post_id, topic_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [postId, topicId],
  );
  return { success: true };
}

export function setBotPresence(body: unknown, hub: WsHub, active: boolean) {
  const input = parseBodyObject(body);
  const uid = assertInt(input.uid, 'uid');
  const ttlMs = input.ttlMs == null ? undefined : assertInt(input.ttlMs, 'ttlMs');
  const displayName =
    typeof input.name === 'string' && input.name
      ? input.name
      : typeof input.nickname === 'string' && input.nickname
        ? input.nickname
        : config.bot.nickname;
  if (ttlMs != null && (ttlMs < 1000 || ttlMs > 60 * 60 * 1000)) {
    throw new ApiError(400, 'ttlMs must be between 1000 and 3600000');
  }
  return hub.setSyntheticPresence({
    uid,
    active,
    name: displayName,
    nickname: displayName,
    ...(typeof input.avatar === 'string' && input.avatar ? { avatar: input.avatar } : {}),
    ...(ttlMs != null ? { ttlMs } : {}),
  });
}

export function setBotTyping(body: unknown, hub: WsHub, typing: boolean) {
  const input = parseBodyObject(body);
  const uid = assertInt(input.uid, 'uid');
  const displayName =
    typeof input.name === 'string' && input.name
      ? input.name
      : typeof input.nickname === 'string' && input.nickname
        ? input.nickname
        : config.bot.nickname;
  return hub.emitSyntheticTyping({
    uid,
    typing,
    name: displayName,
    nickname: displayName,
    ...(typeof input.avatar === 'string' && input.avatar ? { avatar: input.avatar } : {}),
  });
}

export function createBotEventStream(request: Request, hub: WsHub) {
  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  let closed = false;

  const write = (chunk: string) => {
    if (closed) return;
    writer.write(encoder.encode(chunk)).catch(() => cleanup());
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    writer.close().catch(() => undefined);
  };
  const sendEvent = (payload: unknown) => {
    const event = normalizeBotStreamEvent(payload);
    if (!event) return;
    write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = hub.subscribeEvents(sendEvent);
  const heartbeat = setInterval(() => write(': ping\n\n'), 5_000);
  request.signal.addEventListener('abort', cleanup, { once: true });
  write('event: ready\ndata: {"ok":true}\n\n');

  return new Response(stream.readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}
