import { pool } from '../db/pool.js';
import type { LinkPreview } from '@shared/types';
import { ApiError } from '../utils/http.js';
import { fetchBangumiApi } from '../utils/bangumi.js';

type BgmPreviewType = 'subject' | 'character' | 'person';

interface BgmApiEntity {
  id?: number;
  name?: string;
  name_cn?: string;
  images?: { large?: string; common?: string; medium?: string };
  infobox?: Array<{ key?: string; value?: unknown }>;
  rating?: { score?: number; total?: number; rank?: number };
  eps?: number;
  platform?: string;
  date?: string;
  stat?: { collects?: number; comments?: number };
}

type PreviewResult = LinkPreview & { source: string };

const previewCache = new Map<string, { expiresAt: number; preview: PreviewResult }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_FETCH_TIMEOUT_MS = 7000;
const USER_AGENT = 'ReDollarsNext/0.1 link-preview';
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^\[?::1\]?$/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

function infoboxValue(data: BgmApiEntity, key: string) {
  const value = data.infobox?.find((item) => item.key === key)?.value;
  return typeof value === 'string' ? value : '';
}

function assertPreviewUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'Invalid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError(400, 'Unsupported URL protocol');
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    throw new ApiError(400, 'Private preview hosts are not allowed');
  }
  return url;
}

function textBetween(html: string, pattern: RegExp) {
  const match = html.match(pattern);
  return decodeHtml(String(match?.[1] ?? '').trim());
}

function decodeHtml(input: string) {
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

function attrContent(html: string, attr: 'property' | 'name', value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(`<meta\\b(?=[^>]*\\b${attr}=["']${escaped}["'])(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*>`, 'i');
  const reverse = new RegExp(`<meta\\b(?=[^>]*\\bcontent=["']([^"']*)["'])(?=[^>]*\\b${attr}=["']${escaped}["'])[^>]*>`, 'i');
  return textBetween(html, direct) || textBetween(html, reverse);
}

function absoluteUrl(value: string, base: URL) {
  if (!value) return '';
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

function fallbackPreview(url: string, title = url, description = 'Preview unavailable'): PreviewResult {
  return { url, title, description, image: '/img/no_icon_subject.png', source: 'failed' };
}

async function fetchJsonPreview(url: URL): Promise<PreviewResult | null> {
  const bilibili = url.href.match(/bilibili\.com\/video\/(BV\w+)/i);
  if (bilibili?.[1]) {
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bilibili[1]}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      const data = await response.json() as {
        code?: number;
        data?: { title?: string; desc?: string; pic?: string; owner?: { name?: string } };
      };
      if (data.code === 0 && data.data?.title) {
        return {
          url: url.href,
          title: `${data.data.title}${data.data.owner?.name ? ` @${data.data.owner.name}` : ''}`,
          source: 'bilibili',
          ...(data.data.desc ? { description: data.data.desc } : {}),
          ...(data.data.pic ? { image: data.data.pic.replace(/^http:/, 'https:') } : {}),
        };
      }
    }
  }

  if (/youtu\.?be/i.test(url.hostname)) {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url.href)}&format=json`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      const data = await response.json() as { title?: string; author_name?: string; thumbnail_url?: string };
      if (data.title) {
        return {
          url: url.href,
          title: data.title,
          source: 'youtube',
          ...(data.author_name ? { description: `By ${data.author_name}` } : {}),
          ...(data.thumbnail_url ? { image: data.thumbnail_url } : {}),
        };
      }
    }
  }

  return null;
}

export async function getBgmPreview(type: BgmPreviewType, id: string) {
  if (!['subject', 'character', 'person'].includes(type) || !/^\d+$/.test(id)) {
    throw new ApiError(400, 'Invalid preview target');
  }

  const endpoints: Record<BgmPreviewType, string> = {
    subject: 'subjects',
    character: 'characters',
    person: 'persons',
  };
  const response = await fetchBangumiApi(`/${endpoints[type]}/${id}`);
  if (!response.ok) throw new ApiError(response.status === 404 ? 404 : 502, 'Bangumi preview lookup failed');

  const data = await response.json() as BgmApiEntity;
  const preview = {
    id: data.id,
    name: data.name ?? '',
    name_cn: data.name_cn || infoboxValue(data, '简体中文名'),
    image: data.images?.large || data.images?.common || data.images?.medium || '',
    info_tip: '',
    stat1: '' as string | number,
    stat2: '',
    rank: 0,
  };

  if (type === 'subject') {
    preview.stat1 = data.rating?.score || 'N/A';
    preview.stat2 = data.rating?.total ? `(${data.rating.total})` : '';
    preview.rank = data.rating?.rank || 0;
    preview.info_tip = [data.eps ? `${data.eps}话` : '', data.platform, data.date].filter(Boolean).join(' / ');
  } else {
    preview.stat1 = `❤ ${data.stat?.collects || 0}`;
    preview.stat2 = `💬 ${data.stat?.comments || 0}`;
    preview.info_tip = [infoboxValue(data, '性别'), infoboxValue(data, '生日')].filter(Boolean).join(' | ');
  }

  return { status: true, data: preview };
}

export async function fetchLinkPreview(rawUrl: string): Promise<PreviewResult> {
  const url = assertPreviewUrl(rawUrl);
  const cacheKey = url.href;
  const cached = previewCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.preview;

  const jsonPreview = await fetchJsonPreview(url).catch(() => null);
  if (jsonPreview) {
    previewCache.set(cacheKey, { preview: jsonPreview, expiresAt: Date.now() + CACHE_TTL_MS });
    return jsonPreview;
  }

  const response = await fetch(url, {
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('text/html')) return fallbackPreview(url.href);

  const html = (await response.text()).slice(0, 512_000);
  const title = attrContent(html, 'property', 'og:title') || attrContent(html, 'name', 'twitter:title') || textBetween(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = attrContent(html, 'property', 'og:description') || attrContent(html, 'name', 'description') || attrContent(html, 'name', 'twitter:description');
  const image = absoluteUrl(attrContent(html, 'property', 'og:image') || attrContent(html, 'name', 'twitter:image'), url);
  const preview: PreviewResult = title
    ? {
        url: url.href,
        title,
        source: 'generic',
        ...(description ? { description } : {}),
        ...(image ? { image } : {}),
      }
    : fallbackPreview(url.href, url.href, 'Preview unavailable');

  previewCache.set(cacheKey, { preview, expiresAt: Date.now() + CACHE_TTL_MS });
  return preview;
}

export async function previewGenericUrl(body: unknown) {
  const rawUrl = String((body as { url?: string }).url ?? '').trim();
  if (!rawUrl) throw new ApiError(400, 'url is required');
  const url = assertPreviewUrl(rawUrl);

  const cached = previewCache.get(url.href);
  if (cached && cached.expiresAt > Date.now()) {
    return { status: true, data: cached.preview, source: 'memory' };
  }

  const { rows } = await pool.query(
    "SELECT title, description, image_url FROM link_previews WHERE url = $1 AND created_at > NOW() - INTERVAL '7 day'",
    [url.href],
  );
  if (rows[0]) {
    const data: PreviewResult = {
      url: url.href,
      title: rows[0].title,
      source: 'db',
      ...(rows[0].description ? { description: rows[0].description } : {}),
      ...(rows[0].image_url ? { image: rows[0].image_url } : { image: '/img/no_icon_subject.png' }),
    };
    previewCache.set(url.href, { preview: data, expiresAt: Date.now() + CACHE_TTL_MS });
    return { status: true, data, source: 'db' };
  }

  const result = await fetchLinkPreview(url.href).catch(() => fallbackPreview(url.href, url.href, 'Error'));
  await upsertLinkPreview(result).catch(() => undefined);
  return { status: true, data: result, source: result.source };
}

export async function upsertLinkPreview(preview: LinkPreview) {
  await pool.query(
    `INSERT INTO link_previews (url, title, description, image_url, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (url) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       image_url = EXCLUDED.image_url,
       created_at = NOW()`,
    [preview.url, preview.title, preview.description ?? null, preview.image ?? null],
  );
}

export async function fetchMissingLinkPreviews(urls: string[]) {
  const previews: LinkPreview[] = [];
  const unique = [...new Set(urls)].slice(0, 12);
  for (let index = 0; index < unique.length; index += 4) {
    const batch = unique.slice(index, index + 4);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const preview = await fetchLinkPreview(url);
          await upsertLinkPreview(preview).catch(() => undefined);
          return preview;
        } catch {
          return null;
        }
      }),
    );
    previews.push(...results.filter((preview): preview is PreviewResult => preview !== null));
  }
  return previews;
}
