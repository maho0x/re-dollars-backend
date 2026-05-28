import { pool } from '../db/pool.js';
import { parseIntParam } from '../utils/http.js';
import { normalizeServedVideoUrl, videoMetadataLookupKeys } from './mediaUrlService.js';

export function thumbnailFor(url: string, type: 'image' | 'video', thumbnailUrl?: string | null) {
  if (type === 'video') {
    if (thumbnailUrl) return thumbnailUrl;
    return url.replace(/\.[a-zA-Z0-9]+$/, '.jpg');
  }

  if (url.toLowerCase().endsWith('.gif')) return url;
  return url.replace('/i/', '/i/thumbs/').replace(/\.(jpe?g|png|avif|heic|bmp|tiff?|webp)$/i, '.webp');
}

export async function listGalleryMedia(url: URL) {
  const limit = parseIntParam(url.searchParams.get('limit'), 50, 1, 100);
  const offset = parseIntParam(url.searchParams.get('offset'), 0, 0, 100000);
  const uid = url.searchParams.get('uid') ? Number(url.searchParams.get('uid')) : null;

  const params = [limit + 1, offset, Number.isFinite(uid) ? uid : null];
  const { rows } = await pool.query(
    `WITH media AS (
       SELECT m.id as message_id, m.uid, m.nickname, m.avatar, m."timestamp", match[1] as url, 'image' as type
       FROM messages m
       CROSS JOIN LATERAL regexp_matches(m.message, '\\[img\\](https?://[^\\]]+)\\[/img\\]', 'gi') AS match
       WHERE ($3::int IS NULL OR m.uid = $3)
       UNION ALL
       SELECT m.id as message_id, m.uid, m.nickname, m.avatar, m."timestamp", match[1] as url, 'video' as type
       FROM messages m
       CROSS JOIN LATERAL regexp_matches(m.message, '\\[video\\](https?://[^\\]]+)\\[/video\\]', 'gi') AS match
       WHERE ($3::int IS NULL OR m.uid = $3)
     )
     SELECT media.*
     FROM media
     ORDER BY "timestamp" DESC
     LIMIT $1 OFFSET $2`,
    params,
  );

  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, -1) : rows;
  const videoLookupKeys = visibleRows
    .filter((row) => row.type === 'video')
    .flatMap((row) => videoMetadataLookupKeys(row.url));
  const videoThumbnails = new Map<string, string | null>();
  if (videoLookupKeys.length > 0) {
    const { rows: metadataRows } = await pool.query<{ video_url: string; thumbnail_url: string | null }>(
      'SELECT video_url, thumbnail_url FROM video_metadata WHERE video_url = ANY($1)',
      [[...new Set(videoLookupKeys)]],
    );
    for (const row of metadataRows) videoThumbnails.set(row.video_url, row.thumbnail_url);
  }

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) as total
     FROM (
       SELECT m.id FROM messages m CROSS JOIN LATERAL regexp_matches(m.message, '\\[img\\](https?://[^\\]]+)\\[/img\\]', 'gi') AS match
       WHERE ($1::int IS NULL OR m.uid = $1)
       UNION ALL
       SELECT m.id FROM messages m CROSS JOIN LATERAL regexp_matches(m.message, '\\[video\\](https?://[^\\]]+)\\[/video\\]', 'gi') AS match
       WHERE ($1::int IS NULL OR m.uid = $1)
     ) media_count`,
    [Number.isFinite(uid) ? uid : null],
  );

  return {
    status: true,
    items: visibleRows.map((row) => {
      const displayUrl = row.type === 'video' ? normalizeServedVideoUrl(row.url) ?? row.url : row.url;
      const thumbnailUrl = row.type === 'video'
        ? videoMetadataLookupKeys(row.url).map((key) => videoThumbnails.get(key)).find(Boolean)
        : null;
      return {
        url: displayUrl,
        thumbnailUrl: thumbnailFor(displayUrl, row.type, thumbnailUrl),
        type: row.type,
        message_id: Number(row.message_id),
        timestamp: Number(row.timestamp),
        uid: Number(row.uid),
        nickname: row.nickname,
        avatar: row.avatar,
      };
    }),
    hasMore,
    total: Number(countRows[0]?.total ?? 0),
  };
}
