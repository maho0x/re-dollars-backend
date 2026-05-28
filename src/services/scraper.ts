import type { PoolClient } from 'pg';
import { config } from '../config/env.js';
import { pool, searchPool } from '../db/pool.js';
import type { DbMessage, EnrichedMessage } from '../types.js';
import { generateUserColor } from '../utils/color.js';
import { enrichMessages } from './messageService.js';
import { persistLskyImageMetadataForMessages } from './lskyImageMetadataService.js';
import type { WsHub } from '../ws/hub.js';

interface ScraperCursor {
  lastTs: number;
  lastIdAtTs: bigint;
  tick: number;
}

export interface ScrapedDollarsMessage {
  bangumi_id: string;
  uid: number;
  nickname: string;
  avatar: string;
  timestamp: number;
  message: string;
  type: string;
  color: string;
}

interface InsertResult {
  insertedBangumiIds: string[];
  insertedLocalIds: number[];
}

interface NotificationInsert {
  id: number;
  userId: string;
  payload: {
    id: number;
    message_id: number;
    uid: number;
    nickname: string;
    avatar: string;
    content: string;
    timestamp: number;
    type: 'mention' | 'reply';
  };
}

const cursor: ScraperCursor = {
  lastTs: Math.floor(Date.now() / 1000) - 3600,
  lastIdAtTs: 0n,
  tick: 0,
};

function decodeHtmlEntities(input: string) {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[entity] ?? match;
  });
}

export function parseDollarsPayload(raw: unknown[], nowTs = Math.floor(Date.now() / 1000)): ScrapedDollarsMessage[] {
  const scanLimit = nowTs + 12;

  return raw
    .map((item) => {
      const row = item as Record<string, unknown>;
      const bangumiId = String(row.id ?? '').replace(/[^0-9]/g, '');
      const uid = Number.parseInt(String(row.uid ?? ''), 10);
      let timestamp = Number(row.timestamp);
      const message = decodeHtmlEntities(String(row.msg ?? ''));

      if (!bangumiId || !Number.isFinite(uid) || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > scanLimit) {
        return null;
      }

      if (uid === 0 && timestamp > nowTs) {
        timestamp = nowTs;
      }

      return {
        bangumi_id: bangumiId,
        uid,
        nickname: String(row.nickname ?? ''),
        avatar: String(row.avatar ?? ''),
        timestamp,
        message,
        type: String(row.type ?? 'text'),
        color: generateUserColor(uid),
      };
    })
    .filter((message): message is ScrapedDollarsMessage => message !== null)
    .sort(compareByTimestampAndBangumiId);
}

function compareByTimestampAndBangumiId(a: ScrapedDollarsMessage, b: ScrapedDollarsMessage) {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.uid === 0 && b.uid !== 0) return 1;
  if (a.uid !== 0 && b.uid === 0) return -1;
  const idA = BigInt(a.bangumi_id);
  const idB = BigInt(b.bangumi_id);
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function isFresh(message: ScrapedDollarsMessage) {
  if (message.timestamp > cursor.lastTs) return true;
  if (message.timestamp < cursor.lastTs) return false;
  return BigInt(message.bangumi_id) > cursor.lastIdAtTs;
}

function scraperHeaders() {
  const headers = new Headers({
    accept: 'application/json, text/plain, */*',
    referer: `${config.bgm.origin}${config.bgm.dollarsPath}`,
    'user-agent': config.bgm.userAgent,
  });

  try {
    const cookies = JSON.parse(config.bgm.cookieJson) as Array<{ name?: string; value?: string }>;
    const cookie = cookies
      .filter((entry) => entry.name && entry.value)
      .map((entry) => `${entry.name}=${entry.value}`)
      .join('; ');
    if (cookie) headers.set('cookie', cookie);
  } catch {
    // Ignore invalid optional cookie config.
  }

  return headers;
}

async function fetchWithRetry(url: string, retries = 4): Promise<Response> {
  try {
    const signal = AbortSignal.timeout(Math.floor(5000 * Math.pow(2, 4 - retries + 1)));
    const response = await fetch(url, { headers: scraperHeaders(), signal });
    if (!response.ok && response.status >= 500) throw new Error(`Bangumi returned ${response.status}`);
    return response;
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 400));
    return fetchWithRetry(url, retries - 1);
  }
}

async function loadCursor() {
  try {
    const { rows } = await pool.query<{ key: string; value: string }>('SELECT key, value FROM scraper_state WHERE key = ANY($1)', [
      ['last_ts', 'last_id_at_ts'],
    ]);
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const lastTs = Number.parseInt(values.get('last_ts') ?? '', 10);
    if (lastTs > 0) cursor.lastTs = lastTs;

    const lastIdAtTs = values.get('last_id_at_ts');
    if (lastIdAtTs) cursor.lastIdAtTs = BigInt(lastIdAtTs);
  } catch (err) {
    console.warn('[scraper] failed to load cursor:', err instanceof Error ? err.message : err);
  }
}

async function saveCursor() {
  await pool.query(
    `INSERT INTO scraper_state (key, value, updated_at)
     VALUES ('last_ts', $1, NOW()), ('last_id_at_ts', $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(cursor.lastTs), String(cursor.lastIdAtTs)],
  );
}

async function getBlockedUsers(client: PoolClient) {
  const { rows } = await client.query<{ user_id: number }>('SELECT user_id FROM global_blocklist').catch(() => ({ rows: [] }));
  return new Set(rows.map((row) => Number(row.user_id)));
}

function getReplyTargetId(message: string) {
  const quoteId = message.match(/^\[quote=(\d+)\]/)?.[1];
  if (!quoteId) return null;
  return quoteId;
}

async function insertMessages(client: PoolClient, messages: ScrapedDollarsMessage[]): Promise<InsertResult> {
  const insertedBangumiIds: string[] = [];
  const insertedLocalIds: number[] = [];

  for (const message of messages) {
    const replyTargetId = getReplyTargetId(message.message);
    const { rows } = await client.query<{ id: number; bangumi_id: string }>(
      `INSERT INTO messages (bangumi_id, uid, nickname, avatar, message, "timestamp", type, reply_to_id, color)
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         COALESCE(
           (SELECT id FROM messages WHERE id = $8::bigint),
           (SELECT id FROM messages WHERE bangumi_id = $8::text)
         ),
         $9
       )
       ON CONFLICT (bangumi_id) DO NOTHING
       RETURNING id, bangumi_id`,
      [
        message.bangumi_id,
        message.uid,
        message.nickname,
        message.avatar,
        message.message,
        message.timestamp,
        message.type,
        replyTargetId,
        message.color,
      ],
    );

    if (rows[0]) {
      insertedBangumiIds.push(String(rows[0].bangumi_id));
      insertedLocalIds.push(Number(rows[0].id));
    }
  }

  return { insertedBangumiIds, insertedLocalIds };
}

async function resolveMentionTarget(rawTarget: string, cache: Map<string, string>) {
  if (/^\d+$/.test(rawTarget)) return rawTarget;
  if (cache.has(rawTarget)) return cache.get(rawTarget) ?? null;

  try {
    const { rows } = await searchPool.query<{ uid: number }>('SELECT uid FROM users WHERE username = $1', [rawTarget]);
    if (rows[0]) {
      const uid = String(rows[0].uid);
      cache.set(rawTarget, uid);
      return uid;
    }
  } catch {
    // optional search profile DB
  }

  try {
    const { rows } = await pool.query<{ user_id: number }>('SELECT user_id FROM user_lookup_cache WHERE username = $1', [rawTarget]);
    if (rows[0]) {
      const uid = String(rows[0].user_id);
      cache.set(rawTarget, uid);
      return uid;
    }
  } catch {
    // optional cache table
  }

  cache.set(rawTarget, '');
  return null;
}

async function insertNotifications(
  client: PoolClient,
  messages: EnrichedMessage[],
  blockedUsers: Set<number>,
): Promise<NotificationInsert[]> {
  const mentionRegex = /\[user=([^\]]+)\]/g;
  const mentionCache = new Map<string, string>();
  const inserted: NotificationInsert[] = [];

  for (const message of messages) {
    const senderUid = String(message.uid);
    const targets = new Map<string, 'mention' | 'reply'>();
    mentionRegex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(message.message ?? ''))) {
      const rawTarget = match[1];
      if (!rawTarget) continue;
      const targetUid = await resolveMentionTarget(rawTarget, mentionCache);
      if (targetUid && targetUid !== senderUid && !blockedUsers.has(Number(targetUid))) {
        targets.set(targetUid, 'mention');
      }
    }

    const replyUid = message.reply_details?.uid;
    if (replyUid != null && String(replyUid) !== senderUid && !blockedUsers.has(Number(replyUid)) && !targets.has(String(replyUid))) {
      targets.set(String(replyUid), 'reply');
    }

    for (const [userId, type] of targets) {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO notifications (user_id, sender_id, message_id, type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [Number(userId), Number(senderUid), message.id, type],
      );
      if (rows[0]) {
        inserted.push({
          id: Number(rows[0].id),
          userId,
          payload: {
            id: Number(rows[0].id),
            message_id: Number(message.id),
            uid: Number(message.uid),
            nickname: message.nickname,
            avatar: message.avatar,
            content: message.message,
            timestamp: Number(message.timestamp),
            type,
          },
        });
      }
    }
  }

  return inserted;
}

export class DollarsScraper {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private boostUntil = 0;

  constructor(
    private readonly hub: WsHub,
    private readonly onObserved?: (ids: { messageId?: number; notificationId?: number }) => void,
  ) {}

  async start() {
    if (!config.scraper.enabled || this.timer) return;
    await loadCursor();
    void this.tick();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  boost(durationMs = 2500) {
    if (!config.scraper.enabled) return;
    this.boostUntil = Date.now() + durationMs;
    if (!this.running && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      void this.tick();
    }
  }

  async scrapeOnce(options: { sinceTs?: number; immobileCursor?: boolean } = {}) {
    const cursorTs = typeof options.sinceTs === 'number' ? options.sinceTs : cursor.lastTs;
    const overlapTs = Math.max(0, cursorTs - 1);
    const url = `${config.bgm.origin}${config.bgm.dollarsPath}?since_id=${encodeURIComponent(overlapTs)}`;

    const response = await fetchWithRetry(url);
    if (!response.ok) return { inserted: 0, advanced: false };

    const raw = await response.json().catch(() => null);
    if (!Array.isArray(raw) || raw.length === 0) return { inserted: 0, advanced: false };

    const client = await pool.connect();
    let enriched: EnrichedMessage[] = [];
    let notifications: NotificationInsert[] = [];
    let advanced = false;

    try {
      const blockedUsers = await getBlockedUsers(client);
      const parsed = parseDollarsPayload(raw).filter((message) => !blockedUsers.has(message.uid));
      const fresh = options.immobileCursor ? parsed : parsed.filter(isFresh);
      if (fresh.length === 0) return { inserted: 0, advanced: false };

      await client.query('BEGIN');
      const inserted = await insertMessages(client, fresh);
      if (inserted.insertedLocalIds.length > 0) {
        const { rows } = await client.query<DbMessage>(
          'SELECT * FROM messages WHERE id = ANY($1) ORDER BY "timestamp" ASC, id ASC',
          [inserted.insertedLocalIds],
        );
        await persistLskyImageMetadataForMessages(client, rows);
        // Use the same transactional client so the metadata we just INSERTed
        // is visible to the SELECTs inside enrichMessages — otherwise the
        // first WS broadcast for this message ships without `image_meta`.
        enriched = await enrichMessages(rows, { fetchMissingPreviews: false, queryClient: client });
        notifications = await insertNotifications(client, enriched, blockedUsers);
      }

      if (!options.immobileCursor) {
        const last = fresh.at(-1);
        if (last) {
          cursor.lastTs = last.timestamp;
          cursor.lastIdAtTs = fresh.reduce((max, message) => {
            if (message.timestamp !== cursor.lastTs) return max;
            const id = BigInt(message.bangumi_id);
            return id > max ? id : max;
          }, 0n);
          advanced = true;
        }
      }

      await client.query('COMMIT');
      if (advanced) await saveCursor().catch(() => undefined);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (enriched.length > 0) {
      const maxMessageId = Math.max(...enriched.map((message) => message.id));
      this.onObserved?.({ messageId: maxMessageId });
      this.hub.broadcastNewMessages(enriched);
    }

    for (const notification of notifications) {
      this.onObserved?.({ notificationId: notification.id });
      this.hub.sendToUser(notification.userId, { type: 'notification', payload: notification.payload });
    }

    return { inserted: enriched.length, advanced };
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.scrapeOnce();
      cursor.tick = (cursor.tick + 1) % 1000000;
      if (config.scraper.safetySweepEveryTicks > 0 && cursor.tick % config.scraper.safetySweepEveryTicks === 0) {
        await this.scrapeOnce({
          sinceTs: Math.floor(Date.now() / 1000) - config.scraper.safetySweepWindowSec,
          immobileCursor: true,
        }).catch(() => undefined);
      }
    } catch (err) {
      console.warn('[scraper] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
      if (!config.scraper.enabled) return;
      const delay = Date.now() < this.boostUntil ? 100 : config.scraper.intervalMs;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick();
      }, delay);
    }
  }
}
