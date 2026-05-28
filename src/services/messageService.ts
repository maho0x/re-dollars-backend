import type { ImageMeta, LinkPreview, Reaction } from '@shared/types';
import { pool, searchPool } from '../db/pool.js';
import type { DbMessage, EnrichedMessage } from '../types.js';
import { generateUserColor } from '../utils/color.js';
import { fetchMissingLinkPreviews } from './previewService.js';

/**
 * Minimal contract satisfied by both `pg.Pool` and `pg.PoolClient`. Allows
 * callers inside a transaction (e.g. the scraper) to pass their checked-out
 * client so that reads see writes that are still uncommitted on the same
 * connection. The `Row = any` default mirrors `pg.Pool.query` so the existing
 * untyped destructuring downstream stays type-clean.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface QueryablePool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<Row = any>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

const imgRegex = /\[img\](https?:\/\/[^\]]+?)\[\/img\]/gi;
const urlRegex = /(https?:\/\/[^\s<>"'\[\]]+)/gi;

function stripBBCode(text: string) {
  return text
    .replace(/\[quote[^\]]*\][\s\S]*?\[\/quote\]/gi, '')
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
    .replace(/\[sticker[^\]]*\][\s\S]*?\[\/sticker\]/gi, '')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[user=[^\]]*\]([\s\S]*?)\[\/user\]/gi, '@$1')
    .replace(/\[(b|i|u|s|code|color|size|font|center|right|left)[^\]]*\]([\s\S]*?)\[\/\1\]/gi, '$2')
    .replace(/\[[^\]]+\]/g, '')
    .trim();
}

function firstImageFromMessage(message: string) {
  const url = (/\[img\](https?:\/\/[^\]]+?)\[\/img\]/i.exec(message) || [])[1]?.split('?')[0];
  if (!url) return undefined;
  if (url.toLowerCase().endsWith('.gif')) return url;
  return url.replace('/i/', '/i/thumbs/').replace(/\.(jpe?g|png|avif|heic|bmp|tiff?|webp)$/i, '.webp');
}

function collectUrls(messages: DbMessage[]) {
  const imageUrls = new Set<string>();
  const linkUrls = new Set<string>();
  const replyIds = new Set<number>();

  for (const message of messages) {
    if (message.reply_to_id != null && Number.isFinite(Number(message.reply_to_id))) {
      replyIds.add(Number(message.reply_to_id));
    }

    const content = message.message ?? '';
    imgRegex.lastIndex = 0;
    urlRegex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = imgRegex.exec(content))) {
      const url = match[1]?.split('?')[0];
      if (url) imageUrls.add(url);
    }

    while ((match = urlRegex.exec(content))) {
      const url = match[1];
      if (url && !content.includes(`[img]${url}[/img]`)) {
        linkUrls.add(url);
      }
    }
  }

  return { imageUrls, linkUrls, replyIds };
}

export async function enrichMessages(
  messages: DbMessage[],
  options: { fetchMissingPreviews?: boolean; queryClient?: QueryablePool } = {},
): Promise<EnrichedMessage[]> {
  if (messages.length === 0) return [];

  // Default to the shared pool, but let callers route reads through a specific
  // connection. The scraper uses this so that `image_metadata` rows it just
  // INSERTed inside its transaction are visible before COMMIT — otherwise the
  // first WS broadcast of a new message ships without `image_meta`.
  const db: QueryablePool = options.queryClient ?? pool;

  const ids = messages.map((message) => message.id);
  const { imageUrls, linkUrls, replyIds } = collectUrls(messages);

  const [reactionsResult, imageResult, linksResult, repliesResult, blocklistResult] = await Promise.all([
    db.query('SELECT message_id, user_id, nickname, avatar, emoji FROM message_reactions WHERE message_id = ANY($1)', [ids]),
    imageUrls.size
      ? db.query('SELECT image_url, width, height, placeholder FROM image_metadata WHERE image_url = ANY($1)', [[...imageUrls]])
      : Promise.resolve({ rows: [] }),
    linkUrls.size
      ? db.query('SELECT url, title, description, image_url FROM link_previews WHERE url = ANY($1)', [[...linkUrls]])
      : Promise.resolve({ rows: [] }),
    replyIds.size
      ? db.query('SELECT id, uid, nickname, avatar, message FROM messages WHERE id = ANY($1)', [[...replyIds]])
      : Promise.resolve({ rows: [] }),
    db.query('SELECT user_id FROM global_blocklist').catch(() => ({ rows: [] })),
  ]);

  const reactionUserIds = [...new Set(reactionsResult.rows.map((row) => Number(row.user_id)).filter(Boolean))];
  const reactionAvatars = new Map<number, string>();
  if (reactionUserIds.length > 0) {
    try {
      const { rows } = await searchPool.query('SELECT uid, avatar_url FROM users WHERE uid = ANY($1)', [reactionUserIds]);
      for (const row of rows) {
        if (row.avatar_url) reactionAvatars.set(Number(row.uid), row.avatar_url);
      }
    } catch {
      // optional profile database
    }
  }

  const reactionsByMessage = new Map<number, Reaction[]>();
  for (const row of reactionsResult.rows) {
    const messageId = Number(row.message_id);
    const userId = Number(row.user_id);
    const reaction: Reaction = {
      emoji: row.emoji,
      user_id: userId,
      nickname: row.nickname,
      avatar: reactionAvatars.get(userId) ?? row.avatar ?? undefined,
    };
    const list = reactionsByMessage.get(messageId) ?? [];
    list.push(reaction);
    reactionsByMessage.set(messageId, list);
  }

  const imageMeta = new Map<string, ImageMeta & { placeholder?: string }>();
  for (const row of imageResult.rows) {
    imageMeta.set(row.image_url, {
      width: Number(row.width),
      height: Number(row.height),
      ...(row.placeholder ? { placeholder: row.placeholder } : {}),
    });
  }

  const linkPreviews = new Map<string, LinkPreview>();
  for (const row of linksResult.rows) {
    linkPreviews.set(row.url, {
      url: row.url,
      title: row.title,
      description: row.description ?? undefined,
      image: row.image_url ?? undefined,
    });
  }
  if (options.fetchMissingPreviews !== false && linkUrls.size > 0) {
    const missingUrls = [...linkUrls].filter((url) => !linkPreviews.has(url));
    const fetched = await fetchMissingLinkPreviews(missingUrls);
    for (const preview of fetched) {
      linkPreviews.set(preview.url, preview);
    }
  }

  const replies = new Map<number, NonNullable<EnrichedMessage['reply_details']>>();
  for (const row of repliesResult.rows) {
    const firstImage = firstImageFromMessage(row.message ?? '');
    replies.set(Number(row.id), {
      uid: Number(row.uid),
      nickname: row.nickname,
      avatar: row.avatar,
      content: stripBBCode(row.message ?? '').slice(0, 50),
      ...(firstImage ? { firstImage } : {}),
    });
  }

  const blocked = new Set(blocklistResult.rows.map((row) => Number(row.user_id)));

  return messages
    .filter((message) => !blocked.has(Number(message.uid)))
    .map((message) => {
      const content = message.message ?? '';
      const images: Record<string, ImageMeta & { placeholder?: string }> = {};
      const links: Record<string, LinkPreview> = {};

      imgRegex.lastIndex = 0;
      urlRegex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = imgRegex.exec(content))) {
        const url = match[1]?.split('?')[0];
        if (url && imageMeta.has(url)) images[url] = imageMeta.get(url)!;
      }

      while ((match = urlRegex.exec(content))) {
        const url = match[1];
        if (url && linkPreviews.has(url)) links[url] = linkPreviews.get(url)!;
      }

      return {
        ...message,
        uid: Number(message.uid),
        color: generateUserColor(Number(message.uid)),
        db_id: Number(message.id),
        reactions: reactionsByMessage.get(Number(message.id)) ?? [],
        ...(Object.keys(images).length > 0 ? { image_meta: images } : {}),
        ...(Object.keys(links).length > 0 ? { link_previews: links } : {}),
        reply_details: message.reply_to_id != null ? (replies.get(Number(message.reply_to_id)) ?? null) : null,
      };
    });
}

export async function getMessagesByIds(ids: number[]) {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<DbMessage>('SELECT * FROM messages WHERE id = ANY($1) ORDER BY id ASC', [ids]);
  return enrichMessages(rows);
}
