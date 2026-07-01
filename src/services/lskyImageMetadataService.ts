import pg from 'pg';
import { config } from '../config/env.js';

interface MessageWithContent {
  message?: string | null;
}

interface LskyDimensionRow {
  width: number | string | null;
  height: number | string | null;
}

/**
 * Minimal contract satisfied by `pg.Pool`. Tests inject a fake whose `query`
 * mirrors the real signature so we can avoid a live connection.
 */
export interface LskyQueryPool {
  query<Row = LskyDimensionRow>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  end?(): Promise<void>;
}

export interface ImageMetadataStore {
  query<Row = unknown>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

const imgRegex = /\[img\](https?:\/\/[^\]]+?)\[\/img\]/gi;

let lskyPool: pg.Pool | null = null;

function getLskyPool(): pg.Pool | null {
  if (!config.imghostDb) return null;
  if (!lskyPool) {
    lskyPool = new pg.Pool({
      ...config.imghostDb,
      connectionTimeoutMillis: config.imghostDbQueryTimeoutMs,
      query_timeout: config.imghostDbQueryTimeoutMs,
      statement_timeout: config.imghostDbQueryTimeoutMs,
    } as pg.PoolConfig);
    lskyPool.on('error', (err) => console.warn('[db:lsky] idle client error:', err.message));
  }
  return lskyPool;
}

export function collectImageUrls(messages: MessageWithContent[]) {
  const urls = new Set<string>();
  for (const message of messages) {
    imgRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = imgRegex.exec(message.message ?? ''))) {
      const cleanUrl = match[1]?.split('?')[0];
      if (cleanUrl) urls.add(cleanUrl);
    }
  }
  return [...urls];
}

export function lskyFilenameFromUrl(value: string) {
  try {
    const url = new URL(value);
    if (!url.pathname.includes('/i/')) return null;
    const filename = url.pathname.split('/').filter(Boolean).pop();
    return filename ? decodeURIComponent(filename) : null;
  } catch {
    return null;
  }
}

function normalizeDimension(value: number | string | null) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function lookupLskyDimensions(url: string, queryPool: LskyQueryPool | null = getLskyPool()) {
  const filename = lskyFilenameFromUrl(url);
  if (!filename || !queryPool) return null;

  const { rows } = await queryPool.query<LskyDimensionRow>(
    'SELECT width, height FROM images WHERE name = $1 ORDER BY id DESC LIMIT 1',
    [filename],
  );
  const row = rows[0];
  if (!row) return null;

  const width = normalizeDimension(row.width);
  const height = normalizeDimension(row.height);
  return width && height ? { width, height } : null;
}

export async function persistLskyImageMetadataForMessages(
  client: ImageMetadataStore,
  messages: MessageWithContent[],
  queryPool: LskyQueryPool | null = getLskyPool(),
): Promise<Map<string, { width: number; height: number }>> {
  const result = new Map<string, { width: number; height: number }>();
  if (!queryPool || messages.length === 0) return result;

  const urls = collectImageUrls(messages);
  if (urls.length === 0) return result;

  const { rows } = await client.query<{ image_url: string }>(
    'SELECT image_url FROM image_metadata WHERE image_url = ANY($1)',
    [urls],
  );
  const existing = new Set(rows.map((row) => row.image_url));

  for (const url of urls) {
    if (existing.has(url)) continue;
    try {
      const dimensions = await lookupLskyDimensions(url, queryPool);
      if (!dimensions) continue;
      await client.query(
        `INSERT INTO image_metadata (image_url, width, height, placeholder)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (image_url) DO UPDATE SET width = $2, height = $3`,
        [url, dimensions.width, dimensions.height],
      );
      result.set(url, dimensions);
    } catch (error) {
      console.warn('[lsky] image metadata lookup failed:', error instanceof Error ? error.message : error);
    }
  }

  return result;
}

export async function closeLskyPool() {
  if (!lskyPool) return;
  const pool = lskyPool;
  lskyPool = null;
  await pool.end();
}
